/**
 * Parallel fan-out tests (Stage 9).
 *
 * Two layers of coverage:
 *
 *   1. The pure runner — `runChildrenInParallel` — using a stub
 *      `executeOne` that records start/finish ordering. These tests
 *      assert concurrency bounds and result-order determinism without
 *      involving any LLM, registry, or tool surface.
 *
 *   2. The `delegate_tasks` tool end-to-end — using a queued LLM stub.
 *      These exercise the validation, projection, and registry
 *      integration paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ORCHESTRATION_POLICY,
  DELEGATE_TASKS_TOOL_NAME,
  createDelegateTasksTool,
  createDelegateTasksToolDefinition,
  createInMemoryChildRunRegistry,
  delegateTasksParameters,
  executeDelegateTasks,
  runChildrenInParallel,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type DelegateTasksInput,
  type DelegateTasksResultPayload,
  type DelegateTasksToolContext,
  type DelegateTasksToolResult
} from "@maya-ai/agent-loop-orchestration";

import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import type {
  ToolAgentInput,
  ToolAgentOutput,
  ToolLlmAdapter
} from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildRequest(overrides: Partial<ChildRunRequest>): ChildRunRequest {
  return {
    runId: overrides.runId ?? `r-${Math.random().toString(36).slice(2)}`,
    parentRunId: overrides.parentRunId ?? "p-1",
    parentDepth: overrides.parentDepth ?? 0,
    label: overrides.label ?? "task",
    description: overrides.description ?? "do work",
    prompt: overrides.prompt ?? "do work",
    contextMode: overrides.contextMode ?? "isolated",
    executionMode: "blocking_inline"
  };
}

function buildEnvelope(request: ChildRunRequest, summary: string): ChildRunResultEnvelope {
  return {
    runId: request.runId,
    parentRunId: request.parentRunId,
    label: request.label,
    status: "completed",
    summary,
    toolCalls: [],
    startedAt: "2026-05-07T10:00:00.000Z",
    endedAt: "2026-05-07T10:00:01.000Z",
    durationMs: 1000
  };
}

interface StubAdapter extends ToolLlmAdapter {
  calls: ToolAgentInput[];
}

function buildQueuedAdapter(scripts: { output?: ToolAgentOutput; throwError?: unknown; delayMs?: number }[]): StubAdapter {
  const calls: ToolAgentInput[] = [];
  let i = 0;
  return {
    calls,
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i++;
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      if (script.throwError !== undefined) throw script.throwError;
      return script.output ?? { text: "default", toolCalls: [] };
    }
  };
}

function emptyRuntime(): AgentRuntimeContext {
  return {
    toolDefinitions: [],
    toolPolicy: {
      enabled: true,
      sources: { domain: false, mcp: false, memory: false, system: false },
      allow: [],
      deny: []
    },
    skillsPrompt: "",
    memoryPrompt: "",
    diagnostics: []
  };
}

function buildContext(overrides: Partial<DelegateTasksToolContext> = {}): DelegateTasksToolContext {
  return {
    parentRunId: overrides.parentRunId ?? "p-1",
    parentDepth: overrides.parentDepth ?? 0,
    llm: overrides.llm ?? buildQueuedAdapter([]),
    registry: overrides.registry ?? createInMemoryChildRunRegistry(),
    policy: overrides.policy,
    presetOverrides: overrides.presetOverrides,
    onProgress: overrides.onProgress,
    clock:
      overrides.clock ??
      (() => "2026-05-07T11:00:00.000Z"),
    runtimeFactory: overrides.runtimeFactory ?? (async () => emptyRuntime()),
    buildSystemPrompt: overrides.buildSystemPrompt,
    buildTools: overrides.buildTools
  };
}

const VALID_TASK = (label: string) => ({
  label,
  description: `desc for ${label}`,
  prompt: `prompt for ${label}`
});

function parsePayload(result: DelegateTasksToolResult): DelegateTasksResultPayload {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// runChildrenInParallel — pure runner
// ---------------------------------------------------------------------------

test("parallel runner: empty input returns empty array, executor never invoked", async () => {
  let calls = 0;
  const out = await runChildrenInParallel({
    requests: [],
    maxConcurrent: 4,
    executeOne: async () => {
      calls++;
      throw new Error("should not be called");
    }
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("parallel runner: results array preserves input order regardless of completion order", async () => {
  // Three requests; executor delays them in REVERSE order so completion
  // order is opposite of input order. Result indices must still match.
  const requests = [
    buildRequest({ runId: "r0", label: "a" }),
    buildRequest({ runId: "r1", label: "b" }),
    buildRequest({ runId: "r2", label: "c" })
  ];
  const delays = [30, 10, 0];
  const out = await runChildrenInParallel({
    requests,
    maxConcurrent: 3,
    executeOne: async (req) => {
      const i = requests.indexOf(req);
      await new Promise((r) => setTimeout(r, delays[i]));
      return buildEnvelope(req, `result for ${req.label}`);
    }
  });
  assert.deepEqual(
    out.map((r) => r.label),
    ["a", "b", "c"],
    "results must follow input order, not completion order"
  );
});

test("parallel runner: respects maxConcurrent cap (peak active <= cap)", async () => {
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 6 }, (_, i) =>
    buildRequest({ runId: `r${i}`, label: `t${i}` })
  );
  await runChildrenInParallel({
    requests,
    maxConcurrent: 2,
    executeOne: async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return buildEnvelope(req, "ok");
    }
  });
  assert.ok(peak <= 2, `expected peak <= 2, got ${peak}`);
  assert.ok(peak >= 1, "executor should have been called at all");
});

test("parallel runner: maxConcurrent <= 0 is treated as 1 (purely sequential)", async () => {
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 3 }, (_, i) =>
    buildRequest({ runId: `r${i}`, label: `t${i}` })
  );
  await runChildrenInParallel({
    requests,
    maxConcurrent: 0,
    executeOne: async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return buildEnvelope(req, "ok");
    }
  });
  assert.equal(peak, 1, "concurrency should clamp to 1");
});

test("parallel runner: onWorker hook fires started+finished for every request", async () => {
  const events: Array<{ event: string; label: string }> = [];
  const requests = [
    buildRequest({ runId: "r0", label: "a" }),
    buildRequest({ runId: "r1", label: "b" })
  ];
  await runChildrenInParallel({
    requests,
    maxConcurrent: 2,
    executeOne: async (req) => buildEnvelope(req, "ok"),
    onWorker: (event, request) => events.push({ event, label: request.label })
  });
  // Each request fires exactly one started + one finished.
  for (const req of requests) {
    const matching = events.filter((e) => e.label === req.label);
    assert.equal(matching.length, 2);
    assert.equal(matching[0].event, "started");
    assert.equal(matching[1].event, "finished");
  }
});

test("parallel runner: executor throwing propagates out (executor contract: must not throw)", async () => {
  // The runner does not swallow exceptions; the contract is that the
  // executor returns an envelope (success or failure). Tests pin this
  // so a future refactor doesn't accidentally start swallowing.
  await assert.rejects(
    runChildrenInParallel({
      requests: [buildRequest({ runId: "r0", label: "x" })],
      maxConcurrent: 1,
      executeOne: async () => {
        throw new Error("contract violation");
      }
    }),
    /contract violation/
  );
});

// ---------------------------------------------------------------------------
// delegate_tasks tool — registration shape
// ---------------------------------------------------------------------------

test("delegate_tasks tool: name, schema, source/risk metadata", () => {
  const ctx = buildContext();
  const tool = createDelegateTasksTool(ctx);
  assert.equal(tool.name, "delegate_tasks");
  assert.equal(DELEGATE_TASKS_TOOL_NAME, "delegate_tasks");
  // The schema declares `tasks` as an array.
  const props = (delegateTasksParameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.ok(props.tasks);
  // RegisteredTool wrapper.
  const def = createDelegateTasksToolDefinition(ctx);
  assert.equal(def.metadata.source, "system");
  assert.equal(def.metadata.risk, "read");
});

// ---------------------------------------------------------------------------
// delegate_tasks tool — happy path
// ---------------------------------------------------------------------------

test("delegate_tasks: three valid tasks run in parallel; results returned in input order", async () => {
  const registry = createInMemoryChildRunRegistry();
  // Each child does one runToolAgent call, so 3 LLM calls total.
  const llm = buildQueuedAdapter([
    { output: { text: "alpha out", toolCalls: [] } },
    { output: { text: "bravo out", toolCalls: [] } },
    { output: { text: "charlie out", toolCalls: [] } }
  ]);
  const ctx = buildContext({ llm, registry });
  const result = await executeDelegateTasks(
    {
      tasks: [VALID_TASK("alpha"), VALID_TASK("bravo"), VALID_TASK("charlie")]
    } as DelegateTasksInput,
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 3);
  assert.equal(payload.completed, 3);
  assert.equal(payload.failed, 0);
  assert.deepEqual(
    payload.results.map((r) => r.label),
    ["alpha", "bravo", "charlie"]
  );
  // Registry sees three children for this parent.
  assert.equal(registry.listByParent("p-1").length, 3);
});

test("delegate_tasks: bounded by policy.maxConcurrentChildren under load", async () => {
  // 4 tasks, maxConcurrent = 2. Use delays in the LLM stub to make the
  // sliding window observable. We verify by counting active LLM calls
  // at any point through the call timeline.
  const registry = createInMemoryChildRunRegistry();
  let active = 0;
  let peak = 0;
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true }),
    async runToolAgent() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { text: "ok", toolCalls: [] };
    }
  };
  const ctx = buildContext({
    llm,
    registry,
    policy: { ...DEFAULT_ORCHESTRATION_POLICY, maxConcurrentChildren: 2, maxBatchTasks: 4 }
  });
  await executeDelegateTasks(
    {
      tasks: [
        VALID_TASK("a"),
        VALID_TASK("b"),
        VALID_TASK("c"),
        VALID_TASK("d")
      ]
    },
    ctx
  );
  assert.ok(peak <= 2, `expected peak <= 2, got ${peak}`);
  assert.ok(peak >= 1);
  assert.equal(registry.listByParent("p-1").length, 4);
});

// ---------------------------------------------------------------------------
// delegate_tasks tool — validation paths
// ---------------------------------------------------------------------------

test("delegate_tasks: empty tasks array rejected at the batch boundary", async () => {
  const ctx = buildContext();
  const result = await executeDelegateTasks({ tasks: [] }, ctx);
  const payload = parsePayload(result);
  assert.equal(payload.total, 1); // one synthetic batch-level failure envelope
  assert.equal(payload.completed, 0);
  assert.equal(payload.failed, 1);
  assert.equal(payload.results[0].failureCode, "validation_error");
  assert.match(payload.results[0].summary, /non-empty array/);
});

test("delegate_tasks: tasks.length > maxBatchTasks rejected at the batch boundary", async () => {
  const policy = { ...DEFAULT_ORCHESTRATION_POLICY, maxBatchTasks: 2 };
  const ctx = buildContext({ policy });
  const result = await executeDelegateTasks(
    { tasks: [VALID_TASK("a"), VALID_TASK("b"), VALID_TASK("c")] },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 1);
  assert.equal(payload.failed, 1);
  assert.match(payload.results[0].summary, /maxBatchTasks/);
});

test("delegate_tasks: depth-gating safety net at the batch boundary", async () => {
  const ctx = buildContext({ parentDepth: 1 });
  const result = await executeDelegateTasks(
    { tasks: [VALID_TASK("a"), VALID_TASK("b")] },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.failed, 1);
  assert.match(payload.results[0].summary, /maxDepth/);
});

test("delegate_tasks: peak active (active + min(concurrent, valid)) > maxActiveChildrenPerParent rejects the whole batch", async () => {
  const policy = {
    ...DEFAULT_ORCHESTRATION_POLICY,
    maxActiveChildrenPerParent: 3,
    maxConcurrentChildren: 2,
    maxBatchTasks: 3 // keep batch-size guard out of the way; we want active-cap to fire
  };
  const registry = createInMemoryChildRunRegistry();
  // Seed two already-active children for parent p-1 so activeCount == 2.
  for (let i = 0; i < 2; i++) {
    const seedId = `seed-${i}`;
    registry.create(
      buildRequest({ runId: seedId, label: `seed-${i}`, parentRunId: "p-1" }),
      "2026-05-08T10:00:00.000Z"
    );
    registry.markRunning(seedId);
  }
  const ctx = buildContext({ registry, policy });
  // peak = 2 + min(2, 2) = 4 > 3 → reject.
  const result = await executeDelegateTasks(
    { tasks: [VALID_TASK("a"), VALID_TASK("b")] },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 1, "the whole batch is rejected as one synthetic envelope");
  assert.equal(payload.failed, 1);
  assert.equal(payload.results[0].failureCode, "validation_error");
  assert.match(payload.results[0].summary, /maxActiveChildrenPerParent/);
  // Registry still has only the 2 seeded children — no new ones were created.
  assert.equal(registry.listByParent("p-1").length, 2);
});

test("delegate_tasks: peak active == maxActiveChildrenPerParent is allowed (boundary)", async () => {
  const policy = {
    ...DEFAULT_ORCHESTRATION_POLICY,
    maxActiveChildrenPerParent: 3,
    maxConcurrentChildren: 2,
    maxBatchTasks: 3
  };
  const registry = createInMemoryChildRunRegistry();
  // Seed 1 active; submit 2 valid tasks → peak = 1 + min(2,2) = 3, allowed.
  registry.create(
    buildRequest({ runId: "seed-0", label: "seed-0", parentRunId: "p-1" }),
    "2026-05-08T10:00:00.000Z"
  );
  registry.markRunning("seed-0");
  const llm = buildQueuedAdapter([
    { output: { text: "ok-a", toolCalls: [] } },
    { output: { text: "ok-b", toolCalls: [] } }
  ]);
  const ctx = buildContext({ registry, policy, llm });
  const result = await executeDelegateTasks(
    { tasks: [VALID_TASK("a"), VALID_TASK("b")] },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 2);
  assert.equal(payload.completed, 2);
});

test("delegate_tasks: high task count with low concurrency is allowed (cap on peak, not total)", async () => {
  // 4 tasks at concurrency 2 with maxActive 3 — peak = 0 + min(2, 4) = 2,
  // ≤ 3, so the batch must be allowed even though valid > maxActive.
  const policy = {
    ...DEFAULT_ORCHESTRATION_POLICY,
    maxActiveChildrenPerParent: 3,
    maxConcurrentChildren: 2,
    maxBatchTasks: 4
  };
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([
    { output: { text: "ok-a", toolCalls: [] } },
    { output: { text: "ok-b", toolCalls: [] } },
    { output: { text: "ok-c", toolCalls: [] } },
    { output: { text: "ok-d", toolCalls: [] } }
  ]);
  const ctx = buildContext({ registry, policy, llm });
  const result = await executeDelegateTasks(
    {
      tasks: [VALID_TASK("a"), VALID_TASK("b"), VALID_TASK("c"), VALID_TASK("d")]
    },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 4);
  assert.equal(payload.completed, 4);
});

test("delegate_tasks: per-task validation isolation — invalid tasks fail; valid tasks still run", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([
    { output: { text: "valid 1", toolCalls: [] } },
    { output: { text: "valid 2", toolCalls: [] } }
  ]);
  const ctx = buildContext({
    llm,
    registry,
    // Default maxBatchTasks is 3; this test uses 4 deliberately.
    policy: { ...DEFAULT_ORCHESTRATION_POLICY, maxBatchTasks: 4 }
  });
  const result = await executeDelegateTasks(
    {
      tasks: [
        { ...VALID_TASK("invalid-empty-prompt"), prompt: "" }, // invalid
        VALID_TASK("good-1"),
        { ...VALID_TASK("invalid-no-label"), label: "" }, // invalid
        VALID_TASK("good-2")
      ]
    },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.total, 4);
  assert.equal(payload.completed, 2);
  assert.equal(payload.failed, 2);
  // Invalid envelopes preserve input position.
  assert.equal(payload.results[0].failureCode, "validation_error");
  assert.equal(payload.results[1].status, "completed");
  assert.equal(payload.results[2].failureCode, "validation_error");
  assert.equal(payload.results[3].status, "completed");
  // Registry has only the two valid children.
  assert.equal(registry.listByParent("p-1").length, 2);
});

test("delegate_tasks: oversized prompt rejected per-task", async () => {
  const ctx = buildContext();
  const result = await executeDelegateTasks(
    {
      tasks: [
        { ...VALID_TASK("x"), prompt: "a".repeat(20_000) },
        VALID_TASK("ok")
      ]
    },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.results[0].failureCode, "validation_error");
});

// ---------------------------------------------------------------------------
// delegate_tasks tool — runtime failure surfaces cleanly
// ---------------------------------------------------------------------------

test("delegate_tasks: per-task runtime failures surfaced individually", async () => {
  const registry = createInMemoryChildRunRegistry();
  // Three children: one succeeds, one throws, one succeeds. Order of
  // execution may vary but result projection is by input index.
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      // Branch on the prompt text to identify which child this is.
      if (input.prompt.includes("FAIL")) throw new Error("upstream 500");
      return { text: "ok", toolCalls: [] };
    }
  };
  const ctx = buildContext({ llm, registry });
  const result = await executeDelegateTasks(
    {
      tasks: [
        { ...VALID_TASK("good-1"), prompt: "do good 1" },
        { ...VALID_TASK("bad"), prompt: "FAIL me" },
        { ...VALID_TASK("good-2"), prompt: "do good 2" }
      ]
    },
    ctx
  );
  const payload = parsePayload(result);
  assert.equal(payload.results[0].status, "completed");
  assert.equal(payload.results[1].status, "failed");
  assert.equal(payload.results[1].failureCode, "unknown");
  assert.equal(payload.results[2].status, "completed");
  // Registry agreement.
  assert.equal(registry.listByParent("p-1").length, 3);
});

// ---------------------------------------------------------------------------
// Tool result shape contract
// ---------------------------------------------------------------------------

test("delegate_tasks result shape: parseable JSON + typed details", async () => {
  const llm = buildQueuedAdapter([{ output: { text: "ok", toolCalls: [] } }]);
  const result = await executeDelegateTasks(
    { tasks: [VALID_TASK("only")] },
    buildContext({ llm })
  );
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.doesNotThrow(() => JSON.parse(result.content[0].text));
  assert.equal(typeof result.details.total, "number");
  assert.equal(typeof result.details.durationMs, "number");
});

// ---------------------------------------------------------------------------
// Reusability boundary
// ---------------------------------------------------------------------------

test("delegate_tasks: tool name and description domain-neutral", () => {
  const tool = createDelegateTasksTool(buildContext());
  for (const term of ["journey", "wiki", "Journey", "Wiki"]) {
    assert.equal(tool.name.includes(term), false);
    assert.equal(tool.description.includes(term), false);
  }
});

// ---------------------------------------------------------------------------
// Policy defaults
// ---------------------------------------------------------------------------

test("policy defaults: maxConcurrentChildren = 2 and maxBatchTasks = 3 (Phase 1)", () => {
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.maxConcurrentChildren, 2);
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.maxBatchTasks, 3);
});
