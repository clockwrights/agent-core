import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { runToolAgent, type AgentTool } from "@maya-ai/tool-agent-runtime";
import { collectEvents, createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";
import { ToolRegistry, executionModeForRisk, type ToolRisk } from "../src/index.js";

const params = Type.Object({});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRegistry(track?: { active: number; max: number; aloneForWrites: number[] }) {
  const make = (name: string, risk: ToolRisk, ownMode?: "sequential" | "parallel"): AgentTool<typeof params> => ({
    name,
    label: name,
    description: name,
    parameters: params,
    executionMode: ownMode,
    execute: async () => {
      if (track) {
        track.active++;
        track.max = Math.max(track.max, track.active);
        if (risk !== "read") track.aloneForWrites.push(track.active);
        await sleep(10);
        track.active--;
      }
      return { content: [{ type: "text", text: name }], details: {} };
    }
  });
  const registry = new ToolRegistry();
  // Mirrors the built-in memory tools: read risk but hard-coded sequential.
  registry.register(make("memory_search", "read", "sequential"), { source: "domain", risk: "read" });
  registry.register(make("memory_get", "read", "sequential"), { source: "domain", risk: "read" });
  registry.register(make("save_note", "write"), { source: "domain", risk: "write" });
  registry.register(make("web_fetch", "external", "parallel"), { source: "domain", risk: "external" });
  return registry;
}

test("executionModeForRisk: read → parallel, write/external → sequential", () => {
  assert.equal(executionModeForRisk("read"), "parallel");
  assert.equal(executionModeForRisk("write"), "sequential");
  assert.equal(executionModeForRisk("external"), "sequential");
});

test("resolve: without the option tools keep their own executionMode (unchanged objects)", () => {
  const registry = makeRegistry();
  const plain = registry.resolve();
  assert.deepEqual(plain.map((t) => t.executionMode), ["sequential", "sequential", undefined, "parallel"]);
  assert.equal(plain[0], registry.list()[0]!.tool);
});

test("resolve: executionModeFromRisk overrides each tool's mode from its risk", () => {
  const tools = makeRegistry().resolve(undefined, { executionModeFromRisk: true });
  assert.deepEqual(
    tools.map((t) => [t.name, t.executionMode]),
    [
      ["memory_search", "parallel"],
      ["memory_get", "parallel"],
      ["save_note", "sequential"],
      ["web_fetch", "sequential"]
    ]
  );
});

test("resolve: executionModeFromRisk combines with result limits", async () => {
  const tools = makeRegistry().resolve(undefined, { executionModeFromRisk: true, resultLimits: { defaultMaxChars: 3 } });
  assert.equal(tools[0]!.executionMode, "parallel");
  const result = await tools[0]!.execute("c1", {});
  assert.match((result.content.at(-1) as { text: string }).text, /Output truncated/);
});

test("end to end: read tools run in parallel next to write/external tools that run alone", async () => {
  const track = { active: 0, max: 0, aloneForWrites: [] as number[] };
  const tools = makeRegistry(track).resolve(undefined, { executionModeFromRisk: true });
  const replay = createReplayModel([
    replyToolCalls([
      { name: "memory_search", id: "a" },
      { name: "memory_get", id: "b" },
      { name: "save_note", id: "c" },
      { name: "web_fetch", id: "d" }
    ]),
    replyText("done")
  ]);
  const events = collectEvents();
  await runToolAgent(
    { systemPrompt: "s", model: replay.model, tools, prompt: "go", toolBatchStrategy: "sequential-barriers" },
    events.emit
  );
  replay.dispose();

  assert.equal(track.max, 2, "the two reads overlapped");
  assert.deepEqual(track.aloneForWrites, [1, 1], "write and external tools ran alone");
  assert.equal(events.ofType("agent_end")[0]!.reason, "completed");
});
