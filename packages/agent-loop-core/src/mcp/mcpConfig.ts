export type McpHttpTransport = "sse" | "streamable-http";
export type McpTransport = "stdio" | McpHttpTransport;
export type McpDiagnosticLevel = "info" | "warning" | "error";

export type McpDiagnostic = {
  level: McpDiagnosticLevel;
  message: string;
  serverName?: string;
};

export type McpStdioServerConfig = {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  connectionTimeoutMs?: number;
};

export type McpHttpServerConfig = {
  transport: McpHttpTransport;
  url: string;
  headers?: Record<string, string>;
  connectionTimeoutMs?: number;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpConfig = {
  enabled: boolean;
  servers: Record<string, McpServerConfig>;
};

export type NormalizeMcpConfigResult = {
  config: McpConfig;
  diagnostics: McpDiagnostic[];
};

const defaultMcpConfig: McpConfig = {
  enabled: false,
  servers: {}
};

const supportedHttpTransports = new Set<string>(["sse", "streamable-http"]);
const serverNamePattern = /^[A-Za-z0-9_.-]+$/;

export function normalizeMcpConfig(raw: unknown): NormalizeMcpConfigResult {
  const diagnostics: McpDiagnostic[] = [];

  if (raw === undefined || raw === null) {
    return { config: defaultMcpConfig, diagnostics };
  }

  if (!isRecord(raw)) {
    diagnostics.push({
      level: "error",
      message: "MCP config must be an object."
    });
    return { config: defaultMcpConfig, diagnostics };
  }

  const enabled = normalizeEnabled(raw.enabled, diagnostics);
  const servers = normalizeMcpServers(raw.servers, diagnostics);

  return {
    config: {
      enabled,
      servers
    },
    diagnostics
  };
}

function normalizeEnabled(value: unknown, diagnostics: McpDiagnostic[]): boolean {
  if (value === undefined) return defaultMcpConfig.enabled;
  if (typeof value === "boolean") return value;
  diagnostics.push({
    level: "warning",
    message: "MCP config field enabled must be a boolean; using false."
  });
  return false;
}

function normalizeMcpServers(value: unknown, diagnostics: McpDiagnostic[]): Record<string, McpServerConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    diagnostics.push({
      level: "error",
      message: "MCP config field servers must be an object; ignoring all servers."
    });
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [rawName, rawServer] of Object.entries(value)) {
    const serverName = rawName.trim();
    if (!isValidServerName(serverName)) {
      diagnostics.push({
        level: "error",
        message: `MCP server name "${rawName}" must contain only letters, numbers, dots, underscores, or hyphens.`
      });
      continue;
    }

    const server = normalizeMcpServer(serverName, rawServer, diagnostics);
    if (server) {
      servers[serverName] = server;
    }
  }

  return servers;
}

function normalizeMcpServer(serverName: string, rawServer: unknown, diagnostics: McpDiagnostic[]): McpServerConfig | undefined {
  if (!isRecord(rawServer)) {
    diagnostics.push({
      level: "error",
      serverName,
      message: "MCP server config must be an object; server skipped."
    });
    return undefined;
  }

  const command = normalizeOptionalString(rawServer.command);
  const url = normalizeOptionalString(rawServer.url);
  const hasCommand = Boolean(command);
  const hasUrl = Boolean(url);

  if (hasCommand && hasUrl) {
    diagnostics.push({
      level: "error",
      serverName,
      message: "MCP server config must use either command or url, not both; server skipped."
    });
    return undefined;
  }

  if (hasCommand) {
    return normalizeStdioServer(serverName, rawServer, command!, diagnostics);
  }

  if (hasUrl) {
    return normalizeHttpServer(serverName, rawServer, url!, diagnostics);
  }

  diagnostics.push({
    level: "error",
    serverName,
    message: "MCP server config requires either command for stdio or url for HTTP; server skipped."
  });
  return undefined;
}

function normalizeStdioServer(
  serverName: string,
  rawServer: Record<string, unknown>,
  command: string,
  diagnostics: McpDiagnostic[]
): McpStdioServerConfig | undefined {
  const transport = normalizeOptionalString(rawServer.transport);
  if (transport && transport !== "stdio") {
    diagnostics.push({
      level: "error",
      serverName,
      message: `MCP stdio server has unsupported transport "${transport}"; server skipped.`
    });
    return undefined;
  }

  const args = normalizeStringArray(serverName, rawServer.args, "args", diagnostics);
  const env = normalizeStringRecord(serverName, rawServer.env, "env", diagnostics);
  const cwd = normalizeOptionalString(rawServer.cwd ?? rawServer.workingDirectory);
  const connectionTimeoutMs =
    rawServer.connectionTimeoutMs === undefined
      ? undefined
      : normalizeConnectionTimeoutMs(serverName, rawServer.connectionTimeoutMs, diagnostics);

  if (
    args === undefined ||
    env === undefined ||
    (rawServer.connectionTimeoutMs !== undefined && connectionTimeoutMs === undefined)
  ) {
    return undefined;
  }

  const config: McpStdioServerConfig = {
    transport: "stdio",
    command
  };
  if (args.length) config.args = args;
  if (Object.keys(env).length) config.env = env;
  if (cwd) config.cwd = cwd;
  if (connectionTimeoutMs !== undefined) config.connectionTimeoutMs = connectionTimeoutMs;
  return config;
}

function normalizeHttpServer(
  serverName: string,
  rawServer: Record<string, unknown>,
  url: string,
  diagnostics: McpDiagnostic[]
): McpHttpServerConfig | undefined {
  if (!isSupportedUrl(url)) {
    diagnostics.push({
      level: "error",
      serverName,
      message: "MCP HTTP server url must be an http or https URL; server skipped."
    });
    return undefined;
  }

  const transport = normalizeOptionalString(rawServer.transport) ?? "sse";
  if (!supportedHttpTransports.has(transport)) {
    diagnostics.push({
      level: "error",
      serverName,
      message: `MCP HTTP server has unsupported transport "${transport}"; server skipped.`
    });
    return undefined;
  }

  const headers = normalizeStringRecord(serverName, rawServer.headers, "headers", diagnostics);
  const connectionTimeoutMs =
    rawServer.connectionTimeoutMs === undefined
      ? undefined
      : normalizeConnectionTimeoutMs(serverName, rawServer.connectionTimeoutMs, diagnostics);

  if (headers === undefined || (rawServer.connectionTimeoutMs !== undefined && connectionTimeoutMs === undefined)) {
    return undefined;
  }

  const config: McpHttpServerConfig = {
    transport: transport as McpHttpTransport,
    url
  };
  if (Object.keys(headers).length) config.headers = headers;
  if (connectionTimeoutMs !== undefined) config.connectionTimeoutMs = connectionTimeoutMs;
  return config;
}

function normalizeStringArray(
  serverName: string,
  value: unknown,
  field: string,
  diagnostics: McpDiagnostic[]
): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push({
      level: "error",
      serverName,
      message: `MCP server field ${field} must be an array of strings; server skipped.`
    });
    return undefined;
  }
  return value;
}

function normalizeStringRecord(
  serverName: string,
  value: unknown,
  field: string,
  diagnostics: McpDiagnostic[]
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
    diagnostics.push({
      level: "error",
      serverName,
      message: `MCP server field ${field} must be an object with string values; server skipped.`
    });
    return undefined;
  }
  return value as Record<string, string>;
}

function normalizeConnectionTimeoutMs(
  serverName: string,
  value: unknown,
  diagnostics: McpDiagnostic[]
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    diagnostics.push({
      level: "error",
      serverName,
      message: "MCP server field connectionTimeoutMs must be a positive number; server skipped."
    });
    return undefined;
  }
  return Math.floor(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidServerName(serverName: string): boolean {
  return Boolean(serverName) && serverNamePattern.test(serverName);
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
