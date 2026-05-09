import type { ExtractorPlugin, ExtractorPluginRequest, ExtractorPluginResult } from "../extract.js";
import { wordBoxesToLayoutBlocks } from "../ocr.js";

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

type PdfTextItem = { str: string };
type PdfTextContent = { items: Array<PdfTextItem | object> };
type PdfViewport = { width: number; height: number };

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
  const textParts: string[] = [];
  let textLen = 0;
  for (const pageNum of pageNumbers) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? (item as PdfTextItem).str : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textLen = appendText(textParts, pageText, textLen);
      if (textLen >= MAX_TEXT_CHARS) break;
    }
  }
  const text = textParts.join("\n\n");

  // If native text is sufficient, return it without rendering.
  if (text.trim().length >= request.limits.minTextChars) {
    return { text, blocks: [], images: [], ocrUsed: false };
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
    return { text, blocks: [], images: [], ocrUsed: false };
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

  const finalText = ocrUsed ? textParts.join("\n\n") : text;
  return { text: finalText, blocks: ocrBlocks, images, ocrUsed, ocrProviderId };
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
