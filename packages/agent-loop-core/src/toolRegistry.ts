import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { limitToolResult, type ToolOutputStore } from "./toolResultLimits.js";

export type ToolSource = "domain" | "mcp" | "memory" | "system";
export type ToolRisk = "read" | "write" | "external";

export interface ToolMetadata {
  source: ToolSource;
  risk: ToolRisk;
  /**
   * Cap on result text passed to the model, in characters. Applied by
   * `resolve()` / `resolveTools()` only when result limits are requested via
   * `ResolveToolsOptions.resultLimits`.
   */
  maxResultChars?: number;
}

export interface ResolveToolsOptions {
  /**
   * Cap tool result size. Each tool's `metadata.maxResultChars` wins over
   * `defaultMaxChars`; tools with neither are returned unwrapped. With
   * `store`, truncated output stays readable through the `read_tool_output`
   * tool (see `createReadToolOutputTool`).
   */
  resultLimits?: {
    defaultMaxChars?: number;
    store?: ToolOutputStore;
  };
  /**
   * Set each tool's `executionMode` from its registered risk: `read` →
   * `"parallel"`, `write` / `external` → `"sequential"`, overriding the
   * tool's own setting. Pair with the runtime's
   * `toolBatchStrategy: "sequential-barriers"` so read tools run
   * concurrently while each write or external tool runs alone. Default false.
   */
  executionModeFromRisk?: boolean;
}

export interface RegisteredTool {
  tool: AgentTool<any>;
  metadata: ToolMetadata;
}

export interface ToolPolicy {
  enabled: boolean;
  sources: Partial<Record<ToolSource, boolean>>;
  allow: string[];
  deny: string[];
}

export const defaultToolPolicy: ToolPolicy = {
  enabled: true,
  sources: {
    domain: true,
    mcp: false,
    memory: false,
    system: false
  },
  allow: [],
  deny: []
};

export class ToolRegistry {
  private readonly entries: RegisteredTool[] = [];

  register(tool: AgentTool<any>, metadata: ToolMetadata): void {
    this.entries.push({ tool, metadata });
  }

  registerMany(tools: AgentTool<any>[], metadata: ToolMetadata): void {
    for (const tool of tools) {
      this.register(tool, metadata);
    }
  }

  registerDefinitions(definitions: RegisteredTool[]): void {
    this.entries.push(...definitions);
  }

  resolve(policy: ToolPolicy = defaultToolPolicy, options: ResolveToolsOptions = {}): AgentTool<any>[] {
    return this.entries
      .filter((entry) => isToolAllowed(entry, policy))
      .map((entry) => prepareResolvedTool(entry, options));
  }

  list(policy: ToolPolicy = defaultToolPolicy): RegisteredTool[] {
    return this.entries.filter((entry) => isToolAllowed(entry, policy));
  }
}

export function resolveTools(
  definitions: RegisteredTool[],
  policy: ToolPolicy = defaultToolPolicy,
  options: ResolveToolsOptions = {}
): AgentTool<any>[] {
  const registry = new ToolRegistry();
  registry.registerDefinitions(definitions);
  return registry.resolve(policy, options);
}

/** Execution mode implied by a tool's risk. */
export function executionModeForRisk(risk: ToolRisk): "parallel" | "sequential" {
  return risk === "read" ? "parallel" : "sequential";
}

function prepareResolvedTool(entry: RegisteredTool, options: ResolveToolsOptions): AgentTool<any> {
  let tool = entry.tool;
  if (options.executionModeFromRisk) {
    const executionMode = executionModeForRisk(entry.metadata.risk);
    if (tool.executionMode !== executionMode) tool = { ...tool, executionMode };
  }
  const limits = options.resultLimits;
  const maxChars = limits ? (entry.metadata.maxResultChars ?? limits.defaultMaxChars) : undefined;
  if (limits && maxChars !== undefined) tool = limitToolResult(tool, { maxChars, store: limits.store });
  return tool;
}

export function isToolAllowed(entry: RegisteredTool, policy: ToolPolicy = defaultToolPolicy): boolean {
  const normalized = normalizePolicy(policy);
  if (!normalized.enabled) return false;
  if (!normalized.sources[entry.metadata.source]) return false;
  if (normalized.allow.length > 0 && !normalized.allow.includes(entry.tool.name)) return false;
  if (normalized.deny.includes(entry.tool.name)) return false;
  return true;
}

function normalizePolicy(policy: ToolPolicy): ToolPolicy {
  return {
    enabled: policy.enabled,
    sources: {
      ...defaultToolPolicy.sources,
      ...policy.sources
    },
    allow: normalizeToolNames(policy.allow),
    deny: normalizeToolNames(policy.deny)
  };
}

function normalizeToolNames(names: string[]): string[] {
  return names.map((name) => name.trim()).filter(Boolean);
}
