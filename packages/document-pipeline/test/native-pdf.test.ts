// ---------------------------------------------------------------------------
// Tests: native PDF attachments (`documents`) for Tier C — opt-in.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGroups, type ClassificationSourceDocument } from "../src/classify.js";
import { NATIVE_PDF_MAX_BYTES, runDocumentPipeline } from "../src/pipeline.js";
import type { PipelineLlmAdapter, PipelineLlmRequest } from "../src/llm.js";
import type { DocumentGroup, DocumentUnit, UnitExtractionResult } from "../src/types.js";

const REPLY = JSON.stringify({
  label: "invoice",
  confidence: 0.9,
  unsupported: false,
  fields: [{ name: "total", value: "12.00", confidence: 0.9, sourceUnitIndex: 1 }],
  uncertaintyFlags: [],
});

function recordingLlm(supportsDocuments: boolean, reply: (n: number) => string = () => REPLY) {
  const calls: PipelineLlmRequest[] = [];
  const llm: PipelineLlmAdapter = {
    enabled: true,
    supportsDocuments,
    generate: async (input) => {
      calls.push(input);
      return { text: reply(calls.length) };
    },
  };
  return { llm, calls };
}

// Two files: file 0 is a 3-page PDF (units 1-3), file 1 a 1-page PDF (unit 4).
const UNITS: DocumentUnit[] = [
  { index: 1, kind: "page", sourceFileIndex: 0 },
  { index: 2, kind: "page", sourceFileIndex: 0 },
  { index: 3, kind: "page", sourceFileIndex: 0 },
  { index: 4, kind: "page", sourceFileIndex: 1 },
];
const textOnly = (unitIndex: number): UnitExtractionResult => ({
  unitIndex,
  text: "Some text without rendered images",
  blocks: [],
  images: [],
  extractorId: "pdf",
  ocrUsed: false,
});
const EXTRACTIONS = UNITS.map((u) => textOnly(u.index));
const SOURCES: ClassificationSourceDocument[] = [
  { sourceFileIndex: 0, data: "UERGLTA=", mimeType: "application/pdf", name: "bundle.pdf" },
];
const group = (id: string, unitIndices: number[]): DocumentGroup => ({
  id,
  unitIndices,
  confidence: 1,
  segmentationMethod: "single-group",
});

test("native PDF: Tier C attaches the source PDF with a page hint, no images needed", async () => {
  const { llm, calls } = recordingLlm(true);
  const [result] = await classifyGroups({
    groups: [group("g", [2, 3])],
    units: UNITS,
    extractions: EXTRACTIONS,
    llmProvider: llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.equal(calls.length, 1);
  assert.equal(result!.classificationTier, "tier-c");
  assert.deepEqual(calls[0]!.documents, [{ data: "UERGLTA=", mimeType: "application/pdf", name: "bundle.pdf" }]);
  assert.equal(calls[0]!.images, undefined, "the PDF replaces rendered images");
  assert.match(calls[0]!.prompt, /covers pages 2-3 of it/);
});

test("native PDF: page hints for single and non-contiguous pages", async () => {
  const { llm, calls } = recordingLlm(true);
  await classifyGroups({
    groups: [group("one", [1]), group("gap", [3, 1])],
    units: UNITS,
    extractions: EXTRACTIONS,
    llmProvider: llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.match(calls[0]!.prompt, /covers page 1 of it/);
  assert.match(calls[1]!.prompt, /covers pages 1, 3 of it/);
});

test("native PDF: low-confidence field refinement also sends the PDF", async () => {
  const lowField = JSON.stringify({
    label: "invoice",
    confidence: 0.9,
    fields: [{ name: "total", value: "", confidence: 0.2, sourceUnitIndex: 1 }],
  });
  const { llm, calls } = recordingLlm(true, (n) =>
    n === 1 ? lowField : JSON.stringify({ value: "12.00", confidence: 0.8 }),
  );
  const [result] = await classifyGroups({
    groups: [group("g", [1])],
    units: UNITS,
    extractions: EXTRACTIONS,
    llmProvider: llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.documents?.length, 1);
  assert.equal(calls[1]!.images, undefined);
  assert.match(calls[1]!.systemPrompt, /page 1 of the attached PDF/);
  assert.equal(result!.fields[0]!.value, "12.00");
});

test("native PDF: not used without adapter support, without a listed source, or across files", async () => {
  // Adapter without supportsDocuments → old behaviour: no images → Tier C does not run.
  const plain = recordingLlm(false);
  const [unknown] = await classifyGroups({
    groups: [group("g", [1])],
    units: UNITS,
    extractions: EXTRACTIONS,
    llmProvider: plain.llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.equal(plain.calls.length, 0);
  assert.equal(unknown!.label, "unknown");

  // File 1 is not listed; a group spanning files 0 and 1 is not native either.
  const capable = recordingLlm(true);
  const results = await classifyGroups({
    groups: [group("other-file", [4]), group("mixed", [3, 4])],
    units: UNITS,
    extractions: EXTRACTIONS,
    llmProvider: capable.llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.equal(capable.calls.length, 0);
  assert.deepEqual(results.map((r) => r.label), ["unknown", "unknown"]);
});

test("native PDF: when images exist but the adapter lacks support, images are still sent", async () => {
  const { llm, calls } = recordingLlm(false);
  await classifyGroups({
    groups: [group("g", [1])],
    units: UNITS,
    extractions: [{ ...textOnly(1), images: [{ type: "image", data: "iVBO", mimeType: "image/png" }] }],
    llmProvider: llm,
    minTier: "tier-c",
    sourceDocuments: SOURCES,
  });
  assert.equal(calls[0]!.documents, undefined);
  assert.equal(calls[0]!.images?.length, 1);
});

// ---------------------------------------------------------------------------
// Pipeline wiring
// ---------------------------------------------------------------------------

function buildMinimalPdf(): Buffer {
  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n";
  const offset1 = Buffer.byteLength(header, "binary");
  const offset2 = offset1 + Buffer.byteLength(obj1, "binary");
  const offset3 = offset2 + Buffer.byteLength(obj2, "binary");
  const xrefOffset = offset3 + Buffer.byteLength(obj3, "binary");
  const pad = (n: number) => String(n).padStart(10, "0");
  const xref =
    "xref\n0 4\n0000000000 65535 f \n" +
    `${pad(offset1)} 00000 n \n${pad(offset2)} 00000 n \n${pad(offset3)} 00000 n \n`;
  const trailer = `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + obj1 + obj2 + obj3 + xref + trailer, "binary");
}

async function runWith(nativePdf: boolean | { maxBytes?: number } | undefined, supportsDocuments = true) {
  const { llm, calls } = recordingLlm(supportsDocuments);
  const pdf = buildMinimalPdf();
  const result = await runDocumentPipeline(
    { buffer: pdf, fileName: "scan.pdf", minTier: "tier-c", executionMode: "hybrid" },
    { tierCAdapter: llm, ...(nativePdf === undefined ? {} : { nativePdf }) },
  );
  return { calls, pdf, result };
}

test("pipeline: nativePdf sends the submitted PDF bytes to a supporting Tier C adapter", async () => {
  const { calls, pdf, result } = await runWith(true);
  const withDocs = calls.filter((c) => c.documents);
  assert.equal(withDocs.length, 1);
  assert.deepEqual(withDocs[0]!.documents, [
    { data: pdf.toString("base64"), mimeType: "application/pdf", name: "scan.pdf" },
  ]);
  const classified = result.analysisPackage.classifiedGroups[0]!;
  assert.equal(classified.label, "invoice");
  assert.equal(classified.classificationTier, "tier-c");
});

test("pipeline: nativePdf is off by default, needs adapter support, and respects maxBytes", async () => {
  for (const [nativePdf, supports] of [
    [undefined, true],
    [false, true],
    [true, false],
    [{ maxBytes: 10 }, true],
  ] as const) {
    const { calls } = await runWith(nativePdf, supports);
    assert.equal(
      calls.some((c) => c.documents),
      false,
      `no documents for nativePdf=${JSON.stringify(nativePdf)} supports=${supports}`,
    );
  }
  assert.equal(NATIVE_PDF_MAX_BYTES, 32 * 1024 * 1024);
});
