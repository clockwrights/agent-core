import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELEGATE_TASK_TOOL_NAME,
  createDelegateTaskTool,
  createDelegateTaskToolDefinition,
  createInMemoryChildRunRegistry,
  delegateTaskParameters,
  executeDelegateTask,
  type DelegateTaskInput,
  type DelegateTaskToolResult,
  type DelegateToolContext
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

interface StubAdapter extends ToolLlmAdapter {
  calls: ToolAgentInput[];
}

function buildStubAdapter(behavior: {
  output?: ToolAgentOutput;
  delayMs?: number;
  throwError?: unknown;
} = {}): StubAdapter {
  const calls: ToolAgentInput[] = [];
  return {
    calls,
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      if (behavior.delayMs && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
      if (behavior.throwError !== undefined) throw behavior.throwError;
      return behavior.output ?? { text: "Done.", toolCalls: [] };
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

function fixedClock(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

interface ContextOverrides extends Partial<DelegateToolContext> {}

function buildContext(overrides: ContextOverrides = {}): DelegateToolContext {
  return {
    parentRunId: overrides.parentRunId ?? "parent-1",
    parentDepth: overrides.parentDepth ?? 0,
    llm: overrides.llm ?? buildStubAdapter(),
    registry: overrides.registry ?? createInMemoryChildRunRegistry(),
    policy: overrides.policy,
    presetOverrides: overrides.presetOverrides,
    onProgress: overrides.onProgress,
    clock:
      overrides.clock ??
      fixedClock([
        "2026-05-07T11:00:00.000Z",
        "2026-05-07T11:00:01.000Z",
        "2026-05-07T11:00:02.000Z"
      ]),
    runtimeFactory: overrides.runtimeFactory ?? (async () => emptyRuntime()),
    buildSystemPrompt: overrides.buildSystemPrompt,
    buildTools: overrides.buildTools,
    signal: overrides.signal
  };
}

const VALID_INPUT: DelegateTaskInput = {
  label: "research-pass",
  description: "Investigate X.",
  prompt: "Read X and report back."
};

function parsePayload(result: DelegateTaskToolResult): {
  runId: string;
  label: string;
  status: string;
  summary: string;
  warnings: string[];
  failureCode?: string;
} {
  const text = result.content[0]?.text;
  assert.ok(text, "tool result must have text content");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tool registration shape
// ---------------------------------------------------------------------------

test("tool: LLM-visible name is exactly 'delegate_task'", () => {
  const tool = createDelegateTaskTool(buildContext());
  assert.equal(tool.name, "delegate_task");
  assert.equal(DELEGATE_TASK_TOOL_NAME, "delegate_task");
});

test("tool: registered definition is source=system, risk=read", () => {
  const definition = createDelegateTaskToolDefinition(buildContext());
  assert.equal(definition.metadata.source, "system");
  assert.equal(definition.metadata.risk, "read");
  assert.equal(definition.tool.name, "delegate_task");
});

test("tool: typebox schema rejects missing required fields", () => {
  // Schema is exported so consumers can validate before calling.
  const props = (delegateTaskParameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.ok(props.label);
  assert.ok(props.description);
  assert.ok(props.prompt);
  // Optional fields:
  assert.ok(props.contextMode);
  assert.ok(props.maxTokens);
  assert.ok(props.timeoutMs);
});

// ---------------------------------------------------------------------------
// Successful delegation
// ---------------------------------------------------------------------------

test("delegation: signal from context is forwarded into the child's LLM call", async () => {
  const llm = buildStubAdapter();
  const controller = new AbortController();
  await executeDelegateTask(
    VALID_INPUT,
    buildContext({ llm, signal: controller.signal })
  );
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].signal, controller.signal);
});

test("delegation: pre-aborted signal yields a cancelled payload without calling the LLM", async () => {
  const llm = buildStubAdapter();
  const registry = createInMemoryChildRunRegistry();
  const controller = new AbortController();
  controller.abort();
  const result = await executeDelegateTask(
    VALID_INPUT,
    buildContext({ llm, registry, signal: controller.signal })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.failureCode, "cancelled");
  assert.equal(llm.calls.length, 0);
  // Pre-flight cancel must not pollute the registry.
  assert.equal(registry.listByParent("parent-1").length, 0);
});

test("delegation: success path returns a completed JSON payload to the LLM", async () => {
  const llm = buildStubAdapter({
    output: { text: "Found three things.", toolCalls: [] }
  });
  const registry = createInMemoryChildRunRegistry();
  const result = await executeDelegateTask(
    VALID_INPUT,
    buildContext({ llm, registry })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.label, "research-pass");
  assert.equal(payload.summary, "Found three things.");
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.failureCode, undefined);

  // Registry sees the run.
  const handles = registry.listByParent("parent-1");
  assert.equal(handles.length, 1);
  assert.equal(handles[0].status, "completed");
  // runId is unknown to the caller (uuid'd inside the tool); verify it's
  // present in the returned payload and the registry agrees.
  assert.equal(handles[0].runId, payload.runId);
});

test("delegation: contextMode defaults to policy.defaultContextMode (isolated)", async () => {
  const registry = createInMemoryChildRunRegistry();
  await executeDelegateTask(VALID_INPUT, buildContext({ registry }));
  const handle = registry.listByParent("parent-1")[0];
  const request = registry.getRequest(handle.runId);
  assert.equal(request?.contextMode, "isolated");
});

test("delegation: contextMode='fork' from the LLM is honoured", async () => {
  const registry = createInMemoryChildRunRegistry();
  await executeDelegateTask(
    { ...VALID_INPUT, contextMode: "fork" },
    buildContext({ registry })
  );
  const handle = registry.listByParent("parent-1")[0];
  const request = registry.getRequest(handle.runId);
  assert.equal(request?.contextMode, "fork");
});

test("delegation: timeoutMs falls back to policy.defaultChildTimeoutMs when absent", async () => {
  const registry = createInMemoryChildRunRegistry();
  await executeDelegateTask(VALID_INPUT, buildContext({ registry }));
  const handle = registry.listByParent("parent-1")[0];
  const request = registry.getRequest(handle.runId);
  assert.equal(request?.timeoutMs, 120_000); // DEFAULT_ORCHESTRATION_POLICY.defaultChildTimeoutMs
});

test("delegation: parentRunId and parentDepth come from context, never from input", async () => {
  const registry = createInMemoryChildRunRegistry();
  // Even if a malicious LLM crammed extra fields into params, the request
  // shape comes only from `toChildRunRequest` which reads context, not input.
  await executeDelegateTask(
    VALID_INPUT,
    buildContext({ parentRunId: "real-parent", parentDepth: 0, registry })
  );
  const handle = registry.listByParent("real-parent")[0];
  const request = registry.getRequest(handle.runId);
  assert.equal(request?.parentRunId, "real-parent");
  assert.equal(request?.parentDepth, 0);
  assert.equal(request?.executionMode, "blocking_inline");
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

test("validation: empty label rejected with validation_error and no registry pollution", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildStubAdapter();
  const result = await executeDelegateTask(
    { ...VALID_INPUT, label: "" },
    buildContext({ registry, llm })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.failureCode, "validation_error");
  // No registry entry, no LLM call.
  assert.deepEqual(registry.listByParent("parent-1"), []);
  assert.equal(llm.calls.length, 0);
});

test("validation: empty prompt rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, prompt: "" },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

test("validation: empty description rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, description: "" },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

test("validation: oversized label rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, label: "x".repeat(101) },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

test("validation: oversized prompt rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, prompt: "x".repeat(20_000) },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

test("validation: bad contextMode value rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, contextMode: "weird" as unknown as DelegateTaskInput["contextMode"] },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

test("validation: zero / negative maxTokens rejected", async () => {
  const zero = await executeDelegateTask(
    { ...VALID_INPUT, maxTokens: 0 },
    buildContext()
  );
  const neg = await executeDelegateTask(
    { ...VALID_INPUT, maxTokens: -1 },
    buildContext()
  );
  assert.equal(parsePayload(zero).failureCode, "validation_error");
  assert.equal(parsePayload(neg).failureCode, "validation_error");
});

test("validation: maxTokens above policy.maxChildTokens rejected", async () => {
  const result = await executeDelegateTask(
    { ...VALID_INPUT, maxTokens: 999_999 },
    buildContext()
  );
  assert.equal(parsePayload(result).failureCode, "validation_error");
});

// ---------------------------------------------------------------------------
// Depth-gating safety net
// ---------------------------------------------------------------------------

test("depth gate: parentDepth >= policy.maxDepth rejected before any LLM call", async () => {
  const llm = buildStubAdapter();
  const registry = createInMemoryChildRunRegistry();
  const result = await executeDelegateTask(
    VALID_INPUT,
    buildContext({ parentDepth: 1, llm, registry })
    // policy.maxDepth defaults to 1 -> 1 >= 1 fails
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.failureCode, "validation_error");
  assert.match(payload.summary, /maxDepth/);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(registry.listByParent("parent-1"), []);
});

test("active gate: delegate_task rejects when activeCount >= maxActiveChildrenPerParent", async () => {
  const llm = buildStubAdapter();
  const registry = createInMemoryChildRunRegistry();
  // Seed three already-active children for the parent so activeCount == 3
  // (the default `maxActiveChildrenPerParent`). The next delegate_task must
  // be rejected without spawning a fourth child.
  for (let i = 0; i < 3; i++) {
    const seedId = `seed-${i}`;
    registry.create(
      {
        runId: seedId,
        parentRunId: "parent-1",
        parentDepth: 0,
        label: `seed-${i}`,
        description: "seed",
        prompt: "seed",
        contextMode: "isolated",
        executionMode: "blocking_inline"
      },
      "2026-05-08T10:00:00.000Z"
    );
    registry.markRunning(seedId);
  }

  const result = await executeDelegateTask(
    VALID_INPUT,
    buildContext({ llm, registry })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.failureCode, "validation_error");
  assert.match(payload.summary, /maxActiveChildrenPerParent/);
  assert.equal(llm.calls.length, 0);
  // Only the three seeded children — no fourth was created.
  assert.equal(registry.listByParent("parent-1").length, 3);
});

// ---------------------------------------------------------------------------
// Runtime failure surfaces cleanly
// ---------------------------------------------------------------------------

test("runtime failure: LLM error is surfaced as a failed payload (status=failed)", async () => {
  const llm = buildStubAdapter({ throwError: new Error("upstream 500") });
  const registry = createInMemoryChildRunRegistry();
  const result = await executeDelegateTask(
    VALID_INPUT,
    buildContext({ llm, registry })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.failureCode, "unknown");
  assert.match(payload.summary, /upstream 500/);
  // Registry recorded the lifecycle.
  const handle = registry.listByParent("parent-1")[0];
  assert.equal(handle.status, "failed");
});

test("runtime failure: timeout surfaces status=timed_out with failureCode=timeout", async () => {
  const llm = buildStubAdapter({ delayMs: 50 });
  const result = await executeDelegateTask(
    { ...VALID_INPUT, timeoutMs: 5 },
    buildContext({ llm })
  );
  const payload = parsePayload(result);
  assert.equal(payload.status, "timed_out");
  assert.equal(payload.failureCode, "timeout");
});

// ---------------------------------------------------------------------------
// Tool result shape contract
// ---------------------------------------------------------------------------

test("result shape: content has a single text item with parseable JSON", async () => {
  const result = await executeDelegateTask(VALID_INPUT, buildContext());
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  // Must be valid JSON.
  assert.doesNotThrow(() => JSON.parse(result.content[0].text));
});

test("result shape: details exposes runId/label/status/durationMs to the harness", async () => {
  const result = await executeDelegateTask(VALID_INPUT, buildContext());
  assert.equal(typeof result.details.runId, "string");
  assert.equal(result.details.label, "research-pass");
  assert.equal(result.details.status, "completed");
  assert.equal(typeof result.details.durationMs, "number");
});

// ---------------------------------------------------------------------------
// Reusability boundary on the tool surface
// ---------------------------------------------------------------------------

test("reusability: tool name and description contain no consumer-domain terms", () => {
  const tool = createDelegateTaskTool(buildContext());
  for (const term of ["journey", "wiki", "Journey", "Wiki"]) {
    assert.equal(tool.name.includes(term), false);
    assert.equal(tool.description.includes(term), false);
  }
});
