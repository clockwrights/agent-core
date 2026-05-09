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
