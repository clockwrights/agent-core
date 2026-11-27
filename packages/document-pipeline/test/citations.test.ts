// ---------------------------------------------------------------------------
// Tests: field citations (fieldCitations) — quote verification, spans, boxes,
// Tier A deterministic citations, Tier B/C prompts and unit correction.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { boxForSpan, citeQuote, findQuoteSpan } from "../src/citations.js";
import { classifyGroups } from "../src/classify.js";
import { buildClassificationPrompt, buildFieldExtractionPrompt } from "../src/policy.js";
import { loadPipelineDefaults } from "../src/pipeline-config.js";
import type { PipelineLlmAdapter, PipelineLlmRequest } from "../src/llm.js";
import type { DocumentGroup, DocumentUnit, LayoutBlock, UnitExtractionResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function extraction(unitIndex: number, text: string, blocks: LayoutBlock[] = [], withImage = false): UnitExtractionResult {
  return {
    unitIndex,
    text,
    blocks,
    images: withImage ? [{ type: "image", data: "aGk=", mimeType: "image/png" }] : [],
    extractorId: "test",
    ocrUsed: blocks.length > 0,
  };
}

const units: DocumentUnit[] = [
  { index: 1, kind: "page", sourceFileIndex: 0 },
  { index: 2, kind: "page", sourceFileIndex: 0 },
  { index: 3, kind: "page", sourceFileIndex: 1 },
];
const group: DocumentGroup = { id: "g1", unitIndices: [1, 2], confidence: 1, segmentationMethod: "llm-assisted" };

function recordingLlm(reply: (input: PipelineLlmRequest, n: number) => string) {
  const calls: PipelineLlmRequest[] = [];
  const llm: PipelineLlmAdapter = {
    enabled: true,
    generate: async (input) => {
      calls.push(input);
      return { text: reply(input, calls.length) };
    },
  };
  return { llm, calls };
}

const box = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, coordSpace: "normalized" as const });

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

test("findQuoteSpan ignores case, width forms and whitespace, and maps back to the original text", () => {
  const text = "Invoice\n  Number:   INV-0042\nTotal 10";
  const span = findQuoteSpan(text, "number: inv-0042")!;
  assert.equal(text.slice(span.start, span.end), "Number:   INV-0042");
  assert.ok(findQuoteSpan("ＡＢＣ 123", "abc 123"), "full-width letters match");
  assert.equal(findQuoteSpan(text, "INV-0043"), undefined);
  assert.equal(findQuoteSpan(text, "   "), undefined);
});

test("boxForSpan unions the boxes of the words the span covers; misaligned blocks give no box", () => {
  const text = "Name: Jane Doe Date: 2024-01-02";
  const blocks: LayoutBlock[] = [
    { text: "Name:", boundingBox: box(0.1, 0.1, 0.1, 0.05) },
    { text: "Jane", boundingBox: box(0.25, 0.1, 0.1, 0.05) },
    { text: "Doe", boundingBox: box(0.4, 0.12, 0.08, 0.05) },
    { text: "Date:", boundingBox: box(0.1, 0.3, 0.1, 0.05) },
    { text: "2024-01-02", boundingBox: box(0.25, 0.3, 0.2, 0.05) },
  ];
  const span = findQuoteSpan(text, "Jane Doe")!;
  const union = boxForSpan(text, blocks, span)!;
  assert.deepEqual(
    { ...union, x: +union.x.toFixed(4), y: +union.y.toFixed(4), width: +union.width.toFixed(4), height: +union.height.toFixed(4) },
    { x: 0.25, y: 0.1, width: 0.23, height: 0.07, coordSpace: "normalized" },
  );
  assert.equal(boxForSpan(text, [{ text: "Nobody", boundingBox: box(0, 0, 1, 1) }], span), undefined);
  assert.equal(boxForSpan(text, [], span), undefined);
});

test("citeQuote: verified, found in another unit, not-found, unverifiable", () => {
  const context = {
    group,
    units,
    extractions: [extraction(1, "Cover letter for the claim"), extraction(2, "Policy no. AB-77\nHolder: J. Doe")],
  };
  const verified = citeQuote({ value: "AB-77", sourceUnitIndex: 2 }, " Policy no. AB-77 ", context)!;
  assert.equal(verified.status, "verified");
  assert.equal(verified.unitIndex, 2);
  assert.equal(verified.page, 2);
  assert.equal(verified.sourceFileIndex, 0);
  assert.deepEqual(verified.textSpan, { start: 0, end: 16 });
  assert.equal(verified.quote, "Policy no. AB-77");

  const elsewhere = citeQuote({ value: "AB-77", sourceUnitIndex: 1 }, "Holder: J. Doe", context)!;
  assert.equal(elsewhere.unitIndex, 2, "found in the other unit of the group");

  const missing = citeQuote({ value: "AB-78", sourceUnitIndex: 2 }, "Policy no. AB-78", context)!;
  assert.equal(missing.status, "not-found");
  assert.equal(missing.textSpan, undefined);

  const imageOnly = { group, units, extractions: [extraction(1, "", [], true), extraction(2, "")] };
  assert.equal(citeQuote({ value: "x", sourceUnitIndex: 1 }, "x", imageOnly)!.status, "unverifiable");

  const namedImage = { group, units, extractions: [extraction(1, "", [], true), extraction(2, "other text")] };
  assert.equal(citeQuote({ value: "x", sourceUnitIndex: 1 }, "seen on the image", namedImage)!.status, "unverifiable");

  assert.equal(citeQuote({ value: "", sourceUnitIndex: 1 }, "x", context), undefined, "empty value");
  assert.equal(citeQuote({ value: "x", sourceUnitIndex: 1 }, "  ", context), undefined, "empty quote");
  assert.equal(citeQuote({ value: "x", sourceUnitIndex: 1 }, "Cover".padEnd(400, "!"), context)!.quote.length, 300);
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test("prompts: unchanged by default; a quote field when fieldCitations is on", () => {
  const plain = buildClassificationPrompt(undefined, group, units, [extraction(1, "a")]);
  const off = buildClassificationPrompt(undefined, group, units, [extraction(1, "a")], undefined, { fieldCitations: false });
  const on = buildClassificationPrompt(undefined, group, units, [extraction(1, "a")], undefined, { fieldCitations: true });
  assert.equal(off.systemPrompt, plain.systemPrompt);
  assert.doesNotMatch(plain.systemPrompt, /"quote"/);
  assert.match(on.systemPrompt, /"sourceUnitIndex": <1-based page\/unit number where this field was found>,\n {6}"quote": "<the exact text/);
  assert.equal(on.userPrompt, plain.userPrompt);
  assert.doesNotMatch(buildFieldExtractionPrompt("name", "passport", undefined), /quote/);
  assert.match(buildFieldExtractionPrompt("name", "passport", undefined, { fieldCitations: true }), /"quote"/);
});

// ---------------------------------------------------------------------------
// classifyGroups end to end
// ---------------------------------------------------------------------------

const TD3 = [
  "Passport of a test person.",
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
].join("\n");

test("Tier A: MRZ fields cite their MRZ line deterministically; without the option nothing changes", async () => {
  const twoPages: DocumentGroup = { ...group, unitIndices: [1, 2] };
  const extractions = [extraction(1, "Cover page"), extraction(2, TD3)];
  const [withCitations] = await classifyGroups({ groups: [twoPages], units, extractions, fieldCitations: true });
  assert.equal(withCitations!.classificationTier, "tier-a");
  const byName = new Map(withCitations!.fields.map((f) => [f.name, f]));
  const surname = byName.get("surname")!;
  assert.equal(surname.citations!.length, 1);
  assert.equal(surname.citations![0]!.status, "deterministic");
  assert.equal(surname.citations![0]!.quote, "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
  assert.equal(surname.sourceUnitIndex, 2, "the MRZ is on unit 2");
  assert.equal(byName.get("document_number")!.citations![0]!.quote.startsWith("L898902C3"), true);
  assert.equal(withCitations!.uncertaintyFlags.some((f) => f.startsWith("source-unit-corrected")), false);

  const [plain] = await classifyGroups({ groups: [twoPages], units, extractions });
  assert.equal(plain!.fields.every((f) => f.citations === undefined), true);
  assert.equal(plain!.fields[0]!.sourceUnitIndex, 1, "unchanged behaviour without the option");
});

test("Tier B: quotes are verified, a wrong unit is corrected and flagged, maxTokens grows", async () => {
  const extractions = [
    extraction(1, "Claim form\nClaimant: Jane Doe"),
    extraction(2, "Amount due: 120.50 EUR", [
      { text: "Amount", boundingBox: box(0.1, 0.5, 0.1, 0.04) },
      { text: "due:", boundingBox: box(0.21, 0.5, 0.06, 0.04) },
      { text: "120.50", boundingBox: box(0.3, 0.5, 0.1, 0.04) },
      { text: "EUR", boundingBox: box(0.41, 0.5, 0.05, 0.04) },
    ]),
  ];
  const { llm, calls } = recordingLlm(() =>
    JSON.stringify({
      label: "claim",
      confidence: 0.9,
      unsupported: false,
      fields: [
        { name: "claimant", value: "Jane Doe", confidence: 0.9, sourceUnitIndex: 2, quote: "Claimant: Jane Doe" },
        { name: "amount", value: "120.50", confidence: 0.8, sourceUnitIndex: 2, quote: "120.50 EUR" },
        { name: "iban", value: "DE00", confidence: 0.4, sourceUnitIndex: 2, quote: "IBAN DE00" },
        { name: "note", value: "", confidence: 0, sourceUnitIndex: 1, quote: "" },
      ],
      uncertaintyFlags: [],
    }),
  );
  const [result] = await classifyGroups({
    groups: [group],
    units,
    extractions,
    llmProvider: llm,
    minTier: "tier-b",
    fieldCitations: true,
  });
  assert.equal(calls[0]!.maxTokens, 2048);
  assert.match(calls[0]!.systemPrompt, /"quote"/);
  const byName = new Map(result!.fields.map((f) => [f.name, f]));

  const claimant = byName.get("claimant")!;
  assert.equal(claimant.citations![0]!.status, "verified");
  assert.equal(claimant.sourceUnitIndex, 1, "corrected to the unit holding the quote");
  assert.ok(result!.uncertaintyFlags.includes("source-unit-corrected:claimant"));

  const amount = byName.get("amount")!;
  assert.equal(amount.citations![0]!.status, "verified");
  assert.ok(amount.boundingBox, "box from the OCR words");
  assert.equal(+amount.boundingBox!.x.toFixed(4), 0.3);
  assert.equal(+(amount.boundingBox!.x + amount.boundingBox!.width).toFixed(4), 0.46);

  const iban = byName.get("iban")!;
  assert.equal(iban.citations![0]!.status, "not-found");
  assert.equal(iban.confidence, 0.4, "confidence is not rewritten");
  assert.deepEqual(byName.get("note")!.citations, []);

  // Without the option: the original prompt and token cap.
  const plain = recordingLlm(() => JSON.stringify({ label: "claim", confidence: 0.9, unsupported: false, fields: [], uncertaintyFlags: [] }));
  await classifyGroups({ groups: [group], units, extractions, llmProvider: plain.llm, minTier: "tier-b" });
  assert.equal(plain.calls[0]!.maxTokens, 1024);
  assert.doesNotMatch(plain.calls[0]!.systemPrompt, /"quote"/);
});

test("Tier C: low-confidence refinement asks for and keeps a quote", async () => {
  const extractions = [extraction(1, "Receipt total 9.99", [], true)];
  const single: DocumentGroup = { id: "g2", unitIndices: [1], confidence: 1, segmentationMethod: "single-group" };
  const { llm, calls } = recordingLlm((input) =>
    input.sessionId.startsWith("doc-field-")
      ? JSON.stringify({ value: "9.99", confidence: 0.8, quote: "total 9.99" })
      : JSON.stringify({
          label: "receipt",
          confidence: 0.9,
          unsupported: false,
          fields: [{ name: "total", value: "9.9", confidence: 0.2, sourceUnitIndex: 1, quote: "nothing like it" }],
          uncertaintyFlags: [],
        }),
  );
  const [result] = await classifyGroups({ groups: [single], units, extractions, llmProvider: llm, minTier: "tier-c", fieldCitations: true });
  assert.equal(result!.classificationTier, "tier-c");
  const total = result!.fields[0]!;
  assert.equal(total.value, "9.99");
  assert.equal(total.citations![0]!.status, "verified", "the refined quote is checked, not the first one");
  assert.match(calls.find((c) => c.sessionId.startsWith("doc-field-"))!.prompt, /"quote"/);
});

test("pipeline defaults: LLM_DEFAULT_FIELD_CITATIONS", () => {
  assert.equal(loadPipelineDefaults({ LLM_DEFAULT_FIELD_CITATIONS: "true" }).fieldCitations, true);
  assert.equal(loadPipelineDefaults({ LLM_DEFAULT_FIELD_CITATIONS: "0" }).fieldCitations, false);
  assert.equal("fieldCitations" in loadPipelineDefaults({}), false);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal("fieldCitations" in loadPipelineDefaults({ LLM_DEFAULT_FIELD_CITATIONS: "maybe" }), false);
  } finally {
    console.warn = warn;
  }
});
