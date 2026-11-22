/**
 * Orchestrator Loop (Stage 7).
 *
 * Parent-side state machine that wraps a normal `runToolAgentLoop` call,
 * collects whatever child runs the parent's LLM spawned via
 * `delegate_task`, and — when there are children — runs a separate
 * synthesis loop with no tools. When the parent did not delegate, the
 * orchestrator short-circuits and returns the parent output unchanged.
 *
 * Phase 1 constraints:
 *   - Sequential child execution (delegate_task is blocking-inline, so all
 *     children complete during the parent loop).
 *   - One parent run, one or more children, NO nested children.
 *   - Synthesis runs in a separate `runToolAgentLoop` call
 *     (`policy.synthesisMode === "separate_call"`).
 *
 * Reusability rules followed here:
 *   - Domain-neutral: no consumer-app types or names.
 *   - The orchestrator does NOT register `delegate_task` itself by default.
 *     Consumers compose their tool list (parent domain tools +
 *     `createDelegateTaskTool`) and pass it in. Convenience helper
 *     `mergeWithDelegateTool` is provided for the common case.
 */

import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import {
  filterSnapshotByParent,
  type ChildRunRegistry,
  type RegistrySnapshot
} from "./childRunRegistry.js";
import type { ToolLlmAdapter, ToolAgentOutput } from "@maya-ai/agent-loop-core";
import { runToolAgentLoop } from "@maya-ai/agent-loop-core";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  type OrchestrationPolicy
} from "./orchestrationPolicy.js";
import {
  buildSynthesisPrompt,
  buildSynthesisSystemPrompt
} from "./orchestrationPrompt.js";
import type {
  ChildRunFailure,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";
import { createChildProgressReporter, type ProgressSink } from "./progress.js";

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

export type OrchestratorPhase =
  | "prepare"
  | "plan"
  | "delegate"
  | "wait"
  | "synthesize"
  | "finalize";

const ALLOWED_PHASE_TRANSITIONS: Record<OrchestratorPhase, OrchestratorPhase[]> = {
  prepare: ["plan"],
  plan: ["delegate", "finalize"],
  delegate: ["wait"],
  wait: ["synthesize"],
  synthesize: ["finalize"],
  finalize: []
};

export class OrchestratorPhaseTransitionError extends Error {
  constructor(from: OrchestratorPhase, to: OrchestratorPhase) {
    super(`Invalid orchestrator phase transition: ${from} -> ${to}`);
    this.name = "OrchestratorPhaseTransitionError";
  }
}

/**
 * Per-phase timing record. Phase end is recorded when the next phase
 * transition fires; the final phase (`finalize`) is closed when the
 * orchestrator returns.
 */
export interface PhaseTiming {
  phase: OrchestratorPhase;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

function transition(
  state: OrchestratorState,
  to: OrchestratorPhase,
  clock: () => string
): void {
  if (!ALLOWED_PHASE_TRANSITIONS[state.phase].includes(to)) {
    throw new OrchestratorPhaseTransitionError(state.phase, to);
  }
  // Read the clock once so the previous phase's `endedAt` equals the new
  // phase's `startedAt` exactly. Without this, two clock reads create a
  // gap and `wall-clock !== sum(phase durations)`.
  const now = clock();
  closeTimingAt(state, now);
  state.phase = to;
  state.phaseHistory.push(to);
  state.timings.push({ phase: to, startedAt: now });
}

function closeTimingAt(state: OrchestratorState, endedAt: string): void {
  const current = state.timings[state.timings.length - 1];
  if (!current || current.endedAt !== undefined) return;
  current.endedAt = endedAt;
  current.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(current.startedAt));
}

function closeCurrentTiming(state: OrchestratorState, clock: () => string): void {
  const current = state.timings[state.timings.length - 1];
  if (!current || current.endedAt !== undefined) return;
  closeTimingAt(state, clock());
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface OrchestratorState {
  parentRunId: string;
  phase: OrchestratorPhase;
  phaseHistory: OrchestratorPhase[];
  /**
   * Per-phase timings, populated as phases transition. The last entry is
   * always the current phase; its `endedAt` is filled in either at the
   * next transition or when the orchestrator returns.
   */
  timings: PhaseTiming[];
  childRunIds: string[];
  childResults: ChildRunResultEnvelope[];
  childFailures: ChildRunFailure[];
  warnings: string[];
}

export interface ChildLifecycleCounts {
  total: number;
  completed: number;
  /** Children stopped early by a run limit. */
  partial: number;
  failed: number;
  timedOut: number;
  cancelled: number;
}

export function computeChildLifecycleCounts(
  results: ChildRunResultEnvelope[]
): ChildLifecycleCounts {
  const counts: ChildLifecycleCounts = {
    total: results.length,
    completed: 0,
    partial: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0
  };
  for (const r of results) {
    switch (r.status) {
      case "completed":
        counts.completed++;
        break;
      case "partial":
        counts.partial++;
        break;
      case "failed":
        counts.failed++;
        break;
      case "timed_out":
        counts.timedOut++;
        break;
      case "cancelled":
        counts.cancelled++;
        break;
      default:
        // pending / running don't make it past wait → synthesize.
        break;
    }
  }
  return counts;
}

function createInitialState(parentRunId: string, clock: () => string): OrchestratorState {
  return {
    parentRunId,
    phase: "prepare",
    phaseHistory: ["prepare"],
    timings: [{ phase: "prepare", startedAt: clock() }],
    childRunIds: [],
    childResults: [],
    childFailures: [],
    warnings: []
  };
}

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface RunOrchestratorInput {
  /** Stable id used to scope child runs in the registry. */
  parentRunId: string;
  /** Goal stated for synthesis. Typically the user-facing request. */
  parentObjective: string;
  /** Parent system prompt for the planning loop. */
  parentSystemPrompt: string;
  /** Parent user prompt for the planning loop. */
  parentPrompt: string;
  /**
   * Tools available to the parent's LLM. Include `createDelegateTaskTool(...)`
   * here if you want the parent to be able to delegate; the orchestrator
   * does not auto-register the tool.
   */
  parentTools: AgentTool<any>[];
  /** Optional max-token budget for the parent loop. */
  parentMaxTokens?: number;
  llm: ToolLlmAdapter;
  registry: ChildRunRegistry;
  policy?: OrchestrationPolicy;
  onProgress?: ProgressSink;
  /**
   * Override max-token budget for the synthesis call. Defaults to
   * `parentMaxTokens` when absent.
   */
  synthesisMaxTokens?: number;
  /**
   * Override clock used for per-phase timings. Returns ISO-8601
   * timestamps. Defaults to `() => new Date().toISOString()`. Tests
   * pass a deterministic clock so duration assertions are stable.
   */
  clock?: () => string;
  /**
   * Cooperative cancellation. Forwarded to the parent's `runToolAgentLoop`,
   * to synthesis, and (for delegate tools that capture it through their
   * context) to every child spawned during the parent loop. Aborting
   * before/during the parent loop yields a finalized output with the
   * cancellation recorded in `state.warnings`; aborting before synthesis
   * yields the synthesis-fallback path.
   */
  signal?: AbortSignal;
}

export interface RunOrchestratorOutput {
  finalText: string;
  finalToolCalls: Array<{ name: string; isError: boolean }>;
  state: OrchestratorState;
  /** Derived from `state.childResults`. Convenient for callers and tests. */
  childCounts: ChildLifecycleCounts;
  parentOutput?: ToolAgentOutput;
  synthesisOutput?: ToolAgentOutput;
  /** True when synthesis ran. False when the parent did not delegate. */
  didSynthesize: boolean;
  /**
   * Snapshot of every child registered for this parent, filtered from
   * the registry at the moment the orchestrator returned. Lets log
   * middleware capture full lifecycle data without poking the registry
   * directly.
   */
  registrySnapshot: RegistrySnapshot;
}

/**
 * Cancellation note (Stage 10):
 *
 * True mid-call cancellation is supported via AbortSignal end-to-end.
 * `RunOrchestratorInput.signal` is forwarded into:
 *   - the parent `runToolAgentLoop` call,
 *   - `runSynthesis` (so the final synthesis call is also abortable),
 *   - every child spawned through delegate-tool contexts that capture
 *     the same signal (the consumer adapter is responsible for setting
 *     `DelegateToolContext.signal` / `DelegateTasksToolContext.signal`).
 *
 * Inside `executeChildRun`, the signal is raced with the per-child
 * timeout (`withChildTimeout`); whichever fires first determines the
 * terminal status (`cancelled` vs. `timed_out`). Only one terminal
 * write reaches the registry. The signal is also forwarded into the
 * runtime so in-flight LLM streams and tools abort cooperatively.
 */

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOrchestrator(
  input: RunOrchestratorInput
): Promise<RunOrchestratorOutput> {
  const policy = input.policy ?? DEFAULT_ORCHESTRATION_POLICY;
  const clock = input.clock ?? (() => new Date().toISOString());
  const state = createInitialState(input.parentRunId, clock);
  const progress = createChildProgressReporter({
    label: `parent:${input.parentRunId}`,
    onProgress: input.onProgress
  });

  const buildSnapshot = (): RegistrySnapshot =>
    filterSnapshotByParent(input.registry.snapshot(), input.parentRunId);

  // -------------------------------------------------------------
  // prepare → plan
  // -------------------------------------------------------------
  transition(state, "plan", clock);
  progress.message("planning delegated work");

  let parentOutput: ToolAgentOutput | undefined;
  try {
    parentOutput = await runToolAgentLoop({
      llm: input.llm,
      systemPrompt: input.parentSystemPrompt,
      prompt: input.parentPrompt,
      sessionId: input.parentRunId,
      tools: input.parentTools,
      maxTokens: input.parentMaxTokens,
      onProgress: input.onProgress,
      signal: input.signal
    });
  } catch (error) {
    // Parent loop blew up. Skip delegate/wait/synthesize entirely; record
    // the failure and finalize. Distinguish abort-driven exits so callers
    // can see a coherent "cancelled" warning instead of a generic error.
    const aborted = input.signal?.aborted === true;
    const message = error instanceof Error ? error.message : String(error);
    state.warnings.push(
      aborted ? `Parent loop cancelled: ${message}` : `Parent loop failed: ${message}`
    );
    transition(state, "finalize", clock);
    closeCurrentTiming(state, clock);
    return {
      finalText: aborted
        ? `Parent loop cancelled: ${message}`
        : `Parent loop failed: ${message}`,
      finalToolCalls: [],
      state,
      childCounts: computeChildLifecycleCounts(state.childResults),
      didSynthesize: false,
      registrySnapshot: buildSnapshot()
    };
  }

  // Whatever children the parent's LLM created via delegate_task are
  // already complete (delegate_task is blocking-inline in Phase 1). The
  // registry is the source of truth.
  const handles = input.registry.listByParent(input.parentRunId);
  state.childRunIds = handles.map((h) => h.runId);
  for (const handle of handles) {
    const result = input.registry.getResult(handle.runId);
    if (result) {
      state.childResults.push(result);
      if (result.failure) {
        state.childFailures.push(result.failure);
      }
    } else {
      // No result envelope means the run is in a non-terminal state. In
      // Phase 1's blocking model this should not happen; record it as a
      // warning rather than crashing.
      state.warnings.push(
        `Child ${handle.runId} (${handle.label}) ended in non-terminal state ${handle.status}`
      );
    }
  }

  // -------------------------------------------------------------
  // No children → short-circuit: plan → finalize
  // -------------------------------------------------------------
  if (state.childResults.length === 0) {
    transition(state, "finalize", clock);
    progress.message("no delegation; finalizing parent output");
    closeCurrentTiming(state, clock);
    return {
      finalText: parentOutput?.text ?? "",
      finalToolCalls: (parentOutput?.toolCalls ?? []).map((tc) => ({
        name: tc.name,
        isError: tc.isError
      })),
      state,
      childCounts: computeChildLifecycleCounts(state.childResults),
      parentOutput,
      didSynthesize: false,
      registrySnapshot: buildSnapshot()
    };
  }

  // -------------------------------------------------------------
  // plan → delegate → wait → synthesize → finalize
  // -------------------------------------------------------------
  const counts = computeChildLifecycleCounts(state.childResults);
  transition(state, "delegate", clock);
  progress.message(`delegated ${counts.total} task(s)`);

  transition(state, "wait", clock);
  progress.message(
    `collected ${counts.total} result(s): ${counts.completed} completed, ` +
      `${counts.failed} failed, ${counts.timedOut} timed out, ${counts.cancelled} cancelled`
  );

  transition(state, "synthesize", clock);
  progress.message(
    counts.completed > 0
      ? `synthesizing ${counts.total} result(s)`
      : `synthesizing ${counts.total} result(s) — no successes; partial-failure path`
  );

  let synthesisOutput: ToolAgentOutput | undefined;
  try {
    synthesisOutput = await runSynthesis({
      parentRunId: input.parentRunId,
      objective: input.parentObjective,
      childResults: state.childResults,
      childFailures: state.childFailures,
      llm: input.llm,
      maxTokens: input.synthesisMaxTokens ?? input.parentMaxTokens,
      onProgress: input.onProgress,
      signal: input.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.warnings.push(`Synthesis failed: ${message}`);
    transition(state, "finalize", clock);
    closeCurrentTiming(state, clock);
    return {
      finalText: synthesisFallbackText(state, message),
      finalToolCalls: [],
      state,
      childCounts: computeChildLifecycleCounts(state.childResults),
      parentOutput,
      didSynthesize: false,
      registrySnapshot: buildSnapshot()
    };
  }

  transition(state, "finalize", clock);
  progress.message("finalizing");
  closeCurrentTiming(state, clock);

  return {
    finalText: synthesisOutput?.text ?? "",
    finalToolCalls: (synthesisOutput?.toolCalls ?? []).map((tc) => ({
      name: tc.name,
      isError: tc.isError
    })),
    state,
    childCounts: computeChildLifecycleCounts(state.childResults),
    parentOutput,
    synthesisOutput,
    didSynthesize: true,
    registrySnapshot: buildSnapshot()
  };
}

// ---------------------------------------------------------------------------
// Synthesis call (separate runToolAgentLoop, no tools)
// ---------------------------------------------------------------------------

export interface RunSynthesisInput {
  parentRunId: string;
  objective: string;
  childResults: ChildRunResultEnvelope[];
  childFailures: ChildRunFailure[];
  llm: ToolLlmAdapter;
  maxTokens?: number;
  onProgress?: ProgressSink;
  /** Cooperative cancellation for the synthesis call. */
  signal?: AbortSignal;
}

/**
 * Phase 1 synthesis is a fresh `runToolAgentLoop` call with NO tools and a
 * distinct session id. Cost tradeoff vs. inline-tool-result synthesis is
 * documented in the plan; only `separate_call` is implemented here.
 */
export async function runSynthesis(
  input: RunSynthesisInput
): Promise<ToolAgentOutput | undefined> {
  return runToolAgentLoop({
    llm: input.llm,
    systemPrompt: buildSynthesisSystemPrompt(),
    prompt: buildSynthesisPrompt({
      objective: input.objective,
      childResults: input.childResults,
      childFailures: input.childFailures
    }),
    sessionId: `${input.parentRunId}-synthesis`,
    tools: [], // synthesis must not call tools
    maxTokens: input.maxTokens,
    onProgress: input.onProgress,
    signal: input.signal
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fallback text when synthesis itself fails. The orchestrator must still
 * produce a useful answer rather than dropping the run.
 */
function synthesisFallbackText(state: OrchestratorState, errorMessage: string): string {
  const successCount = state.childResults.filter((r) => r.status === "completed").length;
  const partialCount = state.childResults.filter((r) => r.status === "partial").length;
  const failureCount = state.childResults.length - successCount - partialCount;
  const lines = [
    `Synthesis failed (${errorMessage}).`,
    `Child runs: ${state.childResults.length} (${successCount} completed, ` +
      (partialCount > 0 ? `${partialCount} partial, ` : "") +
      `${failureCount} failed).`
  ];
  for (const result of state.childResults) {
    lines.push(`- [${result.status}] ${result.label}: ${result.summary}`);
  }
  return lines.join("\n");
}

/**
 * Convenience: append a delegate tool to an existing parent tool list.
 * Consumers normally call this when wiring up the orchestrator.
 */
export function mergeWithDelegateTool(
  parentTools: AgentTool<any>[],
  delegateTool: AgentTool<any>
): AgentTool<any>[] {
  return [...parentTools, delegateTool];
}
