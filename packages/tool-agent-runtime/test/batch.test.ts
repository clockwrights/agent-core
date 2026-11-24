// ---------------------------------------------------------------------------
// Tests: toolBatchStrategy — sequential tools as barriers.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, type ToolResultMessage } from "@earendil-works/pi-ai";
import { runToolAgent, type AgentTool, type ToolAgentRunInput } from "../src/index.js";
import { collectEvents, createReplayModel, replyText, replyToolCalls } from "../src/testing.js";

const noParams = Type.Object({});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tools that log start/end and track how many are in flight. */
function instrumented() {
  const log: string[] = [];
  const state = { active: 0, max: 0, activeWhenSequentialRan: [] as number[] };
  const make = (name: string, mode?: "sequential"): AgentTool<typeof noParams> => ({
    name,
    label: name,
    description: name,
    parameters: noParams,
    executionMode: mode,
    execute: async () => {
      state.active++;
      state.max = Math.max(state.max, state.active);
      if (mode === "sequential") state.activeWhenSequentialRan.push(state.active);
      log.push(`start:${name}`);
      await sleep(10);
      log.push(`end:${name}`);
      state.active--;
      return { content: [{ type: "text", text: name }], details: {} };
    },
  });
  return { log, state, make };
}

async function runBatch(tools: AgentTool<any>[], extra: Partial<ToolAgentRunInput> = {}) {
  const replay = createReplayModel([
    replyToolCalls(tools.map((t) => ({ name: t.name, id: `id-${t.name}` }))),
    replyText("done"),
  ]);
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", ...extra }, events.emit);
  replay.dispose();
  return events.ofType("agent_end")[0]!;
}

test("sequential-barriers: parallel tools around a sequential tool overlap; the sequential one runs alone", async () => {
  const { log, state, make } = instrumented();
  const tools = [make("r1"), make("r2"), make("w", "sequential"), make("r3"), make("r4")];
  const end = await runBatch(tools, { toolBatchStrategy: "sequential-barriers" });

  assert.equal(state.max, 2, "r1/r2 and r3/r4 ran in pairs");
  assert.deepEqual(state.activeWhenSequentialRan, [1], "nothing overlapped the sequential tool");
  const idx = (entry: string) => log.indexOf(entry);
  assert.ok(idx("end:r1") < idx("start:w") && idx("end:r2") < idx("start:w"), "barrier waits for earlier calls");
  assert.ok(idx("end:w") < idx("start:r3") && idx("end:w") < idx("start:r4"), "later calls wait for the barrier");
  assert.deepEqual(
    end.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => m.toolName),
    ["r1", "r2", "w", "r3", "r4"],
  );
});

test("sequential-barriers: consecutive sequential tools run one by one; maxParallelTools still applies", async () => {
  const { state, make } = instrumented();
  await runBatch([make("w1", "sequential"), make("w2", "sequential"), make("a"), make("b"), make("c")], {
    toolBatchStrategy: "sequential-barriers",
    maxParallelTools: 2,
  });
  assert.deepEqual(state.activeWhenSequentialRan, [1, 1]);
  assert.equal(state.max, 2);
});

test("serialize-batch (default): one sequential tool serializes the whole batch", async () => {
  const { state, make } = instrumented();
  await runBatch([make("r1"), make("r2"), make("w", "sequential"), make("r3")]);
  assert.equal(state.max, 1);
});

test("toolBatchStrategy: unknown value is rejected up front", async () => {
  const replay = createReplayModel([replyText("x")]);
  await assert.rejects(
    runToolAgent(
      { systemPrompt: "s", model: replay.model, tools: [], prompt: "go", toolBatchStrategy: "fast" as never },
      () => {},
    ),
    /toolBatchStrategy must be/,
  );
  replay.dispose();
});
