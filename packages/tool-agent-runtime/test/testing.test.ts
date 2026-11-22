// ---------------------------------------------------------------------------
// Tests: the record/replay helpers themselves.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, getApiProvider, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { runToolAgent, type AgentTool } from "../src/index.js";
import {
  CASSETTE_VERSION,
  collectEvents,
  createModelRecorder,
  createReplayModel,
  replyText,
  replyToolCalls,
} from "../src/testing.js";

const echoParams = Type.Object({ message: Type.String() });

const echo: AgentTool<typeof echoParams> = {
  name: "echo",
  label: "Echo",
  description: "Echo a message.",
  parameters: echoParams,
  execute: async (_id, { message }) => ({ content: [{ type: "text", text: message }], details: {} }),
};

async function runWith(model: Parameters<typeof runToolAgent>[0]["model"], tools: AgentTool<any>[] = [echo]) {
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "s", model, tools, prompt: "go" }, events.emit);
  return events.ofType("agent_end")[0]!.messages;
}

/** Strip fields that legitimately differ between a live run and its replay. */
function comparable(messages: Message[]) {
  return messages.map((m) => {
    const { timestamp: _t, ...rest } = m as Message & { api?: string; provider?: string; model?: string };
    if (rest.role === "assistant") {
      const { api: _a, provider: _p, model: _m, ...core } = rest as Record<string, unknown>;
      return core;
    }
    return rest;
  });
}

test("recorder → cassette → replay reproduces the same conversation", async () => {
  // The "live" model is itself scripted so the test needs no network.
  const live = createReplayModel([
    replyToolCalls([{ name: "echo", arguments: { message: "hi" }, id: "t1" }], { usage: { input: 10, output: 3 } }),
    replyText("finished", { usage: { input: 20, output: 2 } }),
  ]);
  const recorder = createModelRecorder(live.model);
  const original = await runWith(recorder.model);
  const cassette = recorder.cassette();
  recorder.dispose();
  live.dispose();

  assert.equal(cassette.version, CASSETTE_VERSION);
  assert.equal(cassette.steps.length, 2);
  assert.deepEqual(cassette.steps[0]!.request, { messageCount: 1, lastRole: "user", toolNames: ["echo"] });
  assert.deepEqual(cassette.steps[1]!.request, { messageCount: 3, lastRole: "toolResult", toolNames: ["echo"] });

  // Cassettes are plain JSON.
  const replay = createReplayModel(JSON.parse(JSON.stringify(cassette)));
  const replayed = await runWith(replay.model);
  replay.dispose();

  assert.deepEqual(comparable(replayed), comparable(original));
});

test("replay preserves recorded usage (needed for usage/budget tests)", async () => {
  const replay = createReplayModel([replyText("x", { usage: { input: 7, output: 5, totalTokens: 12, cost: { total: 0.01 } } })]);
  const messages = await runWith(replay.model);
  replay.dispose();

  const assistant = messages[1] as AssistantMessage;
  assert.equal(assistant.usage.input, 7);
  assert.equal(assistant.usage.output, 5);
  assert.equal(assistant.usage.totalTokens, 12);
  assert.equal(assistant.usage.cost.total, 0.01);
});

test("replay detects a changed conversation shape", async () => {
  const replay = createReplayModel({
    version: CASSETTE_VERSION,
    steps: [{ request: { messageCount: 1, lastRole: "user", toolNames: ["echo", "other"] }, response: replyText("x") }],
  });
  const messages = await runWith(replay.model);
  replay.dispose();

  const last = messages.at(-1) as AssistantMessage;
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /request mismatch on call 1: tools \[echo\] \(recorded \[echo, other\]\)/);
});

test("replay request checks can be turned off", async () => {
  const replay = createReplayModel(
    { version: CASSETTE_VERSION, steps: [{ request: { messageCount: 99, lastRole: "user", toolNames: [] }, response: replyText("x") }] },
    { checkRequests: false },
  );
  const messages = await runWith(replay.model);
  replay.dispose();
  assert.equal((messages.at(-1) as AssistantMessage).stopReason, "stop");
});

test("function steps receive the live context", async () => {
  const replay = createReplayModel([
    (context, index) => replyText(`saw ${context.messages.length} message(s) on call ${index}`),
  ]);
  const messages = await runWith(replay.model);
  replay.dispose();

  const text = (messages[1] as AssistantMessage).content[0] as { text: string };
  assert.equal(text.text, "saw 1 message(s) on call 0");
});

test("dispose unregisters the backing provider", () => {
  const replay = createReplayModel([]);
  assert.ok(getApiProvider(replay.model.api));
  replay.dispose();
  assert.equal(getApiProvider(replay.model.api), undefined);
});
