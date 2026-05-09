import { defaultToolPolicy, ToolRegistry, type RegisteredTool, type ToolPolicy } from "../toolRegistry.js";
import { createMcpToolDefinitions } from "./mcpToolAdapter.js";
import type { McpConfig, McpDiagnostic } from "./mcpConfig.js";
import { createMcpRuntime } from "./mcpRuntime.js";

export interface McpRegistryPreviewInput {
  config: McpConfig;
  enabled: boolean;
  policy?: ToolPolicy;
  domainDefinitions?: RegisteredTool[];
}

export interface McpRegistryPreviewTool {
  name: string;
  source: RegisteredTool["metadata"]["source"];
  risk: RegisteredTool["metadata"]["risk"];
}

export interface McpRegistryPreview {
  registeredTools: McpRegistryPreviewTool[];
  resolvedTools: McpRegistryPreviewTool[];
  diagnostics: McpDiagnostic[];
}

export async function createMcpRegistryPreview(input: McpRegistryPreviewInput): Promise<McpRegistryPreview> {
  const runtime = createMcpRuntime({
    enabled: input.enabled,
    config: input.config
  });

  try {
    const registry = new ToolRegistry();
    registry.registerDefinitions(input.domainDefinitions ?? []);
    registry.registerDefinitions(await createMcpToolDefinitions(runtime));

    const registeredTools = registry.list(allSourcesPolicy()).map(toPreviewTool);
    const resolvedTools = registry.list(input.policy ?? defaultToolPolicy).map(toPreviewTool);
    const catalog = await runtime.getCatalog();

    return {
      registeredTools,
      resolvedTools,
      diagnostics: catalog.diagnostics
    };
  } finally {
    await runtime.dispose();
  }
}

function allSourcesPolicy(): ToolPolicy {
  return {
    enabled: true,
    sources: {
      domain: true,
      mcp: true,
      system: true
    },
    allow: [],
    deny: []
  };
}

function toPreviewTool(definition: RegisteredTool): McpRegistryPreviewTool {
  return {
    name: definition.tool.name,
    source: definition.metadata.source,
    risk: definition.metadata.risk
  };
}
