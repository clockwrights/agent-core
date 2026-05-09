// ---------------------------------------------------------------------------
// Document Policy Loader and Injector (Stage 7 / pre-classification)
//
// Responsibilities:
//   1. DocumentPolicyRegistry — in-memory store for named, versioned policy
//      text blobs. Computes and verifies SHA-256 content hashes.
//   2. Prompt builders — inject the active policy into LLM classification
//      and extraction prompts so the model operates within the app-defined
//      document type taxonomy and field extraction rules.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  DocumentGroup,
  DocumentPolicy,
  DocumentUnit,
  UnitExtractionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Policy registry
// ---------------------------------------------------------------------------

export class DocumentPolicyRegistry {
  private readonly policies = new Map<string, DocumentPolicy>();

  /**
   * Register a new policy or replace an existing one with the same name.
   *
   * @param name     Unique policy name referenced in pipeline requests.
   * @param text     Natural language policy text authored by the app team.
   * @param version  Semantic version string. Defaults to "1.0.0".
   */
  register(name: string, text: string, version = "1.0.0"): DocumentPolicy {
    if (!name.trim()) throw new Error("Policy name must not be empty.");
    if (!text.trim()) throw new Error("Policy text must not be empty.");

    const policy: DocumentPolicy = {
      name,
      version,
      contentHash: hashText(text),
      policyText: text,
    };
    this.policies.set(name, policy);
    return policy;
  }

  /**
   * Retrieve a policy by name. Returns `undefined` when not found (open-vocabulary
   * mode — the caller should treat absence as "no policy restrictions apply").
   */
  get(name: string): DocumentPolicy | undefined {
    return this.policies.get(name);
  }

  /** List all registered policy names and their current versions. */
  list(): Array<{ name: string; version: string; contentHash: string }> {
    return [...this.policies.values()].map(({ name, version, contentHash }) => ({
      name,
      version,
      contentHash,
    }));
  }

  /** Remove a policy by name. No-op when the name is not registered. */
  remove(name: string): void {
    this.policies.delete(name);
  }

  /** Number of registered policies. */
  get size(): number {
    return this.policies.size;
  }
}

/** SHA-256 hex digest of a UTF-8 string. */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Module-level singleton registry — use for the server's default registry.
// Tests or multi-tenant scenarios should create their own registry instances.
// ---------------------------------------------------------------------------

export const defaultPolicyRegistry = new DocumentPolicyRegistry();

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Classification + field extraction prompt pair.
 * Pass both strings to the LLM: systemPrompt as the system message,
 * userPrompt as the user turn.
 */
export type ClassificationPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

const CLASSIFICATION_OUTPUT_SCHEMA = `\
Respond with a single JSON object. Do not include any explanation or markdown fences.
Schema:
{
  "label": "<document type label, e.g. passport, national-id, utility-bill, unknown>",
  "confidence": <0-1>,
  "unsupported": <true when the document type is not listed in the policy, false otherwise>,
  "fields": [
    {
      "name": "<field name>",
      "value": "<extracted value, empty string if not found>",
      "confidence": <0-1>,
      "sourceUnitIndex": <1-based page/unit number where this field was found>
    }
  ],
  "uncertaintyFlags": ["<flag>"]
}`;

const OPEN_VOCABULARY_GUIDANCE = `\
No document policy is active. Operate in open-vocabulary mode:
- Classify the document using your best judgement of the document type.
- Extract whatever fields are visible and useful (document number, name, date, issuing authority, etc.).
- Set "unsupported" to false for all documents.
- Set "uncertaintyFlags" when confidence is low or fields are ambiguous.`;

/**
 * Build the classification + extraction prompt pair for a single document group.
 *
 * @param policy         Active policy, or `undefined` for open-vocabulary mode.
 * @param group          The document group being classified.
 * @param units          All units in the pipeline (used for ordering context).
 * @param extractions    All unit extraction results (provides text content).
 * @param context        Optional pipeline context (language, country, intent).
 */
export function buildClassificationPrompt(
  policy: DocumentPolicy | undefined,
  group: DocumentGroup,
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
  context?: { language?: string; country?: string; submissionIntent?: string },
): ClassificationPrompt {
  const systemPrompt = buildSystemPrompt(policy);
  const userPrompt = buildUserPrompt(group, units, extractions, context);
  return { systemPrompt, userPrompt };
}

function buildSystemPrompt(policy: DocumentPolicy | undefined): string {
  const parts: string[] = [
    "You are a document classification and field extraction assistant.",
    "Your task is to identify the type of the document and extract the fields specified in the policy.",
    "",
  ];

  if (policy) {
    parts.push(
      "## Document Policy",
      `Name: ${policy.name}  Version: ${policy.version}`,
      "",
      policy.policyText.trim(),
      "",
      "Apply the policy strictly:",
      "- Only recognise document types explicitly listed in the policy.",
      '- For document types not listed, set "unsupported": true and skip field extraction.',
      "- Follow the per-type extraction rules exactly as written.",
      "- Apply all quality and validation expectations from the policy.",
      "",
    );
  } else {
    parts.push(OPEN_VOCABULARY_GUIDANCE, "");
  }

  parts.push("## Output format", CLASSIFICATION_OUTPUT_SCHEMA);

  return parts.join("\n");
}

function buildUserPrompt(
  group: DocumentGroup,
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
  context?: { language?: string; country?: string; submissionIntent?: string },
): string {
  const parts: string[] = [];

  // Optional context block.
  if (context) {
    const ctx: string[] = [];
    if (context.language) ctx.push(`Language: ${context.language}`);
    if (context.country) ctx.push(`Country: ${context.country}`);
    if (context.submissionIntent) ctx.push(`Submission intent: ${context.submissionIntent}`);
    if (ctx.length > 0) {
      parts.push("## Context", ctx.join("  "), "");
    }
  }

  parts.push(`## Document content (group: ${group.id})`);

  const unitMap = new Map(units.map((u) => [u.index, u]));
  const extractionMap = new Map(extractions.map((e) => [e.unitIndex, e]));

  for (const idx of group.unitIndices) {
    const unit = unitMap.get(idx);
    const extraction = extractionMap.get(idx);
    const kind = unit?.kind ?? "unknown";
    const text = (extraction?.text ?? "").trim();
    const hasImage = (extraction?.images.length ?? 0) > 0;

    parts.push(`### Page/unit ${idx} (${kind})`);

    if (text) {
      // Cap at 3 000 chars per unit to stay within token budget while preserving
      // MRZ lines and most text content for typical documents.
      const snippet = text.length > 3_000 ? text.slice(0, 3_000) + "\n[...truncated]" : text;
      parts.push(snippet);
    } else if (hasImage) {
      parts.push("[Image content — text extraction was not available for this unit]");
    } else {
      parts.push("[No extractable content]");
    }

    parts.push("");
  }

  parts.push("Classify this document and extract fields as instructed.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Extraction prompt for a single field (used by tier-c multimodal path)
// ---------------------------------------------------------------------------

/**
 * Builds a focused extraction prompt for a single field when the text-based
 * classifier returned low confidence. The caller is expected to attach the
 * rendered page image(s) alongside this prompt in a multimodal LLM request.
 */
export function buildFieldExtractionPrompt(
  fieldName: string,
  documentLabel: string,
  policy: DocumentPolicy | undefined,
): string {
  const policyHint = policy
    ? `\nApply the extraction rules from policy "${policy.name}" for document type "${documentLabel}".\n`
    : "";
  return (
    `Extract the value of the field "${fieldName}" from the document image.` +
    policyHint +
    `Return ONLY a JSON object: { "value": "<extracted value or empty string>", "confidence": <0-1> }.` +
    ` No explanation, no markdown.`
  );
}
