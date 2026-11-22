import type {
  AgentEndReason,
  AgentEvent,
  AgentTool,
  AgentUsage,
  ToolAgentBudget
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
   */
  supports?: {
    limits?: boolean;
    usage?: boolean;
    events?: boolean;
    modelSelection?: boolean;
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
}
