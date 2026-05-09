# maya-ai

Reusable building blocks for tool-using LLM agent applications. Each package was developed under a strict "zero domain coupling" rule and ships with its own component-level documentation.

## Packages

| Package | Purpose |
|---|---|
| [`@maya-ai/tool-agent-runtime`](./packages/tool-agent-runtime) | Lean tool-calling loop driver over `@mariozechner/pi-ai`, with full `AbortSignal` support. |
| [`@maya-ai/agent-loop-core`](./packages/agent-loop-core) | Tool registry, runtime context, MCP integration, skills, and the agent memory subsystem (incl. markdown-wiki engine). |
| [`@maya-ai/agent-loop-orchestration`](./packages/agent-loop-orchestration) | Multi-agent orchestration: parent run delegates bounded subtasks to child runs via `delegate_task` / `delegate_tasks`. |
| [`@maya-ai/document-pipeline`](./packages/document-pipeline) | Ingest PDFs, images, Office docs, ZIP archives → normalised analysis package with three-tier classification. |
| [`@maya-ai/document-policies`](./packages/document-policies) | Manifest + Markdown body loader for named natural-language document policies. |
| [`@maya-ai/llm-profiles`](./packages/llm-profiles) | Multi-LLM profile config schema, loader with `${ENV_VAR}` interpolation, and a generic memoising router. |

## Workspace commands

```bash
npm install
npm run build      # build every package
npm run test       # run every package's test script
```

## Publishing

See [PUBLISHING.md](./PUBLISHING.md).
