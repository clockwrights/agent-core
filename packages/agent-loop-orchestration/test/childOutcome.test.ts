// ---------------------------------------------------------------------------
// Tests: child usage, end reasons → status (incl. "partial"), child turn caps.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import {
  DEFAULT_ORCHESTRATION_POLICY,
  computeChildLifecycleCounts,
  createDelegateTasksTool,
  createInMemoryChildRunRegistry,
  executeChildRun,
  resolveChildModel,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type DelegateTasksResultPayload
} from "@maya-ai/agent-loop-orchestration";
import {
  createRuntimeToolLlmAdapter,
  emptyAgentRuntimeContext,
  type ToolAgentInput,
  type ToolAgentOutput,
  type ToolLlmAdapter
} from "@maya-ai/agent-loop-core";
import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stubAdapter(output: ToolAgentOutput) {
  const calls: ToolAgentInput[] = [];
  const adapter: ToolLlmAdapter = {
    metadata: () => ({ enabled: true, supports: { limits: true, usage: true } }),
    runToolAgent: async (input) => {
      calls.push(input);
      return output;
    }
  };
  return { adapter, calls };
}

function request(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    runId: "child-1",
    parentRunId: "parent-1",
    parentDepth: 0,
    label: "research",
    description: "Investigate.",
    prompt: "Read and report.",
    contextMode: "isolated",
    executionMode: "blocking_inline",
    ...overrides
  };
}

const usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 }
};

async function run(llm: ToolLlmAdapter, overrides: Partial<ChildRunRequest> = {}, extra: Record<string, unknown> = {}) {
  const registry = createInMemoryChildRunRegistry();
  const progress: string[] = [];
  const envelope = await executeChildRun({
    request: request(overrides),
    llm,
    registry,
    runtimeFactory: async () => emptyAgentRuntimeContext(),
    buildTools: () => [],
    onProgress: (m) => progress.push(typeof m === "string" ? m : JSON.stringify(m)),
    ...extra
  });
  return { envelope, registry, progress };
}

// ---------------------------------------------------------------------------
// Usage and end reasons
// ---------------------------------------------------------------------------

test("completed child carries real usage, end reason and turns; progress shows tokens", async () => {
  const { adapter } = stubAdapter({ text: "Answer.", toolCalls: [], usage, endReason: "completed", turns: 3 });
  const { envelope, progress } = await run(adapter);

  assert.equal(envelope.status, "completed");
  assert.deepEqual(envelope.usage, usage);
  assert.equal(envelope.endReason, "completed");
  assert.equal(envelope.turns, 3);
  assert.ok(progress.some((m) => /tokens=120, cost=\$0\.0015/.test(m)), progress.join("\n"));
});

for (const endReason of ["max_turns", "max_tool_calls", "budget"] as const) {
  test(`end reason ${endReason} → partial: text kept, warning added, registry terminal`, async () => {
    const { adapter } = stubAdapter({
      text: "Half-done findings.",
      toolCalls: [{ name: "search", args: {}, isError: false }],
      usage,
      endReason
    });
    const { envelope, registry, progress } = await run(adapter);

    assert.equal(envelope.status, "partial");
    assert.equal(envelope.text, "Half-done findings.");
    assert.equal(envelope.summary, "Half-done findings.");
    assert.equal(envelope.failure, undefined);
    assert.deepEqual(envelope.warnings, [`Child stopped early (${endReason}); the result may be incomplete.`]);
    assert.equal(registry.get("child-1")?.status, "partial");
    assert.equal(registry.getResult("child-1"), envelope);
    assert.ok(progress.some((m) => m.includes(`stopped early (${endReason})`)));
  });
}

test("end reason error → failed with llm_error; output kept", async () => {
  const { adapter } = stubAdapter({ text: "partial text", toolCalls: [], endReason: "error", errorMessage: "overloaded" });
  const { envelope, registry } = await run(adapter);

  assert.equal(envelope.status, "failed");
  assert.deepEqual(envelope.failure, { code: "llm_error", message: "overloaded", retryable: true });
  assert.equal(envelope.summary, "Child run failed: overloaded");
  assert.equal(envelope.text, "partial text");
  assert.equal(registry.get("child-1")?.status, "failed");
});

test("end reason aborted → cancelled", async () => {
  const { adapter } = stubAdapter({ text: "", toolCalls: [], endReason: "aborted", errorMessage: "Request was aborted" });
  const { envelope } = await run(adapter);
  assert.equal(envelope.status, "cancelled");
  assert.equal(envelope.failure?.code, "cancelled");
});

test("adapter without end reason (older adapters) → completed, no usage fields", async () => {
  const { adapter } = stubAdapter({ text: "Answer.", toolCalls: [] });
  const { envelope } = await run(adapter);
  assert.equal(envelope.status, "completed");
  assert.equal("usage" in envelope, false);
  assert.equal("endReason" in envelope, false);
  assert.equal("turns" in envelope, false);
  assert.equal("warnings" in envelope, false);
});

// ---------------------------------------------------------------------------
// Turn caps
// ---------------------------------------------------------------------------

test("maxTurns: request value wins, then the policy default, else none is sent", async () => {
  const first = stubAdapter({ text: "a", toolCalls: [] });
  await run(first.adapter, { maxTurns: 3 }, { policy: { ...DEFAULT_ORCHESTRATION_POLICY, defaultChildMaxTurns: 8 } });
  assert.equal(first.calls[0]!.maxTurns, 3);

  const second = stubAdapter({ text: "a", toolCalls: [] });
  await run(second.adapter, {}, { policy: { ...DEFAULT_ORCHESTRATION_POLICY, defaultChildMaxTurns: 8 } });
  assert.equal(second.calls[0]!.maxTurns, 8);

  const third = stubAdapter({ text: "a", toolCalls: [] });
  await run(third.adapter);
  assert.equal("maxTurns" in third.calls[0]!, false);
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.defaultChildMaxTurns, undefined, "no default cap");
});

test("maxTurns must be a positive integer", async () => {
  const { adapter, calls } = stubAdapter({ text: "a", toolCalls: [] });
  const { envelope } = await run(adapter, { maxTurns: 0 });
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.failure?.code, "validation_error");
  assert.equal(calls.length, 0);
});

test("end to end with the runtime adapter: a child hitting its turn cap returns partial with usage", async () => {
  const params = Type.Object({});
  const lookup: AgentTool<typeof params> = {
    name: "lookup",
    label: "Lookup",
    description: "Look something up.",
    parameters: params,
    execute: async () => ({ content: [{ type: "text", text: "a fact" }], details: {} })
  };
  const replay = createReplayModel([
    replyToolCalls([{ name: "lookup" }], { text: "Found one fact so far.", usage: { totalTokens: 40, cost: { total: 0.0004 } } }),
    replyText("never reached")
  ]);
  const llm = createRuntimeToolLlmAdapter({ model: replay.model });
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun({
    request: request({ maxTurns: 1 }),
    llm,
    registry,
    runtimeFactory: async () => emptyAgentRuntimeContext(),
    buildTools: () => [lookup]
  });
  replay.dispose();

  assert.equal(envelope.status, "partial");
  assert.equal(envelope.endReason, "max_turns");
  assert.equal(envelope.turns, 1);
  assert.equal(envelope.usage?.totalTokens, 40);
  assert.equal(envelope.text, "Found one fact so far.");
  assert.deepEqual(envelope.toolCalls, [{ name: "lookup", isError: false }]);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test("lifecycle counts and delegate_tasks payload count partial children separately", async () => {
  const envelope = (status: ChildRunResultEnvelope["status"]): ChildRunResultEnvelope => ({
    runId: status,
    parentRunId: "p",
    label: status,
    status,
    summary: "",
    toolCalls: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 0
  });
  const counts = computeChildLifecycleCounts([envelope("completed"), envelope("partial"), envelope("failed")]);
  assert.equal(counts.completed, 1);
  assert.equal(counts.partial, 1);
  assert.equal(counts.failed, 1);

  const outputs: ToolAgentOutput[] = [
    { text: "full", toolCalls: [], endReason: "completed" },
    { text: "half", toolCalls: [], endReason: "max_turns" }
  ];
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true }),
    runToolAgent: async () => outputs.shift()
  };
  const tool = createDelegateTasksTool({
    parentRunId: "p-1",
    parentDepth: 0,
    llm,
    registry: createInMemoryChildRunRegistry(),
    policy: { ...DEFAULT_ORCHESTRATION_POLICY, maxConcurrentChildren: 1 },
    runtimeFactory: async () => emptyAgentRuntimeContext(),
    buildTools: () => []
  });
  const result = await tool.execute("call-1", {
    tasks: [
      { label: "a", description: "a", prompt: "a" },
      { label: "b", description: "b", prompt: "b" }
    ]
  });
  const payload = JSON.parse((result.content[0] as { text: string }).text) as DelegateTasksResultPayload;
  assert.equal(payload.completed, 1);
  assert.equal(payload.partial, 1);
  assert.equal(payload.failed, 0);
  assert.deepEqual(payload.results.map((r) => r.status), ["completed", "partial"]);
});

// ---------------------------------------------------------------------------
// Per-child model and reasoning (request > profile > policy > parent)
// ---------------------------------------------------------------------------

test("resolveChildModel: request > profile > policy > unset", () => {
  const policy = { defaultChildModel: "policy-model", defaultChildThinkingLevel: "low" as const };
  assert.deepEqual(
    resolveChildModel({ model: "call", thinkingLevel: "high", profile: { model: "profile", thinkingLevel: "medium" } }, policy),
    { model: "call", thinkingLevel: "high" }
  );
  assert.deepEqual(resolveChildModel({ profile: { model: "profile", thinkingLevel: "medium" } }, policy), {
    model: "profile",
    thinkingLevel: "medium"
  });
  assert.deepEqual(resolveChildModel({}, policy), { model: "policy-model", thinkingLevel: "low" });
  assert.deepEqual(resolveChildModel({}, {}), {}, "nothing set → adapter default (parent model)");
  assert.deepEqual(resolveChildModel({ thinkingLevel: "off" }, policy), { model: "policy-model", thinkingLevel: "off" });
});

test("executor sends the resolved model/reasoning to the adapter and records them on the envelope", async () => {
  const withProfile = stubAdapter({ text: "a", toolCalls: [] });
  const { envelope } = await run(
    withProfile.adapter,
    { profile: { model: "research-profile", thinkingLevel: "medium" } },
    { policy: { ...DEFAULT_ORCHESTRATION_POLICY, defaultChildModel: "cheap", defaultChildThinkingLevel: "low" } }
  );
  assert.equal(withProfile.calls[0]!.model, "research-profile");
  assert.equal(withProfile.calls[0]!.reasoning, "medium");
  assert.equal(envelope.model, "research-profile");
  assert.equal(envelope.thinkingLevel, "medium");

  const inherit = stubAdapter({ text: "a", toolCalls: [] });
  const inherited = await run(inherit.adapter);
  assert.equal("model" in inherit.calls[0]!, false);
  assert.equal("reasoning" in inherit.calls[0]!, false);
  assert.equal("model" in inherited.envelope, false);
});

test("policy no longer carries the never-enforced child token budget", () => {
  assert.equal("defaultChildTokenBudget" in DEFAULT_ORCHESTRATION_POLICY, false);
});
