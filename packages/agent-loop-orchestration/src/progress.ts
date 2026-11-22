/**
 * Child-run progress reporter (Stage 13).
 *
 * Prefixes lifecycle messages with the child's label so parent-side logs
 * disambiguate parent vs. child activity, and emits a structured summary
 * line on successful completion: `completed in {ms}ms (tools=N, errors=M,
 * chars=K)`. Counters are computed by the executor from the
 * `ChildRunResultEnvelope` after the run settles — no streaming-event
 * plumbing through the LLM adapter is required.
 *
 * Reusability: domain-neutral — only formats and forwards strings and
 * primitive counters; no consumer-app fields.
 */

export type ProgressSink = (message: string) => void;

/**
 * Counters emitted alongside the `completed` lifecycle message. Sourced
 * from the `ChildRunResultEnvelope` so the values are deterministic and
 * always equal to what callers see in the final result.
 */
export interface ChildCompletionMetrics {
  /** Wall-clock duration as recorded on the envelope. */
  durationMs: number;
  /** Total tool calls the child made. */
  toolCallCount: number;
  /** Subset of `toolCallCount` whose execution returned `isError = true`. */
  toolErrorCount: number;
  /**
   * Length of the child's final text output. Cheap proxy for token
   * volume — reported as characters (not tokens) so callers don't get
   * confused into trusting it as a billing figure.
   */
  outputChars: number;
  /** Total tokens of the child run, when the adapter reports usage. */
  totalTokens?: number;
  /** Cost of the child run in USD, when the adapter reports usage. */
  costUsd?: number;
}

export interface ChildProgressReporter {
  start(): void;
  message(text: string): void;
  completed(metrics: ChildCompletionMetrics): void;
  failed(reason: string): void;
  timedOut(timeoutMs: number): void;
  /**
   * Returns a `ProgressSink` suitable for passing into `runToolAgentLoop`'s
   * `onProgress`. Messages routed through it are prefixed with the child
   * label so parent-side logs remain readable.
   */
  loopSink(): ProgressSink;
}

export interface ChildProgressInput {
  label: string;
  onProgress?: ProgressSink;
}

export function createChildProgressReporter(input: ChildProgressInput): ChildProgressReporter {
  const tag = `[child:${input.label}]`;
  const emit = (text: string) => {
    input.onProgress?.(`${tag} ${text}`);
  };
  return {
    start() {
      emit("starting");
    },
    message(text: string) {
      emit(text);
    },
    completed(metrics: ChildCompletionMetrics) {
      emit(
        `completed in ${metrics.durationMs}ms ` +
          `(tools=${metrics.toolCallCount}, errors=${metrics.toolErrorCount}, chars=${metrics.outputChars}` +
          (metrics.totalTokens !== undefined ? `, tokens=${metrics.totalTokens}` : "") +
          (metrics.costUsd !== undefined ? `, cost=$${metrics.costUsd.toFixed(4)}` : "") +
          ")"
      );
    },
    failed(reason: string) {
      emit(`failed: ${reason}`);
    },
    timedOut(timeoutMs: number) {
      emit(`timed out after ${timeoutMs}ms`);
    },
    loopSink() {
      return emit;
    }
  };
}
