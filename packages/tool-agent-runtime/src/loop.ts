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
} from "@earendil-works/pi-ai";
import { ToolTimeoutError } from "./errors.js";
import { parseRunState, RUN_STATE_VERSION, type RunState } from "./runState.js";
import { selectActiveTools, type PrepareStep, type StopCondition } from "./steps.js";
import {
  AGENT_EVENT_VERSION,
  type AgentEndReason,
  type AgentEvent,
  type AgentMessage,
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
  /**
   * Text of a new user turn, appended after `messages` / `resumeFrom` when
   * those are given. Required unless `messages` or `resumeFrom` is given.
   */
  prompt?: string;
  /** Optional image attachments for the `prompt` turn (requires `prompt`). */
  images?: ImageContent[];
  /** Prior conversation; the run continues from it. Not combinable with `resumeFrom`. */
  messages?: AgentMessage[];
  /**
   * Continue a run from a saved state: transcript, turn and tool-call
   * counters and usage carry over, so limits count across invocations.
   * Pending tool calls (no result yet) are executed first.
   */
  resumeFrom?: RunState;
  /**
   * Awaited after every step that continues the run (before the next model
   * call) and once when the run ends, with the current state. A throw ends
   * the run with reason "error".
   */
  onCheckpoint?: (state: RunState) => void | Promise<void>;
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

/** Result of `runAgent`. */
export interface RunResult {
  /** Serializable state; pass as `resumeFrom` to continue the run. */
  state: RunState;
  reason: AgentEndReason;
  /** Usage summed over the whole run (all invocations). */
  usage: AgentUsage;
  /** Full transcript. */
  messages: AgentMessage[];
  /** Text of the last assistant message ("" when there is none). */
  text: string;
  /** The error message when `reason` is "error" or "aborted". */
  errorMessage?: string;
}

/**
 * Run a tool-agent loop from a prompt, a prior conversation (`messages`) or a
 * saved state (`resumeFrom`).
 *
 * Emits AgentEvent notifications throughout the run. If the signal is aborted
 * the current LLM call or tool execution terminates as soon as possible;
 * agent_end is still emitted with whatever messages accumulated, and carries
 * the run's `state`.
 */
export async function runToolAgent(input: ToolAgentRunInput, emit: AgentEventSink): Promise<void> {
  await runLoop(input, emit);
}

/**
 * Same loop as `runToolAgent`, resolving with the run's result and state.
 * `emit` is optional.
 */
export function runAgent(input: ToolAgentRunInput, emit?: AgentEventSink): Promise<RunResult> {
  return runLoop(input, emit ?? (() => {}));
}

async function runLoop(input: ToolAgentRunInput, emit: AgentEventSink): Promise<RunResult> {
  validateLimits(input);
  validateStart(input);
  const resumeFrom = input.resumeFrom === undefined ? undefined : parseRunState(input.resumeFrom);

  // Starting transcript. A trailing failed/aborted model reply is dropped so
  // the model retries that turn (providers also reject such messages).
  const messages: Message[] = (resumeFrom?.messages ?? input.messages ?? []).slice();
  while (isFailedReply(messages[messages.length - 1])) messages.pop();
  const resumed = input.messages !== undefined || input.resumeFrom !== undefined;

  emit({ type: "agent_start", eventVersion: AGENT_EVENT_VERSION, resumed });
  emit({ type: "turn_start" });

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

  const totalUsage = resumeFrom ? cloneUsage(resumeFrom.usage) : emptyUsage();
  const steps: AgentStep[] = [];
  const stopConditions = input.stopWhen === undefined ? [] : [input.stopWhen].flat();
  let turns = resumeFrom?.turns ?? 0;
  let toolCallsExecuted = resumeFrom?.toolCallsExecuted ?? 0;
  let reason: AgentEndReason | undefined;
  let errorMessage: string | undefined;

  const snapshot = (end?: AgentEndReason): RunState => {
    const state: RunState = {
      version: RUN_STATE_VERSION,
      messages: messages.slice(),
      turns,
      toolCallsExecuted,
      usage: cloneUsage(totalUsage),
    };
    if (end !== undefined) state.endReason = end;
    if (end !== undefined && errorMessage !== undefined) state.errorMessage = errorMessage;
    if (resumeFrom?.metadata !== undefined) state.metadata = resumeFrom.metadata;
    return state;
  };

  /** Run the checkpoint hook; on failure set the error and return false. */
  const checkpoint = async (state: RunState): Promise<boolean> => {
    if (!input.onCheckpoint) return true;
    try {
      await input.onCheckpoint(state);
      return true;
    } catch (err) {
      errorMessage = `onCheckpoint failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  };

  /**
   * Execute `toolCalls` of `assistantMessage` (all of them after a model
   * call; only the missing ones when resuming), record the step, and decide
   * whether the run stops. `existingResults` are results already in the
   * transcript for this assistant message.
   */
  const finishTurn = async (
    assistantMessage: AssistantMessage,
    toolCalls: ToolCall[],
    turnUsage: AgentUsage,
    existingResults: ToolResultMessage[],
  ): Promise<AgentEndReason | undefined> => {
    const remaining = input.maxToolCalls === undefined ? toolCalls.length : input.maxToolCalls - toolCallsExecuted;
    const allowed = Math.max(0, Math.min(toolCalls.length, remaining));
    const blockedMessage =
      allowed < toolCalls.length
        ? `Tool call limit of ${input.maxToolCalls} reached; this call was not executed.`
        : undefined;

    const turnTools = currentTools ?? input.tools;
    const batch = await executeToolCalls(toolCalls, allowed, blockedMessage, { ...execution, tools: turnTools });
    toolCallsExecuted += allowed;

    for (const r of batch.messages) {
      messages.push(r);
      emit({ type: "message_start", message: r });
      emit({ type: "message_end", message: r });
    }
    const toolResults = [...existingResults, ...batch.messages];
    emit({ type: "turn_end", message: assistantMessage, toolResults, usage: turnUsage });
    steps.push({ turn: turns, message: assistantMessage, toolResults, usage: turnUsage });

    let stop: AgentEndReason | undefined = batch.terminate
      ? "terminated"
      : allowed < toolCalls.length
        ? "max_tool_calls"
        : undefined;
    if (!stop && stopConditions.length > 0) {
      try {
        for (const condition of stopConditions) {
          if (await condition({ steps: steps.slice(), totalUsage: cloneUsage(totalUsage) })) {
            stop = "stop_condition";
            break;
          }
        }
      } catch (err) {
        stop = "error";
        errorMessage = `stopWhen failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    stop ??= limitReached();
    if (stop) return stop;
    if (!(await checkpoint(snapshot()))) return "error";
    emit({ type: "turn_start" });
    return undefined;
  };

  const limitReached = (): AgentEndReason | undefined =>
    input.maxTurns !== undefined && turns >= input.maxTurns
      ? "max_turns"
      : budgetReached(input.budget, totalUsage)
        ? "budget"
        : undefined;

  // Tools offered on the latest model call (prepareStep may narrow them);
  // pending calls from a saved state run against the full tool list.
  let currentTools: AgentTool<any>[] | undefined;

  // 1. Pending tool calls from a saved conversation (pause or crash in the
  //    middle of a batch): run only the calls that have no result yet.
  const pending = findPendingToolCalls(messages);
  if (pending) {
    reason = await finishTurn(pending.message, pending.missing, emptyUsage(), pending.existingResults);
  }

  // 2. The new user turn.
  if (reason === undefined && input.prompt !== undefined) {
    const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: input.prompt }];
    if (input.images?.length) userContent.push(...input.images);
    const userMessage: Message = { role: "user", content: userContent, timestamp: Date.now() };
    messages.push(userMessage);
    emit({ type: "message_start", message: userMessage });
    emit({ type: "message_end", message: userMessage });
  }

  // 3. A finished conversation with nothing new to answer ends at once.
  if (reason === undefined) {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.content.some((c) => c.type === "toolCall")) reason = "completed";
  }

  // 4. Limits already used up by earlier invocations: no further model call.
  if (reason === undefined && turns > 0) reason = limitReached();

  while (reason === undefined) {
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
    currentTools = stepTools;
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

    reason = await finishTurn(assistantMessage, toolCalls, turnUsage, []);
  }

  let finalState = snapshot(reason);
  if (!(await checkpoint(finalState))) {
    reason = "error";
    finalState = snapshot(reason);
  }

  emit({
    type: "agent_end",
    messages,
    reason,
    usage: totalUsage,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    state: finalState,
  });

  const result: RunResult = {
    state: finalState,
    reason,
    usage: cloneUsage(totalUsage),
    messages: messages.slice(),
    text: lastAssistantText(messages),
  };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  return result;
}

// ---------------------------------------------------------------------------
// Starting transcript
// ---------------------------------------------------------------------------

function validateStart(input: ToolAgentRunInput): void {
  if (input.resumeFrom !== undefined && input.messages !== undefined) {
    throw new RangeError("Pass either messages or resumeFrom, not both");
  }
  if (input.prompt === undefined && input.messages === undefined && input.resumeFrom === undefined) {
    throw new RangeError("One of prompt, messages or resumeFrom is required");
  }
  if (input.images?.length && input.prompt === undefined) {
    throw new RangeError("images require a prompt to attach them to");
  }
}

function isFailedReply(message: Message | undefined): boolean {
  return message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

/**
 * The last assistant message's tool calls that have no result yet, when only
 * tool results follow it. Undefined when nothing is pending.
 */
function findPendingToolCalls(
  messages: Message[],
): { message: AssistantMessage; missing: ToolCall[]; existingResults: ToolResultMessage[] } | undefined {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === "toolResult") index--;
  const message = messages[index];
  if (message?.role !== "assistant") return undefined;
  const existingResults = messages.slice(index + 1) as ToolResultMessage[];
  const answered = new Set(existingResults.map((r) => r.toolCallId));
  const missing = message.content.filter((c): c is ToolCall => c.type === "toolCall" && !answered.has(c.id));
  return missing.length > 0 ? { message, missing, existingResults } : undefined;
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
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

function cloneUsage(usage: AgentUsage): AgentUsage {
  return { ...usage, cost: { ...usage.cost } };
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
