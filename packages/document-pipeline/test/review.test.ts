// ---------------------------------------------------------------------------
// Tests: review routing (`review` thresholds) — reason codes, options,
// package aggregation, the processing-log entry and env defaults.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleAnalysisPackage } from "../src/assemble.js";
import { loadPipelineDefaults } from "../src/pipeline-config.js";
import { DEFAULT_REVIEW_THRESHOLDS, reviewGroup, reviewGroups } from "../src/review.js";
import type { ClassifiedDocumentGroup, ExtractedField, FieldCitationStatus } from "../src/types.js";

function field(name: string, confidence: number, status?: FieldCitationStatus): ExtractedField {
  const f: ExtractedField = { name, value: "v", confidence, sourceUnitIndex: 1, method: "llm-text" };
  if (status) f.citations = [{ unitIndex: 1, sourceFileIndex: 0, page: 1, quote: "q", status }];
  return f;
}

function group(overrides: Partial<ClassifiedDocumentGroup> = {}): ClassifiedDocumentGroup {
  return {
    groupId: "g1",
    label: "invoice",
    unsupported: false,
    classificationTier: "tier-b",
    classificationConfidence: 0.9,
    fields: [],
    uncertaintyFlags: [],
    ...overrides,
  };
}

const codes = (g: ClassifiedDocumentGroup, segment = 1, thresholds = {}) =>
  reviewGroup(g, segment, thresholds).reasons.map((r) => r.code);

test("defaults", () => {
  assert.deepEqual(DEFAULT_REVIEW_THRESHOLDS, { segmentationConfidence: 0.6, classificationConfidence: 0.6, fieldConfidence: 0.5 });
});

test("a confident, cited group needs no review", () => {
  const decision = reviewGroup(group({ fields: [field("total", 0.9, "verified"), field("mrz", 0.88, "deterministic")] }), 0.8);
  assert.deepEqual(decision, { required: false, reasons: [] });
});

test("each reason code fires on a minimal case, in a fixed order", () => {
  assert.deepEqual(codes(group(), 0.5), ["low-segmentation-confidence"]);
  assert.deepEqual(codes(group({ label: "unknown", classificationConfidence: 0 })), ["unknown-type", "low-classification-confidence"]);
  assert.deepEqual(codes(group({ uncertaintyFlags: ["no-classifier-result"] })), ["unknown-type"]);
  assert.deepEqual(codes(group({ unsupported: true })), ["unsupported-type"]);
  assert.deepEqual(codes(group({ classificationConfidence: 0.59 })), ["low-classification-confidence"]);
  assert.deepEqual(codes(group({ fields: [field("total", 0.49)] })), ["low-field-confidence"]);
  assert.deepEqual(codes(group({ fields: [field("total", 0.9, "not-found")] })), ["citation-not-found"]);
  assert.deepEqual(codes(group({ fields: [field("total", 0.9, "unverifiable")] })), [], "unverifiable alone is fine by default");
  assert.deepEqual(codes(group({ fields: [field("total", 0.9)] })), [], "no citations: no citation reason");

  const all = reviewGroup(
    group({ unsupported: true, classificationConfidence: 0.1, fields: [field("a", 0.1, "not-found")], uncertaintyFlags: ["blurry"] }),
    0.4,
    { reviewFlags: ["blurry"] },
  );
  assert.deepEqual(
    all.reasons.map((r) => [r.code, r.fieldName ?? null, r.detail ?? null]),
    [
      ["low-segmentation-confidence", null, "0.4 < 0.6"],
      ["unsupported-type", null, "invoice"],
      ["low-classification-confidence", null, "0.1 < 0.6"],
      ["low-field-confidence", "a", "0.1 < 0.5"],
      ["citation-not-found", "a", null],
      ["flagged", null, "blurry"],
    ],
  );
  assert.equal(all.required, true);
});

test("options: thresholds, ignoreFields, requireVerifiedCitations, reviewFlags", () => {
  assert.deepEqual(codes(group({ classificationConfidence: 0.7 }), 1, { classificationConfidence: 0.8 }), ["low-classification-confidence"]);
  assert.deepEqual(codes(group(), 0.7, { segmentationConfidence: 0.75 }), ["low-segmentation-confidence"]);
  assert.deepEqual(codes(group({ fields: [field("note", 0.1, "not-found")] }), 1, { ignoreFields: ["note"] }), []);
  assert.deepEqual(codes(group({ fields: [field("a", 0.9, "unverifiable")] }), 1, { requireVerifiedCitations: true }), ["citation-unverifiable"]);
  assert.deepEqual(codes(group({ fields: [field("a", 0.9, "verified")] }), 1, { requireVerifiedCitations: true }), []);
  assert.deepEqual(codes(group({ uncertaintyFlags: ["other"] }), 1, { reviewFlags: ["blurry"] }), []);
  assert.deepEqual(codes(group(), undefined), [], "no segment confidence known: no segment rule");
});

test("reviewGroups copies groups and aggregates reasons in group order", () => {
  const input = [group({ groupId: "a" }), group({ groupId: "b", classificationConfidence: 0.2 })];
  const { groups, decision } = reviewGroups(
    input,
    { groups: [{ id: "a", unitIndices: [1], confidence: 0.5, segmentationMethod: "single-group" }, { id: "b", unitIndices: [2], confidence: 0.8, segmentationMethod: "structural" }] },
    {},
  );
  assert.equal(input[0]!.review, undefined, "inputs are not mutated");
  assert.equal(groups[0]!.review.required, true);
  assert.deepEqual(decision.reasons.map((r) => [r.groupId, r.code]), [["a", "low-segmentation-confidence"], ["b", "low-classification-confidence"]]);
});

test("assembly adds review and a log entry only when asked", () => {
  const base = {
    fileRecords: [{ fileName: "f", contentHash: "h", sizeBytes: 1, mimeType: "text/plain", ingestedAt: "t" }],
    units: [{ index: 1, kind: "page" as const, sourceFileIndex: 0 }],
    unitExtractions: [{ unitIndex: 1, text: "x", blocks: [], images: [], extractorId: "t", ocrUsed: false }],
    segmentationMap: { groups: [{ id: "g1", unitIndices: [1], confidence: 1, segmentationMethod: "single-group" as const }] },
    classifiedGroups: [group({ classificationConfidence: 0.3 })],
    policy: null,
    processingLog: [],
  };
  const plain = assembleAnalysisPackage(base);
  assert.equal("review" in plain, false);
  assert.equal(plain.classifiedGroups[0]!.review, undefined);
  assert.deepEqual(plain.processingLog.map((e) => e.stage), ["assembly"]);

  const reviewed = assembleAnalysisPackage({ ...base, review: {} });
  assert.equal(reviewed.review!.required, true);
  assert.deepEqual(reviewed.classifiedGroups[0]!.review!.reasons.map((r) => r.code), ["low-classification-confidence"]);
  assert.deepEqual(reviewed.processingLog.at(-1), { stage: "review", status: "ok", detail: "1 of 1 groups need review" });
});

test("pipeline defaults: LLM_DEFAULT_REVIEW", () => {
  assert.deepEqual(loadPipelineDefaults({ LLM_DEFAULT_REVIEW: "true" }).review, {});
  assert.equal("review" in loadPipelineDefaults({ LLM_DEFAULT_REVIEW: "false" }), false);
  assert.equal("review" in loadPipelineDefaults({}), false);
});
