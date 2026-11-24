import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { RunState } from "./runState.js";

/**
 * Version of the `AgentEvent` / `AgentTool` / tool-result contract.
 *
 * Bumped only for breaking changes to those shapes. Additive changes (new
 * optional fields, new event types consumers can ignore) keep the version.
 * Emitted on every `agent_start` event as `eventVersion`.
 */
export const AGENT_EVENT_VERSION = 1;

/**
 * AgentMessage is structurally identical to pi-ai's Message union.
 * Defined here so callers depend on this package surface.
 */
export type AgentMessage = Message;

/**
 * Token usage and cost (USD) for one model call or summed over a run.
 * Same shape as pi-ai's `Usage`; cost is computed by pi-ai from the model's
 * pricing metadata.
 */
export type AgentUsage = Usage;

/**
 * Why a run ended. Reported on `agent_end`.
 * - `completed`: the model answered without calling tools.
 * - `terminated`: every tool result in the last batch had `terminate: true`.
 * - `max_turns`: `maxTurns` model calls were made.
 * - `max_tool_calls`: the model asked for more tool calls than `maxToolCalls` allows.
 * - `budget`: the token or cost budget was reached.
 * - `stop_condition`: a `stopWhen` condition returned true.
 * - `aborted`: the signal was aborted (the model call ended with stopReason "aborted").
 * - `error`: the model call ended with stopReason "error", or a `prepareStep` /
 *   `stopWhen` / `beforeToolCall` / `afterToolCall` / `onCheckpoint` hook threw.
 * - `interrupted`: `beforeToolCall` asked for approval; the state lists the
 *   calls in `interruptions`; resume with `approvals`.
 *
 * New reasons may be added in later versions; treat unknown values as "ended".
 */
export type AgentEndReason =
  | "completed"
  | "terminated"
  | "max_turns"
  | "max_tool_calls"
  | "budget"
  | "stop_condition"
  | "aborted"
  | "error"
  | "interrupted";

/** A tool call as the approval hooks see it: arguments are validated (after `prepareArguments` and coercion). */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BeforeToolCallContext {
  toolCall: ToolCallInfo;
  /** The tool that would run. */
  tool: AgentTool<any>;
  /** 1-based turn number of the model call that requested the tool. */
  turn: number;
  /** Transcript so far (a copy). */
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
}

/**
 * Decision returned by `beforeToolCall`; `undefined` means allow.
 * - `deny`: the model gets an error result (`message`, default "Tool call denied"); the run continues.
 * - `ask`: nothing in the batch runs; the run ends with reason "interrupted". `data` must be JSON.
 */
export type ToolCallDecision =
  | { action: "allow" }
  | { action: "deny"; message?: string }
  | { action: "ask"; reason?: string; data?: Record<string, unknown> };

export interface AfterToolCallContext {
  toolCall: ToolCallInfo;
  tool: AgentTool<any>;
  /** The result as the tool produced it (thrown errors and timeouts arrive as error results). */
  result: AgentToolResult<any>;
  isError: boolean;
  turn: number;
}

/** Fields of a tool result to replace; omitted fields stay as they are. */
export type ToolResultOverride = Partial<Pick<AgentToolResult<any>, "content" | "details" | "terminate">> & {
  isError?: boolean;
};

/** A human decision for an interrupted tool call, passed on resume in `approvals`. */
export type ToolApproval = { approve: true } | { approve: false; message?: string };

/** What started a compaction: the size estimate, a context-overflow error, or `compactMessages`. */
export type CompactionTrigger = "threshold" | "overflow" | "manual";

/** One compaction of a run's transcript (kept in `RunState.compactions`). */
export interface CompactionRecord {
  /** The turn the compaction ran before (1-based); 0 for `compactMessages`. */
  turn: number;
  trigger: CompactionTrigger;
  /** Estimated prompt tokens before and after. */
  tokensBefore: number;
  tokensAfter: number;
  /**
   * Messages of the old transcript replaced by the summary message, starting
   * at `summaryIndex` (this includes the initial user message the summary
   * was added to). Rebuild: `messages.splice(summaryIndex, removedMessages, summary)`.
   */
  removedMessages: number;
  /** Index of the message holding the summary. */
  summaryIndex: number;
  /** Transcript length right after the compaction (replies from this index on have current usage). */
  messageCount: number;
}

/** One completed turn: the model call and the tool batch it triggered. */
export interface AgentStep {
  /** 1-based turn number. */
  turn: number;
  /** The assistant message of this turn. */
  message: AssistantMessage;
  /** Tool results of this turn, in call order (empty when no tools were called). */
  toolResults: ToolResultMessage[];
  /** Usage of this turn's model call. */
  usage: AgentUsage;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  /**
   * When true on every result in a batch, the agent stops after the current
   * tool batch without making another LLM call.
   */
  terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/**
 * Tool definition consumed by the agent runtime.
 * Extends pi-ai's Tool schema type with runtime execution metadata.
 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  /** Human-readable label for UI display and progress messages. */
  label: string;
  /**
   * Optional argument shim applied before schema validation.
   * Useful for adapting legacy or LLM-produced argument shapes.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Execute the tool. Throw on failure rather than encoding errors in content. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /**
   * Per-tool execution mode.
   * - "sequential": if any tool in a batch is sequential, the whole batch runs one at a time.
   * - "parallel" (also the behaviour when omitted): may run concurrently with the other
   *   tool calls in the batch.
   */
  executionMode?: "sequential" | "parallel";
  /**
   * Per-tool timeout in milliseconds. Overrides the run's `toolTimeoutMs`.
   * On timeout the signal passed to `execute` is aborted with a
   * `ToolTimeoutError`, and the model receives an error result.
   */
  timeoutMs?: number;
}

/**
 * Events emitted by runToolAgent for UI integration and progress tracking.
 *
 * Fields marked "always set by runToolAgent" are optional in the type only so
 * that events built by hand (adapters, tests) stay valid.
 */
export type AgentEvent =
  | {
      type: "agent_start";
      /** Contract version (`AGENT_EVENT_VERSION`). Always set by runToolAgent. */
      eventVersion?: number;
      /** True when the run started from `messages` or `resumeFrom`. Always set by runToolAgent. */
      resumed?: boolean;
    }
  | {
      type: "agent_end";
      messages: AgentMessage[];
      /** Why the run ended. Always set by runToolAgent. */
      reason?: AgentEndReason;
      /** Usage summed over every model call in the run. Always set by runToolAgent. */
      usage?: AgentUsage;
      /** The model's error message when `reason` is "error" or "aborted". */
      errorMessage?: string;
      /** Serializable state of the run; pass as `resumeFrom` to continue. Always set by runToolAgent. */
      state?: RunState;
    }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: AgentMessage;
      toolResults: ToolResultMessage[];
      /** Usage of this turn's model call. Always set by runToolAgent. */
      usage?: AgentUsage;
    }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
  | {
      type: "tool_approval_requested";
      toolCallId: string;
      toolName: string;
      /** Validated arguments of the call. */
      args: Record<string, unknown>;
      reason?: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "compact_boundary";
      trigger: CompactionTrigger;
      /** The turn the compaction ran before (1-based). */
      turn: number;
      /** Estimated prompt tokens before and after. */
      tokensBefore: number;
      tokensAfter: number;
      /** Old messages replaced by `summary`, starting at `summaryIndex`. */
      removedMessages: number;
      summaryIndex: number;
      /** Transcript length after the compaction. */
      keptMessages: number;
      /** The message that now holds the summary. */
      summary: AgentMessage;
      /** Usage of the summariser call (also added to the run's usage). */
      usage: AgentUsage;
    }
  | {
      type: "compaction_failed";
      trigger: CompactionTrigger;
      turn: number;
      /** Why the summariser failed. The run continues uncompacted. */
      error: string;
    };
