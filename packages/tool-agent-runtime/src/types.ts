import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@mariozechner/pi-ai";

/**
 * AgentMessage is structurally identical to pi-ai's Message union.
 * Defined here so callers depend on this package surface.
 */
export type AgentMessage = Message;

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
   * Per-tool execution mode override.
   * - "sequential": must run one at a time with the other tool calls in the batch.
   * - "parallel": can run concurrently with other tool calls in the batch.
   * Defaults to the batch-level mode when omitted.
   */
  executionMode?: "sequential" | "parallel";
}

/** Events emitted by runToolAgent for UI integration and progress tracking. */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
