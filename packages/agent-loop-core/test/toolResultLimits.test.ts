import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import {
  ToolRegistry,
  createReadToolOutputTool,
  createToolOutputStore,
  limitToolResult,
  readToolOutputToolName,
  type RegisteredTool
} from "../src/index.js";

const params = Type.Object({});

function fixedTool(name: string, result: AgentToolResult<any>): AgentTool<typeof params> {
  return {
    name,
    label: name,
    description: name,
    parameters: params,
    execute: async () => result
  };
}

const text = (result: AgentToolResult<any>) =>
  result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

const LONG = "0123456789".repeat(30); // 300 chars

test("limitToolResult: results within the limit are returned untouched", async () => {
  const original: AgentToolResult<any> = { content: [{ type: "text", text: "short" }], details: { a: 1 } };
  const tool = limitToolResult(fixedTool("t", original), { maxChars: 100 });
  const result = await tool.execute("call-1", {});
  assert.equal(result, original);
});

test("limitToolResult: long text is cut to maxChars with a notice and truncation details", async () => {
  const tool = limitToolResult(fixedTool("t", { content: [{ type: "text", text: LONG }], details: { source: "x" } }), {
    maxChars: 50
  });
  const result = await tool.execute("call-1", {});

  assert.equal(result.content[0]!.type, "text");
  assert.equal((result.content[0] as { text: string }).text, LONG.slice(0, 50));
  assert.match(text(result), /\[Output truncated: showing the first 50 of 300 characters\.\]/);
  assert.deepEqual(result.details, { source: "x", truncation: { truncated: true, totalChars: 300, shownChars: 50 } });
});

test("limitToolResult: budget spans text parts in order; images pass through", async () => {
  const tool = limitToolResult(
    fixedTool("t", {
      content: [
        { type: "text", text: "a".repeat(30) },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "b".repeat(30) },
        { type: "text", text: "c".repeat(30) }
      ],
      details: undefined
    }),
    { maxChars: 40 }
  );
  const result = await tool.execute("call-1", {});

  assert.deepEqual(
    result.content.map((p) => p.type),
    ["text", "image", "text", "text"],
    "two kept text parts, the image, and the notice"
  );
  assert.ok(text(result).startsWith("a".repeat(30) + "[image]" + "b".repeat(10) + "\n\n[Output truncated"));
  assert.deepEqual(result.details, { truncation: { truncated: true, totalChars: 90, shownChars: 40 } });
});

test("limitToolResult: preserves other tool fields (name, mode, timeout)", () => {
  const base = { ...fixedTool("t", { content: [], details: {} }), executionMode: "sequential" as const, timeoutMs: 500 };
  const wrapped = limitToolResult(base, { maxChars: 10 });
  assert.equal(wrapped.name, "t");
  assert.equal(wrapped.executionMode, "sequential");
  assert.equal(wrapped.timeoutMs, 500);
  assert.throws(() => limitToolResult(base, { maxChars: 0 }), RangeError);
});

test("store + read_tool_output: the model can page through the full output", async () => {
  const store = createToolOutputStore();
  const tool = limitToolResult(fixedTool("t", { content: [{ type: "text", text: LONG }], details: {} }), {
    maxChars: 100,
    store
  });
  const reader = createReadToolOutputTool(store, { defaultLimit: 120 });
  assert.equal(reader.name, readToolOutputToolName);

  const first = await tool.execute("call-7", {});
  assert.match(text(first), /call read_tool_output with \{"id": "call-7", "offset": 100\}/);
  assert.equal((first.details as any).truncation.outputId, "call-7");

  const page = await reader.execute("r1", { id: "call-7", offset: 100 });
  assert.ok(text(page).startsWith(LONG.slice(100, 220)));
  assert.match(text(page), /Continue with \{"id": "call-7", "offset": 220\}/);
  assert.deepEqual(page.details, { id: "call-7", offset: 100, returnedChars: 120, totalChars: 300 });

  const last = await reader.execute("r2", { id: "call-7", offset: 220 });
  assert.ok(text(last).startsWith(LONG.slice(220)));
  assert.match(text(last), /End of output: characters 220-300 of 300/);

  await assert.rejects(reader.execute("r3", { id: "unknown" }), /No stored output for id "unknown"/);
});

test("store: evicts the oldest entry beyond maxEntries", () => {
  const store = createToolOutputStore({ maxEntries: 2 });
  store.put("a", "1");
  store.put("b", "2");
  store.put("c", "3");
  assert.equal(store.size, 2);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("c"), "3");
  assert.throws(() => createToolOutputStore({ maxEntries: 0 }), RangeError);
});

test("registry: result limits apply only when requested; metadata wins over the default", async () => {
  const big = { content: [{ type: "text" as const, text: LONG }], details: {} };
  const definitions: RegisteredTool[] = [
    { tool: fixedTool("capped", big), metadata: { source: "domain", risk: "read", maxResultChars: 20 } },
    { tool: fixedTool("defaulted", big), metadata: { source: "domain", risk: "read" } }
  ];
  const registry = new ToolRegistry();
  registry.registerDefinitions(definitions);

  // No options → today's behaviour: tools are returned as registered.
  const plain = registry.resolve();
  assert.equal(plain[0], definitions[0]!.tool);
  assert.equal(text(await plain[1]!.execute("c", {})), LONG);

  const limited = registry.resolve(undefined, { resultLimits: { defaultMaxChars: 60 } });
  assert.match(text(await limited[0]!.execute("c1", {})), /first 20 of 300/);
  assert.match(text(await limited[1]!.execute("c2", {})), /first 60 of 300/);

  const metadataOnly = registry.resolve(undefined, { resultLimits: {} });
  assert.equal(metadataOnly[1], definitions[1]!.tool, "no default and no metadata → unwrapped");
});
