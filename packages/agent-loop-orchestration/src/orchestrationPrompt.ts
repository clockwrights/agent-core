/**
 * Child-run prompt construction.
 *
 * Stage 4 ships a minimal isolated-mode prompt. Stage 5 layers on
 * `fork`-mode context selection.
 *
 * Reusability: domain-neutral — the prompt template references no consumer
 * concepts. Domain-specific guidance, when needed, comes from the consumer
 * through the request's `description` and `prompt` fields.
 */

import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import {
  buildForkedContextBlock,
  type ForkContextOptions
} from "./contextFork.js";
import type { ChildRunRequest } from "./orchestrationTypes.js";

const CHILD_ROLE_BLOCK = [
  "[Child Run Role]",
  "You are a delegated agent run executing a bounded subtask on behalf of a parent agent.",
  "Produce a concise, structured deliverable. Do not invent information beyond the inputs you are given.",
  "Return only what the parent explicitly asked for; the parent will synthesize the final user-facing answer."
].join("\n");

export interface BuildChildSystemPromptInput {
  request: ChildRunRequest;
  runtime: AgentRuntimeContext;
  /** Forwarded to `buildForkedContextBlock` when `contextMode === "fork"`. */
  forkContextOptions?: ForkContextOptions;
}

export function buildChildSystemPrompt(input: BuildChildSystemPromptInput): string {
  const { request, runtime } = input;
  const sections: string[] = [CHILD_ROLE_BLOCK];

  sections.push(buildOperatingConstraintsBlock(request));

  if (runtime.skillsPrompt && runtime.skillsPrompt.trim().length > 0) {
    sections.push(runtime.skillsPrompt.trim());
  }
  if (runtime.memoryPrompt && runtime.memoryPrompt.trim().length > 0) {
    sections.push(runtime.memoryPrompt.trim());
  }

  const diagnostics = formatDiagnostics(runtime);
  if (diagnostics) sections.push(diagnostics);

  sections.push(buildDeliverableBlock(request));

  // Forked parent context goes LAST per the plan's prompt section order, so
  // the deliverable framing is read before optional context.
  if (request.contextMode === "fork") {
    const forkBlock = buildForkedContextBlock(request.parentContext, input.forkContextOptions);
    if (forkBlock) sections.push(forkBlock);
  }

  return sections.join("\n\n");
}

export interface BuildChildBriefInput {
  request: ChildRunRequest;
  /** Parent tools the child may run, in the order they should be listed. */
  allowedTools: readonly string[];
}

/**
 * The user message that starts an `inherit` child after the parent's
 * conversation: the child's role, constraints, tools it may use, deliverable
 * and task. The parent's system prompt and messages stay unchanged in front
 * of it, so they remain a cached prefix.
 */
export function buildChildBrief(input: BuildChildBriefInput): string {
  const { request, allowedTools } = input;
  const tools =
    allowedTools.length > 0
      ? `[Available Tools]\nYou may use: ${allowedTools.join(", ")}. Calls to any other tool in the list fail in this run.`
      : "[Available Tools]\nNo tools are available in this run; answer from the conversation above.";
  return [
    "[Delegated Run]\nThe conversation above belongs to the parent agent and is context only. From here on you are a delegated run: do the task below and nothing else.",
    CHILD_ROLE_BLOCK,
    buildOperatingConstraintsBlock(request),
    tools,
    buildDeliverableBlock(request),
    `[Task]\n${request.prompt.trim()}`
  ].join("\n\n");
}

/**
 * Synthesis system prompt for Stage 7's separate-call synthesis. Kept here
 * so all child-side prompt construction lives in one file.
 */
export function buildSynthesisSystemPrompt(): string {
  return [
    "[Synthesis Role]",
    "You are coordinating multiple delegated agent runs.",
    "Combine the structured child results below into a single response for the user.",
    "If a child failed, explain what was attempted and what was missing.",
    "Do not call tools; produce a self-contained answer."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Synthesis user-prompt builder (Stage 7 / Stage 12)
// ---------------------------------------------------------------------------

import type {
  ChildRunFailure,
  ChildRunResultEnvelope
} from "./orchestrationTypes.js";

export interface BuildSynthesisPromptInput {
  objective: string;
  childResults: ChildRunResultEnvelope[];
  /**
   * Failures that did not produce a child result envelope (rare in Phase 1,
   * since the executor always returns an envelope). Reserved for later
   * stages that may raise pre-envelope failures.
   */
  childFailures?: ChildRunFailure[];
}

const SYNTHESIS_OUTPUT_CONSTRAINTS = [
  "[Required Final Output Constraints]",
  "- Produce ONE final answer for the user, written in their voice.",
  "- Reference findings or warnings from the child results when relevant.",
  "- If any child failed, briefly note what was missing — do not pretend otherwise.",
  "- Do not list raw child run ids unless useful for traceability."
].join("\n");

/**
 * Render the synthesis user prompt. Output sections in this exact order:
 *   [Parent Objective]
 *   [Child Results]
 *   [Child Failures]   (only when present)
 *   [Required Final Output Constraints]
 *
 * Domain-neutral: no consumer-app vocabulary.
 */
export function buildSynthesisPrompt(input: BuildSynthesisPromptInput): string {
  const sections: string[] = [];

  sections.push(`[Parent Objective]\n${input.objective.trim()}`);

  if (input.childResults.length === 0) {
    sections.push("[Child Results]\n(no child results)");
  } else {
    sections.push(["[Child Results]", ...input.childResults.map(formatChildResult)].join("\n\n"));
  }

  const failures = input.childFailures ?? [];
  if (failures.length > 0) {
    sections.push(["[Child Failures]", ...failures.map(formatChildFailure)].join("\n\n"));
  }

  sections.push(SYNTHESIS_OUTPUT_CONSTRAINTS);

  return sections.join("\n\n");
}

function formatChildResult(result: ChildRunResultEnvelope): string {
  const lines: string[] = [];
  lines.push(`### ${result.label}`);
  lines.push(`- Status: ${result.status}`);
  lines.push(`- Summary: ${result.summary}`);
  if (result.warnings && result.warnings.length > 0) {
    lines.push(`- Warnings: ${result.warnings.join("; ")}`);
  }
  if (result.changedFiles && result.changedFiles.length > 0) {
    lines.push(`- Changed files: ${result.changedFiles.join(", ")}`);
  }
  if (result.failure) {
    lines.push(`- Failure code: ${result.failure.code}`);
  }
  return lines.join("\n");
}

function formatChildFailure(failure: ChildRunFailure): string {
  return `- [${failure.code}] ${failure.message}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildOperatingConstraintsBlock(request: ChildRunRequest): string {
  const lines: string[] = [
    "[Operating Constraints]",
    `- Context mode: ${request.contextMode}.`,
    `- You may not delegate further work; this run is a leaf.`
  ];
  if (request.allowWriteTools !== true) {
    lines.push("- You may not modify authoritative state. Return findings or proposals only.");
  }
  return lines.join("\n");
}

function buildDeliverableBlock(request: ChildRunRequest): string {
  return [
    "[Expected Deliverable]",
    `- Label: ${request.label}`,
    `- Task: ${request.description}`,
    "- Output: a concise textual answer. Lead with a one-paragraph summary."
  ].join("\n");
}

function formatDiagnostics(runtime: AgentRuntimeContext): string | undefined {
  if (!runtime.diagnostics || runtime.diagnostics.length === 0) return undefined;
  const lines = runtime.diagnostics
    .filter((d) => d.level !== "info")
    .slice(0, 5)
    .map((d) => `- [${d.level}] ${d.source}: ${d.message}`);
  if (lines.length === 0) return undefined;
  return ["[Runtime Diagnostics]", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Parent-side delegation guidance (opt-in)
// ---------------------------------------------------------------------------

import type { OrchestrationPolicy } from "./orchestrationPolicy.js";

/**
 * A system-prompt block that teaches the parent when and how to delegate:
 * scale effort to the task, delegate only independent subtasks, and write
 * every brief with the same five parts. Limits come from the policy.
 * Append it to the parent system prompt yourself, or pass
 * `appendDelegationGuidance: true` to `runOrchestrator`.
 */
export function buildDelegationGuidance(
  policy: Pick<OrchestrationPolicy, "maxBatchTasks" | "maxConcurrentChildren"> = { maxBatchTasks: 3, maxConcurrentChildren: 2 }
): string {
  return [
    "[Delegation Guidance]",
    "Scale effort to the task before delegating:",
    "- Simple lookups or a few tool calls: do the work yourself; do not delegate.",
    `- Several independent questions: delegate them together with delegate_tasks (at most ${policy.maxBatchTasks} per call; ${policy.maxConcurrentChildren} run at once).`,
    "- One large, separable subtask: delegate it with delegate_task.",
    "- Work whose steps depend on each other, or that needs your full context: keep it yourself.",
    "Delegated runs see only their brief (plus selected context in fork mode) and cannot ask you questions.",
    "Write each brief with these parts:",
    "1. Objective — the single question or outcome the run must deliver.",
    "2. Context — facts you already have that the run needs; what has been tried.",
    "3. Deliverable — format and length of the answer (e.g. bullet findings with sources, under 300 words).",
    "4. Scope — what to cover and what to leave out; tools or sources to prefer or avoid.",
    "5. Done when — the condition for stopping, so the run does not over- or under-search.",
    "Check each result's status: \"partial\" means it stopped at a limit and may be incomplete."
  ].join("\n");
}

export interface DelegationBriefInput {
  objective: string;
  context?: string;
  deliverable: string;
  scope?: string;
  doneWhen?: string;
}

/** Format a child prompt in the five-part brief structure used by the guidance. */
export function buildDelegationBrief(input: DelegationBriefInput): string {
  const section = (title: string, body: string | undefined) =>
    body && body.trim().length > 0 ? `[${title}]\n${body.trim()}` : undefined;
  return [
    section("Objective", input.objective),
    section("Context", input.context),
    section("Deliverable", input.deliverable),
    section("Scope", input.scope),
    section("Done When", input.doneWhen)
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}
