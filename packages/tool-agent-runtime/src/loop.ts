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
 * - Otherwise tools run in parallel (at most `maxParallelTools` at once
 *   when set).
 * - tool_execution_start is emitted when a tool starts; tool_execution_end
 *   as each tool completes.
 * - message_start / message_end for tool-result messages are emitted in
 *   assistant source order after the entire batch settles.
 *
 * Limits (all optional, all off by default): `maxTurns`, `maxToolCalls`,
 * `budget`, `toolTimeoutMs` / per-tool `timeoutMs`, `maxParallelTools`.
 * The reason the run ended is reported on `agent_end`.
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
import { ToolTimeoutError } from "./errors.js";
import { selectActiveTools, type PrepareStep, type StopCondition } from "./steps.js";
import {
  AGENT_EVENT_VERSION,
  type AgentEndReason,
  type AgentEvent,
  type AgentStep,
  type AgentTool,
  type AgentToolResult,
  type AgentUsage,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => void;

/** Optional stop condition on accumulated usage. Checked after each model call. */
export interface ToolAgentBudget {
  /** Stop once total tokens (input + output + cache) across the run reach this value. */
  maxTotalTokens?: number;
  /** Stop once total cost in USD across the run reaches this value. */
  maxCostUsd?: number;
}

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
  /** Output-token cap for each model call (forwarded to the provider). */
  maxTokens?: number;
  maxRetryDelayMs?: number;
  /**
   * Maximum number of model calls. After the call that reaches the limit,
   * its tool batch still runs (so every tool call has a result), then the
   * run ends with reason "max_turns". Default: no limit.
   */
  maxTurns?: number;
  /**
   * Maximum number of tool executions across the run. Tool calls beyond the
   * limit are not executed: each gets an error result, and the run ends with
   * reason "max_tool_calls" after that batch. Default: no limit.
   */
  maxToolCalls?: number;
  /**
   * Token / cost budget. Checked after each model call; when reached, that
   * turn's tool batch still runs, then the run ends with reason "budget".
   * The run can therefore overshoot by one model call. Default: none.
   */
  budget?: ToolAgentBudget;
  /** Default per-tool timeout in milliseconds; a tool's own `timeoutMs` wins. Default: none. */
  toolTimeoutMs?: number;
  /** Maximum tools running at once in a parallel batch. Default: no limit. */
  maxParallelTools?: number;
  /**
   * How a batch containing a `"sequential"` tool runs.
   * - `"serialize-batch"` (default): the whole batch runs one tool at a time.
   * - `"sequential-barriers"`: each sequential tool runs alone at its position
   *   in the batch; the parallel tools between them run concurrently (never
   *   overlapping a sequential tool). Results stay in call order either way.
   */
  toolBatchStrategy?: "serialize-batch" | "sequential-barriers";
  /**
   * Custom stop condition(s), evaluated after each turn's tool batch when the
   * run would otherwise continue. Any condition returning true ends the run
   * with reason "stop_condition". See `stepCountIs`, `hasToolCall`.
   */
  stopWhen?: StopCondition | StopCondition[];
  /**
   * Called before each model call; may override the model, system prompt,
   * reasoning level, active tools or messages for that step only.
   */
  prepareStep?: PrepareStep;
}

/**
 * Run a tool-agent loop starting from a single user prompt.
 *
 * Emits AgentEvent notifications throughout the run. If the signal is aborted
 * the current LLM call or tool execution terminates as soon as possible;
 * agent_end is still emitted with whatever messages accumulated.
 */
export async function runToolAgent(input: ToolAgentRunInput, emit: AgentEventSink): Promise<void> {
  validateLimits(input);

  const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: input.prompt }];
  if (input.images?.length) userContent.push(...input.images);

  const userMessage: Message = { role: "user", content: userContent, timestamp: Date.now() };
  const messages: Message[] = [userMessage];

  emit({ type: "agent_start", eventVersion: AGENT_EVENT_VERSION });
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

  const execution: ToolExecutionOptions = {
    tools: input.tools,
    signal: input.signal,
    emit,
    defaultTimeoutMs: input.toolTimeoutMs,
    maxParallel: input.maxParallelTools,
    batchStrategy: input.toolBatchStrategy ?? "serialize-batch",
  };

  const totalUsage = emptyUsage();
  const steps: AgentStep[] = [];
  const stopConditions = input.stopWhen === undefined ? [] : [input.stopWhen].flat();
  let turns = 0;
  let toolCallsExecuted = 0;
  let reason: AgentEndReason;
  let errorMessage: string | undefined;

  while (true) {
    let prepared;
    try {
      prepared = input.prepareStep
        ? (await input.prepareStep({ turn: turns + 1, steps: steps.slice(), messages: messages.slice() })) ?? undefined
        : undefined;
    } catch (err) {
      // No model call happened, so there is no message for a turn_end: the
      // open turn_start is followed directly by agent_end (reason "error").
      reason = "error";
      errorMessage = `prepareStep failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    const stepTools = selectActiveTools(input.tools, prepared?.activeTools);
    const stepStreamOptions: SimpleStreamOptions =
      prepared?.reasoning === undefined ? streamOptions : { ...streamOptions, reasoning: prepared.reasoning };
    const context: Context = {
      systemPrompt: prepared?.systemPrompt ?? input.systemPrompt,
      messages: prepared?.messages ? prepared.messages.slice() : messages.slice(),
      tools: stepTools,
    };

    const assistantMessage = await streamAssistantResponse(
      prepared?.model ?? input.model,
      context,
      stepStreamOptions,
      emit,
    );
    messages.push(assistantMessage);
    turns += 1;
    const turnUsage = usageOf(assistantMessage);
    addUsage(totalUsage, turnUsage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      emit({ type: "turn_end", message: assistantMessage, toolResults: [], usage: turnUsage });
      reason = assistantMessage.stopReason;
      errorMessage = assistantMessage.errorMessage;
      break;
    }

    const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");

    if (toolCalls.length === 0) {
      emit({ type: "turn_end", message: assistantMessage, toolResults: [], usage: turnUsage });
      reason = "completed";
      break;
    }

    const remaining = input.maxToolCalls === undefined ? toolCalls.length : input.maxToolCalls - toolCallsExecuted;
    const allowed = Math.max(0, Math.min(toolCalls.length, remaining));
    const blockedMessage =
      allowed < toolCalls.length
        ? `Tool call limit of ${input.maxToolCalls} reached; this call was not executed.`
        : undefined;

    const batch = await executeToolCalls(toolCalls, allowed, blockedMessage, { ...execution, tools: stepTools });
    toolCallsExecuted += allowed;

    for (const r of batch.messages) {
      messages.push(r);
      emit({ type: "message_start", message: r });
      emit({ type: "message_end", message: r });
    }
    emit({ type: "turn_end", message: assistantMessage, toolResults: batch.messages, usage: turnUsage });
    steps.push({ turn: turns, message: assistantMessage, toolResults: batch.messages, usage: turnUsage });

    let stop: AgentEndReason | undefined = batch.terminate
      ? "terminated"
      : allowed < toolCalls.length
        ? "max_tool_calls"
        : undefined;
    if (!stop && stopConditions.length > 0) {
      try {
        for (const condition of stopConditions) {
          if (await condition({ steps: steps.slice(), totalUsage: { ...totalUsage, cost: { ...totalUsage.cost } } })) {
            stop = "stop_condition";
            break;
          }
        }
      } catch (err) {
        stop = "error";
        errorMessage = `stopWhen failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    stop ??=
      input.maxTurns !== undefined && turns >= input.maxTurns
        ? "max_turns"
        : budgetReached(input.budget, totalUsage)
          ? "budget"
          : undefined;
    if (stop) {
      reason = stop;
      break;
    }
    emit({ type: "turn_start" });
  }

  emit({
    type: "agent_end",
    messages,
    reason,
    usage: totalUsage,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  });
}

// ---------------------------------------------------------------------------
// Limits and usage
// ---------------------------------------------------------------------------

function validateLimits(input: ToolAgentRunInput): void {
  const positiveInteger = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new RangeError(`${name} must be a positive integer, got ${value}`);
    }
  };
  const positiveNumber = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive number, got ${value}`);
    }
  };
  positiveInteger("maxTurns", input.maxTurns);
  positiveInteger("maxToolCalls", input.maxToolCalls);
  positiveInteger("maxParallelTools", input.maxParallelTools);
  positiveNumber("toolTimeoutMs", input.toolTimeoutMs);
  positiveNumber("budget.maxTotalTokens", input.budget?.maxTotalTokens);
  positiveNumber("budget.maxCostUsd", input.budget?.maxCostUsd);
  for (const tool of input.tools) positiveNumber(`timeoutMs of tool "${tool.name}"`, tool.timeoutMs);
  if (
    input.toolBatchStrategy !== undefined &&
    input.toolBatchStrategy !== "serialize-batch" &&
    input.toolBatchStrategy !== "sequential-barriers"
  ) {
    throw new RangeError(`toolBatchStrategy must be "serialize-batch" or "sequential-barriers", got ${String(input.toolBatchStrategy)}`);
  }
}

function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Copy of a message's usage; providers that report none count as zero. */
function usageOf(message: AssistantMessage): AgentUsage {
  const total = emptyUsage();
  if (message.usage) addUsage(total, message.usage);
  return total;
}

function addUsage(target: AgentUsage, add: AgentUsage): void {
  target.input += add.input ?? 0;
  target.output += add.output ?? 0;
  target.cacheRead += add.cacheRead ?? 0;
  target.cacheWrite += add.cacheWrite ?? 0;
  target.totalTokens += add.totalTokens ?? 0;
  target.cost.input += add.cost?.input ?? 0;
  target.cost.output += add.cost?.output ?? 0;
  target.cost.cacheRead += add.cost?.cacheRead ?? 0;
  target.cost.cacheWrite += add.cost?.cacheWrite ?? 0;
  target.cost.total += add.cost?.total ?? 0;
}

function budgetReached(budget: ToolAgentBudget | undefined, usage: AgentUsage): boolean {
  if (!budget) return false;
  if (budget.maxTotalTokens !== undefined && usage.totalTokens >= budget.maxTotalTokens) return true;
  if (budget.maxCostUsd !== undefined && usage.cost.total >= budget.maxCostUsd) return true;
  return false;
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

interface ToolExecutionOptions {
  tools: AgentTool<any>[];
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  defaultTimeoutMs: number | undefined;
  maxParallel: number | undefined;
  batchStrategy: "serialize-batch" | "sequential-barriers";
}

interface ToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

type ToolOutcome = { tc: ToolCall; result: AgentToolResult<any>; isError: boolean };

/**
 * Execute a batch. The first `allowed` calls run normally; the rest get an
 * error result carrying `blockedMessage` without being executed.
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  allowed: number,
  blockedMessage: string | undefined,
  options: ToolExecutionOptions,
): Promise<ToolBatch> {
  const tasks = toolCalls.map((tc, index) => () =>
    executeOne(tc, index < allowed ? undefined : blockedMessage, options),
  );
  const isSequential = toolCalls.map(
    (tc) => options.tools.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  const parallelLimit = options.maxParallel ?? tasks.length;

  let outcomes: ToolOutcome[];
  if (!isSequential.some(Boolean)) {
    outcomes = await runWithConcurrency(tasks, parallelLimit);
  } else if (options.batchStrategy === "serialize-batch") {
    outcomes = await runWithConcurrency(tasks, 1);
  } else {
    // Sequential tools are barriers: run each alone, and run the parallel
    // calls between two barriers together.
    outcomes = [];
    let start = 0;
    while (start < tasks.length) {
      if (isSequential[start]) {
        outcomes.push(await tasks[start]!());
        start += 1;
        continue;
      }
      let end = start;
      while (end < tasks.length && !isSequential[end]) end += 1;
      outcomes.push(...(await runWithConcurrency(tasks.slice(start, end), parallelLimit)));
      start = end;
    }
  }
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

/** Run tasks with at most `limit` in flight; results keep task order. */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return results;
}

async function executeOne(
  tc: ToolCall,
  blockedMessage: string | undefined,
  options: ToolExecutionOptions,
): Promise<ToolOutcome> {
  const { emit } = options;
  emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });

  const prep: PrepResult = blockedMessage
    ? { kind: "error", result: errorResult(blockedMessage) }
    : prepareTool(tc, options.tools);
  const { result, isError } =
    prep.kind === "error" ? { result: prep.result, isError: true } : await runTool(prep.tool, tc, prep.args, options);

  emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
  return { tc, result, isError };
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
  options: ToolExecutionOptions,
): Promise<{ result: AgentToolResult<any>; isError: boolean }> {
  const timeoutMs = tool.timeoutMs ?? options.defaultTimeoutMs;
  let settled = false;
  const onUpdate = (partialResult: AgentToolResult<any>) => {
    // Drop updates from a tool that keeps running after it timed out.
    if (settled) return;
    options.emit({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, args: tc.arguments, partialResult });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === undefined) {
      const result = await tool.execute(tc.id, args as never, options.signal, onUpdate);
      return { result, isError: false };
    }

    const timeoutController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ToolTimeoutError(tc.name, timeoutMs);
        timeoutController.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const result = await Promise.race([tool.execute(tc.id, args as never, signal, onUpdate), timeout]);
    return { result, isError: false };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return {
        result: { content: [{ type: "text", text: err.message }], details: { error: err.name, timeoutMs: err.timeoutMs } },
        isError: true,
      };
    }
    return { result: errorResult(err instanceof Error ? err.message : String(err)), isError: true };
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorResult(message: string): AgentToolResult<any> {
  return { content: [{ type: "text", text: message }], details: {} };
}
