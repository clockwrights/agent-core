import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Model } from "@earendil-works/pi-ai";

import {
  buildChildBrief,
  createDelegateTaskTool,
  createDelegateTasksTool,
  createInMemoryChildRunRegistry,
  delegateTaskParameters,
  delegateTasksParameters,
  executeChildRun,
  inheritAllowedToolNames,
  type ChildRunRegistry,
  type ChildRunRequest,
  type DelegateTaskToolResultPayload,
  type DelegateTasksResultPayload
} from "@maya-ai/agent-loop-orchestration";
import {
  createRuntimeToolLlmAdapter,
  type RegisteredTool,
  type ToolAgentInput,
  type ToolLlmAdapter
} from "@maya-ai/agent-loop-core";
import type { AgentMessage, AgentTool } from "@maya-ai/tool-agent-runtime";
import { createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tool(name: string, executed: string[]): AgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}.`,
    parameters: Type.Object({}),
    execute: async () => {
      executed.push(name);
      return { content: [{ type: "text", text: `${name} ok` }], details: {} };
    }
  };
}

/** A parent with a read tool, a write tool and delegate_task (inherit enabled). */
function parentSetup(llm: ToolLlmAdapter, registry: ChildRunRegistry, options: { inherit?: boolean } = {}) {
  const executed: string[] = [];
  const lookup = tool("lookup", executed);
  const save = tool("save", executed);
  const registered: RegisteredTool[] = [
    { tool: lookup, metadata: { source: "system", risk: "read" } },
    { tool: save, metadata: { source: "domain", risk: "write" } }
  ];
  const delegate = createDelegateTaskTool({
    parentRunId: "parent-1",
    parentDepth: 0,
    llm,
    registry,
    ...(options.inherit === false ? {} : { inherit: { parentTools: registered } })
  });
  return { executed, tools: [lookup, save, delegate] };
}

function delegateCall(contextMode: string, id = "d1") {
  return { name: "delegate_task", id, arguments: { label: "sub", description: "Check the thing.", prompt: "Check the thing and report.", contextMode } };
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function toolResultJson<T>(messages: AgentMessage[], toolCallId: string): T {
  const result = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
  assert.ok(result && result.role === "toolResult");
  return JSON.parse((result.content[0] as { text: string }).text) as T;
}

// ---------------------------------------------------------------------------
// End-to-end through the reference adapter
// ---------------------------------------------------------------------------

test("inherit: the child replays the parent's request and adds one brief message", async () => {
  const replay = createReplayModel([
    replyToolCalls([delegateCall("inherit")]),
    // child: tries the write tool, a delegation, then the read tool
    replyToolCalls([{ name: "save", id: "c1" }, { name: "delegate_task", id: "c2", arguments: { label: "x", description: "y", prompt: "z" } }]),
    replyToolCalls([{ name: "lookup", id: "c3" }]),
    replyText("child finding"),
    replyText("parent final")
  ]);
  const llm = createRuntimeToolLlmAdapter({ model: replay.model });
  const registry = createInMemoryChildRunRegistry();
  const parent = parentSetup(llm, registry);

  const output = (await llm.runToolAgent({ systemPrompt: "parent system", prompt: "go", sessionId: "parent-session", tools: parent.tools }))!;
  replay.dispose();
  assert.equal(output.text, "parent final");

  const parentCall = replay.calls[0]!;
  const childCall = replay.calls[1]!;
  assert.equal(childCall.systemPrompt, parentCall.systemPrompt, "same system prompt");
  assert.deepEqual(childCall.tools!.map((t) => t.name), parentCall.tools!.map((t) => t.name), "same tools, same order");
  assert.deepEqual(childCall.messages.slice(0, parentCall.messages.length), parentCall.messages, "parent request is the prefix");
  assert.equal(childCall.messages.length, parentCall.messages.length + 1, "exactly one new message");
  const brief = userText(childCall.messages[childCall.messages.length - 1]!);
  assert.match(brief, /^\[Delegated Run\]/);
  assert.match(brief, /You may use: lookup\./);
  assert.match(brief, /\[Task\]\nCheck the thing and report\./);
  assert.equal(replay.callOptions[1]!.sessionId, "parent-session", "child uses the parent's session id");

  // Only the read tool ran; the write tool and the delegation were denied.
  assert.deepEqual(parent.executed, ["lookup"]);
  const denied = replay.calls[2]!.messages.filter((m) => m.role === "toolResult" && m.isError);
  assert.deepEqual(denied.map((m) => (m.role === "toolResult" ? m.toolName : "")), ["save", "delegate_task"]);
  assert.match(JSON.stringify(denied[0]), /not available in this delegated run/);

  const payload = toolResultJson<DelegateTaskToolResultPayload>(output.state!.messages, "d1");
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.warnings, []);

  // The parent's transcript holds only its own turns plus the tool result.
  assert.deepEqual(
    output.state!.messages.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"]
  );
});

test("inherit: delegate_tasks children all start from the same prefix", async () => {
  const tasks = [0, 1, 2].map((i) => ({ label: `t${i}`, description: `Task ${i}.`, prompt: `Do task ${i}.`, contextMode: "inherit" }));
  const replay = createReplayModel([
    replyToolCalls([{ name: "delegate_tasks", id: "b1", arguments: { tasks } }]),
    replyText("a"),
    replyText("b"),
    replyText("c"),
    replyText("done")
  ]);
  const llm = createRuntimeToolLlmAdapter({ model: replay.model });
  const registry = createInMemoryChildRunRegistry();
  const batch = createDelegateTasksTool({
    parentRunId: "parent-1",
    parentDepth: 0,
    llm,
    registry,
    policy: undefined,
    inherit: {}
  });
  const output = (await llm.runToolAgent({ systemPrompt: "p", prompt: "go", sessionId: "s", tools: [batch] }))!;
  replay.dispose();
  const parentCall = replay.calls[0]!;
  for (const childCall of replay.calls.slice(1, 4)) {
    assert.equal(childCall.systemPrompt, "p");
    assert.deepEqual(childCall.messages.slice(0, parentCall.messages.length), parentCall.messages);
    assert.match(userText(childCall.messages[childCall.messages.length - 1]!), /No tools are available in this run/);
  }
  const payload = toolResultJson<DelegateTasksResultPayload>(output.state!.messages, "b1");
  assert.equal(payload.completed, 3);
});

test("inherit: the provider cache is reused (faux provider), isolated children start cold", async () => {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel() as Model<any>;
    const llm = createRuntimeToolLlmAdapter({ model });
    const registry = createInMemoryChildRunRegistry();
    const parent = parentSetup(llm, registry);
    const longContext = "Background notes. ".repeat(200);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("delegate_task", { label: "warm", description: "d", prompt: "p", contextMode: "inherit" }, { id: "w" })]),
      fauxAssistantMessage("child warm"),
      fauxAssistantMessage([fauxToolCall("delegate_task", { label: "cold", description: "d", prompt: "p", contextMode: "isolated" }, { id: "k" })]),
      fauxAssistantMessage("child cold"),
      fauxAssistantMessage("end")
    ]);
    await llm.runToolAgent({ systemPrompt: `parent ${longContext}`, prompt: "go", sessionId: "cache-session", tools: parent.tools });
    const results = registry.snapshot().entries.map((entry) => entry.result!);
    const warm = results.find((r) => r.label === "warm")!;
    const cold = results.find((r) => r.label === "cold")!;
    assert.ok(warm.usage!.cacheRead > 500, `inherit child read the cached prefix (${warm.usage!.cacheRead})`);
    assert.equal(cold.usage!.cacheRead, 0, "isolated child has no cached prefix");
  } finally {
    faux.unregister();
  }
});

// ---------------------------------------------------------------------------
// Fallbacks and gating
// ---------------------------------------------------------------------------

function stubAdapter(supports: { runState?: boolean; approvals?: boolean } = {}) {
  const calls: ToolAgentInput[] = [];
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true, supports }),
    async runToolAgent(input) {
      calls.push(input);
      return { text: "done", toolCalls: [] };
    }
  };
  return { llm, calls };
}

function inheritRequest(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    runId: "child-1",
    parentRunId: "parent-1",
    parentDepth: 0,
    label: "sub",
    description: "Check.",
    prompt: "Check it.",
    contextMode: "inherit",
    executionMode: "blocking_inline",
    inherited: {
      sessionId: "ps",
      systemPrompt: "parent system",
      tools: [],
      messages: [{ role: "user", content: "go", timestamp: 1 }],
      modelId: "m-1"
    },
    ...overrides
  };
}

test("inherit falls back to isolated with a warning when it cannot work", async () => {
  const cases: Array<[string, { runState?: boolean; approvals?: boolean }, Partial<ChildRunRequest>, RegExp]> = [
    ["no parent request", { runState: true, approvals: true }, { inherited: undefined }, /no parent request/],
    ["no runState", { approvals: true }, {}, /does not support messages/],
    ["no approvals", { runState: true }, {}, /does not support tool hooks/]
  ];
  for (const [name, supports, overrides, pattern] of cases) {
    const { llm, calls } = stubAdapter(supports);
    const envelope = await executeChildRun({ request: inheritRequest(overrides), llm, registry: createInMemoryChildRunRegistry() });
    assert.equal(envelope.status, "completed", name);
    assert.match(envelope.warnings![0]!, pattern, name);
    assert.match(envelope.warnings![0]!, /ran isolated$/, name);
    assert.equal(calls[0]!.messages, undefined, `${name}: isolated run`);
    assert.equal(calls[0]!.sessionId, "child-1", name);
    assert.notEqual(calls[0]!.systemPrompt, "parent system", name);
  }
});

test("inherit with an explicit different model warns that the cache is not reused", async () => {
  const { llm, calls } = stubAdapter({ runState: true, approvals: true });
  const envelope = await executeChildRun({
    request: inheritRequest({ model: "other-model" }),
    llm,
    registry: createInMemoryChildRunRegistry()
  });
  assert.equal(calls[0]!.model, "other-model");
  assert.equal(calls[0]!.sessionId, "ps");
  assert.deepEqual(envelope.warnings, ["inherit: model or reasoning differs from the parent; the prompt cache is not reused"]);

  const same = stubAdapter({ runState: true, approvals: true });
  const quiet = await executeChildRun({ request: inheritRequest({ model: "m-1" }), llm: same.llm, registry: createInMemoryChildRunRegistry() });
  assert.equal(quiet.warnings, undefined);
});

test("without inherit enabled the schemas are unchanged and the mode is rejected", async () => {
  const registry = createInMemoryChildRunRegistry();
  const { llm, calls } = stubAdapter({ runState: true, approvals: true });
  const plain = createDelegateTaskTool({ parentRunId: "p", parentDepth: 0, llm, registry });
  assert.equal(plain.parameters, delegateTaskParameters);
  assert.doesNotMatch(plain.description, /inherit/);
  const plainBatch = createDelegateTasksTool({ parentRunId: "p", parentDepth: 0, llm, registry });
  assert.equal(plainBatch.parameters, delegateTasksParameters);

  const enabled = createDelegateTaskTool({ parentRunId: "p", parentDepth: 0, llm, registry, inherit: {} });
  assert.match(enabled.description, /inherit:/);
  assert.match(JSON.stringify(enabled.parameters), /"inherit"/);

  const result = await plain.execute("x", { label: "a", description: "b", prompt: "c", contextMode: "inherit" as never });
  const payload = JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}") as DelegateTaskToolResultPayload;
  assert.equal(payload.status, "failed");
  assert.equal(payload.failureCode, "validation_error");
  assert.match(payload.summary, /not enabled/);
  assert.equal(calls.length, 0);
});

test("inheritAllowedToolNames applies the preset and always drops delegation tools", () => {
  const noop = (name: string): AgentTool => tool(name, []);
  const registered: RegisteredTool[] = [
    { tool: noop("read_a"), metadata: { source: "system", risk: "read" } },
    { tool: noop("write_b"), metadata: { source: "domain", risk: "write" } },
    { tool: noop("delegate_task"), metadata: { source: "system", risk: "read" } }
  ];
  const policy = { enabled: true, sources: { domain: false, mcp: false, memory: true, system: true }, allow: [], deny: [] };
  assert.deepEqual([...inheritAllowedToolNames(registered, policy)], ["read_a"]);
  assert.deepEqual([...inheritAllowedToolNames(undefined, policy)], []);
});

test("buildChildBrief lists the allowed tools and ends with the task", () => {
  const brief = buildChildBrief({ request: inheritRequest(), allowedTools: ["a", "b"] });
  assert.match(brief, /You may use: a, b\./);
  assert.match(brief, /Context mode: inherit\./);
  assert.ok(brief.endsWith("[Task]\nCheck it."));
});
