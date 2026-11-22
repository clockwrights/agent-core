import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { AgentEvent, AgentTool } from "@maya-ai/tool-agent-runtime";
import {
  createReplayModel,
  replyError,
  replyText,
  replyToolCalls,
  type ReplayModel,
  type ReplayStep
} from "@maya-ai/tool-agent-runtime/testing";
import {
  createRuntimeToolLlmAdapter,
  DEFAULT_ADAPTER_MAX_TURNS,
  runToolAgentLoop,
  type RuntimeToolLlmAdapterOptions,
  type ToolAgentInput,
  type ToolAgentOutput,
  type ToolLlmAdapter
} from "../src/index.js";

const models: ReplayModel[] = [];
afterEach(() => {
  while (models.length) models.pop()!.dispose();
});

function script(...steps: ReplayStep[]): ReplayModel {
  const replay = createReplayModel(steps);
  models.push(replay);
  return replay;
}

const echoParams = Type.Object({ message: Type.String() });
const echo: AgentTool<typeof echoParams> = {
  name: "echo",
  label: "Echo",
  description: "Echo.",
  parameters: echoParams,
  execute: async (_id, { message }) => ({ content: [{ type: "text", text: message }], details: {} })
};
const noParams = Type.Object({});
const failing: AgentTool<typeof noParams> = {
  name: "fail",
  label: "Fail",
  description: "Throws.",
  parameters: noParams,
  execute: async () => {
    throw new Error("broken");
  }
};
const hang: AgentTool<typeof noParams> = {
  name: "hang",
  label: "Hang",
  description: "Never settles.",
  parameters: noParams,
  execute: () => new Promise(() => {})
};

const baseInput = (extra: Partial<ToolAgentInput> = {}): ToolAgentInput => ({
  systemPrompt: "system",
  prompt: "go",
  sessionId: "session-1",
  tools: [echo, failing, hang],
  ...extra
});

function adapterFor(replay: ReplayModel, extra: Partial<RuntimeToolLlmAdapterOptions> = {}) {
  return createRuntimeToolLlmAdapter({ model: replay.model, ...extra });
}

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

test("metadata reports full support", () => {
  const adapter = adapterFor(script());
  assert.deepEqual(adapter.metadata(), {
    enabled: true,
    supports: { limits: true, usage: true, events: true, modelSelection: false, runState: true }
  });
  const routed = createRuntimeToolLlmAdapter({ model: () => script().model });
  assert.equal(routed.metadata().supports?.modelSelection, true, "function form can honour input.model");
});

test("output: last assistant text, tool calls with args and errors, usage, end reason, turns", async () => {
  const replay = script(
    replyToolCalls(
      [
        { name: "echo", arguments: { message: "hi" }, id: "a" },
        { name: "fail", id: "b" }
      ],
      { text: "Let me check.", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.001 } } }
    ),
    replyText("Final answer.", { usage: { input: 20, output: 3, totalTokens: 23, cost: { total: 0.002 } } })
  );
  const output = (await adapterFor(replay).runToolAgent(baseInput())) as ToolAgentOutput;

  assert.equal(output.text, "Final answer.", "only the last assistant message");
  assert.deepEqual(output.toolCalls, [
    { name: "echo", args: { message: "hi" }, isError: false },
    { name: "fail", args: {}, isError: true }
  ]);
  assert.equal(output.endReason, "completed");
  assert.equal(output.turns, 2);
  assert.equal(output.usage?.totalTokens, 35);
  assert.ok(Math.abs(output.usage!.cost.total - 0.003) < 1e-12);
  assert.equal(output.errorMessage, undefined);
});

test("output: model error → endReason error, errorMessage, empty text", async () => {
  const output = (await adapterFor(script(replyError("overloaded"))).runToolAgent(baseInput())) as ToolAgentOutput;
  assert.equal(output.endReason, "error");
  assert.equal(output.errorMessage, "overloaded");
  assert.equal(output.text, "");
  assert.equal(output.turns, 1);
});

// ---------------------------------------------------------------------------
// Input forwarding
// ---------------------------------------------------------------------------

test("forwards prompt, images, session id, maxTokens, signal and adapter options", async () => {
  const replay = script(replyText("ok"));
  const controller = new AbortController();
  await adapterFor(replay, { reasoning: "high", apiKey: "test-key-not-recorded" }).runToolAgent(
    baseInput({
      maxTokens: 321,
      images: [{ data: "aGk=", mimeType: "image/png" }],
      signal: controller.signal
    })
  );

  const call = replay.calls[0]!;
  assert.equal(call.systemPrompt, "system");
  assert.deepEqual(
    (call.messages[0]!.content as Array<{ type: string }>).map((c) => c.type),
    ["text", "image"]
  );
  assert.deepEqual(replay.callOptions[0], {
    reasoning: "high",
    maxTokens: 321,
    sessionId: "session-1",
    transport: undefined,
    hasSignal: true
  });
});

test("model can be chosen per call", async () => {
  const replay = script(replyText("ok"));
  const seen: string[] = [];
  const adapter = createRuntimeToolLlmAdapter({
    model: (input) => {
      seen.push(input.sessionId);
      return replay.model;
    }
  });
  await adapter.runToolAgent(baseInput({ sessionId: "child-7" }));
  assert.deepEqual(seen, ["child-7"]);
});

test("limits are forwarded: maxTurns", async () => {
  const replay = script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("never"));
  const output = await adapterFor(replay).runToolAgent(baseInput({ maxTurns: 1 }));
  assert.equal(output?.endReason, "max_turns");
  assert.equal(replay.calls.length, 1);
});

test("limits are forwarded: maxToolCalls (blocked call reported as an error)", async () => {
  const replay = script(
    replyToolCalls([
      { name: "echo", arguments: { message: "a" }, id: "1" },
      { name: "echo", arguments: { message: "b" }, id: "2" }
    ]),
    replyText("never")
  );
  const output = await adapterFor(replay).runToolAgent(baseInput({ maxToolCalls: 1 }));
  assert.equal(output?.endReason, "max_tool_calls");
  assert.deepEqual(output?.toolCalls.map((c) => c.isError), [false, true]);
});

test("limits are forwarded: budget and toolTimeoutMs", async () => {
  const budgetRun = await adapterFor(
    script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }], { usage: { totalTokens: 100 } }), replyText("never"))
  ).runToolAgent(baseInput({ budget: { maxTotalTokens: 50 } }));
  assert.equal(budgetRun?.endReason, "budget");

  const timeoutRun = await adapterFor(script(replyToolCalls([{ name: "hang" }]), replyText("moved on"))).runToolAgent(
    baseInput({ toolTimeoutMs: 20 })
  );
  assert.deepEqual(timeoutRun?.toolCalls, [{ name: "hang", args: {}, isError: true }]);
  assert.equal(timeoutRun?.text, "moved on");
});

test("defaults fill unset fields; input values win", async () => {
  const defaults = { maxTurns: 1, maxTokens: 111 };
  const capped = script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("never"));
  const cappedOut = await adapterFor(capped, { defaults }).runToolAgent(baseInput());
  assert.equal(cappedOut?.endReason, "max_turns");
  assert.equal(capped.callOptions[0]!.maxTokens, 111);

  const free = script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("done"));
  const freeOut = await adapterFor(free, { defaults }).runToolAgent(baseInput({ maxTurns: 5, maxTokens: 222 }));
  assert.equal(freeOut?.endReason, "completed");
  assert.equal(free.callOptions[0]!.maxTokens, 222);
});

test("invalid limits propagate as errors", async () => {
  await assert.rejects(adapterFor(script(replyText("x"))).runToolAgent(baseInput({ maxTurns: 0 })), RangeError);
});

// ---------------------------------------------------------------------------
// onEvent / onProgress
// ---------------------------------------------------------------------------

test("onEvent receives the raw runtime stream", async () => {
  const types: AgentEvent["type"][] = [];
  await adapterFor(script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("done"))).runToolAgent(
    baseInput({ onEvent: (e) => types.push(e.type) })
  );
  assert.equal(types[0], "agent_start");
  assert.equal(types.at(-1), "agent_end");
  assert.ok(types.includes("tool_execution_end"));
  assert.ok(types.includes("message_update"));
});

test("a throwing onEvent does not stop the run and is reported once", async (t: TestContext) => {
  const warn = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const output = await adapterFor(script(replyText("still fine"))).runToolAgent(
    baseInput({
      onEvent: () => {
        calls++;
        throw new Error("observer bug");
      }
    })
  );
  assert.equal(output?.text, "still fine");
  assert.equal(output?.endReason, "completed");
  assert.equal(calls, 1, "events stop being forwarded after the first failure");
  assert.equal(warn.mock.callCount(), 1);
});

test("onProgress gets a message per tool start; customisable", async () => {
  const progress: string[] = [];
  await adapterFor(script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("done"))).runToolAgent(
    baseInput({ onProgress: (m) => progress.push(m) })
  );
  assert.deepEqual(progress, ["Running Echo"]);

  const silent: string[] = [];
  await adapterFor(script(replyToolCalls([{ name: "echo", arguments: { message: "a" } }]), replyText("done")), {
    toolProgressMessage: () => undefined
  }).runToolAgent(baseInput({ onProgress: (m) => silent.push(m) }));
  assert.deepEqual(silent, []);
});

// ---------------------------------------------------------------------------
// runToolAgentLoop forwarding and compatibility
// ---------------------------------------------------------------------------

function recordingAdapter(outputs: Array<ToolAgentOutput | undefined>) {
  const inputs: ToolAgentInput[] = [];
  const adapter: ToolLlmAdapter = {
    runToolAgent: async (input) => {
      inputs.push(input);
      return outputs.shift();
    },
    // Minimal pre-existing adapter shape: no `supports`.
    metadata: () => ({ enabled: true })
  };
  return { adapter, inputs };
}

test("runToolAgentLoop forwards limits and onEvent on both passes", async () => {
  const { adapter, inputs } = recordingAdapter([{ text: "first", toolCalls: [] }, { text: "second", toolCalls: [] }]);
  const onEvent = () => {};
  const output = await runToolAgentLoop({
    llm: adapter,
    systemPrompt: "s",
    prompt: "p",
    sessionId: "sid",
    tools: [],
    maxTurns: 4,
    maxToolCalls: 9,
    budget: { maxCostUsd: 0.5 },
    toolTimeoutMs: 1_000,
    maxParallelTools: 2,
    onEvent,
    retry: { shouldRetry: (o) => o?.text === "first", buildRetryPrompt: () => "again" }
  });

  assert.equal(output?.text, "second");
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal(input.maxTurns, 4);
    assert.equal(input.maxToolCalls, 9);
    assert.deepEqual(input.budget, { maxCostUsd: 0.5 });
    assert.equal(input.toolTimeoutMs, 1_000);
    assert.equal(input.maxParallelTools, 2);
    assert.equal(input.onEvent, onEvent);
  }
});

test("runToolAgentLoop adds no new keys when the new fields are unset", async () => {
  const { adapter, inputs } = recordingAdapter([{ text: "x", toolCalls: [] }]);
  await runToolAgentLoop({ llm: adapter, systemPrompt: "s", prompt: "p", sessionId: "sid", tools: [] });
  assert.deepEqual(Object.keys(inputs[0]!).sort(), [
    "maxTokens",
    "onProgress",
    "prompt",
    "sessionId",
    "signal",
    "systemPrompt",
    "tools"
  ]);
});

test("toolCalls are reported in call order, not completion order", async () => {
  const slow: AgentTool<typeof noParams> = {
    name: "slow",
    label: "Slow",
    description: "Slow.",
    parameters: noParams,
    execute: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { content: [{ type: "text", text: "slow" }], details: {} };
    }
  };
  const replay = script(
    replyToolCalls([
      { name: "slow", id: "s" },
      { name: "echo", arguments: { message: "fast" }, id: "f" }
    ]),
    replyText("done")
  );
  const events: string[] = [];
  const output = await adapterFor(replay).runToolAgent(
    baseInput({
      tools: [slow, echo],
      onEvent: (e) => {
        if (e.type === "tool_execution_end") events.push(e.toolName);
      }
    })
  );
  assert.deepEqual(events, ["echo", "slow"], "completion order differs from call order");
  assert.deepEqual(output?.toolCalls.map((c) => c.name), ["slow", "echo"]);
});

// ---------------------------------------------------------------------------
// Model selection and reasoning
// ---------------------------------------------------------------------------

test("model selector: the function form receives input.model and can route on it", async () => {
  const fast = script(replyText("from fast"));
  const smart = script(replyText("from smart"));
  const llm = createRuntimeToolLlmAdapter({ model: (input) => (input.model === "smart" ? smart.model : fast.model) });

  assert.equal((await llm.runToolAgent(baseInput({ model: "smart" })))?.text, "from smart");
  assert.equal((await llm.runToolAgent(baseInput()))?.text, "from fast");
});

test("reasoning: per-call value wins over the adapter default; 'off' disables it", async () => {
  const replay = script(replyText("a"), replyText("b"), replyText("c"));
  const llm = adapterFor(replay, { reasoning: "low" });
  await llm.runToolAgent(baseInput());
  await llm.runToolAgent(baseInput({ reasoning: "high" }));
  await llm.runToolAgent(baseInput({ reasoning: "off" }));
  assert.deepEqual(replay.callOptions.map((o) => o.reasoning), ["low", "high", undefined]);
});

test("runToolAgentLoop forwards model and reasoning only when set", async () => {
  const { adapter, inputs } = recordingAdapter([{ text: "x", toolCalls: [] }, { text: "y", toolCalls: [] }]);
  await runToolAgentLoop({ llm: adapter, systemPrompt: "s", prompt: "p", sessionId: "a", tools: [], model: "smart", reasoning: "medium" });
  await runToolAgentLoop({ llm: adapter, systemPrompt: "s", prompt: "p", sessionId: "b", tools: [] });
  assert.equal(inputs[0]!.model, "smart");
  assert.equal(inputs[0]!.reasoning, "medium");
  assert.equal("model" in inputs[1]!, false);
  assert.equal("reasoning" in inputs[1]!, false);
});

// ---------------------------------------------------------------------------
// Built-in turn cap
// ---------------------------------------------------------------------------

const loopForever = (calls: number): ReplayStep[] =>
  Array.from({ length: calls }, (_, i) => replyToolCalls([{ name: "echo", arguments: { message: `${i}` }, id: `c${i}` }]));

test("built-in cap: runs stop after DEFAULT_ADAPTER_MAX_TURNS model calls", async () => {
  assert.equal(DEFAULT_ADAPTER_MAX_TURNS, 50);
  const replay = script(...loopForever(DEFAULT_ADAPTER_MAX_TURNS + 1));
  const output = await adapterFor(replay).runToolAgent(baseInput());
  assert.equal(output?.endReason, "max_turns");
  assert.equal(output?.turns, DEFAULT_ADAPTER_MAX_TURNS);
  assert.equal(replay.remaining, 1);
});

test("built-in cap: defaults.maxTurns replaces it; { maxTurns: undefined } removes it; the call still wins", async () => {
  const custom = script(...loopForever(5));
  assert.equal((await adapterFor(custom, { defaults: { maxTurns: 3 } }).runToolAgent(baseInput()))?.turns, 3);

  const uncapped = script(...loopForever(DEFAULT_ADAPTER_MAX_TURNS + 2), replyText("finally"));
  const free = await adapterFor(uncapped, { defaults: { maxTurns: undefined } }).runToolAgent(baseInput());
  assert.equal(free?.endReason, "completed");
  assert.equal(free?.turns, DEFAULT_ADAPTER_MAX_TURNS + 3);

  const perCall = script(...loopForever(4));
  assert.equal((await adapterFor(perCall).runToolAgent(baseInput({ maxTurns: 2 })))?.turns, 2);
});

// ---------------------------------------------------------------------------
// Run state: messages, resumeFrom, state
// ---------------------------------------------------------------------------

test("run state: output carries state; resumeFrom continues; empty prompt means no new turn", async () => {
  const replay = script(
    replyToolCalls([{ name: "echo", arguments: { message: "hi" }, id: "a" }], { usage: { totalTokens: 10 } }),
    replyText("first", { usage: { totalTokens: 10 } }),
    replyText("second", { usage: { totalTokens: 10 } })
  );
  const adapter = adapterFor(replay);
  const first = (await adapter.runToolAgent(baseInput())) as ToolAgentOutput;
  assert.equal(first.state?.turns, 2);
  assert.equal(first.state?.toolCallsExecuted, 1);

  const second = (await adapter.runToolAgent(
    baseInput({ prompt: "and now?", resumeFrom: first.state!, maxTurns: 3 })
  )) as ToolAgentOutput;
  assert.equal(second.text, "second");
  assert.equal(second.turns, 1, "this call's model calls");
  assert.equal(second.state?.turns, 3, "the whole run's model calls");
  assert.equal(second.usage?.totalTokens, 30, "usage carries over");
  assert.deepEqual(
    replay.calls[2]!.messages.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant", "user"]
  );

  const finished = (await adapter.runToolAgent(baseInput({ prompt: "", resumeFrom: second.state! }))) as ToolAgentOutput;
  assert.equal(finished.endReason, "completed", "nothing new to answer: no model call");
  assert.equal(finished.turns, 0);
  assert.equal(replay.calls.length, 3);
});

test("run state: messages are forwarded; a resumed pending batch is not counted as a model call", async () => {
  const replay = script(replyText("continued"));
  const history = [
    { role: "user" as const, content: "echo it", timestamp: 0 },
    replyToolCalls([{ name: "echo", arguments: { message: "x" }, id: "p" }])
  ];
  const output = (await adapterFor(replay).runToolAgent(baseInput({ prompt: "", messages: history }))) as ToolAgentOutput;
  assert.equal(output.text, "continued");
  assert.deepEqual(output.toolCalls, [{ name: "echo", args: { message: "x" }, isError: false }]);
  assert.equal(output.turns, 1);
  assert.deepEqual(replay.calls[0]!.messages.map((m) => m.role), ["user", "assistant", "toolResult"]);
});
