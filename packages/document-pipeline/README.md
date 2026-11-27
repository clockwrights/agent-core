# @maya-ai/document-pipeline

App-agnostic pipeline that ingests files (PDF, images, Office docs, ZIP archives, plain text) and produces a normalised analysis package: per-file records, per-unit text and rendered images, document segmentation, three-tier classification with field extraction, and an optional continuation handler that produces task-specific output.

The pipeline is provider-neutral. The LLM, the OCR engine, the policy registry, and any extra format extractors are dependency-injected — there are no global singletons.

## Install

```bash
npm install @maya-ai/document-pipeline
```

**Requires Node.js 22 or newer** (the `file-type` dependency used for MIME sniffing needs it).

Optional peer dependencies (declared as `peerDependencies` with `optional: true`):

| Package | Needed for |
|---|---|
| `pdfjs-dist` (`^4.10.38`) | PDF decomposition + rendering. |
| `@napi-rs/canvas` | Rendering PDF pages to image bytes. |
| `xlsx` (`^0.18.5`) | Spreadsheet extraction. |

Install only the ones whose formats you care about. Pipeline calls into a missing peer surface as a per-stage warning, not a crash.

## Public API

```ts
import {
  runDocumentPipeline,
  type DocumentPipelineRequest,
  type DocumentPipelineResult,
  type DocumentPipelineDeps,
} from "@maya-ai/document-pipeline";

const result: DocumentPipelineResult = await runDocumentPipeline(request, deps);
```

`DocumentPipelineDeps` (all optional):

| Field | Type | Purpose |
|-------|------|---------|
| `llmProvider` | `PipelineLlmAdapter` | Used by Tier B classification, segmentation, continuation. |
| `tierCAdapter` | `PipelineLlmAdapter` | Multimodal Tier-C-specific provider. Falls back to `llmProvider` when omitted. |
| `ocrPlugin` | `OCRPlugin` | Injected into the extraction stage. |
| `policyRegistry` | `DocumentPolicyRegistry` | Resolves `request.policyName` to a `DocumentPolicy`. |
| `extraExtractors` | `ExtractorPlugin[]` | Merged with the built-in extractors. |
| `continuationHandler` | `ContinuationHandler` | Called after assembly when `request.taskIntent` is present. |
| `nativePdf` | `boolean \| { maxBytes?: number }` | Opt-in, default off. Tier C attaches the source PDF as a native document instead of rendered page images — see [Native PDF](#native-pdf-opt-in). |

The pipeline depends on a **narrow LLM adapter** (`PipelineLlmAdapter`), not on any concrete provider:

```ts
export interface PipelineLlmAdapter {
  readonly enabled: boolean;
  readonly supportsDocuments?: boolean; // forwards `documents` (native PDF); default false
  generate(request: PipelineLlmRequest): Promise<PipelineLlmResponse | undefined>;
}

type PipelineLlmRequest = {
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  maxTokens?: number;
  images?: { data: string; mimeType: string }[]; // base64-encoded for Tier C
  documents?: { data: string; mimeType: string; name?: string }[]; // native PDF, opt-in
};
```

The pipeline never sends tool definitions through this adapter — tool use belongs to the agent loop, not the pipeline. Adapters that don't support multimodal calls SHOULD ignore `images` and record that they did so. `documents` is only ever sent to adapters that set `supportsDocuments: true`.

### Native PDF (opt-in)

Some providers read a PDF directly (text layer and page images together), which is often more accurate than rendered page images and works for text PDFs that produced no images. To use it:

```ts
await runDocumentPipeline(request, {
  tierCAdapter: myPdfCapableAdapter, // sets supportsDocuments: true and forwards `documents`
  nativePdf: true,                   // or { maxBytes: 10 * 1024 * 1024 }
});
```

- Applies to Tier C only, for groups whose pages all come from one PDF in the submission (single PDF or a PDF inside a ZIP). The whole file is attached once per call, and the prompt names the group's pages ("pages 2-3 of it"). Low-confidence field refinement sends the same PDF.
- With a native PDF available, Tier C runs even when the group has no rendered images.
- PDFs larger than `maxBytes` (default `NATIVE_PDF_MAX_BYTES`, 32 MiB), groups spanning files, non-PDF sources, and adapters without `supportsDocuments` keep the rendered-image path unchanged.
- Calling `classifyGroups` directly: pass `sourceDocuments: [{ sourceFileIndex, data, mimeType, name }]`.

---

## Stage Flow

| # | Stage | Function | Failure behaviour |
|---|-------|----------|-------------------|
| 1 | Ingest | `ingestFile` | Unrecoverable — returns failed package immediately |
| 2 | Decompose | `decomposeFile` (or `expandZipSubmission` for archives) | Falls through with empty `units` |
| 3 | Extract | `extractUnit` per unit | Per-unit failures tracked; partial results kept |
| 4 | Segment | `segmentDocuments` | Fallback: all units in one group |
| 5 | Classify | `classifyGroups` | Falls through with empty `classifiedGroups` |
| 6 | Assemble | `assembleAnalysisPackage` | Always succeeds; warns about inconsistencies in log |
| 7 | Continue | `continuationHandler` | Skipped unless deps + `request.taskIntent` are both present |

### Segmentation result

Each `DocumentGroup` carries `segmentationMethod` and a `confidence` in [0, 1]:

| `segmentationMethod` | Meaning | `confidence` |
|---|---|---|
| `structural` | Deterministic boundary signals (MRZ lines, form feeds, separator lines, blank units) | `0.8` |
| `llm-assisted` | The LLM decided the boundaries | `0.65`; units the LLM left out are collected into a trailing group with `0.4` |
| `single-group` | The whole submission is one group | `1.0` for a single-unit submission; `UNSEGMENTED_FALLBACK_CONFIDENCE` (`0.5`) when a multi-unit submission could not be split (no structural signal and the LLM fallback disabled, unavailable or failed) |

Route low-confidence groups — in particular the `0.5` fallback — to review rather than treating them as one confirmed document.

---

## Three-Tier Classification Cascade

Each segmented document group is classified by a cascade. Each tier has a confidence threshold; results above the threshold short-circuit the next tier.

| Tier | Mechanism | Cost | Runs when |
|------|-----------|------|-----------|
| **A — Deterministic** | MRZ regex (TD3 passport / TD2 / TD1 ID), barcode anchor (CODE128/PDF417/QR/etc.), heuristic field parsing | None | Always (unless `minTier=tier-b` or `tier-c`) |
| **B — LLM text** | Policy-injected text prompt with extracted text snippets | One LLM call | Tier A confidence below `tierAThreshold` AND `executionMode != deterministic-first` |
| **C — Multimodal LLM** | Same prompt + actual rendered page images attached as `ImageContent` parts | One+ LLM calls with image bytes | Tier B confidence below `tierBThreshold` AND group has rendered images (or a native PDF, when `nativePdf` is on) AND `executionMode` is `hybrid` or `full-multimodal` |

### Execution modes

| Mode | Tier A | Tier B | Tier C | Notes |
|------|--------|--------|--------|-------|
| `deterministic-first` | ✅ | ❌ | ❌ | Structural rules only, no LLM |
| `hybrid` | ✅ | ✅ when A insufficient | ✅ when B insufficient and group has images | LLM text-only segmentation |
| `full-multimodal` | ✅ | ✅ when A insufficient | ✅ when B insufficient and group has images | Up to 12 page images attached to segmentation LLM call |

For *classification*, `hybrid` and `full-multimodal` behave identically — both run the full cascade. The two modes diverge at *segmentation*: only `full-multimodal` attaches page images to the boundary-detection LLM call.

### `minTier` semantics

`minTier` controls which tiers are *attempted*. Tiers below `minTier` are skipped entirely; the classifier does **not** silently salvage by running a lower tier.

| Combination | Behaviour |
|-------------|-----------|
| `minTier=tier-a`, `executionMode=hybrid` | Full A → B → C cascade (default) |
| `minTier=tier-b`, `executionMode=hybrid` | Skip A; LLM-only |
| `minTier=tier-c`, `executionMode=hybrid` | Skip A and B; multimodal only. Group must have images, otherwise → unknown |
| `minTier=tier-b`, `executionMode=deterministic-first` | Contradictory: Tier A blocked by `minTier`, Tier B/C blocked by mode → unknown |
| `minTier=tier-c`, no images on group | Tier C cannot run, lower tiers blocked → unknown |

The "unknown" fallback group has `classificationTier: <minTier>` so the result records what was attempted, and `uncertaintyFlags: ["no-classifier-result"]`.

---

## Configuration

### Per-request fields (on `DocumentPipelineRequest`)

| Field | Type | Purpose |
|-------|------|---------|
| `executionMode` | enum | `deterministic-first \| hybrid \| full-multimodal` |
| `tierAThreshold` | `[0,1]` | Min Tier-A confidence to short-circuit Tier B/C |
| `tierBThreshold` | `[0,1]` | Min Tier-B confidence to skip Tier C |
| `minTier` | enum | `tier-a \| tier-b \| tier-c` — lowest tier the classifier may attempt |
| `fieldCitations` | boolean | Opt-in, default off. Each field gets `citations` with a verified quote — see [Field citations](#field-citations-opt-in) |
| `review` | `ReviewThresholds` | Opt-in. Groups and the package get a `review` decision — see [Review routing](#review-routing-opt-in) |
| `policyName` | string | Named policy in the registry (open-vocabulary if absent) |
| `taskIntent` | string | Continuation goal — gates whether the continuation handler runs |
| `language` | BCP-47 | Hint, e.g. `en`, `ar-EG` |
| `country` | ISO 3166-1 alpha-2 | Hint, e.g. `US`, `DE` |
| `zipParallelism` | enum | `sequential \| parallel`. Sequential is deterministic; parallel is faster on archives with many small entries. |
| `limits` | `DocumentPipelineLimits` | Override per-request budgets (max units, max pixels, max bytes, etc.). |

`request.context.submissionIntent` (separate from `taskIntent`) is a hint about why the submission was made; it flows into the segmentation LLM prompt and the continuation handler's `appContext`.

### App-wide defaults via env

The package exports `loadPipelineDefaults()` which reads these env vars once and returns a `DocumentPipelineDefaults` object the caller can merge into requests:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_DEFAULT_EXECUTION_MODE` | `hybrid` | Default applied when the request omits `executionMode`. |
| `LLM_DEFAULT_TIER_A_THRESHOLD` | `0.8` | Default applied when the request omits `tierAThreshold`. |
| `LLM_DEFAULT_TIER_B_THRESHOLD` | `0.6` | Default applied when the request omits `tierBThreshold`. |
| `LLM_DEFAULT_MIN_TIER` | `tier-a` | Default applied when the request omits `minTier`. |
| `LLM_DEFAULT_FIELD_CITATIONS` | off | `true`/`1` or `false`/`0`: default for `fieldCitations`. Unset: `fieldCitations` is absent from the defaults. |
| `LLM_DEFAULT_REVIEW` | off | `true`/`1`: defaults get `review: {}` (review routing with the default thresholds). |

Invalid env values (unknown enum, non-numeric threshold, out-of-range threshold) produce a `console.warn` at boot and the field falls back to the built-in default. The pipeline never refuses to start because of a bad env var.

### Priority order

1. Per-request field on `DocumentPipelineRequest`.
2. Matching `LLM_DEFAULT_*` env var (read once via `loadPipelineDefaults()`).
3. Built-in default.

---

## ZIP Archives

ZIP support is in `zip.ts`. When `fileRecord.mimeType === "application/zip"`:

1. Each entry is run through Stage 1 ingest (MIME validation, size, SHA-256).
2. Each entry is run through Stage 2 decompose.
3. Unit indices are renumbered into a single submission-wide sequence.
4. Each unit is stamped with `sourceFileIndex` pointing into `fileRecords`.
5. The archive container itself is **not** in `fileRecords` — only the data files inside. The container's hash and metadata are preserved in the processing log.
6. Per-entry failures (empty / oversize / unsupported MIME / nested ZIP / corrupt deflate) become **warnings**; sibling entries continue.
7. Nested ZIPs (an entry whose detected MIME is `application/zip`) are **rejected** with a warning. Recursion is one level deep only.
8. `request.zipParallelism` selects sequential vs parallel processing. Both modes produce identical `fileRecords` and `units` (same archive order); only timing and processing-log ordering differ.

---

## Document Policies

Policies are natural-language rule sets injected into Tier-B and Tier-C prompts:

- `DocumentPolicy` — `{ name, version, contentHash, policyText }` (SHA-256 of the policy text computed at registration).
- `DocumentPolicyRegistry` — in-memory store with `register(name, text, version?)`, `get(name)`, `list()`, `remove(name)`, `size`. Also exported as `defaultPolicyRegistry` (module-level singleton, useful for apps that want a single default).
- `buildClassificationPrompt(policy, group, units, extractions, context?)` — produces `{ systemPrompt, userPrompt }`.
- `buildFieldExtractionPrompt(fieldName, documentLabel, policy?)` — focused single-field prompt for Tier-C refinement.

When no policy is provided, the prompts run in **open-vocabulary mode** — the model classifies freely, marking everything as `unsupported: false`.

Audit trail: every `AnalysisPackage` records the governing policy as `policyRef: { name, version, contentHash }` (also when the pipeline aborts at ingest, so the log shows which policy was requested), and the continuation prompt cites it as `name@version#contentHash`. `policyRef` is `null` in open-vocabulary mode or when the named policy is not registered.

For loading policy bodies from external files (manifest + Markdown bodies), see the sibling package [`@maya-ai/document-policies`](https://www.npmjs.com/package/@maya-ai/document-policies). It emits a plain `LoadedPolicy[]`; the consumer app glues those into a `DocumentPolicyRegistry`.

---

## Multimodal (Tier C)

Real image bytes are transmitted, not text hints. `PipelineLlmRequest.images` carries `{ data: <base64>, mimeType }` parts. Adapters that don't support multimodal (e.g. a disabled stub) ignore the field.

LLM-assisted segmentation in `full-multimodal` mode attaches up to **12** page images (the first image per unit). When images are attached, the prompt enumerates which page indices the model is seeing.

---

## Continuation handlers

When `request.taskIntent` is set and `deps.continuationHandler` is provided, the pipeline runs a final stage that turns the analysis package into a task-shaped result. Two built-in handlers ship with the package:

| Factory | Behaviour |
|---|---|
| `createLlmContinuationHandler(llm, options?)` | Calls the LLM with a structured prompt; expects JSON back. Useful for "extract the address and name from the ID card". |
| `createPassthroughContinuationHandler()` | Resolves the task by collecting all extracted fields directly from the package. No LLM call. Useful as a test double or a deterministic fallback. |

Apps are free to plug in any `ContinuationHandler` — the pipeline core never decides which one to use.

---

## Field citations (opt-in)

With `fieldCitations: true`, every extracted field carries evidence that the pipeline has **checked**:

```ts
type FieldCitation = {
  unitIndex: number;         // unit the quote was found in
  sourceFileIndex: number;   // file within the submission
  page: number;              // 1-based page within that file
  quote: string;             // the quoted text (trimmed, ≤ 300 chars)
  textSpan?: { start; end }; // character span in unitExtractions[unit].text, when found
  boundingBox?: BoundingBox; // normalized box over the OCR words of the span, when the unit has any
  status: "verified" | "not-found" | "unverifiable" | "deterministic";
};
```

- **Tier B / C** ask the model for a verbatim `quote` per field (one extra key in the output schema; Tier B's answer cap grows from 1 024 to 2 048 tokens). The pipeline then looks for the quote in the units' **full** extracted text, ignoring case, Unicode width forms and whitespace. It checks the unit the model named first, then the group's other units. A found quote is `verified`. A quote that is not in any unit's text is `not-found`. When the named unit has no text (image only), the quote cannot be checked and is `unverifiable`. Low-confidence refinement in Tier C asks for a quote too, and that refined quote is the one checked.
- **Tier A** MRZ fields cite their MRZ line with status `deterministic`.
- **Unit correction:** when a quote is found in a different unit of the group than the one reported, `sourceUnitIndex` is set to the unit that holds it. For model-reported fields, the group also gets the flag `source-unit-corrected:<field>`.
- **Boxes** come from positioned `LayoutBlock`s, which today means OCR word boxes. Native PDF text has no positions yet, so those citations have a span but no box. `ExtractedField.boundingBox` is set from the citation's box.
- **Confidence is never rewritten.** A `not-found` citation leaves the field's `confidence` as reported. Use the status, or review routing, to act on it.
- Fields with an empty value, or for which the model gave no quote, get `citations: []`. Without the option, prompts and output are unchanged (no `citations` key).
- Helpers: `findQuoteSpan(text, quote)`, `boxForSpan(text, blocks, span)`, `citeQuote(field, quote, context)`, `attachFieldCitations(group, quotes, context)`, `MAX_CITATION_QUOTE_CHARS`. The prompt builders `buildClassificationPrompt(…, options?)` and `buildFieldExtractionPrompt(…, options?)` take `{ fieldCitations }` (`ClassificationPromptOptions`).

## Review routing (opt-in)

Pass `review` thresholds (`{}` for the defaults). The assemble stage then decides, for each group, whether a person should check it, and why:

```ts
const { analysisPackage } = await runDocumentPipeline({ …, fieldCitations: true, review: { fieldConfidence: 0.7 } }, deps);
if (analysisPackage.review?.required) queueForReview(analysisPackage.review.reasons);
```

| Threshold (`ReviewThresholds`) | Default | Reason code when hit |
|---|---|---|
| `segmentationConfidence` | `0.6` (`DEFAULT_REVIEW_THRESHOLDS`) | `low-segmentation-confidence` (the `0.5` unsegmented fallback is under it) |
| — | — | `unknown-type` (label `unknown` or no classifier result), `unsupported-type` (the policy does not cover the type) |
| `classificationConfidence` | `0.6` | `low-classification-confidence` |
| `fieldConfidence` | `0.5` | `low-field-confidence` (per field) |
| — | — | `citation-not-found`: a field whose citations include `not-found` and none `verified`/`deterministic` (needs `fieldCitations`) |
| `requireVerifiedCitations` | `false` | `citation-unverifiable`: a field whose citations are only `unverifiable` |
| `reviewFlags` | none | `flagged`: an `uncertaintyFlags` entry in this list (the flag is in `detail`) |
| `ignoreFields` | none | listed fields skip the field rules |

- Each `ClassifiedDocumentGroup` gets `review: { required, reasons }`, with reasons in the order of the table above. `AnalysisPackage.review` holds all groups' reasons in group order. A reason is `{ code, groupId, fieldName?, detail? }`. `detail` gives the compared numbers, for example `"0.4 < 0.6"`.
- The processing log gets `{ stage: "review", status: "ok", detail: "<n> of <m> groups need review" }`.
- Without `review`, nothing is added. A package that stops before assembly (for example a failed ingest) has no `review`.
- Helpers: `reviewGroup(group, segmentConfidence, thresholds)` and `reviewGroups(groups, segmentationMap, thresholds)` (pure; the groups are copied).

---

## Lower-level helpers

`runDocumentPipeline` is the normal entry point. These exports let you run or test single stages:

| Export | Purpose |
|---|---|
| `detectMimeType({ buffer, fileName?, declaredMimeType? })` | The MIME type ingestion would use: magic bytes first, then the file extension, then the declared type; a generic container (zip, octet-stream) does not override a specific extension. |
| `SUPPORTED_MIME_TYPES` | `Set` of accepted MIME types (PDF, common images, Office formats, CSV, text, Markdown, …). |
| `EmptyFileError`, `FileTooLargeError` (`sizeBytes`, `maxBytes`), `UnsupportedFileTypeError` (`detectedMimeType`) | Thrown by `ingestFile`. `runDocumentPipeline` catches them and returns a failed package with the reason in the processing log. |
| `DEFAULT_EXTRACTION_LIMITS` | `{ maxPages: 20, maxPixels: 8_000_000, minTextChars: 200 }`, used by `extractUnit` for limits you leave out. |
| `BUILT_IN_DEFAULTS` | `{ executionMode: "hybrid", tierAThreshold: 0.8, tierBThreshold: 0.6, minTier: "tier-a" }`, the last step of the [priority order](#priority-order). |
| `createNullOcrPlugin()` | An `OCRPlugin` that recognizes nothing; a safe default and test double. |
| `validateOcrPlugin(value)` | Type guard: does `value` have the `OCRPlugin` shape? Use it to catch misconfiguration at boot. |
| `wordBoxesToLayoutBlocks(ocrResult, imageWidth, imageHeight)` | Converts OCR word boxes in pixels to `LayoutBlock`s with normalized (0–1) boxes; boxes already normalized pass through. |
| `buildContinuationPrompt(pkg, taskIntent, appContext?)` | The prompt `createLlmContinuationHandler` sends; pure, for tests or custom handlers. |
| `createProcessingLog()`, `logStage(log, stage, status, detail?, startMs?)` | Build a processing log the way the pipeline does (`durationMs` from `startMs`). |

---

## Integration

The pipeline has zero opinion about HTTP, authentication, persistence, multi-tenancy, or job queues. A typical wiring:

1. Build a `PipelineLlmAdapter` that wraps your concrete LLM provider (e.g. one built from [`@maya-ai/llm-profiles`](https://www.npmjs.com/package/@maya-ai/llm-profiles)).
2. Optionally build an `OCRPlugin` for image / scanned-PDF text recovery.
3. Optionally build a `DocumentPolicyRegistry` and (re)load policy bodies from disk using [`@maya-ai/document-policies`](https://www.npmjs.com/package/@maya-ai/document-policies).
4. In your route handler, read the raw upload, construct a `DocumentPipelineRequest`, and call `runDocumentPipeline(request, deps)`.
5. Persist or return `result.analysisPackage` and `result.continuationResult` (when present).

## Exported types

Types not shown elsewhere in this README, by area:

- **Request and package:** `DocumentPipelineExecutionMode` (`"deterministic-first" | "hybrid" | "full-multimodal"`), `DocumentPipelineContext` (`{ language?, country?, submissionIntent? }`), `FileRecord` (one ingested file: name, SHA-256, size, MIME type, time), `ProcessingLogEntry` (`{ stage, status, detail?, durationMs? }`).
- **Units and extraction:** `DocumentUnit` / `DocumentUnitKind` (`"page" | "image" | "sheet" | "section" | "text-block"`), `UnitExtractionResult`, `ExtractedImage`, `BoundingBox` with `CoordSpace` (`"pixels" | "normalized"`), `ExtractionLimits`, and the extractor plugin types `ExtractorPluginRequest` / `ExtractorPluginResult`.
- **OCR:** `OCRResult` (`{ text, wordBoxes?, confidence?, detectedLanguage? }`), `OCRWordBox` and `OCROptions` (`{ language?, requestLayout? }`).
- **Segmentation and classification:** `SegmentationRequest`, `SegmentationMap` (`{ groups }`), `SegmentationMethod` (`"structural" | "llm-assisted" | "single-group"`), `ClassificationRequest`, `ClassificationSourceDocument` (a source file passed for native PDF), `ClassificationTier` (`"tier-a" | "tier-b" | "tier-c"`), `ClassifiedDocumentGroup` and `ExtractedField` (`{ name, value, confidence, sourceUnitIndex, boundingBox?, method, citations? }`), `FieldCitation` / `FieldCitationStatus` (see [Field citations](#field-citations-opt-in)), `CitationContext` (`{ group, units, extractions }`), and for review routing `ReviewThresholds`, `ReviewDecision` (`{ required, reasons }`), `ReviewReason` and `ReviewReasonCode` (see [Review routing](#review-routing-opt-in)).
- **LLM adapter parts:** `PipelineImage` (`{ data, mimeType }`) and `PipelineDocument` (`{ data, mimeType, name? }`).
- **Assembly and continuation:** `AssemblyInput`, `ContinuationRequest`, `ContinuationResult` (`{ results, evidence, unresolvedItems, suggestedNextSteps }`), `ContinuationEvidence`, `UnresolvedItem` and `LlmContinuationOptions` (`{ maxTokens?, sessionIdPrefix? }`).
- **ZIP:** `ZipExpansionOptions` (`{ maxEntryBytes?, maxUnits?, parallelism? }`), `ZipExtractionParallelism` (`"sequential" | "parallel"`) and `ZipExpansionResult` (`{ fileRecords, entryBuffers, units, warnings }`).

## License

MIT.

## Provenance

This component was generated and refined with a merry gang of AI tools. Humans were mostly enlisted for testing, red-pen moments, and keeping the robots from getting too cheeky.
