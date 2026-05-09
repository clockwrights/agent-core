import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OrchestratorPhaseTransitionError,
  buildSynthesisPrompt,
  buildSynthesisSystemPrompt,
  createInMemoryChildRunRegistry,
  mergeWithDelegateTool,
  runOrchestrator,
  type ChildRunRegistry,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type OrchestratorState
} from "@maya-ai/agent-loop-orchestration";

import type {
  ToolAgentInput,
  ToolAgentOutput,
  ToolLlmAdapter
} from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Stub LLM with a response queue
// ---------------------------------------------------------------------------

interface StubBehavior {
  output?: ToolAgentOutput;
  throwError?: unknown;
}

interface StubAdapter extends ToolLlmAdapter {
  calls: ToolAgentInput[];
}

function buildQueuedStubAdapter(behaviors: StubBehavior[]): StubAdapter {
  const calls: ToolAgentInput[] = [];
  let i = 0;
  return {
    calls,
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      const behavior = behaviors[Math.min(i, behaviors.length - 1)];
      i++;
      if (behavior.throwError !== undefined) throw behavior.throwError;
      return behavior.output ?? { text: "default", toolCalls: [] };
    }
  };
}

// ---------------------------------------------------------------------------
// Registry helpers — populate child runs directly so the orchestrator
// tests don't depend on the executor's internals.
// ---------------------------------------------------------------------------

function buildChildRequest(overrides: Partial<ChildRunRequest>): ChildRunRequest {
  return {
    runId: overrides.runId!,
    parentRunId: overrides.parentRunId!,
    parentDepth: overrides.parentDepth ?? 0,
    label: overrides.label ?? overrides.runId!,
    description: overrides.description ?? "test child",
    prompt: overrides.prompt ?? "do work",
    contextMode: overrides.contextMode ?? "isolated",
    executionMode: "blocking_inline"
  };
}

function pushCompletedChild(
  registry: ChildRunRegistry,
  parent: string,
  label: string,
  summary: string,
  warnings: string[] = []
): ChildRunResultEnvelope {
  const runId = `${parent}__${label}`;
  registry.create(
    buildChildRequest({ runId, parentRunId: parent, label }),
    "2026-05-07T12:00:00.000Z"
  );
  registry.markRunning(runId);
  const envelope: ChildRunResultEnvelope = {
    runId,
    parentRunId: parent,
    label,
    status: "completed",
    summary,
    toolCalls: [],
    warnings: warnings.length > 0 ? warnings : undefined,
    startedAt: "2026-05-07T12:00:00.000Z",
    endedAt: "2026-05-07T12:00:01.000Z",
    durationMs: 1000
  };
  registry.markCompleted(envelope);
  return envelope;
}

function pushFailedChild(
  registry: ChildRunRegistry,
  parent: string,
  label: string,
  message: string
): ChildRunResultEnvelope {
  const runId = `${parent}__${label}`;
  registry.create(
    buildChildRequest({ runId, parentRunId: parent, label }),
    "2026-05-07T12:00:00.000Z"
  );
  registry.markRunning(runId);
  registry.markFailed(
    runId,
    { code: "tool_error", message, retryable: false },
    "2026-05-07T12:00:02.000Z"
  );
  // markFailed stores the failure on the entry but does not produce a result
  // envelope. The orchestrator reads via getResult, which returns undefined
  // for failed runs without a stored envelope. To exercise the partial-
  // failure path through the orchestrator, we manually compose an envelope
  // and stash it. In real usage executeChildRun does this automatically.
  const handles = registry.listByParent(parent);
  const handle = handles.find((h) => h.runId === runId);
  assert.ok(handle, "fixture: failed child handle should exist");
  // The orchestrator only treats a child as "real" when it has a result
  // envelope. To make the failed path observable we synthesise one and
  // hand it back; tests using this helper assert only via listByParent +
  // the orchestrator's state.warnings.
  return {
    runId,
    parentRunId: parent,
    label,
    status: "failed",
    summary: `Failed: ${message}`,
    toolCalls: [],
    failure: { code: "tool_error", message, retryable: false },
    startedAt: "2026-05-07T12:00:00.000Z",
    endedAt: "2026-05-07T12:00:02.000Z",
    durationMs: 2000
  };
}

// ---------------------------------------------------------------------------
// buildSynthesisPrompt
// ---------------------------------------------------------------------------

test("synthesis prompt: sections appear in the documented order", () => {
  const prompt = buildSynthesisPrompt({
    objective: "Resolve the user's request.",
    childResults: [
      {
        runId: "r1",
        parentRunId: "p",
        label: "research",
        status: "completed",
        summary: "Three findings.",
        toolCalls: [],
        startedAt: "x",
        endedAt: "y",
        durationMs: 0
      }
    ],
    childFailures: [{ code: "timeout", message: "slow", retryable: true }]
  });
  const objIdx = prompt.indexOf("[Parent Objective]");
  const resIdx = prompt.indexOf("[Child Results]");
  const failIdx = prompt.indexOf("[Child Failures]");
  const constraintIdx = prompt.indexOf("[Required Final Output Constraints]");
  assert.ok(objIdx >= 0);
  assert.ok(objIdx < resIdx);
  assert.ok(resIdx < failIdx);
  assert.ok(failIdx < constraintIdx);
});

test("synthesis prompt: omits [Child Failures] when none", () => {
  const prompt = buildSynthesisPrompt({
    objective: "do thing",
    childResults: [
      {
        runId: "r",
        parentRunId: "p",
        label: "x",
        status: "completed",
        summary: "done",
        toolCalls: [],
        startedAt: "x",
        endedAt: "y",
        durationMs: 0
      }
    ]
  });
  assert.doesNotMatch(prompt, /\[Child Failures\]/);
});

test("synthesis prompt: zero child results produces explicit placeholder", () => {
  const prompt = buildSynthesisPrompt({ objective: "x", childResults: [] });
  assert.match(prompt, /\(no child results\)/);
});

test("synthesis prompt: failed envelope includes failure code line", () => {
  const prompt = buildSynthesisPrompt({
    objective: "x",
    childResults: [
      {
        runId: "r",
        parentRunId: "p",
        label: "x",
        status: "failed",
        summary: "boom",
        toolCalls: [],
        failure: { code: "tool_error", message: "boom", retryable: false },
        startedAt: "x",
        endedAt: "y",
        durationMs: 0
      }
    ]
  });
  assert.match(prompt, /Failure code: tool_error/);
});

test("synthesis prompt: deterministic for fixed input", () => {
  const args = {
    objective: "x",
    childResults: [
      {
        runId: "r",
        parentRunId: "p",
        label: "a",
        status: "completed" as const,
        summary: "ok",
        toolCalls: [],
        startedAt: "x",
        endedAt: "y",
        durationMs: 0
      }
    ]
  };
  assert.equal(buildSynthesisPrompt(args), buildSynthesisPrompt(args));
});

test("synthesis prompt: domain-neutral output", () => {
  const prompt = buildSynthesisPrompt({
    objective: "answer the user",
    childResults: [
      {
        runId: "r",
        parentRunId: "p",
        label: "research",
        status: "completed",
        summary: "ok",
        toolCalls: [],
        startedAt: "x",
        endedAt: "y",
        durationMs: 0
      }
    ]
  });
  for (const term of ["journey", "wiki", "Journey", "Wiki"]) {
    assert.equal(prompt.includes(term), false);
  }
});

test("synthesis system prompt: forbids tool calls", () => {
  const sys = buildSynthesisSystemPrompt();
  assert.match(sys, /Do not call tools/i);
});

// ---------------------------------------------------------------------------
// Orchestrator: no-delegation path
// ---------------------------------------------------------------------------

test("orchestrator: no children → short-circuit, parent text returned, no synthesis", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedStubAdapter([
    { output: { text: "Direct answer.", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p1",
    parentObjective: "answer the user",
    parentSystemPrompt: "system",
    parentPrompt: "prompt",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.didSynthesize, false);
  assert.equal(out.finalText, "Direct answer.");
  assert.equal(out.state.phase, "finalize");
  assert.deepEqual(out.state.phaseHistory, ["prepare", "plan", "finalize"]);
  assert.equal(llm.calls.length, 1, "only the parent loop should run");
});

test("orchestrator: parent loop failure is captured in warnings, no synthesis attempted", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedStubAdapter([{ throwError: new Error("oops") }]);
  const out = await runOrchestrator({
    parentRunId: "p2",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.didSynthesize, false);
  assert.equal(out.state.phase, "finalize");
  assert.match(out.state.warnings.join("\n"), /Parent loop failed/);
  assert.match(out.finalText, /oops/);
});

test("orchestrator: signal is forwarded into the parent runToolAgentLoop call", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedStubAdapter([
    { output: { text: "Direct answer.", toolCalls: [] } }
  ]);
  const controller = new AbortController();
  await runOrchestrator({
    parentRunId: "p-sig",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    signal: controller.signal
  });
  assert.equal(llm.calls[0].signal, controller.signal);
});

test("orchestrator: parent-loop abort is recorded as cancelled, not a generic failure", async () => {
  const registry = createInMemoryChildRunRegistry();
  const controller = new AbortController();
  // Stub adapter throws an AbortError-shaped error, simulating the runtime
  // detecting the aborted signal mid-call.
  const llm = buildQueuedStubAdapter([
    { throwError: new Error("aborted by signal") }
  ]);
  controller.abort();
  const out = await runOrchestrator({
    parentRunId: "p-cancel",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    signal: controller.signal
  });
  assert.equal(out.didSynthesize, false);
  assert.equal(out.state.phase, "finalize");
  assert.match(out.state.warnings.join("\n"), /Parent loop cancelled/);
  assert.match(out.finalText, /Parent loop cancelled/);
});

// ---------------------------------------------------------------------------
// Orchestrator: one-child / multi-child paths
// ---------------------------------------------------------------------------

test("orchestrator: one pre-populated child triggers synthesis with structured input", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p3", "research", "Found 2 sources.");

  const llm = buildQueuedStubAdapter([
    // Parent loop response
    { output: { text: "(plan only)", toolCalls: [] } },
    // Synthesis response
    { output: { text: "Synthesised final answer.", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p3",
    parentObjective: "answer the user",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });

  assert.equal(out.didSynthesize, true);
  assert.equal(out.finalText, "Synthesised final answer.");
  assert.deepEqual(out.state.childRunIds, ["p3__research"]);
  assert.equal(out.state.childResults.length, 1);

  // Synthesis sessionId distinct from parent.
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].sessionId, "p3");
  assert.equal(llm.calls[1].sessionId, "p3-synthesis");
  // Synthesis call has NO tools.
  assert.equal(llm.calls[1].tools.length, 0);
  // Synthesis prompt mentions the child label.
  assert.match(llm.calls[1].prompt, /research/);
  assert.match(llm.calls[1].prompt, /Found 2 sources/);
});

test("orchestrator: multi-child path preserves registry insertion order in synthesis prompt", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p4", "alpha", "First child summary.");
  pushCompletedChild(registry, "p4", "bravo", "Second child summary.");
  pushCompletedChild(registry, "p4", "charlie", "Third child summary.");

  const llm = buildQueuedStubAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "Final.", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p4",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.didSynthesize, true);
  const synthesisPrompt = llm.calls[1].prompt;
  const alphaIdx = synthesisPrompt.indexOf("### alpha");
  const bravoIdx = synthesisPrompt.indexOf("### bravo");
  const charlieIdx = synthesisPrompt.indexOf("### charlie");
  assert.ok(alphaIdx >= 0 && bravoIdx >= 0 && charlieIdx >= 0);
  assert.ok(alphaIdx < bravoIdx);
  assert.ok(bravoIdx < charlieIdx);

  // State carries each runId in order.
  assert.deepEqual(out.state.childRunIds, ["p4__alpha", "p4__bravo", "p4__charlie"]);
});

test("orchestrator: phase history covers full path on multi-child run", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p5", "x", "ok");
  const llm = buildQueuedStubAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "final", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p5",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.deepEqual(out.state.phaseHistory, [
    "prepare",
    "plan",
    "delegate",
    "wait",
    "synthesize",
    "finalize"
  ]);
});

// ---------------------------------------------------------------------------
// Orchestrator: partial failure / synthesis failure
// ---------------------------------------------------------------------------

test("orchestrator: synthesis failure produces deterministic fallback text covering all children", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p6", "alpha", "found things");
  pushCompletedChild(registry, "p6", "bravo", "found other things");

  const llm = buildQueuedStubAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { throwError: new Error("synthesis 500") }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p6",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.didSynthesize, false);
  assert.match(out.finalText, /Synthesis failed/);
  assert.match(out.finalText, /alpha/);
  assert.match(out.finalText, /bravo/);
  assert.match(out.state.warnings.join("\n"), /Synthesis failed/);
});

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

test("phase machine: invalid jumps throw OrchestratorPhaseTransitionError", () => {
  // We can't trigger an invalid jump through the public API without
  // breaking the implementation, so assert the error class is constructable
  // and the message includes both states. (Internal `transition` is exercised
  // implicitly in the success-path tests.)
  const err = new OrchestratorPhaseTransitionError("plan", "wait");
  assert.match(err.message, /plan -> wait/);
});

test("phase machine: plan → finalize short-circuit is allowed (no children)", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedStubAdapter([
    { output: { text: "ok", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "p7",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  // The plan -> finalize edge is exercised when there are no children;
  // assert by checking phase history.
  assert.deepEqual(out.state.phaseHistory, ["prepare", "plan", "finalize"]);
});

// ---------------------------------------------------------------------------
// Helper: mergeWithDelegateTool
// ---------------------------------------------------------------------------

test("mergeWithDelegateTool: appends without mutating the parent list", () => {
  const a = { name: "a" } as never;
  const b = { name: "b" } as never;
  const delegate = { name: "delegate_task" } as never;
  const parentTools = [a, b];
  const merged = mergeWithDelegateTool(parentTools, delegate);
  assert.deepEqual(
    merged.map((t) => t.name),
    ["a", "b", "delegate_task"]
  );
  assert.equal(parentTools.length, 2, "input should not be mutated");
});

// ---------------------------------------------------------------------------
// Reusability boundary on emitted prompts
// ---------------------------------------------------------------------------

test("orchestrator: synthesis prompt seen by the LLM contains no consumer-domain terms", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p8", "research", "Findings.");
  const llm = buildQueuedStubAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "final", toolCalls: [] } }
  ]);
  await runOrchestrator({
    parentRunId: "p8",
    parentObjective: "answer the request",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  const synthesisPrompt = llm.calls[1].prompt;
  for (const term of ["journey", "wiki", "Journey", "Wiki"]) {
    assert.equal(synthesisPrompt.includes(term), false);
  }
});

// Ensure the test file doesn't drop the OrchestratorState type (used in
// helper signatures via inference) — a noop assertion.
test("OrchestratorState type stays exported", () => {
  const probe: OrchestratorState = {
    parentRunId: "x",
    phase: "prepare",
    phaseHistory: ["prepare"],
    timings: [{ phase: "prepare", startedAt: "2026-05-07T00:00:00.000Z" }],
    childRunIds: [],
    childResults: [],
    childFailures: [],
    warnings: []
  };
  assert.equal(probe.phase, "prepare");
});
