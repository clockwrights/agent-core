import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import { Type, type TSchema } from "typebox";

// Core boundary: domain-neutral. Caps how much tool output reaches the model
// and, optionally, keeps the full text so the model can page through it.

export const readToolOutputToolName = "read_tool_output";

/** Default page size for `read_tool_output` when the model gives no limit. */
const DEFAULT_READ_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Output store
// ---------------------------------------------------------------------------

/** Holds full text of truncated tool results, keyed by tool call id. */
export interface ToolOutputStore {
  put(id: string, text: string): void;
  get(id: string): string | undefined;
  readonly size: number;
}

export interface ToolOutputStoreOptions {
  /** Maximum stored outputs; the oldest is evicted first. Default 100. */
  maxEntries?: number;
}

export function createToolOutputStore(options: ToolOutputStoreOptions = {}): ToolOutputStore {
  const maxEntries = options.maxEntries ?? 100;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const entries = new Map<string, string>();
  return {
    put(id, text) {
      entries.delete(id);
      entries.set(id, text);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
    get: (id) => entries.get(id),
    get size() {
      return entries.size;
    }
  };
}

// ---------------------------------------------------------------------------
// Result limiting
// ---------------------------------------------------------------------------

export interface ToolResultLimitOptions {
  /** Maximum characters of text content passed to the model per call. */
  maxChars: number;
  /**
   * When set, the full text of a truncated result is stored under the tool
   * call id and the truncation notice tells the model how to read the rest
   * with the `read_tool_output` tool (register it with
   * `createReadToolOutputTool(store)`).
   */
  store?: ToolOutputStore;
}

/** Details added to a truncated result, merged into the tool's own details when they are an object. */
export interface ToolResultTruncation {
  truncated: true;
  totalChars: number;
  shownChars: number;
  /** Present when the full text was stored. */
  outputId?: string;
}

/**
 * Wrap a tool so the text content of its result is capped at `maxChars`.
 * Text parts are kept in order until the budget is used up; image parts are
 * passed through unchanged. Results within the limit are returned untouched.
 */
export function limitToolResult<P extends TSchema, D>(tool: AgentTool<P, D>, options: ToolResultLimitOptions): AgentTool<P, D> {
  const { maxChars, store } = options;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  }
  return {
    ...tool,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => {
      const result = await tool.execute(toolCallId, params as never, signal, onUpdate as never);
      return truncateResult(result, toolCallId, maxChars, store);
    }
  } as AgentTool<P, D>;
}

function truncateResult(
  result: AgentToolResult<any>,
  toolCallId: string,
  maxChars: number,
  store: ToolOutputStore | undefined
): AgentToolResult<any> {
  const fullText = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (fullText.length <= maxChars) return result;

  let budget = maxChars;
  const content: AgentToolResult<any>["content"] = [];
  for (const part of result.content) {
    if (part.type !== "text") {
      content.push(part);
      continue;
    }
    if (budget <= 0) continue;
    const text = part.text.slice(0, budget);
    budget -= text.length;
    content.push({ ...part, text });
  }

  if (store) store.put(toolCallId, fullText);
  const notice = store
    ? `[Output truncated: showing characters 0-${maxChars} of ${fullText.length}. ` +
      `To read more, call ${readToolOutputToolName} with {"id": ${JSON.stringify(toolCallId)}, "offset": ${maxChars}}.]`
    : `[Output truncated: showing the first ${maxChars} of ${fullText.length} characters.]`;
  content.push({ type: "text", text: `\n\n${notice}` });

  const truncation: ToolResultTruncation = {
    truncated: true,
    totalChars: fullText.length,
    shownChars: maxChars,
    ...(store ? { outputId: toolCallId } : {})
  };
  const details =
    result.details && typeof result.details === "object" && !Array.isArray(result.details)
      ? { ...result.details, truncation }
      : result.details === undefined || result.details === null
        ? { truncation }
        : result.details;

  return { ...result, content, details };
}

// ---------------------------------------------------------------------------
// read_tool_output
// ---------------------------------------------------------------------------

const readToolOutputParameters = Type.Object({
  id: Type.String({ description: "The id given in the truncation notice." }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to start reading from. Default 0." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return." }))
});

export interface ReadToolOutputDetails {
  id: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
}

/** Tool that pages through outputs stored by `limitToolResult`. Register it with risk "read". */
export function createReadToolOutputTool(
  store: ToolOutputStore,
  options: { defaultLimit?: number } = {}
): AgentTool<typeof readToolOutputParameters, ReadToolOutputDetails> {
  const defaultLimit = options.defaultLimit ?? DEFAULT_READ_LIMIT;
  return {
    name: readToolOutputToolName,
    label: "Read tool output",
    description:
      "Read more of a tool result that was truncated. Use the id and offset given in the truncation notice.",
    parameters: readToolOutputParameters,
    execute: async (_toolCallId, { id, offset = 0, limit = defaultLimit }) => {
      const text = store.get(id);
      if (text === undefined) {
        throw new Error(`No stored output for id ${JSON.stringify(id)}; it may have expired.`);
      }
      const slice = text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const more =
        end < text.length
          ? `\n\n[Showing characters ${offset}-${end} of ${text.length}. Continue with {"id": ${JSON.stringify(id)}, "offset": ${end}}.]`
          : `\n\n[End of output: characters ${offset}-${end} of ${text.length}.]`;
      return {
        content: [{ type: "text", text: slice + more }],
        details: { id, offset, returnedChars: slice.length, totalChars: text.length }
      };
    }
  };
}
