// ---------------------------------------------------------------------------
// OCR Plugin Interface
//
// Re-exports the OCR contract from types.ts, provides utility helpers, and
// ships a no-op null plugin for use in tests and environments where OCR is
// not required.
//
// No built-in OCR provider is shipped. Callers inject a provider that
// implements OCRPlugin. Provider examples (not in this codebase):
//   - Tesseract.js (local, open-source)
//   - Azure AI Document Intelligence
//   - Google Cloud Vision
//   - AWS Textract
// ---------------------------------------------------------------------------

export type {
  OCRPlugin,
  OCROptions,
  OCRResult,
  OCRWordBox,
} from "./types.js";

import type { BoundingBox, LayoutBlock, OCRPlugin, OCRResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert OCR word boxes to LayoutBlock records.
 *
 * Contract:
 * - Input `OCRWordBox.boundingBox` MUST be `coordSpace: "pixels"` (absolute
 *   pixel coordinates relative to the image passed to `recognize()`).
 *   Boxes already in `"normalized"` space are passed through unchanged.
 * - Output `LayoutBlock.boundingBox` is always `coordSpace: "normalized"`
 *   (0–1 relative to unit dimensions).
 *
 * Word boxes with no positional data still appear as blocks without a box.
 */
export function wordBoxesToLayoutBlocks(
  ocrResult: OCRResult,
  imageWidth: number,
  imageHeight: number,
): LayoutBlock[] {
  if (!ocrResult.wordBoxes || ocrResult.wordBoxes.length === 0) {
    // Provider returned no boxes — produce a single block from the full text.
    if (!ocrResult.text.trim()) return [];
    return [{ text: ocrResult.text, confidence: ocrResult.confidence }];
  }

  const w = Math.max(imageWidth, 1);
  const h = Math.max(imageHeight, 1);

  return ocrResult.wordBoxes.map((wb) => {
    // Pass through if the provider already produced normalized coordinates.
    const box: BoundingBox =
      wb.boundingBox.coordSpace === "normalized"
        ? { ...wb.boundingBox }
        : {
            x: wb.boundingBox.x / w,
            y: wb.boundingBox.y / h,
            width: wb.boundingBox.width / w,
            height: wb.boundingBox.height / h,
            coordSpace: "normalized",
          };
    return {
      text: wb.text,
      boundingBox: box,
      confidence: wb.confidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Null OCR plugin (no-op — for tests and opt-out scenarios)
// ---------------------------------------------------------------------------

/**
 * Returns an OCR plugin that always produces empty results.
 * Useful as a safe default when no real OCR provider is configured,
 * and as a test double that satisfies the OCRPlugin contract.
 */
export function createNullOcrPlugin(): OCRPlugin {
  return {
    id: "null-ocr",
    label: "Null OCR (no-op)",
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/tiff", "image/bmp"],
    supportedLanguages: [],
    recognize: async (_buffer, _mimeType, _options) => ({
      text: "",
      wordBoxes: [],
      confidence: 0,
    }),
  };
}

// ---------------------------------------------------------------------------
// Validate a caller-supplied OCR plugin at registration time.
// Call this when accepting an externally provided plugin to surface
// misconfiguration early rather than at first use.
// ---------------------------------------------------------------------------

export function validateOcrPlugin(plugin: unknown): plugin is OCRPlugin {
  if (typeof plugin !== "object" || plugin === null) return false;
  const p = plugin as Record<string, unknown>;
  return (
    typeof p["id"] === "string" &&
    p["id"].length > 0 &&
    typeof p["label"] === "string" &&
    Array.isArray(p["supportedMimeTypes"]) &&
    Array.isArray(p["supportedLanguages"]) &&
    typeof p["recognize"] === "function"
  );
}
