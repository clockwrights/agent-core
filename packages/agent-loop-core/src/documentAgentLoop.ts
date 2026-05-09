import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { disposeAgentRuntimeContext, emptyAgentRuntimeContext, type AgentRuntimeContext, type AgentRuntimeContextFactory } from "./runtimeContext.js";
import { runToolAgentLoop, type ToolAgentLoopRetry } from "./toolAgentLoop.js";
import type { ToolAgentOutput, ToolLlmAdapter } from "./toolAgentTypes.js";

// Core boundary: keep this module reusable by any document-like app. Domain
// logic must be supplied by the adapter, not added here.
export interface DocumentAgentPrompt {
  systemPrompt: string;
  prompt: string;
}

/**
 * Approximate prompt-size details supplied when the document loop asks an
 * adapter to compact its prompt.
 */
export interface CompactionHint {
  /** Combined system and user prompt length, measured in JavaScript string characters. */
  estimatedPromptChars: number;
  /**
   * Rough token estimate derived from `estimatedPromptChars` with the common
   * four-characters-per-token heuristic. This is only a planning aid, not an
   * exact tokenizer result.
   */
  estimatedPromptTokens: number;
  /** Agent-loop pass that triggered compaction. Currently only the initial pass can compact. */
  pass: "initial";
}

export interface DocumentAgentLoopProgressMessages {
  prepare?: string;
  start?: string;
  retry?: string;
  finalize?: string;
}

export interface DocumentAgentLoopAdapter<TState, TResult> {
  /** Creates the mutable state used by prompt assembly, tools, retry checks, and finalization. */
  createState(): TState;
  /** Builds the initial document prompt before the core makes the first LLM call. */
  buildPrompt(state: TState, runtimeContext: AgentRuntimeContext): DocumentAgentPrompt;
  /**
   * Character threshold for opt-in prompt compaction. When absent, the core
   * never invokes `compact()`. Units are JavaScript string characters across
   * the assembled system prompt and user prompt.
   */
  compactionThresholdChars?: number;
  /**
   * Returns a smaller replacement prompt when the initial prompt exceeds
   * `compactionThresholdChars`. The core invokes this only for the initial
   * pass, before calling the LLM; retry prompts build on the already selected
   * prompt. The adapter is responsible for returning a prompt that is smaller
   * and still semantically sufficient; the core does not re-compact or enforce
   * a post-compaction size limit.
   */
  compact?(state: TState, runtimeContext: AgentRuntimeContext, hint: CompactionHint): Promise<DocumentAgentPrompt>;
  /** Creates the tools exposed to the LLM for this run. */
  createTools(state: TState, runtimeContext: AgentRuntimeContext): AgentTool<any>[];
  /** Returns the stable session id used by the underlying tool agent runtime. */
  getSessionId(state: TState): string;
  /** Optional maximum response-token budget passed to the LLM runtime. */
  maxTokens?: number;
  /** Optional progress message overrides emitted by the core loop. */
  progressMessages?: DocumentAgentLoopProgressMessages;
  /** Optionally configures a retry pass if the initial tool-agent output is insufficient. */
  getRetry?(state: TState, sessionId: string): ToolAgentLoopRetry;
  /** Applies tool results and returns the adapter-specific final result. */
  finalize(state: TState, output: ToolAgentOutput): Promise<TResult>;
}

export async function runDocumentAgentLoop<TState, TResult>(input: {
  llm: ToolLlmAdapter;
  adapter: DocumentAgentLoopAdapter<TState, TResult>;
  createRuntimeContext?: AgentRuntimeContextFactory<TState>;
  onProgress?: (message: string) => void;
}): Promise<TResult | undefined> {
  if (!input.llm.metadata().enabled) return undefined;

  const state = input.adapter.createState();
  const runtimeContext = (await input.createRuntimeContext?.(state)) ?? emptyAgentRuntimeContext();
  try {
    const tools = input.adapter.createTools(state, runtimeContext);
    let runInput = input.adapter.buildPrompt(state, runtimeContext);
    const estimatedPromptChars = runInput.systemPrompt.length + runInput.prompt.length;
    if (
      input.adapter.compactionThresholdChars !== undefined &&
      input.adapter.compact &&
      estimatedPromptChars > input.adapter.compactionThresholdChars
    ) {
      try {
        runInput = await input.adapter.compact(state, runtimeContext, {
          estimatedPromptChars,
          estimatedPromptTokens: Math.ceil(estimatedPromptChars / 4),
          pass: "initial"
        });
      } catch (error) {
        console.warn("Document prompt compaction failed; continuing with the original prompt.", error);
      }
    }
    const sessionId = input.adapter.getSessionId(state);
    input.onProgress?.(input.adapter.progressMessages?.prepare ?? "Preparing document context");
    const output = await runToolAgentLoop({
      llm: input.llm,
      systemPrompt: runInput.systemPrompt,
      prompt: runInput.prompt,
      sessionId,
      tools,
      maxTokens: input.adapter.maxTokens,
      retry: input.adapter.getRetry?.(state, sessionId),
      progressMessages: {
        start: input.adapter.progressMessages?.start,
        retry: input.adapter.progressMessages?.retry
      },
      onProgress: input.onProgress
    });

    if (!output) return undefined;
    input.onProgress?.(input.adapter.progressMessages?.finalize ?? "Applying document updates");
    return input.adapter.finalize(state, output);
  } finally {
    await disposeAgentRuntimeContext(runtimeContext);
  }
}
