// ---------------------------------------------------------------------------
// Document Intelligence Pipeline — Core Type Contracts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Input
// ---------------------------------------------------------------------------

export type DocumentPipelineExecutionMode =
  | "deterministic-first"
  | "hybrid"
  | "full-multimodal";

export type DocumentPipelineRequest = {
  /** Raw file bytes. */
  buffer: Buffer;
  /** Original file name, used for extension-based MIME fallback. */
  fileName?: string;
  /** MIME type declared by the caller. Used only as a hint; magic-byte sniffing takes precedence. */
  declaredMimeType?: string;
  /** Named document policy registered in the DocumentPolicyRegistry. Open-vocabulary mode when absent. */
  policyName?: string;
  /** Controls how much the pipeline relies on LLM vs deterministic methods. Defaults to hybrid. */
  executionMode?: DocumentPipelineExecutionMode;
  /** Caller-supplied context forwarded to LLM prompts (segmentation, classification). */
  context?: DocumentPipelineContext;
  /**
   * Natural language description of the work the continuation handler should
   * perform (e.g. "extract the address and name from the ID card").
   * When set, the continuation stage runs after assembly. When absent, the
   * continuation stage is skipped regardless of whether a handler is registered.
   *
   * This is distinct from `context.submissionIntent`, which describes WHY the
   * submission was made and is used as analysis context, not as a task target.
   */
  taskIntent?: string;
  /**
   * Concurrency mode for archive (ZIP) entry processing.
   * - "sequential" (default) — entries processed one after another;
   *   deterministic processing log, bounded peak memory.
   * - "parallel" — entries processed concurrently; faster on archives
   *   with many small entries; processing log may be interleaved.
   * Ignored for non-archive submissions.
   */
  zipParallelism?: "sequential" | "parallel";
  /**
   * Minimum Tier-A confidence required to short-circuit the cascade.
   * When the deterministic Tier-A result has lower confidence, the
   * pipeline falls through to Tier B (if `executionMode` allows).
   * Defaults to 0.8.
   */
  tierAThreshold?: number;
  /**
   * Minimum Tier-B confidence required to skip Tier C.
   * When Tier-B has lower confidence and the group has rendered images,
   * Tier C runs. Defaults to 0.6.
   */
  tierBThreshold?: number;
  /**
   * Lowest tier the classifier is allowed to attempt. Tiers below this are
   * skipped entirely.
   *
   * - "tier-a" (default): full A → B → C cascade
   * - "tier-b": skip Tier A; always start with the LLM. Combine with
   *   `executionMode != "deterministic-first"` to actually have an LLM
   *   tier available.
   * - "tier-c": skip A and B; go straight to the multimodal LLM. The
   *   group must have rendered images and `executionMode` must be
   *   "hybrid" or "full-multimodal", otherwise no tier produces a result
   *   and the group falls back to "unknown".
   */
  minTier?: ClassificationTier;
  /** Hard caps on resource usage. Falls back to pipeline-level defaults when absent. */
  limits?: Partial<DocumentPipelineLimits>;
};

export type DocumentPipelineContext = {
  /** Expected language or script (BCP-47 tag, e.g. "en", "ar-EG"). */
  language?: string;
  /** ISO 3166-1 alpha-2 country code. Affects document format expectations. */
  country?: string;
  /**
   * Free-text description of why the file was submitted (e.g. "onboarding",
   * "claim processing"). Used as a hint to LLM prompts during segmentation
   * and classification. Distinct from `taskIntent`, which describes what the
   * continuation handler should produce.
   */
  submissionIntent?: string;
};

export type DocumentPipelineLimits = {
  /** Maximum number of pages or units to process. */
  maxUnits: number;
  /** Maximum total pixels across all page renders (for image-based extraction). */
  maxPixels: number;
  /** Minimum native text characters before falling back to OCR or image extraction. */
  minTextChars: number;
  /** Maximum LLM tokens per document group during classification and extraction. */
  maxTokensPerGroup: number;
  /** Maximum accepted file size in bytes. */
  maxBytes: number;
};

// ---------------------------------------------------------------------------
// 2. File record (Stage 1 output)
// ---------------------------------------------------------------------------

export type FileRecord = {
  /** Original file name as provided by the caller. */
  fileName: string;
  /** SHA-256 hex digest of the raw bytes. */
  contentHash: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Detected MIME type (magic-byte sniff preferred, extension fallback). */
  mimeType: string;
  /** ISO 8601 timestamp when the file was ingested. */
  ingestedAt: string;
};

// ---------------------------------------------------------------------------
// 3. Document units (Stage 2 output)
// ---------------------------------------------------------------------------

export type DocumentUnitKind =
  | "page"        // PDF page or TIFF frame
  | "image"       // standalone raster image
  | "sheet"       // spreadsheet sheet
  | "section"     // Word/PowerPoint section
  | "text-block"; // plain-text or Markdown chunk

export type DocumentUnit = {
  /** 1-based index, globally unique within the submission. */
  index: number;
  kind: DocumentUnitKind;
  /**
   * 0-based index into `AnalysisPackage.fileRecords` identifying which file
   * within the submission this unit was sourced from. For a single-file
   * submission this is always 0; for an archive (ZIP) it points to the
   * entry that produced the unit.
   */
  sourceFileIndex: number;
  /**
   * Human-readable label for the unit when the source format provides one
   * (e.g. spreadsheet sheet name, slide title, document section heading).
   * Optional; never invented when absent.
   */
  name?: string;
  /** Width in points/pixels, if available. */
  widthPx?: number;
  /** Height in points/pixels, if available. */
  heightPx?: number;
  /** Asset reference for the rendered image of this unit (base64 PNG), populated during Stage 3. */
  renderedImageBase64?: string;
};

// ---------------------------------------------------------------------------
// 4. Extracted text and layout (Stage 3 output)
// ---------------------------------------------------------------------------

/**
 * Coordinate space for a bounding box.
 *
 * - `"pixels"`     — absolute pixel coordinates relative to the source raster
 *                    image. Used by OCR plugins which return word boxes in
 *                    raw image-space coordinates.
 * - `"normalized"` — 0–1 coordinates relative to unit dimensions. Used by
 *                    pipeline-internal `LayoutBlock`s and downstream
 *                    consumers that should not depend on render scale.
 *
 * The pipeline always emits `"normalized"` boxes in `LayoutBlock`. OCR
 * plugins are expected to emit `"pixels"`; `wordBoxesToLayoutBlocks`
 * converts to `"normalized"`.
 */
export type CoordSpace = "pixels" | "normalized";

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Coordinate space the values are expressed in. Required. */
  coordSpace: CoordSpace;
};

export type LayoutBlock = {
  text: string;
  boundingBox?: BoundingBox;
  /** Confidence score from the extractor or OCR provider, 0–1. */
  confidence?: number;
};

export type UnitExtractionResult = {
  unitIndex: number;
  /** Full concatenated text for the unit. */
  text: string;
  /** Individual layout blocks when the extractor supports positional output. */
  blocks: LayoutBlock[];
  /** Rendered page images, populated when text was insufficient and image fallback ran. */
  images: ExtractedImage[];
  /** Identifier of the extractor plugin that produced this result. */
  extractorId: string;
  /** Whether an OCR provider was used to obtain the text. */
  ocrUsed: boolean;
  /** OCR provider identifier, when applicable. */
  ocrProviderId?: string;
};

export type ExtractedImage = {
  type: "image";
  data: string;       // base64
  mimeType: string;
};

// ---------------------------------------------------------------------------
// 5. Segmentation (Stage 4 output)
// ---------------------------------------------------------------------------

export type SegmentationMethod =
  | "structural"      // deterministic: MRZ, barcodes, layout anchors
  | "llm-assisted"    // LLM decided the boundary
  | "single-group";   // entire submission is one document

export type DocumentGroup = {
  /** Stable identifier within this analysis package. */
  id: string;
  /** 1-based unit indices belonging to this group, in order. */
  unitIndices: number[];
  /** Segmentation confidence, 0–1. */
  confidence: number;
  segmentationMethod: SegmentationMethod;
};

export type SegmentationMap = {
  groups: DocumentGroup[];
};

// ---------------------------------------------------------------------------
// 6. Classification and field extraction (Stage 5 output)
// ---------------------------------------------------------------------------

export type ClassificationTier = "tier-a" | "tier-b" | "tier-c";

export type ExtractedField = {
  /** Field name as declared in the document policy or derived by the classifier. */
  name: string;
  value: string;
  /** Confidence score, 0–1. */
  confidence: number;
  /** 1-based index of the unit this field was found in. */
  sourceUnitIndex: number;
  /** Bounding box within the source unit, when available. */
  boundingBox?: BoundingBox;
  /** Extraction method: "deterministic", "ocr", "llm-text", "llm-multimodal". */
  method: string;
};

export type ClassifiedDocumentGroup = {
  groupId: string;
  /** Document type label as determined by the classifier, e.g. "national-id", "passport". */
  label: string;
  /** True when the type was not recognised by the active policy. */
  unsupported: boolean;
  classificationTier: ClassificationTier;
  classificationConfidence: number;
  fields: ExtractedField[];
  /** Flags raised during extraction, e.g. "mrz-visual-mismatch", "low-confidence-name". */
  uncertaintyFlags: string[];
};

// ---------------------------------------------------------------------------
// 7. Document policy
// ---------------------------------------------------------------------------

export type DocumentPolicy = {
  /** Unique name used to reference this policy in requests. */
  name: string;
  /** Semantic version of this policy revision. */
  version: string;
  /** SHA-256 hex digest of the policy text, for audit traceability. */
  contentHash: string;
  /**
   * Natural language text authored by the application team.
   * Describes which document types to identify, per-type field extraction rules,
   * quality expectations, unsupported-document handling, and any cross-document
   * consistency checks.
   */
  policyText: string;
};

// ---------------------------------------------------------------------------
// 8. Processing log entry
// ---------------------------------------------------------------------------

export type ProcessingLogEntry = {
  stage: string;
  status: "ok" | "skipped" | "partial" | "failed";
  detail?: string;
  durationMs?: number;
};

// ---------------------------------------------------------------------------
// 9. Analysis package (full pipeline output, Stage 1–5)
// ---------------------------------------------------------------------------

export type AnalysisPackage = {
  /**
   * Files that make up this submission, in order.
   * - For a single-file upload: length 1.
   * - For a ZIP archive: one entry per archive member, in archive order.
   *   The archive container itself is NOT in this list — only the data
   *   files inside it. The container's hash is preserved in the
   *   processing log under the "ingest" stage detail.
   * - For a future multi-file bundle (spec §1): one entry per file, in
   *   submission order.
   *
   * Every `DocumentUnit.sourceFileIndex` indexes into this array.
   */
  fileRecords: FileRecord[];
  units: DocumentUnit[];
  unitExtractions: UnitExtractionResult[];
  segmentationMap: SegmentationMap;
  classifiedGroups: ClassifiedDocumentGroup[];
  /** Policy name and version that governed this analysis. Null when open-vocabulary mode was used. */
  policyRef: { name: string; version: string; contentHash: string } | null;
  processingLog: ProcessingLogEntry[];
};

// ---------------------------------------------------------------------------
// 10. Post-analysis continuation
// ---------------------------------------------------------------------------

export type ContinuationRequest = {
  analysisPackage: AnalysisPackage;
  /**
   * Natural language or structured description of what the calling application
   * wants to accomplish, e.g. "extract the address and name from the ID card".
   */
  taskIntent: string;
  /** Any app-specific context the continuation agent needs. */
  appContext?: Record<string, unknown>;
};

export type ContinuationEvidence = {
  groupId: string;
  fieldName: string;
  confidence: number;
};

export type UnresolvedItem = {
  description: string;
  reason: string;
};

export type ContinuationResult = {
  /** Resolved values requested by the task intent, keyed by field or logical name. */
  results: Record<string, unknown>;
  evidence: ContinuationEvidence[];
  unresolvedItems: UnresolvedItem[];
  /** Suggested follow-up actions, e.g. "request manual review", "re-submit clearer image". */
  suggestedNextSteps: string[];
};

export type ContinuationHandler = (
  request: ContinuationRequest,
) => Promise<ContinuationResult>;

// ---------------------------------------------------------------------------
// 11. OCR plugin contract
// ---------------------------------------------------------------------------

export type OCRWordBox = {
  text: string;
  boundingBox: BoundingBox;
  confidence: number;
};

export type OCRResult = {
  text: string;
  /** Word-level bounding boxes, when the provider supports them. */
  wordBoxes?: OCRWordBox[];
  /** Overall confidence for the page, 0–1. */
  confidence?: number;
  /** BCP-47 language tag detected by the provider, when available. */
  detectedLanguage?: string;
};

export type OCROptions = {
  language?: string;
  /** Whether to request table/layout structure from the provider. */
  requestLayout?: boolean;
};

export type OCRPlugin = {
  id: string;
  label: string;
  /** MIME types this plugin can process (typically image/png, image/jpeg). */
  supportedMimeTypes: readonly string[];
  /** BCP-47 language tags this plugin supports. Empty means it supports all. */
  supportedLanguages: readonly string[];
  recognize: (imageBuffer: Buffer, mimeType: string, options?: OCROptions) => Promise<OCRResult>;
};

// ---------------------------------------------------------------------------
// 12. Full pipeline result
// ---------------------------------------------------------------------------

export type DocumentPipelineResult = {
  analysisPackage: AnalysisPackage;
  continuationResult?: ContinuationResult;
};
