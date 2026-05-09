# @maya-ai/tool-agent-runtime

Lean (~280 lines) tool-calling loop driver for LLM agents built directly on top of [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai).

The loop drives multi-turn tool-calling conversations, executes tool batches in parallel by default (or sequentially when any tool declares `executionMode: "sequential"`), and threads an `AbortSignal` through every LLM call and every tool's `execute` method for end-to-end cancellation support.

## Install

```bash
npm install @maya-ai/tool-agent-runtime @mariozechner/pi-ai
```

## Public API

```ts
import {
  runToolAgent,
  type AgentTool,
  type AgentToolResult,
  type AgentMessage,
  type AgentEvent,
  type AgentToolUpdateCallback,
} from "@maya-ai/tool-agent-runtime";
```

- `AgentTool`, `AgentToolResult` — your tool contract: a `name`, `description`, JSON-schema `parameters`, and an async `execute(args, ctx)` that returns content + optional artefacts.
- `AgentMessage`, `AgentEvent` — message and event shapes for streaming agent interactions.
- `runToolAgent(input)` — runs the agent loop. Accepts a `signal?: AbortSignal` and emits events through the supplied callback.

## Features

- **Parallel tool execution** — batches run in parallel by default for efficiency
- **Sequential mode** — tools can declare `executionMode: "sequential"` when needed
- **Full cancellation support** — `AbortSignal` flows through LLM calls and tool execution
- **Lightweight** — minimal dependencies and focused responsibility

## License

MIT.
