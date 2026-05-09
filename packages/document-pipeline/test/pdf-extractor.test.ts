// ---------------------------------------------------------------------------
// Tests: pdf-extractor — image-fallback smoke test
//
// Critical regression coverage:
//
//   A2 (wrong pdfjs render API) — `pdf-extractor.ts` previously called
//   `page.render({ canvas, viewport })`. pdfjs v4 requires `canvasContext`
//   (a 2D context) — the wrong shape silently degrades to text-only because
//   the swallow-and-continue path masks the runtime TypeError.
//
//   This test:
//     1. Synthesises a minimal valid PDF in memory (1 empty page, no text).
//     2. Runs `extractUnit` on the page.
//     3. Asserts the call does NOT throw a TypeError that mentions
//        `canvasContext` — which is what pdfjs would say if we passed the
//        wrong field name.
//
// Note: this is a smoke test. It depends on `@napi-rs/canvas` being available
// (an optional dep of pdfjs-dist). When the canvas backend is missing, the
// extractor's `onImageExtractionError` path is exercised instead and the
// test still passes — the goal is to catch the *wrong API call*, not to
// require image rendering.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUnit } from "../src/extract.js";
import type { DocumentUnit } from "../src/types.js";

// ---------------------------------------------------------------------------
// Minimal PDF builder
//
// Produces a single-page PDF with no text content streams. pdfjs v4 parses
// this and `getTextContent()` returns an empty `items` array, so the
// extractor's image-fallback path will be exercised.
// ---------------------------------------------------------------------------

function buildMinimalPdf(): Buffer {
  // Build object bodies first, then assemble with computed xref offsets.
  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R " +
    "/MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n";

  // Compute byte offsets for the xref table.
  const offset1 = Buffer.byteLength(header, "binary");
  const offset2 = offset1 + Buffer.byteLength(obj1, "binary");
  const offset3 = offset2 + Buffer.byteLength(obj2, "binary");
  const xrefOffset = offset3 + Buffer.byteLength(obj3, "binary");

  const xref =
    "xref\n" +
    "0 4\n" +
    "0000000000 65535 f \n" +
    `${String(offset1).padStart(10, "0")} 00000 n \n` +
    `${String(offset2).padStart(10, "0")} 00000 n \n` +
    `${String(offset3).padStart(10, "0")} 00000 n \n`;

  const trailer =
    "trailer\n<< /Size 4 /Root 1 0 R >>\n" +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + obj1 + obj2 + obj3 + xref + trailer, "binary");
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test("pdf-extractor: extractUnit on a no-text PDF does not call render with the wrong API", async () => {
  const pdf = buildMinimalPdf();
  const unit: DocumentUnit = { index: 1, kind: "page", sourceFileIndex: 0, widthPx: 200, heightPx: 200 };

  const errors: unknown[] = [];

  // The image-fallback path must run because the page has no text content.
  // We force the threshold to a value our empty page cannot meet.
  let result;
  try {
    result = await extractUnit({
      buffer: pdf,
      mimeType: "application/pdf",
      unit,
      limits: { maxPages: 1, maxPixels: 200_000, minTextChars: 200 },
      onImageExtractionError: (err) => errors.push(err),
    });
  } catch (err) {
    // The extractor itself should not throw — image-fallback errors are
    // routed through onImageExtractionError. Anything thrown here is a real bug.
    assert.fail(
      `extractUnit threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Whatever path was taken, we must not see a pdfjs error mentioning that
  // `canvasContext` is missing — that would mean we regressed A2.
  for (const err of errors) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.doesNotMatch(
      msg,
      /canvasContext/i,
      `pdfjs reported a missing canvasContext — A2 regressed. Full error: ${msg}`,
    );
  }

  // The result is either:
  //  - a UnitExtractionResult with images (canvas backend available, rendering succeeded), OR
  //  - a UnitExtractionResult with empty images (canvas backend unavailable: the
  //    onImageExtractionError path ran and we returned text-only), OR
  //  - null (no plugin matched — shouldn't happen for application/pdf).
  // All of these are acceptable; the regression we guard against is the
  // wrong-shape API call surfaced via canvasContext error.
  assert.ok(result !== null, "expected the PDF extractor to match application/pdf");
  assert.equal(result!.extractorId, "pdf");
});
