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

export function toChildRunResultEnvelope(input: {
  request: ChildRunRequest;
  output: ToolAgentOutput | undefined;
  startedAt: string;
  endedAt: string;
}): ChildRunResultEnvelope {
  const text = input.output?.text ?? "";
  const toolCalls = (input.output?.toolCalls ?? []).map((tc) => ({
    name: tc.name,
    isError: tc.isError
  }));
  const summary = buildSummary(text);
  return {
    runId: input.request.runId,
    parentRunId: input.request.parentRunId,
    label: input.request.label,
    status: "completed",
    summary,
    text: text || undefined,
    toolCalls,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: durationMsBetween(input.startedAt, input.endedAt),
    idempotencyKey: input.request.idempotencyKey
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
