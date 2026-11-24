import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { RegisteredTool } from "../../toolRegistry.js";
import {
  memoryPageBody,
  readMemoryProvenance,
  stampMemoryProvenance,
  type MemoryOrigin,
  type MemoryProvenanceSource
} from "../provenance.js";
import { normalizeMarkdownWikiPath, type MarkdownWikiEngine, type MarkdownWikiEngineStore } from "./markdownWikiEngine.js";

// Core boundary: domain-neutral. Agent-facing tools that create and edit
// wiki content pages, always stamping provenance.

export const wikiWritePageToolName = "wiki_write_page";
export const wikiEditPageToolName = "wiki_edit_page";

export interface MarkdownWikiWriteToolOptions {
  store: MarkdownWikiEngineStore;
  /** When given, its managed files are protected and generated files (index) are refreshed after each write. */
  engine?: MarkdownWikiEngine;
  /** Session, actor and origin recorded on every write. */
  provenance?: MemoryProvenanceSource;
  /** Extra paths the tools must never write. */
  protectedPaths?: string[];
  /** When set, pages may only be written under these path prefixes (e.g. ["wiki/"]). */
  allowedPathPrefixes?: string[];
  /** Allowed file extensions. Default [".md"]. */
  extensions?: string[];
  /** Maximum page size in characters after the write. Default 50 000. */
  maxPageChars?: number;
  clock?: () => string;
}

export interface WikiWriteToolDetails {
  status: "ok";
  path: string;
  created: boolean;
  origin: MemoryOrigin;
  changedFiles: string[];
}

const writeParameters = Type.Object({
  path: Type.String({ description: "Page path relative to the wiki root, e.g. \"topics/billing.md\"." }),
  content: Type.String({ description: "Full markdown content of the page. Provenance is added automatically." })
});

const editParameters = Type.Object({
  path: Type.String({ description: "Path of an existing page." }),
  find: Type.String({ description: "Exact text to replace; must occur exactly once in the page body." }),
  replace: Type.String({ description: "Replacement text." })
});

/**
 * `wiki_write_page` (create or replace a page) and `wiki_edit_page` (exact
 * find/replace). Both are risk "write". Every write stamps `provenance-*`
 * frontmatter; provenance lines in the model's content are discarded. A page
 * that was untrusted stays untrusted when edited.
 */
export function createMarkdownWikiWriteToolDefinitions(options: MarkdownWikiWriteToolOptions): RegisteredTool[] {
  return [
    { tool: createWritePageTool(options), metadata: { source: "memory", risk: "write" } },
    { tool: createEditPageTool(options), metadata: { source: "memory", risk: "write" } }
  ];
}

function createWritePageTool(options: MarkdownWikiWriteToolOptions): AgentTool<typeof writeParameters, WikiWriteToolDetails> {
  return {
    name: wikiWritePageToolName,
    label: "Wiki Write Page",
    description:
      "Create or replace a markdown wiki content page with durable knowledge (decisions, facts, summaries). Provenance is recorded automatically.",
    parameters: writeParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, { path: requestedPath, content }) => {
      const path = checkPath(requestedPath, options);
      const previous = options.store.readFile(path);
      return save(path, content, previous, wikiWritePageToolName, options);
    }
  };
}

function createEditPageTool(options: MarkdownWikiWriteToolOptions): AgentTool<typeof editParameters, WikiWriteToolDetails> {
  return {
    name: wikiEditPageToolName,
    label: "Wiki Edit Page",
    description: "Replace one exact passage in an existing wiki page. Provenance is updated automatically.",
    parameters: editParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, { path: requestedPath, find, replace }) => {
      const path = checkPath(requestedPath, options);
      const previous = options.store.readFile(path);
      if (previous === undefined) throw new Error(`No page at "${path}". Use ${wikiWritePageToolName} to create it.`);
      if (!find) throw new Error("find must not be empty.");
      const body = memoryPageBody(previous);
      const occurrences = body.split(find).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          occurrences === 0
            ? `The text to replace was not found in "${path}".`
            : `The text to replace occurs ${occurrences} times in "${path}"; include more surrounding text so it is unique.`
        );
      }
      const frontmatterEnd = previous.length - body.length;
      const updated = previous.slice(0, frontmatterEnd) + body.replace(find, () => replace);
      return save(path, updated, previous, wikiEditPageToolName, options);
    }
  };
}

function save(
  path: string,
  content: string,
  previous: string | undefined,
  tool: string,
  options: MarkdownWikiWriteToolOptions
): { content: [{ type: "text"; text: string }]; details: WikiWriteToolDetails } {
  const now = (options.clock ?? (() => new Date().toISOString()))();
  const before = previous === undefined ? undefined : readMemoryProvenance(previous);
  const current = options.provenance?.origin?.() ?? "unverified";
  // Taint is sticky: once untrusted, a page stays untrusted.
  const origin: MemoryOrigin = before?.origin === "untrusted" ? "untrusted" : current;
  const stamped = stampMemoryProvenance(content, {
    tool,
    origin,
    session: options.provenance?.session,
    actor: options.provenance?.actor,
    created: before?.created ?? now,
    updated: now
  });
  const maxChars = options.maxPageChars ?? 50_000;
  if (stamped.length > maxChars) throw new Error(`Page would be ${stamped.length} characters, above the ${maxChars} limit.`);

  options.store.writeFile(path, stamped);
  const changedFiles = [path, ...(options.engine ? options.engine.updateGeneratedFiles() : [])];
  const details: WikiWriteToolDetails = { status: "ok", path, created: previous === undefined, origin, changedFiles };
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function checkPath(requested: string, options: MarkdownWikiWriteToolOptions): string {
  const raw = requested.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("Use a page path relative to the wiki root.");
  }
  if (raw.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`Path "${raw}" must not contain "." or ".." segments.`);
  }
  const path = normalizeMarkdownWikiPath(raw);
  const extensions = options.extensions ?? [".md"];
  if (!extensions.some((ext) => path.toLowerCase().endsWith(ext))) {
    throw new Error(`Only ${extensions.join(", ")} pages can be written.`);
  }
  const protectedPaths = new Set([
    ...(options.engine?.managedPaths?.() ?? []),
    ...(options.protectedPaths ?? []).map((p) => normalizeMarkdownWikiPath(p))
  ]);
  if (protectedPaths.has(path)) {
    throw new Error(`"${path}" is maintained by the wiki itself and cannot be written directly.`);
  }
  const prefixes = options.allowedPathPrefixes?.map((p) => normalizeMarkdownWikiPath(p)) ?? [];
  if (prefixes.length > 0 && !prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Pages can only be written under: ${prefixes.join(", ")}.`);
  }
  return path;
}
