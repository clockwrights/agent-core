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
import {
  estimateContextTokens,
  isOverflowReply,
  performCompaction,
  resolveCompaction,
  type CompactionOptions,
} from "./compaction.js";
import { ToolTimeoutError } from "./errors.js";
import { hashArguments, parseRunState, RUN_STATE_VERSION, type RunState, type ToolInterruption } from "./runState.js";
import { selectActiveTools, type PrepareStep, type StopCondition } from "./steps.js";
import {
  AGENT_EVENT_VERSION,
  type AfterToolCallContext,
  type AgentEndReason,
  type AgentEvent,
  type AgentMessage,
  type BeforeToolCallContext,
  type ToolApproval,
  type ToolCallDecision,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolResultOverride,
  type AgentStep,
  type AgentTool,
  type AgentToolResult,
  type AgentUsage,
  type CompactionRecord,
  type CompactionTrigger,
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
  /**
   * Decides each tool call before it runs: allow (also `undefined`), deny
   * (error result to the model) or ask (the run ends "interrupted" and the
   * batch waits for `approvals`). Runs only for calls with valid arguments
   * within `maxToolCalls`. A throw ends the run with reason "error" before
   * any tool of the batch runs.
   */
  beforeToolCall?: (context: BeforeToolCallContext) => ToolCallDecision | undefined | Promise<ToolCallDecision | undefined>;
  /**
   * Sees every executed call's result (including thrown errors and
   * timeouts) and may replace content, details, isError or terminate. A
   * throw replaces that result with an error and ends the run with reason
   * "error" after the batch.
   */
  afterToolCall?: (context: AfterToolCallContext) => ToolResultOverride | undefined | Promise<ToolResultOverride | undefined>;
  /**
   * Human decisions for the calls in `resumeFrom.interruptions`, keyed by
   * tool-call id. An approved call runs without `beforeToolCall`; a rejected
   * one gets an error result. An approval only applies while the call's
   * arguments still match the recorded hash. Ids not in
   * `resumeFrom.interruptions` are a RangeError.
   */
  approvals?: Record<string, ToolApproval>;
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
  /**
   * Opt-in compaction: before each model call, when the estimated prompt
   * reaches the trigger (default 85% of the context window), older turns are
   * replaced by a summary in the run's transcript. Emits `compact_boundary`
   * (or `compaction_failed`); records each compaction in `RunState.compactions`.
   * Absent: never compacts.
   */
  compaction?: CompactionOptions;
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
  validateApprovals(input.approvals, resumeFrom);
  const compaction = input.compaction === undefined ? undefined : resolveCompaction(input.compaction, input.model, input.maxTokens);

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
    sessionId: input.sessionId,
  };

  const totalUsage = resumeFrom ? cloneUsage(resumeFrom.usage) : emptyUsage();
  const steps: AgentStep[] = [];
  const stopConditions = input.stopWhen === undefined ? [] : [input.stopWhen].flat();
  let turns = resumeFrom?.turns ?? 0;
  let toolCallsExecuted = resumeFrom?.toolCallsExecuted ?? 0;
  let reason: AgentEndReason | undefined;
  let errorMessage: string | undefined;
  const compactions: CompactionRecord[] = resumeFrom?.compactions?.map((record) => ({ ...record })) ?? [];
  let compactionFailures = 0;
  let compactionOff = false;

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
    if (end === "interrupted" && interruptions) state.interruptions = interruptions.map((i) => ({ ...i }));
    if (compactions.length > 0) state.compactions = compactions.map((record) => ({ ...record }));
    return state;
  };

  /**
   * Compact the transcript before the next model call when it is over the
   * trigger ("threshold") or the last call overflowed ("overflow"). Fails
   * open: a failing summariser emits `compaction_failed` and the run goes on;
   * after 2 failures in a row compaction is off for this invocation.
   */
  const maybeCompact = async (trigger: CompactionTrigger): Promise<"compacted" | "skipped" | "aborted"> => {
    if (!compaction || compactionOff) return "skipped";
    const usageFrom = compactions[compactions.length - 1]?.messageCount ?? 0;
    const tokensBefore = estimateContextTokens({ messages, systemPrompt: input.systemPrompt, tools: input.tools, usageFrom });
    if (trigger === "threshold" && tokensBefore < compaction.threshold) return "skipped";
    let result;
    try {
      result = await performCompaction({
        messages,
        options: compaction,
        trigger,
        turn: turns + 1,
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        streamOptions,
        tokensBefore,
        usageFrom,
      });
    } catch (err) {
      if (input.signal?.aborted) return "aborted";
      compactionFailures += 1;
      if (compactionFailures >= 2) compactionOff = true;
      emit({ type: "compaction_failed", trigger, turn: turns + 1, error: err instanceof Error ? err.message : String(err) });
      return "skipped";
    }
    if (!result) return "skipped";
    compactionFailures = 0;
    messages.splice(0, messages.length, ...result.messages);
    addUsage(totalUsage, result.usage);
    compactions.push(result.record);
    emit({
      type: "compact_boundary",
      trigger,
      turn: result.record.turn,
      tokensBefore: result.record.tokensBefore,
      tokensAfter: result.record.tokensAfter,
      removedMessages: result.record.removedMessages,
      summaryIndex: result.record.summaryIndex,
      keptMessages: messages.length,
      summary: result.summary,
      usage: cloneUsage(result.usage),
    });
    return "compacted";
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

    // Decide every call before any tool runs (approval hooks see the whole
    // batch; a single "ask" holds the batch).
    const plans: CallPlan[] = [];
    const asks: ToolInterruption[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (i >= allowed) {
        plans.push({ tc, kind: "error", result: errorResult(blockedMessage!), counts: false });
        continue;
      }
      const prep = prepareTool(tc, turnTools);
      if (prep.kind === "error") {
        // Unknown tools and invalid arguments count as executions (unchanged).
        plans.push({ tc, kind: "error", result: prep.result, counts: true });
        continue;
      }
      const args = prep.args as Record<string, unknown>;
      let decision: ToolCallDecision | undefined;
      const approval = approvalFor(tc.id, args);
      if (approval) {
        decision = approval.approve
          ? { action: "allow" }
          : { action: "deny", message: approval.message ? `Denied by the approver: ${approval.message}` : "Denied by the approver." };
      } else if (input.beforeToolCall) {
        try {
          decision =
            (await input.beforeToolCall({
              toolCall: { id: tc.id, name: tc.name, arguments: args },
              tool: prep.tool,
              turn: turns,
              messages: messages.slice(),
              signal: input.signal,
            })) ?? undefined;
        } catch (err) {
          // Fail closed: nothing in the batch runs; the calls stay pending.
          errorMessage = `beforeToolCall failed: ${err instanceof Error ? err.message : String(err)}`;
          emit({ type: "turn_end", message: assistantMessage, toolResults: existingResults, usage: turnUsage });
          return "error";
        }
      }
      if (decision?.action === "deny") {
        plans.push({ tc, kind: "error", result: errorResult(decision.message ?? "Tool call denied"), counts: false });
      } else if (decision?.action === "ask") {
        const interruption: ToolInterruption = {
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: args,
          argumentsHash: hashArguments(args),
        };
        if (decision.reason !== undefined) interruption.reason = decision.reason;
        if (decision.data !== undefined) interruption.data = decision.data;
        asks.push(interruption);
        plans.push({ tc, kind: "held" });
      } else {
        plans.push({ tc, kind: "run", tool: prep.tool, args, counts: true });
      }
    }

    const record = (results: ToolResultMessage[]) => {
      for (const r of results) {
        messages.push(r);
        emit({ type: "message_start", message: r });
        emit({ type: "message_end", message: r });
      }
    };

    if (asks.length > 0) {
      // Nothing runs while a call waits for a human. Final error results
      // (denied, blocked, invalid) are recorded now; allowed calls stay
      // pending and are decided again on resume.
      const finalPlans = plans.filter((p): p is ErrorPlan => p.kind === "error");
      const early = await executeToolCalls(finalPlans, { ...execution, tools: turnTools, turn: turns, request: currentRequest, failures: [] });
      toolCallsExecuted += finalPlans.filter((p) => p.counts).length;
      record(early.messages);
      for (const ask of asks) {
        emit({
          type: "tool_approval_requested",
          toolCallId: ask.toolCallId,
          toolName: ask.toolName,
          args: ask.arguments,
          ...(ask.reason !== undefined ? { reason: ask.reason } : {}),
          ...(ask.data !== undefined ? { data: ask.data } : {}),
        });
      }
      interruptions = asks;
      emit({ type: "turn_end", message: assistantMessage, toolResults: [...existingResults, ...early.messages], usage: turnUsage });
      return "interrupted";
    }

    const failures: string[] = [];
    const runnable = plans as Array<ErrorPlan | RunPlan>;
    const batch = await executeToolCalls(runnable, {
      ...execution,
      tools: turnTools,
      turn: turns,
      request: currentRequest,
      afterToolCall: input.afterToolCall,
      failures,
    });
    toolCallsExecuted += runnable.filter((p) => p.counts).length;

    record(batch.messages);
    const toolResults = [...existingResults, ...batch.messages];
    emit({ type: "turn_end", message: assistantMessage, toolResults, usage: turnUsage });
    steps.push({ turn: turns, message: assistantMessage, toolResults, usage: turnUsage });

    if (failures.length > 0) {
      errorMessage = failures[0];
      return "error";
    }

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
  // The latest model request, passed to tools as `context.request`.
  let currentRequest: ToolExecutionRequest | undefined;
  // Calls waiting for a human decision when the run ends "interrupted".
  let interruptions: ToolInterruption[] | undefined;

  /** The caller's decision for an interrupted call, if it still applies. */
  const approvalFor = (toolCallId: string, args: Record<string, unknown>): ToolApproval | undefined => {
    const approval = input.approvals?.[toolCallId];
    if (!approval) return undefined;
    const recorded = resumeFrom?.interruptions?.find((i) => i.toolCallId === toolCallId);
    // Arguments changed since the approver saw them: the approval does not apply.
    if (!recorded || recorded.argumentsHash !== hashArguments(args)) return undefined;
    return approval;
  };

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

  // At most one compaction per model call, and one overflow retry per call.
  let compactedForThisCall = false;
  let overflowRetried = false;

  while (reason === undefined) {
    if (compaction && !compactedForThisCall) {
      const outcome = await maybeCompact("threshold");
      if (outcome === "aborted") {
        reason = "aborted";
        errorMessage = "Aborted during compaction";
        break;
      }
      if (outcome === "compacted") {
        compactedForThisCall = true;
        // The summariser's tokens count toward the budget.
        if (budgetReached(input.budget, totalUsage)) {
          reason = "budget";
          break;
        }
      }
    }

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

    // Context too long: compact and retry this call once. The failed reply
    // is not kept and is not a turn; its usage still counts.
    if (
      compaction?.onOverflow === "compact" &&
      !overflowRetried &&
      isOverflowReply(assistantMessage, compaction.window)
    ) {
      overflowRetried = true;
      const outcome = await maybeCompact("overflow");
      if (outcome === "compacted" || outcome === "aborted") {
        addUsage(totalUsage, usageOf(assistantMessage));
        if (outcome === "aborted") {
          reason = "aborted";
          errorMessage = "Aborted during compaction";
          break;
        }
        compactedForThisCall = true;
        if (budgetReached(input.budget, totalUsage)) {
          reason = "budget";
          break;
        }
        continue;
      }
    }

    compactedForThisCall = false;
    overflowRetried = false;
    currentRequest = {
      model: prepared?.model ?? input.model,
      ...(stepStreamOptions.reasoning !== undefined ? { reasoning: stepStreamOptions.reasoning } : {}),
      systemPrompt: context.systemPrompt ?? "",
      tools: Object.freeze(stepTools.slice()),
      messages: Object.freeze(context.messages),
    };
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

function validateApprovals(approvals: ToolAgentRunInput["approvals"], resumeFrom: RunState | undefined): void {
  if (approvals === undefined) return;
  for (const [toolCallId, approval] of Object.entries(approvals)) {
    if (!resumeFrom?.interruptions?.some((i) => i.toolCallId === toolCallId)) {
      throw new RangeError(`approvals: "${toolCallId}" is not an interrupted tool call of resumeFrom`);
    }
    if (!approval || typeof approval.approve !== "boolean") {
      throw new RangeError(`approvals: "${toolCallId}" needs { approve: true } or { approve: false, message? }`);
    }
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
  sessionId: string | undefined;
  /** Turn number reported to tools and `afterToolCall`. */
  turn?: number;
  /** The model request that produced the batch, if any. */
  request?: ToolExecutionRequest;
}

interface BatchOptions extends ToolExecutionOptions {
  turn: number;
  afterToolCall?: ToolAgentRunInput["afterToolCall"];
  /** Collects `afterToolCall` failure messages. */
  failures: string[];
}

/** What to do with one tool call of a batch. */
type ErrorPlan = { tc: ToolCall; kind: "error"; result: AgentToolResult<any>; counts: boolean };
type RunPlan = { tc: ToolCall; kind: "run"; tool: AgentTool<any>; args: Record<string, unknown>; counts: true };
type HeldPlan = { tc: ToolCall; kind: "held" };
type CallPlan = ErrorPlan | RunPlan | HeldPlan;

interface ToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

type ToolOutcome = { tc: ToolCall; result: AgentToolResult<any>; isError: boolean };

/**
 * Execute a batch of planned calls: run plans execute the tool, error plans
 * (blocked, denied, invalid) produce their error result without running.
 */
async function executeToolCalls(plans: Array<ErrorPlan | RunPlan>, options: BatchOptions): Promise<ToolBatch> {
  const tasks = plans.map((plan) => () => executeOne(plan, options));
  const isSequential = plans.map(
    (plan) => options.tools.find((t) => t.name === plan.tc.name)?.executionMode === "sequential",
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

async function executeOne(plan: ErrorPlan | RunPlan, options: BatchOptions): Promise<ToolOutcome> {
  const { emit } = options;
  const { tc } = plan;
  emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });

  let { result, isError } =
    plan.kind === "error" ? { result: plan.result, isError: true } : await runTool(plan.tool, tc, plan.args, options);

  if (plan.kind === "run" && options.afterToolCall) {
    try {
      const override = await options.afterToolCall({
        toolCall: { id: tc.id, name: tc.name, arguments: plan.args },
        tool: plan.tool,
        result,
        isError,
        turn: options.turn,
      });
      if (override) ({ result, isError } = applyOverride(result, isError, override));
    } catch (err) {
      // Fail closed: the unfiltered result never reaches the transcript.
      const message = `afterToolCall failed: ${err instanceof Error ? err.message : String(err)}`;
      options.failures.push(message);
      result = errorResult(message);
      isError = true;
    }
  }

  emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
  return { tc, result, isError };
}

function applyOverride(
  result: AgentToolResult<any>,
  isError: boolean,
  override: ToolResultOverride,
): { result: AgentToolResult<any>; isError: boolean } {
  const next: AgentToolResult<any> = { ...result };
  if (override.content !== undefined) next.content = override.content;
  if (override.details !== undefined) next.details = override.details;
  if (override.terminate !== undefined) next.terminate = override.terminate;
  return { result: next, isError: override.isError ?? isError };
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

  const context: ToolExecutionContext = { toolCallId: tc.id, turn: options.turn ?? 0 };
  if (options.sessionId !== undefined) context.sessionId = options.sessionId;
  if (options.request !== undefined) context.request = options.request;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === undefined) {
      const result = await tool.execute(tc.id, args as never, options.signal, onUpdate, context);
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
    const result = await Promise.race([tool.execute(tc.id, args as never, signal, onUpdate, context), timeout]);
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
