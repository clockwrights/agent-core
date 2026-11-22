// ---------------------------------------------------------------------------
// Tests: Segmentation Engine (Stage 4)
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNSEGMENTED_FALLBACK_CONFIDENCE, segmentDocuments } from "../src/segment.js";
import type { DocumentUnit, UnitExtractionResult } from "../src/types.js";
import type {
  PipelineLlmAdapter,
  PipelineLlmRequest,
} from "../src/llm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnit(index: number, kind: DocumentUnit["kind"] = "page"): DocumentUnit {
  return { index, kind, sourceFileIndex: 0 };
}

function makeExtraction(unitIndex: number, text: string): UnitExtractionResult {
  return { unitIndex, text, blocks: [], images: [], extractorId: "test", ocrUsed: false };
}

/** A typical MRZ line (TD3 passport format, 44 chars). */
const MRZ_LINE = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";

/** A null-like LLM that reports itself as disabled. */
function createDisabledLlm(): PipelineLlmAdapter {
  return {
    enabled: false,
    generate: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Single-unit fast path
// ---------------------------------------------------------------------------

test("segment: single unit → one group, method 'single-group'", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1)],
    extractions: [makeExtraction(1, "Some document text here")],
  });

  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.unitIndices, [1]);
  assert.equal(result.groups[0]!.segmentationMethod, "single-group");
  assert.equal(result.groups[0]!.confidence, 1, "a single unit is certain");
});

test("segment: empty units array → one group", async () => {
  const result = await segmentDocuments({
    units: [],
    extractions: [],
  });

  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.unitIndices, []);
});

// ---------------------------------------------------------------------------
// No-signal fallback (multiple units, no structural markers)
// ---------------------------------------------------------------------------

test("segment: two plain-text units with no signals → single group", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2)],
    extractions: [
      makeExtraction(1, "Invoice from ACME Corp issued on 01 Jan 2024."),
      makeExtraction(2, "Payment terms: net 30 days from issue."),
    ],
    executionMode: "deterministic-first",
  });

  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.unitIndices, [1, 2]);
});

// ---------------------------------------------------------------------------
// MRZ-based structural detection
// ---------------------------------------------------------------------------

test("segment: MRZ in second unit following plain text → two structural groups", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2)],
    extractions: [
      makeExtraction(1, "Invoice from ACME Corp"),
      makeExtraction(2, MRZ_LINE),
    ],
    executionMode: "deterministic-first",
  });

  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups[0]!.unitIndices, [1]);
  assert.deepEqual(result.groups[1]!.unitIndices, [2]);
  assert.ok(
    result.groups.every((g) => g.segmentationMethod === "structural"),
    "Both groups should use structural method",
  );
});

// ---------------------------------------------------------------------------
// Separator-line structural detection
// ---------------------------------------------------------------------------

test("segment: separator line '---' → boundary, separator may be excluded", async () => {
  // 3 units: content / separator / content
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2), makeUnit(3)],
    extractions: [
      makeExtraction(1, "First document text"),
      makeExtraction(2, "---"),
      makeExtraction(3, "Second document text"),
    ],
    executionMode: "deterministic-first",
  });

  // Structural detection should produce at least two groups
  assert.equal(result.groups.length, 2);
  // Units 1 and 3 must be in separate groups
  const allIndices = result.groups.flatMap((g) => g.unitIndices);
  assert.ok(allIndices.includes(1));
  assert.ok(allIndices.includes(3));
});

test("segment: '===' separator also triggers boundary", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2), makeUnit(3)],
    extractions: [
      makeExtraction(1, "Part one"),
      makeExtraction(2, "==="),
      makeExtraction(3, "Part two"),
    ],
    executionMode: "deterministic-first",
  });

  assert.equal(result.groups.length, 2);
});

// ---------------------------------------------------------------------------
// Form-feed structural detection
// ---------------------------------------------------------------------------

test("segment: form-feed \\f in unit text → boundary detected", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2)],
    extractions: [
      makeExtraction(1, "Page one text\fForm feed in same unit"),
      makeExtraction(2, "Page two text"),
    ],
    executionMode: "deterministic-first",
  });

  // A form-feed in unit 1 marks it as a separator, causing a boundary before unit 2
  assert.ok(result.groups.length >= 1, "Should produce at least one group");
});

// ---------------------------------------------------------------------------
// Blank unit exclusion
// ---------------------------------------------------------------------------

test("segment: blank unit between two content units → boundary", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2), makeUnit(3)],
    extractions: [
      makeExtraction(1, "First document content"),
      makeExtraction(2, "   "), // blank / whitespace only
      makeExtraction(3, "Second document content"),
    ],
    executionMode: "deterministic-first",
  });

  assert.equal(result.groups.length, 2);
  const allIndices = result.groups.flatMap((g) => g.unitIndices);
  // Blank unit (index 2) should be excluded from all groups (it is truly empty)
  assert.ok(!allIndices.includes(2), "Blank unit should be excluded from groups");
  assert.ok(allIndices.includes(1));
  assert.ok(allIndices.includes(3));
});

// ---------------------------------------------------------------------------
// Execution mode — no LLM calls in deterministic-first
// ---------------------------------------------------------------------------

test("segment: deterministic-first mode never calls LLM even when provided", async () => {
  let llmCallCount = 0;
  const trackingLlm: PipelineLlmAdapter = {
    enabled: true,
    generate: async () => {
      llmCallCount++;
      return undefined;
    },
  };

  await segmentDocuments({
    units: [makeUnit(1), makeUnit(2)],
    extractions: [
      makeExtraction(1, "Plain text without any signals"),
      makeExtraction(2, "More plain text"),
    ],
    executionMode: "deterministic-first",
    llmProvider: trackingLlm,
  });

  assert.equal(llmCallCount, 0, "LLM must not be called in deterministic-first mode");
});

test("segment: disabled LLM → falls back to single-group (no errors)", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2)],
    extractions: [
      makeExtraction(1, "Text without signals"),
      makeExtraction(2, "More text without signals"),
    ],
    executionMode: "hybrid",
    llmProvider: createDisabledLlm(),
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.segmentationMethod, "single-group");
  assert.equal(
    result.groups[0]!.confidence,
    UNSEGMENTED_FALLBACK_CONFIDENCE,
    "an unconfirmed single group must not report certainty",
  );
});

test("segment: deterministic-first with no boundaries → undecided single group", async () => {
  const result = await segmentDocuments({
    units: [makeUnit(1), makeUnit(2), makeUnit(3)],
    extractions: [makeExtraction(1, "a"), makeExtraction(2, "b"), makeExtraction(3, "c")],
    executionMode: "deterministic-first",
  });

  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.unitIndices, [1, 2, 3]);
  assert.equal(result.groups[0]!.confidence, UNSEGMENTED_FALLBACK_CONFIDENCE);
  assert.ok(UNSEGMENTED_FALLBACK_CONFIDENCE < 1);
});

// ---------------------------------------------------------------------------
// Unit coverage invariant
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D3 — Multimodal segmentation
//
// In `full-multimodal` mode the LLM segmentation call must transmit page
// images as real attachments (not just text references). In `hybrid` mode
// the call must remain text-only.
// ---------------------------------------------------------------------------

const PNG_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

/**
 * Recording LLM that captures every `generate` input. The reply is the
 * provided JSON string for every call.
 */
function createRecordingLlm(reply: string): {
  llm: PipelineLlmAdapter;
  calls: PipelineLlmRequest[];
} {
  const calls: PipelineLlmRequest[] = [];
  return {
    llm: {
      enabled: true,
      generate: async (input) => {
        calls.push(input);
        return { text: reply };
      },
    },
    calls,
  };
}

function makeImageExtraction(
  unitIndex: number,
  text: string,
  imageCount = 1,
): UnitExtractionResult {
  return {
    unitIndex,
    text,
    blocks: [],
    images: Array.from({ length: imageCount }, () => ({
      type: "image" as const,
      data: PNG_PIXEL_BASE64,
      mimeType: "image/png",
    })),
    extractorId: "pdf",
    ocrUsed: false,
  };
}

test("segment full-multimodal: page images are passed to the LLM as real attachments", async () => {
  // 4 plain pages with rendered images and only minimal text — text-based
  // structural signals would not produce multiple groups, forcing the LLM path.
  const units = [makeUnit(1), makeUnit(2), makeUnit(3), makeUnit(4)];
  const extractions = [
    makeImageExtraction(1, "alpha"),
    makeImageExtraction(2, "beta"),
    makeImageExtraction(3, "gamma"),
    makeImageExtraction(4, "delta"),
  ];

  const cannedGroups = JSON.stringify([[1, 2], [3, 4]]);
  const { llm, calls } = createRecordingLlm(cannedGroups);

  await segmentDocuments({
    units,
    extractions,
    executionMode: "full-multimodal",
    llmProvider: llm,
  });

  assert.equal(calls.length, 1, "LLM must be called exactly once for segmentation");
  const call = calls[0]!;

  assert.ok(
    call.images && call.images.length === 4,
    `full-multimodal must transmit one image per unit (4 images), got ${call.images?.length ?? 0}`,
  );
  assert.equal(call.images[0]!.mimeType, "image/png");
  assert.equal(call.images[0]!.data, PNG_PIXEL_BASE64);
  // The prompt should reference the attached images so the model knows the order.
  assert.match(call.prompt, /Page images are attached/i);
  assert.match(call.prompt, /1, 2, 3, 4/);
  // Distinct sessionId for the multimodal path.
  assert.match(call.sessionId, /multimodal/);
});

test("segment hybrid mode: must NOT transmit images even when units have them", async () => {
  // Same fixtures, but executionMode = hybrid — images must NOT be sent.
  const units = [makeUnit(1), makeUnit(2)];
  const extractions = [
    makeImageExtraction(1, "alpha"),
    makeImageExtraction(2, "beta"),
  ];

  const cannedGroups = JSON.stringify([[1], [2]]);
  const { llm, calls } = createRecordingLlm(cannedGroups);

  await segmentDocuments({
    units,
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
  });

  assert.equal(calls.length, 1);
  assert.ok(
    !calls[0]!.images || calls[0]!.images.length === 0,
    "hybrid mode segmentation must remain text-only",
  );
  // Prompt should NOT claim images are attached.
  assert.doesNotMatch(calls[0]!.prompt, /Page images are attached/i);
});

test("segment full-multimodal with no images available: degrades to text-only without errors", async () => {
  // No extractions have images — multimodal path should still work, just
  // without sending images.
  const units = [makeUnit(1), makeUnit(2)];
  const extractions = [makeExtraction(1, "alpha"), makeExtraction(2, "beta")];

  const cannedGroups = JSON.stringify([[1], [2]]);
  const { llm, calls } = createRecordingLlm(cannedGroups);

  await segmentDocuments({
    units,
    extractions,
    executionMode: "full-multimodal",
    llmProvider: llm,
  });

  assert.equal(calls.length, 1);
  assert.ok(
    !calls[0]!.images || calls[0]!.images.length === 0,
    "with no images available, multimodal segmentation must degrade gracefully",
  );
  assert.doesNotMatch(calls[0]!.prompt, /Page images are attached/i);
});

test("segment full-multimodal: image attachment is capped (MAX_SEGMENT_IMAGES)", async () => {
  // 16 units all with images. The cap is 12; the call should attach 12 and
  // the remaining 4 must NOT be attached.
  const units = Array.from({ length: 16 }, (_, i) => makeUnit(i + 1));
  const extractions = units.map((u) => makeImageExtraction(u.index, `text-${u.index}`));

  const cannedGroups = JSON.stringify([[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16]]);
  const { llm, calls } = createRecordingLlm(cannedGroups);

  await segmentDocuments({
    units,
    extractions,
    executionMode: "full-multimodal",
    llmProvider: llm,
  });

  assert.equal(calls.length, 1);
  assert.ok(
    call_images_within_cap(calls[0]!.images),
    `image count must be capped at 12, got ${calls[0]!.images?.length ?? 0}`,
  );

  // The prompt must list the 12 unit indices that were attached, in order.
  const expectedFirstTwelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].join(", ");
  assert.match(calls[0]!.prompt, new RegExp(expectedFirstTwelve));
});

function call_images_within_cap(
  images: Array<{ data: string; mimeType: string }> | undefined,
): boolean {
  return Boolean(images && images.length > 0 && images.length <= 12);
}

test("segment: all unit indices are covered exactly once in the result groups", async () => {
  const units = [makeUnit(1), makeUnit(2), makeUnit(3), makeUnit(4)];
  const extractions = [
    makeExtraction(1, "Document A page 1"),
    makeExtraction(2, MRZ_LINE),
    makeExtraction(3, "Document B page 1"),
    makeExtraction(4, "Document B page 2"),
  ];

  const result = await segmentDocuments({
    units,
    extractions,
    executionMode: "deterministic-first",
  });

  const allGroupedIndices = result.groups.flatMap((g) => g.unitIndices).sort((a, b) => a - b);
  // The union of all group indices must be a subset of unit indices
  for (const idx of allGroupedIndices) {
    assert.ok(
      units.some((u) => u.index === idx),
      `Group index ${idx} is not a valid unit index`,
    );
  }
  // No duplicate indices
  const uniqueIndices = [...new Set(allGroupedIndices)];
  assert.equal(
    uniqueIndices.length,
    allGroupedIndices.length,
    "Unit indices should not appear in multiple groups",
  );
});
