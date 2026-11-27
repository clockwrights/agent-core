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
import type { PipelineDocument, PipelineLlmAdapter } from "./llm.js";
import { attachFieldCitations } from "./citations.js";

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
  /**
   * Source files Tier C may attach natively (today: PDFs). Used only when the
   * Tier C adapter sets `supportsDocuments`, and only for groups whose units
   * all come from one listed file; other groups keep the rendered-image path.
   * `runDocumentPipeline` fills this when `deps.nativePdf` is set.
   */
  sourceDocuments?: ClassificationSourceDocument[];
  /**
   * Ask for a verbatim quote per field and verify it (`ExtractedField.citations`).
   * Default false: prompts and output unchanged.
   */
  fieldCitations?: boolean;
};

export type ClassificationSourceDocument = {
  /** Index into the submission's file records (matches `DocumentUnit.sourceFileIndex`). */
  sourceFileIndex: number;
  /** Base64-encoded file bytes. */
  data: string;
  mimeType: string;
  name?: string;
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

/** Quote the classifier collected for each field (Tier A line, or the model's `quote`). */
const fieldQuotes = new WeakMap<ExtractedField, string>();

async function classifyGroup(
  group: DocumentGroup,
  request: ClassificationRequest,
): Promise<ClassifiedDocumentGroup> {
  const result = await classifyGroupTiers(group, request);
  if (!request.fieldCitations) return result;
  return attachFieldCitations(result, fieldQuotes, {
    group,
    units: request.units,
    extractions: request.extractions,
  });
}

async function classifyGroupTiers(
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

    if (hasImages || nativeDocumentFor(group, request, tierCAdapter!)) {
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
 * (TD1 = 30, TD2 = 36, TD3/passport = 44 chars per line).
 * Segmentation uses a looser ≥ 20 boundary hint (`segment.ts`); see there.
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
        fields.push(mrzField("surname", surname.replace(/<+/g, " ").trim(), group.unitIndices[0], trimmed));
      }
      if (givenRaw) {
        const givenName = givenRaw.replace(/<+$/, "").replace(/<+/g, " ").trim();
        if (givenName) {
          fields.push(mrzField("given_names", givenName, group.unitIndices[0], trimmed));
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
        fields.push(mrzField("document_number", docNumber, group.unitIndices[0], trimmed));
      }
      // Nationality: positions 10–12
      const nationality = trimmed.slice(10, 13).replace(/<+$/, "");
      if (nationality && nationality !== "<<<") {
        fields.push(mrzField("nationality", nationality, group.unitIndices[0], trimmed));
      }
      // Date of birth: positions 13–18 (YYMMDD)
      const dob = trimmed.slice(13, 19);
      if (/^\d{6}$/.test(dob)) {
        fields.push(mrzField("date_of_birth", formatMrzDate(dob, "birth"), group.unitIndices[0], trimmed));
      }
      // Expiry: positions 21–26
      const expiry = trimmed.slice(21, 27);
      if (/^\d{6}$/.test(expiry)) {
        fields.push(mrzField("expiry_date", formatMrzDate(expiry, "expiry"), group.unitIndices[0], trimmed));
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

function mrzField(name: string, value: string, sourceUnitIndex: number, line: string): ExtractedField {
  const field: ExtractedField = { name, value, confidence: 0.88, sourceUnitIndex, method: "deterministic" };
  // The MRZ line is the field's evidence (used with `fieldCitations`).
  fieldQuotes.set(field, line);
  return field;
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
    /** Verbatim evidence, requested with `fieldCitations`. */
    quote?: string;
  }>;
  uncertaintyFlags: string[];
};

/** Map a parsed field to an `ExtractedField`, remembering its quote. */
function toExtractedField(
  f: LlmClassificationResponse["fields"][number],
  group: DocumentGroup,
  method: string,
): ExtractedField {
  const field: ExtractedField = {
    name: f.name,
    value: f.value,
    confidence: clamp(f.confidence ?? 0),
    sourceUnitIndex: f.sourceUnitIndex ?? group.unitIndices[0] ?? 1,
    method,
  };
  if (typeof f.quote === "string") fieldQuotes.set(field, f.quote);
  return field;
}

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
    { fieldCitations: request.fieldCitations === true },
  );

  let responseText: string | undefined;
  try {
    const output = await request.llmProvider.generate({
      systemPrompt,
      prompt: userPrompt,
      sessionId: `doc-classify-${group.id}`,
      // Quotes need room in the answer.
      maxTokens: request.fieldCitations ? 2048 : 1024,
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
    fields: (parsed.fields ?? []).map((f) => toExtractedField(f, group, "llm-text")),
    uncertaintyFlags: parsed.uncertaintyFlags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tier C — Multimodal LLM
// ---------------------------------------------------------------------------

/**
 * The native document Tier C may attach for this group, or null. Requires an
 * adapter with `supportsDocuments`, and every unit of the group coming from
 * one file listed in `request.sourceDocuments`. `pageHint` names the group's
 * pages within that file ("page 2", "pages 1-3", "pages 1, 3").
 */
function nativeDocumentFor(
  group: DocumentGroup,
  request: ClassificationRequest,
  adapter: PipelineLlmAdapter,
): { document: PipelineDocument; pageHint: string } | null {
  if (!adapter.supportsDocuments || !request.sourceDocuments?.length) return null;
  const groupUnits = group.unitIndices
    .map((idx) => request.units.find((u) => u.index === idx))
    .filter((u): u is DocumentUnit => u !== undefined);
  if (groupUnits.length === 0) return null;
  const fileIndex = groupUnits[0]!.sourceFileIndex;
  if (groupUnits.some((u) => u.sourceFileIndex !== fileIndex)) return null;
  const source = request.sourceDocuments.find((d) => d.sourceFileIndex === fileIndex);
  if (!source) return null;

  // Page numbers within the file: position among that file's units, 1-based.
  const fileUnitIndices = request.units
    .filter((u) => u.sourceFileIndex === fileIndex)
    .map((u) => u.index)
    .sort((a, b) => a - b);
  const pages = groupUnits
    .map((u) => fileUnitIndices.indexOf(u.index) + 1)
    .sort((a, b) => a - b);
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1]! + 1);
  const pageHint =
    pages.length === 1
      ? `page ${pages[0]}`
      : contiguous
        ? `pages ${pages[0]}-${pages[pages.length - 1]}`
        : `pages ${pages.join(", ")}`;

  const document: PipelineDocument = { data: source.data, mimeType: source.mimeType };
  if (source.name !== undefined) document.name = source.name;
  return { document, pageHint };
}

async function runTierC(
  group: DocumentGroup,
  tierBResult: ClassifiedDocumentGroup | null,
  request: ClassificationRequest,
  adapter: PipelineLlmAdapter,
): Promise<ClassifiedDocumentGroup | null> {

  // Native PDF (opt-in) replaces the rendered images for the group's source
  // file; otherwise collect all rendered images for this group.
  const native = nativeDocumentFor(group, request, adapter);
  const images: Array<{ data: string; mimeType: string }> = [];
  if (!native) {
    for (const idx of group.unitIndices) {
      const ex = request.extractions.find((e) => e.unitIndex === idx);
      for (const img of ex?.images ?? []) {
        images.push({ data: img.data, mimeType: img.mimeType });
      }
    }
    if (images.length === 0) return null;
  }

  // Build a classification prompt that references the attachments.
  const { systemPrompt, userPrompt } = buildClassificationPrompt(
    request.policy,
    group,
    request.units,
    request.extractions,
    request.context,
    { fieldCitations: request.fieldCitations === true },
  );

  const attachmentHint = native
    ? `\n\nThe PDF attached to this message is the source file for this document group; ` +
      `the group covers ${native.pageHint} of it. Use it alongside the text content above to ` +
      `improve classification and field extraction accuracy.`
    : `\n\nThe ${images.length} page image(s) attached to this message are the rendered ` +
      `pages for this document group. Use them alongside the text content above to improve ` +
      `classification and field extraction accuracy.`;

  let responseText: string | undefined;
  try {
    const output = await adapter.generate({
      systemPrompt,
      prompt: userPrompt + attachmentHint,
      sessionId: `doc-classify-multimodal-${group.id}`,
      maxTokens: 1500,
      // Real multimodal call: the adapter forwards images as image content
      // parts, or the source PDF as a document part.
      ...(native ? { documents: [native.document] } : { images }),
    });
    responseText = output?.text?.trim();
  } catch {
    return null;
  }

  if (!responseText) return null;

  const parsed = parseLlmClassificationResponse(responseText);
  if (!parsed) return null;

  // For low-confidence fields, run focused per-field extraction prompts.
  const fields: ExtractedField[] = (parsed.fields ?? []).map((f) => toExtractedField(f, group, "llm-multimodal"));

  const lowConfFields = fields.filter((f) => f.confidence < 0.5);
  for (const field of lowConfFields) {
    const refinedValue = await refineFieldWithImage(
      field.name,
      parsed.label,
      native ? { document: native.document, pageHint: native.pageHint } : { image: images[0]! },
      request,
      adapter,
    );
    if (refinedValue !== null && refinedValue.value) {
      field.value = refinedValue.value;
      field.confidence = clamp(refinedValue.confidence);
      field.method = "llm-multimodal";
      if (refinedValue.quote !== undefined) fieldQuotes.set(field, refinedValue.quote);
      else fieldQuotes.delete(field);
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
  attachment:
    | { image: { data: string; mimeType: string } }
    | { document: PipelineDocument; pageHint: string },
  request: ClassificationRequest,
  adapter: PipelineLlmAdapter,
): Promise<{ value: string; confidence: number; quote?: string } | null> {
  const prompt = buildFieldExtractionPrompt(fieldName, documentLabel, request.policy, {
    fieldCitations: request.fieldCitations === true,
  });
  const isDocument = "document" in attachment;

  let responseText: string | undefined;
  try {
    const output = await adapter.generate({
      systemPrompt: isDocument
        ? `You are a document field extraction assistant. Extract exactly the field requested from ${attachment.pageHint} of the attached PDF.`
        : "You are a document field extraction assistant. Extract exactly the field requested from the image.",
      prompt,
      sessionId: `doc-field-${fieldName}-${documentLabel}`,
      maxTokens: 128,
      // The attachment must travel as a real content part, not just be referenced in text.
      ...(isDocument ? { documents: [attachment.document] } : { images: [attachment.image] }),
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
    const parsed = JSON.parse(json) as { value?: string; confidence?: number; quote?: string };
    if (typeof parsed.value === "string") {
      const refined: { value: string; confidence: number; quote?: string } = {
        value: parsed.value,
        confidence: clamp(parsed.confidence ?? 0.5),
      };
      if (typeof parsed.quote === "string") refined.quote = parsed.quote;
      return refined;
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
