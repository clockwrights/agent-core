/**
 * Internal delegation tool — `delegate_task` (Stage 6).
 *
 * The LLM-visible tool the parent's loop calls to spawn a delegated
 * (child) run. The implementation:
 *
 *   1. Reads the LLM-supplied parameters.
 *   2. Constructs a domain-neutral `ChildRunRequest` by merging the
 *      LLM args with parent-run metadata captured at tool-construction
 *      time (`parentRunId`, `parentDepth`) and policy defaults.
 *   3. Hands the request to `executeChildRun`, which returns a
 *      structured result envelope (success or failure).
 *   4. Projects the envelope into a small JSON shape the LLM can read.
 *
 * Reusability rules followed here:
 *   - LLM-visible name is `delegate_task` — domain-neutral.
 *   - The tool reads no consumer-app state; everything domain-specific
 *     comes through `DelegateToolContext`.
 *   - **Children must not spawn grandchildren.** The primary mechanism
 *     is that `createChildRuntimeContext` (Stage 4) does not register
 *     this tool into child runtimes, so a child's LLM has nothing to
 *     call. The depth check inside `execute` is defense-in-depth: it
 *     rejects when `parentDepth >= policy.maxDepth`. This guards against
 *     future refactors that accidentally register the tool in a child
 *     runtime.
 *   - Phase 1 is blocking-inline: `execute` returns only when the child
 *     result envelope is available.
 */

import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { Type, type Static } from "typebox";
import { v4 as uuid } from "uuid";

import {
  executeChildRun,
  type ExecuteChildRunInput
} from "./childRunExecutor.js";
import type { ChildRunRegistry } from "./childRunRegistry.js";
import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import type { RegisteredTool } from "@maya-ai/agent-loop-core";
import type { ToolLlmAdapter } from "@maya-ai/agent-loop-core";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  checkActiveCount,
  type OrchestrationPolicy,
  type PresetOverrides
} from "./orchestrationPolicy.js";
import type {
  ChildRunRequest,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";
import type { ProgressSink } from "./progress.js";

// ---------------------------------------------------------------------------
// LLM-facing schema
// ---------------------------------------------------------------------------

export const DELEGATE_TASK_TOOL_NAME = "delegate_task" as const;

export const delegateTaskParameters = Type.Object({
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

export type DelegateTaskInput = Static<typeof delegateTaskParameters>;

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

/**
 * Captured at tool-construction time, before the parent's `runToolAgentLoop`
 * call. The LLM never supplies `parentRunId` or `parentDepth`; those flow
 * through this context instead.
 *
 * Optional injection points (`runtimeFactory`, `buildSystemPrompt`,
 * `buildTools`, `clock`) mirror `ExecuteChildRunInput` so consumers and
 * tests can override child runtime behaviour without forking this module.
 */
export interface DelegateToolContext {
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
   * Cooperative cancellation forwarded into `executeChildRun`. When the
   * parent's orchestration is aborted, every child spawned through this
   * delegate context aborts cooperatively too.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Returns the LLM-visible `AgentTool`. Register this into the *parent's*
 * tool list, never into a child runtime.
 */
export function createDelegateTaskTool(
  context: DelegateToolContext
): AgentTool<typeof delegateTaskParameters> {
  return {
    name: DELEGATE_TASK_TOOL_NAME,
    label: "Delegate Task",
    description:
      "Delegate a bounded research or validation task to a separate agent run. The delegated run executes independently and returns a structured result; this call blocks until it completes.",
    parameters: delegateTaskParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      return executeDelegateTask(params as DelegateTaskInput, context);
    }
  };
}

/**
 * Convenience: returns the tool wrapped in a `RegisteredTool` with source
 * `"system"` and risk `"read"`. Risk is `read` because the tool itself
 * just routes work — any writes performed by the delegated run are gated
 * by that run's own tool policy.
 */
export function createDelegateTaskToolDefinition(
  context: DelegateToolContext
): RegisteredTool {
  return {
    tool: createDelegateTaskTool(context),
    metadata: { source: "system", risk: "read" }
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Public for tests. Shaped to match what `AgentTool.execute` returns.
 */
export async function executeDelegateTask(
  input: DelegateTaskInput,
  context: DelegateToolContext
): Promise<DelegateTaskToolResult> {
  const policy = context.policy ?? DEFAULT_ORCHESTRATION_POLICY;
  const validation = validateDelegateInput(input, context, policy);
  if (validation) {
    return toToolResult(synthesiseValidationEnvelope(input, context, validation));
  }

  const request = toChildRunRequest(input, context, policy);

  const envelope = await executeChildRun({
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
    signal: context.signal
  });

  return toToolResult(envelope);
}

// ---------------------------------------------------------------------------
// Result projection (LLM-facing)
// ---------------------------------------------------------------------------

export interface DelegateTaskToolResultPayload {
  runId: string;
  label: string;
  status: ChildRunResultEnvelope["status"];
  summary: string;
  warnings: string[];
  failureCode?: string;
}

export interface DelegateTaskToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    runId: string;
    label: string;
    status: ChildRunResultEnvelope["status"];
    failureCode?: string;
    durationMs: number;
  };
}

function toToolResult(envelope: ChildRunResultEnvelope): DelegateTaskToolResult {
  const payload: DelegateTaskToolResultPayload = {
    runId: envelope.runId,
    label: envelope.label,
    status: envelope.status,
    summary: envelope.summary,
    warnings: envelope.warnings ?? []
  };
  if (envelope.failure) {
    payload.failureCode = envelope.failure.code;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: {
      runId: envelope.runId,
      label: envelope.label,
      status: envelope.status,
      failureCode: envelope.failure?.code,
      durationMs: envelope.durationMs
    }
  };
}

// ---------------------------------------------------------------------------
// Internal: validation & request shaping
// ---------------------------------------------------------------------------

interface DelegateValidationFailure {
  message: string;
}

function validateDelegateInput(
  input: DelegateTaskInput,
  context: DelegateToolContext,
  policy: OrchestrationPolicy
): DelegateValidationFailure | undefined {
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    return { message: "label must be non-empty" };
  }
  if (input.label.length > 100) {
    return { message: "label must be 100 characters or fewer" };
  }
  if (typeof input.description !== "string" || input.description.trim().length === 0) {
    return { message: "description must be non-empty" };
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return { message: "prompt must be non-empty" };
  }
  if (input.prompt.length > policy.maxChildPromptChars) {
    return {
      message: `prompt exceeds maxChildPromptChars (${policy.maxChildPromptChars})`
    };
  }
  if (
    input.contextMode !== undefined &&
    input.contextMode !== "isolated" &&
    input.contextMode !== "fork"
  ) {
    return { message: `contextMode must be "isolated" or "fork"` };
  }
  if (input.maxTokens !== undefined) {
    if (!Number.isFinite(input.maxTokens) || input.maxTokens <= 0) {
      return { message: "maxTokens must be a positive integer" };
    }
    if (input.maxTokens > policy.maxChildTokens) {
      return {
        message: `maxTokens exceeds policy.maxChildTokens (${policy.maxChildTokens})`
      };
    }
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      return { message: "timeoutMs must be a positive integer" };
    }
  }
  // Depth-gating safety net. The primary mechanism is "tool not registered
  // in child runtimes"; this catches a refactor that ever registered it.
  if (context.parentDepth >= policy.maxDepth) {
    return {
      message: `parentDepth ${context.parentDepth} >= maxDepth ${policy.maxDepth}`
    };
  }
  // Active-child cap. Phase 1's parent loop is serial, but a future
  // non-blocking delegate variant or external caller could attempt to
  // exceed `maxActiveChildrenPerParent`. This makes the limit honest at
  // the runtime boundary — declared in policy, enforced here.
  const active = context.registry.activeCount(context.parentRunId);
  const activeCheck = checkActiveCount(policy, active);
  if (!activeCheck.ok) {
    return { message: activeCheck.message };
  }
  return undefined;
}

function toChildRunRequest(
  input: DelegateTaskInput,
  context: DelegateToolContext,
  policy: OrchestrationPolicy
): ChildRunRequest {
  return {
    runId: uuid(),
    parentRunId: context.parentRunId,
    parentDepth: context.parentDepth,
    label: input.label,
    description: input.description,
    prompt: input.prompt,
    contextMode: input.contextMode ?? policy.defaultContextMode,
    executionMode: "blocking_inline",
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs ?? policy.defaultChildTimeoutMs,
    allowWriteTools: policy.defaultAllowWriteTools
  };
}

/**
 * Builds a synthetic "failed" envelope for validation rejections so the
 * LLM-facing return shape is uniform between validation and runtime
 * failures. Crucially this does NOT touch the registry — a malformed
 * tool call should not pollute lifecycle state.
 */
function synthesiseValidationEnvelope(
  input: DelegateTaskInput,
  context: DelegateToolContext,
  failure: DelegateValidationFailure
): ChildRunResultEnvelope {
  const clock = context.clock ?? (() => new Date().toISOString());
  const ts = clock();
  return {
    runId: `unassigned-${uuid()}`,
    parentRunId: context.parentRunId,
    label: typeof input.label === "string" && input.label.length > 0 ? input.label : "(unlabelled)",
    status: "failed",
    summary: `Validation rejected delegate_task: ${failure.message}`,
    toolCalls: [],
    failure: {
      code: "validation_error",
      message: failure.message,
      retryable: false
    },
    startedAt: ts,
    endedAt: ts,
    durationMs: 0
  };
}
