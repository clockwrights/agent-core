import type { RegisteredTool } from "../toolRegistry.js";
import { createMemoryToolDefinitions } from "./memoryTools.js";
import type { MemoryRuntime, MemoryRuntimeContext } from "./memoryTypes.js";
import {
  buildMarkdownWikiMaintenancePrompt,
  createMarkdownWikiMaintenanceToolDefinitions,
  createMarkdownWikiMemoryRuntime,
  type MarkdownWikiEngine,
  type MarkdownWikiMemoryRuntimeConfig
} from "./markdown-wiki/index.js";

export interface MemoryConfig {
  enabled: boolean;
  runtime?: MemoryRuntime;
  markdownWiki?: MarkdownWikiMemoryRuntimeConfig;
  markdownWikiEngine?: MarkdownWikiEngine;
  toolAllow?: string[];
  toolDeny?: string[];
}

export async function createMemoryRuntimeContext(config: MemoryConfig): Promise<MemoryRuntimeContext> {
  if (!config.enabled) {
    return {
      toolDefinitions: [],
      memoryPrompt: "",
      diagnostics: [{ level: "info", message: "Memory runtime is disabled." }]
    };
  }

  const runtime = config.runtime ?? (config.markdownWiki ? createMarkdownWikiMemoryRuntime(config.markdownWiki) : undefined);
  if (!runtime) {
    return {
      toolDefinitions: [],
      memoryPrompt: "",
      diagnostics: [{ level: "warning", message: "Memory runtime is enabled but no runtime or markdownWiki store was provided." }]
    };
  }

  const toolDefinitions = filterDefinitions(
    [
      ...createMemoryToolDefinitions(runtime),
      ...(config.markdownWikiEngine ? createMarkdownWikiMaintenanceToolDefinitions(config.markdownWikiEngine) : [])
    ],
    {
    allow: config.toolAllow ?? [],
    deny: config.toolDeny ?? []
    }
  );
  const availableTools = new Set(toolDefinitions.map((definition) => definition.tool.name));
  const memoryPrompt = [runtime.buildPromptSection?.({ availableTools }) ?? "", buildMarkdownWikiMaintenancePrompt({ availableTools })]
    .filter((section) => section.trim())
    .join("\n");
  const diagnostics = runtime.diagnostics?.() ?? [];
  return {
    runtime,
    toolDefinitions,
    memoryPrompt,
    diagnostics
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
