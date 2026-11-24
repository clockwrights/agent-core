import type { AgentEvent, AgentTool } from "@maya-ai/tool-agent-runtime";
import type { ToolAgentInput, ToolAgentLimits, ToolAgentOutput, ToolLlmAdapter } from "./toolAgentTypes.js";

// Core boundary: keep this module domain-neutral. App-specific prompts, files,
// retry heuristics, state commits, and rendering belong in adapters.
export interface ToolAgentLoopRetry {
  shouldRetry(output: ToolAgentOutput | undefined): boolean;
  buildRetryPrompt(): string;
  sessionId?: string;
  maxTokens?: number;
}

export interface ToolAgentLoopProgressMessages {
  start?: string;
  retry?: string;
}

export interface ToolAgentLoopInput extends ToolAgentLimits {
  llm: ToolLlmAdapter;
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  tools: AgentTool<any>[];
  maxTokens?: number;
  retry?: ToolAgentLoopRetry;
  progressMessages?: ToolAgentLoopProgressMessages;
  onProgress?: (message: string) => void;
  /** Cooperative cancellation forwarded to the adapter. */
  signal?: AbortSignal;
  /** Raw runtime events, forwarded to the adapter (both passes). */
  onEvent?: (event: AgentEvent) => void;
  /** Model selector forwarded to the adapter (both passes). */
  model?: string;
  /** Reasoning effort forwarded to the adapter (both passes). */
  reasoning?: ToolAgentInput["reasoning"];
}

export async function runToolAgentLoop(input: ToolAgentLoopInput): Promise<ToolAgentOutput | undefined> {
  const passthrough = optionalPassthrough(input);

  input.onProgress?.(input.progressMessages?.start ?? "Running the agent update");
  const output = await input.llm.runToolAgent({
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    sessionId: input.sessionId,
    tools: input.tools,
    maxTokens: input.maxTokens,
    onProgress: input.onProgress,
    signal: input.signal,
    ...passthrough
  });

  if (!input.retry?.shouldRetry(output)) return output;

  input.onProgress?.(input.progressMessages?.retry ?? "Checking whether the update needs another pass");
  return input.llm.runToolAgent({
    systemPrompt: input.systemPrompt,
    prompt: `${input.prompt}\n\n${input.retry.buildRetryPrompt()}`,
    sessionId: input.retry.sessionId ?? `${input.sessionId}-retry`,
    tools: input.tools,
    maxTokens: input.retry.maxTokens ?? input.maxTokens,
    onProgress: input.onProgress,
    signal: input.signal,
    ...passthrough
  });
}

/** Limits, onEvent, model and reasoning — only the fields the caller set. */
function optionalPassthrough(input: ToolAgentLoopInput): Partial<ToolAgentInput> {
  const out: Partial<ToolAgentInput> = {};
  if (input.maxTurns !== undefined) out.maxTurns = input.maxTurns;
  if (input.maxToolCalls !== undefined) out.maxToolCalls = input.maxToolCalls;
  if (input.budget !== undefined) out.budget = input.budget;
  if (input.toolTimeoutMs !== undefined) out.toolTimeoutMs = input.toolTimeoutMs;
  if (input.maxParallelTools !== undefined) out.maxParallelTools = input.maxParallelTools;
  if (input.onEvent !== undefined) out.onEvent = input.onEvent;
  if (input.model !== undefined) out.model = input.model;
  if (input.reasoning !== undefined) out.reasoning = input.reasoning;
  return out;
}
