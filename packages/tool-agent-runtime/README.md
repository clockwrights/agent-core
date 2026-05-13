# @maya-ai/tool-agent-runtime

Lightweight, domain-neutral runtime for tool-calling LLM agents.

Built on top of [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) for model streaming. This package adds:

- a multi-turn agent loop (`runToolAgent`) that drives a conversation until the model stops calling tools,
- a richer `AgentTool` contract (label, optional argument shim, streaming `onUpdate` callback, per-tool execution mode),
- a structured `AgentEvent` stream you can pipe straight into a UI or trace,
- cooperative cancellation via `AbortSignal` through both model streaming and tool execution.

It is the foundation that the rest of the `@maya-ai/*` packages build on, but it has no opinion about your domain — you supply the model, the prompt, and the tools.

## Install

```bash
npm install @maya-ai/tool-agent-runtime
```

Peer/dependency: `@mariozechner/pi-ai` is a runtime dependency and supplies the underlying `Model`, `Tool`, and streaming primitives.

## Quick start

```ts
import { runToolAgent, type AgentTool } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
// Pick a Model<...> from @mariozechner/pi-ai (any provider it supports).
import { someModel } from "./model.js";

const echo: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo a message back to the user.",
  parameters: Type.Object({ message: Type.String() }),
  execute: async (_id, { message }) => ({
    content: [{ type: "text", text: message }],
    details: { message },
  }),
};

await runToolAgent(
  {
    systemPrompt: "You are a helpful assistant.",
    model: someModel,
    prompt: "Say hi via the echo tool.",
    tools: [echo],
  },
  (event) => {
    if (event.type === "tool_execution_end") {
      console.log("[tool]", event.toolName, event.isError ? "ERROR" : "OK");
    }
  },
);
```

## Public API

```ts
import {
  runToolAgent,
  type AgentTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type AgentMessage,
  type AgentEvent,
  type AgentEventSink,
  type ToolAgentRunInput,
} from "@maya-ai/tool-agent-runtime";
```

### `runToolAgent(input, emit)`

Run a multi-turn tool loop starting from a single user prompt.

`ToolAgentRunInput` fields:

| Field | Type | Notes |
|---|---|---|
| `systemPrompt` | `string` | Required. |
| `model` | pi-ai `Model<any>` | Required. |
| `prompt` | `string` | Initial user turn. |
| `tools` | `AgentTool<any>[]` | Tools the model can call. |
| `images` | `ImageContent[]?` | Optional multimodal attachments appended to the first user message. |
| `reasoning` | `ThinkingLevel?` | Forwarded to pi-ai's `streamSimple`. Omit to disable extended thinking. |
| `signal` | `AbortSignal?` | Forwarded to streaming and to every tool's `execute`. |
| `apiKey`, `sessionId`, `transport`, `maxTokens`, `maxRetryDelayMs` | | Passed through to `streamSimple`. |

Returns `Promise<void>`. All output is delivered through the `emit` callback (`AgentEventSink`).

### `AgentTool`

Extends pi-ai's `Tool<TParameters>` shape with runtime metadata:

```ts
interface AgentTool<TParameters, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}
```

- `label` — human-readable label for UI / progress messages.
- `prepareArguments` — optional shim applied **before** schema validation. Useful for adapting legacy or LLM-produced argument shapes.
- `execute` — throws on failure rather than encoding errors in `content`; the loop converts thrown errors into `isError: true` tool-result messages.
- `executionMode` — `"sequential"` forces the entire batch to run one tool at a time; `"parallel"` (default) lets the batch run concurrently via `Promise.all`.

### `AgentToolResult`

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

When every result in a tool batch has `terminate: true`, the agent stops after that batch without making another LLM call.

### `AgentEvent`

Stream of lifecycle, message, and tool events:

| Event | When |
|---|---|
| `agent_start` / `agent_end` | Run begins / completes. `agent_end` includes the full message list. |
| `turn_start` / `turn_end` | Each assistant turn (model call + any tool batch). |
| `message_start` / `message_update` / `message_end` | Streaming text/thinking/tool-call deltas for each assistant or tool-result message. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Per tool call. `_update` is emitted when a tool calls its `onUpdate` callback. `_end` carries `isError`. |

## Loop semantics

- The loop alternates between an LLM call and a batch of tool executions.
- It exits when:
  - the assistant returns no tool calls,
  - the assistant's `stopReason` is `"error"` or `"aborted"`, or
  - every tool result in the latest batch has `terminate: true`.
- Within a batch:
  - if any tool has `executionMode: "sequential"`, the whole batch runs sequentially;
  - otherwise tools run in parallel and `tool_execution_end` fires as each one completes;
  - tool-result messages are appended to the conversation in the order the assistant called them, regardless of completion order.
- Tool errors (validation failure, thrown exceptions, missing tool) are turned into tool-result messages flagged with `isError: true` instead of crashing the loop.

## Cancellation

`input.signal` is forwarded into every `streamSimple` call and into every `tool.execute`. On abort, the in-flight LLM call or tool returns as soon as it cooperatively notices the signal, and the loop emits `agent_end` with the messages accumulated so far.

## License

MIT.

## Provenance

Built with heavy AI-tooling assistance. Humans showed up as test pilots, bug hunters, and the occasional emergency brake.
