# Document Pipeline

> **Reusable component.** Lives at `server/src/document-pipeline/`. Self-contained — zero imports from outside the directory except external npm deps and node built-ins. This document travels with the component.

App-agnostic capability that ingests files (PDF, images, Office docs, ZIP archives, plain text) and produces a normalised analysis package: per-file records, per-unit text and rendered images, document segmentation, three-tier classification with field extraction, and an optional continuation handler that produces task-specific output.

---

## Public API

```ts
import { runDocumentPipeline } from "./document-pipeline/pipeline.js";
import type {
  DocumentPipelineRequest,
  DocumentPipelineResult,
  DocumentPipelineDeps,
} from "./document-pipeline/pipeline.js";

const result: DocumentPipelineResult = await runDocumentPipeline(request, deps);
```

`DocumentPipelineDeps` (all optional):

| Field | Type | Purpose |
|-------|------|---------|
| `llmProvider` | `PipelineLlmAdapter` | Used by Tier B classification, segmentation, continuation. See `./llm.ts`. |
| `tierCAdapter` | `PipelineLlmAdapter` | Multimodal Tier-C-specific provider. Falls back to `llmProvider` when omitted. |
| `ocrPlugin` | `OCRPlugin` | Injected into the extraction stage. |
| `policyRegistry` | `DocumentPolicyRegistry` | Resolves `request.policyName` to a `DocumentPolicy`. |
| `extraExtractors` | `ExtractorPlugin[]` | Merged with the built-in extractors. |
| `continuationHandler` | `ContinuationHandler` | Called after assembly when `request.taskIntent` is present. |

The pipeline depends on a **narrow LLM adapter** (`PipelineLlmAdapter` in `./llm.ts`), not on any concrete provider:

```ts
export interface PipelineLlmAdapter {
  readonly enabled: boolean;
  generate(request: PipelineLlmRequest): Promise<PipelineLlmResponse | undefined>;
}
```

Apps wrap their concrete `LlmProvider` into this shape via a small shim (in this app: `server/src/llm/pipeline-adapter.ts`).

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

---

## Three-Tier Classification Cascade

Each segmented document group is classified by a cascade. Each tier has a confidence threshold; results above the threshold short-circuit the next tier.

| Tier | Mechanism | Cost | Runs when |
|------|-----------|------|-----------|
| **A — Deterministic** | MRZ regex (TD3 passport / TD2 / TD1 ID), barcode anchor (CODE128/PDF417/QR/etc.), heuristic field parsing | None | Always (unless `minTier=tier-b` or `tier-c`) |
| **B — LLM text** | Policy-injected text prompt with extracted text snippets | One LLM call | Tier A confidence below `tierAThreshold` AND `executionMode != deterministic-first` |
| **C — Multimodal LLM** | Same prompt + actual rendered page images attached as `ImageContent` parts | One+ LLM calls with image bytes | Tier B confidence below `tierBThreshold` AND group has rendered images AND `executionMode` is `hybrid` or `full-multimodal` |

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
| `policyName` | string | Named policy in the registry (open-vocabulary if absent) |
| `taskIntent` | string | Continuation goal — gates whether the continuation handler runs |
| `language` | BCP-47 | Hint, e.g. `en`, `ar-EG` |
| `country` | ISO 3166-1 alpha-2 | Hint, e.g. `US`, `DE` |
| `zipParallelism` | enum | `sequential \| parallel`. Sequential is deterministic; parallel is faster on archives with many small entries. |
| `limits` | `DocumentPipelineLimits` | Override per-request budgets (max units, max pixels, max bytes, etc.). |

`request.context.submissionIntent` (separate from `taskIntent`) is a hint about why the submission was made; it flows into the segmentation LLM prompt and the continuation handler's `appContext`.

### Server-wide defaults via env (parsed by `pipeline-config.ts`)

When the consumer app calls `loadPipelineDefaults()`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_DEFAULT_EXECUTION_MODE` | `hybrid` | Default applied when the request omits `executionMode`. |
| `LLM_DEFAULT_TIER_A_THRESHOLD` | `0.8` | Default applied when the request omits `tierAThreshold`. |
| `LLM_DEFAULT_TIER_B_THRESHOLD` | `0.6` | Default applied when the request omits `tierBThreshold`. |
| `LLM_DEFAULT_MIN_TIER` | `tier-a` | Default applied when the request omits `minTier`. |

Invalid env values (unknown enum, non-numeric threshold, out-of-range threshold) produce a `console.warn` at boot and the field falls back to the built-in default. The pipeline never refuses to start because of a bad env var.

### Priority order

1. Per-request field on `DocumentPipelineRequest`
2. Matching `LLM_DEFAULT_*` env var (read once at boot)
3. Built-in default in `pipeline-config.ts`

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

Policies are natural-language rule sets (spec §6) injected into Tier-B and Tier-C prompts. Implementation lives in `policy.ts`:

- `DocumentPolicy` — `{ name, version, contentHash, policyText }` (SHA-256 hash computed at registration).
- `DocumentPolicyRegistry` — in-memory store with `register(name, text, version?)`, `get(name)`, `list()`, `remove(name)`, `size`.
- `buildClassificationPrompt(policy, group, units, extractions, context?)` — produces `{ systemPrompt, userPrompt }`.
- `buildFieldExtractionPrompt(fieldName, documentLabel, policy?)` — focused single-field prompt for Tier-C refinement.

When no policy is provided, the prompts run in **open-vocabulary mode** — the model classifies freely, marking everything as `unsupported: false`.

For loading policy bodies from external files (manifest + Markdown bodies), see [`document-policies`](./document-policies.md) — that's a separate reusable component dedicated to policy loading.

---

## Multimodal (Tier C)

Real image bytes are transmitted, not text hints. The pipeline's `PipelineLlmRequest.images?: PipelineImage[]` carries `{ data: <base64>, mimeType }` parts. Adapters that don't support multimodal (e.g. a disabled stub) ignore the field.

Stage 4 LLM-assisted segmentation in `full-multimodal` mode attaches up to **12** page images (first image per unit, capped at `MAX_SEGMENT_IMAGES`). When images are attached, the prompt enumerates which page indices the model is seeing.

---

## HTTP Integration Sketch

The pipeline doesn't include HTTP wiring — that's the consumer app's job. In this app, `server/src/routes/documents.ts` exposes:

```
POST /api/documents/analyze
GET  /api/documents/policies
```

with raw-body uploads (`Content-Type: <file mime type>`, up to 50 MB) and query params for the per-request fields above. Errors return `{ error, details? }` with appropriate HTTP status.

---

## Tests

In this app, tests live at `server/test/document-pipeline/`:

| File | Purpose |
|------|---------|
| `ingest.test.ts` | MIME detection, ingest validation |
| `decompose.test.ts` | Per-format decomposition |
| `ocr.test.ts` | OCR plugin contract, coordinate normalisation |
| `policy.test.ts` | Registry + prompt builders |
| `assemble.test.ts` | Package assembly + log validation |
| `segment.test.ts` | Structural + LLM-assisted segmentation, multimodal segmentation |
| `classify.test.ts` | Three-tier cascade, threshold semantics, `minTier`, Tier-C image attachment |
| `pdf-extractor.test.ts` | A2 regression — pdfjs render API |
| `continue.test.ts` | LLM and passthrough continuation handlers |
| `pipeline.test.ts` | End-to-end orchestration |
| `route.test.ts` | HTTP integration via supertest |
| `zip.test.ts` | ZIP support and per-entry failure modes |
| `pipeline-config.test.ts` | Env-default parsing |

Run via `npm run test:document-pipeline`. All tests use disabled or recording mocks — no live LLM, no OCR provider.

---

## Extracting to Another App

1. Copy or package `server/src/document-pipeline/`.
2. Keep runtime deps: `pdfjs-dist@4`, `xlsx`, `file-type@19`, `adm-zip@0.5`, `@napi-rs/canvas`.
3. Provide a concrete `PipelineLlmAdapter` (wrap your app's LLM provider — see `server/src/llm/pipeline-adapter.ts` for a one-screen example).
4. Optionally provide an `OCRPlugin` for image/PDF text recovery.
5. Optionally provide a `DocumentPolicyRegistry` (see [`document-policies`](./document-policies.md) for a reusable manifest-based loader).
6. Wire HTTP routes (raw-body upload, query schema validation) and call `runDocumentPipeline(request, deps)`.

The pipeline has zero opinion about authentication, persistence, multi-tenancy, or job queues.
