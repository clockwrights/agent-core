import { createHash } from "node:crypto";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type { FileRecord } from "./types.js";

// ---------------------------------------------------------------------------
// MIME type map (extension → MIME and reverse)
// Sourced from /media/mime.ts
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".css": "text/css",
  ".js": "text/javascript",
};

// MIME types considered too generic to override a more specific extension mapping
const GENERIC_MIMES = new Set(["application/octet-stream", "application/zip"]);

// Maximum bytes read for magic-byte sniffing (1 MB is more than enough for all formats)
const SNIFF_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Supported MIME types — any type outside this set is rejected at ingestion
// ---------------------------------------------------------------------------

export const SUPPORTED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword",                                                        // doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",        // xlsx
  "application/vnd.ms-excel",                                                  // xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/xml",
  "application/zip", // accepted as container; further validated by decomposition stage
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getExtension(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return ext || undefined;
}

function mimeFromExtension(fileName: string): string | undefined {
  const ext = getExtension(fileName);
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function normalizeDeclaredMime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isGenericMime(mime: string | undefined): boolean {
  return !mime || GENERIC_MIMES.has(mime);
}

async function sniffMime(buffer: Buffer): Promise<string | undefined> {
  const slice = buffer.byteLength <= SNIFF_MAX_BYTES ? buffer : buffer.subarray(0, SNIFF_MAX_BYTES);
  try {
    const result = await fileTypeFromBuffer(slice);
    return result?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the best MIME type from three competing signals:
 *  1. Magic-byte sniff  (most trustworthy)
 *  2. File extension    (reliable for text formats that have no magic bytes)
 *  3. Declared MIME     (caller hint, least trusted)
 *
 * Generic container types (application/zip, application/octet-stream) do not
 * override a more specific extension mapping — e.g. an XLSX sniffed as ZIP
 * should still be reported as the XLSX type.
 */
export async function detectMimeType(params: {
  buffer: Buffer;
  fileName?: string;
  declaredMimeType?: string;
}): Promise<string | undefined> {
  const extMime = params.fileName ? mimeFromExtension(params.fileName) : undefined;
  const declaredMime = normalizeDeclaredMime(params.declaredMimeType);
  const sniffed = await sniffMime(params.buffer);

  // Prefer sniffed — but don't let a generic container type overrule a precise extension map
  if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  if (declaredMime && !isGenericMime(declaredMime)) {
    return declaredMime;
  }
  if (sniffed) {
    return sniffed;
  }
  return declaredMime;
}

// ---------------------------------------------------------------------------
// Public: ingestFile
// ---------------------------------------------------------------------------

export class UnsupportedFileTypeError extends Error {
  constructor(public readonly detectedMimeType: string | undefined) {
    super(
      detectedMimeType
        ? `Unsupported file type: ${detectedMimeType}`
        : "Unable to determine file type",
    );
    this.name = "UnsupportedFileTypeError";
  }
}

export class EmptyFileError extends Error {
  constructor() {
    super("File is empty");
    this.name = "EmptyFileError";
  }
}

export class FileTooLargeError extends Error {
  constructor(public readonly sizeBytes: number, public readonly maxBytes: number) {
    super(`File too large: ${sizeBytes} bytes (limit: ${maxBytes} bytes)`);
    this.name = "FileTooLargeError";
  }
}

/**
 * Stage 1 — Ingestion and Normalization.
 *
 * Validates the raw file bytes, detects the MIME type, and produces a
 * canonical FileRecord. Throws a typed error for any validation failure.
 */
export async function ingestFile(params: {
  buffer: Buffer;
  fileName?: string;
  declaredMimeType?: string;
  maxBytes?: number;
}): Promise<FileRecord> {
  if (params.buffer.byteLength === 0) {
    throw new EmptyFileError();
  }

  if (params.maxBytes !== undefined && params.buffer.byteLength > params.maxBytes) {
    throw new FileTooLargeError(params.buffer.byteLength, params.maxBytes);
  }

  const mimeType = await detectMimeType({
    buffer: params.buffer,
    fileName: params.fileName,
    declaredMimeType: params.declaredMimeType,
  });

  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new UnsupportedFileTypeError(mimeType);
  }

  const contentHash = createHash("sha256").update(params.buffer).digest("hex");

  return {
    fileName: params.fileName ?? "unknown",
    contentHash,
    sizeBytes: params.buffer.byteLength,
    mimeType,
    ingestedAt: new Date().toISOString(),
  };
}
