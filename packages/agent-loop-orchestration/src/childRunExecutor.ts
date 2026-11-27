/**
 * Child Run Executor (Stage 4).
 *
 * `executeChildRun` is the only place that turns a `ChildRunRequest` into a
 * real tool-using LLM call. It wraps `runToolAgentLoop` from core, enforces
 * the per-child timeout (non-negotiable in Phase 1), constructs and disposes
 * a child-scoped runtime context, and normalises every outcome — success or
 * failure — into a `ChildRunResultEnvelope`.
 *
 * Reusability rules followed here:
 *   - No imports from any consumer-app path.
 *   - The executor never throws on expected failures (timeout, validation,
 *     LLM error). Callers always receive an envelope. Unexpected internal
 *     bugs may still throw.
 *   - The runtime factory and prompt builder are injectable so consumers
 *     with richer needs can supply their own without forking this module.
 */

import {
  ChildRunCancelledError,
  ChildRunValidationError,
  type ChildRunRegistry,
  withChildTimeout
} from "./childRunRegistry.js";
import {
  statusForFailureCode,
  toChildRunFailure,
  toChildRunResultEnvelope,
  toFailureEnvelope
} from "./childRunResult.js";
import {
  buildChildBrief,
  buildChildSystemPrompt as defaultBuildChildSystemPrompt
} from "./orchestrationPrompt.js";
import { inheritAllowedToolNames, type InheritModeOptions } from "./inheritMode.js";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  checkDepth,
  resolveChildModel,
  type OrchestrationPolicy,
  type PresetOverrides
} from "./orchestrationPolicy.js";
import {
  buildChildTools as defaultBuildChildTools,
  createChildRuntimeContext as defaultCreateChildRuntimeContext
} from "./orchestrationRuntime.js";
import { createChildProgressReporter, type ProgressSink } from "./progress.js";
import type {
  ChildRunRequest,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";

import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import { disposeAgentRuntimeContext } from "@maya-ai/agent-loop-core";
import { runToolAgentLoop } from "@maya-ai/agent-loop-core";
import type { ToolLlmAdapter } from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

export interface ExecuteChildRunInput {
  request: ChildRunRequest;
  llm: ToolLlmAdapter;
  registry: ChildRunRegistry;
  policy?: OrchestrationPolicy;
  presetOverrides?: PresetOverrides;
  onProgress?: ProgressSink;
  /** Override clock for deterministic tests. */
  clock?: () => string;
  /** Override runtime construction (e.g. tests, or consumers needing memory). */
  runtimeFactory?: (request: ChildRunRequest) => Promise<AgentRuntimeContext>;
  /** Override system-prompt construction. */
  buildSystemPrompt?: (input: {
    request: ChildRunRequest;
    runtime: AgentRuntimeContext;
  }) => string;
  /** Override tool resolution. */
  buildTools?: (runtime: AgentRuntimeContext) => AgentTool<any>[];
  /**
   * Cooperative cancellation. Aborting before the LLM call returns
   * produces a `cancelled` envelope; aborting before validation runs
   * also produces a `cancelled` envelope and never touches the registry.
   * The signal is forwarded into `runToolAgentLoop` so the in-house
   * runtime aborts in-flight LLM streams and tool work too.
   */
  signal?: AbortSignal;
  /**
   * Options for `contextMode: "inherit"` (which parent tools the child may
   * run). Without them an inherit child may run none of the parent's tools.
   */
  inherit?: InheritModeOptions;
}

/**
 * Execute one child run end-to-end.
 *
 * Always resolves to a `ChildRunResultEnvelope`. The envelope's `status`
 * reflects the outcome — `completed`, `failed`, `timed_out`, or
 * `cancelled`. Callers decide how to surface failures; the executor never
 * throws on expected-class failures.
 */
export async function executeChildRun(
  input: ExecuteChildRunInput
): Promise<ChildRunResultEnvelope> {
  const policy = input.policy ?? DEFAULT_ORCHESTRATION_POLICY;
  const clock = input.clock ?? (() => new Date().toISOString());
  const startedAt = clock();
  const progress = createChildProgressReporter({
    label: input.request.label,
    onProgress: input.onProgress
  });

  // ------------------------------------------------------------
  // Pre-flight cancellation check. An already-aborted signal short-
  // circuits before validation, before registry creation, and before
  // any LLM call. The envelope is `cancelled` (not `failed`) so callers
  // can distinguish parent-driven cancellation from a malformed input.
  // ------------------------------------------------------------
  if (input.signal?.aborted) {
    const failure = toChildRunFailure(
      new ChildRunCancelledError("Child run was cancelled before execution")
    );
    progress.failed("cancelled");
    return toFailureEnvelope({
      request: input.request,
      failure,
      startedAt,
      endedAt: clock(),
      status: "cancelled"
    });
  }

  // ------------------------------------------------------------
  // Pre-registry validation. We deliberately do these checks *before*
  // creating a registry entry: a malformed request shouldn't pollute
  // the registry. Stage 6 (the delegate_task tool) does richer
  // validation when the LLM provides the inputs; this layer is
  // defensive against direct programmatic callers.
  // ------------------------------------------------------------
  const validationFailure = validateRequest(input.request, policy);
  if (validationFailure) {
    progress.failed(validationFailure.message);
    return toFailureEnvelope({
      request: input.request,
      failure: validationFailure,
      startedAt,
      endedAt: clock(),
      status: "failed"
    });
  }

  // From here on the registry tracks the lifecycle.
  input.registry.create(input.request, startedAt);

  // ------------------------------------------------------------
  // Runtime setup happens BEFORE markRunning so a setup failure
  // does not leave the registry in a permanently "running" state.
  // ------------------------------------------------------------
  let runtime: AgentRuntimeContext | undefined;
  try {
    runtime = await (input.runtimeFactory
      ? input.runtimeFactory(input.request)
      : defaultCreateChildRuntimeContext({
          request: input.request,
          options: { presetOverrides: input.presetOverrides }
        }));
  } catch (error) {
    const failure = toChildRunFailure(error);
    const endedAt = clock();
    const envelope = toFailureEnvelope({
      request: input.request,
      failure,
      startedAt,
      endedAt,
      status: "failed"
    });
    input.registry.markTerminal(envelope);
    progress.failed(failure.message);
    return envelope;
  }

  input.registry.markRunning(input.request.runId);
  progress.start();

  const buildSystemPrompt = input.buildSystemPrompt ?? defaultBuildChildSystemPrompt;
  const buildTools = input.buildTools ?? defaultBuildChildTools;

  // "inherit" needs the parent's request and an adapter that honours
  // `messages` and tool hooks; otherwise the child runs isolated.
  const warnings: string[] = [];
  let request = input.request;
  if (request.contextMode === "inherit") {
    const unavailable = inheritUnavailableReason(request, input.llm);
    if (unavailable) {
      warnings.push(`inherit unavailable: ${unavailable}; ran isolated`);
      const { inherited: _dropped, ...rest } = request;
      request = { ...rest, contextMode: "isolated" };
    }
  }

  // ------------------------------------------------------------
  // Run the loop with a per-child timeout. Any error path lands in
  // the catch below; success path normalises through
  // toChildRunResultEnvelope. The finally block disposes the runtime.
  // ------------------------------------------------------------
  try {
    const timeoutMs = input.request.timeoutMs ?? policy.defaultChildTimeoutMs;
    const maxTurns = input.request.maxTurns ?? policy.defaultChildMaxTurns;
    const resolvedModel = resolveChildModel(request, policy);
    const maxTokens = request.maxTokens ?? request.profile?.maxTokens;
    const inherited = request.contextMode === "inherit" ? request.inherited : undefined;
    let run: Promise<Awaited<ReturnType<typeof runToolAgentLoop>>>;
    if (inherited) {
      const allowed = inheritAllowedToolNames(input.inherit?.parentTools, runtime.toolPolicy);
      const reasoning = resolvedModel.thinkingLevel ?? inherited.reasoning;
      if (
        (resolvedModel.model !== undefined && resolvedModel.model !== inherited.modelId) ||
        (resolvedModel.thinkingLevel !== undefined && resolvedModel.thinkingLevel !== (inherited.reasoning ?? "off"))
      ) {
        warnings.push("inherit: model or reasoning differs from the parent; the prompt cache is not reused");
      }
      const sink = progress.loopSink();
      sink("Running the agent update");
      run = input.llm.runToolAgent({
        systemPrompt: inherited.systemPrompt,
        prompt: buildChildBrief({
          request,
          allowedTools: inherited.tools.map((tool) => tool.name).filter((name) => allowed.has(name))
        }),
        messages: inherited.messages.slice(),
        sessionId: inherited.sessionId ?? request.runId,
        tools: inherited.tools.slice(),
        maxTokens,
        onProgress: sink,
        signal: input.signal,
        beforeToolCall: ({ toolCall }) =>
          allowed.has(toolCall.name)
            ? undefined
            : { action: "deny", message: `Tool ${toolCall.name} is not available in this delegated run.` },
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(resolvedModel.model !== undefined ? { model: resolvedModel.model } : {}),
        ...(reasoning !== undefined ? { reasoning } : {})
      });
    } else {
      run = runToolAgentLoop({
        llm: input.llm,
        systemPrompt: buildSystemPrompt({ request, runtime }),
        prompt: request.prompt,
        sessionId: request.runId,
        tools: buildTools(runtime),
        maxTokens,
        onProgress: progress.loopSink(),
        signal: input.signal,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(resolvedModel.model !== undefined ? { model: resolvedModel.model } : {}),
        ...(resolvedModel.thinkingLevel !== undefined ? { reasoning: resolvedModel.thinkingLevel } : {})
      });
    }
    const output = await withChildTimeout(timeoutMs, run, input.signal);

    const endedAt = clock();
    const envelope = withWarnings(
      {
        ...toChildRunResultEnvelope({
          request,
          output,
          startedAt,
          endedAt
        }),
        ...resolvedModel
      },
      warnings
    );
    input.registry.markTerminal(envelope);
    if (envelope.status === "failed" || envelope.status === "cancelled") {
      progress.failed(envelope.status === "cancelled" ? "cancelled" : (envelope.failure?.message ?? "failed"));
      return envelope;
    }
    if (envelope.status === "partial") {
      progress.message(`stopped early (${envelope.endReason})`);
    }
    // Stage 13 structured completion metrics. Sourced from the envelope so
    // the emitted line and the returned envelope can never disagree.
    progress.completed({
      durationMs: envelope.durationMs,
      toolCallCount: envelope.toolCalls.length,
      toolErrorCount: envelope.toolCalls.filter((tc) => tc.isError).length,
      outputChars: envelope.text?.length ?? 0,
      ...(envelope.usage ? { totalTokens: envelope.usage.totalTokens, costUsd: envelope.usage.cost.total } : {})
    });
    return envelope;
  } catch (error) {
    const failure = toChildRunFailure(error);
    const endedAt = clock();
    const status = statusForFailureCode(failure.code);
    const envelope = withWarnings(
      toFailureEnvelope({
        request,
        failure,
        startedAt,
        endedAt,
        status
      }),
      warnings
    );
    // Store the full envelope on the registry — registers status + failure
    // + envelope in one call so `getResult` reflects every terminal state.
    input.registry.markTerminal(envelope);
    if (status === "timed_out") {
      progress.timedOut(input.request.timeoutMs ?? policy.defaultChildTimeoutMs);
    } else if (status === "cancelled") {
      progress.failed("cancelled");
    } else {
      progress.failed(failure.message);
    }
    return envelope;
  } finally {
    if (runtime) {
      try {
        await disposeAgentRuntimeContext(runtime);
      } catch {
        // Disposal errors should not mask the run outcome. They are
        // intentionally swallowed; observability lands in Stage 13.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inherit mode helpers
// ---------------------------------------------------------------------------

function inheritUnavailableReason(request: ChildRunRequest, llm: ToolLlmAdapter): string | undefined {
  if (!request.inherited) return "no parent request (the delegate tool was not run by the runtime)";
  const supports = llm.metadata().supports;
  if (supports?.runState !== true) return "the adapter does not support messages";
  if (supports?.approvals !== true) return "the adapter does not support tool hooks";
  return undefined;
}

function withWarnings(envelope: ChildRunResultEnvelope, warnings: string[]): ChildRunResultEnvelope {
  if (warnings.length === 0) return envelope;
  return { ...envelope, warnings: [...warnings, ...(envelope.warnings ?? [])] };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRequest(
  request: ChildRunRequest,
  policy: OrchestrationPolicy
):
  | undefined
  | { code: "validation_error"; message: string; retryable: false } {
  if (!request.runId || request.runId.trim().length === 0) {
    return validationFailure("runId must be non-empty");
  }
  if (!request.parentRunId || request.parentRunId.trim().length === 0) {
    return validationFailure("parentRunId must be non-empty");
  }
  if (!request.label || request.label.trim().length === 0) {
    return validationFailure("label must be non-empty");
  }
  if (request.label.length > 100) {
    return validationFailure("label must be 100 characters or fewer");
  }
  if (!request.description || request.description.trim().length === 0) {
    return validationFailure("description must be non-empty");
  }
  if (!request.prompt || request.prompt.trim().length === 0) {
    return validationFailure("prompt must be non-empty");
  }
  if (request.prompt.length > policy.maxChildPromptChars) {
    return validationFailure(
      `prompt exceeds maxChildPromptChars (${policy.maxChildPromptChars})`
    );
  }
  if (request.maxTokens !== undefined) {
    if (!Number.isFinite(request.maxTokens) || request.maxTokens <= 0) {
      return validationFailure("maxTokens must be a positive integer");
    }
    if (request.maxTokens > policy.maxChildTokens) {
      return validationFailure(
        `maxTokens exceeds policy.maxChildTokens (${policy.maxChildTokens})`
      );
    }
  }
  if (request.maxTurns !== undefined && (!Number.isInteger(request.maxTurns) || request.maxTurns < 1)) {
    return validationFailure("maxTurns must be a positive integer");
  }
  if (
    request.contextMode !== "isolated" &&
    request.contextMode !== "fork" &&
    request.contextMode !== "inherit"
  ) {
    return validationFailure(`contextMode must be "isolated", "fork" or "inherit"`);
  }
  // Depth-gating safety net (primary gate is "tool not registered in child
  // runtimes" — Stage 6). This catches programmatic callers that bypass
  // the tool entirely.
  const depth = checkDepth(policy, request.parentDepth);
  if (!depth.ok) {
    return validationFailure(depth.message);
  }
  return undefined;
}

function validationFailure(message: string): {
  code: "validation_error";
  message: string;
  retryable: false;
} {
  // Construct here so a future Stage 6 path can throw `ChildRunValidationError`
  // and have it mapped via `toChildRunFailure` consistently.
  void ChildRunValidationError; // mark as used; constructor referenced for symmetry.
  return { code: "validation_error", message, retryable: false };
}
