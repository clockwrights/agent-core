// ---------------------------------------------------------------------------
// Pipeline Orchestrator
//
// App-agnostic. No application-domain logic belongs here.
//
// `runDocumentPipeline` is the single entry point that calls all stages in
// order, collects partial results on stage failure, and optionally runs the
// continuation handler after assembly.
//
// Stage order:
//   1. Ingest     — MIME detection, hash, FileRecord
//   2. Decompose  — split into DocumentUnits
//   3. Extract    — text/layout/images per unit
//   4. Segment    — group units into DocumentGroups
//   5. Classify   — label each group, extract fields
//   6. Assemble   — build AnalysisPackage
//   7. Continue   — optional: resolve task intent against the package
//
// Dependencies (llm, ocr, policy registry, extra extractors, continuation
// handler) are fully injected — no global singletons are imported here.
// ---------------------------------------------------------------------------

import {
  ingestFile,
  EmptyFileError,
  FileTooLargeError,
  UnsupportedFileTypeError,
} from "./ingest.js";
import { decomposeFile } from "./decompose.js";
import { extractUnit } from "./extract.js";
import { segmentDocuments } from "./segment.js";
import { classifyGroups } from "./classify.js";
import { assembleAnalysisPackage, createProcessingLog, logStage } from "./assemble.js";
import { expandZipSubmission, type ZipExtractionParallelism } from "./zip.js";
import type { ExtractorPlugin } from "./extract.js";
import type {
  AnalysisPackage,
  ClassifiedDocumentGroup,
  ContinuationHandler,
  ContinuationResult,
  DocumentGroup,
  DocumentPipelineExecutionMode,
  DocumentPipelineLimits,
  DocumentPipelineRequest,
  DocumentPipelineResult,
  DocumentUnit,
  FileRecord,
  OCRPlugin,
  ProcessingLogEntry,
  SegmentationMap,
  UnitExtractionResult,
} from "./types.js";
import type { PipelineLlmAdapter } from "./llm.js";
import type { DocumentPolicyRegistry } from "./policy.js";

// ---------------------------------------------------------------------------
// Dependency injection bag
// ---------------------------------------------------------------------------

export type DocumentPipelineDeps = {
  /** LLM provider used by segmentation, classification, and the LLM continuation handler. */
  llmProvider?: PipelineLlmAdapter;
  /**
   * Optional dedicated adapter for Tier-C (multimodal) classification calls.
   * When set, Tier C uses this instead of `llmProvider`. Used to route Tier C
   * to a vision-capable profile while keeping Tier B on a cheaper text profile.
   * Falls back to `llmProvider` when undefined.
   */
  tierCAdapter?: PipelineLlmAdapter;
  /** OCR plugin injected into the extraction stage. */
  ocrPlugin?: OCRPlugin;
  /**
   * Policy registry used to look up the named policy from the request.
   * When absent, the pipeline always runs in open-vocabulary mode.
   */
  policyRegistry?: DocumentPolicyRegistry;
  /**
   * Additional extractor plugins merged with the built-in set.
   * Useful for proprietary formats or extended capabilities.
   */
  extraExtractors?: ExtractorPlugin[];
  /**
   * Continuation handler called after assembly when the request includes a
   * task intent. Defaults to no continuation (result.continuationResult is
   * undefined) when not provided.
   */
  continuationHandler?: ContinuationHandler;
};

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: DocumentPipelineLimits = {
  maxUnits: 50,
  maxPixels: 8_000_000,
  minTextChars: 200,
  maxTokensPerGroup: 2048,
  maxBytes: 50 * 1024 * 1024, // 50 MB
};

// ---------------------------------------------------------------------------
// Orchestrator entry point
// ---------------------------------------------------------------------------

/**
 * Run all pipeline stages for a single document submission.
 *
 * - Stages run sequentially; a failure in an early stage does not prevent
 *   later stages from running with whatever partial data is available.
 * - The returned `analysisPackage.processingLog` records the outcome and
 *   duration of every stage.
 * - When `request.taskIntent` is provided and a `continuationHandler` is
 *   present in `deps`, the continuation stage runs automatically and its
 *   result is attached to `continuationResult`. `context.submissionIntent`
 *   is *not* used to gate continuation — it is only an analysis hint.
 */
export async function runDocumentPipeline(
  request: DocumentPipelineRequest,
  deps: DocumentPipelineDeps = {},
): Promise<DocumentPipelineResult> {
  const limits: DocumentPipelineLimits = { ...DEFAULT_LIMITS, ...request.limits };
  const executionMode: DocumentPipelineExecutionMode = request.executionMode ?? "hybrid";
  const log = createProcessingLog();

  // -------------------------------------------------------------------------
  // Stage 1 — Ingest
  // -------------------------------------------------------------------------

  let fileRecord: Awaited<ReturnType<typeof ingestFile>>;
  {
    const t = Date.now();
    try {
      fileRecord = await ingestFile({
        buffer: request.buffer,
        fileName: request.fileName,
        declaredMimeType: request.declaredMimeType,
        maxBytes: limits.maxBytes,
      });
      logStage(log, "ingest", "ok", undefined, t);
    } catch (err) {
      const detail = formatIngestError(err);
      logStage(log, "ingest", "failed", detail, t);
      // Ingest failure is unrecoverable — return minimal package.
      return { analysisPackage: failedPackage(request, log, "ingest") };
    }
  }

  // For single-file submissions, fileRecords is just [outerFile] and every
  // unit's sourceFileIndex is 0. For ZIP archives, we expand to one record
  // per entry; the archive container is NOT in the data list.
  let fileRecords: FileRecord[] = [fileRecord];
  // Per-entry buffers used by Stage 3 (extract). Index aligns with fileRecords.
  let entryBuffers: Buffer[] = [request.buffer];

  // -------------------------------------------------------------------------
  // Stage 2 — Decompose
  // -------------------------------------------------------------------------

  let units: DocumentUnit[] = [];
  {
    const t = Date.now();
    try {
      if (fileRecord.mimeType === "application/zip") {
        // -- ZIP submission: expand entries → fileRecords + units --
        const parallelism: ZipExtractionParallelism = request.zipParallelism ?? "sequential";
        const expansion = await expandZipSubmission(request.buffer, {
          maxEntryBytes: limits.maxBytes,
          maxUnits: limits.maxUnits,
          parallelism,
        });

        fileRecords = expansion.fileRecords;
        entryBuffers = expansion.entryBuffers;
        units = expansion.units;

        const detail =
          `archive expanded to ${fileRecords.length} entry/entries, ` +
          `${units.length} total unit(s) (${parallelism})` +
          (expansion.warnings.length > 0 ? `; ${expansion.warnings.length} warning(s)` : "");

        if (expansion.warnings.length > 0) {
          // Surface every per-entry warning as its own log entry so the audit
          // trail is human-readable rather than a single concatenated string.
          for (const w of expansion.warnings) {
            log.push({ stage: "decompose", status: "partial", detail: w });
          }
          logStage(log, "decompose", "partial", detail, t);
        } else if (units.length === 0) {
          logStage(log, "decompose", "failed", "ZIP archive contained no usable entries", t);
        } else {
          logStage(log, "decompose", "ok", detail, t);
        }
      } else {
        // -- Single-file submission --
        units = await decomposeFile({
          buffer: request.buffer,
          mimeType: fileRecord.mimeType,
        });

        // Apply maxUnits cap.
        if (units.length > limits.maxUnits) {
          const dropped = units.length - limits.maxUnits;
          units = units.slice(0, limits.maxUnits);
          logStage(
            log,
            "decompose",
            "partial",
            `${units.length} units processed; ${dropped} units dropped (maxUnits cap)`,
            t,
          );
        } else {
          logStage(log, "decompose", "ok", `${units.length} unit(s)`, t);
        }
      }
    } catch (err) {
      logStage(log, "decompose", "failed", errorDetail(err), t);
      // Fall through with empty units — later stages handle empty input.
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3 — Extract
  // -------------------------------------------------------------------------

  const unitExtractions: UnitExtractionResult[] = [];
  {
    const t = Date.now();
    let failures = 0;
    for (const unit of units) {
      // Each unit's source file may differ (ZIP). Pull the right buffer/mime.
      const sourceRec = fileRecords[unit.sourceFileIndex];
      const sourceBuf = entryBuffers[unit.sourceFileIndex];
      if (!sourceRec || !sourceBuf) {
        failures++;
        continue;
      }
      try {
        const result = await extractUnit({
          buffer: sourceBuf,
          mimeType: sourceRec.mimeType,
          unit,
          limits: {
            maxPages: limits.maxUnits,
            maxPixels: limits.maxPixels,
            minTextChars: limits.minTextChars,
          },
          ocrPlugin: deps.ocrPlugin,
          extraPlugins: deps.extraExtractors,
        });
        if (result) unitExtractions.push(result);
      } catch {
        failures++;
      }
    }

    if (failures > 0 && unitExtractions.length === 0) {
      logStage(log, "extract", "failed", `all ${failures} unit(s) failed`, t);
    } else if (failures > 0) {
      logStage(log, "extract", "partial", `${unitExtractions.length} ok, ${failures} failed`, t);
    } else {
      logStage(log, "extract", "ok", `${unitExtractions.length} unit(s)`, t);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 4 — Segment
  // -------------------------------------------------------------------------

  let segmentationMap: SegmentationMap = { groups: [] };
  {
    const t = Date.now();
    try {
      // Look up policy text for the segmentation prompt.
      const policy = request.policyName
        ? deps.policyRegistry?.get(request.policyName)
        : undefined;

      segmentationMap = await segmentDocuments({
        units,
        extractions: unitExtractions,
        policy,
        context: request.context,
        executionMode,
        llmProvider: deps.llmProvider,
      });
      logStage(log, "segment", "ok", `${segmentationMap.groups.length} group(s)`, t);
    } catch (err) {
      logStage(log, "segment", "failed", errorDetail(err), t);
      // Fallback: treat all units as one group.
      segmentationMap = fallbackSegmentationMap(units);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 5 — Classify
  // -------------------------------------------------------------------------

  let classifiedGroups: ClassifiedDocumentGroup[] = [];
  {
    const t = Date.now();
    try {
      const policy = request.policyName
        ? deps.policyRegistry?.get(request.policyName)
        : undefined;

      classifiedGroups = await classifyGroups({
        groups: segmentationMap.groups,
        units,
        extractions: unitExtractions,
        policy,
        context: request.context,
        executionMode,
        llmProvider: deps.llmProvider,
        tierCAdapter: deps.tierCAdapter,
        tierAThreshold: request.tierAThreshold,
        tierBThreshold: request.tierBThreshold,
        minTier: request.minTier,
      });
      logStage(
        log,
        "classify",
        "ok",
        `${classifiedGroups.length} group(s) classified`,
        t,
      );
    } catch (err) {
      logStage(log, "classify", "failed", errorDetail(err), t);
      // classifiedGroups stays empty — assemble will warn about this.
    }
  }

  // -------------------------------------------------------------------------
  // Stage 6 — Assemble
  // -------------------------------------------------------------------------

  const policy = request.policyName
    ? (deps.policyRegistry?.get(request.policyName) ?? null)
    : null;

  const analysisPackage: AnalysisPackage = assembleAnalysisPackage({
    fileRecords,
    units,
    unitExtractions,
    segmentationMap,
    classifiedGroups,
    policy,
    processingLog: log,
  });

  // -------------------------------------------------------------------------
  // Stage 7 — Continuation (optional)
  // -------------------------------------------------------------------------

  if (!deps.continuationHandler || !request.taskIntent) {
    return { analysisPackage };
  }

  let continuationResult: ContinuationResult | undefined;
  {
    const t = Date.now();
    try {
      continuationResult = await deps.continuationHandler({
        analysisPackage,
        taskIntent: request.taskIntent,
        appContext: buildAppContext(request),
      });
      logStage(
        analysisPackage.processingLog as ProcessingLogEntry[],
        "continuation",
        "ok",
        undefined,
        t,
      );
    } catch (err) {
      logStage(
        analysisPackage.processingLog as ProcessingLogEntry[],
        "continuation",
        "failed",
        errorDetail(err),
        t,
      );
    }
  }

  return { analysisPackage, continuationResult };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatIngestError(err: unknown): string {
  if (err instanceof EmptyFileError) return "empty file";
  if (err instanceof FileTooLargeError) return `file too large: ${(err as FileTooLargeError).sizeBytes} bytes`;
  if (err instanceof UnsupportedFileTypeError) return `unsupported type: ${(err as UnsupportedFileTypeError).detectedMimeType ?? "unknown"}`;
  return errorDetail(err);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Return a minimal AnalysisPackage for the case where the pipeline cannot
 * proceed past the given stage. Gives callers a well-typed object with an
 * informative processing log rather than a thrown error.
 */
function failedPackage(
  request: DocumentPipelineRequest,
  log: ProcessingLogEntry[],
  failedStage: string,
): AnalysisPackage {
  return {
    fileRecords: [
      {
        fileName: request.fileName ?? "unknown",
        contentHash: "",
        sizeBytes: request.buffer.byteLength,
        mimeType: request.declaredMimeType ?? "application/octet-stream",
        ingestedAt: new Date().toISOString(),
      },
    ],
    units: [],
    unitExtractions: [],
    segmentationMap: { groups: [] },
    classifiedGroups: [],
    policyRef: null,
    processingLog: [
      ...log,
      {
        stage: "assembly",
        status: "failed",
        detail: `pipeline aborted at ${failedStage}`,
      },
    ],
  };
}

function fallbackSegmentationMap(units: DocumentUnit[]): SegmentationMap {
  if (units.length === 0) return { groups: [] };
  return {
    groups: [
      {
        id: "group-1",
        unitIndices: units.map((u) => u.index),
        confidence: 0,
        segmentationMethod: "single-group",
      } satisfies DocumentGroup,
    ],
  };
}

function buildAppContext(request: DocumentPipelineRequest): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (request.context?.language) ctx["language"] = request.context.language;
  if (request.context?.country) ctx["country"] = request.context.country;
  if (request.context?.submissionIntent) ctx["submissionIntent"] = request.context.submissionIntent;
  if (request.policyName) ctx["policyName"] = request.policyName;
  return ctx;
}
