import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import type { TSchema } from "typebox";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "../toolRegistry.js";
import type { McpRuntime, McpToolCatalogEntry } from "./mcpRuntime.js";

export interface McpToolDetails {
  mcpServer: string;
  mcpTool: string;
  status: "ok" | "error";
  structuredContent?: unknown;
}

export interface McpToolDefinitionOptions {
  /**
   * Mark tools as deferred (loaded on demand through `tool_search`): `true`
   * for every server, or a list of server names. Default: none.
   */
  defer?: boolean | string[];
}

export async function createMcpToolDefinitions(
  runtime: McpRuntime,
  options: McpToolDefinitionOptions = {}
): Promise<RegisteredTool[]> {
  const catalog = await runtime.getCatalog();
  const usedNames = new Set<string>();
  const isDeferred = (server: string) =>
    options.defer === true || (Array.isArray(options.defer) && options.defer.includes(server));

  return catalog.tools.map((entry) => ({
    tool: createMcpAgentTool(runtime, entry, usedNames),
    metadata: {
      source: "mcp",
      risk: "external",
      mcpServer: entry.serverName,
      ...(entry.annotations ? { annotations: { ...entry.annotations } } : {}),
      ...(isDeferred(entry.serverName) ? { deferred: true } : {})
    }
  }));
}

function createMcpAgentTool(runtime: McpRuntime, entry: McpToolCatalogEntry, usedNames: Set<string>): AgentTool<any, McpToolDetails> {
  const toolName = uniqueToolName(buildMcpAgentToolName(entry.serverName, entry.toolName), usedNames);
  return {
    name: toolName,
    label: entry.title || entry.toolName,
    description: entry.description || `MCP tool "${entry.toolName}" from server "${entry.serverName}".`,
    parameters: entry.inputSchema as TSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, input) => {
      const result = await runtime.callTool(entry.serverName, entry.toolName, input);
      return toAgentToolResult(entry, result);
    }
  };
}

export function buildMcpAgentToolName(serverName: string, toolName: string): string {
  const server = sanitizeToolNamePart(serverName);
  const tool = sanitizeToolNamePart(toolName);
  return `mcp__${server || "server"}__${tool || "tool"}`;
}

function uniqueToolName(baseName: string, usedNames: Set<string>): string {
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function sanitizeToolNamePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .toLowerCase();
}

function toAgentToolResult(entry: McpToolCatalogEntry, result: CallToolResult): AgentToolResult<McpToolDetails> {
  const content = normalizeMcpContent(result);
  const details: McpToolDetails = {
    mcpServer: entry.serverName,
    mcpTool: entry.toolName,
    status: result.isError ? "error" : "ok"
  };
  if ("structuredContent" in result) {
    details.structuredContent = result.structuredContent;
  }
  return { content, details };
}

function normalizeMcpContent(result: CallToolResult): AgentToolResult<McpToolDetails>["content"] {
  const content: AgentToolResult<McpToolDetails>["content"] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === "text") {
        content.push({ type: "text", text: item.text });
      } else if (item.type === "image") {
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      } else {
        content.push({ type: "text", text: JSON.stringify(item, null, 2) });
      }
    }
  }

  if (content.length) return content;

  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
  }

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          status: result.isError ? "error" : "ok"
        },
        null,
        2
      )
    }
  ];
}
