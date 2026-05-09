import type { AgentTool } from "@maya-ai/tool-agent-runtime";

export type ToolSource = "domain" | "mcp" | "memory" | "system";
export type ToolRisk = "read" | "write" | "external";

export interface ToolMetadata {
  source: ToolSource;
  risk: ToolRisk;
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

  resolve(policy: ToolPolicy = defaultToolPolicy): AgentTool<any>[] {
    return this.entries.filter((entry) => isToolAllowed(entry, policy)).map((entry) => entry.tool);
  }

  list(policy: ToolPolicy = defaultToolPolicy): RegisteredTool[] {
    return this.entries.filter((entry) => isToolAllowed(entry, policy));
  }
}

export function resolveTools(definitions: RegisteredTool[], policy: ToolPolicy = defaultToolPolicy): AgentTool<any>[] {
  const registry = new ToolRegistry();
  registry.registerDefinitions(definitions);
  return registry.resolve(policy);
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
