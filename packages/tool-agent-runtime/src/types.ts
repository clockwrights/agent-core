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
 *   `stopWhen` hook threw.
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
  | "error";

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
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
