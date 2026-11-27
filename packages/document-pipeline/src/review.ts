// ---------------------------------------------------------------------------
// Review routing
//
// With `review` thresholds on the request, the assemble stage decides per
// document group whether a person should look at it, and why. Pure and
// deterministic: it reads confidences, labels, flags and field citations.
// ---------------------------------------------------------------------------

import type {
  ClassifiedDocumentGroup,
  ReviewDecision,
  ReviewReason,
  ReviewThresholds,
  SegmentationMap,
} from "./types.js";

/** Thresholds used for the ones `review` leaves out. */
export const DEFAULT_REVIEW_THRESHOLDS = {
  segmentationConfidence: 0.6,
  classificationConfidence: 0.6,
  fieldConfidence: 0.5,
} as const;

/** The review decision for one classified group (reasons in a fixed order). */
export function reviewGroup(
  group: ClassifiedDocumentGroup,
  segmentationConfidence: number | undefined,
  thresholds: ReviewThresholds = {},
): ReviewDecision {
  const minSegmentation = thresholds.segmentationConfidence ?? DEFAULT_REVIEW_THRESHOLDS.segmentationConfidence;
  const minClassification = thresholds.classificationConfidence ?? DEFAULT_REVIEW_THRESHOLDS.classificationConfidence;
  const minField = thresholds.fieldConfidence ?? DEFAULT_REVIEW_THRESHOLDS.fieldConfidence;
  const ignored = new Set(thresholds.ignoreFields ?? []);
  const reviewFlags = new Set(thresholds.reviewFlags ?? []);
  const groupId = group.groupId;
  const reasons: ReviewReason[] = [];

  if (segmentationConfidence !== undefined && segmentationConfidence < minSegmentation) {
    reasons.push({ code: "low-segmentation-confidence", groupId, detail: `${segmentationConfidence} < ${minSegmentation}` });
  }
  if (group.label === "unknown" || group.uncertaintyFlags.includes("no-classifier-result")) {
    reasons.push({ code: "unknown-type", groupId });
  } else if (group.unsupported) {
    reasons.push({ code: "unsupported-type", groupId, detail: group.label });
  }
  if (group.classificationConfidence < minClassification) {
    reasons.push({
      code: "low-classification-confidence",
      groupId,
      detail: `${group.classificationConfidence} < ${minClassification}`,
    });
  }
  for (const field of group.fields) {
    if (ignored.has(field.name)) continue;
    if (field.confidence < minField) {
      reasons.push({ code: "low-field-confidence", groupId, fieldName: field.name, detail: `${field.confidence} < ${minField}` });
    }
    const citations = field.citations;
    if (!citations || citations.length === 0) continue;
    const grounded = citations.some((c) => c.status === "verified" || c.status === "deterministic");
    if (grounded) continue;
    if (citations.some((c) => c.status === "not-found")) {
      reasons.push({ code: "citation-not-found", groupId, fieldName: field.name });
    } else if (thresholds.requireVerifiedCitations) {
      reasons.push({ code: "citation-unverifiable", groupId, fieldName: field.name });
    }
  }
  for (const flag of group.uncertaintyFlags) {
    if (reviewFlags.has(flag)) reasons.push({ code: "flagged", groupId, detail: flag });
  }
  return { required: reasons.length > 0, reasons };
}

/**
 * Review every classified group. Returns copies of the groups with `review`
 * set, and the package-level decision (all reasons, in group order).
 */
export function reviewGroups(
  classifiedGroups: readonly ClassifiedDocumentGroup[],
  segmentationMap: SegmentationMap,
  thresholds: ReviewThresholds = {},
): { groups: Array<ClassifiedDocumentGroup & { review: ReviewDecision }>; decision: ReviewDecision } {
  const segmentConfidence = new Map(segmentationMap.groups.map((g) => [g.id, g.confidence]));
  const groups = classifiedGroups.map((group) => ({
    ...group,
    review: reviewGroup(group, segmentConfidence.get(group.groupId), thresholds),
  }));
  const reasons = groups.flatMap((g) => g.review.reasons);
  return { groups, decision: { required: reasons.length > 0, reasons } };
}
