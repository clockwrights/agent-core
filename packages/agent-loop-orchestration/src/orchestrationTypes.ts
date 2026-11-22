/**
 * Domain-neutral contracts for multi-agent orchestration.
 *
 * Reusability rule: this file must not import from any consumer-app path.
 * All identifiers are domain-neutral. Consumers supply domain specifics
 * through these contracts.
 */

import type { AgentEndReason, AgentUsage } from "@maya-ai/tool-agent-runtime";

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

/**
 * - `partial`: the child stopped early because a run limit was reached
 *   (`max_turns`, `max_tool_calls` or `budget`). Its text and tool calls are
 *   kept; `warnings` says which limit. Only reported when the adapter
 *   reports an end reason (see `ToolLlmAdapter` `supports.usage`).
 */
export type ChildRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ChildContextMode = "isolated" | "fork";

/**
 * Phase 1 always uses "blocking_inline". The discriminator is encoded in the
 * request so later async-completion stages can extend it without breaking
 * existing consumers.
 */
export type ChildExecutionMode = "blocking_inline";

// ---------------------------------------------------------------------------
// Execution profile
// ---------------------------------------------------------------------------

export type ChildThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Cost / capability shape for a child run. `model` / `thinkingLevel` are
 * the profile level of the child model resolution order:
 * request > profile > policy default > parent (the adapter's default).
 * `model` is a selector the adapter interprets (llm-profiles profile name,
 * component id or provider model id).
 */
export interface ChildExecutionProfile {
  model?: string;
  thinkingLevel?: ChildThinkingLevel;
  maxTokens?: number;
  toolPolicyPreset?: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ChildRunRequest {
  runId: string;
  parentRunId: string;
  parentDepth: number;
  label: string;
  description: string;
  prompt: string;
  contextMode: ChildContextMode;
  executionMode: ChildExecutionMode;
  profile?: ChildExecutionProfile;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Maximum model calls for the child. Falls back to the policy's
   * `defaultChildMaxTurns`; unset means no cap. Reaching it yields status
   * `partial` (with an adapter that reports end reasons).
   */
  maxTurns?: number;
  /** Model selector for this child; wins over `profile.model` and the policy default. */
  model?: string;
  /** Reasoning effort for this child; wins over `profile.thinkingLevel` and the policy default. */
  thinkingLevel?: ChildThinkingLevel;
  allowWriteTools?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  /**
   * Selected parent context slices, used only when `contextMode === "fork"`.
   * Slices are domain-neutral text + metadata; the consumer pre-filters them
   * before constructing the request. Phase 1 caps total and per-slice size
   * via `buildForkedContextBlock`. Ignored when `contextMode === "isolated"`.
   */
  parentContext?: ParentContextSlice[];
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

export type ChildRunFailureCode =
  | "timeout"
  | "cancelled"
  | "tool_error"
  | "llm_error"
  | "validation_error"
  | "unknown";

export interface ChildRunFailure {
  code: ChildRunFailureCode;
  message: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Proposed change set (reserved for Phase 1)
// ---------------------------------------------------------------------------

/**
 * Reserved shape for child runs that produce candidate edits / actions /
 * notifications without mutating authoritative state directly.
 *
 * Phase 1 does not populate this. The field exists on `ChildRunResultEnvelope`
 * so the contract is stable; the first executor that writes to it is
 * introduced once a concrete proposal-producing use case exists.
 */
export interface ChildRunProposedChangeSet {
  filePatches?: Array<{
    path: string;
    summary: string;
    content?: string;
  }>;
  pendingActions?: Array<{
    title: string;
    ownerRole: string;
    priority: string;
  }>;
  notifications?: Array<{
    title: string;
    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export interface ChildRunToolCallSummary {
  name: string;
  isError: boolean;
}

export interface ChildRunResultEnvelope {
  runId: string;
  parentRunId: string;
  label: string;
  status: ChildRunStatus;
  summary: string;
  text?: string;
  evidence?: string[];
  toolCalls: ChildRunToolCallSummary[];
  /**
   * RESERVED — always undefined in Phase 1. First populated by a candidate-edit
   * child variant introduced after Stage 11. Do not write to this field from
   * Phase 1 executors.
   */
  proposedChanges?: ChildRunProposedChangeSet;
  changedFiles?: string[];
  warnings?: string[];
  failure?: ChildRunFailure;
  idempotencyKey?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Token usage and cost of the child run, when the adapter reports it. */
  usage?: AgentUsage;
  /** Why the child's run ended, when the adapter reports it. */
  endReason?: AgentEndReason;
  /** Model calls the child made, when the adapter reports it. */
  turns?: number;
  /** Model selector the child was run with (after resolution), if any. */
  model?: string;
  /** Reasoning effort the child was run with (after resolution), if any. */
  thinkingLevel?: ChildThinkingLevel;
}

// ---------------------------------------------------------------------------
// Handle (lightweight registry view)
// ---------------------------------------------------------------------------

export interface ChildRunHandle {
  runId: string;
  parentRunId: string;
  label: string;
  status: ChildRunStatus;
  startedAt: string;
  endedAt?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator-side contracts (used by the orchestrator loop in Stage 7)
// ---------------------------------------------------------------------------

export interface OrchestratorDecision {
  shouldDelegate: boolean;
  childRequests: ChildRunRequest[];
  reason?: string;
}

export interface OrchestratorSynthesisInput {
  parentRunId: string;
  objective: string;
  childResults: ChildRunResultEnvelope[];
  childFailures: ChildRunFailure[];
}

/**
 * Optional execution-side overrides. Phase 1 leaves this empty; later stages
 * may attach per-call overrides without changing the request shape.
 */
export interface ChildRunExecutionOptions {
  onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Domain-neutral parent-context slice (used by Stage 5 fork builder)
// ---------------------------------------------------------------------------

/**
 * The consumer supplies a `ParentContextSlice` when requesting `contextMode: "fork"`.
 * Orchestration treats it as opaque text + metadata; it never inspects domain
 * structure. Keeping this shape generic is what allows orchestration to remain
 * reusable across consumers.
 */
export interface ParentContextSlice {
  label: string;
  content: string;
  /** Optional provenance hint, e.g. "transcript-tail", "summary", "evidence". */
  kind?: string;
}
