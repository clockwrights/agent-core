import type { AgentMessage, PrepareStep } from "@maya-ai/tool-agent-runtime";
import { memoryGetToolName, memorySearchToolName } from "./memory/memoryTools.js";
import { readToolOutputToolName, type ToolOutputStore } from "./toolResultLimits.js";

// Core boundary: domain-neutral. Context editing: replace stale tool results
// with short stubs in what the model sees, without touching the transcript.

/** Tools whose results are never cleared by default (memory and skill reads). */
export const DEFAULT_CLEARING_EXCLUDED_TOOLS: readonly string[] = [memorySearchToolName, memoryGetToolName, "read_skill"];

export interface ToolResultClearingOptions {
  /** Tool turns (turns that called tools) whose results always stay intact, counted from the newest. Default 3. */
  keepRecentTurns?: number;
  /**
   * The clearing boundary moves in steps of this many tool turns, so the
   * prompt prefix stays identical between steps and the provider's prompt
   * cache keeps hitting. Default 5. Use 1 to clear as soon as a turn ages out.
   */
  batchTurns?: number;
  /** Results shorter than this (text characters) are kept. Default 200. */
  minChars?: number;
  /** Tool names never cleared. Default `DEFAULT_CLEARING_EXCLUDED_TOOLS`. */
  excludeTools?: readonly string[];
  /**
   * When set, the full text of each cleared result is stored under its tool
   * call id and the stub tells the model to call `read_tool_output` to get it
   * back (register `createReadToolOutputTool(store)`).
   */
  store?: ToolOutputStore;
}

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * A `prepareStep` hook that clears old tool results in the messages sent to
 * the model. Older tool turns beyond `keepRecentTurns` have their text
 * results replaced by a stub naming the tool and the size removed (and, with
 * a store, how to read it back). Image parts are dropped from cleared
 * results too. Error results, excluded tools and short results are kept.
 * Returns no override until at least one batch of turns is clearable.
 */
export function createToolResultClearing(options: ToolResultClearingOptions = {}): PrepareStep {
  const keepRecentTurns = checkCount("keepRecentTurns", options.keepRecentTurns ?? 3, 0);
  const batchTurns = checkCount("batchTurns", options.batchTurns ?? 5, 1);
  const minChars = checkCount("minChars", options.minChars ?? 200, 0);
  const excluded = new Set(options.excludeTools ?? DEFAULT_CLEARING_EXCLUDED_TOOLS);
  const store = options.store;

  return ({ messages }) => {
    // Tool turns: index of each assistant message that called tools.
    const toolTurnStarts: number[] = [];
    messages.forEach((message, index) => {
      if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) {
        toolTurnStarts.push(index);
      }
    });

    const clearable = toolTurnStarts.length - keepRecentTurns;
    const turnsToClear = clearable > 0 ? Math.floor(clearable / batchTurns) * batchTurns : 0;
    if (turnsToClear === 0) return undefined;

    // Everything before the first kept tool turn is eligible.
    const cutoff = toolTurnStarts[turnsToClear] ?? messages.length;
    let changed = false;
    const edited = messages.map((message, index) => {
      if (index >= cutoff || message.role !== "toolResult") return message;
      const cleared = clearResult(message, excluded, minChars, store);
      if (cleared !== message) changed = true;
      return cleared;
    });
    return changed ? { messages: edited } : undefined;
  };
}

function clearResult(
  message: ToolResult,
  excluded: Set<string>,
  minChars: number,
  store: ToolOutputStore | undefined
): AgentMessage {
  if (message.isError || excluded.has(message.toolName)) return message;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  const hasImages = message.content.some((part) => part.type === "image");
  if (text.length < minChars && !hasImages) return message;

  if (store) store.put(message.toolCallId, text);
  const removed = `${text.length} characters${hasImages ? " and images" : ""}`;
  const stub = store
    ? `[Earlier ${message.toolName} result cleared to save context (${removed}). ` +
      `To read it again, call ${readToolOutputToolName} with {"id": ${JSON.stringify(message.toolCallId)}}.]`
    : `[Earlier ${message.toolName} result cleared to save context (${removed}). Call the tool again if you need it.]`;
  return { ...message, content: [{ type: "text", text: stub }] };
}

function checkCount(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
  return value;
}
