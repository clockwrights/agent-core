// ---------------------------------------------------------------------------
// Tests: runToolAgent loop behaviour, driven by a scripted replay model.
// No network: every model call is answered by the replay provider.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Type, type ToolResultMessage } from "@earendil-works/pi-ai";
import { runToolAgent, type AgentTool, type AgentToolResult } from "../src/index.js";
import {
  collectEvents,
  createReplayModel,
  recordTool,
  replyError,
  replyText,
  replyToolCalls,
  type ReplayModel,
  type ReplayStep,
} from "../src/testing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const models: ReplayModel[] = [];
afterEach(() => {
  while (models.length) models.pop()!.dispose();
});

function script(...steps: ReplayStep[]): ReplayModel {
  const replay = createReplayModel(steps);
  models.push(replay);
  return replay;
}

function textResult(text: string, extra: Partial<AgentToolResult<any>> = {}): AgentToolResult<any> {
  return { content: [{ type: "text", text }], details: {}, ...extra };
}

const echoParams = Type.Object({ message: Type.String() });

const echo: AgentTool<typeof echoParams> = {
  name: "echo",
  label: "Echo",
  description: "Echo a message.",
  parameters: echoParams,
  execute: async (_id, { message }) => textResult(message, { details: { message } }),
};

const failing: AgentTool = {
  name: "fail",
  label: "Fail",
  description: "Always throws.",
  parameters: Type.Object({}),
  execute: async () => {
    throw new Error("disk on fire");
  },
};

function run(replay: ReplayModel, tools: AgentTool<any>[], extra: { signal?: AbortSignal; prompt?: string } = {}) {
  const events = collectEvents();
  const done = runToolAgent(
    {
      systemPrompt: "You are a test agent.",
      model: replay.model,
      tools,
      prompt: extra.prompt ?? "go",
      signal: extra.signal,
    },
    events.emit,
  );
  return { events, done };
}

function toolResultsSeenOnCall(replay: ReplayModel, callIndex: number): ToolResultMessage[] {
  return replay.calls[callIndex]!.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

function resultText(m: { content: unknown[] }): string {
  return (m.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
}

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

test("text-only reply: one turn, ordered lifecycle events, run ends", async () => {
  const replay = script(replyText("hello"));
  const { events, done } = run(replay, [echo]);
  await done;

  const types = events.types();
  assert.deepEqual(types.slice(0, 5), ["agent_start", "turn_start", "message_start", "message_end", "message_start"]);
  assert.deepEqual(types.slice(-3), ["message_end", "turn_end", "agent_end"]);
  assert.ok(types.includes("message_update"), "assistant output is streamed");
  assert.equal(events.ofType("turn_start").length, 1);

  const end = events.ofType("agent_end")[0]!;
  assert.equal(end.messages.length, 2);
  assert.equal(end.messages[1]!.role, "assistant");
  assert.equal(replay.calls.length, 1);
  assert.equal(replay.calls[0]!.systemPrompt, "You are a test agent.");
  assert.deepEqual(replay.calls[0]!.tools!.map((t) => t.name), ["echo"]);
});

test("prompt images are attached to the first user message", async () => {
  const replay = script(replyText("seen"));
  const events = collectEvents();
  await runToolAgent(
    {
      systemPrompt: "s",
      model: replay.model,
      tools: [],
      prompt: "look",
      images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    },
    events.emit,
  );
  const user = replay.calls[0]!.messages[0]!;
  assert.equal(user.role, "user");
  assert.deepEqual(
    (user.content as Array<{ type: string }>).map((c) => c.type),
    ["text", "image"],
  );
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

test("tool success: result is fed back to the model and the loop continues", async () => {
  const recorded = recordTool(echo);
  const replay = script(replyToolCalls([{ name: "echo", arguments: { message: "ping" }, id: "c1" }]), replyText("done"));
  const { events, done } = run(replay, [recorded.tool]);
  await done;

  assert.equal(recorded.calls.length, 1);
  assert.deepEqual(recorded.calls[0]!.params, { message: "ping" });

  const seen = toolResultsSeenOnCall(replay, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolCallId, "c1");
  assert.equal(seen[0]!.isError, false);
  assert.equal(resultText(seen[0]!), "ping");

  const ends = events.ofType("tool_execution_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.isError, false);
  assert.equal(events.ofType("turn_start").length, 2);
  assert.equal(events.ofType("agent_end")[0]!.messages.length, 4);
});

test("tool error: thrown error becomes an isError result the model sees", async () => {
  const replay = script(replyToolCalls([{ name: "fail" }]), replyText("recovered"));
  const { events, done } = run(replay, [failing]);
  await done;

  const seen = toolResultsSeenOnCall(replay, 1);
  assert.equal(seen[0]!.isError, true);
  assert.match(resultText(seen[0]!), /disk on fire/);
  assert.equal(events.ofType("tool_execution_end")[0]!.isError, true);
  const last = events.ofType("agent_end")[0]!.messages.at(-1)!;
  assert.equal(last.role, "assistant");
});

test("unknown tool: reported to the model as an error result", async () => {
  const replay = script(replyToolCalls([{ name: "nope" }]), replyText("ok"));
  const { done } = run(replay, [echo]);
  await done;

  const seen = toolResultsSeenOnCall(replay, 1);
  assert.equal(seen[0]!.isError, true);
  assert.match(resultText(seen[0]!), /Tool "nope" not found/);
});

test("invalid arguments: validation error is fed back and the tool never runs", async () => {
  const recorded = recordTool(echo);
  const replay = script(replyToolCalls([{ name: "echo", arguments: {} }]), replyText("ok"));
  const { done } = run(replay, [recorded.tool]);
  await done;

  assert.equal(recorded.calls.length, 0);
  const seen = toolResultsSeenOnCall(replay, 1)[0]!;
  assert.equal(seen.isError, true);
  assert.match(resultText(seen), /message/);
});

test("argument coercion: pi-ai coerces primitives to the schema type before execute", async () => {
  // Pinned on purpose: a pi-ai upgrade that changes coercion changes what tools receive.
  const recorded = recordTool(echo);
  const replay = script(replyToolCalls([{ name: "echo", arguments: { message: 42 } }]), replyText("ok"));
  const { done } = run(replay, [recorded.tool]);
  await done;

  assert.deepEqual(recorded.calls[0]!.params, { message: "42" });
});

test("prepareArguments: shim runs before validation", async () => {
  const shimmed: AgentTool<typeof echoParams> = {
    ...echo,
    prepareArguments: (args) => {
      const a = args as { msg?: string; message?: string };
      return { message: a.message ?? a.msg ?? "" };
    },
  };
  const recorded = recordTool(shimmed);
  const replay = script(replyToolCalls([{ name: "echo", arguments: { msg: "legacy" } }]), replyText("ok"));
  const { done } = run(replay, [recorded.tool]);
  await done;

  assert.deepEqual(recorded.calls[0]!.params, { message: "legacy" });
  assert.equal(toolResultsSeenOnCall(replay, 1)[0]!.isError, false);
});

test("onUpdate: partial results are emitted as tool_execution_update", async () => {
  const streaming: AgentTool = {
    name: "stream",
    label: "Stream",
    description: "Streams progress.",
    parameters: Type.Object({}),
    execute: async (_id, _p, _s, onUpdate) => {
      onUpdate?.(textResult("25%"));
      onUpdate?.(textResult("75%"));
      return textResult("100%");
    },
  };
  const replay = script(replyToolCalls([{ name: "stream" }]), replyText("ok"));
  const { events, done } = run(replay, [streaming]);
  await done;

  const updates = events.ofType("tool_execution_update");
  assert.deepEqual(updates.map((u) => resultText(u.partialResult)), ["25%", "75%"]);
});

// ---------------------------------------------------------------------------
// Batches: parallel vs sequential, ordering
// ---------------------------------------------------------------------------

/** Tool whose execute blocks until released; tracks concurrency. */
function gatedTool(name: string, tracker: { active: number; max: number }, mode?: "sequential" | "parallel") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tool: AgentTool = {
    name,
    label: name,
    description: `Gated tool ${name}.`,
    parameters: Type.Object({}),
    executionMode: mode,
    execute: async () => {
      tracker.active++;
      tracker.max = Math.max(tracker.max, tracker.active);
      await gate;
      tracker.active--;
      return textResult(name);
    },
  };
  return { tool, release };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Wait until `condition` holds; fail instead of hanging if it never does. */
async function waitFor(condition: () => boolean, what: string, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (condition()) return;
    await tick();
  }
  assert.fail(`timed out waiting for: ${what}`);
}

test("parallel batch: tools run concurrently; end events in completion order, results in source order", async () => {
  const tracker = { active: 0, max: 0 };
  const a = gatedTool("a", tracker);
  const b = gatedTool("b", tracker);
  const replay = script(replyToolCalls([{ name: "a", id: "ca" }, { name: "b", id: "cb" }]), replyText("ok"));
  const { events, done } = run(replay, [a.tool, b.tool]);

  await waitFor(() => tracker.active === 2, "both tools in flight");
  b.release();
  await tick();
  a.release();
  await done;

  assert.equal(tracker.max, 2, "both tools were in flight together");
  assert.deepEqual(events.ofType("tool_execution_end").map((e) => e.toolName), ["b", "a"]);
  assert.deepEqual(toolResultsSeenOnCall(replay, 1).map((m) => m.toolCallId), ["ca", "cb"]);
  const turnEnd = events.ofType("turn_end")[0]!;
  assert.deepEqual(turnEnd.toolResults.map((m) => m.toolName), ["a", "b"]);
});

test("sequential tool in a batch: whole batch runs one at a time, in source order", async () => {
  const tracker = { active: 0, max: 0 };
  const order: string[] = [];
  const mk = (name: string, mode?: "sequential"): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    executionMode: mode,
    execute: async () => {
      tracker.active++;
      tracker.max = Math.max(tracker.max, tracker.active);
      order.push(name);
      await tick();
      tracker.active--;
      return textResult(name);
    },
  });
  const replay = script(replyToolCalls([{ name: "x" }, { name: "y", }, { name: "z" }]), replyText("ok"));
  const { done } = run(replay, [mk("x"), mk("y", "sequential"), mk("z")]);
  await done;

  assert.equal(tracker.max, 1);
  assert.deepEqual(order, ["x", "y", "z"]);
});

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

test("terminate on every result: loop stops without another model call", async () => {
  const stopper: AgentTool<typeof echoParams> = { ...echo, name: "stop", execute: async () => textResult("bye", { terminate: true }) };
  const replay = script(
    replyToolCalls([
      { name: "stop", arguments: { message: "a" } },
      { name: "stop", arguments: { message: "b" }, id: "c2" },
    ]),
    replyText("never"),
  );
  const { events, done } = run(replay, [stopper]);
  await done;

  assert.equal(replay.calls.length, 1);
  assert.equal(replay.remaining, 1);
  assert.equal(events.ofType("agent_end").length, 1);
  assert.equal(events.types().at(-1), "agent_end");
});

test("terminate on only some results: loop continues", async () => {
  const stopper: AgentTool<typeof echoParams> = { ...echo, name: "stop", execute: async () => textResult("bye", { terminate: true }) };
  const replay = script(
    replyToolCalls([{ name: "stop", arguments: { message: "a" } }, { name: "echo", arguments: { message: "x" }, id: "c2" }]),
    replyText("continued"),
  );
  const { done } = run(replay, [stopper, echo]);
  await done;

  assert.equal(replay.calls.length, 2);
});

test("model error: run ends with agent_end and the error message last", async () => {
  const replay = script(replyError("rate limited"));
  const { events, done } = run(replay, [echo]);
  await done;

  const types = events.types();
  assert.deepEqual(types.slice(-2), ["turn_end", "agent_end"]);
  const last = events.ofType("agent_end")[0]!.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.equal((last as { stopReason: string }).stopReason, "error");
  assert.equal(events.ofType("turn_end")[0]!.toolResults.length, 0);
});

test("script exhausted: surfaces as a model error, not a hang", async () => {
  const replay = script(replyToolCalls([{ name: "echo", arguments: { message: "x" } }]));
  const { events, done } = run(replay, [echo]);
  await done;

  const last = events.ofType("agent_end")[0]!.messages.at(-1) as { stopReason: string; errorMessage?: string };
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /no scripted response for call 2/);
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test("abort during a tool: tool sees the signal, next model call is aborted, run ends", async () => {
  const controller = new AbortController();
  const waiting: AgentTool = {
    name: "wait",
    label: "Wait",
    description: "Waits until aborted.",
    parameters: Type.Object({}),
    execute: (_id, _p, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted by caller")), { once: true });
        controller.abort();
      }),
  };
  const recorded = recordTool(waiting);
  const replay = script(replyToolCalls([{ name: "wait" }]), replyText("should not be used"));
  const { events, done } = run(replay, [recorded.tool], { signal: controller.signal });
  await done;

  assert.equal(recorded.calls[0]!.aborted, true);
  assert.match(recorded.calls[0]!.error ?? "", /aborted by caller/);
  const last = events.ofType("agent_end")[0]!.messages.at(-1) as { stopReason: string };
  assert.equal(last.stopReason, "aborted");
  assert.equal(events.types().at(-1), "agent_end");
});

test("already-aborted signal: first model call aborts, no tools run", async () => {
  const controller = new AbortController();
  controller.abort();
  const recorded = recordTool(echo);
  const replay = script(replyToolCalls([{ name: "echo", arguments: { message: "x" } }]));
  const { events, done } = run(replay, [recorded.tool], { signal: controller.signal });
  await done;

  assert.equal(recorded.calls.length, 0);
  const last = events.ofType("agent_end")[0]!.messages.at(-1) as { stopReason: string };
  assert.equal(last.stopReason, "aborted");
});
