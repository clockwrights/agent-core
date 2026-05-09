// ---------------------------------------------------------------------------
// Continuation Interface
//
// App-agnostic. No application-domain logic belongs here.
//
// This module provides:
//   1. createLlmContinuationHandler(llm, options?)
//      — Returns a ContinuationHandler that calls the LLM to resolve a
//        task intent against an AnalysisPackage.
//
//   2. createPassthroughContinuationHandler()
//      — Returns a ContinuationHandler that resolves the task without any
//        LLM by collecting all extracted fields directly from the package.
//        Useful as a test double and as a deterministic fallback.
//
// Callers plug whichever handler they need into the pipeline orchestrator.
// The document-pipeline core never decides which handler to use.
// ---------------------------------------------------------------------------

import type {
  AnalysisPackage,
  ContinuationEvidence,
  ContinuationHandler,
  ContinuationRequest,
  ContinuationResult,
  UnresolvedItem,
} from "./types.js";
import type { PipelineLlmAdapter } from "./llm.js";

// ---------------------------------------------------------------------------
// LLM continuation handler
// ---------------------------------------------------------------------------

export type LlmContinuationOptions = {
  /** Max tokens for the continuation LLM call. Defaults to 1024. */
  maxTokens?: number;
  /**
   * Session id prefix for the LLM call. A unique suffix is appended per
   * invocation to avoid context bleed between requests.
   */
  sessionIdPrefix?: string;
};

const CONTINUATION_SYSTEM_PROMPT = `\
You are a document task resolution assistant.
You receive a structured analysis of one or more documents (extracted fields, classification labels, confidence scores) and a task intent from the calling application.

Your job is to resolve the task intent using only the information present in the analysis package.
Do not invent, guess, or infer values not supported by the provided data.

Respond with a single JSON object matching this schema exactly. No explanation, no markdown fences.
{
  "results": {
    "<task-output-key>": "<resolved value or null>"
  },
  "evidence": [
    { "groupId": "<document group id>", "fieldName": "<field name from analysis>", "confidence": <0-1> }
  ],
  "unresolvedItems": [
    { "description": "<what could not be resolved>", "reason": "<why>" }
  ],
  "suggestedNextSteps": ["<optional follow-up suggestion>"]
}`;

/**
 * Build the user-turn prompt from the analysis package and task intent.
 * This is a pure function — it has no side effects and can be used in tests.
 */
export function buildContinuationPrompt(
  pkg: AnalysisPackage,
  taskIntent: string,
  appContext?: Record<string, unknown>,
): string {
  const lines: string[] = [];

  lines.push(`## Task intent\n${taskIntent}\n`);

  if (appContext && Object.keys(appContext).length > 0) {
    lines.push("## Application context");
    for (const [k, v] of Object.entries(appContext)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
    lines.push("");
  }

  lines.push("## Document analysis");
  if (pkg.fileRecords.length === 1) {
    const f = pkg.fileRecords[0]!;
    lines.push(`File: ${f.fileName}  (${f.sizeBytes} bytes, ${f.mimeType})`);
  } else {
    lines.push(`Submission contains ${pkg.fileRecords.length} files:`);
    for (const [i, f] of pkg.fileRecords.entries()) {
      lines.push(`  [${i}] ${f.fileName}  (${f.sizeBytes} bytes, ${f.mimeType})`);
    }
  }
  if (pkg.policyRef) {
    lines.push(`Policy: ${pkg.policyRef.name} v${pkg.policyRef.version}`);
  }
  lines.push("");

  for (const group of pkg.classifiedGroups) {
    lines.push(
      `### Group ${group.groupId}: ${group.label}` +
        (group.unsupported ? " [unsupported]" : "") +
        `  confidence: ${group.classificationConfidence.toFixed(2)}` +
        `  tier: ${group.classificationTier}`,
    );
    if (group.uncertaintyFlags.length > 0) {
      lines.push(`Uncertainty flags: ${group.uncertaintyFlags.join(", ")}`);
    }
    if (group.fields.length > 0) {
      lines.push("Extracted fields:");
      for (const field of group.fields) {
        lines.push(
          `  ${field.name}: ${field.value || "(empty)"}` +
            `  (confidence: ${field.confidence.toFixed(2)}, method: ${field.method})`,
        );
      }
    } else {
      lines.push("  No fields extracted.");
    }
    lines.push("");
  }

  lines.push("Resolve the task intent using only the fields above.");
  return lines.join("\n");
}

/**
 * Create a ContinuationHandler backed by the provided LLM adapter.
 *
 * The returned handler is a plain async function — it can be stored,
 * passed, tested, or replaced without any class hierarchy.
 */
export function createLlmContinuationHandler(
  llm: PipelineLlmAdapter,
  options: LlmContinuationOptions = {},
): ContinuationHandler {
  const { maxTokens = 1024, sessionIdPrefix = "doc-continuation" } = options;

  return async (request: ContinuationRequest): Promise<ContinuationResult> => {
    const { analysisPackage, taskIntent, appContext } = request;

    if (!llm.enabled) {
      return passthroughResult(analysisPackage, taskIntent, "llm-disabled");
    }

    const prompt = buildContinuationPrompt(analysisPackage, taskIntent, appContext);
    // Session id seed: first file's hash. Sufficient to scope context across
    // submissions; multi-file submissions still get a per-submission seed
    // because every entry has a distinct hash.
    const seedHash = analysisPackage.fileRecords[0]?.contentHash ?? "no-hash";
    const sessionId = `${sessionIdPrefix}-${seedHash.slice(0, 8)}`;

    let responseText: string | undefined;
    try {
      const output = await llm.generate({
        systemPrompt: CONTINUATION_SYSTEM_PROMPT,
        prompt,
        sessionId,
        maxTokens,
      });
      responseText = output?.text?.trim();
    } catch {
      return passthroughResult(analysisPackage, taskIntent, "llm-error");
    }

    if (!responseText) {
      return passthroughResult(analysisPackage, taskIntent, "llm-empty-response");
    }

    const parsed = parseContinuationResponse(responseText);
    if (!parsed) {
      return passthroughResult(analysisPackage, taskIntent, "llm-parse-error");
    }

    return parsed;
  };
}

// ---------------------------------------------------------------------------
// Passthrough (deterministic) continuation handler
// ---------------------------------------------------------------------------

/**
 * Create a ContinuationHandler that resolves the task without any LLM call.
 *
 * It flattens all extracted fields from the analysis package into the
 * `results` map, keyed by `fieldName` (with groupId prefix when there are
 * multiple groups to avoid collisions). All fields become evidence.
 *
 * Use this:
 *   - As a test double when you do not want live LLM calls.
 *   - When `executionMode === "deterministic-first"` and no LLM is configured.
 *   - As a fallback when the LLM handler fails.
 */
export function createPassthroughContinuationHandler(): ContinuationHandler {
  return async (request: ContinuationRequest): Promise<ContinuationResult> => {
    return passthroughResult(request.analysisPackage, request.taskIntent, undefined);
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function passthroughResult(
  pkg: AnalysisPackage,
  taskIntent: string,
  reason: string | undefined,
): ContinuationResult {
  const results: Record<string, unknown> = {};
  const evidence: ContinuationEvidence[] = [];
  const unresolvedItems: UnresolvedItem[] = [];
  const suggestedNextSteps: string[] = [];
  const multipleGroups = pkg.classifiedGroups.length > 1;

  for (const group of pkg.classifiedGroups) {
    if (group.unsupported) {
      unresolvedItems.push({
        description: `Group ${group.groupId}`,
        reason: "document type not supported by the active policy",
      });
      continue;
    }

    for (const field of group.fields) {
      const key = multipleGroups ? `${group.groupId}.${field.name}` : field.name;
      results[key] = field.value;
      evidence.push({
        groupId: group.groupId,
        fieldName: field.name,
        confidence: field.confidence,
      });
    }

    if (group.fields.length === 0) {
      unresolvedItems.push({
        description: `Group ${group.groupId} (${group.label})`,
        reason: "no fields were extracted",
      });
    }

    if (group.uncertaintyFlags.length > 0) {
      suggestedNextSteps.push(
        `Review group ${group.groupId} (${group.label}): ${group.uncertaintyFlags.join(", ")}`,
      );
    }
  }

  if (reason) {
    unresolvedItems.push({
      description: `Task intent: "${taskIntent}"`,
      reason,
    });
  }

  // Suggest manual review when no fields were resolved.
  if (Object.keys(results).length === 0 && unresolvedItems.length > 0) {
    suggestedNextSteps.push("Manual review required — no fields could be resolved automatically.");
  }

  return { results, evidence, unresolvedItems, suggestedNextSteps };
}

type RawContinuationResponse = {
  results?: Record<string, unknown>;
  evidence?: Array<{ groupId?: string; fieldName?: string; confidence?: number }>;
  unresolvedItems?: Array<{ description?: string; reason?: string }>;
  suggestedNextSteps?: string[];
};

function parseContinuationResponse(text: string): ContinuationResult | null {
  try {
    const json = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const raw = JSON.parse(json) as RawContinuationResponse;

    if (typeof raw !== "object" || raw === null) return null;

    const evidence: ContinuationEvidence[] = (raw.evidence ?? [])
      .filter(
        (e): e is { groupId: string; fieldName: string; confidence: number } =>
          typeof e.groupId === "string" &&
          typeof e.fieldName === "string",
      )
      .map((e) => ({
        groupId: e.groupId,
        fieldName: e.fieldName,
        confidence: Math.max(0, Math.min(1, e.confidence ?? 0)),
      }));

    const unresolvedItems: UnresolvedItem[] = (raw.unresolvedItems ?? [])
      .filter(
        (u): u is { description: string; reason: string } =>
          typeof u.description === "string" && typeof u.reason === "string",
      );

    return {
      results: raw.results ?? {},
      evidence,
      unresolvedItems,
      suggestedNextSteps: (raw.suggestedNextSteps ?? []).filter(
        (s): s is string => typeof s === "string",
      ),
    };
  } catch {
    return null;
  }
}
