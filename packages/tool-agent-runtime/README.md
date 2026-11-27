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
  runAgent,
  serializeRunState,
  hashArguments,
  parseRunState,
  RunStateError,
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
  type RunState,
  type RunResult,
  type ToolCallDecision,
  type ToolApproval,
  type ToolInterruption,
  type BeforeToolCallContext,
  type AfterToolCallContext,
  // compaction
  compactMessages,
  estimateContextTokens,
  buildCompactionTranscript,
  DEFAULT_COMPACTION_INSTRUCTIONS,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_MAX_SUMMARY_TOKENS,
  type CompactionOptions,
  type CompactionRecord,
} from "@maya-ai/tool-agent-runtime";
```

### `runToolAgent(input, emit)`

Run a multi-turn tool loop from a prompt, a prior conversation (`messages`) or a saved state (`resumeFrom`). `runAgent(input, emit?)` runs the same loop and resolves with the result — see [Conversations, saved state and resume](#conversations-saved-state-and-resume).

`ToolAgentRunInput` fields:

| Field | Type | Notes |
|---|---|---|
| `systemPrompt` | `string` | Required. |
| `model` | pi-ai `Model<any>` | Required. |
| `prompt` | `string?` | New user turn. Required unless `messages` or `resumeFrom` is given; with them it is appended after the prior conversation. |
| `messages` | `AgentMessage[]?` | Prior conversation to continue from (counters start at zero). Not combinable with `resumeFrom`. |
| `resumeFrom` | `RunState?` | Saved state to continue from; counters and usage carry over. |
| `onCheckpoint` | `(state: RunState) => void \| Promise<void>`? | Awaited after every step that continues the run and once at the end. A throw ends the run with reason `error`. |
| `tools` | `AgentTool<any>[]` | Tools the model can call. |
| `images` | `ImageContent[]?` | Optional multimodal attachments for the `prompt` turn (requires `prompt`). |
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
| `beforeToolCall` | `(ctx) => ToolCallDecision \| undefined`? | Decides each tool call before it runs: allow, deny or ask. See [Tool approval hooks](#tool-approval-hooks). |
| `afterToolCall` | `(ctx) => ToolResultOverride \| undefined`? | Sees each executed call's result and may replace it before the model sees it. |
| `approvals` | `Record<string, ToolApproval>?` | Decisions for the interrupted calls of `resumeFrom`, keyed by tool-call id. |
| `compaction` | `CompactionOptions?` | Replace older turns with a summary when the prompt grows too large. See [Compaction](#compaction). |

Limits are validated up front: a non-positive or non-integer value rejects with a `RangeError` before any event is emitted.

`runToolAgent` returns `Promise<void>`; all output is delivered through the `emit` callback (`AgentEventSink`), and `agent_end.state` carries the run's state. `runAgent` returns `Promise<RunResult>`: `{ state, reason, usage, messages, text, errorMessage? }`, where `text` is the last assistant message's text.

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
    context?: ToolExecutionContext,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
  timeoutMs?: number;
}
```

- `label` — human-readable label for UI / progress messages.
- `prepareArguments` — optional shim applied **before** schema validation. Useful for adapting legacy or LLM-produced argument shapes.
- `execute` — throws on failure rather than encoding errors in `content`; the loop converts thrown errors into `isError: true` tool-result messages.
- `context` (fifth argument, set by the runtime; tools may ignore it) — `{ toolCallId, turn, sessionId?, request? }`. `request` is the model call that produced the tool call, exactly as it was sent: `{ model, reasoning?, systemPrompt, tools, messages }`, after any `prepareStep` override. `messages` ends with the message before the assistant reply that holds the call. It is a frozen snapshot shared by every tool of the batch. `request` is absent for pending calls run from a saved state before this invocation's first model call. A tool can use it to see the conversation, or to start a related model call that reuses the provider's prompt cache (same tools, system prompt, session id and message prefix). Callers outside the runtime may omit `context`; wrappers should pass it on.
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
| `agent_start` / `agent_end` | Run begins / completes. `agent_start.eventVersion` is the contract version; `agent_start.resumed` is true when the run started from `messages` or `resumeFrom`. `agent_end` includes the full message list, `reason` (`AgentEndReason`), summed `usage`, `errorMessage` when the reason is `error` or `aborted`, and the serializable `state`. |
| `turn_start` / `turn_end` | Each assistant turn (model call + any tool batch). `turn_end.usage` is that model call's usage. |
| `message_start` / `message_update` / `message_end` | Streaming text/thinking/tool-call deltas for each assistant or tool-result message. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Per tool call. `_start` fires when the tool actually starts. `_update` is emitted when a tool calls its `onUpdate` callback. `_end` carries `isError`. |
| `tool_approval_requested` | `beforeToolCall` asked for approval: `{ toolCallId, toolName, args, reason?, data? }`. One per asked call; the run then ends with reason `interrupted`. |
| `compact_boundary` | The transcript was compacted before a model call: `{ trigger, turn, tokensBefore, tokensAfter, removedMessages, summaryIndex, keptMessages, summary, usage }`. |
| `compaction_failed` | The summariser failed: `{ trigger, turn, error }`. The run continues uncompacted. |

`AgentEndReason`: `completed` (answered without tools) · `terminated` (every result had `terminate: true`) · `max_turns` · `max_tool_calls` · `budget` · `stop_condition` · `aborted` · `error` (also when a `prepareStep` / `stopWhen` / `beforeToolCall` / `afterToolCall` / `onCheckpoint` hook throws) · `interrupted` (a tool call waits for approval). New reasons may be added; treat unknown values as "ended".

`AgentUsage` is pi-ai's `Usage`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost` (USD, computed by pi-ai from the model's pricing). Providers that report no usage count as zero.

### Contract versioning

`AgentEvent`, `AgentTool` and the tool-result shapes are a versioned contract. `AGENT_EVENT_VERSION` (currently `1`) is emitted on every `agent_start` as `eventVersion`. Additive changes — new optional fields, new event types — keep the version; consumers should ignore fields and event types they don't know. Removing or renaming a field, or changing its meaning, bumps the version. Fields documented as always set by `runToolAgent` (`eventVersion`, `resumed`, `reason`, `usage`, `state`) are optional in the TypeScript types only so that hand-built events stay valid.

## Loop semantics

- The loop alternates between an LLM call and a batch of tool executions.
- It exits when (reported as `agent_end.reason`):
  - the assistant returns no tool calls (`completed`),
  - the assistant's `stopReason` is `"error"` or `"aborted"` (`error` / `aborted`),
  - every tool result in the latest batch has `terminate: true` (`terminated`), or
  - `beforeToolCall` asked for approval (`interrupted`), or
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
- `composePrepareSteps(a, b, …)` combines hooks: they run in order and each sees the previous hook's `messages`; for `model`, `systemPrompt` and `reasoning` the last hook that sets one wins, and `activeTools` lists are intersected.
- `selectActiveTools(tools, activeTools)` is the filter the loop uses for `activeTools` (all tools when `activeTools` is undefined); it is exported for hooks and adapters that need the same rule.
- A hook that throws ends the run with reason `error` and `errorMessage` `"prepareStep failed: …"` / `"stopWhen failed: …"`. When `prepareStep` fails no model call happened, so `agent_end` follows the open `turn_start` directly.

## Tool approval hooks

```ts
const policy = ({ tool, toolCall }: BeforeToolCallContext): ToolCallDecision | undefined => {
  if (tool.name === "delete_account") return { action: "deny", message: "Never delete accounts." };
  if (tool.name.startsWith("send_")) return { action: "ask", reason: "sends a message", data: { to: toolCall.arguments.to } };
  return undefined; // allow
};

const first = await runAgent({ systemPrompt, model, tools, prompt, beforeToolCall: policy });
if (first.reason === "interrupted") {
  // show first.state.interruptions to a person, save the state, wait…
  const next = await runAgent({
    systemPrompt, model, tools, beforeToolCall: policy,
    resumeFrom: first.state,
    approvals: { [first.state.interruptions![0]!.toolCallId]: { approve: true } },
  });
}
```

- **`beforeToolCall`** gets `{ toolCall: { id, name, arguments }, tool, turn, messages, signal }` with arguments already validated (after `prepareArguments` and coercion). It runs only for calls that would execute — unknown tools, invalid arguments and calls past `maxToolCalls` keep their error results without it. Return `undefined` or `{ action: "allow" }` to run, `{ action: "deny", message? }` to send the model an error result (default `"Tool call denied"`; the run continues), or `{ action: "ask", reason?, data? }` (`data` must be JSON).
- **A batch runs only when nothing in it is waiting.** All decisions for a batch are made first. If any call asks, no tool in the batch runs: denied calls get their error results, a `tool_approval_requested` event is emitted per asked call, and the run ends with reason `interrupted`. `state.interruptions` lists `{ toolCallId, toolName, arguments, argumentsHash, reason?, data? }`. Allowed calls of that batch are decided again on resume.
- **Resume with `approvals`** keyed by tool-call id: `{ approve: true }` runs the call without asking `beforeToolCall` again; `{ approve: false, message? }` sends the model `"Denied by the approver: …"` and the run continues. A call with no decision yet is asked again. An approval only applies while the call's arguments still match the recorded `argumentsHash` (sha256 of canonical JSON, see `hashArguments`), so editing the saved transcript voids it. An id that is not in `resumeFrom.interruptions` is a `RangeError`. Approvals are not signed; treat saved state as trusted input or sign it yourself.
- **`afterToolCall`** gets `{ toolCall, tool, result, isError, turn }` for every executed call, including thrown errors and timeouts (not for denied, blocked or invalid calls), and may return `{ content?, details?, isError?, terminate? }` to replace those fields — for example to redact secrets or label untrusted content before the model and the saved state see it.
- **Failing hooks fail closed.** A throwing `beforeToolCall` ends the run with reason `error` before any tool of the batch runs (the calls stay pending, so the state can be resumed). A throwing `afterToolCall` replaces that call's result with an error result, the rest of the batch finishes, then the run ends with reason `error`.
- Denied and waiting calls do not count toward `maxToolCalls`; an approved call counts when it runs. Hooks are configuration, not state: pass them again on every resume.

## Conversations, saved state and resume

```ts
import { runAgent, serializeRunState, parseRunState } from "@maya-ai/tool-agent-runtime";

const first = await runAgent({ systemPrompt, model, tools, prompt: "Plan the trip", maxTurns: 20 });
await db.save(runId, serializeRunState(first.state));

// later, possibly in another process, with the same or different model/tools:
const saved = parseRunState(await db.load(runId));
const next = await runAgent({ systemPrompt, model, tools, resumeFrom: saved, prompt: "Now book it", maxTurns: 20 });
```

- **`RunState`** is `{ version: 1, messages, turns, toolCallsExecuted, usage, endReason?, errorMessage?, metadata?, interruptions?, compactions? }` (`RUN_STATE_VERSION` is the current version; `interruptions` is set when the run ended `interrupted`, see [Tool approval hooks](#tool-approval-hooks); `compactions` lists the run's compactions, see [Compaction](#compaction)): progress only. Model, tools, API keys, system prompt, hooks and limits are not in it — pass them on every call. `metadata` is yours; the runtime copies it through.
- **`serializeRunState(state)`** returns JSON text and throws `RunStateError` if anything would be lost in JSON (functions, `Date`/`Map` and other class instances, `NaN`, `undefined` inside arrays, cycles), naming the path and the tool. Tools whose results should survive a resume must return JSON-safe `details`.
- **`parseRunState(jsonOrValue)`** validates and copies; a state from a newer runtime (`version` > 1) is rejected with a clear error.
- **Starting transcript:** `prompt` alone works as before. `messages` continues a conversation with counters at zero; add `prompt` to append a new user turn. `resumeFrom` continues a saved run with counters and usage carried over. `messages` + `resumeFrom` together, or none of `prompt`/`messages`/`resumeFrom`, is a `RangeError`.
- **What happens next** depends on the last message: a user or tool-result message → model call; an assistant message whose tool calls lack results → only the missing calls run (before any new `prompt` is appended), then a model call; a finished assistant answer with no new `prompt` → the run ends at once with `completed`; a trailing failed or aborted assistant reply is dropped so the model retries that turn.
- **Limits are cumulative across resumes:** `maxTurns`, `maxToolCalls` and `budget` count the carried totals, and a run whose limit is already used up ends without a model call. For a fresh allowance, pass `messages: state.messages` instead of `resumeFrom`.
- **Turn numbers continue:** `prepareStep`/`stopWhen` see `turn = state.turns + 1`; `steps` holds only this invocation's steps.
- **Tool calls may run again after a crash.** Calls that already have a result are never re-run, but a tool that finished its work without its result being saved will run again on resume. Make side-effecting tools idempotent, for example by keying on the `toolCallId` they receive (stable across resumes).
- **Checkpoints:** `onCheckpoint` is awaited after each step that continues the run (before the next model call) and once at the end, so a durability layer can persist before the loop moves on.

## Compaction

Long runs grow their transcript every turn. With `compaction`, the runtime estimates the next prompt before every model call and, when it reaches the trigger, replaces older turns with a summary written by a model. The compacted transcript is the run's transcript: later calls, `agent_end.state` and saved state all use it.

```ts
await runAgent({
  systemPrompt, model, tools, prompt,
  compaction: { triggerRatio: 0.85 },   // the default; or triggerTokens: 100_000
});
```

| Option | Default | Meaning |
|---|---|---|
| `triggerRatio` | `0.85` | Compact when the estimate reaches this share of the context window (0 < ratio < 1). |
| `triggerTokens` | — | Absolute trigger in tokens; wins over `triggerRatio`. |
| `contextWindow` | `model.contextWindow` | Window to use (for example when `prepareStep` switches to a smaller model). Without a window, `triggerTokens` is required. |
| `keepRecentTokens` | 20% of the window (25% of `triggerTokens` without one) | Recent turns kept verbatim, as whole turns, newest first. The latest turn is always kept. |
| `keepInitialMessages` | `true` | Keep the messages before the first assistant reply (the task, pinned memory) verbatim. |
| `maxSummaryTokens` | `2048` | Output cap of the summary call. |
| `model` | the run's model | Model that writes the summary. |
| `summarize` | built in | `({ messages, previousSummary?, transcript, signal }) => Promise<{ text, usage? }>` to write the summary yourself. |
| `onOverflow` | `"compact"` | On a context-overflow error, compact and retry the call once; `"fail"` keeps today's behaviour. |

- **Trigger:** the estimate starts from the latest reply's reported usage (`input + cacheRead + cacheWrite + output`) and adds about 4 characters per token (1,600 tokens per image) for messages after it. Without usable usage it estimates the whole context that way, including the system prompt and tool schemas. Replies older than the latest compaction are not used, because they measured the longer prompt. The trigger never leaves less than `maxTokens` for the reply. `estimateContextTokens()` gives the same number.
- **What is kept:** the initial messages, and the most recent whole turns that fit `keepRecentTokens`. A cut only falls before an assistant message, so a tool call is never separated from its result, and pending calls and `interruptions` are never touched. If there is no older turn to summarise, nothing happens.
- **The summary** goes into a `<conversation-summary>` block that says it is background, not a request from the user, so instructions that arrived through tool output do not turn into user instructions. It is added as an extra text part of the last initial user message, which keeps user and assistant messages alternating. With `keepInitialMessages: false` it is a user message of its own at the start. A later compaction folds the earlier summary into the new one, so there is only ever one.
- **The built-in summariser** makes one call to the summary model, without tools, using `DEFAULT_COMPACTION_INSTRUCTIONS`: goal, decisions, work done (files, ids, numbers), open issues, current state and next step, with exact identifiers kept and facts from tool output marked. The summarised turns are sent as plain text (`buildCompactionTranscript`). Very long items are shortened in the middle, and the oldest part is dropped if the transcript would not fit the summary model.
- **Cost and limits:** the summary call's usage is added to the run's `usage`, so `budget` applies, and the budget is checked again right after a compaction. It is not a turn: `turns` and `maxTurns` still count the agent's own model calls.
- **Events and state:** `compact_boundary` comes after `turn_start` and before that turn's model call. To rebuild the transcript from events, apply `messages.splice(summaryIndex, removedMessages, summary)`. `RunState.compactions` keeps one record per compaction, `{ turn, trigger, tokensBefore, tokensAfter, removedMessages, summaryIndex, messageCount }`, and survives `serializeRunState` / resume.
- **Failures fail open:** if the summariser throws or returns no text, `compaction_failed` is emitted and the call goes ahead uncompacted. After 2 failures in a row, compaction is off for the rest of that invocation. An abort during compaction ends the run with reason `aborted` and leaves the transcript unchanged.
- **Overflow recovery:** when a call fails with a context-overflow error (pi-ai's `isContextOverflow`), the failed reply is dropped, the transcript is compacted (`trigger: "overflow"`) and the call is retried once. The failed call's usage counts, but it is not a turn. Its `message_start` / `message_end` events were already emitted; when rebuilding the transcript from events, drop a failed assistant message that is followed by `compact_boundary` with `trigger: "overflow"`. A second overflow ends the run with `error`.
- **At most one compaction per model call.** If the kept part alone is still over the trigger, the call goes ahead anyway.
- **Prompt caching:** a compaction invalidates the provider's cache from the summary onward, once. Because the summary is stored in the transcript, later calls and resumed runs reuse it instead of summarising again.
- **Between runs:** `compactMessages(messages, { model, …options })` compacts a saved conversation with the same rules (for example before resuming, or for a "/compact" command). It returns `{ messages, record, summary, usage }`, or `undefined` when there is nothing to summarise.

## Cancellation

`input.signal` is forwarded into every `streamSimple` call and into every `tool.execute`. On abort, the in-flight LLM call or tool returns as soon as it cooperatively notices the signal, and the loop emits `agent_end` with the messages accumulated so far.

## Testing helpers

Deterministic, network-free test doubles live in a separate entry point:

```ts
import {
  createReplayModel,   // scripted model: answers each call with the next step (records contexts and non-secret call options)
  createModelRecorder, // wraps a real model and records its responses as a cassette
  replyText, replyToolCalls, replyError, // build scripted assistant replies
  recordTool,          // wraps a tool and records params / result / error / context per call
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

## Exported types

Types not shown elsewhere in this README, by area:

- `ToolCallInfo` — `{ id, name, arguments }`, a tool call as the approval hooks see it (arguments already validated).
- `ToolExecutionContext` — the fifth argument of `execute`; `ToolExecutionRequest` — its `request` field (see `AgentTool`).
- `PrepareStepContext` — `{ turn, steps, messages }`, the input of `prepareStep`; `PrepareStepResult` — `{ model?, systemPrompt?, reasoning?, activeTools?, messages? }`, its overrides for one model call.
- `StopConditionState` — `{ steps, totalUsage }`, the input of a stop condition after each tool batch.
- `CompactionTrigger` — `"threshold" | "overflow" | "manual"`; `CompactionRecord` — one entry of `RunState.compactions`.
- `SummarizeInput` / `SummarizeResult` — the input and result of a custom `summarize`; `CompactMessagesOptions` — the options of `compactMessages`; `CompactionResult` — its result; `EstimateContextInput` — `{ messages, systemPrompt?, tools?, usageFrom? }` for `estimateContextTokens`.

## License

MIT.

## Provenance

Built with heavy AI-tooling assistance. Humans showed up as test pilots, bug hunters, and the occasional emergency brake.
