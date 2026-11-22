// ---------------------------------------------------------------------------
// Tests: beforeToolCall / afterToolCall hooks and approval pause/resume.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, type Message } from "@earendil-works/pi-ai";
import {
  hashArguments,
  parseRunState,
  runAgent,
  serializeRunState,
  type AgentTool,
  type BeforeToolCallContext,
  type ToolCallDecision,
} from "../src/index.js";
import { collectEvents, createReplayModel, recordTool, replyText, replyToolCalls } from "../src/testing.js";

const params = Type.Object({ to: Type.Optional(Type.String()), n: Type.Optional(Type.Number()) });
function tool(name: string, extra: Partial<AgentTool<typeof params>> = {}): AgentTool<typeof params> {
  return {
    name,
    label: name,
    description: name,
    parameters: params,
    execute: async (id) => ({ content: [{ type: "text", text: `${name} ran (${id})` }], details: { secret: "s3cr3t" } }),
    ...extra,
  };
}

type ToolResult = Extract<Message, { role: "toolResult" }>;
const results = (messages: Message[]) => messages.filter((m): m is ToolResult => m.role === "toolResult");
const text = (r: ToolResult) => (r.content[0] as { text: string }).text;
const decide =
  (byName: Record<string, ToolCallDecision | undefined>) =>
  ({ toolCall }: BeforeToolCallContext) =>
    byName[toolCall.name];

// ---------------------------------------------------------------------------
// beforeToolCall: allow / deny
// ---------------------------------------------------------------------------

test("no hooks: behaviour unchanged (hooks are optional)", async () => {
  const read = recordTool(tool("read"));
  const result = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyToolCalls([{ name: "read", id: "1" }]), replyText("ok")]).model,
    tools: [read.tool],
    prompt: "go",
  });
  assert.equal(read.calls.length, 1);
  assert.equal(result.reason, "completed");
});

test("beforeToolCall: allow, undefined and deny (default and custom message); denied calls are not counted", async () => {
  const read = recordTool(tool("read"));
  const send = recordTool(tool("send"));
  const drop = recordTool(tool("drop"));
  const seen: BeforeToolCallContext[] = [];
  const result = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([
      replyToolCalls([
        { name: "read", id: "r", arguments: { n: "7" } },
        { name: "send", id: "s" },
        { name: "drop", id: "d" },
      ]),
      replyText("done"),
    ]).model,
    tools: [read.tool, send.tool, drop.tool],
    prompt: "go",
    beforeToolCall: (context) => {
      seen.push(context);
      if (context.toolCall.name === "read") return { action: "allow" };
      if (context.toolCall.name === "send") return { action: "deny", message: "No sending today." };
      return context.toolCall.name === "drop" ? { action: "deny" } : undefined;
    },
  });
  assert.equal(read.calls.length, 1);
  assert.equal(send.calls.length + drop.calls.length, 0);
  const [r, s, d] = results(result.messages);
  assert.equal(r!.isError, false);
  assert.deepEqual([s!.isError, text(s!)], [true, "No sending today."]);
  assert.deepEqual([d!.isError, text(d!)], [true, "Tool call denied"]);
  assert.equal(result.state.toolCallsExecuted, 1, "only the allowed call counts");
  assert.equal(result.reason, "completed", "a deny does not stop the run");

  assert.deepEqual(seen[0]!.toolCall, { id: "r", name: "read", arguments: { n: 7 } }, "validated, coerced arguments");
  assert.equal(seen[0]!.tool.name, "read");
  assert.equal(seen[0]!.turn, 1);
  assert.deepEqual(seen[0]!.messages.map((m) => m.role), ["user", "assistant"]);
});

test("beforeToolCall is skipped for unknown tools, invalid arguments and limit-blocked calls", async () => {
  const names: string[] = [];
  await runAgent({
    systemPrompt: "s",
    model: createReplayModel([
      replyToolCalls([
        { name: "missing", id: "1" },
        { name: "read", id: "2", arguments: { n: "not a number" } },
        { name: "read", id: "3" },
        { name: "read", id: "4" },
      ]),
    ]).model,
    tools: [tool("read")],
    prompt: "go",
    maxToolCalls: 3,
    beforeToolCall: ({ toolCall }) => {
      names.push(toolCall.id);
      return undefined;
    },
  });
  assert.deepEqual(names, ["3"]);
});

test("denied calls emit tool_execution_start/end with isError", async () => {
  const events = collectEvents();
  await runAgent(
    {
      systemPrompt: "s",
      model: createReplayModel([replyToolCalls([{ name: "send", id: "s" }]), replyText("ok")]).model,
      tools: [tool("send")],
      prompt: "go",
      beforeToolCall: () => ({ action: "deny" }),
    },
    events.emit,
  );
  assert.deepEqual(events.ofType("tool_execution_start").map((e) => e.toolCallId), ["s"]);
  assert.equal(events.ofType("tool_execution_end")[0]!.isError, true);
});

// ---------------------------------------------------------------------------
// ask → interrupted → approvals
// ---------------------------------------------------------------------------

test("ask: nothing in the batch runs; denials recorded; one event per ask; state lists interruptions", async () => {
  const read = recordTool(tool("read"));
  const send = recordTool(tool("send"));
  const pay = recordTool(tool("pay"));
  const events = collectEvents();
  const result = await runAgent(
    {
      systemPrompt: "s",
      model: createReplayModel([
        replyToolCalls([
          { name: "read", id: "r" },
          { name: "send", id: "s", arguments: { to: "bob" } },
          { name: "pay", id: "p", arguments: { n: 5 } },
          { name: "drop", id: "d" },
        ]),
      ]).model,
      tools: [read.tool, send.tool, pay.tool, tool("drop")],
      prompt: "go",
      beforeToolCall: decide({
        send: { action: "ask", reason: "external write", data: { risk: "external" } },
        pay: { action: "ask" },
        drop: { action: "deny" },
      }),
    },
    events.emit,
  );

  assert.equal(result.reason, "interrupted");
  assert.equal(read.calls.length + send.calls.length + pay.calls.length, 0, "nothing ran, not even the allowed call");
  assert.deepEqual(results(result.messages).map((r) => r.toolCallId), ["d"], "only the denial has a result");
  assert.deepEqual(
    events.ofType("tool_approval_requested").map(({ toolCallId, args, reason, data }) => ({ toolCallId, args, reason, data })),
    [
      { toolCallId: "s", args: { to: "bob" }, reason: "external write", data: { risk: "external" } },
      { toolCallId: "p", args: { n: 5 }, reason: undefined, data: undefined },
    ],
  );
  assert.deepEqual(result.state.interruptions, [
    { toolCallId: "s", toolName: "send", arguments: { to: "bob" }, argumentsHash: hashArguments({ to: "bob" }), reason: "external write", data: { risk: "external" } },
    { toolCallId: "p", toolName: "pay", arguments: { n: 5 }, argumentsHash: hashArguments({ n: 5 }) },
  ]);
  assert.equal(result.state.endReason, "interrupted");
  assert.equal(result.state.toolCallsExecuted, 0);
  assert.equal(events.ofType("turn_end").length, 1);
});

test("resume: approve runs without beforeToolCall, reject is an error result, the run continues", async () => {
  const read = recordTool(tool("read"));
  const send = recordTool(tool("send"));
  const pay = recordTool(tool("pay"));
  const tools = [read.tool, send.tool, pay.tool];
  const hookCalls: string[] = [];
  const beforeToolCall = ({ toolCall }: BeforeToolCallContext): ToolCallDecision | undefined => {
    hookCalls.push(toolCall.id);
    return toolCall.name === "read" ? undefined : { action: "ask" };
  };

  const replay = createReplayModel([
    replyToolCalls([{ name: "read", id: "r" }, { name: "send", id: "s" }, { name: "pay", id: "p" }]),
    replyText("all done"),
  ]);
  const first = await runAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", beforeToolCall });
  hookCalls.length = 0;

  const saved = parseRunState(serializeRunState(first.state));
  assert.equal(saved.interruptions?.length, 2, "interruptions survive serialization");
  const second = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools,
    resumeFrom: saved,
    beforeToolCall,
    approvals: { s: { approve: true }, p: { approve: false, message: "Too expensive." } },
  });
  replay.dispose();

  assert.deepEqual(hookCalls, ["r"], "approved/rejected calls skip the hook; the held allowed call is decided again");
  assert.equal(read.calls.length, 1);
  assert.equal(send.calls.length, 1);
  assert.equal(pay.calls.length, 0);
  const byId = Object.fromEntries(results(second.messages).map((r) => [r.toolCallId, r]));
  assert.equal(text(byId.p!), "Denied by the approver: Too expensive.");
  assert.equal(byId.p!.isError, true);
  assert.equal(second.reason, "completed");
  assert.equal(second.text, "all done");
  assert.equal(second.state.interruptions, undefined, "no interruptions once resolved");
  assert.equal(second.state.toolCallsExecuted, 2);
});

test("resume: a call without a decision is asked again; nothing runs", async () => {
  const send = recordTool(tool("send"));
  const pay = recordTool(tool("pay"));
  const tools = [send.tool, pay.tool];
  const beforeToolCall = () => ({ action: "ask" }) as const;
  const replay = createReplayModel([replyToolCalls([{ name: "send", id: "s" }, { name: "pay", id: "p" }])]);
  const first = await runAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", beforeToolCall });
  const events = collectEvents();
  const second = await runAgent(
    { systemPrompt: "s", model: replay.model, tools, resumeFrom: first.state, beforeToolCall, approvals: { s: { approve: true } } },
    events.emit,
  );
  replay.dispose();
  assert.equal(second.reason, "interrupted");
  assert.equal(send.calls.length, 0, "the approved call waits for the rest of its batch");
  assert.deepEqual(events.ofType("tool_approval_requested").map((e) => e.toolCallId), ["p"]);
  assert.deepEqual(second.state.interruptions?.map((i) => i.toolCallId), ["p"]);
  assert.equal(replay.calls.length, 1, "no model call while interrupted");
});

test("resume: edited arguments void the approval; unknown ids and malformed approvals are RangeErrors", async () => {
  const send = recordTool(tool("send"));
  const beforeToolCall = () => ({ action: "ask" }) as const;
  const first = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyToolCalls([{ name: "send", id: "s", arguments: { to: "bob" } }])]).model,
    tools: [send.tool],
    prompt: "go",
    beforeToolCall,
  });

  // Tamper with the saved transcript: same call id, different recipient.
  const tampered = structuredClone(first.state);
  const assistant = tampered.messages[1]!;
  if (assistant.role === "assistant") {
    const call = assistant.content.find((c) => c.type === "toolCall");
    if (call?.type === "toolCall") call.arguments = { to: "mallory" };
  }
  const again = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([]).model,
    tools: [send.tool],
    resumeFrom: tampered,
    beforeToolCall,
    approvals: { s: { approve: true } },
  });
  assert.equal(send.calls.length, 0, "the approval was for bob, not mallory");
  assert.equal(again.reason, "interrupted");
  assert.deepEqual(again.state.interruptions?.[0]?.arguments, { to: "mallory" });

  const base = { systemPrompt: "s", model: createReplayModel([]).model, tools: [send.tool], resumeFrom: first.state };
  await assert.rejects(runAgent({ ...base, approvals: { nope: { approve: true } } }), /"nope" is not an interrupted tool call/);
  await assert.rejects(runAgent({ ...base, approvals: { s: { approve: "yes" } as never } }), /needs \{ approve: true \}/);
  await assert.rejects(
    runAgent({ systemPrompt: "s", model: base.model, tools: [send.tool], prompt: "x", approvals: { s: { approve: true } } }),
    RangeError,
    "approvals without resumeFrom",
  );
});

test("resume: a sequential batch keeps call order after approval", async () => {
  const order: string[] = [];
  const seq = (name: string) =>
    tool(name, {
      executionMode: "sequential",
      execute: async () => {
        order.push(name);
        return { content: [{ type: "text", text: name }], details: {} };
      },
    });
  const tools = [seq("a"), seq("b"), seq("c")];
  const beforeToolCall = decide({ b: { action: "ask" } });
  const replay = createReplayModel([replyToolCalls([{ name: "a", id: "1" }, { name: "b", id: "2" }, { name: "c", id: "3" }]), replyText("ok")]);
  const first = await runAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", beforeToolCall });
  assert.deepEqual(order, []);
  await runAgent({ systemPrompt: "s", model: replay.model, tools, resumeFrom: first.state, beforeToolCall, approvals: { "2": { approve: true } } });
  replay.dispose();
  assert.deepEqual(order, ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// afterToolCall
// ---------------------------------------------------------------------------

test("afterToolCall: replaces content, details, isError and terminate; sees thrown errors and timeouts", async () => {
  const seen: Array<{ name: string; isError: boolean }> = [];
  const result = await runAgent({
    systemPrompt: "s",
    model: createReplayModel([
      replyToolCalls([{ name: "read", id: "r" }, { name: "boom", id: "b" }, { name: "slow", id: "w" }]),
      replyToolCalls([{ name: "stop", id: "t" }]),
    ]).model,
    tools: [
      tool("read"),
      tool("boom", { execute: async () => Promise.reject(new Error("kaput")) }),
      tool("slow", { timeoutMs: 5, execute: () => new Promise(() => {}) }),
      tool("stop"),
    ],
    prompt: "go",
    afterToolCall: ({ toolCall, result: original, isError }) => {
      seen.push({ name: toolCall.name, isError });
      if (toolCall.name === "read") return { content: [{ type: "text", text: "[redacted]" }], details: {} };
      if (toolCall.name === "boom") return { isError: false, content: [{ type: "text", text: `recovered from: ${(original.content[0] as { text: string }).text}` }] };
      if (toolCall.name === "stop") return { terminate: true };
      return undefined;
    },
  });
  assert.deepEqual(seen.slice(0, 3), [
    { name: "read", isError: false },
    { name: "boom", isError: true },
    { name: "slow", isError: true },
  ]);
  const byId = Object.fromEntries(results(result.messages).map((r) => [r.toolCallId, r]));
  assert.equal(text(byId.r!), "[redacted]");
  assert.deepEqual(byId.r!.details, {}, "the secret in details is gone");
  assert.deepEqual([byId.b!.isError, text(byId.b!)], [false, "recovered from: kaput"]);
  assert.equal(byId.w!.isError, true);
  assert.equal(result.reason, "terminated", "terminate set by the hook");
});

test("afterToolCall is not called for denied, invalid or blocked calls", async () => {
  const seen: string[] = [];
  await runAgent({
    systemPrompt: "s",
    model: createReplayModel([replyToolCalls([{ name: "send", id: "1" }, { name: "missing", id: "2" }, { name: "read", id: "3" }])]).model,
    tools: [tool("send"), tool("read")],
    prompt: "go",
    maxToolCalls: 2,
    beforeToolCall: decide({ send: { action: "deny" } }),
    afterToolCall: ({ toolCall }) => {
      seen.push(toolCall.id);
      return undefined;
    },
  });
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// Failing hooks fail closed
// ---------------------------------------------------------------------------

test("a throwing beforeToolCall ends the run with error before anything runs; the batch stays resumable", async () => {
  const read = recordTool(tool("read"));
  const replay = createReplayModel([replyToolCalls([{ name: "read", id: "1" }, { name: "read", id: "2" }]), replyText("ok")]);
  let failing = true;
  const beforeToolCall = ({ toolCall }: BeforeToolCallContext) => {
    if (failing && toolCall.id === "2") throw new Error("policy service down");
    return undefined;
  };
  const first = await runAgent({ systemPrompt: "s", model: replay.model, tools: [read.tool], prompt: "go", beforeToolCall });
  assert.equal(first.reason, "error");
  assert.equal(first.errorMessage, "beforeToolCall failed: policy service down");
  assert.equal(read.calls.length, 0, "not even the call decided before the failure ran");
  assert.equal(results(first.state.messages).length, 0);

  failing = false;
  const second = await runAgent({ systemPrompt: "s", model: replay.model, tools: [read.tool], resumeFrom: first.state, beforeToolCall });
  replay.dispose();
  assert.equal(read.calls.length, 2);
  assert.equal(second.reason, "completed");
});

test("a throwing afterToolCall replaces that result with an error and ends the run after the batch", async () => {
  const replay = createReplayModel([replyToolCalls([{ name: "a", id: "1" }, { name: "b", id: "2" }]), replyText("never")]);
  const result = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools: [tool("a"), tool("b")],
    prompt: "go",
    afterToolCall: ({ toolCall }) => {
      if (toolCall.name === "a") throw new Error("redactor crashed");
      return undefined;
    },
  });
  replay.dispose();
  const [a, b] = results(result.messages);
  assert.deepEqual([a!.isError, text(a!)], [true, "afterToolCall failed: redactor crashed"]);
  assert.deepEqual(a!.details, {}, "the unfiltered details are not stored");
  assert.equal(b!.isError, false, "the rest of the batch finished");
  assert.equal(result.reason, "error");
  assert.equal(result.errorMessage, "afterToolCall failed: redactor crashed");
  assert.equal(replay.calls.length, 1);
});
