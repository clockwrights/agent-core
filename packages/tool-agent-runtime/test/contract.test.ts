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
  agent_start: ["eventVersion", "type"],
  agent_end: ["messages", "reason", "type", "usage"],
  turn_start: ["type"],
  turn_end: ["message", "toolResults", "type", "usage"],
  message_start: ["message", "type"],
  message_update: ["assistantMessageEvent", "message", "type"],
  message_end: ["message", "type"],
  tool_execution_start: ["args", "toolCallId", "toolName", "type"],
  tool_execution_update: ["args", "partialResult", "toolCallId", "toolName", "type"],
  tool_execution_end: ["isError", "result", "toolCallId", "toolName", "type"],
};

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
  assert.deepEqual([...seenTypes].sort(), Object.keys(EXPECTED_KEYS).sort(), "scenario covers every event type");

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
  assert.deepEqual(Object.keys(end).sort(), ["errorMessage", "messages", "reason", "type", "usage"]);
});
