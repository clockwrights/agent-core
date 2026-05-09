import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryChildRunRegistry,
  executeChildRun,
  type ChildRunRequest,
  type ExecuteChildRunInput
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

interface StubBehavior {
  output?: ToolAgentOutput;
  /** When set, the stub waits this many ms before resolving. Used for timeout tests. */
  delayMs?: number;
  /** When set, the stub rejects with this error. */
  throwError?: unknown;
}

interface StubAdapter extends ToolLlmAdapter {
  calls: ToolAgentInput[];
}

function buildStubAdapter(behavior: StubBehavior = {}): StubAdapter {
  const calls: ToolAgentInput[] = [];
  return {
    calls,
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      if (behavior.delayMs && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
      if (behavior.throwError !== undefined) {
        throw behavior.throwError;
      }
      return (
        behavior.output ?? {
          text: "Default stub answer.",
          toolCalls: []
        }
      );
    }
  };
}

function fixedClock(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function buildRequest(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    runId: overrides.runId ?? "child-1",
    parentRunId: overrides.parentRunId ?? "parent-1",
    parentDepth: overrides.parentDepth ?? 0,
    label: overrides.label ?? "research-pass",
    description: overrides.description ?? "Investigate X.",
    prompt: overrides.prompt ?? "Read X and report Y.",
    contextMode: overrides.contextMode ?? "isolated",
    executionMode: overrides.executionMode ?? "blocking_inline",
    profile: overrides.profile,
    maxTokens: overrides.maxTokens,
    timeoutMs: overrides.timeoutMs,
    allowWriteTools: overrides.allowWriteTools,
    idempotencyKey: overrides.idempotencyKey,
    metadata: overrides.metadata
  };
}

interface RuntimeStub {
  context: AgentRuntimeContext;
  disposeCalls: number;
}

function buildRuntimeStub(): RuntimeStub {
  const stub: RuntimeStub = {
    disposeCalls: 0,
    context: {
      toolDefinitions: [],
      toolPolicy: {
        enabled: true,
        sources: { domain: false, mcp: false, memory: false, system: false },
        allow: [],
        deny: []
      },
      skillsPrompt: "",
      memoryPrompt: "",
      diagnostics: [],
      dispose: async () => {
        stub.disposeCalls++;
      }
    }
  };
  return stub;
}

function baseInput(overrides: Partial<ExecuteChildRunInput> = {}): ExecuteChildRunInput {
  const registry = overrides.registry ?? createInMemoryChildRunRegistry();
  const llm = overrides.llm ?? buildStubAdapter();
  const runtime = buildRuntimeStub();
  return {
    request: overrides.request ?? buildRequest(),
    llm,
    registry,
    policy: overrides.policy,
    presetOverrides: overrides.presetOverrides,
    onProgress: overrides.onProgress,
    clock:
      overrides.clock ??
      fixedClock([
        "2026-05-07T10:00:00.000Z",
        "2026-05-07T10:00:01.000Z",
        "2026-05-07T10:00:02.000Z"
      ]),
    runtimeFactory: overrides.runtimeFactory ?? (async () => runtime.context),
    buildSystemPrompt: overrides.buildSystemPrompt,
    buildTools: overrides.buildTools,
    signal: overrides.signal
  };
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test("executor: successful child run produces a normalised completed envelope", async () => {
  const llm = buildStubAdapter({
    output: {
      text: "Found three relevant facts.\n\nDetails follow.",
      toolCalls: [{ name: "memory_search", args: {}, isError: false }]
    }
  });
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun(
    baseInput({
      llm,
      registry,
      request: buildRequest({ runId: "ok-1" })
    })
  );

  assert.equal(envelope.status, "completed");
  assert.equal(envelope.runId, "ok-1");
  assert.equal(envelope.parentRunId, "parent-1");
  assert.equal(envelope.label, "research-pass");
  assert.equal(envelope.summary, "Found three relevant facts.");
  assert.equal(envelope.text, "Found three relevant facts.\n\nDetails follow.");
  assert.deepEqual(envelope.toolCalls, [{ name: "memory_search", isError: false }]);
  assert.equal(envelope.startedAt, "2026-05-07T10:00:00.000Z");
  assert.equal(envelope.endedAt, "2026-05-07T10:00:01.000Z");
  assert.equal(envelope.durationMs, 1000);
  assert.equal(envelope.failure, undefined);
  assert.equal(envelope.proposedChanges, undefined); // reserved in Phase 1

  // Registry sees the full lifecycle.
  const handle = registry.get("ok-1");
  assert.equal(handle?.status, "completed");
  assert.deepEqual(registry.getResult("ok-1"), envelope);
});

test("executor: empty LLM output still produces a completed envelope with placeholder summary", async () => {
  const llm = buildStubAdapter({ output: { text: "", toolCalls: [] } });
  const envelope = await executeChildRun(baseInput({ llm }));
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.summary, "(no output)");
  assert.equal(envelope.text, undefined);
});

test("executor: undefined LLM output is tolerated", async () => {
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true }),
    async runToolAgent() {
      return undefined;
    }
  };
  const envelope = await executeChildRun(baseInput({ llm }));
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.summary, "(no output)");
  assert.deepEqual(envelope.toolCalls, []);
});

// ---------------------------------------------------------------------------
// Failure / timeout / validation paths
// ---------------------------------------------------------------------------

test("executor: LLM error becomes a typed failure envelope (status=failed)", async () => {
  const llm = buildStubAdapter({ throwError: new Error("upstream 500") });
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun(
    baseInput({ llm, registry, request: buildRequest({ runId: "fail-1" }) })
  );
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.failure?.code, "unknown");
  assert.equal(envelope.failure?.message, "upstream 500");
  assert.equal(registry.get("fail-1")?.status, "failed");
});

test("executor: per-child timeout produces a timed_out envelope", async () => {
  const llm = buildStubAdapter({ delayMs: 50 });
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun(
    baseInput({
      llm,
      registry,
      request: buildRequest({ runId: "to-1", timeoutMs: 10 })
    })
  );
  assert.equal(envelope.status, "timed_out");
  assert.equal(envelope.failure?.code, "timeout");
  assert.match(envelope.failure?.message ?? "", /10ms/);
  assert.equal(registry.get("to-1")?.status, "timed_out");
});

test("executor: prompt longer than maxChildPromptChars is rejected without registry pollution", async () => {
  const registry = createInMemoryChildRunRegistry();
  const huge = "x".repeat(20_000);
  const envelope = await executeChildRun(
    baseInput({
      registry,
      request: buildRequest({ runId: "big", prompt: huge })
    })
  );
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.failure?.code, "validation_error");
  // Pre-registry validation: the registry MUST NOT have an entry for this run.
  assert.equal(registry.get("big"), undefined);
});

test("executor: parentDepth >= maxDepth is rejected (depth-gating safety net)", async () => {
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun(
    baseInput({
      registry,
      request: buildRequest({ runId: "deep", parentDepth: 1 })
      // policy.maxDepth defaults to 1 -> 1 >= 1 fails
    })
  );
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.failure?.code, "validation_error");
  assert.match(envelope.failure?.message ?? "", /maxDepth/);
  assert.equal(registry.get("deep"), undefined);
});

test("executor: empty label/prompt rejected at validation", async () => {
  const empty = await executeChildRun(
    baseInput({ request: buildRequest({ runId: "e1", label: "" }) })
  );
  assert.equal(empty.status, "failed");
  assert.equal(empty.failure?.code, "validation_error");
});

// ---------------------------------------------------------------------------
// Lifecycle invariants
// ---------------------------------------------------------------------------

test("executor: runtime is disposed after a successful run", async () => {
  const runtime = buildRuntimeStub();
  await executeChildRun(
    baseInput({ runtimeFactory: async () => runtime.context })
  );
  assert.equal(runtime.disposeCalls, 1);
});

test("executor: runtime is disposed after a failed run", async () => {
  const runtime = buildRuntimeStub();
  const llm = buildStubAdapter({ throwError: new Error("nope") });
  await executeChildRun(
    baseInput({ llm, runtimeFactory: async () => runtime.context })
  );
  assert.equal(runtime.disposeCalls, 1);
});

test("executor: runtime is disposed after a timeout", async () => {
  const runtime = buildRuntimeStub();
  const llm = buildStubAdapter({ delayMs: 50 });
  await executeChildRun(
    baseInput({
      llm,
      request: buildRequest({ timeoutMs: 5 }),
      runtimeFactory: async () => runtime.context
    })
  );
  assert.equal(runtime.disposeCalls, 1);
});

test("executor: runtime factory failure leaves no run stuck in 'running'", async () => {
  const registry = createInMemoryChildRunRegistry();
  const envelope = await executeChildRun(
    baseInput({
      registry,
      request: buildRequest({ runId: "rf" }),
      runtimeFactory: async () => {
        throw new Error("runtime boom");
      }
    })
  );
  assert.equal(envelope.status, "failed");
  // The run was created (pending) and immediately marked failed.
  assert.equal(registry.get("rf")?.status, "failed");
});

test("executor: invalid request never reaches the LLM", async () => {
  const llm = buildStubAdapter();
  await executeChildRun(
    baseInput({ llm, request: buildRequest({ prompt: "" }) })
  );
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Tool / runtime threading
// ---------------------------------------------------------------------------

test("executor: child tools come from buildTools(runtime), not from the parent", async () => {
  const llm = buildStubAdapter();
  const fakeTool = {
    name: "fake_child_tool",
    label: "Fake",
    description: "fake",
    parameters: { type: "object", properties: {} } as never,
    executionMode: "sequential" as const,
    execute: async () => ({ text: "" })
  } as unknown as Parameters<NonNullable<ExecuteChildRunInput["buildTools"]>>[0]["toolDefinitions"][number]["tool"];

  await executeChildRun(
    baseInput({
      llm,
      buildTools: () => [fakeTool]
    })
  );
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].tools.length, 1);
  assert.equal(llm.calls[0].tools[0].name, "fake_child_tool");
});

test("executor: onProgress receives lifecycle messages tagged with the child label", async () => {
  const messages: string[] = [];
  await executeChildRun(
    baseInput({
      onProgress: (msg) => messages.push(msg),
      request: buildRequest({ label: "alpha" })
    })
  );
  assert.ok(messages.some((m) => m.startsWith("[child:alpha]")), `messages: ${messages.join(", ")}`);
  assert.ok(messages.some((m) => /completed in \d+ms/.test(m)));
});

test("executor: sessionId passed to the LLM equals the child runId", async () => {
  const llm = buildStubAdapter();
  await executeChildRun(
    baseInput({ llm, request: buildRequest({ runId: "sess-7" }) })
  );
  assert.equal(llm.calls[0].sessionId, "sess-7");
});

test("executor: maxTokens override flows through to the LLM call", async () => {
  const llm = buildStubAdapter();
  await executeChildRun(
    baseInput({
      llm,
      request: buildRequest({ maxTokens: 512 })
    })
  );
  assert.equal(llm.calls[0].maxTokens, 512);
});

// ---------------------------------------------------------------------------
// Cancellation paths (Stage 10 — AbortSignal end-to-end)
// ---------------------------------------------------------------------------

test("executor: pre-aborted signal returns a cancelled envelope and never calls the LLM", async () => {
  const llm = buildStubAdapter();
  const registry = createInMemoryChildRunRegistry();
  const controller = new AbortController();
  controller.abort();

  const envelope = await executeChildRun(
    baseInput({
      llm,
      registry,
      request: buildRequest({ runId: "pre-abort" }),
      signal: controller.signal
    })
  );

  assert.equal(envelope.status, "cancelled");
  assert.equal(envelope.failure?.code, "cancelled");
  assert.equal(llm.calls.length, 0);
  // Pre-flight cancel must NOT touch the registry — same invariant as
  // pre-registry validation rejections.
  assert.equal(registry.get("pre-abort"), undefined);
});

test("executor: signal aborted mid-call produces a cancelled envelope and disposes the runtime", async () => {
  const llm = buildStubAdapter({ delayMs: 200 });
  const runtime = buildRuntimeStub();
  const registry = createInMemoryChildRunRegistry();
  const controller = new AbortController();

  const envelopePromise = executeChildRun(
    baseInput({
      llm,
      registry,
      runtimeFactory: async () => runtime.context,
      request: buildRequest({ runId: "mid-abort", timeoutMs: 5_000 }),
      signal: controller.signal
    })
  );

  // Abort after the LLM call has started.
  setTimeout(() => controller.abort(), 10);

  const envelope = await envelopePromise;
  assert.equal(envelope.status, "cancelled");
  assert.equal(envelope.failure?.code, "cancelled");
  assert.equal(registry.get("mid-abort")?.status, "cancelled");
  assert.equal(runtime.disposeCalls, 1);
});

test("executor: signal forwarded into runToolAgentLoop's input", async () => {
  const llm = buildStubAdapter();
  const controller = new AbortController();
  await executeChildRun(
    baseInput({
      llm,
      request: buildRequest({ runId: "fwd-1" }),
      signal: controller.signal
    })
  );
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].signal, controller.signal);
});

// ---------------------------------------------------------------------------
// Stage 13 — structured completion metrics
// ---------------------------------------------------------------------------

test("executor: completion message includes structured tool/error/char counters", async () => {
  const llm = buildStubAdapter({
    output: {
      text: "twelve chars",
      toolCalls: [
        { name: "read_file", args: {}, isError: false },
        { name: "search_files", args: {}, isError: false },
        { name: "write_file", args: {}, isError: true }
      ]
    }
  });
  const messages: string[] = [];
  await executeChildRun(
    baseInput({
      llm,
      onProgress: (m) => messages.push(m),
      request: buildRequest({ label: "alpha" })
    })
  );
  const completion = messages.find((m) => /completed in/.test(m));
  assert.ok(completion, `expected a completion message; got: ${messages.join(" | ")}`);
  // 12 chars in "twelve chars", 3 tool calls (1 error).
  assert.match(completion, /\[child:alpha\]/);
  assert.match(completion, /tools=3/);
  assert.match(completion, /errors=1/);
  assert.match(completion, /chars=12/);
});

test("executor: completion metrics are all zero when output is empty", async () => {
  const llm = buildStubAdapter({ output: { text: "", toolCalls: [] } });
  const messages: string[] = [];
  await executeChildRun(
    baseInput({
      llm,
      onProgress: (m) => messages.push(m)
    })
  );
  const completion = messages.find((m) => /completed in/.test(m));
  assert.ok(completion);
  assert.match(completion, /tools=0, errors=0, chars=0/);
});

test("executor: failed runs do not emit the structured-metrics line", async () => {
  // The completion line is success-only; failure paths still emit
  // `failed: …` / `timed out after …` so observers can distinguish.
  const llm = buildStubAdapter({ throwError: new Error("boom") });
  const messages: string[] = [];
  await executeChildRun(
    baseInput({
      llm,
      onProgress: (m) => messages.push(m)
    })
  );
  assert.ok(!messages.some((m) => /completed in/.test(m)));
  assert.ok(messages.some((m) => /failed: boom/.test(m)));
});

test("executor: timeout still wins when it fires before abort", async () => {
  const llm = buildStubAdapter({ delayMs: 100 });
  const registry = createInMemoryChildRunRegistry();
  const controller = new AbortController();

  // Timeout is 5ms; abort is scheduled for 50ms — timeout must win.
  const envelopePromise = executeChildRun(
    baseInput({
      llm,
      registry,
      request: buildRequest({ runId: "to-vs-cancel", timeoutMs: 5 }),
      signal: controller.signal
    })
  );
  setTimeout(() => controller.abort(), 50);

  const envelope = await envelopePromise;
  assert.equal(envelope.status, "timed_out");
  assert.equal(envelope.failure?.code, "timeout");
  // Only one terminal status reached the registry.
  assert.equal(registry.get("to-vs-cancel")?.status, "timed_out");
});
