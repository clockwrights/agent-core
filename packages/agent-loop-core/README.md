# @maya-ai/agent-loop-core

Reusable agent-loop core for tool-using LLM agents:

- a generic, retry-aware **tool-agent loop** built on top of [`@maya-ai/tool-agent-runtime`](https://www.npmjs.com/package/@maya-ai/tool-agent-runtime),
- a **document-style agent loop** that wires state, prompt assembly, optional prompt compaction, and finalisation through a typed adapter,
- a **tool registry + policy** model with `domain | mcp | memory | system` sources and `read | write | external` risk levels,
- an **MCP integration** (stdio, SSE, streamable HTTP) that converts MCP catalog tools into agent tools,
- **skills**: load `SKILL.md` files from explicit roots and expose them through a single constrained `read_skill` tool,
- a **memory subsystem** with pluggable `MemoryRuntime`, a built-in markdown-wiki memory runtime, and a markdown-wiki maintenance engine.

The package is domain-neutral. Consumer apps supply the LLM adapter, the domain tools, the prompts, and (optionally) memory and wiki stores. App-specific code lives in the consumer; this package only defines contracts and reusable wiring.

## Install

```bash
npm install @maya-ai/agent-loop-core @maya-ai/tool-agent-runtime
```

Dependencies pulled in transitively: `@modelcontextprotocol/sdk` (for MCP), `typebox` (for tool schemas).

## Public surface (at a glance)

```ts
import {
  // generic tool-agent loop (single + retry pass)
  runToolAgentLoop,
  type ToolAgentLoopInput,
  type ToolAgentLoopRetry,

  // document-style loop with adapter + optional compaction
  runDocumentAgentLoop,
  type DocumentAgentLoopAdapter,
  type DocumentAgentPrompt,
  type CompactionHint,

  // LLM adapter contract consumed by the loops
  type ToolLlmAdapter,
  type ToolAgentInput,
  type ToolAgentOutput,

  // runtime context, prompts, prompt utilities
  type AgentRuntimeContext,
  emptyAgentRuntimeContext,
  disposeAgentRuntimeContext,
  appendRuntimePromptsToSystemPrompt,
  fitWithinBudget,

  // capability assembly
  createAgentRuntimeContextFromConfig,
  type AgentRuntimeCapabilitiesConfig,

  // tool registry + policy
  ToolRegistry,
  defaultToolPolicy,
  resolveTools,
  type RegisteredTool,
  type ToolPolicy,
  type ToolSource,
  type ToolRisk,

  // MCP
  normalizeMcpConfig,
  createMcpRuntime,
  createMcpToolDefinitions,
  createMcpRegistryPreview,
  buildMcpAgentToolName,

  // Memory + markdown wiki
  createMemoryRuntimeContext,
  createMarkdownWikiMemoryRuntime,
  createMarkdownWikiEngine,
  createDefaultMarkdownWikiSupportFiles,
  createDefaultMarkdownWikiGeneratedFiles,
  // ...plus types

  // Skills
  loadSkills,
  formatSkillsForPrompt,
  createSkillsRuntimeContext,
  createSkillToolDefinitions,
} from "@maya-ai/agent-loop-core";
```

## The two loops

### `runToolAgentLoop(input)`

A thin retry layer over a `ToolLlmAdapter`. You provide the adapter, system + user prompt, tools, and (optionally) a retry policy. The loop:

1. calls `llm.runToolAgent({...})` once,
2. if `retry.shouldRetry(output)` is true, builds an appended prompt from `retry.buildRetryPrompt()` and calls the adapter again with a derived session id.

The adapter — not this package — owns the actual conversation. See `ToolLlmAdapter`:

```ts
interface ToolLlmAdapter {
  runToolAgent(input: ToolAgentInput): Promise<ToolAgentOutput | undefined>;
  metadata(): { enabled: boolean };
}
```

A reference adapter that wraps `@maya-ai/tool-agent-runtime` is straightforward to build (translate `ToolAgentInput` → `ToolAgentRunInput`, collect events, return `{ text, toolCalls }`).

### `runDocumentAgentLoop({ llm, adapter, createRuntimeContext?, onProgress? })`

A document-shaped wrapper around `runToolAgentLoop`. The adapter is the integration point:

```ts
interface DocumentAgentLoopAdapter<TState, TResult> {
  createState(): TState;
  buildPrompt(state, runtimeContext): DocumentAgentPrompt;
  compactionThresholdChars?: number;
  compact?(state, runtimeContext, hint: CompactionHint): Promise<DocumentAgentPrompt>;
  createTools(state, runtimeContext): AgentTool<any>[];
  getSessionId(state): string;
  maxTokens?: number;
  progressMessages?: { prepare?; start?; retry?; finalize? };
  getRetry?(state, sessionId): ToolAgentLoopRetry;
  finalize(state, output: ToolAgentOutput): Promise<TResult>;
}
```

The loop creates fresh state, builds the runtime context (capabilities like MCP / memory / skills, contributed via `createRuntimeContext`), optionally compacts the prompt if it exceeds `compactionThresholdChars`, runs the tool agent, and finally calls `finalize`. Runtime context cleanup runs in `finally`.

## Tool registry and policy

```ts
type ToolSource = "domain" | "mcp" | "memory" | "system";
type ToolRisk   = "read" | "write" | "external";

interface ToolPolicy {
  enabled: boolean;
  sources: Partial<Record<ToolSource, boolean>>;
  allow: string[];
  deny: string[];
}
```

Default policy:

```ts
{
  enabled: true,
  sources: { domain: true, mcp: false, memory: false, system: false },
  allow: [],
  deny: []
}
```

`ToolRegistry` accumulates `RegisteredTool[]` (an `AgentTool` + `{ source, risk }`); `resolve(policy)` returns the filtered list to hand to the LLM. The allow/deny lists are applied after source gates; an empty `allow` means "no name-level filter".

## Runtime context and capability assembly

`AgentRuntimeContext` is the value the document loop passes to your adapter:

```ts
interface AgentRuntimeContext {
  toolDefinitions: RegisteredTool[];   // MCP + memory + skill tools
  toolPolicy: ToolPolicy;
  skillsPrompt: string;                 // pre-formatted skills block, may be empty
  memoryPrompt: string;                 // pre-formatted memory block, may be empty
  diagnostics: AgentRuntimeDiagnostic[];
  dispose?: () => Promise<void>;
}
```

Use `appendRuntimePromptsToSystemPrompt(systemPrompt, ctx)` to append the skills + memory blocks to your domain system prompt.

For most apps the easiest entry point is `createAgentRuntimeContextFromConfig`, which takes a single config and returns a ready-to-use context:

```ts
import { createAgentRuntimeContextFromConfig } from "@maya-ai/agent-loop-core";

const runtime = await createAgentRuntimeContextFromConfig({
  mcp: { enabled: true, config: mcpConfig, toolAllow: [], toolDeny: [] },
  memory: { enabled: true, markdownWiki: { store: myWikiFileStore } },
  skills: { enabled: true, roots: ["skills", ".agents/skills"] },
  toolPolicy: { /* optional overrides */ },
});
```

When you are done, call `await disposeAgentRuntimeContext(runtime)` (or rely on `runDocumentAgentLoop`'s automatic cleanup).

## MCP

Supported transports: **stdio**, **SSE**, **streamable-http**.

| Function | Purpose |
|---|---|
| `normalizeMcpConfig(raw)` | Validate a JSON-shaped MCP config; returns `{ config, diagnostics }`. |
| `createMcpRuntime({ enabled, config })` | Connect to configured servers; exposes `getCatalog()`, `callTool()`, `dispose()`. |
| `createMcpToolDefinitions(runtime)` | Turn the runtime catalog into `RegisteredTool[]` (source `mcp`, risk `external`). |
| `createMcpRegistryPreview({...})` | Dev/test helper that lists registered + policy-resolved tools. |
| `buildMcpAgentToolName(server, tool)` | The deterministic naming function. |

MCP tool names are normalised as `mcp__<server>__<tool>` with non-alphanumeric characters replaced by underscores. Example: server `file-system.local`, tool `read/file` → `mcp__file_system_local__read_file`. Duplicates are disambiguated with a `_2`, `_3`, … suffix.

Per-server connect / list / call timeouts default to 30s / 30s / 60s and can be overridden via `connectionTimeoutMs` on a server config.

## Skills

Skills are tiny `SKILL.md` files describing a reusable procedure. `loadSkills` scans `<root>/SKILL.md` and `<root>/*/SKILL.md` under each configured root, parses the YAML-style frontmatter, and returns a list of entries:

```md
---
name: review_package
description: Review a documentation package for completeness.
---

Step-by-step instructions for the model…
```

Required frontmatter keys: `name`, `description`. Files larger than `maxSkillFileBytes` (default 128 KB) are skipped with a diagnostic.

`formatSkillsForPrompt(skills)` produces a compact XML-style block (name, description, file path — *not* the body), capped at `maxPromptChars` (default 12 000). The body is loaded into memory only — exposed through the `read_skill` tool registered by `createSkillToolDefinitions(skills)`. `read_skill` accepts either `name` or `filePath` and returns the full body; it has no arbitrary filesystem access.

The convenience wrapper `createSkillsRuntimeContext(config)` ties the loader and prompt formatter together.

## Memory subsystem

The memory subsystem has two independent layers:

- **Memory runtime** — read/search access used by the agent at inference time (tools `memory_search`, `memory_get`).
- **Markdown-wiki engine** — write/maintain access used by the app to keep a structured markdown knowledge base healthy (tools `wiki_lint`, `wiki_update_index`, `wiki_append_log`, `wiki_record_relationship`).

The wiki engine is intentionally separate from the runtime so apps can sync the wiki on ingestion or lifecycle events without exposing maintenance tools to the agent.

### Memory runtime contract

```ts
interface MemoryRuntime {
  status(): MemoryRuntimeStatus;
  diagnostics?(): MemoryRuntimeDiagnostic[];
  buildPromptSection?(input: { availableTools: Set<string> }): string;
  createToolDefinitions?(): RegisteredTool[];   // override the default memory tools
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  get(input: MemoryGetInput): Promise<MemoryGetResult | undefined>;
  sync?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

`MemorySource = "wiki" | "raw" | "sessions"` classifies each file; callers can filter searches by source (or `"all"`).

Default tools registered when you don't override `createToolDefinitions`:

| Tool | Risk | Purpose |
|---|---|---|
| `memory_search` | `read` | Scored full-text search; returns path, title, source, score, snippet. |
| `memory_get` | `read` | Bounded read by path and line window; returns content + line metadata. |

### Built-in: markdown-wiki memory runtime

`createMarkdownWikiMemoryRuntime({ store, ... })` is a turnkey `MemoryRuntime` backed by a `MarkdownWikiFileStore`:

```ts
interface MarkdownWikiFileStore {
  listFiles(): Promise<MarkdownWikiFile[]>; // { path, content, updatedAt? }
  readFile(path: string): Promise<string | undefined>;
}
```

Store files anywhere — in-memory map, database, filesystem, external index — and back it with this interface.

Scoring used by `search`:

| Signal | Points |
|---|---|
| Exact phrase in content | 5 |
| Exact phrase in title | 4 |
| Exact phrase in path | 3 |
| Each query token in content | +1 per occurrence |
| Each query token in title | +3 per occurrence |
| Each query token in path | +2 per occurrence |

Final score is `raw / (raw + 8)`, capped to `0..1`, sorted descending, truncated to `maxResults`.

Default knobs (override via the runtime config):

| Setting | Default |
|---|---|
| Max search results | 8 |
| Search snippet chars | 700 |
| `memory_get` excerpt chars | 12 000 |
| `memory_get` default line count | 120 |

Included extensions: `.md`, `.mdx`, `.txt`, `.jsonl`.

### Markdown-wiki engine

`createMarkdownWikiEngine({ store, ... })` is the maintenance backend. The app supplies an `MarkdownWikiEngineStore`:

```ts
interface MarkdownWikiEngineStore {
  listFiles(): MarkdownWikiEngineFile[];     // { path, content, updatedAt? }
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
}
```

`MarkdownWikiEngineConfig` fields:

| Field | Required | Purpose |
|---|---|---|
| `store` | yes | File I/O backend. |
| `metadata` | no | Key/value headers rendered into generated files. |
| `requiredFiles` | no | Support files to create when missing. Default: `index.md`, `log.md`, `graph/relationships.jsonl`, `graph/context-brief.md`, `graph/open-gaps.md`. |
| `generatedFiles` | no | Files re-rendered on every `sync` / `updateGeneratedFiles`. Renderer receives `MarkdownWikiEngineRenderContext`. |
| `relationshipTypes` | no | Allowed edge types for lint validation. |
| `logPath` | no | Default `log.md`. |
| `relationshipsPath` | no | Default `graph/relationships.jsonl`. |
| `categorizePath` | no | `(path) => category` used by the index renderer. |
| `summarizeContent` | no | `(content) => oneLine` used by the index renderer. |
| `clock` | no | `() => isoString`; override for deterministic tests. |

Engine methods:

| Method | Behaviour |
|---|---|
| `ensureSupportFiles()` | Creates any missing required files. Returns the paths it wrote. |
| `sync(options?)` | `ensureSupportFiles` + optional `recordRelationships` + optional `appendLog` + `updateGeneratedFiles`. Returns all changed paths. |
| `updateGeneratedFiles()` | Re-renders every configured generated file. |
| `appendLog({ action, details, affectedFiles? })` | Appends a dated log entry to `log.md`. |
| `recordRelationships(edges)` | Deduplicates by `from\|to\|type` and appends new JSONL edges. Returns count added. |
| `readRelationships()` | Reads and parses JSONL edges. |
| `lint()` | Returns `MarkdownWikiLintReport`: missing support files (critical), broken `[[wikilinks]]` (warning), malformed / unknown-type / dangling edges (critical/warning). |
| `renderIndex(options?)` | Renders a grouped markdown catalog of all files. |

Relationship edges are stored as JSONL:

```json
{ "from": "product-overview.md", "to": "feature-map.md", "type": "requires", "evidence": "...", "date": "2026-05-01" }
```

### Wiring memory into the agent

```ts
import { createMemoryRuntimeContext } from "@maya-ai/agent-loop-core";

const ctx = await createMemoryRuntimeContext({
  enabled: true,
  // either bring your own runtime…
  runtime: myRuntime,
  // …or supply a markdown-wiki file store
  markdownWiki: { store: myFileStore },
  // optionally expose maintenance tools too
  markdownWikiEngine: myEngine,
  toolAllow: [],
  toolDeny: [],
});

// ctx.toolDefinitions  → RegisteredTool[] (memory_search, memory_get, wiki_*)
// ctx.memoryPrompt     → string to append to the system prompt
// ctx.diagnostics      → startup info / warnings / errors
// ctx.runtime          → the active MemoryRuntime
```

Tools exposed when `markdownWikiEngine` is supplied:

| Tool | Risk | Purpose |
|---|---|---|
| `wiki_lint` | `read` | Lint report (critical / warning / info issues). |
| `wiki_update_index` | `write` | Regenerate all configured generated files. |
| `wiki_append_log` | `write` | Append a dated action entry to the wiki log. |
| `wiki_record_relationship` | `write` | Record one de-duplicated typed edge. |

## Suggested env var conventions (consumer-side)

This package itself reads no environment variables. The consumer app's bridge typically reads:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MCP_ENABLED` | `false` | Enable MCP runtime preparation. |
| `AGENT_MCP_CONFIG_JSON` | — | JSON for MCP server definitions. |
| `AGENT_MCP_TOOL_ALLOW` / `_DENY` | empty | Allow/deny lists of normalised MCP tool names. |
| `AGENT_MEMORY_ENABLED` | `false` | Enable memory runtime. |
| `AGENT_MEMORY_TOOL_ALLOW` / `_DENY` | empty | Allow/deny lists of memory tool names. |
| `AGENT_MEMORY_MAX_SEARCH_RESULTS` | `8` | `memory_search` cap. |
| `AGENT_MEMORY_MAX_SNIPPET_CHARS` | `700` | Snippet length. |
| `AGENT_MEMORY_MAX_GET_CHARS` | `12000` | `memory_get` cap. |
| `AGENT_MEMORY_DEFAULT_GET_LINES` | `120` | `memory_get` default window. |
| `AGENT_SKILLS_ENABLED` | `false` | Load `SKILL.md` and expose `read_skill`. |
| `AGENT_SKILL_ROOTS` | e.g. `skills,.agents/skills` | Comma-separated skill roots. |
| `AGENT_SKILL_ALLOW` / `_DENY` | empty | Allow/deny lists by skill name. |
| `AGENT_SKILL_MAX_FILE_BYTES` | `131072` | Skip oversized `SKILL.md` files. |
| `AGENT_SKILL_MAX_PROMPT_CHARS` | `12000` | Cap on the compact skills prompt. |
| `AGENT_TOOL_ALLOW` / `_DENY` | empty | Final allow/deny across all exposed tools. |

Naming and source (env, file, secrets manager, …) are entirely the consumer's choice — the package just consumes the resulting config object.

## Sibling packages

- [`@maya-ai/tool-agent-runtime`](https://www.npmjs.com/package/@maya-ai/tool-agent-runtime) — the underlying multi-turn loop and `AgentTool` types.
- [`@maya-ai/agent-loop-orchestration`](https://www.npmjs.com/package/@maya-ai/agent-loop-orchestration) — multi-agent delegation built on top of this loop.
- [`@maya-ai/llm-profiles`](https://www.npmjs.com/package/@maya-ai/llm-profiles) — file/env-driven LLM routing config you can use to construct your `ToolLlmAdapter`.

## License

MIT.

## Provenance

Built with a slightly unruly coalition of AI tools and automation. Humans were mostly present for testing, guardrails, and the occasional "nope, not like that" intervention.
