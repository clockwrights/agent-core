import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { RegisteredTool } from "../toolRegistry.js";
import { UNTRUSTED_MEMORY_LABEL } from "./provenance.js";
import type {
  MemoryGetResult,
  MemoryRuntime,
  MemorySearchResult,
  MemorySourceFilter
} from "./memoryTypes.js";

export const memorySearchToolName = "memory_search";
export const memoryGetToolName = "memory_get";

export interface MemorySearchDetails {
  query: string;
  resultCount: number;
  status: "ok" | "error";
}

export interface MemoryGetDetails {
  path: string;
  status: "ok" | "not_found" | "error";
  fromLine?: number;
  lineCount?: number;
  totalLines?: number;
  truncated?: boolean;
}

interface MemorySearchParams {
  query?: string;
  maxResults?: number;
  minScore?: number;
  source?: MemorySourceFilter;
}

interface MemoryGetParams {
  path?: string;
  fromLine?: number;
  lineCount?: number;
  from?: number;
  lines?: number;
}

export function createMemoryToolDefinitions(runtime: MemoryRuntime): RegisteredTool[] {
  const customDefinitions = runtime.createToolDefinitions?.();
  if (customDefinitions?.length) return customDefinitions;
  return [
    {
      tool: createMemorySearchTool(runtime),
      metadata: {
        source: "memory",
        risk: "read"
      }
    },
    {
      tool: createMemoryGetTool(runtime),
      metadata: {
        source: "memory",
        risk: "read"
      }
    }
  ];
}

function createMemorySearchTool(runtime: MemoryRuntime): AgentTool<any, MemorySearchDetails> {
  return {
    name: memorySearchToolName,
    label: "Memory Search",
    description: "Search the configured memory corpus for relevant wiki, raw-source, or session context.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
      minScore: Type.Optional(Type.Number({ description: "Optional minimum score from 0 to 1." })),
      source: Type.Optional(
        Type.Union([
          Type.Literal("wiki"),
          Type.Literal("raw"),
          Type.Literal("sessions"),
          Type.Literal("all")
        ])
      )
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const input = params as MemorySearchParams;
        const query = input.query?.trim();
        if (!query) {
          return jsonResult([], {
            query: "",
            resultCount: 0,
            status: "error"
          });
        }
        const results = await runtime.search({
          query,
          maxResults: input.maxResults,
          minScore: input.minScore,
          source: input.source
        });
        const labelled = results.map((result) =>
          result.origin === "untrusted" ? { ...result, snippet: `${UNTRUSTED_MEMORY_LABEL}\n${result.snippet}` } : result
        );
        return jsonResult(labelled, {
          query,
          resultCount: results.length,
          status: "ok"
        });
      } catch (error) {
        return jsonResult(
          { error: errorMessage(error) },
          {
            query: ((params as MemorySearchParams).query ?? "").trim(),
            resultCount: 0,
            status: "error"
          }
        );
      }
    }
  };
}

function createMemoryGetTool(runtime: MemoryRuntime): AgentTool<any, MemoryGetDetails> {
  return {
    name: memoryGetToolName,
    label: "Memory Get",
    description: "Read a bounded excerpt from one configured memory file by path.",
    parameters: Type.Object({
      path: Type.String({ description: "Memory file path from memory_search or the memory index." }),
      fromLine: Type.Optional(Type.Number({ description: "1-based starting line." })),
      lineCount: Type.Optional(Type.Number({ description: "Number of lines to read." })),
      from: Type.Optional(Type.Number({ description: "Alias for fromLine." })),
      lines: Type.Optional(Type.Number({ description: "Alias for lineCount." }))
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const input = params as MemoryGetParams;
        const path = input.path?.trim();
        if (!path) {
          return textResult("Provide a memory file path.", {
            path: "",
            status: "error"
          });
        }
        const result = await runtime.get({
          path,
          fromLine: input.fromLine ?? input.from,
          lineCount: input.lineCount ?? input.lines
        });
        if (!result) {
          return textResult(`No memory file found at path: ${path}`, {
            path,
            status: "not_found"
          });
        }
        return textResult(formatMemoryGetResult(result), {
          path: result.path,
          status: "ok",
          fromLine: result.fromLine,
          lineCount: result.lineCount,
          totalLines: result.totalLines,
          truncated: result.truncated
        });
      } catch (error) {
        return textResult(errorMessage(error), {
          path: ((params as MemoryGetParams).path ?? "").trim(),
          status: "error"
        });
      }
    }
  };
}

function formatMemoryGetResult(result: MemoryGetResult): string {
  const header = [
    `Path: ${result.path}`,
    `Source: ${result.source}`,
    `Lines: ${result.fromLine}-${result.fromLine + result.lineCount - 1} of ${result.totalLines}`
  ].join("\n");
  const suffix = result.truncated ? "\n\n[Truncated]" : "";
  const label = result.origin === "untrusted" ? `${UNTRUSTED_MEMORY_LABEL}\n\n` : "";
  return `${header}\n\n${label}${result.content}${suffix}`;
}

function jsonResult(
  value: MemorySearchResult[] | Record<string, unknown>,
  details: MemorySearchDetails
): AgentToolResult<MemorySearchDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details
  };
}

function textResult(text: string, details: MemoryGetDetails): AgentToolResult<MemoryGetDetails> {
  return {
    content: [{ type: "text", text }],
    details
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
