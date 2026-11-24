import path from "node:path";
import type {
  MemoryGetInput,
  MemoryGetResult,
  MemoryRuntime,
  MemoryRuntimeDiagnostic,
  MemoryRuntimeStatus,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource,
  MemorySourceFilter
} from "../memoryTypes.js";
import { memoryGetToolName, memorySearchToolName } from "../memoryTools.js";
import { readMemoryProvenance } from "../provenance.js";

export interface MarkdownWikiFile {
  path: string;
  content?: string;
  updatedAt?: string;
}

export interface MarkdownWikiFileStore {
  listFiles(): Promise<MarkdownWikiFile[]>;
  readFile(path: string): Promise<string | undefined>;
}

export interface MarkdownWikiMemoryRuntimeConfig {
  store: MarkdownWikiFileStore;
  wikiRoot?: string;
  rawRoot?: string;
  sessionsRoot?: string;
  includeExtensions?: string[];
  maxSnippetChars?: number;
  maxGetChars?: number;
  defaultGetLineCount?: number;
  maxSearchResults?: number;
}

type LoadedMemoryFile = {
  path: string;
  title?: string;
  content: string;
  source: MemorySource;
  updatedAt?: string;
};

const defaultExtensions = [".md", ".mdx", ".txt", ".jsonl"];
const defaultMaxSnippetChars = 700;
const defaultMaxGetChars = 12_000;
const defaultGetLineCount = 120;
const defaultMaxSearchResults = 8;

export function createMarkdownWikiMemoryRuntime(
  config: MarkdownWikiMemoryRuntimeConfig
): MemoryRuntime {
  return new MarkdownWikiMemoryRuntime(config);
}

class MarkdownWikiMemoryRuntime implements MemoryRuntime {
  private readonly diagnosticsList: MemoryRuntimeDiagnostic[] = [];

  constructor(private readonly config: MarkdownWikiMemoryRuntimeConfig) {}

  status(): MemoryRuntimeStatus {
    return {
      enabled: true,
      provider: "markdown-wiki",
      sources: ["wiki", "raw", "sessions"]
    };
  }

  diagnostics(): MemoryRuntimeDiagnostic[] {
    return [...this.diagnosticsList];
  }

  buildPromptSection(input: { availableTools: Set<string> }): string {
    const hasSearch = input.availableTools.has(memorySearchToolName);
    const hasGet = input.availableTools.has(memoryGetToolName);
    if (!hasSearch && !hasGet) return "";
    const guidance =
      hasSearch && hasGet
        ? "Before answering questions about prior work, decisions, sources, domain facts, preferences, or open questions, use memory_search to find relevant wiki context, then memory_get to read the needed lines."
        : hasSearch
          ? "Before answering questions about prior work, decisions, sources, domain facts, preferences, or open questions, use memory_search to find relevant wiki context."
          : "When a question points to a specific memory page, use memory_get to read the needed lines.";
    return [
      "## Memory Recall",
      guidance,
      "Use citations from memory paths and line numbers when they help the user verify the answer.",
      ""
    ].join("\n");
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const query = input.query.trim();
    if (!query) return [];
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const maxResults = clampPositiveInt(input.maxResults, this.config.maxSearchResults ?? defaultMaxSearchResults);
    const minScore = clampScore(input.minScore);
    const files = await this.loadFiles(input.source ?? "wiki");
    const scored = files
      .map((file) => scoreFile(file, query, tokens, this.config.maxSnippetChars ?? defaultMaxSnippetChars))
      .filter((result): result is MemorySearchResult => result !== undefined)
      .filter((result) => minScore === undefined || result.score >= minScore)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.path.localeCompare(right.path);
      })
      .slice(0, maxResults);
    return scored;
  }

  async get(input: MemoryGetInput): Promise<MemoryGetResult | undefined> {
    const targetPath = normalizeMemoryPath(input.path);
    if (!targetPath) return undefined;
    const listed = await this.config.store.listFiles();
    const listedFile = listed.find((file) => normalizeMemoryPath(file.path) === targetPath);
    if (!listedFile || !this.shouldIncludePath(targetPath)) return undefined;
    const content = listedFile.content ?? (await this.config.store.readFile(listedFile.path));
    if (content === undefined) return undefined;
    const lines = splitLines(content);
    const fromLine = clampPositiveInt(input.fromLine, 1);
    const defaultLines = this.config.defaultGetLineCount ?? defaultGetLineCount;
    const requestedLineCount = clampPositiveInt(input.lineCount, defaultLines);
    const startIndex = Math.min(Math.max(0, fromLine - 1), Math.max(0, lines.length - 1));
    const selected = lines.slice(startIndex, startIndex + requestedLineCount);
    const limited = limitChars(selected.join("\n"), this.config.maxGetChars ?? defaultMaxGetChars);
    const actualLineCount = selected.length;
    const origin = readMemoryProvenance(content)?.origin;
    return {
      ...(origin ? { origin } : {}),
      path: targetPath,
      title: titleFromContent(content) ?? titleFromPath(targetPath),
      source: this.resolveSource(targetPath),
      content: limited.text,
      fromLine: startIndex + 1,
      lineCount: actualLineCount,
      totalLines: lines.length,
      truncated: limited.truncated || startIndex + actualLineCount < lines.length,
      updatedAt: listedFile.updatedAt
    };
  }

  async sync(): Promise<void> {
    // The markdown-wiki runtime is store-backed and reads on demand. Search-index
    // implementations can override this behind the same MemoryRuntime contract.
  }

  private async loadFiles(source: MemorySourceFilter): Promise<LoadedMemoryFile[]> {
    const listed = await this.config.store.listFiles();
    const files: LoadedMemoryFile[] = [];
    for (const file of listed) {
      const normalizedPath = normalizeMemoryPath(file.path);
      if (!normalizedPath || !this.shouldIncludePath(normalizedPath)) continue;
      const fileSource = this.resolveSource(normalizedPath);
      if (source !== "all" && fileSource !== source) continue;
      const content = file.content ?? (await this.config.store.readFile(file.path));
      if (content === undefined) continue;
      files.push({
        path: normalizedPath,
        title: titleFromContent(content) ?? titleFromPath(normalizedPath),
        content,
        source: fileSource,
        updatedAt: file.updatedAt
      });
    }
    return files;
  }

  private shouldIncludePath(filePath: string): boolean {
    const extension = path.posix.extname(filePath).toLowerCase();
    const extensions = this.config.includeExtensions ?? defaultExtensions;
    return extensions.includes(extension);
  }

  private resolveSource(filePath: string): MemorySource {
    const normalized = normalizeMemoryPath(filePath);
    const rawRoot = normalizeRoot(this.config.rawRoot ?? "raw");
    const sessionsRoot = normalizeRoot(this.config.sessionsRoot ?? "sessions");
    const wikiRoot = normalizeRoot(this.config.wikiRoot);
    if (rawRoot && isInsideRoot(normalized, rawRoot)) return "raw";
    if (sessionsRoot && isInsideRoot(normalized, sessionsRoot)) return "sessions";
    if (wikiRoot && isInsideRoot(normalized, wikiRoot)) return "wiki";
    return "wiki";
  }
}

function scoreFile(
  file: LoadedMemoryFile,
  query: string,
  tokens: string[],
  maxSnippetChars: number
): MemorySearchResult | undefined {
  const contentLower = file.content.toLowerCase();
  const titleLower = (file.title ?? "").toLowerCase();
  const pathLower = file.path.toLowerCase();
  const queryLower = query.toLowerCase();
  let rawScore = contentLower.includes(queryLower) ? 5 : 0;
  if (titleLower.includes(queryLower)) rawScore += 4;
  if (pathLower.includes(queryLower)) rawScore += 3;
  for (const token of tokens) {
    rawScore += countOccurrences(contentLower, token);
    rawScore += countOccurrences(titleLower, token) * 3;
    rawScore += countOccurrences(pathLower, token) * 2;
  }
  if (rawScore <= 0) return undefined;
  const { snippet, startLine, endLine } = buildSnippet(file.content, tokens, maxSnippetChars);
  const origin = readMemoryProvenance(file.content)?.origin;
  return {
    ...(origin ? { origin } : {}),
    path: file.path,
    title: file.title,
    source: file.source,
    score: roundScore(rawScore / (rawScore + 8)),
    snippet,
    startLine,
    endLine,
    updatedAt: file.updatedAt
  };
}

function buildSnippet(
  content: string,
  tokens: string[],
  maxChars: number
): { snippet: string; startLine: number; endLine: number } {
  const lines = splitLines(content);
  const matchIndex = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return tokens.some((token) => lower.includes(token));
  });
  const start = Math.max(0, (matchIndex >= 0 ? matchIndex : 0) - 1);
  const end = Math.min(lines.length, start + 4);
  const limited = limitChars(lines.slice(start, end).join("\n").trim(), maxChars);
  return {
    snippet: limited.text,
    startLine: start + 1,
    endLine: end
  };
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );
}

function countOccurrences(value: string, token: string): number {
  if (!value || !token) return 0;
  let count = 0;
  let index = value.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(token, index + token.length);
  }
  return count;
}

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  return lines.length ? lines : [""];
}

function titleFromContent(content: string): string | undefined {
  return content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.replace(/^#\s+/, "")
    .trim();
}

function titleFromPath(filePath: string): string {
  const base = path.posix.basename(filePath, path.posix.extname(filePath));
  return base
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeMemoryPath(filePath: string | undefined): string {
  return (filePath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function normalizeRoot(root: string | undefined): string {
  const normalized = normalizeMemoryPath(root);
  return normalized.replace(/\/+$/, "");
}

function isInsideRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(value));
}

function clampScore(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function limitChars(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, Math.max(0, maxChars)).trimEnd(), truncated: true };
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
