import type { AgentTool, PrepareStep } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { RegisteredTool } from "./toolRegistry.js";

// Core boundary: domain-neutral. Deferred tool loading: large tool catalogs
// stay out of the prompt until the model searches for what it needs.

export const toolSearchToolName = "tool_search";

const MAX_REGEX_CHARS = 200;

export interface ToolSearchOptions {
  /** Names to defer in addition to entries whose metadata has `deferred: true`. */
  deferred?: string[];
  /** Default number of tools returned per search. Default 5. */
  defaultLimit?: number;
}

export interface ToolSearch {
  /** Every tool to pass to the run: always-on, deferred, and `tool_search` (when anything is deferred). */
  tools: AgentTool<any>[];
  /** Registry entries for the same tools (`tool_search` is source "system", risk "read"). */
  definitions: RegisteredTool[];
  /**
   * prepareStep hook that offers the always-on tools, `tool_search` and the
   * deferred tools discovered so far. Discoveries reset at the start of each
   * run (turn 1), so use one instance per concurrently running agent.
   */
  prepareStep: PrepareStep;
  /** Names of deferred tools discovered in the current run. */
  readonly discovered: readonly string[];
  /** Names of all deferred tools. */
  readonly deferredNames: readonly string[];
  reset(): void;
}

/**
 * Hide deferred tools behind a `tool_search` meta-tool. The model sees the
 * always-on tools plus `tool_search`; tools it finds become callable from its
 * next step. Calling a deferred tool before finding it yields a "not found"
 * error result (the step's active tools also bound what can execute).
 * With nothing deferred, the tools are returned unchanged and the hook is a no-op.
 */
export function createToolSearch(definitions: readonly RegisteredTool[], options: ToolSearchOptions = {}): ToolSearch {
  const extraDeferred = new Set(options.deferred ?? []);
  const deferredEntries = definitions.filter((d) => d.metadata.deferred === true || extraDeferred.has(d.tool.name));
  const deferredNames = deferredEntries.map((d) => d.tool.name);
  const alwaysOn = definitions.filter((d) => !deferredNames.includes(d.tool.name)).map((d) => d.tool.name);
  const discovered: string[] = [];
  const index = buildIndex(deferredEntries.map((d) => d.tool));

  if (deferredEntries.length === 0) {
    return {
      tools: definitions.map((d) => d.tool),
      definitions: [...definitions],
      prepareStep: () => undefined,
      discovered,
      deferredNames,
      reset: () => {}
    };
  }

  const searchParameters = Type.Object({
    query: Type.String({ description: "What you need, in a few words (e.g. \"create calendar event\")." }),
    mode: Type.Optional(
      Type.Union([Type.Literal("keyword"), Type.Literal("regex")], {
        description: "\"keyword\" (default) ranks by relevance; \"regex\" matches names and descriptions with a regular expression."
      })
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to load. Default 5." }))
  });

  const searchTool: AgentTool<typeof searchParameters, { matches: string[] }> = {
    name: toolSearchToolName,
    label: "Tool Search",
    description:
      `Search ${deferredEntries.length} additional tools that are not loaded yet. ` +
      "Matching tools become callable on your next step. Search before concluding that no tool can help.",
    parameters: searchParameters,
    execute: async (_toolCallId, { query, mode, limit }) => {
      const max = limit ?? options.defaultLimit ?? 5;
      const matches = mode === "regex" ? regexSearch(index, query, max) : keywordSearch(index, query, max);
      for (const entry of matches) if (!discovered.includes(entry.tool.name)) discovered.push(entry.tool.name);
      const text = matches.length
        ? `Loaded ${matches.length} tool(s); they are callable from your next step:\n` +
          matches.map((entry) => `- ${entry.tool.name}: ${entry.tool.description}${paramsHint(entry.tool)}`).join("\n")
        : `No tools match "${query}". Try other words or mode "regex".`;
      return { content: [{ type: "text", text }], details: { matches: matches.map((entry) => entry.tool.name) } };
    }
  };

  return {
    tools: [...definitions.map((d) => d.tool), searchTool],
    definitions: [...definitions, { tool: searchTool, metadata: { source: "system", risk: "read" } }],
    prepareStep: ({ turn, steps }) => {
      if (turn === 1 && steps.length === 0) discovered.length = 0;
      return { activeTools: [...alwaysOn, toolSearchToolName, ...discovered] };
    },
    discovered,
    deferredNames,
    reset: () => {
      discovered.length = 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Search (BM25 keyword ranking and regex)
// ---------------------------------------------------------------------------

interface IndexedTool {
  tool: AgentTool<any>;
  terms: string[];
  haystack: string;
}

interface SearchIndex {
  entries: IndexedTool[];
  documentFrequency: Map<string, number>;
  averageLength: number;
}

function buildIndex(tools: AgentTool<any>[]): SearchIndex {
  const entries = tools.map((tool) => {
    const params = parameterNames(tool);
    // The name counts twice: it is the strongest signal.
    const terms = [...tokenize(tool.name), ...tokenize(tool.name), ...tokenize(tool.description), ...params.flatMap(tokenize)];
    return { tool, terms, haystack: `${tool.name}\n${tool.description}` };
  });
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) {
    for (const term of new Set(entry.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageLength = entries.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, entries.length);
  return { entries, documentFrequency, averageLength };
}

function keywordSearch(index: SearchIndex, query: string, limit: number): IndexedTool[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const n = index.entries.length;
  const scored = index.entries.map((entry) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = entry.terms.filter((t) => t === term || (term.length >= 4 && t.startsWith(term))).length;
      if (frequency === 0) continue;
      const df = index.documentFrequency.get(term) ?? 1;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * entry.terms.length) / index.averageLength));
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, c) => c.score - a.score || a.entry.tool.name.localeCompare(c.entry.tool.name))
    .slice(0, limit)
    .map((s) => s.entry);
}

function regexSearch(index: SearchIndex, pattern: string, limit: number): IndexedTool[] {
  if (pattern.length > MAX_REGEX_CHARS) throw new Error(`Regex is longer than ${MAX_REGEX_CHARS} characters.`);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
  return index.entries.filter((entry) => regex.test(entry.haystack)).slice(0, limit);
}

/** Lowercase words; splits camelCase, snake_case, kebab-case and dots. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function parameterNames(tool: AgentTool<any>): string[] {
  const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties ? Object.keys(properties) : [];
}

function paramsHint(tool: AgentTool<any>): string {
  const names = parameterNames(tool);
  return names.length ? ` (parameters: ${names.join(", ")})` : "";
}
