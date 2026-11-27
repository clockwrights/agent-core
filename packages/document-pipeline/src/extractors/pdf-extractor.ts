import type { ExtractorPlugin, ExtractorPluginRequest, ExtractorPluginResult } from "../extract.js";
import { wordBoxesToLayoutBlocks } from "../ocr.js";
import type { BoundingBox, LayoutBlock } from "../types.js";

// ---------------------------------------------------------------------------
// PDF Extractor
//
// Strategy (identical to document-extractor.ts):
//   1. Extract native embedded text from the requested page via pdfjs.
//   2. If total text < minTextChars, render each page to a PNG image using
//      @napi-rs/canvas and return the images instead.
//   3. The pixel budget (maxPixels) is distributed across pages via a binary-
//      search render-plan so total rendered pixels never exceed the budget.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pdfjs types (structural — avoids importing the module's TS types)
// ---------------------------------------------------------------------------

type PdfTextItem = {
  str: string;
  /** Text matrix [a, b, c, d, e, f] in PDF user space; (e, f) is the baseline start. */
  transform?: number[];
  width?: number;
  height?: number;
};
type PdfTextContent = { items: Array<PdfTextItem | object> };
type PdfViewport = {
  width: number;
  height: number;
  /** User space → viewport (top-left origin), including page rotation and the MediaBox offset. */
  transform?: number[];
};

type PdfPage = {
  getTextContent(): Promise<PdfTextContent>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: unknown; viewport: PdfViewport }): { promise: Promise<void> };
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfJsModule = {
  getDocument(params: { data: Uint8Array; disableWorker?: boolean }): {
    promise: Promise<PdfDocument>;
  };
};

type CanvasLike = {
  getContext(type: "2d"): unknown;
  toBuffer(type: "image/png"): Buffer;
};
type CanvasModule = { createCanvas(width: number, height: number): CanvasLike };

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let canvasPromise: Promise<CanvasModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>).catch(
      (err) => {
        pdfJsPromise = null;
        throw new Error("pdfjs-dist is required for PDF extraction", { cause: err });
      },
    );
  }
  return pdfJsPromise;
}

async function loadCanvas(): Promise<CanvasModule> {
  if (!canvasPromise) {
    canvasPromise = (import("@napi-rs/canvas") as Promise<CanvasModule>).catch((err) => {
      canvasPromise = null;
      throw new Error("@napi-rs/canvas is required for PDF image fallback", { cause: err });
    });
  }
  return canvasPromise;
}

// ---------------------------------------------------------------------------
// Helpers (ported from document-extractor.ts)
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;

/**
 * Normalized (0–1, top-left origin) box of a text item on its page, or
 * undefined when the item has no usable geometry. Axis-aligned: the box of
 * the item's two corners after the viewport transform.
 */
function itemBox(item: PdfTextItem, viewport: PdfViewport): BoundingBox | undefined {
  const t = item.transform;
  const m = viewport.transform;
  if (!t || t.length < 6 || !m || m.length < 6) return undefined;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return undefined;
  const width = item.width ?? 0;
  const height = item.height || Math.hypot(t[2]!, t[3]!);
  const x0 = t[4]!;
  const y0 = t[5]!;
  const apply = (x: number, y: number): [number, number] => [
    m[0]! * x + m[2]! * y + m[4]!,
    m[1]! * x + m[3]! * y + m[5]!,
  ];
  const [ax, ay] = apply(x0, y0);
  const [bx, by] = apply(x0 + width, y0 + height);
  const left = Math.max(0, Math.min(ax, bx) / viewport.width);
  const top = Math.max(0, Math.min(ay, by) / viewport.height);
  const right = Math.min(1, Math.max(ax, bx) / viewport.width);
  const bottom = Math.min(1, Math.max(ay, by) / viewport.height);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom < top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top, coordSpace: "normalized" };
}

function appendText(parts: string[], pageText: string, currentLen: number): number {
  if (!pageText) return currentLen;
  const remaining = MAX_TEXT_CHARS - currentLen;
  if (remaining <= 0) return currentLen;
  const chunk = pageText.length > remaining ? pageText.slice(0, remaining) : pageText;
  parts.push(chunk);
  return currentLen + chunk.length;
}

function resolveRenderPlan(
  viewport: PdfViewport,
  remainingPixels: number,
): { scale: number; width: number; height: number; pixels: number } | null {
  if (
    remainingPixels <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const pagePixels = Math.max(1, viewport.width * viewport.height);
  const maxScale = Math.min(
    1,
    Math.sqrt(remainingPixels / pagePixels),
    MAX_RENDER_DIMENSION / viewport.width,
    MAX_RENDER_DIMENSION / viewport.height,
  );
  if (!Number.isFinite(maxScale) || maxScale <= 0) return null;

  let best: { scale: number; width: number; height: number; pixels: number } | null = null;
  let low = 0;
  let high = maxScale;
  for (let i = 0; i < 32; i += 1) {
    const scale = (low + high) / 2;
    const width = Math.max(1, Math.ceil(viewport.width * scale));
    const height = Math.max(1, Math.ceil(viewport.height * scale));
    const pixels = width * height;
    if (width <= MAX_RENDER_DIMENSION && height <= MAX_RENDER_DIMENSION && pixels <= remainingPixels) {
      best = { scale, width, height, pixels };
      low = scale;
    } else {
      high = scale;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Core extraction function
// ---------------------------------------------------------------------------

async function extractPdf(request: ExtractorPluginRequest): Promise<ExtractorPluginResult> {
  const pdfJs = await loadPdfJs();
  const pdf = await pdfJs.getDocument({ data: new Uint8Array(request.buffer), disableWorker: true })
    .promise;

  // Determine which pages to process for this unit.
  // The unit.index is the 1-based page number from the decompose stage.
  const pageNumbers = request.unit.index
    ? [request.unit.index]
    : Array.from({ length: Math.min(pdf.numPages, request.limits.maxPages) }, (_, i) => i + 1);

  // --- Text extraction ---
  // Each non-empty text item also becomes a positioned layout block, in text
  // order, so citations on native-text pages can point at a region.
  const textParts: string[] = [];
  const textBlocks: LayoutBlock[] = [];
  let textLen = 0;
  for (const pageNum of pageNumbers) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (item): item is PdfTextItem => "str" in item && Boolean((item as PdfTextItem).str),
    );
    const pageText = items.map((item) => item.str).join(" ");
    if (pageText) {
      const viewport = page.getViewport({ scale: 1 });
      const before = textLen;
      textLen = appendText(textParts, pageText, textLen);
      // Keep only the blocks of the text that was kept (a page cut at MAX_TEXT_CHARS).
      let used = 0;
      for (const item of items) {
        used += item.str.length + 1;
        if (before + used - 1 > textLen) break;
        const block: LayoutBlock = { text: item.str };
        const box = itemBox(item, viewport);
        if (box) block.boundingBox = box;
        textBlocks.push(block);
      }
      if (textLen >= MAX_TEXT_CHARS) break;
    }
  }
  const text = textParts.join("\n\n");

  // If native text is sufficient, return it without rendering.
  if (text.trim().length >= request.limits.minTextChars) {
    return { text, blocks: textBlocks, images: [], ocrUsed: false };
  }

  // Try OCR plugin first (if provided and text is insufficient)
  if (request.ocrPlugin) {
    // For OCR we need to render the page to an image first — fall through to rendering.
  }

  // --- Image fallback ---
  let canvasMod: CanvasModule;
  try {
    canvasMod = await loadCanvas();
  } catch (err) {
    request.onImageExtractionError?.(err);
    return { text, blocks: textBlocks, images: [], ocrUsed: false };
  }

  const images: ExtractorPluginResult["images"] = [];
  const ocrBlocks: ExtractorPluginResult["blocks"] = [];
  let remainingPixels = Math.max(1, Math.floor(request.limits.maxPixels));
  let ocrUsed = false;
  let ocrProviderId: string | undefined;

  for (const pageNum of pageNumbers) {
    if (remainingPixels <= 0) break;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const plan = resolveRenderPlan(viewport, remainingPixels);
    if (!plan) break;

    const scaled = page.getViewport({ scale: plan.scale });
    const canvas = canvasMod.createCanvas(plan.width, plan.height);
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      // Canvas backend did not return a 2D context — skip image fallback for this page.
      request.onImageExtractionError?.(new Error("canvas getContext('2d') returned null"));
      break;
    }
    await page.render({ canvasContext, viewport: scaled }).promise;
    const png = canvas.toBuffer("image/png");
    remainingPixels -= plan.pixels;

    // If an OCR plugin is available, run it on the rendered PNG and accumulate text.
    if (request.ocrPlugin) {
      try {
        const ocrResult = await request.ocrPlugin.recognize(png, "image/png", {
          language: undefined,
          requestLayout: false,
        });
        if (ocrResult.text.trim().length > 0) {
          textParts.push(ocrResult.text);
          const pageBlocks = wordBoxesToLayoutBlocks(ocrResult, plan.width, plan.height);
          for (const b of pageBlocks) ocrBlocks.push(b);
          ocrUsed = true;
          ocrProviderId = request.ocrPlugin.id;
        }
      } catch {
        // OCR failure is non-fatal — fall through to returning the image.
      }
    }

    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  // OCR text replaces the native text, so its word boxes replace the native blocks.
  const finalText = ocrUsed ? textParts.join("\n\n") : text;
  return { text: finalText, blocks: ocrUsed ? ocrBlocks : textBlocks, images, ocrUsed, ocrProviderId };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPdfExtractor(): ExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    priority: 10,
    extract: extractPdf,
  };
}
