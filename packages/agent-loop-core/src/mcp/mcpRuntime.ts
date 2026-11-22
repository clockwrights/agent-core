import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, type SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, McpDiagnostic, McpHttpServerConfig, McpServerConfig, McpStdioServerConfig, McpTransport } from "./mcpConfig.js";
import type { ToolAnnotations } from "../toolRegistry.js";

export interface McpRuntimeOptions {
  enabled: boolean;
  config: McpConfig;
  clientName?: string;
  clientVersion?: string;
}

export interface McpServerCatalogEntry {
  serverName: string;
  transport: McpTransport;
  toolCount: number;
}

export interface McpToolCatalogEntry {
  serverName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  /** The tool's explicit boolean annotation hints, when it declares any. */
  annotations?: ToolAnnotations;
}

export interface McpToolCatalog {
  generatedAt: string;
  servers: Record<string, McpServerCatalogEntry>;
  tools: McpToolCatalogEntry[];
  diagnostics: McpDiagnostic[];
}

export interface McpRuntime {
  getCatalog(): Promise<McpToolCatalog>;
  callTool(serverName: string, toolName: string, input: unknown): Promise<CallToolResult>;
  dispose(): Promise<void>;
}

export type StdioMcpRuntime = McpRuntime;

type ConnectedMcpServer = {
  client: Client;
  transport: Transport;
  transportType: McpTransport;
};

const defaultConnectionTimeoutMs = 30_000;
const defaultListToolsTimeoutMs = 30_000;
const defaultCallToolTimeoutMs = 60_000;

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntime {
  const diagnostics: McpDiagnostic[] = [];
  const sessions = new Map<string, ConnectedMcpServer>();
  let catalog: McpToolCatalog | undefined;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  let disposed = false;

  const failIfDisposed = () => {
    if (disposed) throw new Error("MCP runtime has been disposed.");
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) return catalog;
    if (catalogInFlight) return catalogInFlight;

    catalogInFlight = buildCatalog({
      options,
      sessions,
      diagnostics,
      failIfDisposed
    });

    try {
      catalog = await catalogInFlight;
      return catalog;
    } finally {
      catalogInFlight = undefined;
    }
  };

  return {
    getCatalog,
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = sessions.get(serverName);
      if (!session) throw new Error(`MCP server is not connected: ${serverName}`);
      return timeoutPromise(
        session.client.callTool({
          name: toolName,
          arguments: isRecord(input) ? input : {}
        }) as Promise<CallToolResult>,
        defaultCallToolTimeoutMs,
        `MCP tool call timed out for ${serverName}/${toolName}`
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      catalog = undefined;
      catalogInFlight = undefined;
      const connected = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(connected.map(disposeConnectedServer));
    }
  };
}

async function buildCatalog(input: {
  options: McpRuntimeOptions;
  sessions: Map<string, ConnectedMcpServer>;
  diagnostics: McpDiagnostic[];
  failIfDisposed: () => void;
}): Promise<McpToolCatalog> {
  const { options, sessions, diagnostics, failIfDisposed } = input;
  const servers: Record<string, McpServerCatalogEntry> = {};
  const tools: McpToolCatalogEntry[] = [];

  if (!options.enabled || !options.config.enabled) {
    diagnostics.push({
      level: "info",
      message: "MCP runtime is disabled."
    });
    return createCatalog(servers, tools, diagnostics);
  }

  for (const [serverName, server] of Object.entries(options.config.servers)) {
    failIfDisposed();

    const connected = await connectServer(serverName, server, options, diagnostics);
    if (!connected) continue;
    sessions.set(serverName, connected);

    try {
      const listedTools = await listAllTools(connected.client, server.connectionTimeoutMs ?? defaultListToolsTimeoutMs);
      servers[serverName] = {
        serverName,
        transport: connected.transportType,
        toolCount: listedTools.length
      };
      for (const tool of listedTools) {
        tools.push({
          serverName,
          toolName: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...annotationHints(tool.annotations)
        });
      }
    } catch (error) {
      diagnostics.push({
        level: "error",
        serverName,
        message: `Failed to list MCP tools: ${safeErrorMessage(error)}`
      });
      sessions.delete(serverName);
      await disposeConnectedServer(connected);
    }
  }

  return createCatalog(servers, tools, diagnostics);
}

async function connectServer(
  serverName: string,
  server: McpServerConfig,
  options: McpRuntimeOptions,
  diagnostics: McpDiagnostic[]
): Promise<ConnectedMcpServer | undefined> {
  if (isStdioServerConfig(server)) {
    return connectStdioServer(serverName, server, options, diagnostics);
  }
  return connectHttpServer(serverName, server, options, diagnostics);
}

async function connectStdioServer(
  serverName: string,
  server: McpStdioServerConfig,
  options: McpRuntimeOptions,
  diagnostics: McpDiagnostic[]
): Promise<ConnectedMcpServer | undefined> {
  const client = new Client({
    name: options.clientName ?? "agent-loop-core-mcp-runtime",
    version: options.clientVersion ?? "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    stderr: "pipe"
  });

  try {
    await timeoutPromise(
      client.connect(transport),
      server.connectionTimeoutMs ?? defaultConnectionTimeoutMs,
      `MCP stdio server connection timed out after ${server.connectionTimeoutMs ?? defaultConnectionTimeoutMs}ms`
    );
    return { client, transport, transportType: "stdio" };
  } catch (error) {
    diagnostics.push({
      level: "error",
      serverName,
      message: `Failed to connect MCP stdio server: ${safeErrorMessage(error)}`
    });
    await disposeConnectedServer({ client, transport, transportType: "stdio" });
    return undefined;
  }
}

async function connectHttpServer(
  serverName: string,
  server: McpHttpServerConfig,
  options: McpRuntimeOptions,
  diagnostics: McpDiagnostic[]
): Promise<ConnectedMcpServer | undefined> {
  const client = new Client({
    name: options.clientName ?? "agent-loop-core-mcp-runtime",
    version: options.clientVersion ?? "0.1.0"
  });
  const transport = createHttpTransport(server);

  try {
    await timeoutPromise(
      client.connect(transport),
      server.connectionTimeoutMs ?? defaultConnectionTimeoutMs,
      `MCP ${server.transport} server connection timed out after ${server.connectionTimeoutMs ?? defaultConnectionTimeoutMs}ms`
    );
    return { client, transport, transportType: server.transport };
  } catch (error) {
    diagnostics.push({
      level: "error",
      serverName,
      message: `Failed to connect MCP ${server.transport} server: ${safeErrorMessage(error)}`
    });
    await disposeConnectedServer({ client, transport, transportType: server.transport });
    return undefined;
  }
}

function createHttpTransport(server: McpHttpServerConfig): Transport {
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.transport === "streamable-http") {
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      fetch: fetchWithGlobal
    });
  }
  return new SSEClientTransport(url, {
    requestInit,
    fetch: fetchWithGlobal,
    eventSourceInit: server.headers ? { fetch: buildSseEventSourceFetch(server.headers) } : undefined
  });
}

async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;

  do {
    const page = await timeoutPromise(
      client.listTools(cursor ? { cursor } : undefined),
      timeoutMs,
      `MCP tools/list timed out after ${timeoutMs}ms`
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return tools;
}

async function disposeConnectedServer(server: ConnectedMcpServer): Promise<void> {
  if (server.transportType === "streamable-http") {
    await (server.transport as StreamableHTTPClientTransport).terminateSession().catch(() => {});
  }
  await server.transport.close().catch(() => {});
  await server.client.close().catch(() => {});
}

function createCatalog(
  servers: Record<string, McpServerCatalogEntry>,
  tools: McpToolCatalogEntry[],
  diagnostics: McpDiagnostic[]
): McpToolCatalog {
  return {
    generatedAt: new Date().toISOString(),
    servers,
    tools,
    diagnostics: [...diagnostics]
  };
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** Copies only boolean hint values; anything else a server sends is dropped. */
function annotationHints(annotations: unknown): { annotations?: ToolAnnotations } {
  if (!annotations || typeof annotations !== "object") return {};
  const hints: ToolAnnotations = {};
  for (const key of ANNOTATION_HINTS) {
    const value = (annotations as Record<string, unknown>)[key];
    if (typeof value === "boolean") hints[key] = value;
  }
  return Object.keys(hints).length ? { annotations: hints } : {};
}

function isStdioServerConfig(server: McpServerConfig): server is McpStdioServerConfig {
  return server.transport === "stdio";
}

const fetchWithGlobal: FetchLike = async (url, init) => fetch(url, init);

function buildSseEventSourceFetch(headers: Record<string, string>): NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"] {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: {
        ...headersFromInit(init?.headers),
        ...headers
      }
    });
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const createStdioMcpRuntime = createMcpRuntime;
