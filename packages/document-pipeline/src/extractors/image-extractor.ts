import type { ExtractorPlugin, ExtractorPluginRequest, ExtractorPluginResult } from "../extract.js";
import { wordBoxesToLayoutBlocks } from "../ocr.js";

// ---------------------------------------------------------------------------
// Image Extractor
//
// Handles raster image formats (JPEG, PNG, WEBP, GIF, BMP, HEIC/HEIF).
// The image buffer is passed through directly as a single extracted image.
// If an OCR plugin is provided, it is run on the image to produce text.
// ---------------------------------------------------------------------------

async function extractImage(request: ExtractorPluginRequest): Promise<ExtractorPluginResult> {
  const imageData = request.buffer.toString("base64");
  const image: ExtractorPluginResult["images"][number] = {
    type: "image",
    data: imageData,
    mimeType: request.mimeType,
  };

  // If an OCR plugin is available, run it to produce text for downstream stages.
  if (request.ocrPlugin) {
    try {
      const ocrResult = await request.ocrPlugin.recognize(
        request.buffer,
        request.mimeType,
        { language: undefined, requestLayout: true },
      );
      const blocks = wordBoxesToLayoutBlocks(
        ocrResult,
        request.unit.widthPx ?? 0,
        request.unit.heightPx ?? 0,
      );
      return {
        text: ocrResult.text,
        blocks,
        images: [image],
        ocrUsed: true,
        ocrProviderId: request.ocrPlugin.id,
      };
    } catch {
      // OCR failure is non-fatal — return the image without text.
    }
  }

  return { text: "", blocks: [], images: [image], ocrUsed: false };
}

export function createImageExtractor(): ExtractorPlugin {
  return {
    id: "image",
    label: "Raster Image",
    mimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/heic",
      "image/heif",
    ],
    priority: 20,
    extract: extractImage,
  };
}
