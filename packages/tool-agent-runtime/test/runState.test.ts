// ---------------------------------------------------------------------------
// Tests: `messages` input, serializable RunState, resume and checkpoints.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  parseRunState,
  runAgent,
  runToolAgent,
  RUN_STATE_VERSION,
  RunStateError,
  serializeRunState,
  type AgentTool,
  type RunState,
} from "../src/index.js";
import { collectEvents, createReplayModel, recordTool, replyError, replyText, replyToolCalls } from "../src/testing.js";

const params = Type.Object({ q: Type.Optional(Type.String()) });
function lookup(name = "lookup", details: unknown = { ok: true }): AgentTool<typeof params> {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: params,
    execute: async (id) => ({ content: [{ type: "text", text: `${name} ${id}` }], details: details as never }),
  };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const roles = (messages: Message[]) => messages.map((m) => m.role);
const textOf = (m: Message) =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((c) => ("text" in c ? c.text : c.type === "toolCall" ? `call:${c.name}` : "")).join("");

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("round trip: run → serialize → parse → resume with a new prompt", async () => {
  const replay = createReplayModel([
    replyToolCalls([{ name: "lookup", id: "c1" }], { usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } }),
    replyText("first answer", { usage: { input: 20, output: 5, totalTokens: 25, cost: { total: 0.02 } } }),
    replyText("second answer", { usage: { input: 30, output: 5, totalTokens: 35, cost: { total: 0.03 } } }),
  ]);
  const base = { systemPrompt: "s", model: replay.model, tools: [lookup()] };

  const first = await runAgent({ ...base, prompt: "question one" });
  assert.equal(first.reason, "completed");
  assert.equal(first.text, "first answer");
  assert.deepEqual(
    { turns: first.state.turns, calls: first.state.toolCallsExecuted, tokens: first.state.usage.totalTokens },
    { turns: 2, calls: 1, tokens: 40 },
  );
  assert.equal(first.state.version, RUN_STATE_VERSION);
  assert.equal(first.state.endReason, "completed");

  const saved = serializeRunState(first.state);
  const restored = parseRunState(saved);
  assert.deepEqual(restored, JSON.parse(saved));

  const events = collectEvents();
  const second = await runAgent({ ...base, resumeFrom: restored, prompt: "question two" }, events.emit);
  replay.dispose();

  assert.equal(second.text, "second answer");
  assert.deepEqual(roles(replay.calls[2]!.messages), ["user", "assistant", "toolResult", "assistant", "user"]);
  assert.equal(second.state.turns, 3);
  assert.equal(second.state.toolCallsExecuted, 1);
  assert.equal(second.state.usage.totalTokens, 75);
  assert.ok(Math.abs(second.state.usage.cost.total - 0.06) < 1e-9);
  assert.equal(events.ofType("agent_start")[0]!.resumed, true);
  assert.deepEqual(events.ofType("agent_end")[0]!.state, second.state, "agent_end carries the same state");
});

test("runToolAgent: a fresh run is unchanged except for resumed: false and agent_end.state", async () => {
  const replay = createReplayModel([replyText("hi")]);
  const events = collectEvents();
  const returned = await runToolAgent({ systemPrompt: "s", model: replay.model, tools: [], prompt: "hello" }, events.emit);
  replay.dispose();
  assert.equal(returned, undefined, "runToolAgent still resolves with nothing");
  assert.deepEqual(
    events.types().filter((t) => t !== "message_update"),
    ["agent_start", "turn_start", "message_start", "message_end", "message_start", "message_end", "turn_end", "agent_end"],
  );
  assert.equal(events.ofType("agent_start")[0]!.resumed, false);
  const state = events.ofType("agent_end")[0]!.state!;
  assert.deepEqual(roles(state.messages), ["user", "assistant"]);
  assert.equal(state.metadata, undefined);
});

// ---------------------------------------------------------------------------
// Starting transcript
// ---------------------------------------------------------------------------

test("messages: the run continues from the given conversation, with or without a prompt", async () => {
  const history: Message[] = [user("earlier"), { ...replyText("earlier answer") }, user("follow-up")];
  const replay = createReplayModel([replyText("a"), replyText("b")]);
  const base = { systemPrompt: "s", model: replay.model, tools: [] };

  const plain = await runAgent({ ...base, messages: history });
  assert.deepEqual(roles(replay.calls[0]!.messages), ["user", "assistant", "user"]);
  assert.equal(plain.state.turns, 1, "counters start at zero with messages");

  await runAgent({ ...base, messages: history.slice(0, 2), prompt: "new question" });
  replay.dispose();
  assert.deepEqual(replay.calls[1]!.messages.map(textOf), ["earlier", "earlier answer", "new question"]);
  assert.equal(history.length, 3, "the caller's array is not mutated");
});

test("start validation: ambiguous or empty starts and images without a prompt are errors", async () => {
  const replay = createReplayModel([]);
  const base = { systemPrompt: "s", model: replay.model, tools: [] };
  const state = (await runAgent({ ...base, messages: [user("x"), replyText("y")] })).state;
  await assert.rejects(runAgent({ ...base, messages: [user("x")], resumeFrom: state }), /either messages or resumeFrom/);
  await assert.rejects(runAgent({ ...base }), /One of prompt, messages or resumeFrom is required/);
  await assert.rejects(
    runAgent({ ...base, messages: [user("x")], images: [{ type: "image", data: "AA", mimeType: "image/png" }] }),
    /images require a prompt/,
  );
  await assert.rejects(runAgent({ ...base, resumeFrom: { ...state, version: 2 as 1 } }), RunStateError);
  replay.dispose();
});

test("a finished conversation with no new prompt ends at once without a model call", async () => {
  const replay = createReplayModel([]);
  const result = await runAgent({ systemPrompt: "s", model: replay.model, tools: [], messages: [user("q"), replyText("done")] });
  replay.dispose();
  assert.equal(replay.calls.length, 0);
  assert.equal(result.reason, "completed");
  assert.equal(result.text, "done");
});

test("a trailing failed or aborted reply is dropped so the model retries the turn", async () => {
  const failed = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyError("provider down")]).model,
    tools: [],
    prompt: "q",
  });
  assert.equal(failed.reason, "error");
  assert.equal(failed.state.errorMessage, "provider down");
  assert.deepEqual(roles(failed.state.messages), ["user", "assistant"]);

  const replay = createReplayModel([replyText("recovered")]);
  const retried = await runAgent({ systemPrompt: "s", model: replay.model, tools: [], resumeFrom: failed.state });
  replay.dispose();
  assert.deepEqual(roles(replay.calls[0]!.messages), ["user"], "the failed reply is not sent again");
  assert.equal(retried.text, "recovered");
  assert.equal(retried.state.turns, 2, "the failed call still counts");
  assert.deepEqual(roles(retried.state.messages), ["user", "assistant"]);
});

// ---------------------------------------------------------------------------
// Pending tool calls
// ---------------------------------------------------------------------------

test("pending calls: only calls without a result run, then the model is called", async () => {
  const a = recordTool(lookup("a"));
  const b = recordTool(lookup("b"));
  const assistant = replyToolCalls([{ name: "a", id: "ca" }, { name: "b", id: "cb" }]);
  const resultA: Message = { role: "toolResult", toolCallId: "ca", toolName: "a", content: [{ type: "text", text: "a done" }], details: {}, isError: false, timestamp: 0 };
  const state: RunState = {
    version: 1,
    messages: [user("do both"), assistant, resultA],
    turns: 1,
    toolCallsExecuted: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    metadata: { job: "42" },
  };
  const replay = createReplayModel([replyText("both done")]);
  const events = collectEvents();
  const result = await runAgent({ systemPrompt: "s", model: replay.model, tools: [a.tool, b.tool], resumeFrom: state }, events.emit);
  replay.dispose();

  assert.equal(a.calls.length, 0, "a already has a result");
  assert.deepEqual(b.calls.map((c) => c.toolCallId), ["cb"]);
  assert.deepEqual(roles(replay.calls[0]!.messages), ["user", "assistant", "toolResult", "toolResult"]);
  const finished = events.ofType("turn_end")[0]!;
  assert.deepEqual(finished.toolResults.map((r) => r.toolCallId), ["ca", "cb"], "the resumed turn reports all its results");
  assert.equal(finished.usage!.totalTokens, 0, "no new model call for the pending batch");
  assert.equal(result.state.turns, 2);
  assert.equal(result.state.toolCallsExecuted, 2);
  assert.deepEqual(result.state.metadata, { job: "42" }, "metadata is copied through");
});

test("pending calls run before a new prompt; maxToolCalls counts across resumes", async () => {
  const b = recordTool(lookup("b"));
  const pendingState = (toolCallsExecuted: number): RunState => ({
    version: 1,
    messages: [user("go"), replyToolCalls([{ name: "b", id: "cb" }])],
    turns: 1,
    toolCallsExecuted,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });

  const replay = createReplayModel([replyText("ok")]);
  await runAgent({ systemPrompt: "s", model: replay.model, tools: [b.tool], resumeFrom: pendingState(0), prompt: "and then?" });
  replay.dispose();
  assert.deepEqual(roles(replay.calls[0]!.messages), ["user", "assistant", "toolResult", "user"]);

  const capped = await runAgent({ systemPrompt: "s", model: createReplayModel([]).model, tools: [b.tool], resumeFrom: pendingState(2), maxToolCalls: 2 });
  assert.equal(capped.reason, "max_tool_calls");
  assert.equal(b.calls.length, 1, "the over-limit pending call was not executed");
  const last = capped.state.messages.at(-1)!;
  assert.equal(last.role === "toolResult" && last.isError, true);
});

// ---------------------------------------------------------------------------
// Cumulative limits, turn numbers
// ---------------------------------------------------------------------------

test("maxTurns and budget count across resumes", async () => {
  const replay = createReplayModel([
    replyToolCalls([{ name: "lookup", id: "1" }], { usage: { totalTokens: 40 } }),
    replyToolCalls([{ name: "lookup", id: "2" }], { usage: { totalTokens: 40 } }),
    replyToolCalls([{ name: "lookup", id: "3" }], { usage: { totalTokens: 40 } }),
  ]);
  const base = { systemPrompt: "s", model: replay.model, tools: [lookup()] };

  const first = await runAgent({ ...base, prompt: "go", maxTurns: 2 });
  assert.equal(first.reason, "max_turns");
  const second = await runAgent({ ...base, resumeFrom: first.state, maxTurns: 3 });
  assert.equal(second.reason, "max_turns");
  assert.equal(second.state.turns, 3);
  const third = await runAgent({ ...base, resumeFrom: second.state, maxTurns: 3 });
  assert.equal(third.reason, "max_turns", "limit already used up: ends without a model call");
  assert.equal(replay.calls.length, 3);

  const overBudget = await runAgent({ ...base, resumeFrom: second.state, budget: { maxTotalTokens: 100 } });
  assert.equal(overBudget.reason, "budget");
  assert.equal(replay.calls.length, 3);
  replay.dispose();

  // A fresh allowance: pass the transcript as messages instead.
  const fresh = createReplayModel([replyText("fine")]);
  const restart = await runAgent({ ...base, model: fresh.model, messages: second.state.messages, maxTurns: 1 });
  fresh.dispose();
  assert.equal(restart.reason, "completed");
  assert.equal(restart.state.turns, 1);
});

test("prepareStep turn numbers continue from the saved state", async () => {
  const turnsSeen: number[] = [];
  const state = (await runAgent({ systemPrompt: "s", model: createReplayModel([replyText("one")]).model, tools: [], prompt: "a" })).state;
  await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyText("two")]).model,
    tools: [],
    resumeFrom: state,
    prompt: "b",
    prepareStep: ({ turn, steps }) => {
      turnsSeen.push(turn, steps.length);
      return undefined;
    },
  });
  assert.deepEqual(turnsSeen, [2, 0]);
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test("onCheckpoint: awaited after each continuing step and once at the end", async () => {
  const replay = createReplayModel([
    replyToolCalls([{ name: "lookup", id: "1" }]),
    replyToolCalls([{ name: "lookup", id: "2" }]),
    replyText("done"),
  ]);
  const seen: Array<{ modelCalls: number; turns: number; end?: string }> = [];
  await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools: [lookup()],
    prompt: "go",
    onCheckpoint: async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push({ modelCalls: replay.calls.length, turns: state.turns, ...(state.endReason ? { end: state.endReason } : {}) });
    },
  });
  replay.dispose();
  assert.deepEqual(seen, [
    { modelCalls: 1, turns: 1 },
    { modelCalls: 2, turns: 2 },
    { modelCalls: 3, turns: 3, end: "completed" },
  ]);
});

test("onCheckpoint: a throw ends the run with reason error", async () => {
  const replay = createReplayModel([replyToolCalls([{ name: "lookup", id: "1" }]), replyText("never")]);
  const result = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools: [lookup()],
    prompt: "go",
    onCheckpoint: () => {
      throw new Error("disk full");
    },
  });
  replay.dispose();
  assert.equal(result.reason, "error");
  assert.equal(result.errorMessage, "onCheckpoint failed: disk full");
  assert.equal(replay.calls.length, 1, "no model call after a failed checkpoint");

  let calls = 0;
  const atEnd = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyText("hi")]).model,
    tools: [],
    prompt: "go",
    onCheckpoint: () => {
      calls++;
      throw new Error("late");
    },
  });
  assert.equal(atEnd.reason, "error");
  assert.equal(atEnd.state.endReason, "error");
  assert.equal(calls, 1, "the end checkpoint is not retried");
});

// ---------------------------------------------------------------------------
// serializeRunState / parseRunState
// ---------------------------------------------------------------------------

test("serializeRunState rejects values JSON would drop or change, naming the tool", async () => {
  const run = async (details: unknown) =>
    (
      await runAgent({
        systemPrompt: "s",
        model: createReplayModel([replyToolCalls([{ name: "clock", id: "1" }]), replyText("ok")]).model,
        tools: [lookup("clock", details)],
        prompt: "time?",
      })
    ).state;

  const dated = await run({ at: new Date(0) });
  assert.throws(() => serializeRunState(dated), /messages\[2\]\.details\.at: Date \(tool "clock"\)/);
  assert.throws(() => serializeRunState(dated), RunStateError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const [details, message] of [
    [{ n: Number.NaN }, /details\.n: NaN/],
    [{ list: [1, undefined] }, /undefined in an array/],
    [{ fn: () => 1 }, /details\.fn: function/],
    [{ map: new Map() }, /details\.map: Map/],
    [cyclic, /circular reference/],
  ] as const) {
    const state = await run(details);
    assert.throws(() => serializeRunState(state), message);
  }

  const ok = await run({ when: "2026-01-01", skipped: undefined });
  assert.doesNotThrow(() => serializeRunState(ok), "undefined object properties are fine (JSON omits them)");
  assert.throws(() => serializeRunState({ ...ok, metadata: { at: new Date() } }), /state\.metadata\.at: Date/);
});

test("parseRunState validates shape and version", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const valid = { version: 1, messages: [{ role: "user", content: "x", timestamp: 0 }], turns: 0, toolCallsExecuted: 0, usage };
  assert.deepEqual(parseRunState(JSON.stringify(valid)), valid);

  assert.throws(() => parseRunState("{nope"), /not valid JSON/);
  assert.throws(() => parseRunState({ ...valid, version: 2 }), /version 2 is newer than this runtime supports \(1\)/);
  assert.throws(() => parseRunState({ ...valid, version: "1" }), /unknown version "1"/);
  assert.throws(() => parseRunState({ ...valid, messages: [{ role: "system" }] }), /messages\[0\]/);
  assert.throws(() => parseRunState({ ...valid, turns: -1 }), /turns must be a non-negative integer/);
  assert.throws(() => parseRunState({ ...valid, usage: { ...usage, cost: {} } }), /usage\.cost\.input/);
  assert.throws(() => parseRunState({ ...valid, metadata: [] }), /metadata must be an object/);
  assert.throws(() => parseRunState(null), RunStateError);

  const copy = parseRunState(valid);
  copy.messages.push({ role: "user", content: "y", timestamp: 0 });
  assert.equal(valid.messages.length, 1, "parse returns a copy");
});

test("an aborted run's state resumes like a failed one", async () => {
  const aborted: AssistantMessage = { ...replyText(""), content: [], stopReason: "aborted", errorMessage: "user cancelled" };
  const first = await runAgent({ systemPrompt: "s", model: createReplayModel([aborted]).model, tools: [], prompt: "q" });
  assert.equal(first.reason, "aborted");
  const replay = createReplayModel([replyText("answer")]);
  const second = await runAgent({ systemPrompt: "s", model: replay.model, tools: [], resumeFrom: first.state });
  replay.dispose();
  assert.deepEqual(roles(replay.calls[0]!.messages), ["user"]);
  assert.equal(second.reason, "completed");
});
