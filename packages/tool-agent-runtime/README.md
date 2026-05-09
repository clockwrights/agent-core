# @maya-ai/tool-agent-runtime

Lean (~280 lines) tool-calling loop driver for LLM agents, built directly on top of [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai). Designed as a domain-neutral, zero-coupling primitive: no imports from any consumer-app code.

The loop drives a multi-turn tool-calling conversation, executes tool batches in parallel by default (or sequentially when any tool in the batch declares `executionMode: "sequential"`), and threads an `AbortSignal` through every `streamSimple` call and every tool's `execute` method so cancellation works end-to-end.

## Install

```bash
npm install @maya-ai/tool-agent-runtime @mariozechner/pi-ai
```

## Public surface

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
- `AgentMessage`, `AgentEvent` — message and streaming-event shapes (structurally compatible with the older `@mariozechner/pi-agent-core` types).
- `runToolAgent(input)` — runs the loop. Accepts a `signal?: AbortSignal` and emits events through the supplied callback.

## Why it exists

The previous incarnation depended on `@mariozechner/pi-agent-core`'s `Agent` class, which does not support `AbortSignal`. This package replaces that single class with a focused loop that has cancellation built in from the first line.

## License

MIT.
