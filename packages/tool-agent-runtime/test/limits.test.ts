// ---------------------------------------------------------------------------
// Tests: run limits, end reasons, tool timeouts, concurrency, usage, budget.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Type, type ToolResultMessage } from "@mariozechner/pi-ai";
import {
  ToolTimeoutError,
  runToolAgent,
  type AgentTool,
  type AgentToolResult,
  type ToolAgentRunInput,
} from "../src/index.js";
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

const textResult = (text: string, extra: Partial<AgentToolResult<any>> = {}): AgentToolResult<any> => ({
  content: [{ type: "text", text }],
  details: {},
  ...extra,
});

const noParams = Type.Object({});

function tool(
  name: string,
  execute: AgentTool<typeof noParams>["execute"],
  extra: Partial<Pick<AgentTool, "timeoutMs" | "executionMode">> = {},
): AgentTool<typeof noParams> {
  return { name, label: name, description: name, parameters: noParams, execute, ...extra };
}

const ok = tool("ok", async () => textResult("ok"));

async function run(replay: ReplayModel, tools: AgentTool<any>[], extra: Partial<ToolAgentRunInput> = {}) {
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", ...extra }, events.emit);
  const end = events.ofType("agent_end")[0]!;
  return { events, end };
}

const callOk = (n = 1) => replyToolCalls(Array.from({ length: n }, (_, i) => ({ name: "ok", id: `c${i + 1}` })));

function toolResults(messages: unknown[]): ToolResultMessage[] {
  return (messages as ToolResultMessage[]).filter((m) => m.role === "toolResult");
}

const text = (m: { content: unknown[] }) => (m.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// End reasons
// ---------------------------------------------------------------------------

test("reason: completed when the model answers without tools", async () => {
  const { end } = await run(script(replyText("hi")), [ok]);
  assert.equal(end.reason, "completed");
  assert.equal(end.errorMessage, undefined);
});

test("reason: terminated when every result terminates", async () => {
  const stop = tool("ok", async () => textResult("bye", { terminate: true }));
  const { end } = await run(script(callOk(), replyText("never")), [stop]);
  assert.equal(end.reason, "terminated");
});

test("reason: error carries the model's error message", async () => {
  const { end } = await run(script(replyError("overloaded")), [ok]);
  assert.equal(end.reason, "error");
  assert.equal(end.errorMessage, "overloaded");
});

test("reason: aborted when the signal is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const { end } = await run(script(replyText("x")), [ok], { signal: controller.signal });
  assert.equal(end.reason, "aborted");
  assert.equal(end.errorMessage, "Request was aborted");
});

// ---------------------------------------------------------------------------
// maxTurns / maxToolCalls
// ---------------------------------------------------------------------------

test("maxTurns: stops after N model calls; the last batch still runs", async () => {
  const replay = script(callOk(), callOk(), callOk());
  const spy = recordTool(ok);
  const { end, events } = await run(replay, [spy.tool], { maxTurns: 2 });

  assert.equal(end.reason, "max_turns");
  assert.equal(replay.calls.length, 2);
  assert.equal(replay.remaining, 1);
  assert.equal(spy.calls.length, 2);
  assert.equal(end.messages.at(-1)!.role, "toolResult", "every tool call has a result");
  assert.equal(events.ofType("turn_start").length, 2);
});

test("maxTurns: a run that finishes earlier reports completed", async () => {
  const { end } = await run(script(callOk(), replyText("done")), [ok], { maxTurns: 5 });
  assert.equal(end.reason, "completed");
});

test("maxToolCalls: calls beyond the limit get an error result and the run stops", async () => {
  const replay = script(callOk(2), callOk(2), replyText("never"));
  const spy = recordTool(ok);
  const { end, events } = await run(replay, [spy.tool], { maxToolCalls: 3 });

  assert.equal(end.reason, "max_tool_calls");
  assert.equal(spy.calls.length, 3);
  assert.equal(replay.calls.length, 2);
  const lastBatch = toolResults(end.messages).slice(-2);
  assert.deepEqual(lastBatch.map((m) => m.isError), [false, true]);
  assert.match(text(lastBatch[1]!), /Tool call limit of 3 reached/);
  // The blocked call is still visible to UIs as a started + ended tool execution.
  assert.equal(events.ofType("tool_execution_end").length, 4);
});

test("maxToolCalls: reaching the limit exactly lets the model still answer", async () => {
  const { end } = await run(script(callOk(2), replyText("summary")), [ok], { maxToolCalls: 2 });
  assert.equal(end.reason, "completed");
});

test("invalid limits are rejected before the run starts", async () => {
  const replay = script(replyText("x"));
  for (const extra of [
    { maxTurns: 0 },
    { maxToolCalls: 1.5 },
    { maxParallelTools: -1 },
    { toolTimeoutMs: 0 },
    { budget: { maxCostUsd: Number.NaN } },
  ] satisfies Partial<ToolAgentRunInput>[]) {
    const events = collectEvents();
    await assert.rejects(
      runToolAgent({ systemPrompt: "s", model: replay.model, tools: [ok], prompt: "go", ...extra }, events.emit),
      RangeError,
    );
    assert.equal(events.events.length, 0);
  }
  await assert.rejects(
    run(replay, [tool("bad", async () => textResult("x"), { timeoutMs: -5 })]),
    /timeoutMs of tool "bad"/,
  );
});

// ---------------------------------------------------------------------------
// Tool timeouts
// ---------------------------------------------------------------------------

test("timeout: a hung tool is cut off, signalled, and reported to the model", async () => {
  let seenSignal: AbortSignal | undefined;
  const hung = tool(
    "hung",
    (_id, _p, signal) => {
      seenSignal = signal;
      return new Promise(() => {}); // never settles, ignores the signal
    },
    { timeoutMs: 30 },
  );
  const replay = script(replyToolCalls([{ name: "hung" }]), replyText("moved on"));
  const { end } = await run(replay, [hung]);

  const [result] = toolResults(end.messages);
  assert.equal(result!.isError, true);
  assert.match(text(result!), /Tool "hung" timed out after 30ms/);
  assert.deepEqual(result!.details, { error: "ToolTimeoutError", timeoutMs: 30 });
  assert.equal(seenSignal?.aborted, true);
  assert.ok(seenSignal?.reason instanceof ToolTimeoutError);
  assert.equal(end.reason, "completed", "the run continues after a timeout");
});

test("timeout: run-level default applies, a tool's own timeoutMs overrides it", async () => {
  const slow = (name: string, extra: Partial<Pick<AgentTool, "timeoutMs">> = {}) =>
    tool(name, async () => (await sleep(60), textResult(name)), extra);
  const replay = script(
    replyToolCalls([{ name: "defaulted", id: "a" }, { name: "overridden", id: "b" }]),
    replyText("ok"),
  );
  const { end } = await run(replay, [slow("defaulted"), slow("overridden", { timeoutMs: 2_000 })], {
    toolTimeoutMs: 20,
  });

  const [defaulted, overridden] = toolResults(end.messages);
  assert.equal(defaulted!.isError, true);
  assert.match(text(defaulted!), /timed out after 20ms/);
  assert.equal(overridden!.isError, false);
});

test("timeout: a caller abort is not reported as a timeout", async () => {
  const controller = new AbortController();
  const waits = tool(
    "waits",
    (_id, _p, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error(`stopped: ${String(signal.reason)}`)), { once: true });
        setTimeout(() => controller.abort("user cancelled"), 5);
      }),
    { timeoutMs: 1_000 },
  );
  const { end } = await run(script(replyToolCalls([{ name: "waits" }])), [waits], { signal: controller.signal });

  const [result] = toolResults(end.messages);
  assert.match(text(result!), /stopped: user cancelled/);
  assert.deepEqual(result!.details, {});
  assert.equal(end.reason, "aborted");
});

test("timeout: updates sent after the timeout are dropped", async () => {
  const late = tool(
    "late",
    (_id, _p, _s, onUpdate) =>
      new Promise((resolve) => {
        onUpdate?.(textResult("early"));
        setTimeout(() => {
          onUpdate?.(textResult("too late"));
          resolve(textResult("done"));
        }, 40);
      }),
    { timeoutMs: 10 },
  );
  const { events } = await run(script(replyToolCalls([{ name: "late" }]), replyText("ok")), [late]);
  await sleep(60);

  assert.deepEqual(events.ofType("tool_execution_update").map((u) => text(u.partialResult)), ["early"]);
});

test("no timeout configured: the tool receives the caller's signal unchanged", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const probe = tool("probe", async (_id, _p, signal) => ((seen = signal), textResult("x")));
  await run(script(replyToolCalls([{ name: "probe" }]), replyText("ok")), [probe], { signal: controller.signal });
  assert.equal(seen, controller.signal);
});

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

test("maxParallelTools: at most N tools in flight, results stay in call order", async () => {
  const tracker = { active: 0, max: 0 };
  const started: string[] = [];
  const worker = (name: string, ms: number) =>
    tool(name, async () => {
      started.push(name);
      tracker.active++;
      tracker.max = Math.max(tracker.max, tracker.active);
      await sleep(ms);
      tracker.active--;
      return textResult(name);
    });
  const tools = [worker("a", 30), worker("b", 5), worker("c", 5), worker("d", 5)];
  const replay = script(
    replyToolCalls(tools.map((t) => ({ name: t.name, id: `id-${t.name}` }))),
    replyText("ok"),
  );
  const { end, events } = await run(replay, tools, { maxParallelTools: 2 });

  assert.equal(tracker.max, 2);
  assert.deepEqual(toolResults(end.messages).map((m) => m.toolName), ["a", "b", "c", "d"]);
  // tool_execution_start reflects when a tool actually starts.
  assert.deepEqual(events.ofType("tool_execution_start").map((e) => e.toolName), started);
});

// ---------------------------------------------------------------------------
// Usage and budget
// ---------------------------------------------------------------------------

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  totalTokens: input + output,
  cost: { input: cost / 2, output: cost / 2, total: cost },
});

test("usage: reported per turn on turn_end and summed on agent_end", async () => {
  const replay = script(
    replyToolCalls([{ name: "ok" }], { usage: usage(100, 10, 0.002) }),
    replyText("done", { usage: usage(150, 20, 0.003) }),
  );
  const { end, events } = await run(replay, [ok]);

  assert.deepEqual(events.ofType("turn_end").map((e) => e.usage?.totalTokens), [110, 170]);
  assert.equal(end.usage?.input, 250);
  assert.equal(end.usage?.output, 30);
  assert.equal(end.usage?.totalTokens, 280);
  assert.ok(Math.abs(end.usage!.cost.total - 0.005) < 1e-12);
});

test("budget: token budget stops the run after the turn that reaches it", async () => {
  const replay = script(
    replyToolCalls([{ name: "ok" }], { usage: usage(40, 20, 0) }),
    replyText("never", { usage: usage(1, 1, 0) }),
  );
  const spy = recordTool(ok);
  const { end } = await run(replay, [spy.tool], { budget: { maxTotalTokens: 50 } });

  assert.equal(end.reason, "budget");
  assert.equal(replay.calls.length, 1);
  assert.equal(spy.calls.length, 1, "the batch of the last turn still runs");
});

test("budget: cost budget stops the run", async () => {
  const replay = script(
    replyToolCalls([{ name: "ok" }], { usage: usage(10, 10, 0.4) }),
    replyToolCalls([{ name: "ok" }], { usage: usage(10, 10, 0.4) }),
    replyText("never"),
  );
  const { end } = await run(replay, [ok], { budget: { maxCostUsd: 0.75 } });
  assert.equal(end.reason, "budget");
  assert.equal(replay.calls.length, 2);
});

test("budget: not reached → normal completion", async () => {
  const replay = script(replyToolCalls([{ name: "ok" }], { usage: usage(10, 10, 0.01) }), replyText("done"));
  const { end } = await run(replay, [ok], { budget: { maxTotalTokens: 1_000, maxCostUsd: 1 } });
  assert.equal(end.reason, "completed");
});
