# Agent Loop Core

> **Reusable component.** Lives at `server/src/agent-loop/core/`. Self-contained — zero imports from outside the directory except external npm deps and node built-ins. This document travels with the component.

Related repository: [`maya-intelligence/agent-core`](https://github.com/maya-intelligence/agent-core)

The reusable agent-loop core for tool-using LLM agents: tool registry, runtime context, MCP integration, and skills. Memory and the markdown-wiki engine are a sub-component documented in the **Memory subsystem** section below. App-specific code lives in the consumer and uses the contracts defined here.

---

## What lives in core

Core owns:

- Document-agent loop orchestration
- Tool-loop execution contracts
- Generic tool registry and policy
- Runtime prompt composition
- MCP config parsing, runtime connections, tool adaptation, registry preview helpers
- Skills loading, compact prompt formatting, and the constrained `read_skill` system tool
- Memory runtime wiring (`createMemoryRuntimeContext`) — the memory contracts, tools, and markdown-wiki engine live in `core/memory/` and are documented in [`agent-memory`](./agent-memory.md)

Core does **not** own:

- Domain tools or domain prompt content
- Domain memory stores or renderers
- Environment-variable parsing (the consumer app supplies a runtime context)
- Concrete LLM provider construction (uses the `ToolLlmAdapter` contract; see [`llm-profiles`](./llm-profiles.md))

---

## Tool Registry

`toolRegistry.ts` defines:

- `ToolSource`: `domain | mcp | memory | system`
- `ToolRisk`: `read | write | external`
- `RegisteredTool`: an `AgentTool` plus metadata
- `ToolPolicy`: enabled flag, source gates, and final allow/deny lists

Default policy:

```ts
{
  enabled: true,
  sources: { domain: true, mcp: false, memory: false, system: false },
  allow: [],
  deny: []
}
```

Domain tools remain enabled by default. MCP, memory, and system tools are off unless a caller enables them through runtime capability configuration. The final allow/deny gates apply after domain, MCP, memory, and skill/system tools are merged.

---

## Runtime Context

`runtimeContext.ts` defines `AgentRuntimeContext`:

- extra `toolDefinitions`
- `toolPolicy`
- optional `skillsPrompt`
- optional `memoryPrompt`
- diagnostics
- optional cleanup function

`documentAgentLoop.ts` accepts a `createRuntimeContext` factory. Reusable capabilities are created by the generic loop and passed into adapters rather than hardcoded into domain logic.

`runtimePrompt.ts` exposes `appendRuntimePromptsToSystemPrompt`, which appends optional skills and memory prompt blocks to a domain prompt.

---

## MCP

MCP support is split into stages:

| File | Responsibility |
|------|----------------|
| `mcpConfig.ts` | Parses and validates config |
| `mcpRuntime.ts` | Connects to MCP servers and lists/calls tools |
| `mcpToolAdapter.ts` | Converts MCP catalog tools into `RegisteredTool[]` |
| `mcpRegistryPreview.ts` | Dev/test helper to preview registered and policy-resolved tools |

Supported transports: **stdio**, **SSE**, **streamable HTTP**.

MCP tool names are normalised as `mcp__<server>__<tool>`. Non-alphanumeric characters become underscores. Example: server `file-system.local` tool `read/file` becomes `mcp__file_system_local__read_file`.

---

## Skills

Skills are loaded from explicit roots and exposed through a compact prompt plus a constrained `read_skill` system tool. They do **not** install dependencies or execute commands.

`skillLoader.ts` scans:

- `<root>/SKILL.md`
- `<root>/*/SKILL.md`

`SKILL.md` must start with simple single-line frontmatter:

```md
---
name: package_review
description: Review the package for completeness.
---

Instructions...
```

`skillPrompt.ts` formats a compact XML-style prompt block with skill name, description, and file location. Full skill body is loaded into memory but **not** injected into the prompt by default.

`skillTools.ts` registers `read_skill` when skills are loaded. The tool reads only from the already-loaded skill catalog by skill name or listed file path; it does not provide arbitrary filesystem access.

---

## Memory

Memory lives at `core/memory/` and is fully documented in **[`agent-memory`](./agent-memory.md)**.

In brief: `createMemoryRuntimeContext(config)` wires an optional `MemoryRuntime` (read/search), an optional `MarkdownWikiEngine` (write/maintain), and tool allow/deny lists into a `MemoryRuntimeContext` that the agent loop merges into its runtime context. The markdown-wiki implementation in `core/memory/markdown-wiki/` is storage-agnostic and supplies `memory_search`, `memory_get`, and the four `wiki_*` maintenance tools.

---

## App Opt-In (env vars consumed by the integration layer)

Runtime capabilities are off by default. The consumer app's bridge (in this app: `server/src/config/runtimeCapabilities.ts`) reads:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_MCP_ENABLED` | `false` | Enables MCP runtime preparation. |
| `AGENT_MCP_CONFIG_JSON` | _(none)_ | JSON object with MCP server definitions. Supports stdio / SSE / streamable-HTTP transports. |
| `AGENT_MCP_TOOL_ALLOW` | _(empty)_ | Comma-separated allowlist of normalised MCP tool names. |
| `AGENT_MCP_TOOL_DENY` | _(empty)_ | Comma-separated denylist of normalised MCP tool names. |
| `AGENT_MEMORY_ENABLED` | `false` | Enables memory runtime preparation, injects memory guidance, exposes memory tools. See [`agent-memory`](./agent-memory.md) for the full `AGENT_MEMORY_*` table. |
| `AGENT_SKILLS_ENABLED` | `false` | Loads `SKILL.md` files, exposes `read_skill`. |
| `AGENT_SKILL_ROOTS` | `skills,.agents/skills` (when enabled) | Comma-separated skill roots. |
| `AGENT_SKILL_ALLOW` | _(empty)_ | Comma-separated allowlist of skill names from frontmatter. |
| `AGENT_SKILL_DENY` | _(empty)_ | Comma-separated denylist of skill names from frontmatter. |
| `AGENT_SKILL_MAX_FILE_BYTES` | `131072` | Max `SKILL.md` size; oversized files are skipped. |
| `AGENT_SKILL_MAX_PROMPT_CHARS` | `12000` | Cap for the compact skills prompt block. |
| `AGENT_TOOL_ALLOW` | _(empty)_ | Final allowlist across all exposed tools (including domain tools). |
| `AGENT_TOOL_DENY` | _(empty)_ | Final denylist across all exposed tools. |

These env vars are **consumed by the consumer app, not by core**. Core itself reads no env. A different app may surface these capabilities under different names or via a config file.

---

## Tests

`server/test/markdownWikiEngine.test.ts` covers the engine. Domain-tool tests live in the consumer app's test tree. Core tests do not exercise live network or LLM calls.

---

## Extracting Core to Another App

To move core into another project:

1. Install `@maya-ai/agent-loop-core` and its peer `@maya-ai/tool-agent-runtime` (core types `AgentTool` / `AgentToolResult` come from there).
2. Provide an app bridge that reads env/config and produces an `AgentRuntimeContext` (use `createAgentRuntimeContextFromConfig`).
3. Provide a domain adapter: domain tools, prompt content, optional memory store, optional markdown-wiki engine store, finalisation behaviour.
4. Optionally implement a domain `MarkdownWikiFileStore` or another `MemoryRuntime` — see the Memory subsystem section below for the full extraction checklist.
5. Optionally implement a domain `MarkdownWikiEngineStore` and renderers for markdown-wiki maintenance.
6. Decide which capability sources are enabled by default for that app.

The reusable contract is intentionally narrow: the domain adapter consumes only the generic `AgentRuntimeContext`. It does **not** parse MCP config, connect to MCP servers, scan skill roots, or know about environment variables.

## Provenance

Built with a slightly unruly coalition of AI tools and automation.
Humans were mostly present for testing, guardrails, and the occasional "nope, not like that" intervention.


---

# Agent Memory

> **Reusable component.** Lives at `server/src/agent-loop/core/memory/`. Self-contained within the `agent-loop/core` module — zero imports from outside `agent-loop/core/` except external npm deps and node built-ins. This document travels with the component.

The agent memory subsystem provides pluggable, read-only memory access for tool-using LLM agents, plus a reusable markdown-wiki maintenance engine for apps that need to manage a structured knowledge base. Both layers are storage-agnostic and domain-neutral.

---

## Architecture

```
agent-loop/core/memory/
├─ memoryTypes.ts             MemoryRuntime interface + I/O types
├─ memoryTools.ts             memory_search / memory_get tool definitions
├─ memoryRuntimeContext.ts    MemoryConfig → MemoryRuntimeContext factory
├─ index.ts                   public barrel export
└─ markdown-wiki/
   ├─ markdownWikiMemoryRuntime.ts   MarkdownWikiFileStore → MemoryRuntime
   ├─ markdownWikiEngine.ts          MarkdownWikiEngineStore → MarkdownWikiEngine
   ├─ markdownWikiTools.ts           wiki_lint / wiki_update_index / wiki_append_log / wiki_record_relationship
   └─ index.ts                       public barrel export
```

Two independent layers:

- **Memory runtime** — read/search access the agent uses at inference time.
- **Wiki engine** — write/maintain access an app uses to keep the wiki up to date.

The wiki engine is intentionally separate from the runtime so apps can sync the wiki on ingestion or lifecycle events even before exposing maintenance tools to the agent.

---

## Memory Runtime Contract

`memoryTypes.ts` defines `MemoryRuntime`:

```ts
interface MemoryRuntime {
  status(): MemoryRuntimeStatus;
  diagnostics?(): MemoryRuntimeDiagnostic[];
  buildPromptSection?(input: MemoryPromptInput): string;
  createToolDefinitions?(): RegisteredTool[];
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  get(input: MemoryGetInput): Promise<MemoryGetResult | undefined>;
  sync?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

`MemorySource` (`wiki | raw | sessions`) classifies where a file comes from. Agents can filter by source.

---

## Core Agent Tools

`memoryTools.ts` registers two tools (source `memory`, risk `read`):

| Tool | Purpose |
|------|---------|
| `memory_search` | Full-text scored search; returns path, title, source, score, snippet |
| `memory_get` | Bounded read by path and line window; returns content with line metadata |

If the `MemoryRuntime` supplies its own `createToolDefinitions()` these replace the defaults.

---

## Markdown-Wiki Memory Runtime

`createMarkdownWikiMemoryRuntime(config)` is the built-in `MemoryRuntime` implementation, backed by any object that satisfies:

```ts
interface MarkdownWikiFileStore {
  listFiles(): Promise<MarkdownWikiFile[]>;   // { path, content, updatedAt? }
  readFile(path: string): Promise<string | undefined>;
}
```

Store the files anywhere — in-memory map, database, file system, or external index — and back it with this interface.

### Search scoring

For each file the runtime computes a raw score:

| Signal | Points |
|--------|--------|
| Exact phrase in content | 5 |
| Exact phrase in title | 4 |
| Exact phrase in path | 3 |
| Each query token in content | +1 per occurrence |
| Each query token in title | +3 per occurrence (3× weight) |
| Each query token in path | +2 per occurrence (2× weight) |

Normalized score: `rawScore / (rawScore + 8)` → `0..1`. Results sorted by score descending and capped at `maxResults`.

### Default configuration

| Setting | Default | Env override |
|---------|---------|-------------|
| Max search results | 8 | `AGENT_MEMORY_MAX_SEARCH_RESULTS` |
| Search snippet chars | 700 | `AGENT_MEMORY_MAX_SNIPPET_CHARS` |
| Get excerpt chars | 12 000 | `AGENT_MEMORY_MAX_GET_CHARS` |
| Get default line count | 120 | `AGENT_MEMORY_DEFAULT_GET_LINES` |

Included extensions: `.md`, `.mdx`, `.txt`, `.jsonl`.

---

## Markdown-Wiki Engine

`createMarkdownWikiEngine(config)` is the maintenance backend. The app supplies an `MarkdownWikiEngineStore`:

```ts
interface MarkdownWikiEngineStore {
  listFiles(): MarkdownWikiEngineFile[];   // { path, content, updatedAt? }
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
}
```

Full config shape (`MarkdownWikiEngineConfig`):

| Field | Required | Purpose |
|-------|----------|---------|
| `store` | yes | File I/O backend |
| `metadata` | no | Key/value headers rendered into generated files |
| `requiredFiles` | no | Support files to create if missing (default: `index.md`, `log.md`, `graph/relationships.jsonl`, `graph/context-brief.md`, `graph/open-gaps.md`) |
| `generatedFiles` | no | Files re-rendered on every sync (renderer receives a `MarkdownWikiEngineRenderContext`) |
| `relationshipTypes` | no | Allowed edge types for lint validation |
| `logPath` | no | Defaults to `log.md` |
| `relationshipsPath` | no | Defaults to `graph/relationships.jsonl` |
| `categorizePath` | no | Path → category label for index grouping |
| `summarizeContent` | no | Content → one-line summary for index entries |
| `clock` | no | `() => string` returning ISO timestamp — override for deterministic tests |

### Engine methods

| Method | Description |
|--------|-------------|
| `ensureSupportFiles()` | Creates missing required files; returns changed paths |
| `sync(options?)` | `ensureSupportFiles` + optional log append + optional relationship record + `updateGeneratedFiles`; returns all changed paths |
| `updateGeneratedFiles()` | Re-renders all configured generated files; returns paths |
| `appendLog(entry)` | Appends a dated markdown log entry to `log.md` |
| `recordRelationships(edges)` | De-duplicates and appends JSONL edges; returns count added |
| `readRelationships()` | Reads and parses JSONL edges |
| `lint()` | Returns `MarkdownWikiLintReport` — missing support files (critical), broken `[[wikilinks]]` (warning), malformed/unknown-type/dangling relationship edges (critical/warning) |
| `renderIndex(options?)` | Renders a grouped markdown catalog of all files |

### Relationship graph

Relationships are stored as JSONL. Each edge:

```json
{ "from": "product-overview.md", "to": "feature-map.md", "type": "requires", "evidence": "...", "date": "2025-01-01" }
```

De-duplication key: `from|to|type`. The app configures `relationshipTypes` to constrain what types lint accepts.

### Default support and generated files

```
index.md                  grouped file catalog (generated on sync)
log.md                    append-only markdown log
graph/relationships.jsonl typed relationship edges (JSONL)
graph/context-brief.md    recent relationship summary (generated on sync)
graph/open-gaps.md        app-supplied gap renderer or placeholder
```

---

## Wiki Maintenance Tools

When an app supplies a `MarkdownWikiEngine` to `createMemoryRuntimeContext`, four maintenance tools are exposed (source `memory`):

| Tool | Risk | Description |
|------|------|-------------|
| `wiki_lint` | `read` | Returns a lint report with critical, warning, and info issues |
| `wiki_update_index` | `write` | Regenerates all configured generated files |
| `wiki_append_log` | `write` | Appends a dated action entry to the wiki log |
| `wiki_record_relationship` | `write` | Records one de-duplicated typed relationship edge |

All four are domain-neutral. The app-supplied engine provides valid relationship types, generated-file renderers, and support-file definitions.

---

## Wiring into the Agent (`createMemoryRuntimeContext`)

`memoryRuntimeContext.ts` exports the factory that agent loops use:

```ts
interface MemoryConfig {
  enabled: boolean;
  runtime?: MemoryRuntime;            // bring your own MemoryRuntime, or ...
  markdownWiki?: MarkdownWikiMemoryRuntimeConfig;  // ... supply a file store
  markdownWikiEngine?: MarkdownWikiEngine;          // optional maintenance tools
  toolAllow?: string[];
  toolDeny?: string[];
}

const ctx: MemoryRuntimeContext = await createMemoryRuntimeContext(config);
// ctx.toolDefinitions  → RegisteredTool[] (memory_search, memory_get, wiki_*)
// ctx.memoryPrompt     → string injected into the system prompt
// ctx.diagnostics      → startup warnings/errors
// ctx.runtime          → the active MemoryRuntime
```

---

## App Opt-In (env vars consumed by the integration bridge)

The component itself reads no env vars. The consumer app's bridge reads them and passes the result to `createMemoryRuntimeContext`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_MEMORY_ENABLED` | `false` | Enables memory runtime preparation |
| `AGENT_MEMORY_TOOL_ALLOW` | _(empty)_ | Comma-separated allowlist of memory tool names |
| `AGENT_MEMORY_TOOL_DENY` | _(empty)_ | Comma-separated denylist of memory tool names |
| `AGENT_MEMORY_MAX_SNIPPET_CHARS` | `700` | Max characters per search snippet |
| `AGENT_MEMORY_MAX_GET_CHARS` | `12000` | Max characters per `memory_get` |
| `AGENT_MEMORY_DEFAULT_GET_LINES` | `120` | Default line count when `memory_get` omits one |
| `AGENT_MEMORY_MAX_SEARCH_RESULTS` | `8` | Default max results for `memory_search` |

---

## Tests

`test/markdownWikiEngine.test.ts` covers the engine. Domain-specific tests
for the consumer's wiki integration belong in the consumer app's test tree.

---

## Integrating into a consumer app

Checklist:

1. Install `@maya-ai/agent-loop-core` and `@maya-ai/tool-agent-runtime`.
2. Implement a `MarkdownWikiFileStore` for read access (in-memory map, filesystem, database — your choice).
3. Implement a `MarkdownWikiEngineStore` for write/maintenance.
4. Supply domain-specific `relationshipTypes`, `categorizePath`, `generatedFiles` to `createMarkdownWikiEngine`.
5. Call `createMemoryRuntimeContext(config)` from your agent-loop bootstrap and pass `toolDefinitions` + `memoryPrompt` into the runtime context.
6. Wire env vars (or an equivalent config source) for the settings in the table above.
7. Optionally implement a domain linter on top of `engine.lint()` for domain-specific validation rules.
