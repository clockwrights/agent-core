/**
 * Child-run result envelope construction and failure mapping.
 *
 * The executor (childRunExecutor.ts) is the only writer of result envelopes.
 * Keeping the projection here lets tests assert on the projection logic
 * directly without standing up a full executor.
 *
 * Reusability: domain-neutral. The summary heuristic operates on the
 * generic `ToolAgentOutput.text`; no consumer-specific fields are read.
 */

import type { ToolAgentOutput } from "@maya-ai/agent-loop-core";
import {
  ChildRunCancelledError,
  ChildRunTimeoutError,
  ChildRunValidationError
} from "./childRunRegistry.js";
import type {
  ChildRunFailure,
  ChildRunRequest,
  ChildRunResultEnvelope,
  ChildRunStatus
} from "./orchestrationTypes.js";

const SUMMARY_MAX_CHARS = 500;

/**
 * End reasons meaning "stopped early" → status `partial`: a run limit, or a
 * tool call waiting for approval (`interrupted`).
 */
const PARTIAL_END_REASONS = new Set(["max_turns", "max_tool_calls", "budget", "interrupted"]);

/**
 * Project an adapter output onto a result envelope. The status follows the
 * adapter's `endReason` when it reports one:
 * - limit reasons (`max_turns`, `max_tool_calls`, `budget`) and `interrupted`
 *   (waiting for tool approval; `interruptions` kept) → `partial`
 * - `error` → `failed` (code `llm_error`, retryable)
 * - `aborted` → `cancelled`
 * - anything else, or no end reason (older adapters) → `completed`
 * Text, tool calls and usage are kept in every case.
 */
export function toChildRunResultEnvelope(input: {
  request: ChildRunRequest;
  output: ToolAgentOutput | undefined;
  startedAt: string;
  endedAt: string;
}): ChildRunResultEnvelope {
  const output = input.output;
  const text = output?.text ?? "";
  const toolCalls = (output?.toolCalls ?? []).map((tc) => ({
    name: tc.name,
    isError: tc.isError
  }));
  const endReason = output?.endReason;

  let status: ChildRunStatus = "completed";
  let failure: ChildRunFailure | undefined;
  const warnings: string[] = [];
  if (endReason && PARTIAL_END_REASONS.has(endReason)) {
    status = "partial";
    warnings.push(
      endReason === "interrupted"
        ? `Child stopped to wait for approval of ${output?.interruptions?.length ?? 0} tool call(s); the result may be incomplete.`
        : `Child stopped early (${endReason}); the result may be incomplete.`
    );
  } else if (endReason === "error") {
    status = "failed";
    failure = { code: "llm_error", message: output?.errorMessage ?? "Model call failed", retryable: true };
  } else if (endReason === "aborted") {
    status = "cancelled";
    failure = { code: "cancelled", message: output?.errorMessage ?? "Child run was cancelled", retryable: false };
  }

  return {
    runId: input.request.runId,
    parentRunId: input.request.parentRunId,
    label: input.request.label,
    status,
    summary: failure ? `Child run ${status}: ${failure.message}` : buildSummary(text),
    text: text || undefined,
    toolCalls,
    ...(warnings.length ? { warnings } : {}),
    ...(failure ? { failure } : {}),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: durationMsBetween(input.startedAt, input.endedAt),
    idempotencyKey: input.request.idempotencyKey,
    ...(output?.usage ? { usage: output.usage } : {}),
    ...(endReason ? { endReason } : {}),
    ...(output?.turns !== undefined ? { turns: output.turns } : {}),
    ...(output?.interruptions?.length ? { interruptions: output.interruptions } : {})
    // proposedChanges intentionally omitted in Phase 1 (see ChildRunResultEnvelope JSDoc).
  };
}

export function toFailureEnvelope(input: {
  request: ChildRunRequest;
  failure: ChildRunFailure;
  startedAt: string;
  endedAt: string;
  status: Extract<ChildRunStatus, "failed" | "timed_out" | "cancelled">;
}): ChildRunResultEnvelope {
  return {
    runId: input.request.runId,
    parentRunId: input.request.parentRunId,
    label: input.request.label,
    status: input.status,
    summary: `Child run ${input.status}: ${input.failure.message}`,
    toolCalls: [],
    failure: input.failure,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: durationMsBetween(input.startedAt, input.endedAt),
    idempotencyKey: input.request.idempotencyKey
  };
}

export function toChildRunFailure(error: unknown): ChildRunFailure {
  if (error instanceof ChildRunTimeoutError) {
    return { code: "timeout", message: error.message, retryable: true };
  }
  if (error instanceof ChildRunCancelledError) {
    return { code: "cancelled", message: error.message, retryable: false };
  }
  if (error instanceof ChildRunValidationError) {
    return { code: "validation_error", message: error.message, retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "unknown", message, retryable: false };
}

/**
 * Maps a failure code to the registry status the executor should record.
 * Centralised so the executor and any future stage agree on the mapping.
 */
export function statusForFailureCode(code: ChildRunFailure["code"]): Extract<
  ChildRunStatus,
  "failed" | "timed_out" | "cancelled"
> {
  switch (code) {
    case "timeout":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSummary(text: string): string {
  if (!text) return "(no output)";
  const firstParagraph = text.split(/\n\s*\n/)[0]?.trim() ?? "";
  const trimmed = firstParagraph || text.trim();
  return trimmed.length > SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : trimmed || "(no output)";
}

function durationMsBetween(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}
