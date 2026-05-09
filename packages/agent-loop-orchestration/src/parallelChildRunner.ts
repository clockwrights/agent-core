/**
 * Bounded-concurrency child runner (Stage 9).
 *
 * Runs a list of `ChildRunRequest`s through a caller-supplied executor
 * function with at most `maxConcurrent` children active at any moment.
 * The result array preserves input order regardless of completion
 * order — slot `i` is always the result for `requests[i]`.
 *
 * Reusability: domain-neutral; the runner only knows about
 * `ChildRunRequest` and `ChildRunResultEnvelope` shapes from this
 * package. The executor function is injected so tests can drive it
 * with a stub and consumers can provide custom execution semantics.
 *
 * Determinism note (single-thread JS): each worker reads `nextIndex`
 * synchronously, calls `executeOne`, and only then awaits. The
 * registry's `create()` call happens inside the synchronous prefix of
 * `executeChildRun` (before the first `await`), so child registry
 * insertion order matches input order even under parallel execution.
 * Synthesis ordering remains stable.
 */

import type {
  ChildRunRequest,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";

export interface RunChildrenInParallelInput {
  requests: ChildRunRequest[];
  /**
   * At most this many children active at once. Values <= 0 are normalised
   * to 1 (purely sequential). Values larger than `requests.length` cap to
   * `requests.length`.
   */
  maxConcurrent: number;
  /** Per-request execution. Always resolves with an envelope (never throws). */
  executeOne: (request: ChildRunRequest) => Promise<ChildRunResultEnvelope>;
  /**
   * Optional lifecycle hook for observability. Called once per request
   * with `"started"` immediately before `executeOne` is invoked, and
   * with `"finished"` after it resolves.
   */
  onWorker?: (event: "started" | "finished", request: ChildRunRequest) => void;
}

export async function runChildrenInParallel(
  input: RunChildrenInParallelInput
): Promise<ChildRunResultEnvelope[]> {
  const { requests, executeOne, onWorker } = input;
  if (requests.length === 0) return [];

  const concurrency = Math.max(
    1,
    Math.min(input.maxConcurrent || 1, requests.length)
  );
  const results: ChildRunResultEnvelope[] = new Array(requests.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex++;
      if (i >= requests.length) return;
      const request = requests[i];
      onWorker?.("started", request);
      try {
        results[i] = await executeOne(request);
      } finally {
        onWorker?.("finished", request);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
