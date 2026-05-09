import type { DocumentUnit, ExtractedImage, LayoutBlock, OCRPlugin, UnitExtractionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Stage 3 — Text / Layout Extraction
//
// Plugin contract, built-in registry, and the public extractUnit() entry point.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

export type ExtractionLimits = {
  /** Max pages/units to process per document. */
  maxPages: number;
  /** Max total pixels across all rendered images (for image-fallback path). */
  maxPixels: number;
  /** Minimum native text chars before triggering OCR / image fallback. */
  minTextChars: number;
};

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxPages: 20,
  maxPixels: 8_000_000,
  minTextChars: 200,
};

export type ExtractorPluginRequest = {
  /** Full document buffer (not just a single page slice). */
  buffer: Buffer;
  mimeType: string;
  unit: DocumentUnit;
  limits: ExtractionLimits;
  /** Optional OCR provider injected by the caller. Used when native text is insufficient. */
  ocrPlugin?: OCRPlugin;
  /** Called when image rendering fails (non-fatal). */
  onImageExtractionError?: (err: unknown) => void;
};

export type ExtractorPluginResult = {
  text: string;
  blocks: LayoutBlock[];
  images: ExtractedImage[];
  ocrUsed: boolean;
  ocrProviderId?: string;
};

export type ExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  /** Lower number = higher priority when multiple plugins match the same MIME type. */
  priority?: number;
  extract: (request: ExtractorPluginRequest) => Promise<ExtractorPluginResult>;
};

// ---------------------------------------------------------------------------
// Built-in plugin loader (lazy — avoids startup cost and circular imports)
// ---------------------------------------------------------------------------

let builtinPluginsPromise: Promise<ExtractorPlugin[]> | null = null;

async function getBuiltinPlugins(): Promise<ExtractorPlugin[]> {
  if (!builtinPluginsPromise) {
    builtinPluginsPromise = (async () => {
      const [{ createPdfExtractor }, { createImageExtractor }, { createPlainTextExtractor }, { createSpreadsheetExtractor }] =
        await Promise.all([
          import("./extractors/pdf-extractor.js"),
          import("./extractors/image-extractor.js"),
          import("./extractors/plain-text-extractor.js"),
          import("./extractors/spreadsheet-extractor.js"),
        ]);
      return [
        createPdfExtractor(),
        createImageExtractor(),
        createPlainTextExtractor(),
        createSpreadsheetExtractor(),
      ];
    })().catch((err) => {
      builtinPluginsPromise = null;
      throw err;
    });
  }
  return builtinPluginsPromise;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Stage 3 — extract text and images from a single DocumentUnit.
 *
 * Tries built-in plugins (plus any caller-supplied extras) in priority order.
 * The first plugin whose mimeTypes includes the document MIME type is used.
 * Returns null when no plugin matches — the pipeline records this as a partial
 * result rather than a hard failure.
 */
export async function extractUnit(params: {
  buffer: Buffer;
  mimeType: string;
  unit: DocumentUnit;
  limits?: Partial<ExtractionLimits>;
  ocrPlugin?: OCRPlugin;
  extraPlugins?: ExtractorPlugin[];
  onImageExtractionError?: (err: unknown) => void;
}): Promise<UnitExtractionResult | null> {
  const limits: ExtractionLimits = {
    ...DEFAULT_EXTRACTION_LIMITS,
    ...params.limits,
  };

  const builtins = await getBuiltinPlugins();
  const all = [...builtins, ...(params.extraPlugins ?? [])].sort(
    (a, b) => (a.priority ?? 50) - (b.priority ?? 50),
  );

  const mime = params.mimeType.toLowerCase();
  const plugin = all.find((p) => p.mimeTypes.map((m) => m.toLowerCase()).includes(mime));
  if (!plugin) return null;

  const result = await plugin.extract({
    buffer: params.buffer,
    mimeType: params.mimeType,
    unit: params.unit,
    limits,
    ocrPlugin: params.ocrPlugin,
    onImageExtractionError: params.onImageExtractionError,
  });

  return {
    unitIndex: params.unit.index,
    text: result.text,
    blocks: result.blocks,
    images: result.images,
    extractorId: plugin.id,
    ocrUsed: result.ocrUsed,
    ocrProviderId: result.ocrProviderId,
  };
}
