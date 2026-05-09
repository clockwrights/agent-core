import type { DocumentUnit } from "./types.js";

// ---------------------------------------------------------------------------
// Stage 2 — Page / Unit Decomposition
//
// Splits a file buffer into an ordered list of DocumentUnit records.
// Each format has its own splitter. Splitters are pure functions — no I/O
// except for the lazy-loaded pdfjs module.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pdfjs lazy loader (same pattern as document-extractor.ts)
// ---------------------------------------------------------------------------

type PdfPage = {
  getViewport(params: { scale: number }): { width: number; height: number };
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

let pdfJsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (
      import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>
    ).catch((err) => {
      pdfJsPromise = null;
      throw new Error("pdfjs-dist is required for PDF decomposition", { cause: err });
    });
  }
  return pdfJsPromise;
}

// ---------------------------------------------------------------------------
// xlsx lazy loader
// ---------------------------------------------------------------------------

type XlsxModule = {
  read(buffer: Buffer, opts: { type: "buffer" }): { SheetNames: string[] };
};

let xlsxPromise: Promise<XlsxModule> | null = null;

async function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = (import("xlsx") as Promise<XlsxModule>).catch((err) => {
      xlsxPromise = null;
      throw new Error("xlsx is required for spreadsheet decomposition", { cause: err });
    });
  }
  return xlsxPromise;
}

// ---------------------------------------------------------------------------
// TIFF IFD chain parser — pure JS, no extra dependency
//
// TIFF structure:
//   0–1  : byte-order mark  ("II" = LE, "MM" = BE)
//   2–3  : magic            (42 = TIFF, 43 = BigTIFF — BigTIFF not supported here)
//   4–7  : offset of first IFD
//
// Each IFD:
//   0–1  : entry count (uint16)
//   2–(count*12+1) : directory entries (12 bytes each)
//   last 4 bytes   : offset to next IFD (0 = end)
// ---------------------------------------------------------------------------

function countTiffFrames(buffer: Buffer): number {
  if (buffer.byteLength < 8) return 1;

  const marker = buffer.toString("ascii", 0, 2);
  const isLE = marker === "II";
  const isBE = marker === "MM";
  if (!isLE && !isBE) return 1;

  const read16 = (offset: number): number =>
    isLE ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const read32 = (offset: number): number =>
    isLE ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);

  const magic = read16(2);
  if (magic !== 42) return 1; // BigTIFF (43) or unknown — treat as 1 frame

  let ifdOffset = read32(4);
  let frameCount = 0;
  const visited = new Set<number>();

  while (ifdOffset !== 0 && ifdOffset + 2 <= buffer.byteLength) {
    if (visited.has(ifdOffset)) break; // cycle guard
    visited.add(ifdOffset);
    frameCount += 1;

    const entryCount = read16(ifdOffset);
    const nextIfdOffset = ifdOffset + 2 + entryCount * 12;
    if (nextIfdOffset + 4 > buffer.byteLength) break;
    ifdOffset = read32(nextIfdOffset);
  }

  return Math.max(frameCount, 1);
}

// ---------------------------------------------------------------------------
// Format-specific splitters
// ---------------------------------------------------------------------------

// Decomposers stamp `sourceFileIndex: 0` because, at this stage, they are
// processing a single file in isolation. The pipeline orchestrator overrides
// this for archive (ZIP) submissions where the unit comes from entry N.

async function decomposePdf(buffer: Buffer): Promise<DocumentUnit[]> {
  const pdfJs = await loadPdfJs();
  const pdf = await pdfJs.getDocument({ data: new Uint8Array(buffer), disableWorker: true })
    .promise;
  const units: DocumentUnit[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    units.push({
      index: i,
      kind: "page",
      sourceFileIndex: 0,
      widthPx: vp.width,
      heightPx: vp.height,
    });
  }
  return units;
}

function decomposeImage(_buffer: Buffer): DocumentUnit[] {
  return [{ index: 1, kind: "image", sourceFileIndex: 0 }];
}

function decomposeTiff(buffer: Buffer): DocumentUnit[] {
  const frameCount = countTiffFrames(buffer);
  return Array.from({ length: frameCount }, (_, i): DocumentUnit => ({
    index: i + 1,
    kind: "page",
    sourceFileIndex: 0,
  }));
}

async function decomposeSpreadsheet(buffer: Buffer): Promise<DocumentUnit[]> {
  const xlsx = await loadXlsx();
  const workbook = xlsx.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name, i): DocumentUnit => ({
    index: i + 1,
    kind: "sheet",
    sourceFileIndex: 0,
    ...(name ? { name } : {}),
  }));
}

function decomposeOfficeDocument(): DocumentUnit[] {
  // DOCX/DOC section splitting requires ZIP parsing (not yet available).
  // Treated as a single unit; granular section splitting is a future enhancement.
  return [{ index: 1, kind: "section", sourceFileIndex: 0 }];
}

function decomposePresentation(): DocumentUnit[] {
  // PPTX slide counting requires ZIP parsing (not yet available).
  // Treated as a single unit; granular slide splitting is a future enhancement.
  return [{ index: 1, kind: "section", sourceFileIndex: 0 }];
}

function decomposeTextFile(): DocumentUnit[] {
  return [{ index: 1, kind: "text-block", sourceFileIndex: 0 }];
}

// ---------------------------------------------------------------------------
// MIME → splitter dispatch table
// ---------------------------------------------------------------------------

const PDF_MIMES = new Set(["application/pdf"]);

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/heic",
  "image/heif",
]);

const TIFF_MIMES = new Set(["image/tiff"]);

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

const WORD_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

const PRESENTATION_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/xml",
]);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Stage 2 — Page/Unit Decomposition.
 *
 * Returns an ordered list of DocumentUnit records for the given buffer.
 * The caller is expected to have already validated the MIME type via Stage 1
 * (ingestFile). An unrecognised MIME type falls back to a single text-block unit.
 */
export async function decomposeFile(params: {
  buffer: Buffer;
  mimeType: string;
}): Promise<DocumentUnit[]> {
  const mime = params.mimeType.toLowerCase();

  if (PDF_MIMES.has(mime)) return decomposePdf(params.buffer);
  if (IMAGE_MIMES.has(mime)) return decomposeImage(params.buffer);
  if (TIFF_MIMES.has(mime)) return decomposeTiff(params.buffer);
  if (SPREADSHEET_MIMES.has(mime)) return decomposeSpreadsheet(params.buffer);
  if (WORD_MIMES.has(mime)) return decomposeOfficeDocument();
  if (PRESENTATION_MIMES.has(mime)) return decomposePresentation();
  if (TEXT_MIMES.has(mime)) return decomposeTextFile();

  // Fallback: unknown but accepted MIME — single text-block unit
  return [{ index: 1, kind: "text-block", sourceFileIndex: 0 }];
}
