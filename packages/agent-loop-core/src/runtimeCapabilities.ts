import { createMcpToolDefinitions } from "./mcp/mcpToolAdapter.js";
import type { McpConfig } from "./mcp/mcpConfig.js";
import { createMcpRuntime } from "./mcp/mcpRuntime.js";
import { createMemoryRuntimeContext, type MemoryConfig } from "./memory/index.js";
import type { SkillConfig } from "./skills/skillTypes.js";
import { createSkillsRuntimeContext } from "./skills/skillRuntimeContext.js";
import { createSkillToolDefinitions } from "./skills/skillTools.js";
import type { AgentRuntimeContext, AgentRuntimeDiagnostic } from "./runtimeContext.js";
import { defaultToolPolicy, type RegisteredTool, type ToolPolicy } from "./toolRegistry.js";

export interface AgentRuntimeMcpCapabilitiesConfig {
  enabled: boolean;
  config: McpConfig;
  toolAllow?: string[];
  toolDeny?: string[];
  clientName?: string;
  clientVersion?: string;
}

export type AgentRuntimeToolPolicyConfig = Partial<Pick<ToolPolicy, "enabled" | "sources" | "allow" | "deny">>;

export interface AgentRuntimeCapabilitiesConfig {
  mcp?: AgentRuntimeMcpCapabilitiesConfig;
  memory?: MemoryConfig;
  skills?: SkillConfig;
  toolPolicy?: AgentRuntimeToolPolicyConfig;
}

export async function createAgentRuntimeContextFromConfig(config: AgentRuntimeCapabilitiesConfig): Promise<AgentRuntimeContext> {
  const diagnostics: AgentRuntimeDiagnostic[] = [];
  const mcpEnabled = config.mcp?.enabled === true;
  const mcpRuntime = config.mcp
    ? createMcpRuntime({
        enabled: config.mcp.enabled,
        config: config.mcp.config,
        clientName: config.mcp.clientName,
        clientVersion: config.mcp.clientVersion
      })
    : undefined;

  let mcpToolDefinitions: RegisteredTool[] = [];
  const disposers: Array<() => Promise<void>> = [];
  if (mcpEnabled && mcpRuntime) {
    disposers.push(() => mcpRuntime.dispose());
    try {
      mcpToolDefinitions = filterDefinitions(await createMcpToolDefinitions(mcpRuntime), {
        allow: config.mcp?.toolAllow ?? [],
        deny: config.mcp?.toolDeny ?? []
      });
      const catalog = await mcpRuntime.getCatalog();
      diagnostics.push(...catalog.diagnostics.map((diagnostic) => ({ ...diagnostic, source: "mcp" as const })));
    } catch (error) {
      diagnostics.push({
        level: "error",
        source: "mcp",
        message: `Failed to prepare MCP tools. ${errorMessage(error)}`
      });
    }
  }

  const memoryContext = await createMemoryRuntimeContext(config.memory ?? { enabled: false });
  diagnostics.push(...memoryContext.diagnostics.map((diagnostic) => ({ ...diagnostic, source: "memory" as const })));
  if (memoryContext.runtime?.dispose) {
    disposers.push(() => memoryContext.runtime?.dispose?.() ?? Promise.resolve());
  }

  const skillsContext = await createSkillsRuntimeContext(config.skills ?? { enabled: false, roots: [] });
  diagnostics.push(...skillsContext.diagnostics.map((diagnostic) => ({ ...diagnostic, source: "skills" as const })));
  const skillToolDefinitions = createSkillToolDefinitions(skillsContext.skills);

  return {
    toolDefinitions: [...mcpToolDefinitions, ...memoryContext.toolDefinitions, ...skillToolDefinitions],
    toolPolicy: resolveRuntimeToolPolicy(config.toolPolicy, {
      mcpEnabled,
      memoryEnabled: memoryContext.toolDefinitions.length > 0,
      systemEnabled: skillToolDefinitions.length > 0
    }),
    skillsPrompt: skillsContext.skillsPrompt,
    memoryPrompt: memoryContext.memoryPrompt,
    diagnostics,
    dispose: disposers.length ? () => disposeAll(disposers) : undefined
  };
}

function resolveRuntimeToolPolicy(
  policy: AgentRuntimeToolPolicyConfig | undefined,
  input: { mcpEnabled: boolean; memoryEnabled: boolean; systemEnabled: boolean }
): ToolPolicy {
  return {
    enabled: policy?.enabled ?? defaultToolPolicy.enabled,
    sources: {
      ...defaultToolPolicy.sources,
      mcp: input.mcpEnabled,
      memory: input.memoryEnabled,
      system: input.systemEnabled,
      ...policy?.sources
    },
    allow: policy?.allow ?? [],
    deny: policy?.deny ?? []
  };
}

function filterDefinitions(definitions: RegisteredTool[], input: { allow: string[]; deny: string[] }): RegisteredTool[] {
  const allow = new Set(input.allow);
  const deny = new Set(input.deny);
  return definitions.filter((definition) => {
    const name = definition.tool.name;
    if (allow.size > 0 && !allow.has(name)) return false;
    if (deny.has(name)) return false;
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function disposeAll(disposers: Array<() => Promise<void>>): Promise<void> {
  await Promise.allSettled(disposers.map((dispose) => dispose()));
}
