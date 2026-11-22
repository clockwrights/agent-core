// ---------------------------------------------------------------------------
// Segmentation Engine (Stage 4)
//
// Splits a set of extracted document units into DocumentGroups. Three
// strategies are tried in order:
//
//   1. Single-group fast path  — when only one unit is present.
//   2. Structural detection    — deterministic: MRZ lines, form-feed
//                                characters, separator lines, blank units.
//   3. LLM-assisted fallback   — the LLM decides boundaries when structural
//                                signals are absent or ambiguous.
//
// If none of the above produces multiple groups (i.e. no boundary is found),
// the entire submission is returned as a single group.
// ---------------------------------------------------------------------------

import type {
  DocumentGroup,
  DocumentPipelineContext,
  DocumentPipelineExecutionMode,
  DocumentPolicy,
  DocumentUnit,
  SegmentationMap,
  SegmentationMethod,
  UnitExtractionResult,
} from "./types.js";
import type { PipelineLlmAdapter } from "./llm.js";

/**
 * Confidence reported when a multi-unit submission is returned as one group
 * only because no boundary could be determined (no structural signal, and
 * the LLM fallback was disabled, unavailable or failed). It is an
 * "undecided" value, below typical review thresholds, so callers can route
 * such submissions to review. A single-unit submission is certain and
 * reports 1.0.
 */
export const UNSEGMENTED_FALLBACK_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Public request type and entry point
// ---------------------------------------------------------------------------

export type SegmentationRequest = {
  units: DocumentUnit[];
  extractions: UnitExtractionResult[];
  /** Active policy, forwarded to the LLM prompt for context. Optional. */
  policy?: DocumentPolicy;
  /** Pipeline context (language, country, submission intent). Optional. */
  context?: DocumentPipelineContext;
  /** Controls whether LLM fallback is allowed. Defaults to "hybrid". */
  executionMode?: DocumentPipelineExecutionMode;
  /** LLM provider injected by the pipeline orchestrator. Required for LLM fallback. */
  llmProvider?: PipelineLlmAdapter;
};

/**
 * Segment a set of document units into logical document groups.
 *
 * Returns a SegmentationMap with one or more DocumentGroups. Every unit
 * index in `request.units` will appear in exactly one group.
 */
export async function segmentDocuments(
  request: SegmentationRequest,
): Promise<SegmentationMap> {
  const { units, extractions, executionMode = "hybrid" } = request;

  // Single-unit fast path — no segmentation needed.
  if (units.length <= 1) {
    return singleGroupMap(units, 1.0);
  }

  // Structural (deterministic) detection — always attempted.
  const structural = detectStructuralBoundaries(units, extractions);
  if (structural !== null) {
    return structural;
  }

  // LLM-assisted fallback — skipped when caller requires deterministic-only.
  if (executionMode !== "deterministic-first" && request.llmProvider) {
    const llmResult = await llmAssistedSegmentation(request);
    if (llmResult !== null) return llmResult;
  }

  // Final fallback: treat the entire submission as one document. Nothing
  // confirmed that, so report it as undecided rather than certain.
  return singleGroupMap(units, UNSEGMENTED_FALLBACK_CONFIDENCE);
}

// ---------------------------------------------------------------------------
// Structural detection
// ---------------------------------------------------------------------------

/**
 * A Machine-Readable Zone line contains ≥ 20 consecutive uppercase letters,
 * digits, and '<' fill characters. Handles TD1 (30 chars), TD2 (36 chars),
 * and TD3 / passport (44 chars) formats.
 */
const MRZ_LINE_RE = /^[A-Z][A-Z0-9<]{19,}$/m;

/**
 * An explicit separator line: three or more identical delimiter characters
 * (dash, equals, asterisk) on a line by themselves.
 */
const SEPARATOR_LINE_RE = /^[-=*]{3,}\s*$/m;

type UnitSignal = {
  unitIndex: number;
  hasMrz: boolean;
  hasSeparator: boolean; // form-feed or separator line
  isEmpty: boolean;      // no text and no images
};

function analyseUnit(
  unit: DocumentUnit,
  extraction: UnitExtractionResult | undefined,
): UnitSignal {
  const text = (extraction?.text ?? "").replace(/\r\n/g, "\n");
  const hasImages = (extraction?.images.length ?? 0) > 0;

  return {
    unitIndex: unit.index,
    hasMrz: MRZ_LINE_RE.test(text),
    hasSeparator: text.includes("\f") || SEPARATOR_LINE_RE.test(text),
    isEmpty: !text.trim() && !hasImages,
  };
}

function detectStructuralBoundaries(
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
): SegmentationMap | null {
  const byIndex = new Map(extractions.map((e) => [e.unitIndex, e]));
  const signals = units.map((u) => analyseUnit(u, byIndex.get(u.index)));

  const hasAnySignal = signals.some((s) => s.hasMrz || s.hasSeparator || s.isEmpty);
  if (!hasAnySignal) return null;

  // Walk units and decide where boundaries fall:
  //   - A blank/separator unit marks a boundary; it is NOT included in any group.
  //   - When an MRZ unit follows a non-MRZ unit, a new document starts.
  const groups: DocumentGroup[] = [];
  let currentIndices: number[] = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const prev = i > 0 ? signals[i - 1] : null;

    const boundaryBefore =
      i > 0 &&
      (prev!.isEmpty ||               // preceding blank page / separator sheet
        prev!.hasSeparator ||         // preceding form-feed or separator line
        (sig.hasMrz && !prev!.hasMrz)); // start of a new MRZ document

    if (boundaryBefore && currentIndices.length > 0) {
      groups.push(buildGroup(groups.length, currentIndices, "structural", 0.8));
      currentIndices = [];
    }

    // Blank and separator units are discarded — they are interstitial markers.
    if (!sig.isEmpty) {
      currentIndices.push(sig.unitIndex);
    }
  }

  if (currentIndices.length > 0) {
    groups.push(buildGroup(groups.length, currentIndices, "structural", 0.8));
  }

  // If no real boundary was found (only one group produced), fall through.
  if (groups.length <= 1) return null;

  return { groups };
}

// ---------------------------------------------------------------------------
// LLM-assisted fallback
// ---------------------------------------------------------------------------

const SEGMENTATION_SYSTEM_PROMPT = `\
You are a document segmentation assistant.
You receive a numbered list of pages/units extracted from a scanned submission.
Each entry shows the page number, unit kind, and the first few words of its text.
Your task is to identify where one distinct document ends and another begins.

Respond ONLY with a valid JSON array of groups. Each group is an array of 1-based page numbers belonging to the same document.
Example for a 5-page submission split as [pages 1-2], [pages 3-4-5]: [[1,2],[3,4,5]]
Rules:
- Every page number must appear in exactly one group.
- Groups must be ordered by their first page number.
- Do not omit any pages.
- Return only the raw JSON array — no explanation, no markdown, no code fences.`;

/**
 * Maximum number of page images to attach to a single multimodal segmentation
 * call. Caps token cost on long submissions. When more units have images than
 * this, the first MAX_SEGMENT_IMAGES are attached and the prompt notes the
 * truncation. Boundaries are typically visible at the start of each document
 * so a modest cap is usually sufficient.
 */
const MAX_SEGMENT_IMAGES = 12;

function buildLlmPrompt(
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
  policy: DocumentPolicy | undefined,
  attachedImageUnits: number[],
): string {
  const lines: string[] = [];

  if (policy?.policyText) {
    // Provide the first 800 chars of policy text for context without blowing the token budget.
    lines.push(`Document policy context (excerpt):\n${policy.policyText.slice(0, 800)}\n`);
  }

  lines.push("Submission contents:");
  const byIndex = new Map(extractions.map((e) => [e.unitIndex, e]));

  for (const unit of units) {
    const extraction = byIndex.get(unit.index);
    const raw = (extraction?.text ?? "").trim().replace(/\s+/g, " ");
    const preview = raw.slice(0, 200);
    const hasImage = (extraction?.images.length ?? 0) > 0;
    const content = preview
      ? `"${preview}${raw.length > 200 ? "…" : ""}"`
      : hasImage
        ? "[image content, no extractable text]"
        : "[blank]";
    lines.push(`Page ${unit.index} (${unit.kind}): ${content}`);
  }

  if (attachedImageUnits.length > 0) {
    lines.push(
      "",
      `Page images are attached to this message in order. The attached images correspond to pages ${attachedImageUnits.join(", ")}. Use them alongside the text content above to detect document boundaries (visual layout shifts, header changes, MRZ regions, separator pages).`,
    );
  }

  return lines.join("\n");
}

/**
 * Collect rendered images for multimodal segmentation, preserving unit-index
 * order and capping at MAX_SEGMENT_IMAGES. Returns the image attachments and
 * the unit indices each one corresponds to (parallel arrays).
 *
 * Only the FIRST image of each unit is taken — pdfjs may return multiple
 * pages of rendered output for a single unit but for boundary detection a
 * single representative image is sufficient.
 */
function collectSegmentationImages(
  units: DocumentUnit[],
  extractions: UnitExtractionResult[],
): { images: Array<{ data: string; mimeType: string }>; unitIndices: number[]; truncated: boolean } {
  const byIndex = new Map(extractions.map((e) => [e.unitIndex, e]));
  const images: Array<{ data: string; mimeType: string }> = [];
  const unitIndices: number[] = [];

  for (const unit of units) {
    if (images.length >= MAX_SEGMENT_IMAGES) break;
    const ex = byIndex.get(unit.index);
    const first = ex?.images[0];
    if (first) {
      images.push({ data: first.data, mimeType: first.mimeType });
      unitIndices.push(unit.index);
    }
  }

  // Count how many additional units had images we didn't attach.
  const totalUnitsWithImages = units.filter(
    (u) => (byIndex.get(u.index)?.images.length ?? 0) > 0,
  ).length;
  const truncated = totalUnitsWithImages > images.length;

  return { images, unitIndices, truncated };
}

async function llmAssistedSegmentation(
  request: SegmentationRequest,
): Promise<SegmentationMap | null> {
  const { units, extractions, policy, llmProvider, executionMode = "hybrid" } = request;
  if (!llmProvider) return null;

  // Multimodal segmentation runs only in "full-multimodal" mode (per spec §3).
  // In "hybrid" mode the LLM still helps with boundary detection, but only
  // from text — keeping cost low when deterministic + text suffice.
  let images: Array<{ data: string; mimeType: string }> | undefined;
  let attachedImageUnits: number[] = [];
  if (executionMode === "full-multimodal") {
    const collected = collectSegmentationImages(units, extractions);
    if (collected.images.length > 0) {
      images = collected.images;
      attachedImageUnits = collected.unitIndices;
    }
  }

  const prompt = buildLlmPrompt(units, extractions, policy, attachedImageUnits);

  let responseText: string | undefined;
  try {
    const output = await llmProvider.generate({
      systemPrompt: SEGMENTATION_SYSTEM_PROMPT,
      prompt,
      sessionId: images
        ? "document-segmentation-multimodal"
        : "document-segmentation",
      maxTokens: 512,
      images,
    });
    responseText = output?.text?.trim();
  } catch {
    return null;
  }

  if (!responseText) return null;

  try {
    // Strip accidental markdown code fences if the model included them.
    const json = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;

    const groups: DocumentGroup[] = [];
    const seenIndices = new Set<number>();
    const validUnitIndices = new Set(units.map((u) => u.index));

    for (const rawGroup of parsed) {
      if (!Array.isArray(rawGroup)) continue;
      const indices = (rawGroup as unknown[])
        .filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1)
        .filter((i) => validUnitIndices.has(i) && !seenIndices.has(i));
      if (indices.length === 0) continue;
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      for (const i of sorted) seenIndices.add(i);
      groups.push(buildGroup(groups.length, sorted, "llm-assisted", 0.65));
    }

    // Collect any units the LLM missed into a trailing catch-all group.
    const missed = units.map((u) => u.index).filter((i) => !seenIndices.has(i));
    if (missed.length > 0) {
      groups.push(buildGroup(groups.length, missed, "llm-assisted", 0.4));
    }

    // No boundary found — fall through.
    if (groups.length <= 1) return null;

    return { groups };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGroup(
  positionIndex: number,
  unitIndices: number[],
  method: SegmentationMethod,
  confidence: number,
): DocumentGroup {
  return {
    id: `group-${positionIndex + 1}`,
    unitIndices,
    confidence,
    segmentationMethod: method,
  };
}

function singleGroupMap(units: DocumentUnit[], confidence: number): SegmentationMap {
  return {
    groups: [
      {
        id: "group-1",
        unitIndices: units.map((u) => u.index),
        confidence,
        segmentationMethod: "single-group",
      },
    ],
  };
}
