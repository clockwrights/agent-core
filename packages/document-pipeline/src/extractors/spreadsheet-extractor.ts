import type { ExtractorPlugin, ExtractorPluginRequest, ExtractorPluginResult } from "../extract.js";

// ---------------------------------------------------------------------------
// Spreadsheet Extractor
//
// Handles XLSX and XLS files using the `xlsx` package.
// Converts the target sheet (identified by unit.index - 1) to a CSV-style
// text representation so downstream stages can work with it as plain text.
// ---------------------------------------------------------------------------

type XlsxModule = {
  read(buffer: Buffer, opts: { type: "buffer" }): XlsxWorkbook;
  utils: {
    sheet_to_csv(sheet: XlsxSheet): string;
  };
};

type XlsxWorkbook = {
  SheetNames: string[];
  Sheets: Record<string, XlsxSheet>;
};

type XlsxSheet = object;

let xlsxPromise: Promise<XlsxModule> | null = null;

async function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = (import("xlsx") as Promise<XlsxModule>).catch((err) => {
      xlsxPromise = null;
      throw new Error("xlsx is required for spreadsheet extraction", { cause: err });
    });
  }
  return xlsxPromise;
}

const MAX_TEXT_CHARS = 200_000;

async function extractSpreadsheet(
  request: ExtractorPluginRequest,
): Promise<ExtractorPluginResult> {
  const xlsx = await loadXlsx();
  const workbook = xlsx.read(request.buffer, { type: "buffer" });

  // unit.index is 1-based; SheetNames is 0-based.
  const sheetIndex = Math.max(0, request.unit.index - 1);
  const sheetName = workbook.SheetNames[sheetIndex] ?? workbook.SheetNames[0];
  if (!sheetName) {
    return { text: "", blocks: [], images: [], ocrUsed: false };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { text: "", blocks: [], images: [], ocrUsed: false };
  }

  const header = `[Sheet: ${sheetName}]\n`;
  const csv = xlsx.utils.sheet_to_csv(sheet);
  const combined = header + csv;
  const text = combined.length > MAX_TEXT_CHARS ? combined.slice(0, MAX_TEXT_CHARS) : combined;

  return { text, blocks: [], images: [], ocrUsed: false };
}

export function createSpreadsheetExtractor(): ExtractorPlugin {
  return {
    id: "spreadsheet",
    label: "Spreadsheet",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ],
    priority: 20,
    extract: extractSpreadsheet,
  };
}
