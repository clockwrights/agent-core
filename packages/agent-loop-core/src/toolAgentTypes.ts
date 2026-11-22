import type {
  AgentEndReason,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentUsage,
  RunState,
  ToolAgentBudget,
  ToolAgentRunInput,
  ToolApproval,
  ToolInterruption
} from "@maya-ai/tool-agent-runtime";

export interface ToolAgentRuntimeMetadata {
  enabled: boolean;
  /**
   * Which optional `ToolAgentInput` / `ToolAgentOutput` features this adapter
   * honours. Absent means none are known to be supported.
   * - `limits`: `maxTurns`, `maxToolCalls`, `budget`, `toolTimeoutMs`, `maxParallelTools`
   * - `usage`: `usage`, `endReason`, `errorMessage`, `turns` on the output
   * - `events`: `onEvent` receives the runtime's raw events
   * - `modelSelection`: `model` on the input picks the model for that call
   * - `runState`: `messages` / `resumeFrom` on the input and `state` on the output
   * - `approvals`: `beforeToolCall` / `afterToolCall` / `approvals` on the input and
   *   `interruptions` on the output
   */
  supports?: {
    limits?: boolean;
    usage?: boolean;
    events?: boolean;
    modelSelection?: boolean;
    runState?: boolean;
    approvals?: boolean;
  };
}

export interface ToolLlmAdapter {
  runToolAgent(input: ToolAgentInput): Promise<ToolAgentOutput | undefined>;
  metadata(): ToolAgentRuntimeMetadata;
}

/**
 * Image content for multimodal LLM calls. Shape matches pi-ai's `ImageContent`:
 * `data` is base64-encoded bytes (no data URL prefix); `mimeType` is the image
 * MIME type (e.g. `image/png`).
 *
 * When present on `ToolAgentInput`, the adapter constructs a multimodal user
 * message with `prompt` as the text part followed by these image parts. Used
 * by the document pipeline's Tier-C classification path.
 */
export interface ToolAgentImage {
  data: string;
  mimeType: string;
}

/**
 * Run limits, with the same names and meaning as tool-agent-runtime's
 * `ToolAgentRunInput`. All optional; unset means no limit. Adapters that
 * cannot enforce them MAY ignore them and SHOULD report
 * `supports.limits: false` (or omit it) in `metadata()`.
 */
export interface ToolAgentLimits {
  /** Maximum model calls. */
  maxTurns?: number;
  /** Maximum tool executions across the run. */
  maxToolCalls?: number;
  /** Token / cost budget, checked after each model call. */
  budget?: ToolAgentBudget;
  /** Default per-tool timeout in milliseconds. */
  toolTimeoutMs?: number;
  /** Maximum tools running at once in a parallel batch. */
  maxParallelTools?: number;
}

/** Reasoning effort levels (same names as tool-agent-runtime / pi-ai). */
export type ToolAgentReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ToolAgentInput extends ToolAgentLimits {
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  tools: AgentTool<any>[];
  maxTokens?: number;
  /**
   * Model selector for this call — for example an llm-profiles profile name
   * or component id, or a provider model id. The adapter decides how to
   * interpret it. Adapters that cannot switch models MAY ignore it and
   * SHOULD report `supports.modelSelection: false` (or omit it).
   */
  model?: string;
  /** Reasoning effort for this call. "off" disables extended thinking. */
  reasoning?: ToolAgentReasoningLevel;
  onProgress?: (message: string) => void;
  /**
   * Optional image attachments. When provided, the LLM call is multimodal:
   * the user message contains the text `prompt` followed by each image as a
   * `{ type: "image" }` content part. Adapters that do not support
   * multimodal MAY ignore these (and SHOULD record that they did so).
   */
  images?: ToolAgentImage[];
  /**
   * Cooperative cancellation. Adapters that wrap the in-house
   * `tool-agent-runtime` forward this to every streamSimple call and to
   * every tool's `execute`. Adapters built on other runtimes that lack
   * cancellation MAY ignore it (and SHOULD record that they did so).
   */
  signal?: AbortSignal;
  /**
   * Receives the runtime's raw `AgentEvent`s (per-turn usage, tool timings,
   * streaming deltas). Adapters that cannot provide them MAY ignore this and
   * SHOULD report `supports.events: false` (or omit it).
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Prior conversation; the run continues from it. With `messages` or
   * `resumeFrom`, `prompt` is the new user turn, and an empty `prompt` ("")
   * means no new turn. Adapters that cannot honour it SHOULD report
   * `supports.runState: false` (or omit it).
   */
  messages?: AgentMessage[];
  /**
   * Continue from a saved `RunState` (from a previous output's `state`):
   * transcript, counters and usage carry over, so limits count across calls.
   * Not combinable with `messages`.
   */
  resumeFrom?: RunState;
  /**
   * Decide each tool call before it runs (allow / deny / ask). An "ask" ends
   * the run with `endReason: "interrupted"` and `interruptions` on the output;
   * resume with `resumeFrom` + `approvals`. Same semantics as
   * tool-agent-runtime's `beforeToolCall`. Adapters that cannot honour it
   * SHOULD report `supports.approvals: false` (or omit it).
   */
  beforeToolCall?: ToolAgentRunInput["beforeToolCall"];
  /** Inspect or replace each executed call's result before the model sees it. */
  afterToolCall?: ToolAgentRunInput["afterToolCall"];
  /** Human decisions for the interrupted calls of `resumeFrom`, keyed by tool-call id. */
  approvals?: Record<string, ToolApproval>;
}

export interface ToolAgentOutput {
  text: string;
  toolCalls: Array<{
    name: string;
    args: unknown;
    isError: boolean;
  }>;
  /** Usage summed over the run (tokens and USD cost). */
  usage?: AgentUsage;
  /** Why the run ended. */
  endReason?: AgentEndReason;
  /** The model's error message when `endReason` is "error" or "aborted". */
  errorMessage?: string;
  /** Number of model calls made. */
  turns?: number;
  /** Serializable state of the run; pass as `resumeFrom` to continue. */
  state?: RunState;
  /** Calls waiting for a human decision when `endReason` is "interrupted" (same as `state.interruptions`). */
  interruptions?: ToolInterruption[];
}
