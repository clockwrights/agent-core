# @maya-ai/tool-agent-runtime

Lightweight, domain-neutral runtime for tool-calling LLM agents.

Built on top of [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) for model streaming. This package adds:

- a multi-turn agent loop (`runToolAgent`) that drives a conversation until the model stops calling tools,
- a richer `AgentTool` contract (label, optional argument shim, streaming `onUpdate` callback, per-tool execution mode),
- a structured `AgentEvent` stream you can pipe straight into a UI or trace,
- cooperative cancellation via `AbortSignal` through both model streaming and tool execution.

It is the foundation that the rest of the `@maya-ai/*` packages build on, but it has no opinion about your domain — you supply the model, the prompt, and the tools.

## Install

```bash
npm install @maya-ai/tool-agent-runtime
```

Peer/dependency: `@earendil-works/pi-ai` is a runtime dependency and supplies the underlying `Model`, `Tool`, and streaming primitives.

## Quick start

```ts
import { runToolAgent, type AgentTool } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
// Pick a Model<...> from @earendil-works/pi-ai (any provider it supports).
import { someModel } from "./model.js";

const echoParams = Type.Object({ message: Type.String() });

// Pass the schema type so `execute` gets typed params.
const echo: AgentTool<typeof echoParams> = {
  name: "echo",
  label: "Echo",
  description: "Echo a message back to the user.",
  parameters: echoParams,
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
  ToolTimeoutError,
  AGENT_EVENT_VERSION,
  type AgentTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type AgentMessage,
  type AgentEvent,
  type AgentEventSink,
  type ToolAgentRunInput,
  type ToolAgentBudget,
  type AgentEndReason,
  type AgentUsage,
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
| `apiKey`, `sessionId`, `transport`, `maxTokens`, `maxRetryDelayMs` | | Passed through to `streamSimple`. `maxTokens` caps output tokens per model call. |
| `maxTurns` | `number?` | Maximum model calls. The batch of the last allowed turn still runs, then the run ends with reason `max_turns`. Default: no limit. |
| `maxToolCalls` | `number?` | Maximum tool executions over the run. Calls past the limit are not executed and get an error result; the run then ends with reason `max_tool_calls`. Default: no limit. |
| `budget` | `{ maxTotalTokens?, maxCostUsd? }?` | Checked after each model call against summed usage; when reached, that turn's batch still runs, then the run ends with reason `budget` (can overshoot by one model call). Default: none. |
| `toolTimeoutMs` | `number?` | Default timeout per tool call; a tool's own `timeoutMs` wins. Default: none. |
| `maxParallelTools` | `number?` | Maximum tools in flight in a parallel batch. Default: no limit. |
| `toolBatchStrategy` | `"serialize-batch" \| "sequential-barriers"`? | How a batch with a `sequential` tool runs. `serialize-batch` (default): the whole batch one at a time. `sequential-barriers`: each sequential tool runs alone at its position; the parallel tools between them run concurrently. |
| `stopWhen` | `StopCondition \| StopCondition[]`? | Custom stop conditions, checked after each turn's tool batch; any `true` ends the run with reason `stop_condition`. Helpers: `stepCountIs(n)`, `hasToolCall(...names)`. |
| `prepareStep` | `PrepareStep?` | Called before each model call with `{ turn, steps, messages }`; may return per-step overrides `{ model, systemPrompt, reasoning, activeTools, messages }`. |

Limits are validated up front: a non-positive or non-integer value rejects with a `RangeError` before any event is emitted.

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
  timeoutMs?: number;
}
```

- `label` — human-readable label for UI / progress messages.
- `prepareArguments` — optional shim applied **before** schema validation. Useful for adapting legacy or LLM-produced argument shapes.
- `execute` — throws on failure rather than encoding errors in `content`; the loop converts thrown errors into `isError: true` tool-result messages.
- `executionMode` — `"sequential"` forces the entire batch to run one tool at a time (or, with `toolBatchStrategy: "sequential-barriers"`, makes the tool run alone at its position in the batch); `"parallel"` (default) lets the batch run concurrently (bounded by `maxParallelTools` when set).
- `timeoutMs` — per-tool timeout, overriding the run's `toolTimeoutMs`. On timeout the `signal` passed to `execute` is aborted with a `ToolTimeoutError` as its `reason`, the call stops being awaited, and the model gets an error result with `details: { error: "ToolTimeoutError", timeoutMs }`. Updates the tool sends after that are dropped. Without a timeout, `execute` receives the caller's `signal` unchanged.

Timeouts compose by nesting: a tool's own internal timeout (for example the MCP adapter's call timeout) still applies inside it, so the effective limit is the smaller of the two; an orchestration child timeout bounds the whole child run.

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
| `agent_start` / `agent_end` | Run begins / completes. `agent_start.eventVersion` is the contract version. `agent_end` includes the full message list, `reason` (`AgentEndReason`), summed `usage`, and `errorMessage` when the reason is `error` or `aborted`. |
| `turn_start` / `turn_end` | Each assistant turn (model call + any tool batch). `turn_end.usage` is that model call's usage. |
| `message_start` / `message_update` / `message_end` | Streaming text/thinking/tool-call deltas for each assistant or tool-result message. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Per tool call. `_start` fires when the tool actually starts. `_update` is emitted when a tool calls its `onUpdate` callback. `_end` carries `isError`. |

`AgentEndReason`: `completed` (answered without tools) · `terminated` (every result had `terminate: true`) · `max_turns` · `max_tool_calls` · `budget` · `stop_condition` · `aborted` · `error` (also when a `prepareStep` / `stopWhen` hook throws). New reasons may be added; treat unknown values as "ended".

`AgentUsage` is pi-ai's `Usage`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost` (USD, computed by pi-ai from the model's pricing). Providers that report no usage count as zero.

### Contract versioning

`AgentEvent`, `AgentTool` and the tool-result shapes are a versioned contract. `AGENT_EVENT_VERSION` (currently `1`) is emitted on every `agent_start` as `eventVersion`. Additive changes — new optional fields, new event types — keep the version; consumers should ignore fields and event types they don't know. Removing or renaming a field, or changing its meaning, bumps the version. Fields documented as always set by `runToolAgent` (`eventVersion`, `reason`, `usage`) are optional in the TypeScript types only so that hand-built events stay valid.

## Loop semantics

- The loop alternates between an LLM call and a batch of tool executions.
- It exits when (reported as `agent_end.reason`):
  - the assistant returns no tool calls (`completed`),
  - the assistant's `stopReason` is `"error"` or `"aborted"` (`error` / `aborted`),
  - every tool result in the latest batch has `terminate: true` (`terminated`), or
  - a configured limit is reached (`max_tool_calls`, `max_turns`, `budget`). Limits are checked after a turn's tool batch, so every tool call in the transcript has a result.
- Within a batch:
  - if any tool has `executionMode: "sequential"`, the whole batch runs sequentially — or, with `toolBatchStrategy: "sequential-barriers"`, each sequential tool runs alone and the parallel tools between them run together;
  - otherwise tools run in parallel (at most `maxParallelTools` at a time) and `tool_execution_end` fires as each one completes;
  - tool-result messages are appended to the conversation in the order the assistant called them, regardless of completion order.
- Tool errors (validation failure, thrown exceptions, missing tool) are turned into tool-result messages flagged with `isError: true` instead of crashing the loop.
- Arguments are validated with pi-ai's `validateToolArguments`, which coerces primitives to the schema type first (e.g. `42` → `"42"` for a string field). Only arguments that cannot be coerced are rejected.

## Per-step control

```ts
import { runToolAgent, hasToolCall, stepCountIs } from "@maya-ai/tool-agent-runtime";

await runToolAgent({
  …,
  stopWhen: [hasToolCall("submit_answer"), stepCountIs(10)],
  prepareStep: ({ turn, steps, messages }) =>
    turn === 1 ? { activeTools: ["search"] } : { model: cheaperModel },
}, emit);
```

- **`stopWhen`** conditions receive `{ steps, totalUsage }`, where each `AgentStep` is `{ turn, message, toolResults, usage }`. They run after a turn's tool batch, only when the run would otherwise continue: `terminated` and `max_tool_calls` take precedence; `max_turns` and `budget` are checked after them. Conditions may be async.
- **`prepareStep`** runs before every model call, including the first. Overrides apply to that step only and are not persisted: `messages` replaces what the model sees (for pruning or clearing old tool results) without changing the run's transcript; `activeTools` narrows both the tools offered and the tools that can execute in that step (a call outside the set gets a "not found" error result; unknown names are ignored). Tool choice is not exposed: pi-ai's generic stream options have no provider-neutral tool-choice field.
- A hook that throws ends the run with reason `error` and `errorMessage` `"prepareStep failed: …"` / `"stopWhen failed: …"`. When `prepareStep` fails no model call happened, so `agent_end` follows the open `turn_start` directly.

## Cancellation

`input.signal` is forwarded into every `streamSimple` call and into every `tool.execute`. On abort, the in-flight LLM call or tool returns as soon as it cooperatively notices the signal, and the loop emits `agent_end` with the messages accumulated so far.

## Testing helpers

Deterministic, network-free test doubles live in a separate entry point:

```ts
import {
  createReplayModel,   // scripted model: answers each call with the next step (records contexts and non-secret call options)
  createModelRecorder, // wraps a real model and records its responses as a cassette
  replyText, replyToolCalls, replyError, // build scripted assistant replies
  recordTool,          // wraps a tool and records params / result / error per call
  collectEvents,       // event sink that keeps every AgentEvent
} from "@maya-ai/tool-agent-runtime/testing";
```

Scripted run:

```ts
const replay = createReplayModel([
  replyToolCalls([{ name: "echo", arguments: { message: "hi" } }]),
  replyText("done", { usage: { input: 20, output: 2 } }),
]);
const echoSpy = recordTool(echo);
const events = collectEvents();

await runToolAgent({ systemPrompt: "…", model: replay.model, tools: [echoSpy.tool], prompt: "go" }, events.emit);

echoSpy.calls[0].params;          // { message: "hi" }
replay.calls[1].messages;         // what the model saw on its second call
events.ofType("tool_execution_end");
replay.dispose();
```

- Steps can be assistant messages, recorded cassette steps, or functions `(context, callIndex) => message` for replies that depend on the conversation.
- Streaming is deterministic: one delta per content block. Recorded `usage` is preserved.
- When the script runs out, the call ends with `stopReason: "error"` and an explanatory `errorMessage` instead of hanging. An aborted signal produces `stopReason: "aborted"`.

Record once, replay in tests:

```ts
const recorder = createModelRecorder(realModel);
await runToolAgent({ …, model: recorder.model }, emit);
writeFileSync("fixtures/run.cassette.json", JSON.stringify(recorder.cassette(), null, 2));
recorder.dispose();

// later, offline:
const replay = createReplayModel(JSON.parse(readFileSync("fixtures/run.cassette.json", "utf8")));
```

A cassette stores model responses plus a small fingerprint of each request (message count, last message role, tool names) — never prompts, tool results or API keys. On replay, a fingerprint mismatch fails that call with a `request mismatch` error, so a test notices when the code under test starts sending a different conversation; pass `{ checkRequests: false }` to disable this. Model output can still echo user data: review cassettes before committing them.

## License

MIT.

## Provenance

Built with heavy AI-tooling assistance. Humans showed up as test pilots, bug hunters, and the occasional emergency brake.
