// ---------------------------------------------------------------------------
// Tests: the AgentEvent contract. These pin the field set of every event the
// runtime emits. A failure here means downstream consumers can see a change:
// additive changes update the expected keys below; removing or renaming a
// field is a breaking change and must bump AGENT_EVENT_VERSION.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { AGENT_EVENT_VERSION, runToolAgent, type AgentEvent, type AgentTool } from "../src/index.js";
import { collectEvents, createReplayModel, replyText, replyToolCalls } from "../src/testing.js";

const EXPECTED_KEYS: Record<AgentEvent["type"], string[]> = {
  agent_start: ["eventVersion", "resumed", "type"],
  agent_end: ["messages", "reason", "state", "type", "usage"],
  turn_start: ["type"],
  turn_end: ["message", "toolResults", "type", "usage"],
  message_start: ["message", "type"],
  message_update: ["assistantMessageEvent", "message", "type"],
  message_end: ["message", "type"],
  tool_execution_start: ["args", "toolCallId", "toolName", "type"],
  tool_execution_update: ["args", "partialResult", "toolCallId", "toolName", "type"],
  tool_execution_end: ["isError", "result", "toolCallId", "toolName", "type"],
  tool_approval_requested: ["args", "data", "reason", "toolCallId", "toolName", "type"],
  compact_boundary: ["keptMessages", "removedMessages", "summary", "summaryIndex", "tokensAfter", "tokensBefore", "trigger", "turn", "type", "usage"],
  compaction_failed: ["error", "trigger", "turn", "type"],
};

/** Event types the main scenario does not produce (each has its own test). */
const SEPARATE_SCENARIO = new Set(["tool_approval_requested", "compact_boundary", "compaction_failed"]);

test("contract version is 1", () => {
  assert.equal(AGENT_EVENT_VERSION, 1);
});

test("every emitted event has exactly the documented fields", async () => {
  const params = Type.Object({ message: Type.String() });
  const echo: AgentTool<typeof params> = {
    name: "echo",
    label: "Echo",
    description: "Echo.",
    parameters: params,
    execute: async (_id, { message }, _signal, onUpdate) => {
      onUpdate?.({ content: [{ type: "text", text: "…" }], details: {} });
      return { content: [{ type: "text", text: message }], details: { message } };
    },
  };
  const replay = createReplayModel([
    replyToolCalls([{ name: "echo", arguments: { message: "hi" } }]),
    replyText("done"),
  ]);
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "s", model: replay.model, tools: [echo], prompt: "go" }, events.emit);
  replay.dispose();

  const seenTypes = new Set(events.types());
  assert.deepEqual(
    [...seenTypes].sort(),
    Object.keys(EXPECTED_KEYS).filter((k) => !SEPARATE_SCENARIO.has(k)).sort(),
    "scenario covers every event type",
  );

  for (const event of events.events) {
    assert.deepEqual(Object.keys(event).sort(), EXPECTED_KEYS[event.type], `fields of ${event.type}`);
  }
  assert.equal(events.ofType("agent_start")[0]!.eventVersion, AGENT_EVENT_VERSION);
});

test("agent_end carries errorMessage only for error/aborted runs", async () => {
  const replay = createReplayModel([{ ...replyText(""), content: [], stopReason: "error", errorMessage: "boom" }]);
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "s", model: replay.model, tools: [], prompt: "go" }, events.emit);
  replay.dispose();

  const end = events.ofType("agent_end")[0]!;
  assert.deepEqual(Object.keys(end).sort(), ["errorMessage", "messages", "reason", "state", "type", "usage"]);
});

test("tool_approval_requested has exactly the documented fields", async () => {
  const params = Type.Object({ to: Type.String() });
  const send: AgentTool<typeof params> = {
    name: "send",
    label: "Send",
    description: "Send.",
    parameters: params,
    execute: async () => ({ content: [{ type: "text", text: "sent" }], details: {} }),
  };
  const replay = createReplayModel([replyToolCalls([{ name: "send", arguments: { to: "a" } }])]);
  const events = collectEvents();
  await runToolAgent(
    {
      systemPrompt: "s",
      model: replay.model,
      tools: [send],
      prompt: "go",
      beforeToolCall: () => ({ action: "ask", reason: "external", data: { risk: "external" } }),
    },
    events.emit,
  );
  replay.dispose();
  const [event] = events.ofType("tool_approval_requested");
  assert.deepEqual(Object.keys(event!).sort(), EXPECTED_KEYS.tool_approval_requested);
  const end = events.ofType("agent_end")[0]!;
  assert.equal(end.reason, "interrupted");
  assert.deepEqual(Object.keys(end).sort(), ["messages", "reason", "state", "type", "usage"]);
});

test("compact_boundary and compaction_failed have exactly the documented fields", async () => {
  const params = Type.Object({});
  const read: AgentTool<typeof params> = {
    name: "read",
    label: "Read",
    description: "Read.",
    parameters: params,
    execute: async () => ({ content: [{ type: "text", text: "x".repeat(400) }], details: {} }),
  };
  const usage = { input: 600, output: 10 };
  const run = async (summarize: () => Promise<{ text: string }>) => {
    const replay = createReplayModel([
      replyToolCalls([{ name: "read", id: "a" }], { usage }),
      replyToolCalls([{ name: "read", id: "b" }], { usage }),
      replyText("done"),
    ]);
    const events = collectEvents();
    await runToolAgent(
      {
        systemPrompt: "s",
        model: replay.model,
        tools: [read],
        prompt: "go",
        compaction: { triggerTokens: 500, keepRecentTokens: 0, summarize },
      },
      events.emit,
    );
    replay.dispose();
    return events;
  };

  const ok = await run(async () => ({ text: "summary" }));
  const [boundary] = ok.ofType("compact_boundary");
  assert.deepEqual(Object.keys(boundary!).sort(), EXPECTED_KEYS.compact_boundary);

  const failed = await run(async () => {
    throw new Error("no summary today");
  });
  const [failure] = failed.ofType("compaction_failed");
  assert.deepEqual(Object.keys(failure!).sort(), EXPECTED_KEYS.compaction_failed);
});
