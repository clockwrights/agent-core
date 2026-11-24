// ---------------------------------------------------------------------------
// Tests: stopWhen conditions and the prepareStep hook.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Type, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
  hasToolCall,
  runToolAgent,
  stepCountIs,
  type AgentStep,
  type AgentTool,
  type AgentToolResult,
  type StopConditionState,
  type ToolAgentRunInput,
} from "../src/index.js";
import {
  collectEvents,
  createReplayModel,
  recordTool,
  replyText,
  replyToolCalls,
  type ReplayModel,
  type ReplayStep,
} from "../src/testing.js";

const models: ReplayModel[] = [];
afterEach(() => {
  while (models.length) models.pop()!.dispose();
});

function script(...steps: ReplayStep[]): ReplayModel {
  const replay = createReplayModel(steps);
  models.push(replay);
  return replay;
}

const noParams = Type.Object({});
const result = (text: string, extra: Partial<AgentToolResult<any>> = {}): AgentToolResult<any> => ({
  content: [{ type: "text", text }],
  details: {},
  ...extra,
});
const tool = (name: string, extra: Partial<Pick<AgentTool, "executionMode">> = {}): AgentTool<typeof noParams> => ({
  name,
  label: name,
  description: name,
  parameters: noParams,
  execute: async () => result(name),
  ...extra,
});

const search = tool("search");
const finish = tool("finish");
const call = (name: string, id = `${name}-1`) => replyToolCalls([{ name, id }]);

async function run(replay: ReplayModel, tools: AgentTool<any>[], extra: Partial<ToolAgentRunInput> = {}) {
  const events = collectEvents();
  await runToolAgent({ systemPrompt: "base prompt", model: replay.model, tools, prompt: "go", ...extra }, events.emit);
  return { events, end: events.ofType("agent_end")[0]! };
}

// ---------------------------------------------------------------------------
// stopWhen
// ---------------------------------------------------------------------------

test("stopWhen hasToolCall: stops after the turn that called the tool; the tool still ran", async () => {
  const spy = recordTool(finish);
  const replay = script(call("search"), call("finish"), replyText("never"));
  const { end } = await run(replay, [search, spy.tool], { stopWhen: hasToolCall("finish") });

  assert.equal(end.reason, "stop_condition");
  assert.equal(replay.calls.length, 2);
  assert.equal(spy.calls.length, 1);
});

test("stopWhen hasToolCall(): any tool call matches", async () => {
  const { end } = await run(script(call("search"), replyText("never")), [search], { stopWhen: hasToolCall() });
  assert.equal(end.reason, "stop_condition");
});

test("stopWhen stepCountIs: stops after N completed turns", async () => {
  const replay = script(call("search", "a"), call("search", "b"), call("search", "c"));
  const { end } = await run(replay, [search], { stopWhen: stepCountIs(2) });
  assert.equal(end.reason, "stop_condition");
  assert.equal(replay.calls.length, 2);
  assert.throws(() => stepCountIs(0), RangeError);
});

test("stopWhen: several conditions (any wins), async conditions, state carries steps and usage", async () => {
  const seen: StopConditionState[] = [];
  const replay = script(
    replyToolCalls([{ name: "search" }], { usage: { input: 5, output: 1, totalTokens: 6 } }),
    replyToolCalls([{ name: "search", id: "s2" }], { usage: { input: 7, output: 1, totalTokens: 8 } }),
    replyText("never"),
  );
  const { end } = await run(replay, [search], {
    stopWhen: [
      async (state) => {
        seen.push(state);
        return false;
      },
      ({ totalUsage }) => totalUsage.totalTokens >= 14,
    ],
  });

  assert.equal(end.reason, "stop_condition");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.steps.map((step: AgentStep) => step.turn)), [[1], [1, 2]]);
  assert.equal(seen[1]!.steps[1]!.usage.totalTokens, 8);
  assert.equal((seen[1]!.steps[1]!.toolResults[0] as ToolResultMessage).toolName, "search");
});

test("stopWhen: not evaluated when the run ends anyway; terminate wins", async () => {
  let evaluated = 0;
  const stopper: AgentTool<typeof noParams> = { ...search, execute: async () => result("x", { terminate: true }) };
  const { end } = await run(script(call("search")), [stopper], {
    stopWhen: () => (evaluated++, true),
  });
  assert.equal(end.reason, "terminated");
  assert.equal(evaluated, 0);

  const done = await run(script(replyText("answer")), [search], { stopWhen: () => (evaluated++, true) });
  assert.equal(done.end.reason, "completed");
  assert.equal(evaluated, 0);
});

test("stopWhen: a throwing condition ends the run with reason error", async () => {
  const { end, events } = await run(script(call("search"), replyText("never")), [search], {
    stopWhen: () => {
      throw new Error("bad predicate");
    },
  });
  assert.equal(end.reason, "error");
  assert.equal(end.errorMessage, "stopWhen failed: bad predicate");
  assert.equal(events.types().at(-1), "agent_end");
});

// ---------------------------------------------------------------------------
// prepareStep
// ---------------------------------------------------------------------------

test("prepareStep: receives turn number, completed steps and the conversation", async () => {
  const contexts: Array<{ turn: number; steps: number; messages: number }> = [];
  await run(script(call("search"), replyText("done")), [search], {
    prepareStep: ({ turn, steps, messages }) => {
      contexts.push({ turn, steps: steps.length, messages: messages.length });
    },
  });
  assert.deepEqual(contexts, [
    { turn: 1, steps: 0, messages: 1 },
    { turn: 2, steps: 1, messages: 3 },
  ]);
});

test("prepareStep: model, system prompt and reasoning can be swapped per step", async () => {
  const first = script(call("search"));
  const second = script(replyText("from second model"));
  const { end } = await run(first, [search], {
    reasoning: "low",
    prepareStep: ({ turn }) => (turn === 2 ? { model: second.model, systemPrompt: "step-2 prompt", reasoning: "high" } : undefined),
  });

  assert.equal(end.reason, "completed");
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls[0]!.systemPrompt, "base prompt");
  assert.equal(second.calls[0]!.systemPrompt, "step-2 prompt");
  assert.equal(first.callOptions[0]!.reasoning, "low");
  assert.equal(second.callOptions[0]!.reasoning, "high");
});

test("prepareStep activeTools: narrows the offered tools and the executable set", async () => {
  const searchSpy = recordTool(search);
  const replay = script(
    replyToolCalls([{ name: "search", id: "s" }, { name: "finish", id: "f" }]),
    replyText("done"),
  );
  const { end } = await run(replay, [searchSpy.tool, finish], {
    prepareStep: ({ turn }) => (turn === 1 ? { activeTools: ["finish", "unknown-tool"] } : undefined),
  });

  assert.deepEqual(replay.calls[0]!.tools!.map((t) => t.name), ["finish"]);
  assert.deepEqual(replay.calls[1]!.tools!.map((t) => t.name), ["search", "finish"], "override is per step");
  const [searchResult, finishResult] = end.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
  assert.equal(searchResult!.isError, true, "a tool outside the active set is not executed");
  assert.match((searchResult!.content[0] as { text: string }).text, /Tool "search" not found/);
  assert.equal(finishResult!.isError, false);
  assert.equal(searchSpy.calls.length, 0);
});

test("prepareStep messages: the model sees the override; the transcript is unchanged", async () => {
  const replay = script(call("search"), replyText("done"));
  const { end } = await run(replay, [search], {
    prepareStep: ({ turn, messages }) =>
      turn === 2
        ? { messages: [messages[0]!, ...messages.slice(1).filter((m: Message) => m.role !== "toolResult")] }
        : undefined,
  });

  assert.deepEqual(replay.calls[1]!.messages.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(end.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
});

test("prepareStep: a throwing hook ends the run with reason error before any model call", async () => {
  const replay = script(replyText("never"));
  const { end, events } = await run(replay, [search], {
    prepareStep: async () => {
      throw new Error("no budget left");
    },
  });
  assert.equal(end.reason, "error");
  assert.equal(end.errorMessage, "prepareStep failed: no budget left");
  assert.equal(replay.calls.length, 0);
  assert.equal(events.types().at(-1), "agent_end");
});
