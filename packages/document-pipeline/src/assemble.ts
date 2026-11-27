// ---------------------------------------------------------------------------
// Analysis Package Assembly
//
// Assembles the outputs of all pipeline stages into a single typed
// AnalysisPackage. This is a pure data-assembly step with no I/O or LLM
// calls — it just collects what the earlier stages produced and attaches
// the policy reference and processing log.
// ---------------------------------------------------------------------------

import type {
  AnalysisPackage,
  ClassifiedDocumentGroup,
  DocumentPolicy,
  DocumentUnit,
  FileRecord,
  ProcessingLogEntry,
  ReviewThresholds,
  SegmentationMap,
  UnitExtractionResult,
} from "./types.js";
import { reviewGroups } from "./review.js";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type AssemblyInput = {
  /**
   * Stage 1 output — one record per data file in the submission.
   * Length 1 for single-file uploads, N for archives (ZIP) and bundles.
   * Indexed by `DocumentUnit.sourceFileIndex`.
   */
  fileRecords: FileRecord[];
  /** Stage 2 output — ordered unit list. */
  units: DocumentUnit[];
  /** Stage 3 output — one entry per processed unit. */
  unitExtractions: UnitExtractionResult[];
  /** Stage 4 output. */
  segmentationMap: SegmentationMap;
  /** Stage 5 output. */
  classifiedGroups: ClassifiedDocumentGroup[];
  /** Active policy, if any. Null when running in open-vocabulary mode. */
  policy: DocumentPolicy | null;
  /** Ordered log of stage executions collected by the orchestrator. */
  processingLog: ProcessingLogEntry[];
  /** Review thresholds; when set, groups and the package get a `review` decision. */
  review?: ReviewThresholds;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Assemble a normalized AnalysisPackage from the outputs of all pipeline stages.
 *
 * This function is pure: same inputs always produce the same output.
 * It performs light validation to surface obvious inconsistencies (units
 * referenced in segmentation that have no extraction, etc.) as log warnings
 * rather than thrown errors, so the pipeline always delivers what it has.
 */
export function assembleAnalysisPackage(input: AssemblyInput): AnalysisPackage {
  const warnings = validateInput(input);

  const log: ProcessingLogEntry[] = [
    ...input.processingLog,
    // Append assembly-stage entry.
    {
      stage: "assembly",
      status: warnings.length > 0 ? "partial" : "ok",
      detail: warnings.length > 0 ? warnings.join("; ") : undefined,
    },
  ];

  let classifiedGroups = input.classifiedGroups;
  let review: AnalysisPackage["review"];
  if (input.review) {
    const reviewed = reviewGroups(input.classifiedGroups, input.segmentationMap, input.review);
    classifiedGroups = reviewed.groups;
    review = reviewed.decision;
    const flagged = reviewed.groups.filter((g) => g.review.required).length;
    log.push({ stage: "review", status: "ok", detail: `${flagged} of ${reviewed.groups.length} groups need review` });
  }

  const pkg: AnalysisPackage = {
    fileRecords: input.fileRecords,
    units: input.units,
    unitExtractions: input.unitExtractions,
    segmentationMap: input.segmentationMap,
    classifiedGroups,
    policyRef: input.policy
      ? {
          name: input.policy.name,
          version: input.policy.version,
          contentHash: input.policy.contentHash,
        }
      : null,
    processingLog: log,
  };
  if (review) pkg.review = review;
  return pkg;
}

// ---------------------------------------------------------------------------
// Processing log helpers
// ---------------------------------------------------------------------------

/**
 * Create a new mutable processing log. Pass to the orchestrator at pipeline
 * start; append entries with `logStage()` as each stage completes.
 */
export function createProcessingLog(): ProcessingLogEntry[] {
  return [];
}

/**
 * Append a stage entry to the log.
 *
 * @param log        The mutable log array.
 * @param stage      Stage identifier, e.g. "ingest", "decompose", "extract".
 * @param status     Outcome of the stage.
 * @param detail     Optional human-readable detail (error message, counts, etc.).
 * @param startMs    `Date.now()` captured before the stage ran. Used to compute durationMs.
 */
export function logStage(
  log: ProcessingLogEntry[],
  stage: string,
  status: ProcessingLogEntry["status"],
  detail?: string,
  startMs?: number,
): void {
  log.push({
    stage,
    status,
    detail,
    durationMs: startMs !== undefined ? Date.now() - startMs : undefined,
  });
}

// ---------------------------------------------------------------------------
// Validation (non-throwing — issues become log warnings)
// ---------------------------------------------------------------------------

function validateInput(input: AssemblyInput): string[] {
  const warnings: string[] = [];

  if (input.fileRecords.length === 0 && input.units.length > 0) {
    warnings.push("units present but fileRecords is empty");
  }

  const unitIndices = new Set(input.units.map((u) => u.index));
  const extractedIndices = new Set(input.unitExtractions.map((e) => e.unitIndex));

  // sourceFileIndex must point into fileRecords.
  for (const u of input.units) {
    if (u.sourceFileIndex < 0 || u.sourceFileIndex >= input.fileRecords.length) {
      warnings.push(
        `unit ${u.index} has sourceFileIndex ${u.sourceFileIndex} outside fileRecords range [0, ${input.fileRecords.length})`,
      );
    }
  }

  // Units with no extraction result.
  for (const idx of unitIndices) {
    if (!extractedIndices.has(idx)) {
      warnings.push(`unit ${idx} has no extraction result`);
    }
  }

  // Segmentation references units that don't exist.
  for (const group of input.segmentationMap.groups) {
    for (const idx of group.unitIndices) {
      if (!unitIndices.has(idx)) {
        warnings.push(`group ${group.id} references unknown unit ${idx}`);
      }
    }
  }

  // Classified groups reference segmentation groups that don't exist.
  const segGroupIds = new Set(input.segmentationMap.groups.map((g) => g.id));
  for (const cg of input.classifiedGroups) {
    if (!segGroupIds.has(cg.groupId)) {
      warnings.push(`classified group ${cg.groupId} has no matching segmentation group`);
    }
  }

  // Segmentation groups with no classification result.
  const classifiedGroupIds = new Set(input.classifiedGroups.map((g) => g.groupId));
  for (const sg of input.segmentationMap.groups) {
    if (!classifiedGroupIds.has(sg.id)) {
      warnings.push(`segmentation group ${sg.id} has no classification result`);
    }
  }

  return warnings;
}
