// ---------------------------------------------------------------------------
// Tests: Stage 1 — Ingestion and Normalisation
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ingestFile,
  detectMimeType,
  EmptyFileError,
  FileTooLargeError,
  UnsupportedFileTypeError,
  SUPPORTED_MIME_TYPES,
} from "../src/ingest.js";

// ---------------------------------------------------------------------------
// Minimal valid file buffers for magic-byte sniffing
// ---------------------------------------------------------------------------

/** PDF magic bytes: %PDF- */
function pdfBuffer(extraBytes = 100): Buffer {
  const header = Buffer.from("%PDF-1.4\n", "utf8");
  const pad = Buffer.alloc(extraBytes);
  return Buffer.concat([header, pad]);
}

/** PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A */
function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(100).fill(0)]);
}

/** JPEG magic bytes: FF D8 FF */
function jpegBuffer(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);
}

/** Plain-text buffer with no magic bytes */
function textBuffer(content = "Hello world"): Buffer {
  return Buffer.from(content, "utf8");
}

// ---------------------------------------------------------------------------
// ingestFile — happy paths
// ---------------------------------------------------------------------------

test("ingest: PDF buffer is accepted and produces correct FileRecord", async () => {
  const buf = pdfBuffer();
  const record = await ingestFile({ buffer: buf, fileName: "test.pdf" });

  assert.equal(record.fileName, "test.pdf");
  assert.equal(record.mimeType, "application/pdf");
  assert.equal(record.sizeBytes, buf.byteLength);
  assert.match(record.contentHash, /^[0-9a-f]{64}$/);
  // ISO 8601 timestamp
  assert.doesNotThrow(() => new Date(record.ingestedAt));
  assert.ok(new Date(record.ingestedAt).getTime() > 0);
});

test("ingest: PNG buffer is accepted", async () => {
  const buf = pngBuffer();
  const record = await ingestFile({ buffer: buf, fileName: "photo.png" });
  assert.equal(record.mimeType, "image/png");
});

test("ingest: JPEG buffer is accepted", async () => {
  const buf = jpegBuffer();
  const record = await ingestFile({ buffer: buf });
  assert.equal(record.mimeType, "image/jpeg");
});

test("ingest: plain text accepted via extension fallback", async () => {
  const buf = textBuffer("plain text document");
  const record = await ingestFile({ buffer: buf, fileName: "notes.txt" });
  assert.equal(record.mimeType, "text/plain");
  assert.equal(record.fileName, "notes.txt");
});

test("ingest: unknown fileName defaults to 'unknown'", async () => {
  const buf = pdfBuffer();
  const record = await ingestFile({ buffer: buf });
  assert.equal(record.fileName, "unknown");
});

test("ingest: content hash is stable for same bytes", async () => {
  const buf = pdfBuffer(50);
  const r1 = await ingestFile({ buffer: buf });
  const r2 = await ingestFile({ buffer: buf });
  assert.equal(r1.contentHash, r2.contentHash);
});

test("ingest: content hash differs for different bytes", async () => {
  const r1 = await ingestFile({ buffer: pdfBuffer(10) });
  const r2 = await ingestFile({ buffer: pdfBuffer(20) });
  assert.notEqual(r1.contentHash, r2.contentHash);
});

// ---------------------------------------------------------------------------
// ingestFile — error paths
// ---------------------------------------------------------------------------

test("ingest: empty buffer throws EmptyFileError", async () => {
  await assert.rejects(
    () => ingestFile({ buffer: Buffer.alloc(0) }),
    (err) => err instanceof EmptyFileError,
  );
});

test("ingest: file exceeding maxBytes throws FileTooLargeError", async () => {
  const buf = pdfBuffer(200);
  await assert.rejects(
    () => ingestFile({ buffer: buf, maxBytes: 50 }),
    (err) => {
      assert.ok(err instanceof FileTooLargeError);
      assert.equal((err as FileTooLargeError).sizeBytes, buf.byteLength);
      assert.equal((err as FileTooLargeError).maxBytes, 50);
      return true;
    },
  );
});

test("ingest: buffer with no recognisable MIME throws UnsupportedFileTypeError", async () => {
  // Random bytes with no magic header and no filename hint
  const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, ...Array(50).fill(0xab)]);
  await assert.rejects(
    () => ingestFile({ buffer: buf }),
    (err) => err instanceof UnsupportedFileTypeError,
  );
});

// ---------------------------------------------------------------------------
// SUPPORTED_MIME_TYPES sanity checks
// ---------------------------------------------------------------------------

test("SUPPORTED_MIME_TYPES includes expected types", () => {
  const required = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "text/plain",
    "text/csv",
  ];
  for (const mime of required) {
    assert.ok(SUPPORTED_MIME_TYPES.has(mime), `Expected ${mime} to be supported`);
  }
});

// ---------------------------------------------------------------------------
// detectMimeType — internal helper exported for testing
// ---------------------------------------------------------------------------

test("detectMimeType: sniffed MIME wins over extension", async () => {
  // PNG bytes but .pdf extension — magic bytes should win
  const detected = await detectMimeType({ buffer: pngBuffer(), fileName: "fake.pdf" });
  assert.equal(detected, "image/png");
});

test("detectMimeType: extension wins when sniff is generic", async () => {
  // text/plain has no magic bytes — sniff returns undefined; extension wins
  const detected = await detectMimeType({
    buffer: textBuffer("some text"),
    fileName: "document.csv",
  });
  assert.equal(detected, "text/csv");
});

test("detectMimeType: declared MIME used as last resort", async () => {
  // Completely opaque bytes that match no known file-type magic signature
  const detected = await detectMimeType({
    buffer: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]),
    declaredMimeType: "text/plain",
  });
  assert.equal(detected, "text/plain");
});
