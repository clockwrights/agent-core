// ---------------------------------------------------------------------------
// Tests: pdfjs text positions — native-text PDF pages yield positioned
// layout blocks, and field citations on them get a bounding box.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { boxForSpan, citeQuote, findQuoteSpan } from "../src/citations.js";
import { extractUnit } from "../src/extract.js";
import type { DocumentGroup, DocumentUnit, UnitExtractionResult } from "../src/types.js";

/** A one-page PDF (MediaBox 0 0 600 800, optional /Rotate) drawing each line in Helvetica 20 pt. */
function buildTextPdf(lines: Array<{ x: number; y: number; text: string }>, rotate = 0): Buffer {
  const stream = lines.map((l) => `BT /F1 20 Tf ${l.x} ${l.y} Td (${l.text}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800]${rotate ? ` /Rotate ${rotate}` : ""} ` +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((content, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, "latin1");
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const unit: DocumentUnit = { index: 1, kind: "page", sourceFileIndex: 0 };

async function extract(buffer: Buffer): Promise<UnitExtractionResult> {
  const result = await extractUnit({
    unit,
    buffer,
    mimeType: "application/pdf",
    limits: { minTextChars: 1 },
  });
  assert.ok(result, "the PDF extractor handled the unit");
  return result;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

test("native-text PDF pages yield one positioned block per text item, top-left normalized", async () => {
  const result = await extract(
    buildTextPdf([
      { x: 60, y: 700, text: "Invoice number INV-0042" },
      { x: 60, y: 200, text: "Total due 120.50 EUR" },
    ]),
  );
  assert.equal(result.text, "Invoice number INV-0042 Total due 120.50 EUR");
  assert.deepEqual(result.blocks.map((b) => b.text), ["Invoice number INV-0042", "Total due 120.50 EUR"]);
  const [top, bottom] = result.blocks.map((b) => b.boundingBox!);
  assert.equal(top!.coordSpace, "normalized");
  assert.equal(round(top!.x), 0.1, "x = 60 / 600");
  // Baseline at y=700 of 800 with a 20 pt line: the box spans 80..100 from the top.
  assert.equal(round(top!.y), 0.1, "80 / 800");
  assert.equal(round(top!.height), 0.025);
  assert.ok(top!.width > 0.2 && top!.width < 0.6, `plausible width (${top!.width})`);
  assert.ok(bottom!.y > 0.7, "the second line is near the bottom");
});

test("a field citation on a native-text PDF gets a box over the quoted line", async () => {
  const extraction = await extract(
    buildTextPdf([
      { x: 60, y: 700, text: "Invoice number INV-0042" },
      { x: 60, y: 200, text: "Total due 120.50 EUR" },
    ]),
  );
  const group: DocumentGroup = { id: "g", unitIndices: [1], confidence: 1, segmentationMethod: "single-group" };
  const citation = citeQuote({ value: "120.50", sourceUnitIndex: 1 }, "Total due 120.50 EUR", {
    group,
    units: [unit],
    extractions: [extraction],
  })!;
  assert.equal(citation.status, "verified");
  assert.deepEqual(citation.boundingBox, extraction.blocks[1]!.boundingBox);
});

test("page rotation is applied to the boxes", async () => {
  const result = await extract(buildTextPdf([{ x: 60, y: 700, text: "Rotated line" }], 90));
  const box = result.blocks[0]!.boundingBox!;
  // Rotated 90° clockwise: the page is 800 wide and 600 high, and the line now runs top to bottom.
  assert.ok(box.height > box.width, `vertical box (${JSON.stringify(box)})`);
  assert.ok(box.x >= 0 && box.x + box.width <= 1 && box.y >= 0 && box.y + box.height <= 1);
});

test("boxForSpan keeps the box when blocks after the span cannot be aligned", () => {
  const text = "alpha beta gamma";
  const blocks = [
    { text: "alpha", boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1, coordSpace: "normalized" as const } },
    { text: "beta", boundingBox: { x: 0.2, y: 0, width: 0.1, height: 0.1, coordSpace: "normalized" as const } },
    { text: "not in the text" },
  ];
  const span = findQuoteSpan(text, "alpha")!;
  assert.deepEqual(boxForSpan(text, blocks, span), blocks[0]!.boundingBox);
  // A block that fails before the span still means no box.
  assert.equal(boxForSpan(text, [{ text: "zzz" }, ...blocks], span), undefined);
});
