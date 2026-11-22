import type { RegisteredTool } from "../toolRegistry.js";
import { createMemoryToolDefinitions } from "./memoryTools.js";
import type { MemoryRuntime, MemoryRuntimeContext } from "./memoryTypes.js";
import {
  buildMarkdownWikiMaintenancePrompt,
  createMarkdownWikiMaintenanceToolDefinitions,
  createMarkdownWikiMemoryRuntime,
  createMarkdownWikiWriteToolDefinitions,
  type MarkdownWikiEngine,
  type MarkdownWikiMemoryRuntimeConfig,
  type MarkdownWikiWriteToolOptions
} from "./markdown-wiki/index.js";
import { loadPinnedMemory, type PinnedMemoryOptions } from "./pinnedMemory.js";
import type { MemoryProvenanceSource } from "./provenance.js";

export interface MemoryConfig {
  enabled: boolean;
  runtime?: MemoryRuntime;
  markdownWiki?: MarkdownWikiMemoryRuntimeConfig;
  markdownWikiEngine?: MarkdownWikiEngine;
  /**
   * Register the page write tools (`wiki_write_page`, `wiki_edit_page`) over
   * this store. Off when absent. The `markdownWikiEngine`, when set, protects
   * its managed files and refreshes the index after writes.
   */
  markdownWikiWrite?: Omit<MarkdownWikiWriteToolOptions, "engine" | "provenance">;
  /**
   * Provenance recorded by write tools (pages always; log entries and
   * relationship edges only when this is set). Use
   * `createUntrustedOriginTracker` for `origin`.
   */
  provenance?: MemoryProvenanceSource;
  /**
   * Always-loaded tier read from the `markdownWiki` store and returned as
   * `pinnedMemory` on the context. Off when absent.
   */
  pinnedMemory?: PinnedMemoryOptions;
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
      ...(config.markdownWikiEngine
        ? createMarkdownWikiMaintenanceToolDefinitions(config.markdownWikiEngine, { provenance: config.provenance })
        : []),
      ...(config.markdownWikiWrite
        ? createMarkdownWikiWriteToolDefinitions({
            ...config.markdownWikiWrite,
            engine: config.markdownWikiEngine,
            provenance: config.provenance
          })
        : [])
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
  const diagnostics = [...(runtime.diagnostics?.() ?? [])];

  let pinnedMemory: string | undefined;
  if (config.pinnedMemory) {
    if (!config.markdownWiki) {
      diagnostics.push({ level: "warning", message: "pinnedMemory needs a markdownWiki store; no pinned memory loaded." });
    } else {
      const pinned = await loadPinnedMemory(config.markdownWiki.store, config.pinnedMemory);
      pinnedMemory = pinned.block;
      const overBudget = pinned.omitted.filter((o) => o.reason === "over_budget").map((o) => o.path);
      const untrusted = pinned.omitted.filter((o) => o.reason === "untrusted").map((o) => o.path);
      if (overBudget.length) {
        diagnostics.push({
          level: "warning",
          message: `Pinned memory is over its ${pinned.maxChars}-character budget; left out: ${overBudget.join(", ")}.`
        });
      }
      if (untrusted.length) {
        diagnostics.push({
          level: "warning",
          message: `Pinned pages with untrusted provenance were left out: ${untrusted.join(", ")}.`
        });
      }
    }
  }

  return {
    runtime,
    toolDefinitions,
    memoryPrompt,
    diagnostics,
    ...(pinnedMemory !== undefined ? { pinnedMemory } : {})
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
