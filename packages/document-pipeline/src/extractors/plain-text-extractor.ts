import type { ExtractorPlugin, ExtractorPluginRequest, ExtractorPluginResult } from "../extract.js";

// ---------------------------------------------------------------------------
// Plain Text Extractor
//
// Handles: text/plain, text/markdown, text/csv, text/html, text/xml,
//          application/xml, application/json
//
// Decodes the buffer as UTF-8 (with a fallback to latin-1 for legacy files)
// and returns the raw text. No layout analysis — text formats have no spatial
// structure to preserve.
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 200_000;

function decodeBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // Fallback for legacy documents with non-UTF-8 encoding.
    return new TextDecoder("latin1").decode(buffer);
  }
}

async function extractPlainText(
  request: ExtractorPluginRequest,
): Promise<ExtractorPluginResult> {
  const raw = decodeBuffer(request.buffer);
  const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
  return { text, blocks: [], images: [], ocrUsed: false };
}

export function createPlainTextExtractor(): ExtractorPlugin {
  return {
    id: "plain-text",
    label: "Plain Text",
    mimeTypes: [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/html",
      "text/xml",
      "application/xml",
      "application/json",
    ],
    priority: 30,
    extract: extractPlainText,
  };
}
