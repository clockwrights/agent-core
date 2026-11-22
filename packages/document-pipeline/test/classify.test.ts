// ---------------------------------------------------------------------------
// Tests: classify.ts — Tier A / Tier B / Tier C dispatch
//
// Critical regression coverage:
//
//   A1 (silent threshold no-op) — `classify.ts` previously read `tierA.confidence`
//   which does not exist on `ClassifiedDocumentGroup` (the field is
//   `classificationConfidence`). Both Tier A and Tier B threshold checks were
//   no-ops because `undefined >= 0.8` is always false. This file verifies the
//   thresholds actually work end-to-end:
//
//     - A clear TD3 MRZ in extracted text MUST classify at Tier A
//       (label: "passport", classificationTier: "tier-a") and MUST stop there
//       even when an LLM provider is supplied.
//
//     - Below-threshold tier-A signals (none / barcode-only) MUST fall through
//       to Tier B when an enabled LLM is provided.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGroups } from "../src/classify.js";
import type {
  DocumentGroup,
  DocumentUnit,
  UnitExtractionResult,
} from "../src/types.js";
import type {
  PipelineLlmAdapter,
  PipelineLlmRequest,
} from "../src/llm.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeDisabledLlm(): PipelineLlmAdapter {
  return {
    enabled: false,
    generate: async () => undefined,
  };
}

/**
 * Returns an LLM whose `generate` records every call (full request) and
 * replies with the given canned JSON. Use this to inspect what was actually
 * sent to the LLM — including the `images` field for multimodal calls.
 *
 * The reply can be a single canned JSON string (replied for every call) or
 * a function that picks a reply based on call ordinal / input.
 */
function makeRecordingLlm(reply: string | ((input: PipelineLlmRequest, n: number) => string)): {
  llm: PipelineLlmAdapter;
  calls: PipelineLlmRequest[];
} {
  const calls: PipelineLlmRequest[] = [];
  const llm: PipelineLlmAdapter = {
    enabled: true,
    generate: async (input) => {
      calls.push(input);
      const text = typeof reply === "function" ? reply(input, calls.length) : reply;
      return { text };
    },
  };
  return { llm, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_GROUP: DocumentGroup = {
  id: "group-1",
  unitIndices: [1],
  confidence: 1,
  segmentationMethod: "single-group",
};

const SINGLE_UNIT: DocumentUnit = { index: 1, kind: "page", sourceFileIndex: 0 };

/**
 * A canonical TD3 (passport) MRZ. Two lines, 44 chars each, all uppercase
 * letters, digits, and `<` fillers. Matches the regex
 *   /^[A-Z][A-Z0-9<]{29,}$/m
 * used by classify.ts Tier A.
 */
const TD3_MRZ_TEXT = `\
Some surrounding text from OCR.
P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
L898902C36UTO7408122F1204159ZE184226B<<<<<10
More surrounding text.`;

// ---------------------------------------------------------------------------
// E2 — Tier A regression: TD3 MRZ classifies deterministically
// ---------------------------------------------------------------------------

test("classify: TD3 MRZ in extracted text → tier-a passport (regression for A1 threshold no-op)", async () => {
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  // Disabled LLM — no Tier B / C should be needed.
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    llmProvider: makeDisabledLlm(),
  });

  assert.equal(result.length, 1);
  const cg = result[0]!;
  assert.equal(cg.classificationTier, "tier-a", "MRZ must classify at tier A");
  assert.equal(cg.label, "passport");
  assert.equal(cg.unsupported, false);
  assert.ok(
    cg.classificationConfidence >= 0.8,
    `tier-A confidence must clear the 0.8 threshold (got ${cg.classificationConfidence})`,
  );
  // The MRZ parser should pull at least the document number.
  assert.ok(
    cg.fields.some((f) => f.name === "document_number"),
    "expected MRZ field 'document_number' to be extracted",
  );
});

test("classify: TD3 MRZ does NOT call the LLM at all (Tier A short-circuits)", async () => {
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const { llm, calls } = makeRecordingLlm('{"label":"unused"}');
  await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    llmProvider: llm,
  });

  assert.equal(
    calls.length,
    0,
    "Tier A passing the threshold must short-circuit; the LLM must not be called",
  );
});

test("classify: deterministic-first mode skips LLM entirely (no Tier B/C even with LLM)", async () => {
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Plain document with no MRZ and no barcode anchors.",
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const { llm, calls } = makeRecordingLlm('{"label":"unused"}');
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "deterministic-first",
    llmProvider: llm,
  });

  assert.equal(calls.length, 0, "deterministic-first must never call the LLM");
  // Tier A produced no signal, so we expect the unknown fallback.
  assert.equal(result[0]!.label, "unknown");
});

test("classify: when Tier A fails and LLM is enabled, Tier B is invoked", async () => {
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "An ordinary plain document with no anchors.",
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const cannedTierB = JSON.stringify({
    label: "invoice",
    confidence: 0.85,
    unsupported: false,
    fields: [
      { name: "issuer", value: "ACME", confidence: 0.9, sourceUnitIndex: 1 },
    ],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm(cannedTierB);
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
  });

  assert.ok(calls.length >= 1, "Tier B must call the LLM when Tier A is empty");
  assert.equal(result[0]!.classificationTier, "tier-b");
  assert.equal(result[0]!.label, "invoice");
  assert.equal(result[0]!.fields[0]!.method, "llm-text");
});

// ---------------------------------------------------------------------------
// D2 — Tier-C multimodal regression: images must actually be transmitted
//
// Original analysis issue #4: Tier C only appended a text hint about images
// without sending the actual bytes. This block guards against that regressing.
// ---------------------------------------------------------------------------

const PNG_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

test("classify Tier C: rendered images are passed to the LLM as real attachments", async () => {
  // Tier-A returns nothing (plain text, no MRZ / no barcode), Tier-B returns
  // a low-confidence result so Tier-C runs.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Some plain extracted text",
      blocks: [],
      images: [
        { type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" },
        { type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" },
      ],
      extractorId: "pdf",
      ocrUsed: false,
    },
  ];

  const lowConfTierB = JSON.stringify({
    label: "passport",
    confidence: 0.3, // below 0.6 threshold → Tier C runs
    unsupported: false,
    fields: [],
    uncertaintyFlags: ["low-confidence"],
  });
  const tierCResponse = JSON.stringify({
    label: "passport",
    confidence: 0.95,
    unsupported: false,
    fields: [
      { name: "full_name", value: "Jane Doe", confidence: 0.97, sourceUnitIndex: 1 },
    ],
    uncertaintyFlags: [],
  });

  // First call → Tier B (text only); second call → Tier C (must include images).
  const { llm, calls } = makeRecordingLlm((_input, n) => (n === 1 ? lowConfTierB : tierCResponse));
  await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
  });

  // Two LLM calls: Tier B then Tier C.
  assert.ok(calls.length >= 2, `expected at least 2 LLM calls (Tier B + Tier C), got ${calls.length}`);

  const tierBCall = calls[0]!;
  const tierCCall = calls[1]!;

  // Tier B must NOT carry images.
  assert.ok(
    !tierBCall.images || tierBCall.images.length === 0,
    "Tier B (text) must not transmit image attachments",
  );

  // Tier C MUST carry the actual image bytes — this is the regression guard.
  assert.ok(
    tierCCall.images && tierCCall.images.length === 2,
    `Tier C must transmit all 2 group images as real attachments, got ${tierCCall.images?.length ?? 0}`,
  );
  assert.equal(tierCCall.images[0]!.mimeType, "image/png");
  assert.equal(tierCCall.images[0]!.data, PNG_PIXEL_BASE64);
  assert.equal(tierCCall.images[1]!.data, PNG_PIXEL_BASE64);
  // sessionId distinguishes the multimodal call so context doesn't bleed.
  assert.match(tierCCall.sessionId, /multimodal/);
});

test("classify Tier C: refineFieldWithImage call also transmits the image (regression for #4)", async () => {
  // Tier-C returns one low-confidence field (< 0.5) which triggers the
  // refineFieldWithImage path; that call must also carry the image.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Some plain text",
      blocks: [],
      images: [{ type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" }],
      extractorId: "pdf",
      ocrUsed: false,
    },
  ];

  const lowConfTierB = JSON.stringify({
    label: "passport",
    confidence: 0.3,
    unsupported: false,
    fields: [],
    uncertaintyFlags: [],
  });
  const tierCResponse = JSON.stringify({
    label: "passport",
    confidence: 0.85,
    unsupported: false,
    fields: [
      { name: "full_name", value: "?", confidence: 0.2, sourceUnitIndex: 1 },
    ],
    uncertaintyFlags: [],
  });
  const refinedField = JSON.stringify({ value: "Jane Doe", confidence: 0.92 });

  const { llm, calls } = makeRecordingLlm((_input, n) => {
    if (n === 1) return lowConfTierB;   // Tier B
    if (n === 2) return tierCResponse;  // Tier C (group classification)
    return refinedField;                 // Per-field refinement
  });

  await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
  });

  // 3 calls expected: Tier B, Tier C group, then per-field refinement.
  assert.ok(calls.length >= 3, `expected ≥ 3 LLM calls, got ${calls.length}`);
  const refineCall = calls[2]!;
  assert.ok(
    refineCall.images && refineCall.images.length === 1,
    "per-field refinement call must carry the image attachment",
  );
  assert.equal(refineCall.images[0]!.mimeType, "image/png");
  assert.equal(refineCall.images[0]!.data, PNG_PIXEL_BASE64);
});

// ---------------------------------------------------------------------------
// minTier — skip lower tiers
// ---------------------------------------------------------------------------

test("classify minTier=tier-b: Tier A is skipped even when MRZ would qualify", async () => {
  // The MRZ would normally trigger Tier A (which is what classify regression
  // E2 verified). With minTier="tier-b", Tier A must be skipped and the LLM
  // must be called instead.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const cannedTierB = JSON.stringify({
    label: "passport-via-llm",
    confidence: 0.9,
    unsupported: false,
    fields: [{ name: "issued_by", value: "LLM", confidence: 0.9, sourceUnitIndex: 1 }],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm(cannedTierB);
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    minTier: "tier-b",
  });

  assert.equal(calls.length, 1, "LLM must be called — Tier A was skipped");
  assert.equal(result[0]!.classificationTier, "tier-b");
  assert.equal(result[0]!.label, "passport-via-llm");
});

test("classify minTier=tier-b + deterministic-first: Tier A skipped, B blocked → unknown", async () => {
  // Contradictory request: minTier blocks Tier A, executionMode blocks Tier B/C.
  // No tier can run → must fall back to "unknown" (NOT silently use Tier A).
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "deterministic-first",
    llmProvider: makeDisabledLlm(),
    minTier: "tier-b",
  });

  assert.equal(result[0]!.label, "unknown");
  assert.equal(result[0]!.unsupported, true);
});

test("classify minTier=tier-c: Tier A and B skipped, Tier C runs when images exist", async () => {
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT, // Tier A would qualify, but minTier blocks it
      blocks: [],
      images: [{ type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" }],
      extractorId: "pdf",
      ocrUsed: false,
    },
  ];

  const tierCResponse = JSON.stringify({
    label: "passport-multimodal",
    confidence: 0.95,
    unsupported: false,
    fields: [{ name: "verified_visually", value: "yes", confidence: 0.95, sourceUnitIndex: 1 }],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm(tierCResponse);
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    minTier: "tier-c",
  });

  assert.equal(calls.length, 1, "Only the Tier C call should run; Tier B is skipped");
  assert.equal(result[0]!.classificationTier, "tier-c");
  // The Tier C call must carry the actual image bytes.
  assert.ok(calls[0]!.images && calls[0]!.images.length === 1);
});

test("classify minTier=tier-c without images: returns unknown (no salvage to lower tiers)", async () => {
  // minTier="tier-c" requires images; no images → no tier runs → unknown.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [], // no images!
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const { llm, calls } = makeRecordingLlm("{}");
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    minTier: "tier-c",
  });

  assert.equal(calls.length, 0, "Tier C must not be called when no images exist");
  assert.equal(result[0]!.label, "unknown");
  assert.equal(result[0]!.unsupported, true);
});

// ---------------------------------------------------------------------------
// Threshold knobs
// ---------------------------------------------------------------------------

test("classify tierAThreshold=1.0 forces Tier A to fall through to Tier B", async () => {
  // MRZ Tier A produces confidence 0.88. With threshold 1.0, it cannot
  // short-circuit, so the cascade falls through to Tier B.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const cannedTierB = JSON.stringify({
    label: "passport-from-llm",
    confidence: 0.85,
    unsupported: false,
    fields: [],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm(cannedTierB);
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    tierAThreshold: 1.0,
  });

  assert.ok(calls.length >= 1, "Tier B must run because tierAThreshold=1.0 blocks Tier A");
  assert.equal(result[0]!.classificationTier, "tier-b");
});

test("classify tierAThreshold=0 accepts any Tier A result without LLM", async () => {
  // Even a low-confidence Tier A result wins when threshold is 0.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: TD3_MRZ_TEXT,
      blocks: [],
      images: [],
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const { llm, calls } = makeRecordingLlm("{}");
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    tierAThreshold: 0,
  });

  assert.equal(calls.length, 0, "Tier A must short-circuit at threshold 0");
  assert.equal(result[0]!.classificationTier, "tier-a");
});

test("classify Tier C: skipped when no images are available even if Tier B is low-confidence", async () => {
  // Same low-confidence Tier B response, but no images in extractions →
  // Tier C cannot run. The Tier B result must be returned as-is.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Plain text only",
      blocks: [],
      images: [], // no images!
      extractorId: "plain-text",
      ocrUsed: false,
    },
  ];

  const lowConfTierB = JSON.stringify({
    label: "invoice",
    confidence: 0.3,
    unsupported: false,
    fields: [],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm(lowConfTierB);
  const result = await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
  });

  // Only one call — Tier B. Tier C did not run because no images.
  assert.equal(calls.length, 1);
  assert.equal(result[0]!.classificationTier, "tier-b");
});

// ---------------------------------------------------------------------------
// Tier-C routing — separate adapter for multimodal calls
// ---------------------------------------------------------------------------

test("classify: tierCAdapter (when set) receives Tier-C calls; primary llmProvider gets Tier-B only", async () => {
  // Two distinct adapters: Tier B should hit `llmProvider` only; Tier C and
  // per-field refinement should hit `tierCAdapter` only. Verifies the routing
  // injected via `ClassificationRequest.tierCAdapter`.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Some plain extracted text",
      blocks: [],
      images: [{ type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" }],
      extractorId: "pdf",
      ocrUsed: false,
    },
  ];

  const lowConfTierB = JSON.stringify({
    label: "passport",
    confidence: 0.3,
    unsupported: false,
    fields: [],
    uncertaintyFlags: ["low-confidence"],
  });
  const tierCResponse = JSON.stringify({
    label: "passport",
    confidence: 0.95,
    unsupported: false,
    fields: [
      { name: "full_name", value: "Jane Doe", confidence: 0.97, sourceUnitIndex: 1 },
    ],
    uncertaintyFlags: [],
  });

  const tierB = makeRecordingLlm(lowConfTierB);
  const tierC = makeRecordingLlm(tierCResponse);

  await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: tierB.llm,
    tierCAdapter: tierC.llm,
  });

  // Tier B adapter saw exactly one call; Tier C adapter saw the multimodal call
  // (per-field refinement does not run because returned field confidence is high).
  assert.equal(tierB.calls.length, 1, "Tier B adapter must be called once");
  assert.equal(tierC.calls.length, 1, "Tier C adapter must be called for the multimodal classification");

  // Tier B call carries no images.
  assert.ok(!tierB.calls[0]!.images || tierB.calls[0]!.images.length === 0);
  // Tier C call carries the image bytes.
  assert.ok(tierC.calls[0]!.images && tierC.calls[0]!.images.length === 1);
  assert.match(tierC.calls[0]!.sessionId, /multimodal/);
});

test("classify: when tierCAdapter is omitted, Tier C falls back to llmProvider", async () => {
  // Regression guard: if no Tier-C-specific adapter is provided, the existing
  // single-adapter path must continue to handle Tier C calls.
  const extractions: UnitExtractionResult[] = [
    {
      unitIndex: 1,
      text: "Some plain text",
      blocks: [],
      images: [{ type: "image", data: PNG_PIXEL_BASE64, mimeType: "image/png" }],
      extractorId: "pdf",
      ocrUsed: false,
    },
  ];

  const lowConfTierB = JSON.stringify({
    label: "passport",
    confidence: 0.3,
    unsupported: false,
    fields: [],
    uncertaintyFlags: [],
  });
  const tierCResponse = JSON.stringify({
    label: "passport",
    confidence: 0.9,
    unsupported: false,
    fields: [{ name: "full_name", value: "x", confidence: 0.9, sourceUnitIndex: 1 }],
    uncertaintyFlags: [],
  });

  const { llm, calls } = makeRecordingLlm((_input, n) => (n === 1 ? lowConfTierB : tierCResponse));
  await classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions,
    executionMode: "hybrid",
    llmProvider: llm,
    // tierCAdapter intentionally omitted
  });

  // Two calls on the single adapter: Tier B (no images), Tier C (with images).
  assert.equal(calls.length, 2);
  assert.ok(!calls[0]!.images || calls[0]!.images.length === 0);
  assert.ok(calls[1]!.images && calls[1]!.images.length === 1);
});

// ---------------------------------------------------------------------------
// MRZ date century inference (birth vs expiry)
// ---------------------------------------------------------------------------

function td3Fields(dobYYMMDD: string, expiryYYMMDD: string) {
  const line1 = "P<UTOSAMPLE<<TEST<<<<<<<<<<<<<<<<<<<<<<<<<<<";
  const line2 = `X000000010UTO${dobYYMMDD}1F${expiryYYMMDD}4${"<".repeat(14)}02`;
  assert.equal(line1.length, 44);
  assert.equal(line2.length, 44);
  return classifyGroups({
    groups: [SINGLE_GROUP],
    units: [SINGLE_UNIT],
    extractions: [
      { unitIndex: 1, text: `${line1}\n${line2}`, blocks: [], images: [], extractorId: "plain-text", ocrUsed: false },
    ],
    llmProvider: makeDisabledLlm(),
  }).then((r) => Object.fromEntries(r[0]!.fields.map((f) => [f.name, f.value])));
}

const yy = (year: number) => String(((year % 100) + 100) % 100).padStart(2, "0");

test("classify MRZ dates: expiry years in the 2030s+ stay in the 2000s", async () => {
  const now = new Date().getUTCFullYear();
  const soon = now + 5;
  const fields = await td3Fields("700101", `${yy(soon)}0615`);
  assert.equal(fields.expiry_date, `${soon}-06-15`);
  assert.equal((await td3Fields("700101", "310101")).expiry_date, "2031-01-01");
});

test("classify MRZ dates: a long-expired document from the 1990s stays in the 1900s", async () => {
  assert.equal((await td3Fields("700101", "990101")).expiry_date, "1999-01-01");
});

test("classify MRZ dates: birth dates are never in the future", async () => {
  const now = new Date().getUTCFullYear();
  const adult = now - 30;
  assert.equal((await td3Fields(`${yy(adult)}0101`, "310101")).date_of_birth, `${adult}-01-01`);
  const nextYear = now + 1;
  assert.equal(
    (await td3Fields(`${yy(nextYear)}0101`, "310101")).date_of_birth,
    `${nextYear - 100}-01-01`,
    "a two-digit year after the current year is a 1900s birth date",
  );
  assert.equal((await td3Fields("000229", "310101")).date_of_birth, "2000-02-29");
});
