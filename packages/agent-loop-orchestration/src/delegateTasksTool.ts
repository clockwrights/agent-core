/**
 * Batched delegation tool — `delegate_tasks` (Stage 9).
 *
 * Sibling to `delegate_task` (singular). Accepts an array of task
 * definitions and runs them in parallel, bounded by
 * `policy.maxConcurrentChildren`. Returns one result envelope per
 * input task in input order — synthesis ordering remains
 * deterministic regardless of completion order.
 *
 * The parent's tool loop still serialises tool calls; parallelism
 * happens *inside* a single `delegate_tasks` invocation. This keeps the
 * simple `delegate_task` path working unchanged for one-off delegations.
 *
 * Reusability: same rules as `delegateTaskTool.ts`. Domain-neutral
 * tool name, no consumer-app imports.
 */

import type { AgentTool, ToolExecutionContext } from "@maya-ai/tool-agent-runtime";
import { Type, type Static } from "typebox";
import { v4 as uuid } from "uuid";

import {
  executeChildRun,
  type ExecuteChildRunInput
} from "./childRunExecutor.js";
import { runChildrenInParallel } from "./parallelChildRunner.js";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  type OrchestrationPolicy
} from "./orchestrationPolicy.js";
import type { ChildRunRegistry } from "./childRunRegistry.js";
import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import type { RegisteredTool } from "@maya-ai/agent-loop-core";
import type { ToolLlmAdapter } from "@maya-ai/agent-loop-core";
import type { PresetOverrides } from "./orchestrationPolicy.js";
import type {
  ChildRunRequest,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";
import type { ProgressSink } from "./progress.js";
import {
  INHERIT_CONTEXT_MODE_DESCRIPTION,
  inheritedRequestFromContext,
  type InheritModeOptions
} from "./inheritMode.js";

// ---------------------------------------------------------------------------
// LLM-facing schema
// ---------------------------------------------------------------------------

export const DELEGATE_TASKS_TOOL_NAME = "delegate_tasks" as const;

export const delegateTasksTaskParameters = Type.Object({
  label: Type.String({
    description: "Short label for the delegated task (max 100 chars)."
  }),
  description: Type.String({
    description: "Full description of what the delegated run should accomplish."
  }),
  prompt: Type.String({
    description: "The complete prompt the delegated agent receives as its task."
  }),
  contextMode: Type.Optional(
    Type.Union(
      [Type.Literal("isolated"), Type.Literal("fork")],
      {
        description:
          "How much parent context the delegate receives. Defaults to isolated."
      }
    )
  ),
  maxTokens: Type.Optional(
    Type.Number({ description: "Maximum output tokens per model call for the delegated run (capped by policy)." })
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Timeout in milliseconds for this delegated run." })
  )
});

export const delegateTasksParameters = Type.Object({
  tasks: Type.Array(delegateTasksTaskParameters, {
    description: "Tasks to run in parallel. Order is preserved in the result."
  })
});

/** A task of `delegateTasksParametersWithInherit`: "inherit" added to `contextMode`. */
export const delegateTasksTaskParametersWithInherit = Type.Object({
  ...delegateTasksTaskParameters.properties,
  contextMode: Type.Optional(
    Type.Union(
      [Type.Literal("isolated"), Type.Literal("fork"), Type.Literal("inherit")],
      {
        description: `How much parent context the delegate receives. Defaults to isolated. ${INHERIT_CONTEXT_MODE_DESCRIPTION}`
      }
    )
  )
});

/** `delegateTasksParameters` with "inherit" allowed per task; used when `inherit` is enabled. */
export const delegateTasksParametersWithInherit = Type.Object({
  tasks: Type.Array(delegateTasksTaskParametersWithInherit, {
    description: "Tasks to run in parallel. Order is preserved in the result."
  })
});

export type DelegateTasksTaskInput = Static<typeof delegateTasksTaskParametersWithInherit>;
export type DelegateTasksInput = Static<typeof delegateTasksParametersWithInherit>;

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

export interface DelegateTasksToolContext {
  parentRunId: string;
  parentDepth: number;
  llm: ToolLlmAdapter;
  registry: ChildRunRegistry;
  policy?: OrchestrationPolicy;
  presetOverrides?: PresetOverrides;
  onProgress?: ProgressSink;
  clock?: () => string;
  runtimeFactory?: (request: ChildRunRequest) => Promise<AgentRuntimeContext>;
  buildSystemPrompt?: ExecuteChildRunInput["buildSystemPrompt"];
  buildTools?: ExecuteChildRunInput["buildTools"];
  /**
   * Cooperative cancellation forwarded into every child spawned by this
   * batched call. Parent abort propagates to all children in the batch.
   */
  signal?: AbortSignal;
  /**
   * Enables `contextMode: "inherit"` per task: each child continues from
   * this run's real model request, so all of them reuse the same cached
   * prefix. Off by default; without it the tool schema is unchanged.
   */
  inherit?: InheritModeOptions;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDelegateTasksTool(
  context: DelegateTasksToolContext
): AgentTool<typeof delegateTasksParameters> {
  const description =
    "Delegate multiple bounded tasks to separate agent runs in parallel. Returns one result per task in input order. Use when several research / validation subtasks are independent and can run concurrently; for a single delegation, prefer delegate_task.";
  return {
    name: DELEGATE_TASKS_TOOL_NAME,
    label: "Delegate Tasks (Parallel)",
    description: context.inherit ? `${description} ${INHERIT_CONTEXT_MODE_DESCRIPTION}` : description,
    parameters: (context.inherit ? delegateTasksParametersWithInherit : delegateTasksParameters) as typeof delegateTasksParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, executionContext) => {
      return executeDelegateTasks(params as DelegateTasksInput, context, executionContext);
    }
  };
}

export function createDelegateTasksToolDefinition(
  context: DelegateTasksToolContext
): RegisteredTool {
  return {
    tool: createDelegateTasksTool(context),
    metadata: { source: "system", risk: "read" }
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface DelegateTasksResultPayloadEntry {
  index: number;
  runId: string;
  label: string;
  status: ChildRunResultEnvelope["status"];
  summary: string;
  warnings: string[];
  failureCode?: string;
}

export interface DelegateTasksResultPayload {
  total: number;
  completed: number;
  /** Children stopped early by a run limit (status `partial`). */
  partial: number;
  failed: number;
  results: DelegateTasksResultPayloadEntry[];
}

export interface DelegateTasksToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    total: number;
    completed: number;
    failed: number;
    durationMs: number;
  };
}

export async function executeDelegateTasks(
  input: DelegateTasksInput,
  context: DelegateTasksToolContext,
  executionContext?: ToolExecutionContext
): Promise<DelegateTasksToolResult> {
  const policy = context.policy ?? DEFAULT_ORCHESTRATION_POLICY;
  const clock = context.clock ?? (() => new Date().toISOString());
  const startedAt = clock();

  // Top-level batch-shape validation. These are envelope-shaped failures
  // so the LLM-facing result shape stays uniform with successful runs.
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return toToolResult([], startedAt, clock(), [
      synthesiseValidationEnvelope(context, "(batch)", clock(), "tasks must be a non-empty array")
    ]);
  }
  if (input.tasks.length > policy.maxBatchTasks) {
    return toToolResult([], startedAt, clock(), [
      synthesiseValidationEnvelope(
        context,
        "(batch)",
        clock(),
        `tasks.length (${input.tasks.length}) exceeds policy.maxBatchTasks (${policy.maxBatchTasks})`
      )
    ]);
  }

  // Depth-gating safety net (same rule as delegate_task).
  if (context.parentDepth >= policy.maxDepth) {
    return toToolResult([], startedAt, clock(), [
      synthesiseValidationEnvelope(
        context,
        "(batch)",
        clock(),
        `parentDepth ${context.parentDepth} >= maxDepth ${policy.maxDepth}`
      )
    ]);
  }

  // Per-task validation. Invalid tasks produce a validation envelope
  // (without touching the registry); valid tasks produce a request the
  // parallel runner will execute.
  const requests: { index: number; request: ChildRunRequest }[] = [];
  const preFailures: { index: number; envelope: ChildRunResultEnvelope }[] = [];
  input.tasks.forEach((task, index) => {
    const failure = validateTaskShape(task, policy, context.inherit !== undefined);
    if (failure) {
      preFailures.push({
        index,
        envelope: synthesiseValidationEnvelope(
          context,
          typeof task.label === "string" && task.label.length > 0 ? task.label : "(unlabelled)",
          clock(),
          failure
        )
      });
    } else {
      const request = toChildRunRequest(task, context, policy);
      if (request.contextMode === "inherit") {
        const inherited = inheritedRequestFromContext(executionContext);
        if (inherited) request.inherited = inherited;
      }
      requests.push({ index, request });
    }
  });

  // Active-child cap (defense-in-depth alongside `maxBatchTasks`).
  //
  // The parallel runner caps simultaneous execution at
  // `maxConcurrentChildren`, so the peak number of children registered
  // as active for this parent during the batch is
  // `activeBefore + min(maxConcurrentChildren, validTasks)` — not
  // `activeBefore + validTasks`. Use that projection so a high-task /
  // low-concurrency batch (e.g. 4 tasks @ concurrency 2 with maxActive 3)
  // is correctly allowed while a high-concurrency or pre-loaded parent
  // is correctly rejected. Reject the whole batch — not individual tasks
  // — so partial batches never silently violate the limit.
  if (requests.length > 0) {
    const active = context.registry.activeCount(context.parentRunId);
    const peak = active + Math.min(policy.maxConcurrentChildren, requests.length);
    if (peak > policy.maxActiveChildrenPerParent) {
      return toToolResult([], startedAt, clock(), [
        synthesiseValidationEnvelope(
          context,
          "(batch)",
          clock(),
          `peak active children ${peak} (active ${active} + concurrent ${Math.min(policy.maxConcurrentChildren, requests.length)}) > maxActiveChildrenPerParent ${policy.maxActiveChildrenPerParent}`
        )
      ]);
    }
  }

  // Run valid requests in parallel.
  const runResults = requests.length === 0
    ? []
    : await runChildrenInParallel({
        requests: requests.map((r) => r.request),
        maxConcurrent: policy.maxConcurrentChildren,
        executeOne: (request) =>
          executeChildRun({
            request,
            llm: context.llm,
            registry: context.registry,
            policy,
            presetOverrides: context.presetOverrides,
            onProgress: context.onProgress,
            clock: context.clock,
            runtimeFactory: context.runtimeFactory,
            buildSystemPrompt: context.buildSystemPrompt,
            buildTools: context.buildTools,
            signal: context.signal,
            ...(context.inherit ? { inherit: context.inherit } : {})
          })
      });

  // Stitch results back into input order.
  const ordered: ChildRunResultEnvelope[] = new Array(input.tasks.length);
  for (let k = 0; k < requests.length; k++) {
    ordered[requests[k].index] = runResults[k];
  }
  for (const { index, envelope } of preFailures) {
    ordered[index] = envelope;
  }

  return toToolResult(ordered, startedAt, clock(), []);
}

// ---------------------------------------------------------------------------
// Internal: validation
// ---------------------------------------------------------------------------

function validateTaskShape(
  task: DelegateTasksTaskInput,
  policy: OrchestrationPolicy,
  inheritEnabled: boolean
): string | undefined {
  if (typeof task.label !== "string" || task.label.trim().length === 0) {
    return "label must be non-empty";
  }
  if (task.label.length > 100) return "label must be 100 characters or fewer";
  if (typeof task.description !== "string" || task.description.trim().length === 0) {
    return "description must be non-empty";
  }
  if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
    return "prompt must be non-empty";
  }
  if (task.prompt.length > policy.maxChildPromptChars) {
    return `prompt exceeds maxChildPromptChars (${policy.maxChildPromptChars})`;
  }
  const mode = task.contextMode ?? policy.defaultContextMode;
  if (mode === "inherit" && !inheritEnabled) {
    return `contextMode "inherit" is not enabled for this tool`;
  }
  if (mode !== "isolated" && mode !== "fork" && mode !== "inherit") {
    return inheritEnabled
      ? `contextMode must be "isolated", "fork" or "inherit"`
      : `contextMode must be "isolated" or "fork"`;
  }
  if (task.maxTokens !== undefined) {
    if (!Number.isFinite(task.maxTokens) || task.maxTokens <= 0) {
      return "maxTokens must be a positive integer";
    }
    if (task.maxTokens > policy.maxChildTokens) {
      return `maxTokens exceeds policy.maxChildTokens (${policy.maxChildTokens})`;
    }
  }
  if (task.timeoutMs !== undefined) {
    if (!Number.isFinite(task.timeoutMs) || task.timeoutMs <= 0) {
      return "timeoutMs must be a positive integer";
    }
  }
  return undefined;
}

function toChildRunRequest(
  task: DelegateTasksTaskInput,
  context: DelegateTasksToolContext,
  policy: OrchestrationPolicy
): ChildRunRequest {
  return {
    runId: uuid(),
    parentRunId: context.parentRunId,
    parentDepth: context.parentDepth,
    label: task.label,
    description: task.description,
    prompt: task.prompt,
    contextMode: task.contextMode ?? policy.defaultContextMode,
    executionMode: "blocking_inline",
    maxTokens: task.maxTokens,
    timeoutMs: task.timeoutMs ?? policy.defaultChildTimeoutMs,
    allowWriteTools: policy.defaultAllowWriteTools
  };
}

function synthesiseValidationEnvelope(
  context: DelegateTasksToolContext,
  label: string,
  ts: string,
  message: string
): ChildRunResultEnvelope {
  return {
    runId: `unassigned-${uuid()}`,
    parentRunId: context.parentRunId,
    label,
    status: "failed",
    summary: `Validation rejected delegate_tasks task: ${message}`,
    toolCalls: [],
    failure: { code: "validation_error", message, retryable: false },
    startedAt: ts,
    endedAt: ts,
    durationMs: 0
  };
}

// ---------------------------------------------------------------------------
// Result projection
// ---------------------------------------------------------------------------

function toToolResult(
  results: ChildRunResultEnvelope[],
  startedAt: string,
  endedAt: string,
  fallback: ChildRunResultEnvelope[]
): DelegateTasksToolResult {
  // `fallback` is used when batch-level validation rejected the call
  // before any per-task work; in that case `results` is empty and
  // `fallback` contains a single synthetic envelope.
  const effective = results.length > 0 ? results : fallback;

  let completed = 0;
  let partial = 0;
  let failed = 0;
  for (const r of effective) {
    if (r.status === "completed") completed++;
    else if (r.status === "partial") partial++;
    else failed++;
  }

  const payload: DelegateTasksResultPayload = {
    total: effective.length,
    completed,
    partial,
    failed,
    results: effective.map((r, i) => ({
      index: i,
      runId: r.runId,
      label: r.label,
      status: r.status,
      summary: r.summary,
      warnings: r.warnings ?? [],
      failureCode: r.failure?.code
    }))
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: {
      total: payload.total,
      completed: payload.completed,
      failed: payload.failed,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
    }
  };
}

