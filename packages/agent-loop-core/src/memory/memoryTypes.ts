import type { RegisteredTool } from "../toolRegistry.js";
import type { MemoryOrigin } from "./provenance.js";

export type MemorySource = "wiki" | "raw" | "sessions";
export type MemorySourceFilter = MemorySource | "all";

export interface MemoryRuntimeDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
}

export interface MemoryRuntimeStatus {
  enabled: boolean;
  provider: string;
  sources: MemorySource[];
}

export interface MemoryPromptInput {
  availableTools: Set<string>;
}

export interface MemorySearchInput {
  query: string;
  maxResults?: number;
  minScore?: number;
  source?: MemorySourceFilter;
}

export interface MemorySearchResult {
  path: string;
  title?: string;
  source: MemorySource;
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  updatedAt?: string;
  /** Provenance origin of an agent-written page, when it has provenance. */
  origin?: MemoryOrigin;
}

export interface MemoryGetInput {
  path: string;
  fromLine?: number;
  lineCount?: number;
}

export interface MemoryGetResult {
  path: string;
  title?: string;
  source: MemorySource;
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines: number;
  truncated: boolean;
  updatedAt?: string;
  /** Provenance origin of an agent-written page, when it has provenance. */
  origin?: MemoryOrigin;
}

export interface MemoryRuntime {
  status(): MemoryRuntimeStatus;
  diagnostics?(): MemoryRuntimeDiagnostic[];
  buildPromptSection?(input: MemoryPromptInput): string;
  createToolDefinitions?(): RegisteredTool[];
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  get(input: MemoryGetInput): Promise<MemoryGetResult | undefined>;
  sync?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface MemoryRuntimeContext {
  runtime?: MemoryRuntime;
  toolDefinitions: RegisteredTool[];
  memoryPrompt: string;
  diagnostics: MemoryRuntimeDiagnostic[];
  /**
   * Rendered always-loaded tier when `pinnedMemory` is configured. Put it in
   * the user side of the conversation (for example as its own message with
   * `pinnedMemoryMessages`, or in front of the prompt with `pinnedMemoryPrompt`),
   * not the system prompt, so memory updates do not invalidate the cached
   * system prompt.
   */
  pinnedMemory?: string;
}
