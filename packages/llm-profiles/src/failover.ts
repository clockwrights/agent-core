// ---------------------------------------------------------------------------
// Failover and load-balancing helpers — dependency-free.
//
// These work on plain async functions, so they fit any provider shape: wrap
// the one method that calls the model (e.g. `generate`, `complete`) and build
// your provider around the result. They are also what an app can use inside
// the router's `withFallbacks` / `withLoadBalance` options.
//
// Named `createFailover` (not `withFailover`) so it does not clash with the
// router's existing `withFailover` option.
// ---------------------------------------------------------------------------

import type { LlmRetryPolicy } from "./profiles.js";

export type AsyncFn<A extends unknown[], R> = (...args: A) => Promise<R>;

export type FailoverAttempt = {
  /** 0 = primary, 1 = first fallback, … */
  targetIndex: number;
  /** 1-based attempt number on this target. */
  attempt: number;
  error: unknown;
  /** What happens next. */
  next: "retry" | "fallback" | "throw";
};

export type CreateFailoverOptions = {
  /**
   * Decide whether an error should move on (retry or fall back). Default:
   * every error, or only errors whose status is in `retry.onStatusCodes`
   * when that list is set. Returning false rethrows immediately.
   */
  shouldFallback?: (error: unknown) => boolean;
  /** Retry policy applied to each target before moving to the next. */
  retry?: LlmRetryPolicy;
  /** Called after every failed attempt (logging/metrics). */
  onAttemptFailed?: (attempt: FailoverAttempt) => void;
  /** Injectable sleep for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

/** Thrown when an attempt exceeds `retry.timeoutMs`. */
export class FailoverTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`attempt timed out after ${timeoutMs} ms`);
    this.name = "FailoverTimeoutError";
  }
}

/** HTTP status of an error, read from `status`, `statusCode` or `response.status`. */
export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [e.status, e.statusCode, e.response?.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

/**
 * Wrap `primary` so that failures retry (per `retry`) and then move through
 * `fallbacks` in order. The last error is rethrown when every target fails.
 * Timeouts do not cancel the underlying call; they only stop waiting for it.
 */
export function createFailover<A extends unknown[], R>(
  primary: AsyncFn<A, R>,
  fallbacks: ReadonlyArray<AsyncFn<A, R>>,
  options: CreateFailoverOptions = {},
): AsyncFn<A, R> {
  const targets = [primary, ...fallbacks];
  const retry = options.retry ?? {};
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 1);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const statusCodes = retry.onStatusCodes;
  const shouldMoveOn =
    options.shouldFallback ??
    ((error: unknown) => {
      if (error instanceof FailoverTimeoutError) return true;
      if (!statusCodes) return true;
      const status = getErrorStatus(error);
      return status !== undefined && statusCodes.includes(status);
    });

  return async (...args: A): Promise<R> => {
    let lastError: unknown;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex]!;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await withTimeout(target(...args), retry.timeoutMs);
        } catch (error) {
          lastError = error;
          const moveOn = shouldMoveOn(error);
          const lastTarget = targetIndex === targets.length - 1;
          const next: FailoverAttempt["next"] = !moveOn
            ? "throw"
            : attempt < maxAttempts
              ? "retry"
              : lastTarget
                ? "throw"
                : "fallback";
          options.onAttemptFailed?.({ targetIndex, attempt, error, next });
          if (next === "throw") throw error;
          if (next === "fallback") break;
          const base = retry.backoffMs ?? 0;
          const delay = Math.min(base * 2 ** (attempt - 1), retry.maxBackoffMs ?? Number.POSITIVE_INFINITY);
          if (delay > 0) await sleep(delay);
        }
      }
    }
    throw lastError;
  };
}

function withTimeout<R>(promise: Promise<R>, timeoutMs: number | undefined): Promise<R> {
  if (!timeoutMs) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FailoverTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Weighted selection
// ---------------------------------------------------------------------------

export type WeightedTarget<T> = { target: T; weight?: number };

/**
 * Pick one target by weight (default 1). `random` returns a number in [0, 1);
 * inject it for deterministic tests. Throws on an empty list or a non-positive
 * total weight.
 */
export function pickWeighted<T>(targets: ReadonlyArray<WeightedTarget<T>>, random: () => number = Math.random): T {
  const weights = targets.map((t) => t.weight ?? 1);
  if (weights.some((w) => !(Number.isFinite(w) && w >= 0))) throw new Error("weights must be finite and >= 0");
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (targets.length === 0 || total <= 0) throw new Error("pickWeighted needs at least one target with weight > 0");
  let point = random() * total;
  for (let i = 0; i < targets.length; i++) {
    point -= weights[i]!;
    if (point < 0) return targets[i]!.target;
  }
  // Floating-point edge (random() very close to 1): last target with weight > 0.
  for (let i = targets.length - 1; i >= 0; i--) if (weights[i]! > 0) return targets[i]!.target;
  return targets[targets.length - 1]!.target;
}

/** A function that forwards each call to one target picked by weight. */
export function createLoadBalancer<A extends unknown[], R>(
  targets: ReadonlyArray<WeightedTarget<AsyncFn<A, R>>>,
  random: () => number = Math.random,
): AsyncFn<A, R> {
  pickWeighted(targets, () => 0); // validate eagerly
  return (...args: A) => pickWeighted(targets, random)(...args);
}
