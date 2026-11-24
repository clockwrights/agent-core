/**
 * Raised when a tool exceeds its timeout. The runtime aborts the signal it
 * passed to the tool with this error as the abort reason, and reports the
 * timeout to the model as an error tool result whose `details` are
 * `{ error: "ToolTimeoutError", timeoutMs }`.
 */
export class ToolTimeoutError extends Error {
  override readonly name = "ToolTimeoutError";

  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
  }
}
