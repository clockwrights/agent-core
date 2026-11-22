/**
 * Multi-agent orchestration layer.
 *
 * REUSABLE COMPONENT — same boundary rules as `@maya-ai/agent-loop-core`,
 * `@maya-ai/document-pipeline`, `@maya-ai/document-policies`,
 * `@maya-ai/llm-profiles`:
 *
 *   - Self-contained package.
 *   - Zero imports from any consumer-app module.
 *   - All exported types, prompts, and tool names are domain-neutral.
 *
 * Consumers supply domain specifics through the contracts exported here —
 * never the reverse.
 *
 * Phase 1 scope: blocking inline child runs, isolated context by default,
 * maxDepth = 1, sequential execution.
 */

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type {
  ChildContextMode,
  ChildExecutionMode,
  ChildExecutionProfile,
  ChildRunExecutionOptions,
  ChildRunFailure,
  ChildRunFailureCode,
  ChildRunHandle,
  ChildRunProposedChangeSet,
  ChildRunRequest,
  ChildRunResultEnvelope,
  ChildRunStatus,
  ChildRunToolCallSummary,
  ChildThinkingLevel,
  OrchestratorDecision,
  OrchestratorSynthesisInput,
  ParentContextSlice
} from "./orchestrationTypes.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export {
  ChildRunCancelledError,
  ChildRunTimeoutError,
  ChildRunValidationError,
  RegistryTransitionError,
  RegistryUnknownRunError,
  createInMemoryChildRunRegistry,
  filterSnapshotByParent,
  withChildTimeout
} from "./childRunRegistry.js";

export type {
  ChildRunRegistry,
  ChildRunRegistryOptions,
  RegistrySnapshot,
  RegistrySnapshotEntry
} from "./childRunRegistry.js";

// ---------------------------------------------------------------------------
// Executor (Stage 4)
// ---------------------------------------------------------------------------

export { executeChildRun } from "./childRunExecutor.js";
export type { ExecuteChildRunInput } from "./childRunExecutor.js";

export {
  statusForFailureCode,
  toChildRunFailure,
  toChildRunResultEnvelope,
  toFailureEnvelope
} from "./childRunResult.js";

export {
  buildChildSystemPrompt,
  buildSynthesisPrompt,
  buildSynthesisSystemPrompt
} from "./orchestrationPrompt.js";
export type {
  BuildChildSystemPromptInput,
  BuildSynthesisPromptInput
} from "./orchestrationPrompt.js";

export {
  DEFAULT_MAX_FORK_CONTEXT_CHARS,
  DEFAULT_MAX_SLICE_CHARS,
  buildForkedContextBlock
} from "./contextFork.js";
export type { ForkContextOptions } from "./contextFork.js";

export {
  DEFAULT_CHILD_PRESET,
  buildChildTools,
  createChildRuntimeContext
} from "./orchestrationRuntime.js";
export type { ChildRuntimeOptions } from "./orchestrationRuntime.js";

export { createChildProgressReporter } from "./progress.js";
export type {
  ChildCompletionMetrics,
  ChildProgressInput,
  ChildProgressReporter,
  ProgressSink
} from "./progress.js";

// ---------------------------------------------------------------------------
// Delegation tool (Stage 6)
// ---------------------------------------------------------------------------

export {
  DELEGATE_TASK_TOOL_NAME,
  createDelegateTaskTool,
  createDelegateTaskToolDefinition,
  delegateTaskParameters,
  executeDelegateTask
} from "./delegateTaskTool.js";
export type {
  DelegateTaskInput,
  DelegateTaskToolResult,
  DelegateTaskToolResultPayload,
  DelegateToolContext
} from "./delegateTaskTool.js";

// ---------------------------------------------------------------------------
// Batched delegation tool (Stage 9)
// ---------------------------------------------------------------------------

export {
  DELEGATE_TASKS_TOOL_NAME,
  createDelegateTasksTool,
  createDelegateTasksToolDefinition,
  delegateTasksParameters,
  delegateTasksTaskParameters,
  executeDelegateTasks
} from "./delegateTasksTool.js";
export type {
  DelegateTasksInput,
  DelegateTasksResultPayload,
  DelegateTasksResultPayloadEntry,
  DelegateTasksTaskInput,
  DelegateTasksToolContext,
  DelegateTasksToolResult
} from "./delegateTasksTool.js";

export { runChildrenInParallel } from "./parallelChildRunner.js";
export type { RunChildrenInParallelInput } from "./parallelChildRunner.js";

// ---------------------------------------------------------------------------
// Orchestrator loop (Stage 7)
// ---------------------------------------------------------------------------

export {
  OrchestratorPhaseTransitionError,
  computeChildLifecycleCounts,
  mergeWithDelegateTool,
  runOrchestrator,
  runSynthesis
} from "./orchestratorLoop.js";
export type {
  ChildLifecycleCounts,
  OrchestratorPhase,
  OrchestratorState,
  PhaseTiming,
  RunOrchestratorInput,
  RunOrchestratorOutput,
  RunSynthesisInput
} from "./orchestratorLoop.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export {
  DEFAULT_ORCHESTRATION_POLICY,
  resolveChildModel,
  TOOL_POLICY_PRESETS,
  checkActiveCount,
  checkDepth,
  resolveToolPolicyForPreset
} from "./orchestrationPolicy.js";

export type {
  LimitCheckResult,
  OrchestrationPolicy,
  PresetOverrides,
  SynthesisMode,
  ToolPolicyPreset
} from "./orchestrationPolicy.js";
