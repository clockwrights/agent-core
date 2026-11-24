// ---------------------------------------------------------------------------
// Tests: compaction during a run (`compaction` option), the token estimate,
// cut points, failures, overflow recovery, saved state and compactMessages.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, type Message, type Model } from "@earendil-works/pi-ai";
import {
  buildCompactionTranscript,
  compactMessages,
  DEFAULT_COMPACTION_INSTRUCTIONS,
  estimateContextTokens,
  parseRunState,
  runAgent,
  serializeRunState,
  RunStateError,
  type AgentEvent,
  type AgentTool,
  type CompactionOptions,
  type RunState,
  type SummarizeInput,
} from "../src/index.js";
import { collectEvents, createReplayModel, replyError, replyText, replyToolCalls } from "../src/testing.js";

const params = Type.Object({});

/** A tool returning `chars` characters of text. */
function bigTool(name: string, chars: number, calls?: string[]): AgentTool<typeof params> {
  return {
    name,
    label: name,
    description: name,
    parameters: params,
    execute: async (id) => {
      calls?.push(id);
      return { content: [{ type: "text", text: `${name}:` + "x".repeat(chars) }], details: {} };
    },
  };
}

const usage600 = { usage: { input: 600, output: 10 } };

/** Tool turns a, b, c …, then a final text reply. */
function toolTurns(ids: string[], final = "done") {
  return [...ids.map((id) => replyToolCalls([{ name: "read", id }], usage600)), replyText(final)];
}

/** A summariser that records what it was given. */
function scriptedSummarizer(texts: string[] = ["SUMMARY"]) {
  const inputs: SummarizeInput[] = [];
  const summarize = async (input: SummarizeInput) => {
    inputs.push(input);
    return { text: texts[Math.min(inputs.length - 1, texts.length - 1)]!, usage: usage(7, 3) };
  };
  return { inputs, summarize };
}

function usage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function textOf(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("|");
}

function roles(messages: readonly Message[]): string {
  return messages.map((m) => m.role[0]).join("");
}

async function run(steps: Parameters<typeof createReplayModel>[0], compaction: CompactionOptions, extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const replay = createReplayModel(steps);
  const events = collectEvents();
  const result = await runAgent(
    { systemPrompt: "sys", model: replay.model, tools: [bigTool("read", 400)], prompt: "the task", compaction, ...extra },
    events.emit,
  );
  replay.dispose();
  return { result, events, replay };
}

// ---------------------------------------------------------------------------
// In-run compaction
// ---------------------------------------------------------------------------

test("threshold compaction keeps the task and the latest turn, replaces the middle with a framed summary", async () => {
  const { inputs, summarize } = scriptedSummarizer();
  const { result, events, replay } = await run(toolTurns(["a", "b"]), { triggerTokens: 500, keepRecentTokens: 0, summarize });

  assert.equal(result.reason, "completed");
  assert.equal(result.text, "done");
  const [boundary] = events.ofType("compact_boundary");
  assert.ok(boundary, "compacted once");
  assert.equal(events.ofType("compact_boundary").length, 1);
  assert.equal(boundary.trigger, "threshold");
  assert.equal(boundary.turn, 3, "before the third model call");
  assert.equal(boundary.summaryIndex, 0);
  assert.equal(boundary.removedMessages, 3, "task message (gets the summary), a1, its result");
  assert.ok(boundary.tokensBefore >= 500);
  assert.ok(boundary.tokensAfter < boundary.tokensBefore);

  // The summariser saw the replaced turn only (not the task, not the kept turn).
  assert.equal(inputs.length, 1);
  assert.deepEqual(roles(inputs[0]!.messages), "at");
  assert.match(inputs[0]!.transcript, /Tool result of read \(tool output\)/);
  assert.equal(inputs[0]!.previousSummary, undefined);

  // Transcript: [task + summary part] [a2] [result b] [final].
  const messages = result.state.messages;
  assert.equal(roles(messages), "uata");
  const task = messages[0]!;
  assert.ok(Array.isArray(task.content));
  assert.equal((task.content[0] as { text: string }).text, "the task", "task kept verbatim");
  const summaryPart = (task.content[1] as { text: string }).text;
  assert.match(summaryPart, /^<conversation-summary>\n/);
  assert.match(summaryPart, /not a new request from the user/);
  assert.match(summaryPart, /SUMMARY\n<\/conversation-summary>$/);
  assert.deepEqual(boundary.summary, task);

  // The third model call saw the compacted transcript.
  assert.equal(roles(replay.calls[2]!.messages), "uat");

  // Accounting: summariser usage counts, but it is not a turn.
  assert.equal(result.state.turns, 3);
  assert.equal(result.usage.input, 600 * 2 + 7);
  assert.equal(result.usage.output, 10 * 2 + 3);
  assert.deepEqual(boundary.usage, usage(7, 3));

  // Record in the state.
  assert.deepEqual(result.state.compactions, [
    {
      turn: 3,
      trigger: "threshold",
      tokensBefore: boundary.tokensBefore,
      tokensAfter: boundary.tokensAfter,
      removedMessages: 3,
      summaryIndex: 0,
      messageCount: 3,
    },
  ]);
});

test("events: compact_boundary comes before the next model call, and rebuilds the transcript", async () => {
  const { summarize } = scriptedSummarizer();
  const { result, events } = await run(toolTurns(["a", "b"]), { triggerTokens: 500, keepRecentTokens: 0, summarize });
  const types = events.types().filter((t) => t !== "message_update");
  const at = types.indexOf("compact_boundary");
  assert.deepEqual(types.slice(at - 1, at + 2), ["turn_start", "compact_boundary", "message_start"]);

  // Rebuild the transcript from message events plus the boundary.
  const rebuilt: Message[] = [];
  for (const event of events.events as AgentEvent[]) {
    if (event.type === "message_end") rebuilt.push(event.message);
    if (event.type === "compact_boundary") rebuilt.splice(event.summaryIndex, event.removedMessages, event.summary);
  }
  assert.deepEqual(rebuilt, result.state.messages);
});

test("without compaction nothing changes, and nothing to summarise means no summariser call", async () => {
  const { inputs, summarize } = scriptedSummarizer();
  // One tool turn only: the latest turn is always kept, so there is no middle.
  const { result, events } = await run(toolTurns(["a"]), { triggerTokens: 1, keepRecentTokens: 0, summarize });
  assert.equal(result.reason, "completed");
  assert.equal(inputs.length, 0);
  assert.equal(events.ofType("compact_boundary").length, 0);
  assert.equal(result.state.compactions, undefined);

  const plain = await run(toolTurns(["a", "b"]), undefined as unknown as CompactionOptions);
  assert.equal(plain.events.ofType("compact_boundary").length, 0);
  assert.equal(roles(plain.result.state.messages), "uatata");
});

test("tool calls are never split from their results; keepRecentTokens keeps whole turns", async () => {
  const { inputs, summarize } = scriptedSummarizer();
  // Each tool turn is about 105 tokens (400 chars + call); keep two turns.
  const { result } = await run(toolTurns(["a", "b", "c", "d"]), { triggerTokens: 600, keepRecentTokens: 250, summarize });
  for (const input of inputs) {
    const ids = new Set(input.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => (c as { id: string }).id) : [])));
    const resultIds = new Set(input.messages.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId));
    assert.deepEqual([...ids].sort(), [...resultIds].sort(), "every summarised call has its result with it");
  }
  // Kept messages after the task always start with an assistant message (roles alternate).
  const messages = result.state.messages;
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[1]!.role, "assistant");
  for (let i = 1; i < messages.length; i++) {
    assert.ok(!(messages[i]!.role === "user" && messages[i - 1]!.role === "user"), "no two user messages in a row");
  }
});

test("a later compaction folds the earlier summary: one summary remains", async () => {
  const { inputs, summarize } = scriptedSummarizer(["FIRST", "SECOND"]);
  const { result, events } = await run(toolTurns(["a", "b", "c", "d"]), { triggerTokens: 500, keepRecentTokens: 0, summarize });
  // Before calls 3, 4 and 5 (each new reply reports 600 tokens again).
  assert.equal(events.ofType("compact_boundary").length, 3);
  assert.equal(inputs[1]!.previousSummary, "FIRST");
  const all = result.state.messages.map(textOf).join("\n");
  assert.equal(all.match(/<conversation-summary>/g)?.length, 1);
  assert.match(all, /SECOND/);
  assert.doesNotMatch(all, /FIRST/);
  assert.equal(result.state.compactions!.length, events.ofType("compact_boundary").length);
});

test("keepInitialMessages: false makes the summary a standalone first message", async () => {
  const { inputs, summarize } = scriptedSummarizer(["ONE", "TWO"]);
  const { result } = await run(toolTurns(["a", "b", "c"]), {
    triggerTokens: 500,
    keepRecentTokens: 0,
    keepInitialMessages: false,
    summarize,
  });
  const messages = result.state.messages;
  assert.equal(messages[0]!.role, "user");
  assert.match(textOf(messages[0]!), /^<conversation-summary>/);
  assert.doesNotMatch(textOf(messages[0]!), /the task/, "the task itself was summarised");
  assert.equal(messages[1]!.role, "assistant");
  assert.equal(roles(inputs[0]!.messages)[0], "u", "the summariser saw the task");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]!.previousSummary, "ONE", "standalone summary folded, not re-summarised as text");
  assert.equal(roles(inputs[1]!.messages)[0], "a", "the earlier summary is not in the summarised messages");
  assert.match(textOf(messages[0]!), /TWO/);
});

test("the built-in summariser calls the run's model with the recall-first instructions", async () => {
  const steps = [...toolTurns(["a", "b"]).slice(0, 2), replyText("BUILT-IN SUMMARY", { usage: { input: 50, output: 20 } }), replyText("done")];
  const { result, replay } = await run(steps, { triggerTokens: 500, keepRecentTokens: 0, maxSummaryTokens: 300 });
  const summaryCall = replay.calls[2]!;
  assert.equal(summaryCall.systemPrompt, DEFAULT_COMPACTION_INSTRUCTIONS);
  assert.equal(summaryCall.tools, undefined);
  assert.match(textOf(summaryCall.messages[0]!), /Transcript to summarise:/);
  assert.equal(replay.callOptions[2]!.maxTokens, 300);
  assert.equal(replay.callOptions[2]!.reasoning, undefined);
  assert.match(textOf(result.state.messages[0]!), /BUILT-IN SUMMARY/);
  assert.equal(result.usage.input, 600 * 2 + 50);
});

// ---------------------------------------------------------------------------
// Failures, abort, budget
// ---------------------------------------------------------------------------

test("a failing or empty summariser fails open, and stops being tried after 2 failures in a row", async () => {
  let calls = 0;
  const summarize = async () => {
    calls += 1;
    if (calls === 1) throw new Error("summariser down");
    return { text: "   " };
  };
  const { result, events } = await run(toolTurns(["a", "b", "c", "d"]), { triggerTokens: 500, keepRecentTokens: 0, summarize });
  assert.equal(result.reason, "completed", "the run goes on");
  const failures = events.ofType("compaction_failed");
  assert.deepEqual(failures.map((f) => f.error), ["summariser down", "summarizer returned no text"]);
  assert.equal(calls, 2, "not tried again after 2 failures");
  assert.equal(events.ofType("compact_boundary").length, 0);
  assert.equal(roles(result.state.messages), "uatatatata", "transcript untouched");
});

test("an abort during compaction ends the run aborted with the transcript unchanged", async () => {
  const controller = new AbortController();
  const summarize = async () => {
    controller.abort();
    throw new Error("aborted");
  };
  const { result, events } = await run(toolTurns(["a", "b"]), { triggerTokens: 500, keepRecentTokens: 0, summarize }, { signal: controller.signal });
  assert.equal(result.reason, "aborted");
  assert.equal(result.errorMessage, "Aborted during compaction");
  assert.equal(events.ofType("compaction_failed").length, 0);
  assert.equal(roles(result.state.messages), "uatat");
  assert.equal(result.state.turns, 2);
});

test("the summariser's tokens count toward the budget", async () => {
  const summarize = async () => ({ text: "S", usage: usage(5000, 0) });
  const { result, replay } = await run(toolTurns(["a", "b"]), { triggerTokens: 500, keepRecentTokens: 0, summarize }, {
    budget: { maxTotalTokens: 4000 },
  });
  assert.equal(result.reason, "budget");
  assert.equal(replay.calls.length, 2, "no model call after the compaction pushed usage over the budget");
  assert.equal(result.state.compactions?.length, 1);
});

// ---------------------------------------------------------------------------
// Overflow recovery
// ---------------------------------------------------------------------------

const overflow = () => replyError("prompt is too long: 140000 tokens > 128000 maximum");

test("a context-overflow error compacts and retries the call once", async () => {
  const { summarize } = scriptedSummarizer();
  const steps = [...toolTurns(["a", "b"]).slice(0, 2), overflow(), replyText("done")];
  const { result, events, replay } = await run(steps, { triggerTokens: 1_000_000, keepRecentTokens: 0, summarize });
  assert.equal(result.reason, "completed");
  const [boundary] = events.ofType("compact_boundary");
  assert.equal(boundary!.trigger, "overflow");
  assert.equal(result.state.turns, 3, "the failed call is not a turn");
  assert.equal(replay.calls.length, 4);
  assert.ok(!result.state.messages.some((m) => m.role === "assistant" && m.stopReason === "error"), "failed reply not kept");
});

test("a second overflow ends the run with error; onOverflow: \"fail\" does not compact", async () => {
  const { summarize } = scriptedSummarizer();
  const twice = await run([...toolTurns(["a", "b"]).slice(0, 2), overflow(), overflow()], {
    triggerTokens: 1_000_000,
    keepRecentTokens: 0,
    summarize,
  });
  assert.equal(twice.result.reason, "error");
  assert.equal(twice.events.ofType("compact_boundary").length, 1);

  const fail = await run([...toolTurns(["a", "b"]).slice(0, 2), overflow()], {
    triggerTokens: 1_000_000,
    keepRecentTokens: 0,
    onOverflow: "fail",
    summarize,
  });
  assert.equal(fail.result.reason, "error");
  assert.equal(fail.events.ofType("compact_boundary").length, 0);
});

test("errors that are not overflow are not retried", async () => {
  const { inputs, summarize } = scriptedSummarizer();
  const { result } = await run([...toolTurns(["a", "b"]).slice(0, 2), replyError("rate limited")], {
    triggerTokens: 1_000_000,
    keepRecentTokens: 0,
    summarize,
  });
  assert.equal(result.reason, "error");
  assert.equal(inputs.length, 0);
});

// ---------------------------------------------------------------------------
// Saved state and resume
// ---------------------------------------------------------------------------

test("compactions survive serialization; a resumed run does not compact again on stale usage", async () => {
  const { summarize, inputs } = scriptedSummarizer();
  const first = await run(toolTurns(["a", "b"]), { triggerTokens: 500, keepRecentTokens: 0, summarize });
  const saved = parseRunState(serializeRunState(first.result.state));
  assert.deepEqual(saved.compactions, first.result.state.compactions);

  // Resume with a new prompt: the kept reply's usage (600) predates the
  // compaction, so the estimate falls back to characters and stays under.
  const replay = createReplayModel([replyText("again")]);
  const resumed = await runAgent({
    systemPrompt: "sys",
    model: replay.model,
    tools: [bigTool("read", 400)],
    resumeFrom: saved,
    prompt: "more",
    compaction: { triggerTokens: 500, keepRecentTokens: 0, summarize },
  });
  replay.dispose();
  assert.equal(resumed.reason, "completed");
  assert.equal(inputs.length, 1, "no second summary");
  assert.deepEqual(resumed.state.compactions, saved.compactions);
});

test("parseRunState rejects malformed compactions", () => {
  const base: RunState = {
    version: 1,
    messages: [],
    turns: 0,
    toolCallsExecuted: 0,
    usage: usage(0, 0),
  };
  assert.throws(() => parseRunState({ ...base, compactions: "no" as never }), RunStateError);
  assert.throws(() => parseRunState({ ...base, compactions: [{ trigger: "sometimes" }] as never }), /compactions\[0\]/);
  assert.throws(
    () =>
      parseRunState({
        ...base,
        compactions: [{ turn: 1, trigger: "threshold", tokensBefore: 1, tokensAfter: 1, removedMessages: -1, summaryIndex: 0, messageCount: 1 }],
      }),
    /compactions\[0\]/,
  );
});

test("pending tool calls of a resumed run execute before any compaction", async () => {
  const calls: string[] = [];
  const replay = createReplayModel(toolTurns(["a", "b"]).slice(0, 2));
  const paused = await runAgent({
    systemPrompt: "sys",
    model: replay.model,
    tools: [bigTool("read", 400, calls)],
    prompt: "the task",
    beforeToolCall: () => ({ action: "ask" }),
  });
  replay.dispose();
  assert.equal(paused.reason, "interrupted");

  const { summarize } = scriptedSummarizer();
  const replay2 = createReplayModel([replyText("done")]);
  const events = collectEvents();
  const resumed = await runAgent(
    {
      systemPrompt: "sys",
      model: replay2.model,
      tools: [bigTool("read", 400, calls)],
      resumeFrom: paused.state,
      approvals: { a: { approve: true } },
      compaction: { triggerTokens: 1, keepRecentTokens: 0, summarize },
    },
    events.emit,
  );
  replay2.dispose();
  assert.equal(resumed.reason, "completed");
  assert.deepEqual(calls, ["a"]);
  // Only one tool turn exists, so there is nothing to summarise yet.
  assert.equal(events.ofType("compact_boundary").length, 0);
  const types = events.types();
  assert.ok(types.indexOf("tool_execution_end") < types.indexOf("message_start"), "pending call ran first");
});

// ---------------------------------------------------------------------------
// Estimate, validation, helpers
// ---------------------------------------------------------------------------

test("estimateContextTokens: reported usage plus 4 characters per token for later messages", () => {
  const assistant = { ...replyToolCalls([{ name: "read", id: "a" }], { usage: { input: 900, cacheRead: 100, output: 20 } }) };
  const result: Message = { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], isError: false, timestamp: 0 };
  const messages: Message[] = [{ role: "user", content: "y".repeat(8000), timestamp: 0 }, assistant, result];
  assert.equal(estimateContextTokens({ messages }), 900 + 100 + 20 + 100);
  // usageFrom past the reply: characters only (task 2000 + call + result 100).
  const charsOnly = estimateContextTokens({ messages, usageFrom: 2, systemPrompt: "z".repeat(40) });
  assert.ok(charsOnly >= 2000 + 100 + 10 && charsOnly < 2200, String(charsOnly));
  // Images count 1,600 tokens each.
  const withImage: Message[] = [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 }];
  assert.equal(estimateContextTokens({ messages: withImage }), 1600);
});

test("the trigger defaults to 85% of the window and never leaves less than maxTokens for the reply", async () => {
  // 85% of 1,000 = 850: an 800-token prompt does not compact, 900 does.
  const at = async (window: number, promptTokens: number, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => {
    const { summarize, inputs } = scriptedSummarizer();
    const replay = createReplayModel([
      replyToolCalls([{ name: "read", id: "a" }], { usage: { input: promptTokens } }),
      replyToolCalls([{ name: "read", id: "b" }], { usage: { input: promptTokens } }),
      replyText("done"),
    ]);
    await runAgent({
      systemPrompt: "s",
      model: { ...replay.model, contextWindow: window },
      tools: [bigTool("read", 0)],
      prompt: "go",
      compaction: { keepRecentTokens: 0, summarize },
      ...extra,
    });
    replay.dispose();
    return inputs.length;
  };
  assert.equal(await at(1000, 800), 0);
  assert.equal(await at(1000, 900), 1);
  // maxTokens 400 caps the trigger at 1000 - 400 = 600.
  assert.equal(await at(1000, 700, { maxTokens: 400 }), 1);
  // triggerRatio is configurable.
  const counted = scriptedSummarizer();
  await at(1000, 700, { compaction: { triggerRatio: 0.6, keepRecentTokens: 0, summarize: counted.summarize } });
  assert.equal(counted.inputs.length, 1, "triggerRatio 0.6 → 600 tokens: compacts at 700");
});

test("invalid compaction options are a RangeError before the run starts", async () => {
  const replay = createReplayModel([]);
  const base = { systemPrompt: "s", tools: [], prompt: "go" };
  const bad = async (compaction: CompactionOptions, model: Model<any> = replay.model) =>
    assert.rejects(runAgent({ ...base, model, compaction }), RangeError);
  await bad({ triggerRatio: 1 });
  await bad({ triggerRatio: 0 });
  await bad({ triggerTokens: 0 });
  await bad({ keepRecentTokens: -1 });
  await bad({ maxSummaryTokens: 1.5 });
  await bad({ onOverflow: "retry" as never });
  await bad({}, { ...replay.model, contextWindow: 0 });
  // A window from the options, or triggerTokens, makes a model without one usable.
  await assert.doesNotReject(
    runAgent({ ...base, model: { ...replay.model, contextWindow: 0 }, compaction: { triggerTokens: 100 } }).then(() => undefined),
  );
  replay.dispose();
});

test("buildCompactionTranscript marks tool output, replaces images and clips long items", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AA", mimeType: "image/png" }], timestamp: 0 },
    replyToolCalls([{ name: "fetch", id: "f", arguments: { url: "https://example.test" } }]),
    { role: "toolResult", toolCallId: "f", toolName: "fetch", content: [{ type: "text", text: "a".repeat(10_000) }], isError: true, timestamp: 0 },
  ];
  const transcript = buildCompactionTranscript(messages);
  assert.match(transcript, /^User: look\n\[image\]/);
  assert.match(transcript, /Assistant called fetch\(\{"url":"https:\/\/example.test"\}\)/);
  assert.match(transcript, /Tool result of fetch \(error\) \(tool output\): a+ \[…6000 characters omitted…\] a+$/);
  const capped = buildCompactionTranscript(messages, 100);
  assert.match(capped, /^\[… earlier part of the transcript omitted …\]/);
});

test("compactMessages compacts a saved conversation the same way", async () => {
  const { summarize } = scriptedSummarizer(["SAME"]);
  const full = await run(toolTurns(["a", "b"]), undefined as unknown as CompactionOptions);
  const messages = full.result.state.messages;

  const manual = await compactMessages(messages, { model: full.replay.model, keepRecentTokens: 0, summarize });
  assert.ok(manual);
  assert.equal(manual.record.trigger, "manual");
  // The latest turn of a finished conversation is the final reply: task + summary, then "done".
  assert.equal(roles(manual.messages), "ua");
  assert.equal(textOf(manual.messages[1]!), "done");
  assert.match(textOf(manual.messages[0]!), /SAME/);
  assert.equal(manual.record.removedMessages, 5);
  assert.equal(await compactMessages(messages.slice(0, 3), { model: full.replay.model, summarize }), undefined, "nothing to summarise");
});
