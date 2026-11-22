// ---------------------------------------------------------------------------
// Classification and Field Extraction (Stage 5)
//
// Classifies each DocumentGroup and extracts fields using a three-tier strategy:
//
//   Tier A — Deterministic
//     MRZ pattern detection, known layout signatures. No LLM.
//     Fast, cheap, auditable.
//
//   Tier B — LLM text-based
//     Passes extracted text + document policy to the LLM.
//     Used when Tier A produces no result or confidence is below threshold.
//
//   Tier C — Multimodal LLM
//     Attaches rendered page images alongside text.
//     Used when Tier B confidence is too low, images are available, and
//     executionMode is not capped at Tier B.
//
// Each result records which tier was used, the confidence, and the method
// for every individual extracted field.
// ---------------------------------------------------------------------------

import type {
  ClassificationTier,
  ClassifiedDocumentGroup,
  DocumentGroup,
  DocumentPipelineContext,
  DocumentPipelineExecutionMode,
  DocumentPolicy,
  DocumentUnit,
  ExtractedField,
  UnitExtractionResult,
} from "./types.js";
import {
  buildClassificationPrompt,
  buildFieldExtractionPrompt,
} from "./policy.js";
import type { PipelineLlmAdapter } from "./llm.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ClassificationRequest = {
  groups: DocumentGroup[];
  units: DocumentUnit[];
  extractions: UnitExtractionResult[];
  policy?: DocumentPolicy;
  context?: DocumentPipelineContext;
  executionMode?: DocumentPipelineExecutionMode;
  llmProvider?: PipelineLlmAdapter;
  /**
   * Optional Tier-C-specific adapter. When set, multimodal calls go through
   * this adapter; Tier B continues to use `llmProvider`. Falls back to
   * `llmProvider` when undefined.
   */
  tierCAdapter?: PipelineLlmAdapter;
  /**
   * Minimum tier-A confidence required to skip Tier B.
   * Defaults to TIER_A_CONFIDENCE_THRESHOLD.
   */
  tierAThreshold?: number;
  /**
   * Minimum tier-B confidence required to skip Tier C.
   * Defaults to TIER_B_CONFIDENCE_THRESHOLD.
   */
  tierBThreshold?: number;
  /**
   * Lowest tier the classifier may attempt. Tiers below this are skipped.
   * Defaults to "tier-a" (full cascade).
   */
  minTier?: ClassificationTier;
};

const TIER_A_CONFIDENCE_THRESHOLD = 0.8;
const TIER_B_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Classify every DocumentGroup and extract fields according to the active policy.
 * Returns one ClassifiedDocumentGroup per input group in the same order.
 */
export async function classifyGroups(
  request: ClassificationRequest,
): Promise<ClassifiedDocumentGroup[]> {
  const results: ClassifiedDocumentGroup[] = [];
  for (const group of request.groups) {
    results.push(await classifyGroup(group, request));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Per-group classification
// ---------------------------------------------------------------------------

async function classifyGroup(
  group: DocumentGroup,
  request: ClassificationRequest,
): Promise<ClassifiedDocumentGroup> {
  const tierAThreshold = request.tierAThreshold ?? TIER_A_CONFIDENCE_THRESHOLD;
  const tierBThreshold = request.tierBThreshold ?? TIER_B_CONFIDENCE_THRESHOLD;
  const executionMode = request.executionMode ?? "hybrid";
  const minTier: ClassificationTier = request.minTier ?? "tier-a";

  // Which tiers are eligible to run, given minTier and executionMode?
  const allowTierA = minTier === "tier-a";
  const allowTierB =
    (minTier === "tier-a" || minTier === "tier-b") &&
    executionMode !== "deterministic-first" &&
    Boolean(request.llmProvider);
  const tierCAdapter = request.tierCAdapter ?? request.llmProvider;
  const allowTierC =
    (executionMode === "hybrid" || executionMode === "full-multimodal") &&
    Boolean(tierCAdapter);

  // ------------------------------------------------------------------
  // Tier A — deterministic
  // ------------------------------------------------------------------
  let tierA: ClassifiedDocumentGroup | null = null;
  if (allowTierA) {
    tierA = runTierA(group, request.units, request.extractions);
    if (tierA && tierA.classificationConfidence >= tierAThreshold) {
      return tierA;
    }
  }

  // ------------------------------------------------------------------
  // Tier B — LLM text
  // ------------------------------------------------------------------
  let tierB: ClassifiedDocumentGroup | null = null;
  if (allowTierB) {
    tierB = await runTierB(group, request);
    if (tierB && tierB.classificationConfidence >= tierBThreshold) {
      return tierB;
    }
  }

  // ------------------------------------------------------------------
  // Tier C — multimodal LLM (only when images exist and mode allows)
  // ------------------------------------------------------------------
  if (allowTierC) {
    const hasImages = group.unitIndices.some((idx) => {
      const ex = request.extractions.find((e) => e.unitIndex === idx);
      return (ex?.images.length ?? 0) > 0;
    });

    if (hasImages) {
      const tierC = await runTierC(group, tierB, request, tierCAdapter!);
      if (tierC) return tierC;
    }
  }

  // Return tier-B result even if below threshold (best we have).
  if (tierB) return tierB;

  // ------------------------------------------------------------------
  // Fallback: return tier-A partial result or an unknown group.
  // The "unknown" path also covers cases where minTier blocked every
  // tier from running (e.g. minTier="tier-c" with no images).
  // ------------------------------------------------------------------
  return (
    tierA ?? {
      groupId: group.id,
      label: "unknown",
      unsupported: true,
      classificationTier: minTier,
      classificationConfidence: 0,
      fields: [],
      uncertaintyFlags: ["no-classifier-result"],
    }
  );
}

// ---------------------------------------------------------------------------
// Tier A — Deterministic
// ---------------------------------------------------------------------------

/**
 * Checks the extracted text for Machine-Readable Zone lines, then checks
 * for known barcode / separator anchors.
 *
 * MRZ line: at least 30 consecutive chars matching [A-Z0-9<]
 * (TD1 = 30, TD2 = 36, TD3/passport = 44 chars per line)
 */
const MRZ_LINE_RE = /^[A-Z][A-Z0-9<]{29,}$/m;

/** Barcode-type anchor: CODE128, QR, PDF417 refs in OCR output */
const BARCODE_ANCHOR_RE = /\b(CODE128|CODE39|PDF417|QRCODE|DATAMATRIX)\b/i;

type TierAResult = {
  label: string;
  confidence: number;
  fields: ExtractedField[];
  uncertaintyFlags: string[];
};

function runTierA(
  group: DocumentGroup,
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
): ClassifiedDocumentGroup | null {
  const unitMap = new Map(units.map((u) => [u.index, u]));
  const extractionMap = new Map(extractions.map((e) => [e.unitIndex, e]));

  const allText = group.unitIndices
    .map((idx) => extractionMap.get(idx)?.text ?? "")
    .join("\n");

  const result = detectMrz(allText, group, extractionMap) ??
    detectBarcode(allText, group) ??
    null;

  if (!result) return null;

  return {
    groupId: group.id,
    label: result.label,
    unsupported: false,
    classificationTier: "tier-a",
    classificationConfidence: result.confidence,
    fields: result.fields,
    uncertaintyFlags: result.uncertaintyFlags,
  };
}

function detectMrz(
  text: string,
  group: DocumentGroup,
  extractionMap: Map<number, UnitExtractionResult>,
): TierAResult | null {
  if (!MRZ_LINE_RE.test(text)) return null;

  const lines = text.split(/\n/).filter((l) => MRZ_LINE_RE.test(l.trim()));

  // Try to determine passport vs ID card by MRZ line length.
  const maxLen = Math.max(...lines.map((l) => l.trim().length));
  const label = maxLen >= 44 ? "passport" : "national-id";

  const fields: ExtractedField[] = [];
  const uncertaintyFlags: string[] = [];

  // Extract surname/given-name from the first MRZ line of a TD3 passport (44 chars).
  // Field format: P<COUNTRYNAMES<<GIVENNAMES<<<...
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 44 && trimmed.startsWith("P<")) {
      const nameSection = trimmed.slice(5, 44); // after P<CCC
      const [surname, givenRaw] = nameSection.split("<<");
      if (surname) {
        fields.push(mrzField("surname", surname.replace(/<+/g, " ").trim(), group.unitIndices[0]));
      }
      if (givenRaw) {
        const givenName = givenRaw.replace(/<+$/, "").replace(/<+/g, " ").trim();
        if (givenName) {
          fields.push(mrzField("given_names", givenName, group.unitIndices[0]));
        }
      }
      break;
    }
  }

  // Extract document number from TD3 line 2 (positions 0-8).
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 44 && !/^P</.test(trimmed)) {
      const docNumber = trimmed.slice(0, 9).replace(/<+$/, "");
      if (docNumber) {
        fields.push(mrzField("document_number", docNumber, group.unitIndices[0]));
      }
      // Nationality: positions 10–12
      const nationality = trimmed.slice(10, 13).replace(/<+$/, "");
      if (nationality && nationality !== "<<<") {
        fields.push(mrzField("nationality", nationality, group.unitIndices[0]));
      }
      // Date of birth: positions 13–18 (YYMMDD)
      const dob = trimmed.slice(13, 19);
      if (/^\d{6}$/.test(dob)) {
        fields.push(mrzField("date_of_birth", formatMrzDate(dob, "birth"), group.unitIndices[0]));
      }
      // Expiry: positions 21–26
      const expiry = trimmed.slice(21, 27);
      if (/^\d{6}$/.test(expiry)) {
        fields.push(mrzField("expiry_date", formatMrzDate(expiry, "expiry"), group.unitIndices[0]));
      }
      break;
    }
  }

  if (fields.length === 0) {
    uncertaintyFlags.push("mrz-no-fields-parsed");
  }

  return { label, confidence: 0.88, fields, uncertaintyFlags };
}

function detectBarcode(text: string, group: DocumentGroup): TierAResult | null {
  if (!BARCODE_ANCHOR_RE.test(text)) return null;
  return {
    label: "barcode-document",
    confidence: 0.7,
    fields: [],
    uncertaintyFlags: ["barcode-detected-no-type-resolved"],
  };
}

function mrzField(name: string, value: string, sourceUnitIndex: number): ExtractedField {
  return { name, value, confidence: 0.88, sourceUnitIndex, method: "deterministic" };
}

/**
 * Expand an MRZ YYMMDD date to YYYY-MM-DD. MRZ dates carry no century, so
 * it is inferred from the field and the current year:
 * - birth date: 20YY unless that is in the future, else 19YY;
 * - expiry date: 20YY unless that is more than 50 years ahead, else 19YY
 *   (documents expiring from 2030 on stay in the 2000s; long-expired ones
 *   from the 1990s stay in the 1900s).
 */
function formatMrzDate(yymmdd: string, kind: "birth" | "expiry", now: Date = new Date()): string {
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const currentYear = now.getUTCFullYear();
  const in2000s = 2000 + yy;
  const year =
    kind === "birth"
      ? in2000s > currentYear
        ? 1900 + yy
        : in2000s
      : in2000s > currentYear + 50
        ? 1900 + yy
        : in2000s;
  return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

// ---------------------------------------------------------------------------
// Tier B — LLM text
// ---------------------------------------------------------------------------

type LlmClassificationResponse = {
  label: string;
  confidence: number;
  unsupported: boolean;
  fields: Array<{
    name: string;
    value: string;
    confidence: number;
    sourceUnitIndex: number;
  }>;
  uncertaintyFlags: string[];
};

async function runTierB(
  group: DocumentGroup,
  request: ClassificationRequest,
): Promise<ClassifiedDocumentGroup | null> {
  if (!request.llmProvider) return null;

  const { systemPrompt, userPrompt } = buildClassificationPrompt(
    request.policy,
    group,
    request.units,
    request.extractions,
    request.context,
  );

  let responseText: string | undefined;
  try {
    const output = await request.llmProvider.generate({
      systemPrompt,
      prompt: userPrompt,
      sessionId: `doc-classify-${group.id}`,
      maxTokens: 1024,
    });
    responseText = output?.text?.trim();
  } catch {
    return null;
  }

  if (!responseText) return null;

  const parsed = parseLlmClassificationResponse(responseText);
  if (!parsed) return null;

  return {
    groupId: group.id,
    label: parsed.label || "unknown",
    unsupported: parsed.unsupported ?? false,
    classificationTier: "tier-b",
    classificationConfidence: clamp(parsed.confidence ?? 0),
    fields: (parsed.fields ?? []).map((f) => ({
      name: f.name,
      value: f.value,
      confidence: clamp(f.confidence ?? 0),
      sourceUnitIndex: f.sourceUnitIndex ?? group.unitIndices[0] ?? 1,
      method: "llm-text",
    })),
    uncertaintyFlags: parsed.uncertaintyFlags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tier C — Multimodal LLM
// ---------------------------------------------------------------------------

async function runTierC(
  group: DocumentGroup,
  tierBResult: ClassifiedDocumentGroup | null,
  request: ClassificationRequest,
  adapter: PipelineLlmAdapter,
): Promise<ClassifiedDocumentGroup | null> {

  // Collect all rendered images for this group.
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const idx of group.unitIndices) {
    const ex = request.extractions.find((e) => e.unitIndex === idx);
    for (const img of ex?.images ?? []) {
      images.push({ data: img.data, mimeType: img.mimeType });
    }
  }
  if (images.length === 0) return null;

  // Build a classification prompt that references the attached images.
  const { systemPrompt, userPrompt } = buildClassificationPrompt(
    request.policy,
    group,
    request.units,
    request.extractions,
    request.context,
  );

  const imageHint =
    `\n\nThe ${images.length} page image(s) attached to this message are the rendered ` +
    `pages for this document group. Use them alongside the text content above to improve ` +
    `classification and field extraction accuracy.`;

  let responseText: string | undefined;
  try {
    const output = await adapter.generate({
      systemPrompt,
      prompt: userPrompt + imageHint,
      sessionId: `doc-classify-multimodal-${group.id}`,
      maxTokens: 1500,
      // Real multimodal call: the adapter forwards images as image content parts.
      images,
    });
    responseText = output?.text?.trim();
  } catch {
    return null;
  }

  if (!responseText) return null;

  const parsed = parseLlmClassificationResponse(responseText);
  if (!parsed) return null;

  // For low-confidence fields, run focused per-field extraction prompts.
  const fields: ExtractedField[] = (parsed.fields ?? []).map((f) => ({
    name: f.name,
    value: f.value,
    confidence: clamp(f.confidence ?? 0),
    sourceUnitIndex: f.sourceUnitIndex ?? group.unitIndices[0] ?? 1,
    method: "llm-multimodal",
  }));

  const lowConfFields = fields.filter((f) => f.confidence < 0.5);
  for (const field of lowConfFields) {
    const refinedValue = await refineFieldWithImage(
      field.name,
      parsed.label,
      images[0],
      request,
      adapter,
    );
    if (refinedValue !== null && refinedValue.value) {
      field.value = refinedValue.value;
      field.confidence = clamp(refinedValue.confidence);
      field.method = "llm-multimodal";
    }
  }

  return {
    groupId: group.id,
    label: parsed.label || tierBResult?.label || "unknown",
    unsupported: parsed.unsupported ?? tierBResult?.unsupported ?? false,
    classificationTier: "tier-c",
    classificationConfidence: clamp(parsed.confidence ?? 0),
    fields,
    uncertaintyFlags: [
      ...(parsed.uncertaintyFlags ?? []),
      ...(tierBResult?.uncertaintyFlags ?? []).filter((f) => f !== "low-confidence"),
    ],
  };
}

async function refineFieldWithImage(
  fieldName: string,
  documentLabel: string,
  image: { data: string; mimeType: string },
  request: ClassificationRequest,
  adapter: PipelineLlmAdapter,
): Promise<{ value: string; confidence: number } | null> {
  const prompt = buildFieldExtractionPrompt(fieldName, documentLabel, request.policy);

  let responseText: string | undefined;
  try {
    const output = await adapter.generate({
      systemPrompt:
        "You are a document field extraction assistant. Extract exactly the field requested from the image.",
      prompt,
      sessionId: `doc-field-${fieldName}-${documentLabel}`,
      maxTokens: 128,
      // The image must travel as a real attachment, not just be referenced in text.
      images: [image],
    });
    responseText = output?.text?.trim();
  } catch {
    return null;
  }

  if (!responseText) return null;

  try {
    const json = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(json) as { value?: string; confidence?: number };
    if (typeof parsed.value === "string") {
      return { value: parsed.value, confidence: clamp(parsed.confidence ?? 0.5) };
    }
  } catch {
    // parse failure — return null
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLlmClassificationResponse(
  text: string,
): LlmClassificationResponse | null {
  try {
    const json = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const obj = JSON.parse(json) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as LlmClassificationResponse;
  } catch {
    return null;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
