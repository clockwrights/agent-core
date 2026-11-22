# @maya-ai/agent-loop-orchestration

Multi-agent orchestration for tool-using LLM agents. A parent run delegates bounded subtasks to child runs through a domain-neutral `delegate_task` (or batched `delegate_tasks`) tool; child results are joined and synthesised into a single final answer.

Phase 1 is blocking-inline, depth = 1; sequential single-delegations through `delegate_task`, parallel fan-out through `delegate_tasks`. The contract surface is shaped so async completion and nested delegation can land later without breaking changes.

Built on top of [`@maya-ai/agent-loop-core`](https://www.npmjs.com/package/@maya-ai/agent-loop-core) and [`@maya-ai/tool-agent-runtime`](https://www.npmjs.com/package/@maya-ai/tool-agent-runtime).

## Install

```bash
npm install @maya-ai/agent-loop-orchestration @maya-ai/agent-loop-core @maya-ai/tool-agent-runtime
```

---

## Why this component exists

A single tool-using loop scales fine until two pressures collide:
1. The parent's prompt + context + tool surface gets large enough that quality and cost suffer.
2. Some subtasks (research, validation, candidate edits) are naturally separable and would be cheaper, more focused, and easier to reason about as their own bounded runs.

Putting those subtasks into the same loop bloats the parent. Putting them into ad-hoc helper functions hides the lifecycle (no tracked status, no failure envelopes, no synthesis). This component is the structured middle ground: a parent run can spawn one or more child runs, each with its own prompt and a narrower tool surface, and the results are joined deterministically before the parent produces its final answer.

What's reusable lives here. What's app-specific (which domain tools children are allowed to call, when to enable orchestration, how to render a final answer) stays in the consumer adapter.

---

## What lives in orchestration

The component owns:

- **Contracts.** `ChildRunRequest`, `ChildRunResultEnvelope`, `ChildRunFailure`, `ChildRunHandle`, `OrchestratorState`, `OrchestratorPhase`, plus the `ParentContextSlice` shape used by fork-mode prompts.
- **Registry.** Lifecycle tracking with explicit transition rules. In-memory store ships; the contract is shaped so a persistent store can replace it later without changing callers.
- **Policy.** `OrchestrationPolicy` (depth limits, active-children limits, timeouts, default context mode, default token budget, synthesis mode). The domain-neutral preset → tool-policy resolver and a `PresetOverrides` extension point consumers use to map presets onto their own tool names.
- **Child run executor.** `executeChildRun(input)` — the only place that turns a `ChildRunRequest` into a real `runToolAgentLoop` call. Wraps the call in a per-child timeout, builds a child-scoped runtime context, normalises every outcome into a `ChildRunResultEnvelope`, disposes the runtime in `finally`.
- **Internal delegation tool.** `delegate_task` — the LLM-visible tool the parent's loop calls to spawn a delegated run. Validates inputs, applies depth-gating, blocks until the child completes, returns a structured JSON payload to the LLM.
- **Orchestrator loop.** `runOrchestrator(input)` — the parent-side state machine that wraps `runToolAgentLoop`, collects whatever child runs `delegate_task` created, and runs synthesis as a separate no-tools `runToolAgentLoop` call.
- **Prompt builders.** `buildChildSystemPrompt`, `buildSynthesisSystemPrompt`, `buildSynthesisPrompt`, `buildForkedContextBlock`. All domain-neutral; consumers supply domain content through the request fields.

The component does **not** own:

- Domain tool names. Orchestration's preset resolver ships an empty allow-list; the consumer supplies domain tool names through `PresetOverrides`.
- The decision to enable orchestration. Feature gating belongs in the consumer's adapter or app-bridge layer.
- The parent's prompt content. Parents send whatever prompts and tools they like; orchestration appends `delegate_task` only when the consumer chooses to register it.
- Persistence. The in-memory registry is the only store in Phase 1.
- Cancellation. Full `AbortSignal` propagation is supported via the in-house `tool-agent-runtime` component (see the cancellation note below).

---

## Reusability boundary

Same rule as `@maya-ai/agent-loop-core`, `@maya-ai/document-pipeline`, `@maya-ai/document-policies`, `@maya-ai/llm-profiles`:

```
@maya-ai/agent-loop-core           → (npm, node)
@maya-ai/agent-loop-orchestration  → agent-loop-core, (npm, node)
consumer app                       → agent-loop-core, agent-loop-orchestration, ...
```

A grep against this package for imports from any consumer-app module must return zero matches. Adding such an import would couple orchestration to one consumer; the right fix is to surface the missing capability through `orchestrationTypes.ts` or an injection point on `ExecuteChildRunInput` / `DelegateToolContext` / `RunOrchestratorInput`.

No exported identifier or rendered prompt mentions consumer-domain terms. This is asserted by tests in `test/foundations.test.ts`.

---

## Phase 1 contract

All Phase 1 child runs are:

- **Blocking-inline.** `delegate_task` returns only when the child's result envelope is available. The parent's tool loop processes child calls one at a time.
- **Sequential by default; parallel via `delegate_tasks`.** Single delegations through `delegate_task` are sequential because the parent's tool loop serialises tool calls. Batched delegations through `delegate_tasks` run children in parallel inside one tool call, bounded by `policy.maxConcurrentChildren`. Result projection preserves input order regardless of completion order.
- **Depth = 1.** Children cannot spawn grandchildren. Enforced two ways: child runtimes do not get `delegate_task` / `delegate_tasks` registered (primary), and each tool's `execute` rejects when `parentDepth >= policy.maxDepth` (defense-in-depth).
- **Proposal-only.** Child runs do not directly mutate authoritative state. The `ChildRunResultEnvelope.proposedChanges` field is reserved for a future candidate-edit child variant; in Phase 1 it is always `undefined`.
- **Isolated by default.** `defaultContextMode = "isolated"`. A child receives a fresh brief; opt in to `"fork"` mode and supply `parentContext: ParentContextSlice[]` on the request when the child needs selected parent context.

---

## Public API

```ts
import {
  // Contracts
  type ChildContextMode,
  type ChildExecutionMode,
  type ChildExecutionProfile,
  type ChildRunFailure,
  type ChildRunFailureCode,
  type ChildRunHandle,
  type ChildRunProposedChangeSet,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type ChildRunStatus,
  type ChildRunToolCallSummary,
  type OrchestratorDecision,
  type OrchestratorSynthesisInput,
  type ParentContextSlice,

  // Registry
  ChildRunCancelledError,
  ChildRunTimeoutError,
  ChildRunValidationError,
  RegistryTransitionError,
  RegistryUnknownRunError,
  createInMemoryChildRunRegistry,
  withChildTimeout,
  type ChildRunRegistry,
  type ChildRunRegistryOptions,
  type RegistrySnapshot,
  type RegistrySnapshotEntry,

  // Policy
  DEFAULT_ORCHESTRATION_POLICY,
  TOOL_POLICY_PRESETS,
  checkActiveCount,
  checkDepth,
  resolveToolPolicyForPreset,
  type LimitCheckResult,
  type OrchestrationPolicy,
  type PresetOverrides,
  type SynthesisMode,
  type ToolPolicyPreset,

  // Executor
  executeChildRun,
  type ExecuteChildRunInput,

  // Result projection
  statusForFailureCode,
  toChildRunFailure,
  toChildRunResultEnvelope,
  toFailureEnvelope,

  // Prompt builders
  buildChildSystemPrompt,
  buildSynthesisPrompt,
  buildSynthesisSystemPrompt,
  type BuildChildSystemPromptInput,
  type BuildSynthesisPromptInput,

  // Context fork
  DEFAULT_MAX_FORK_CONTEXT_CHARS,
  DEFAULT_MAX_SLICE_CHARS,
  buildForkedContextBlock,
  type ForkContextOptions,

  // Runtime
  DEFAULT_CHILD_PRESET,
  buildChildTools,
  createChildRuntimeContext,
  type ChildRuntimeOptions,

  // Progress
  createChildProgressReporter,
  type ChildProgressInput,
  type ChildProgressReporter,
  type ProgressSink,

  // Delegation tool
  DELEGATE_TASK_TOOL_NAME,
  createDelegateTaskTool,
  createDelegateTaskToolDefinition,
  delegateTaskParameters,
  executeDelegateTask,
  type DelegateTaskInput,
  type DelegateTaskToolResult,
  type DelegateTaskToolResultPayload,
  type DelegateToolContext,

  // Orchestrator loop
  OrchestratorPhaseTransitionError,
  computeChildLifecycleCounts,
  mergeWithDelegateTool,
  runOrchestrator,
  runSynthesis,
  type ChildLifecycleCounts,
  type OrchestratorPhase,
  type OrchestratorState,
  type RunOrchestratorInput,
  type RunOrchestratorOutput,
  type RunSynthesisInput
} from "@maya-ai/agent-loop-orchestration";
```

---

## Core types

### `ChildRunRequest`

```ts
interface ChildRunRequest {
  runId: string;
  parentRunId: string;
  parentDepth: number;
  label: string;
  description: string;
  prompt: string;
  contextMode: "isolated" | "fork";
  executionMode: "blocking_inline";
  profile?: ChildExecutionProfile;
  maxTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;                      // model-call cap; falls back to policy.defaultChildMaxTurns
  model?: string;                         // model selector for this child (see resolution order below)
  thinkingLevel?: ChildThinkingLevel;     // reasoning effort for this child
  allowWriteTools?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  parentContext?: ParentContextSlice[];   // only used when contextMode === "fork"
}
```

### `ChildRunResultEnvelope`

The single shape every child outcome produces — success and failure both. Synthesis reads this; consumers projecting child results into a UI read this; tests assert on this.

```ts
interface ChildRunResultEnvelope {
  runId: string;
  parentRunId: string;
  label: string;
  status: "completed" | "partial" | "failed" | "timed_out" | "cancelled";
  summary: string;
  text?: string;
  evidence?: string[];
  toolCalls: { name: string; isError: boolean }[];
  proposedChanges?: ChildRunProposedChangeSet;   // RESERVED — undefined in Phase 1
  changedFiles?: string[];
  warnings?: string[];
  failure?: ChildRunFailure;
  idempotencyKey?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  usage?: AgentUsage;          // tokens + USD cost of the child run (when the adapter reports it)
  endReason?: AgentEndReason;  // why the child's run ended (when the adapter reports it)
  turns?: number;              // model calls made (when the adapter reports it)
  model?: string;              // model selector the child ran with, after resolution
  thinkingLevel?: ChildThinkingLevel;
}
```

Status from the adapter's `endReason` (adapters that report one, such as `createRuntimeToolLlmAdapter` from agent-loop-core):

| `endReason` | `status` | Notes |
|---|---|---|
| `completed`, `terminated`, `stop_condition` | `completed` | |
| `max_turns`, `max_tool_calls`, `budget` | `partial` | Text, tool calls and usage are kept; `warnings` names the limit. The child stopped early, so treat the result as possibly incomplete. |
| `error` | `failed` | `failure: { code: "llm_error", retryable: true }`; text and tool calls are kept. |
| `aborted` | `cancelled` | |
| none (older adapters) | `completed` | Same as before. |

### `OrchestrationPolicy`

```ts
interface OrchestrationPolicy {
  maxDepth: number;                                    // Phase 1: 1
  maxActiveChildrenPerParent: number;                  // Phase 1: 3
  defaultChildTimeoutMs: number;                       // Phase 1: 120_000
  defaultContextMode: "isolated" | "fork";             // Phase 1: "isolated"
  defaultAllowWriteTools: boolean;                     // Phase 1: false
  defaultStateMutationMode: "proposal_only" | "direct_apply";  // Phase 1: "proposal_only"
  synthesisMode: "separate_call" | "inline_tool_result";       // Phase 1: "separate_call" only
  maxChildPromptChars: number;                         // Phase 1: 16_000
  maxChildTokens: number;                              // Phase 1: 4_000
  defaultChildMaxTurns?: number;                       // optional; unset = no child turn cap
  defaultChildModel?: string;                          // optional; unset = adapter default (parent model)
  defaultChildThinkingLevel?: ChildThinkingLevel;      // optional
}
```

**Per-child model and reasoning.** Each is resolved independently, first match wins: `request.model` / `request.thinkingLevel` → `request.profile.model` / `profile.thinkingLevel` → `policy.defaultChildModel` / `defaultChildThinkingLevel` → unset, so the adapter uses its own default (the parent's model). `resolveChildModel(request, policy)` exposes the same logic. The resolved values are sent to the adapter as `model` / `reasoning` and recorded on the envelope. `model` is a selector the adapter interprets — typically an llm-profiles profile name or component id; the reference adapter honours it when its `model` option is a function (see agent-loop-core). The `delegate_task` / `delegate_tasks` tools do not let the model choose: LLM-delegated children get the policy defaults.

`DEFAULT_ORCHESTRATION_POLICY` exposes the Phase 1 defaults; consumers override individual fields when needed.

> **Removed:** `defaultChildTokenBudget` was never read by the executor and has been removed. To bound a child, use `maxTokens` (output tokens per model call, capped by `maxChildTokens`), `maxTurns` / `defaultChildMaxTurns`, and `timeoutMs`; real usage is reported on the envelope. Policy objects that still set it no longer type-check — delete the field.

---

## Lifecycle

### Phase machine

```
prepare → plan
plan    → finalize         (no-delegation short-circuit)
plan    → delegate         (one or more child requests)
delegate → wait
wait     → synthesize
synthesize → finalize
finalize is terminal
```

Invalid transitions throw `OrchestratorPhaseTransitionError`. The `OrchestratorState.phaseHistory` array preserves the full path through phases — useful for debugging and assertion.

### Child registry transitions

```
pending → running → completed
                  → partial
                  → failed
                  → timed_out
                  → cancelled
```

The registry rejects:
- Skipping `running` (e.g. `pending → completed`).
- Double-completion (any terminal → terminal).
- Operations on unknown `runId` values.

`markTerminal(envelope)` is the canonical way to record a terminal state — it routes by `envelope.status` and stores the full envelope so `getResult` works for every terminal status, not just `completed`. The executor uses it on every code path. Older `markFailed` / `markTimedOut` / `markCancelled` methods remain for callers that report state without an envelope (e.g. a future Stage 9 parallel runner).

---

## The `delegate_tasks` tool (parallel)

Sibling to `delegate_task` (singular). Same domain-neutral name shape, registered the same way (`source: "system"`, `risk: "read"`). Use it when several research / validation subtasks are independent and can run concurrently; for a single delegation, prefer `delegate_task` — fewer moving parts and identical semantics.

### Schema

```ts
{
  tasks: Array<{
    label: string;        // ≤ 100 chars
    description: string;
    prompt: string;       // ≤ policy.maxChildPromptChars
    contextMode?: "isolated" | "fork";
    maxTokens?: number;
    timeoutMs?: number;
  }>;
}
```

### Bounds

- `tasks` array length ≤ `policy.maxBatchTasks` (Phase 1 default: `3`).
- At most `policy.maxConcurrentChildren` children active simultaneously inside the call (Phase 1 default: `2`).
- Per-child timeout still applies via `withChildTimeout`.
- **Active-child cap.** The whole batch is rejected when `activeBefore + min(maxConcurrentChildren, validTasks) > maxActiveChildrenPerParent`. The projection uses `min(maxConcurrentChildren, validTasks)` because the parallel runner caps simultaneous execution — a high task count with low concurrency does not violate the cap. `delegate_task` (singular) applies the simpler check `activeCount >= maxActiveChildrenPerParent` since it adds at most one child.

### Result

```json
{
  "total": 3,
  "completed": 2,
  "partial": 0,
  "failed": 1,
  "results": [
    { "index": 0, "runId": "...", "label": "alpha", "status": "completed", "summary": "...", "warnings": [] },
    { "index": 1, "runId": "...", "label": "bravo", "status": "failed", "summary": "...", "warnings": [], "failureCode": "timeout" },
    { "index": 2, "runId": "...", "label": "charlie", "status": "completed", "summary": "...", "warnings": [] }
  ]
}
```

`results` is always indexed by input position. A task that fails per-task validation still occupies its index — its envelope reports `status: "failed"`, `failureCode: "validation_error"` and never touches the registry.

### Programmatic use

`runChildrenInParallel({ requests, maxConcurrent, executeOne, onWorker? })` is exported for consumers that need parallel fan-out without going through the LLM tool surface. Determinism guarantee: result slot `i` is always the result for `requests[i]`, regardless of completion order. The runner's `executeOne` contract is "always returns an envelope, never throws"; throwing propagates out of the runner (the standard executor `executeChildRun` follows the contract).

---

## The `delegate_task` tool

The LLM-visible tool name is exactly `delegate_task` — domain-neutral, registered with `source: "system"`, `risk: "read"` (the tool itself just routes; any writes performed by the delegated run are gated by *that* run's tool policy).

### Schema

```ts
{
  label: string;        // ≤ 100 chars
  description: string;
  prompt: string;       // ≤ policy.maxChildPromptChars
  contextMode?: "isolated" | "fork";
  maxTokens?: number;   // ≤ policy.maxChildTokens
  timeoutMs?: number;   // > 0
}
```

### Tool result projected to the LLM

```json
{
  "runId": "...",
  "label": "research-pass",
  "status": "completed",
  "summary": "Found three findings.",
  "warnings": [],
  "failureCode": "..."
}
```

`failureCode` is present only when `status` is non-completed. Possible values: `"timeout"`, `"cancelled"`, `"tool_error"`, `"llm_error"`, `"validation_error"`, `"unknown"`.

### Preventing grandchildren

Children must not spawn grandchildren in Phase 1. Two independent mechanisms:

1. **Primary: the tool is not registered into child runtimes.** `createChildRuntimeContext` builds a runtime with the consumer-supplied factory — and the default factory does not include `delegate_task`. There is nothing for a child's LLM to call.
2. **Defense in depth: the tool's `execute` rejects when `parentDepth >= policy.maxDepth`.** Catches future refactors that ever register the tool in a child runtime.

Old draft plans considered using a deny-list approach (every child preset's `deny` array includes `delegate_task`). That was rejected: deny-lists rot every time a new preset is added.

---

## Policy presets and `PresetOverrides`

Orchestration ships four domain-neutral preset names:

| Preset | `domain` source | Intent |
|--------|-----------------|--------|
| `read_only_research` | off | Memory + system tools only. |
| `read_and_memory` | off | Same as above. |
| `read_and_validation` | on | Domain reads (consumer supplies `allow`). |
| `limited_write_candidate_generation` | on | Limited domain writes (consumer supplies `allow`/`deny`). |

The default preset for child runs is `read_only_research`.

The presets ship with empty `allow` and `deny` lists. Consumers supply domain-specific tool names through `PresetOverrides` at policy-construction time. Orchestration treats every consumer-supplied string as opaque.

```ts
const overrides: PresetOverrides = {
  read_and_validation: {
    allow: ["list_files", "read_file", "search_files"]
  }
};

const policy = resolveToolPolicyForPreset("read_and_validation", overrides);
```

Unknown preset names fall through to a fully-restricted policy (every source disabled). This is conservative on purpose — a typo produces a child that can't reach any tool, not one that silently inherits broad access.

---

## Synthesis

Phase 1 ships only `synthesisMode: "separate_call"`. After every orchestrated turn that produced at least one child:

1. The orchestrator constructs a synthesis prompt with sections in this order: `[Parent Objective]`, `[Child Results]`, optional `[Child Failures]`, `[Required Final Output Constraints]`.
2. Synthesis runs as a fresh `runToolAgentLoop` call with **no tools**, distinct session id `${parentRunId}-synthesis`, and a lightweight coordinator system prompt (see `buildSynthesisSystemPrompt`).
3. The synthesis call's `text` becomes the orchestrator's `finalText`.

If the synthesis call itself throws, the orchestrator records the error to `state.warnings` and produces a deterministic fallback text that lists every child's status and summary. Users still see something useful even when synthesis is broken.

### Cost tradeoff

Separate-call synthesis doubles the parent-side LLM cost on every orchestrated turn (one parent planning call + one synthesis call, on top of N child calls). The cleaner alternative — injecting child result envelopes back as tool-result messages into the parent's existing loop — is rejected for Phase 1 because of determinism (separate call is much easier to test and reason about), observability (synthesis output is cleanly tagged), and failure isolation (a synthesis-prompt bug doesn't poison the parent's state). The `synthesisMode` policy field is shaped so the alternative can land later.

---

## Observability

Two observability hooks ship with `RunOrchestratorOutput` — no extra wiring needed:

### Per-phase timings

`OrchestratorState.timings: PhaseTiming[]` records when each phase started, ended, and how long it took. The clock advances exactly once per transition, so `prev.endedAt === next.startedAt` and total wall-clock equals the sum of phase durations. Tests pass a stepped clock for deterministic assertions; production uses `() => new Date().toISOString()`.

```ts
interface PhaseTiming {
  phase: OrchestratorPhase;
  startedAt: string;     // ISO 8601
  endedAt?: string;
  durationMs?: number;
}
```

The final phase's `endedAt` / `durationMs` is closed before `runOrchestrator` returns on every code path (success, no-delegation short-circuit, parent-loop failure, synthesis failure).

### Registry snapshot in output

`RunOrchestratorOutput.registrySnapshot: RegistrySnapshot` is the registry's view of every child for *this parent only* at the moment the orchestrator returned. Lets log middleware capture full lifecycle data without poking the registry directly.

The same filter is exposed as `filterSnapshotByParent(snapshot, parentRunId)` — a pure function that callers can use against a registry shared by multiple parents.

### Progress messages

`onProgress` callbacks tag parent and child timelines distinguishably:
- Parent messages start with `[child:parent:<runId>]` (the orchestrator's reporter is a child reporter labelled for the parent).
- Child messages start with `[child:<label>]`.

Phase messages emitted by `runOrchestrator` include:
- `"planning delegated work"` when entering `plan`.
- `"delegated N task(s)"` when entering `delegate`.
- `"collected N result(s): A completed, B failed, C timed out, D cancelled"` when entering `wait`.
- `"synthesizing N result(s)"` (or the partial-failure variant) when entering `synthesize`.
- `"finalizing"` when entering `finalize`.
- `"no delegation; finalizing parent output"` on the short-circuit.

#### Per-child completion metrics

On a successful (or `partial`) child run the executor emits a single structured summary line:

```
[child:<label>] completed in <ms>ms (tools=N, errors=M, chars=K[, tokens=T, cost=$C])
```

A `partial` child is preceded by `[child:<label>] stopped early (<endReason>)`.

- `tools` — total tool calls the child made (`envelope.toolCalls.length`).
- `errors` — subset of those whose execution returned `isError: true`.
- `chars` — length of the child's final text output, a cheap proxy for output volume.
- `tokens`, `cost` — the child's real total tokens and USD cost (from `envelope.usage`), present only when the adapter reports usage. Use these, not `chars`, for billing.

The counters are sourced from the `ChildRunResultEnvelope`, so the emitted line and the returned envelope can never disagree. Failure paths (`failed: …`, `timed out after <ms>ms`) intentionally do not include this structured suffix — observers can distinguish success from failure on the message prefix alone.

The `ChildCompletionMetrics` type is exported for consumers that want to recompute or render the same shape themselves.

### Lifecycle counts

`RunOrchestratorOutput.childCounts: ChildLifecycleCounts` exposes `total`, `completed`, `failed`, `timedOut`, `cancelled`. Derived from `state.childResults`; `computeChildLifecycleCounts(results)` is exported for callers that want to recompute against a filtered subset.

---

## Cancellation note

Full `AbortSignal` cancellation is plumbed end-to-end through the orchestration APIs:

- `RunOrchestratorInput.signal` — forwarded to the parent `runToolAgentLoop` call and to `runSynthesis`. An abort during the parent loop produces a deterministic finalize with `state.warnings` containing `"Parent loop cancelled: …"` and `finalText` mirroring the same prefix (distinct from the generic `"Parent loop failed: …"` path).
- `DelegateToolContext.signal` / `DelegateTasksToolContext.signal` — forwarded into `executeChildRun` for every spawned child. Consumers wire the same signal into both the orchestrator input and the delegate context so the abort fans out.
- `ExecuteChildRunInput.signal` — pre-flight aborts return a `cancelled` envelope without touching the registry; mid-flight aborts race with the per-child timeout via `withChildTimeout(timeoutMs, promise, signal?)`. Whichever fires first determines the terminal status (`cancelled` vs. `timed_out`); only one `markTerminal` call reaches the registry.
- `ToolAgentInput.signal` — the LLM adapter forwards it to `runToolAgent` in the in-house `tool-agent-runtime`, which propagates it to every `streamSimple` call and every tool's `execute` method.

`ChildRunCancelledError` is mapped to a `cancelled` terminal envelope by the executor, so the parent sees a failure envelope rather than an exception. The per-child timeout still acts as an upper bound independent of provider-level cancellation latency — the two mechanisms are additive.

A consumer adapter typically accepts an optional `signal` and threads it into both `runOrchestrator` and the `DelegateToolContext`, so a route handler can pass `req.signal` to terminate the entire orchestrated run on client disconnect.

---

## Tests

Lives in `test/`:

| File | Coverage |
|------|----------|
| `foundations.test.ts` | Registry transitions, policy defaults, limit checks, preset resolver, public-surface domain-neutrality grep. |
| `childRunExecutor.test.ts` | Success / empty-output / undefined-output paths; LLM error / timeout / validation rejection paths; runtime disposal on every code path; runtime-factory-failure stranding guard; tool / runtime threading; cancellation paths (pre-aborted signal short-circuits without LLM call or registry pollution; mid-call abort yields `cancelled` envelope and disposes runtime; signal forwarded into `runToolAgentLoop`; timeout-vs-abort precedence); structured completion metrics (`tools`, `errors`, `chars` in the completion line, zero-output edge case, failed runs do not emit the structured-metrics line). |
| `contextFork.test.ts` | `buildForkedContextBlock` rendering, ordering, truncation, label sanitisation; `buildChildSystemPrompt` fork branch with section ordering; determinism. |
| `delegateTaskTool.test.ts` | Tool registration shape; success projection; validation paths; depth-gating safety net; active-child cap (`maxActiveChildrenPerParent`); runtime-failure projection; reusability boundary; signal forwarding from context into the child's LLM call; pre-aborted signal yields `cancelled` payload without registry pollution. |
| `orchestratorLoop.test.ts` | Synthesis prompt section order and conditional sections; no-delegation short-circuit; one/multi-child synthesis with sessionId distinctness; synthesis-failure fallback; phase-machine error class; `mergeWithDelegateTool`; reusability boundary; signal forwarded into the parent `runToolAgentLoop`; parent-loop abort produces the distinct `"Parent loop cancelled"` warning and final text. |
| `orchestratorIntegration.test.ts` | End-to-end with a scripted LLM stub: 4-call ordering for two delegate calls + synthesis; mixed success/failure visibility in synthesis prompt (this test surfaced and locked in the `markTerminal` registry symmetry); all-failure path still synthesizes; validation rejection isolation; progress timeline tagging; registry/state agreement. |
| `observability.test.ts` | Per-phase timings populate on every return path and every phase has `endedAt` / `durationMs` filled; total wall-clock equals the sum of phase durations; `registrySnapshot` contains exactly this parent's children; `filterSnapshotByParent` is pure and order-preserving. |
| `parallelFanOut.test.ts` | `runChildrenInParallel` empty-input / order-preservation / concurrency-cap / `maxConcurrent <= 0` clamp / `onWorker` hook / executor-throw propagation. `delegate_tasks` registration shape; happy-path 3-task batch; bounded peak under load; batch-level rejection (empty array / `maxBatchTasks` / depth-gate / active-cap projected against `maxConcurrentChildren`); active-cap boundary allowed; high-task / low-concurrency batch allowed (cap on peak, not total); per-task validation isolation; per-task runtime failure surfacing; result-shape contract; reusability boundary; policy defaults. |

The scripted-LLM stub in `orchestratorIntegration.test.ts` is the closest harness to real LLM behaviour without a network call — each scripted turn fires its tool calls in order through the real tool `execute` callbacks.

---

## Integrating Orchestration into a consumer app

1. Install `@maya-ai/agent-loop-orchestration` and its peers `@maya-ai/agent-loop-core` + `@maya-ai/tool-agent-runtime`.
2. Provide a **child runtime factory** that builds an `AgentRuntimeContext` for delegated children. The default factory disables MCP/memory/skills and exposes nothing — your factory is what gives children useful tools.
3. Provide a **`PresetOverrides` map** that maps the orchestration preset names onto your domain tool names. At minimum, `read_and_validation: { allow: [...your read tools...] }` if you want children to read domain state.
4. Provide a **gating decision** — when should orchestration be enabled? Likely an env var as a global kill-switch, plus a per-call override or per-tenant flag. Keep this in your adapter, not in this package.
5. Wire `runOrchestrator` in your adapter:
   - Build your normal parent prompt + tool list as if you were calling `runToolAgentLoop` directly.
   - Append a `delegate_task` tool created via `createDelegateTaskTool({ parentRunId, parentDepth: 0, llm, registry, policy, presetOverrides, runtimeFactory })`.
   - Call `runOrchestrator` with the parent prompt + tools (including `delegate_task`).
   - On success, stitch a `ToolAgentOutput` from `output.finalText` + `output.parentOutput.toolCalls` and pass it to your adapter's finalize step. The synthesis text is the user-facing answer; the parent's tool calls are what mutated state.
6. Optionally provide a richer registry. The in-memory `createInMemoryChildRunRegistry` is fine for one-shot request flows; persistent stores can implement the same `ChildRunRegistry` contract.

The reusable contract is intentionally narrow: `ChildRunRequest`, `ChildRunResultEnvelope`, `OrchestrationPolicy`, `PresetOverrides`, `DelegateToolContext`, `RunOrchestratorInput`. Everything domain-specific (which tools children can call, how the parent's prompt is composed, how the final answer is rendered) flows through these contracts. None of them mention domain vocabulary.

## License

MIT.

## Provenance

Developed with liberal help from multiple AI tools orchestrating code generation and iteration. Humans mostly handled testing, sanity checks, and keeping the whole operation charmingly lawful.
