import {
  runToolAgent,
  type AgentEvent,
  type AgentMessage,
  type ToolAgentRunInput
} from "@maya-ai/tool-agent-runtime";
import type {
  ToolAgentInput,
  ToolAgentLimits,
  ToolAgentOutput,
  ToolLlmAdapter
} from "./toolAgentTypes.js";

// Core boundary: domain-neutral. Maps the ToolLlmAdapter contract onto the
// in-house tool-agent-runtime so consumers do not each re-implement it.

export interface RuntimeToolLlmAdapterOptions {
  /**
   * The model to run, or a function choosing one per call. Use the function
   * form to honour `input.model` (for example by resolving it through an
   * llm-profiles router); a fixed model ignores `input.model`.
   */
  model: ToolAgentRunInput["model"] | ((input: ToolAgentInput) => ToolAgentRunInput["model"]);
  apiKey?: string;
  /** Default reasoning level; `input.reasoning` overrides it per call. */
  reasoning?: ToolAgentRunInput["reasoning"];
  transport?: ToolAgentRunInput["transport"];
  /**
   * Applied when a call leaves the field unset. `maxTurns` defaults to
   * `DEFAULT_ADAPTER_MAX_TURNS` (50) so a model stuck in a tool loop cannot
   * run forever; set `defaults.maxTurns` to change it, or include the key
   * with value `undefined` (`{ maxTurns: undefined }`) for no cap.
   */
  defaults?: ToolAgentLimits & { maxTokens?: number };
  /**
   * Per-step hook passed to every run, e.g. `createToolResultClearing()` to
   * clear stale tool results from what the model sees.
   */
  prepareStep?: ToolAgentRunInput["prepareStep"];
  /**
   * Progress message emitted through `onProgress` when a tool starts.
   * Default: `Running <tool label>`. Return undefined to stay silent.
   */
  toolProgressMessage?: (toolLabel: string, toolName: string) => string | undefined;
}

/**
 * A `ToolLlmAdapter` backed by `runToolAgent`.
 *
 * - Forwards prompt, tools, images, signal, session id, `maxTokens` and every
 *   limit (`maxTurns`, `maxToolCalls`, `budget`, `toolTimeoutMs`,
 *   `maxParallelTools`), with `defaults` filling unset fields. Unlike the
 *   bare runtime, runs are capped at `DEFAULT_ADAPTER_MAX_TURNS` model calls
 *   unless `defaults` or the call says otherwise.
 * - `onEvent` receives every runtime event; an exception thrown by it is
 *   reported once per run with `console.warn` and does not stop the run.
 * - Output: `text` is the text of the last assistant message; `toolCalls`
 *   lists every executed or rejected call in call order (errors, timeouts and
 *   calls blocked by `maxToolCalls` have `isError: true`); `usage`, `endReason`,
 *   `errorMessage` and `turns` come from the run; `state` is the run's
 *   serializable state (pass it back as `resumeFrom`). `turns` counts this
 *   call's model calls; `state.turns` counts the whole run.
 * - `messages` / `resumeFrom` are forwarded; with either, an empty `prompt`
 *   means no new user turn.
 * - Errors thrown by the runtime (for example invalid limits) propagate.
 */
/** Turn cap the reference adapter applies when neither the call nor `defaults` sets one. */
export const DEFAULT_ADAPTER_MAX_TURNS = 50;

export function createRuntimeToolLlmAdapter(options: RuntimeToolLlmAdapterOptions): ToolLlmAdapter {
  // An explicit `maxTurns` key in `defaults` (even `undefined`) replaces the built-in cap.
  const defaults: ToolAgentLimits & { maxTokens?: number } = {
    maxTurns: DEFAULT_ADAPTER_MAX_TURNS,
    ...options.defaults
  };
  const toolProgressMessage = options.toolProgressMessage ?? ((label: string) => `Running ${label}`);

  return {
    metadata: () => ({
      enabled: true,
      supports: {
        limits: true,
        usage: true,
        events: true,
        modelSelection: typeof options.model === "function",
        runState: true
      }
    }),

    async runToolAgent(input: ToolAgentInput): Promise<ToolAgentOutput> {
      const model = typeof options.model === "function" ? options.model(input) : options.model;
      const labels = new Map(input.tools.map((tool) => [tool.name, tool.label]));
      // Tool calls are reported in call order. Start order is call order in
      // every batch mode; end events arrive in completion order.
      const startedById = new Map<string, { seq: number; args: unknown }>();
      const finishedCalls: Array<{ seq: number; call: ToolAgentOutput["toolCalls"][number] }> = [];
      let seq = 0;
      let turns = 0;
      const run: { end?: Extract<AgentEvent, { type: "agent_end" }> } = {};
      let onEventFailed = false;

      const emit = (event: AgentEvent) => {
        switch (event.type) {
          case "tool_execution_start": {
            startedById.set(event.toolCallId, { seq: seq++, args: event.args });
            const message = toolProgressMessage(labels.get(event.toolName) ?? event.toolName, event.toolName);
            if (message) input.onProgress?.(message);
            break;
          }
          case "tool_execution_end": {
            const started = startedById.get(event.toolCallId);
            finishedCalls.push({
              seq: started?.seq ?? seq++,
              call: { name: event.toolName, args: started?.args, isError: event.isError }
            });
            break;
          }
          case "turn_end":
            turns += 1;
            break;
          case "agent_end":
            run.end = event;
            break;
        }
        if (input.onEvent && !onEventFailed) {
          try {
            input.onEvent(event);
          } catch (error) {
            onEventFailed = true;
            console.warn("onEvent threw; further events are not forwarded for this run.", error);
          }
        }
      };

      // With a prior conversation, an empty prompt means "no new user turn".
      const continuing = input.messages !== undefined || input.resumeFrom !== undefined;
      const prompt = continuing && input.prompt === "" ? undefined : input.prompt;

      await runToolAgent(
        {
          systemPrompt: input.systemPrompt,
          model,
          reasoning: resolveReasoning(input.reasoning, options.reasoning),
          tools: input.tools,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(input.messages !== undefined ? { messages: input.messages } : {}),
          ...(input.resumeFrom !== undefined ? { resumeFrom: input.resumeFrom } : {}),
          images: input.images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          signal: input.signal,
          apiKey: options.apiKey,
          sessionId: input.sessionId,
          transport: options.transport,
          maxTokens: input.maxTokens ?? defaults.maxTokens,
          maxTurns: input.maxTurns ?? defaults.maxTurns,
          maxToolCalls: input.maxToolCalls ?? defaults.maxToolCalls,
          budget: input.budget ?? defaults.budget,
          toolTimeoutMs: input.toolTimeoutMs ?? defaults.toolTimeoutMs,
          maxParallelTools: input.maxParallelTools ?? defaults.maxParallelTools,
          prepareStep: options.prepareStep
        },
        emit
      );

      const finished = run.end;
      return {
        text: lastAssistantText(finished?.messages ?? []),
        toolCalls: finishedCalls.sort((a, b) => a.seq - b.seq).map((entry) => entry.call),
        ...(finished?.usage ? { usage: finished.usage } : {}),
        ...(finished?.reason ? { endReason: finished.reason } : {}),
        ...(finished?.errorMessage !== undefined ? { errorMessage: finished.errorMessage } : {}),
        // A resumed run's pending batch emits a turn_end without a model call,
        // so derive this call's model calls from the state when it is there.
        turns: finished?.state ? finished.state.turns - (input.resumeFrom?.turns ?? 0) : turns,
        ...(finished?.state ? { state: finished.state } : {})
      };
    }
  };
}

/** Per-call reasoning wins over the adapter default; "off" disables thinking. */
function resolveReasoning(
  perCall: ToolAgentInput["reasoning"],
  fallback: ToolAgentRunInput["reasoning"]
): ToolAgentRunInput["reasoning"] {
  if (perCall === undefined) return fallback;
  return perCall === "off" ? undefined : perCall;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}
