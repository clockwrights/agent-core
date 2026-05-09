/**
 * Child-run registry: contract, lifecycle transitions, in-memory store, and
 * the typed error classes raised by the executor (Stage 4).
 *
 * Compressed layout: the earlier draft split this across three files
 * (childRunRegistry.ts, childRunRegistryMemory.ts, childRunLifecycle.ts).
 * They are merged here because they describe a single concept; splitting
 * before behavior ships only adds files, not clarity.
 *
 * Reusability rule: this file must not import from any consumer-app path.
 */

import type {
  ChildRunFailure,
  ChildRunHandle,
  ChildRunRequest,
  ChildRunResultEnvelope,
  ChildRunStatus
} from "./orchestrationTypes.js";

// ---------------------------------------------------------------------------
// Typed errors (raised by the executor in Stage 4; mapped to ChildRunFailure)
// ---------------------------------------------------------------------------

export class ChildRunTimeoutError extends Error {
  readonly code = "timeout" as const;
  constructor(message = "Child run timed out") {
    super(message);
    this.name = "ChildRunTimeoutError";
  }
}

export class ChildRunCancelledError extends Error {
  readonly code = "cancelled" as const;
  constructor(message = "Child run was cancelled") {
    super(message);
    this.name = "ChildRunCancelledError";
  }
}

export class ChildRunValidationError extends Error {
  readonly code = "validation_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChildRunValidationError";
  }
}

// ---------------------------------------------------------------------------
// withChildTimeout — race a child loop call against a timer
// ---------------------------------------------------------------------------

/**
 * Races `promise` against a timer and (optionally) an `AbortSignal`.
 *
 * - On timeout, rejects with `ChildRunTimeoutError`.
 * - On abort, rejects with `ChildRunCancelledError`.
 * - Whichever fires first wins; the other is cleaned up so no lingering
 *   timer or listener is left.
 *
 * Race semantics: the wrapped promise itself may still be in flight when
 * this function rejects. The caller is responsible for forwarding the
 * same `signal` to the underlying work so it can settle quickly.
 */
export async function withChildTimeout<T>(
  timeoutMs: number,
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new ChildRunCancelledError("Child run was cancelled before execution");
  }
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout && !signal) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: T) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      if (hasTimeout) {
        timer = setTimeout(() => {
          settleReject(new ChildRunTimeoutError(`Child run exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (signal) {
        abortListener = () => {
          settleReject(new ChildRunCancelledError("Child run was cancelled"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      promise.then(settleResolve, settleReject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transition rules
// ---------------------------------------------------------------------------

/**
 * Allowed status transitions. Any transition not in this table is rejected
 * with `RegistryTransitionError`. Centralising this prevents partial
 * implementations (e.g. completing a run that was never started).
 */
const ALLOWED_TRANSITIONS: Record<ChildRunStatus, ChildRunStatus[]> = {
  pending: ["running", "cancelled", "failed", "timed_out"],
  running: ["completed", "failed", "timed_out", "cancelled"],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: []
};

export class RegistryTransitionError extends Error {
  constructor(runId: string, from: ChildRunStatus, to: ChildRunStatus) {
    super(`Invalid registry transition for ${runId}: ${from} -> ${to}`);
    this.name = "RegistryTransitionError";
  }
}

export class RegistryUnknownRunError extends Error {
  constructor(runId: string) {
    super(`Registry has no entry for run ${runId}`);
    this.name = "RegistryUnknownRunError";
  }
}

function assertTransitionAllowed(
  runId: string,
  from: ChildRunStatus,
  to: ChildRunStatus
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RegistryTransitionError(runId, from, to);
  }
}

// ---------------------------------------------------------------------------
// Registry contract
// ---------------------------------------------------------------------------

export interface ChildRunRegistry {
  create(request: ChildRunRequest, startedAt?: string): ChildRunHandle;
  markRunning(runId: string): void;
  markCompleted(result: ChildRunResultEnvelope): void;
  markFailed(runId: string, failure: ChildRunFailure, endedAt: string): void;
  markTimedOut(runId: string, endedAt: string): void;
  markCancelled(runId: string, endedAt: string): void;
  /**
   * Unified terminal-state writer. Routes to the right markX based on
   * `envelope.status` and stores the full envelope so `getResult` returns
   * something for every terminal state — not just `completed`. Use this
   * from callers (e.g. the executor) that already build a complete
   * envelope on every code path.
   */
  markTerminal(envelope: ChildRunResultEnvelope): void;
  get(runId: string): ChildRunHandle | undefined;
  /** Children of `parentRunId` in creation order. */
  listByParent(parentRunId: string): ChildRunHandle[];
  /** Number of children for `parentRunId` whose status is `pending` or `running`. */
  activeCount(parentRunId: string): number;
  /** Read the full original request — useful for audit and later persistence. */
  getRequest(runId: string): ChildRunRequest | undefined;
  /** Result envelope, available after `markCompleted`. */
  getResult(runId: string): ChildRunResultEnvelope | undefined;
  /** Deterministic snapshot for tests / debugging. */
  snapshot(): RegistrySnapshot;
}

export interface RegistrySnapshotEntry {
  handle: ChildRunHandle;
  request: ChildRunRequest;
  result?: ChildRunResultEnvelope;
  failure?: ChildRunFailure;
}

export interface RegistrySnapshot {
  entries: RegistrySnapshotEntry[];
}

/**
 * Filter a registry snapshot to a single parent's children. Order is
 * preserved (registry insertion order). Useful when a consumer logs the
 * orchestrator output and wants only the children for that run, not
 * every child the registry has ever seen.
 */
export function filterSnapshotByParent(
  snapshot: RegistrySnapshot,
  parentRunId: string
): RegistrySnapshot {
  return {
    entries: snapshot.entries.filter((entry) => entry.handle.parentRunId === parentRunId)
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface InternalEntry {
  handle: ChildRunHandle;
  request: ChildRunRequest;
  result?: ChildRunResultEnvelope;
  failure?: ChildRunFailure;
  /** Insertion order, used for stable `listByParent` ordering. */
  sequence: number;
}

export interface ChildRunRegistryOptions {
  /** Override clock for deterministic tests. Defaults to `Date.now()`-based ISO string. */
  clock?: () => string;
}

export function createInMemoryChildRunRegistry(
  options: ChildRunRegistryOptions = {}
): ChildRunRegistry {
  const clock = options.clock ?? (() => new Date().toISOString());
  const entries = new Map<string, InternalEntry>();
  let nextSequence = 0;

  function require(runId: string): InternalEntry {
    const entry = entries.get(runId);
    if (!entry) throw new RegistryUnknownRunError(runId);
    return entry;
  }

  function transition(runId: string, to: ChildRunStatus, endedAt?: string): InternalEntry {
    const entry = require(runId);
    assertTransitionAllowed(runId, entry.handle.status, to);
    entry.handle = {
      ...entry.handle,
      status: to,
      endedAt: endedAt ?? entry.handle.endedAt
    };
    return entry;
  }

  return {
    create(request, startedAt) {
      if (entries.has(request.runId)) {
        throw new Error(`Registry already has entry for run ${request.runId}`);
      }
      const handle: ChildRunHandle = {
        runId: request.runId,
        parentRunId: request.parentRunId,
        label: request.label,
        status: "pending",
        startedAt: startedAt ?? clock()
      };
      entries.set(request.runId, {
        handle,
        request,
        sequence: nextSequence++
      });
      return handle;
    },

    markRunning(runId) {
      transition(runId, "running");
    },

    markCompleted(result) {
      const entry = transition(result.runId, "completed", result.endedAt);
      entry.result = result;
    },

    markFailed(runId, failure, endedAt) {
      const entry = transition(runId, "failed", endedAt);
      entry.failure = failure;
    },

    markTimedOut(runId, endedAt) {
      const entry = transition(runId, "timed_out", endedAt);
      entry.failure = entry.failure ?? {
        code: "timeout",
        message: "Child run timed out",
        retryable: true
      };
    },

    markCancelled(runId, endedAt) {
      const entry = transition(runId, "cancelled", endedAt);
      entry.failure = entry.failure ?? {
        code: "cancelled",
        message: "Child run was cancelled",
        retryable: false
      };
    },

    markTerminal(envelope) {
      if (envelope.status === "completed") {
        this.markCompleted(envelope);
        return;
      }
      // Failure-class terminal: set status + envelope + failure together.
      const entry = transition(envelope.runId, envelope.status, envelope.endedAt);
      entry.result = envelope;
      if (envelope.failure) entry.failure = envelope.failure;
      else if (envelope.status === "timed_out") {
        entry.failure = { code: "timeout", message: "Child run timed out", retryable: true };
      } else if (envelope.status === "cancelled") {
        entry.failure = { code: "cancelled", message: "Child run was cancelled", retryable: false };
      }
    },

    get(runId) {
      return entries.get(runId)?.handle;
    },

    getRequest(runId) {
      return entries.get(runId)?.request;
    },

    getResult(runId) {
      return entries.get(runId)?.result;
    },

    listByParent(parentRunId) {
      return Array.from(entries.values())
        .filter((entry) => entry.handle.parentRunId === parentRunId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => entry.handle);
    },

    activeCount(parentRunId) {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.handle.parentRunId !== parentRunId) continue;
        if (entry.handle.status === "pending" || entry.handle.status === "running") {
          count++;
        }
      }
      return count;
    },

    snapshot() {
      const sorted = Array.from(entries.values()).sort((a, b) => a.sequence - b.sequence);
      return {
        entries: sorted.map((entry) => ({
          handle: entry.handle,
          request: entry.request,
          result: entry.result,
          failure: entry.failure
        }))
      };
    }
  };
}
