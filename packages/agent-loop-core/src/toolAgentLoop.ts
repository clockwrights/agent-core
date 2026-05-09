import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import type { ToolAgentOutput, ToolLlmAdapter } from "./toolAgentTypes.js";

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

export interface ToolAgentLoopInput {
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
}

export async function runToolAgentLoop(input: ToolAgentLoopInput): Promise<ToolAgentOutput | undefined> {
  input.onProgress?.(input.progressMessages?.start ?? "Running the agent update");
  const output = await input.llm.runToolAgent({
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    sessionId: input.sessionId,
    tools: input.tools,
    maxTokens: input.maxTokens,
    onProgress: input.onProgress,
    signal: input.signal
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
    signal: input.signal
  });
}
