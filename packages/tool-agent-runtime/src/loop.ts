/**
 * Tool-agent runtime loop.
 *
 * Drives a multi-turn tool-calling conversation with an LLM using pi-ai's
 * streamSimple directly. Supports AbortSignal for cancellation throughout:
 * the signal is forwarded to each streamSimple call and to every tool's
 * execute method.
 *
 * Tool-call execution strategy per batch:
 * - If any tool in the batch has executionMode "sequential", all tools run
 *   sequentially (one at a time).
 * - Otherwise all tools run in parallel via Promise.all (default).
 * - tool_execution_end is emitted as each tool completes.
 * - message_start / message_end for tool-result messages are emitted in
 *   assistant source order after the entire batch settles.
 */

import {
  streamSimple,
  validateToolArguments,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
  type Transport,
} from "@mariozechner/pi-ai";
import type { AgentEvent, AgentTool, AgentToolResult } from "./types.js";

export type AgentEventSink = (event: AgentEvent) => void;

/** Input for a single-prompt tool-agent run. */
export interface ToolAgentRunInput {
  systemPrompt: string;
  model: Model<any>;
  /**
   * Reasoning level forwarded to streamSimple.
   * Omit or set undefined to disable extended thinking (equivalent to "off").
   */
  reasoning?: ThinkingLevel;
  tools: AgentTool<any>[];
  /** Text of the initial user turn. */
  prompt: string;
  /** Optional image attachments for multimodal prompts. */
  images?: ImageContent[];
  signal?: AbortSignal;
  apiKey?: string;
  sessionId?: string;
  transport?: Transport;
  maxTokens?: number;
  maxRetryDelayMs?: number;
}

/**
 * Run a tool-agent loop starting from a single user prompt.
 *
 * Emits AgentEvent notifications throughout the run. If the signal is aborted
 * the current LLM call or tool execution terminates as soon as possible;
 * agent_end is still emitted with whatever messages accumulated.
 */
export async function runToolAgent(input: ToolAgentRunInput, emit: AgentEventSink): Promise<void> {
  const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: input.prompt }];
  if (input.images?.length) userContent.push(...input.images);

  const userMessage: Message = { role: "user", content: userContent, timestamp: Date.now() };
  const messages: Message[] = [userMessage];

  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: userMessage });
  emit({ type: "message_end", message: userMessage });

  const streamOptions: SimpleStreamOptions = {
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    maxTokens: input.maxTokens,
    apiKey: input.apiKey,
    sessionId: input.sessionId,
    transport: input.transport,
    maxRetryDelayMs: input.maxRetryDelayMs,
    signal: input.signal,
  };

  while (true) {
    const context: Context = {
      systemPrompt: input.systemPrompt,
      messages: messages.slice(),
      tools: input.tools,
    };

    const assistantMessage = await streamAssistantResponse(input.model, context, streamOptions, emit);
    messages.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
      emit({ type: "agent_end", messages });
      return;
    }

    const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");

    if (toolCalls.length === 0) {
      emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
      break;
    }

    const batch = await executeToolCalls(toolCalls, input.tools, input.signal, emit);

    for (const r of batch.messages) {
      messages.push(r);
      emit({ type: "message_start", message: r });
      emit({ type: "message_end", message: r });
    }
    emit({ type: "turn_end", message: assistantMessage, toolResults: batch.messages });

    if (batch.terminate) break;
    emit({ type: "turn_start" });
  }

  emit({ type: "agent_end", messages });
}

// ---------------------------------------------------------------------------
// LLM streaming
// ---------------------------------------------------------------------------

async function streamAssistantResponse(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  const response = streamSimple(model, context, options);
  let partialMessage: AssistantMessage | null = null;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          emit({ type: "message_update", message: { ...partialMessage }, assistantMessageEvent: event });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (!partialMessage) emit({ type: "message_start", message: finalMessage });
        emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  // Fallback: stream exhausted without a terminal event.
  const finalMessage = await response.result();
  if (!partialMessage) emit({ type: "message_start", message: finalMessage });
  emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

type ToolOutcome = { tc: ToolCall; result: AgentToolResult<any>; isError: boolean };

async function executeToolCalls(
  toolCalls: ToolCall[],
  tools: AgentTool<any>[],
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const hasSequential = toolCalls.some(
    (tc) => tools.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  return hasSequential
    ? executeSequential(toolCalls, tools, signal, emit)
    : executeParallel(toolCalls, tools, signal, emit);
}

async function executeSequential(
  toolCalls: ToolCall[],
  tools: AgentTool<any>[],
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const outcomes: ToolOutcome[] = [];

  for (const tc of toolCalls) {
    emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
    const { result, isError } = await executeSingle(tc, tools, signal, emit);
    emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
    outcomes.push({ tc, result, isError });
  }

  return outcomesBatch(outcomes);
}

async function executeParallel(
  toolCalls: ToolCall[],
  tools: AgentTool<any>[],
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  type Entry = ToolOutcome | (() => Promise<ToolOutcome>);
  const entries: Entry[] = [];

  for (const tc of toolCalls) {
    emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });

    const prep = prepareTool(tc, tools);
    if (prep.kind === "error") {
      emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: prep.result, isError: true });
      entries.push({ tc, result: prep.result, isError: true });
      continue;
    }

    const capturedTc = tc;
    const capturedPrep = prep;
    entries.push(async (): Promise<ToolOutcome> => {
      const { result, isError } = await runTool(capturedPrep.tool, capturedTc, capturedPrep.args, signal, emit);
      emit({ type: "tool_execution_end", toolCallId: capturedTc.id, toolName: capturedTc.name, result, isError });
      return { tc: capturedTc, result, isError };
    });
  }

  const outcomes = await Promise.all(entries.map((e) => (typeof e === "function" ? e() : Promise.resolve(e))));
  return outcomesBatch(outcomes);
}

async function executeSingle(
  tc: ToolCall,
  tools: AgentTool<any>[],
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ result: AgentToolResult<any>; isError: boolean }> {
  const prep = prepareTool(tc, tools);
  if (prep.kind === "error") return { result: prep.result, isError: true };
  return runTool(prep.tool, tc, prep.args, signal, emit);
}

type PrepResult =
  | { kind: "error"; result: AgentToolResult<any> }
  | { kind: "ready"; tool: AgentTool<any>; args: unknown };

function prepareTool(tc: ToolCall, tools: AgentTool<any>[]): PrepResult {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) return { kind: "error", result: errorResult(`Tool "${tc.name}" not found`) };

  try {
    const preparedTc = tool.prepareArguments
      ? { ...tc, arguments: tool.prepareArguments(tc.arguments) as Record<string, any> }
      : tc;
    const args = validateToolArguments(tool, preparedTc);
    return { kind: "ready", tool, args };
  } catch (err) {
    return { kind: "error", result: errorResult(err instanceof Error ? err.message : String(err)) };
  }
}

async function runTool(
  tool: AgentTool<any>,
  tc: ToolCall,
  args: unknown,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ result: AgentToolResult<any>; isError: boolean }> {
  try {
    const result = await tool.execute(tc.id, args as never, signal, (partialResult) => {
      emit({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, args: tc.arguments, partialResult });
    });
    return { result, isError: false };
  } catch (err) {
    return { result: errorResult(err instanceof Error ? err.message : String(err)), isError: true };
  }
}

function outcomesBatch(outcomes: ToolOutcome[]): ToolBatch {
  return {
    messages: outcomes.map(({ tc, result, isError }) => ({
      role: "toolResult" as const,
      toolCallId: tc.id,
      toolName: tc.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    })),
    terminate: outcomes.length > 0 && outcomes.every((o) => o.result.terminate === true),
  };
}

function errorResult(message: string): AgentToolResult<any> {
  return { content: [{ type: "text", text: message }], details: {} };
}
