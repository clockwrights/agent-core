# maya-ai

Composable building blocks for tool-using LLM agent applications.

This monorepo follows a strict "zero domain coupling" rule: every package is intentionally reusable and documented at the component level.

## Why this repo exists

- Build robust agent systems from focused, reusable parts.
- Keep runtime contracts portable across apps.
- Separate generic agent infrastructure from domain logic.

## Packages

| Package | Purpose |
|---|---|
| [`@maya-ai/tool-agent-runtime`](./packages/tool-agent-runtime) | Domain-neutral tool-calling runtime with event streaming and validated tool execution. |
| [`@maya-ai/agent-loop-core`](./packages/agent-loop-core) | Tool registry, runtime context, MCP integration, skills, and the agent memory subsystem (incl. markdown-wiki engine). |
| [`@maya-ai/agent-loop-orchestration`](./packages/agent-loop-orchestration) | Multi-agent orchestration: parent run delegates bounded subtasks to child runs via `delegate_task` / `delegate_tasks`. |
| [`@maya-ai/document-pipeline`](./packages/document-pipeline) | Ingest PDFs, images, Office docs, ZIP archives into a normalized analysis package with three-tier classification. |
| [`@maya-ai/document-policies`](./packages/document-policies) | Manifest + Markdown body loader for named natural-language document policies. |
| [`@maya-ai/llm-profiles`](./packages/llm-profiles) | Multi-LLM profile config schema, loader with `${ENV_VAR}` interpolation, and a generic memoizing router. |

## Related repository

- [`maya-intelligence/agent-core`](https://github.com/maya-intelligence/agent-core): companion project with broader agent runtime and application patterns.

## Workspace commands

```bash
npm install
npm run build      # build every package
npm run test       # run every package's test script
```

## Provenance

Large parts of this codebase were generated and iterated by AI tooling in a highly caffeinated toolchain relay race.

Humans mostly showed up as QA gremlins: testing, poking edge cases, and occasionally confiscating the keyboard when the robots got too bold.
