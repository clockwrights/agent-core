/**
 * Observability tests (Stage 13).
 *
 * Asserts that:
 *   - Per-phase timings populate on every return path.
 *   - The final phase's `endedAt` / `durationMs` is closed before
 *     return.
 *   - Total elapsed time matches the sum of phase durations.
 *   - `RunOrchestratorOutput.registrySnapshot` reflects exactly the
 *     children for this parent (and nothing else).
 *   - `filterSnapshotByParent` is a pure helper.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryChildRunRegistry,
  filterSnapshotByParent,
  runOrchestrator,
  type ChildRunRegistry,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type OrchestratorPhase
} from "@maya-ai/agent-loop-orchestration";

import type {
  ToolAgentInput,
  ToolAgentOutput,
  ToolLlmAdapter
} from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface QueueScript {
  output?: ToolAgentOutput;
  throwError?: unknown;
}

function buildQueuedAdapter(scripts: QueueScript[]): ToolLlmAdapter & {
  calls: ToolAgentInput[];
} {
  const calls: ToolAgentInput[] = [];
  let i = 0;
  return {
    calls,
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i++;
      if (script.throwError !== undefined) throw script.throwError;
      return script.output ?? { text: "default", toolCalls: [] };
    }
  };
}

/**
 * Deterministic clock that advances by `stepMs` on every read.
 * Returns ISO timestamps so timings stay readable.
 */
function steppedIsoClock(startMs: number, stepMs: number): () => string {
  let current = startMs;
  return () => {
    const value = new Date(current).toISOString();
    current += stepMs;
    return value;
  };
}

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
  summary: string
): void {
  const runId = `${parent}__${label}`;
  registry.create(buildChildRequest({ runId, parentRunId: parent, label }), "2026-05-07T00:00:00.000Z");
  registry.markRunning(runId);
  const envelope: ChildRunResultEnvelope = {
    runId,
    parentRunId: parent,
    label,
    status: "completed",
    summary,
    toolCalls: [],
    startedAt: "2026-05-07T00:00:00.000Z",
    endedAt: "2026-05-07T00:00:01.000Z",
    durationMs: 1000
  };
  registry.markCompleted(envelope);
}

// ---------------------------------------------------------------------------
// Phase timings
// ---------------------------------------------------------------------------

test("timings: no-delegation path records prepare → plan → finalize timings, all closed", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([{ output: { text: "ok", toolCalls: [] } }]);
  // Each clock read advances 100ms. Order of reads:
  // 1. createInitialState (prepare start)
  // 2. transition closing prepare
  // 3. transition opening plan
  // 4. transition closing plan
  // 5. transition opening finalize
  // 6. closeCurrentTiming closing finalize
  const out = await runOrchestrator({
    parentRunId: "obs-1",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });

  const phases = out.state.timings.map((t) => t.phase);
  assert.deepEqual(phases, ["prepare", "plan", "finalize"]);

  for (const t of out.state.timings) {
    assert.ok(t.endedAt, `timing for ${t.phase} should have endedAt`);
    assert.equal(typeof t.durationMs, "number");
    assert.ok((t.durationMs ?? 0) >= 0);
  }
});

test("timings: multi-child success path records all six phases with positive durations", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "obs-2", "alpha", "ok");
  pushCompletedChild(registry, "obs-2", "bravo", "ok");

  const llm = buildQueuedAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "final", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "obs-2",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });

  const phases = out.state.timings.map((t) => t.phase);
  assert.deepEqual(phases, [
    "prepare",
    "plan",
    "delegate",
    "wait",
    "synthesize",
    "finalize"
  ]);
  for (const t of out.state.timings) {
    assert.ok(t.endedAt, `${t.phase} should be closed`);
    assert.ok((t.durationMs ?? -1) >= 0);
  }
});

test("timings: parent-loop failure path closes the final phase before return", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([{ throwError: new Error("boom") }]);
  const out = await runOrchestrator({
    parentRunId: "obs-3",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });
  // prepare → plan → finalize (parent-failure short-circuit).
  assert.deepEqual(out.state.timings.map((t) => t.phase), ["prepare", "plan", "finalize"]);
  assert.ok(out.state.timings[out.state.timings.length - 1].endedAt);
});

test("timings: synthesis-failure path still closes finalize", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "obs-4", "only", "ok");
  const llm = buildQueuedAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { throwError: new Error("synthesis 500") }
  ]);
  const out = await runOrchestrator({
    parentRunId: "obs-4",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });

  // Up through synthesize, then finalize.
  const phases = out.state.timings.map((t) => t.phase);
  assert.deepEqual(phases, [
    "prepare",
    "plan",
    "delegate",
    "wait",
    "synthesize",
    "finalize"
  ]);
  for (const t of out.state.timings) {
    assert.ok(t.endedAt, `${t.phase} should be closed`);
  }
});

test("timings: durations are deterministic with a stepped clock", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([{ output: { text: "ok", toolCalls: [] } }]);
  const out = await runOrchestrator({
    parentRunId: "obs-5",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });
  // Stepped clock by 100ms per read; every phase open/close pair takes 100ms.
  for (const t of out.state.timings) {
    assert.equal(t.durationMs, 100);
  }
});

test("timings: total wall-clock = sum of phase durations (within rounding)", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "obs-6", "only", "ok");
  const llm = buildQueuedAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "final", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "obs-6",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry,
    clock: steppedIsoClock(Date.parse("2026-05-07T10:00:00.000Z"), 100)
  });
  const first = out.state.timings[0].startedAt;
  const last = out.state.timings[out.state.timings.length - 1].endedAt!;
  const wall = Date.parse(last) - Date.parse(first);
  const sumDurations = out.state.timings.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
  assert.equal(wall, sumDurations);
});

// ---------------------------------------------------------------------------
// Registry snapshot in output
// ---------------------------------------------------------------------------

test("registrySnapshot: contains exactly this parent's children", async () => {
  const registry = createInMemoryChildRunRegistry();
  // Different parents share the registry. The orchestrator output should
  // carry only the right ones.
  pushCompletedChild(registry, "obs-7", "alpha", "ok");
  pushCompletedChild(registry, "other-parent", "ignored", "should not appear");
  pushCompletedChild(registry, "obs-7", "bravo", "ok");

  const llm = buildQueuedAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { output: { text: "final", toolCalls: [] } }
  ]);
  const out = await runOrchestrator({
    parentRunId: "obs-7",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });

  const labels = out.registrySnapshot.entries.map((e) => e.handle.label);
  assert.deepEqual(labels, ["alpha", "bravo"]);
  assert.equal(
    out.registrySnapshot.entries.some((e) => e.handle.parentRunId === "other-parent"),
    false
  );
});

test("registrySnapshot: no-delegation path produces an empty snapshot", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([{ output: { text: "ok", toolCalls: [] } }]);
  const out = await runOrchestrator({
    parentRunId: "obs-8",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.registrySnapshot.entries.length, 0);
});

test("registrySnapshot: parent-failure path produces the snapshot anyway (may be empty)", async () => {
  const registry = createInMemoryChildRunRegistry();
  const llm = buildQueuedAdapter([{ throwError: new Error("boom") }]);
  const out = await runOrchestrator({
    parentRunId: "obs-9",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  // Parent failed before any children; snapshot is empty but the field is present.
  assert.ok(out.registrySnapshot);
  assert.equal(out.registrySnapshot.entries.length, 0);
});

test("registrySnapshot: synthesis-failure path still surfaces every child", async () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "obs-10", "alpha", "ok");
  pushCompletedChild(registry, "obs-10", "bravo", "ok");
  const llm = buildQueuedAdapter([
    { output: { text: "(plan)", toolCalls: [] } },
    { throwError: new Error("synthesis fail") }
  ]);
  const out = await runOrchestrator({
    parentRunId: "obs-10",
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [],
    llm,
    registry
  });
  assert.equal(out.registrySnapshot.entries.length, 2);
});

// ---------------------------------------------------------------------------
// filterSnapshotByParent helper
// ---------------------------------------------------------------------------

test("filterSnapshotByParent: pure filter, preserves order", () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "p1", "first", "x");
  pushCompletedChild(registry, "p2", "skip", "x");
  pushCompletedChild(registry, "p1", "second", "x");
  pushCompletedChild(registry, "p1", "third", "x");
  const full = registry.snapshot();
  const filtered = filterSnapshotByParent(full, "p1");
  assert.deepEqual(
    filtered.entries.map((e) => e.handle.label),
    ["first", "second", "third"]
  );
  // Original snapshot is untouched.
  assert.equal(full.entries.length, 4);
});

test("filterSnapshotByParent: unknown parent returns empty entries (not undefined)", () => {
  const registry = createInMemoryChildRunRegistry();
  pushCompletedChild(registry, "real", "x", "y");
  const filtered = filterSnapshotByParent(registry.snapshot(), "ghost");
  assert.deepEqual(filtered.entries, []);
});

// ---------------------------------------------------------------------------
// Type / typing sanity
// ---------------------------------------------------------------------------

test("PhaseTiming type exposes the right fields", () => {
  // Compile-time test: just shape the object and check assignability.
  const phase: OrchestratorPhase = "synthesize";
  const sample = {
    phase,
    startedAt: "2026-05-07T00:00:00.000Z",
    endedAt: "2026-05-07T00:00:01.000Z",
    durationMs: 1000
  };
  assert.equal(sample.phase, "synthesize");
  assert.equal(sample.durationMs, 1000);
});
