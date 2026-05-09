# @maya-ai/tool-agent-runtime

Lightweight, domain-neutral runtime for tool-calling LLM agents.

Related repository: [`maya-intelligence/agent-core`](https://github.com/maya-intelligence/agent-core)

This package provides one core loop function (`runToolAgent`) plus shared runtime types (`AgentTool`, `AgentToolResult`, `AgentEvent`, `AgentMessage`).

The loop:

- starts from one user prompt (optionally with image attachments),
- streams assistant output events while the model responds,
- executes tool calls requested by the assistant,
- feeds tool results back into the conversation,
- repeats until the assistant stops calling tools, an error/abort occurs, or tool results signal termination.

## Install

```bash
npm install @maya-ai/tool-agent-runtime
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

`runToolAgent(input, emit)`

- Runs a multi-turn tool loop.
- Emits lifecycle, message streaming, and tool execution events through `emit`.
- Forwards cooperative cancellation (`AbortSignal`) to both model streaming and tool execution.

`AgentTool`

- Extends the pi-ai tool shape with:
  - `label` for UI/progress display,
  - optional `prepareArguments(args)` shim before validation,
  - `execute(toolCallId, params, signal, onUpdate)`,
  - optional `executionMode` (`parallel` or `sequential`).

`AgentToolResult`

- Contains `content` and `details`.
- Optional `terminate` flag; when every result in a tool batch has `terminate: true`, the loop ends after that batch.

`AgentEvent`

- Covers: `agent_start`, `agent_end`, `turn_start`, `turn_end`,
  `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.

## Features

- **Event-driven runtime** — emits structured events for progress UIs and tracing.
- **Streaming assistant updates** — forwards incremental text/thinking/tool-call stream updates.
- **Tool argument safety** — optional argument preparation plus schema validation before execute.
- **Batch execution policy** — parallel by default; if any tool call in a batch is `sequential`, the full batch runs sequentially.
- **Robust failure handling** — tool errors become `toolResult` messages flagged with `isError` instead of crashing the loop.
- **Cooperative cancellation** — `AbortSignal` is propagated to model calls and tool execution.

## Execution notes

- Tool result messages are appended in assistant tool-call order.
- `tool_execution_end` events are emitted as each tool completes.
- The loop exits when:
  - assistant returns no tool calls,
  - assistant stop reason is `error` or `aborted`, or
  - all tool results in a batch set `terminate: true`.

## License

MIT.

## Provenance

This component was assembled with heavy AI-tooling assistance.
Humans were mostly drafted in as test pilots, bug hunters, and occasional emergency brakes.
