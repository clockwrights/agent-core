// ---------------------------------------------------------------------------
// ZIP Submission Expansion
//
// Spec §1: "ZIP as special supported file ... extract and treat them
// separately (parallel?)."
//
// When the Stage 1 ingest determines a submission's MIME is application/zip,
// the orchestrator delegates to `expandZipSubmission`, which:
//
//   1. Reads each entry from the archive in archive order.
//   2. Runs Stage 1 ingest on each entry (MIME validation, size check, hash).
//   3. Runs Stage 2 decompose on each entry to produce its DocumentUnits.
//   4. Renumbers unit indices into a single submission-wide sequence.
//   5. Stamps every unit's `sourceFileIndex` to the entry's position in
//      the returned `fileRecords` array.
//
// Per-entry failures (empty entries, oversize entries, unsupported types,
// nested ZIPs, corrupt deflate streams) are recorded as warnings and the
// entry is skipped; the rest of the archive is still processed.
//
// Parallelism is configurable per call:
//   - "sequential" (default) — processes entries one after another.
//     Produces a deterministic processing log and bounded peak memory.
//   - "parallel" — runs ingest + decompose for all entries concurrently.
//     Faster on archives with many small entries; the processing log
//     for individual entries is interleaved.
//
// Both modes produce identical `fileRecords` and `units` output (same
// archive order); only timing and log ordering differ.
//
// Nested ZIPs (an entry whose detected MIME is application/zip) are
// rejected at this stage: recursion is bounded to one level.
// ---------------------------------------------------------------------------

import AdmZip from "adm-zip";
import { decomposeFile } from "./decompose.js";
import { ingestFile } from "./ingest.js";
import type { DocumentUnit, FileRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ZipExtractionParallelism = "sequential" | "parallel";

export type ZipExpansionOptions = {
  /** Maximum size for any individual entry (uncompressed). Defaults to 50 MB. */
  maxEntryBytes?: number;
  /**
   * Maximum total units across all entries. When exceeded, trailing entries'
   * units are dropped (whole entries are kept or fully dropped — never split).
   */
  maxUnits?: number;
  /** Concurrency mode. Defaults to "sequential". */
  parallelism?: ZipExtractionParallelism;
};

export type ZipExpansionResult = {
  /** One record per successfully ingested entry, in archive order. */
  fileRecords: FileRecord[];
  /** Per-entry buffers, aligned with `fileRecords`. Used by Stage 3 (extract). */
  entryBuffers: Buffer[];
  /**
   * All units produced by all entries, with submission-wide unique indices
   * and `sourceFileIndex` pointing into `fileRecords`.
   */
  units: DocumentUnit[];
  /**
   * Per-entry warnings: empty entries, oversize, unsupported, nested ZIP,
   * corrupt deflate, etc. The pipeline appends these to the processing log.
   */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_UNITS = 50;

export async function expandZipSubmission(
  zipBuffer: Buffer,
  options: ZipExpansionOptions = {},
): Promise<ZipExpansionResult> {
  const {
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxUnits = DEFAULT_MAX_UNITS,
    parallelism = "sequential",
  } = options;

  // Open the archive. Failure here is fatal — the orchestrator handles it.
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error("Failed to read ZIP archive", {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // Filter out directories and __MACOSX metadata.
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX/"));

  // Process entries; preserve archive order in the output regardless of mode.
  const processed: Array<EntryResult | null> =
    parallelism === "parallel"
      ? await Promise.all(entries.map((e) => processEntry(e, maxEntryBytes)))
      : await processSequentially(entries, maxEntryBytes);

  // Assemble fileRecords + entryBuffers + units in archive order.
  const fileRecords: FileRecord[] = [];
  const entryBuffers: Buffer[] = [];
  const units: DocumentUnit[] = [];
  const warnings: string[] = [];
  let nextGlobalIndex = 1;

  for (const item of processed) {
    if (!item) continue;
    if (item.kind === "warning") {
      warnings.push(item.message);
      continue;
    }

    // Apply maxUnits cap globally — drop trailing whole entries that overflow.
    if (units.length + item.units.length > maxUnits) {
      const remaining = maxUnits - units.length;
      if (remaining <= 0) {
        warnings.push(
          `entry "${item.fileRecord.fileName}" dropped — maxUnits cap (${maxUnits}) reached`,
        );
        continue;
      }
      // Partial: include only the first `remaining` units of this entry.
      const dropped = item.units.length - remaining;
      warnings.push(
        `entry "${item.fileRecord.fileName}" truncated — ${dropped} unit(s) dropped (maxUnits cap ${maxUnits})`,
      );
      item.units = item.units.slice(0, remaining);
    }

    const sourceFileIndex = fileRecords.length;
    fileRecords.push(item.fileRecord);
    entryBuffers.push(item.buffer);

    for (const u of item.units) {
      units.push({
        ...u,
        index: nextGlobalIndex++,
        sourceFileIndex,
      });
    }
  }

  return { fileRecords, entryBuffers, units, warnings };
}

// ---------------------------------------------------------------------------
// Internal — process a single ZIP entry
// ---------------------------------------------------------------------------

type EntrySuccess = {
  kind: "success";
  fileRecord: FileRecord;
  buffer: Buffer;
  units: DocumentUnit[];
};

type EntryWarning = {
  kind: "warning";
  message: string;
};

type EntryResult = EntrySuccess | EntryWarning;

/** Read entry bytes, ingest, decompose. Returns either success or a warning record. */
async function processEntry(
  entry: AdmZip.IZipEntry,
  maxEntryBytes: number,
): Promise<EntryResult> {
  const entryName = entry.entryName;

  // 1. Get bytes. AdmZip's getData throws on corrupt deflate streams.
  let entryBuffer: Buffer;
  try {
    entryBuffer = entry.getData();
  } catch (err) {
    return {
      kind: "warning",
      message: `entry "${entryName}" skipped — failed to decompress: ${errorMessage(err)}`,
    };
  }

  if (entryBuffer.byteLength === 0) {
    return { kind: "warning", message: `entry "${entryName}" skipped — empty` };
  }

  // 2. Ingest (MIME validation, size, hash). Catches every typed error
  //    from ingestFile and converts to a warning so other entries proceed.
  let fileRecord: FileRecord;
  try {
    fileRecord = await ingestFile({
      buffer: entryBuffer,
      fileName: entryName,
      maxBytes: maxEntryBytes,
    });
  } catch (err) {
    return {
      kind: "warning",
      message: `entry "${entryName}" skipped — ${errorMessage(err)}`,
    };
  }

  // 3. Reject nested ZIPs. Recursion is intentionally bounded to one level.
  if (fileRecord.mimeType === "application/zip") {
    return {
      kind: "warning",
      message: `entry "${entryName}" skipped — nested ZIP archives are not supported`,
    };
  }

  // 4. Decompose into units. Failure here is logged but the entry's
  //    fileRecord is still kept so callers know the file existed.
  let units: DocumentUnit[];
  try {
    units = await decomposeFile({
      buffer: entryBuffer,
      mimeType: fileRecord.mimeType,
    });
  } catch (err) {
    return {
      kind: "warning",
      message: `entry "${entryName}" skipped — decomposition failed: ${errorMessage(err)}`,
    };
  }

  return { kind: "success", fileRecord, buffer: entryBuffer, units };
}

/** Sequential variant — preserves processing order. */
async function processSequentially(
  entries: AdmZip.IZipEntry[],
  maxEntryBytes: number,
): Promise<EntryResult[]> {
  const out: EntryResult[] = [];
  for (const e of entries) {
    out.push(await processEntry(e, maxEntryBytes));
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
