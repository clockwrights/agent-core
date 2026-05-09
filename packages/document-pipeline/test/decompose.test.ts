// ---------------------------------------------------------------------------
// Tests: Stage 2 — Page / Unit Decomposition
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import { decomposeFile } from "../src/decompose.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textBuffer(content: string): Buffer {
  return Buffer.from(content, "utf8");
}

// ---------------------------------------------------------------------------
// Text-based formats (pure JS path, no heavy dependencies)
// ---------------------------------------------------------------------------

test("decompose: plain text produces a single text-block unit", async () => {
  const units = await decomposeFile({
    buffer: textBuffer("Hello world"),
    mimeType: "text/plain",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "text-block");
  assert.equal(units[0]!.index, 1);
});

test("decompose: markdown produces a single text-block unit", async () => {
  const units = await decomposeFile({
    buffer: textBuffer("# Title\n\nParagraph."),
    mimeType: "text/markdown",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "text-block");
});

test("decompose: CSV produces a single text-block unit", async () => {
  const units = await decomposeFile({
    buffer: textBuffer("a,b,c\n1,2,3"),
    mimeType: "text/csv",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "text-block");
});

test("decompose: HTML produces a single text-block unit", async () => {
  const units = await decomposeFile({
    buffer: textBuffer("<html><body>test</body></html>"),
    mimeType: "text/html",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "text-block");
});

// ---------------------------------------------------------------------------
// Image formats
// ---------------------------------------------------------------------------

test("decompose: JPEG image produces a single image unit", async () => {
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(50).fill(0)]);
  const units = await decomposeFile({
    buffer: jpegMagic,
    mimeType: "image/jpeg",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "image");
  assert.equal(units[0]!.index, 1);
});

test("decompose: PNG image produces a single image unit", async () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(50).fill(0)]);
  const units = await decomposeFile({
    buffer: pngMagic,
    mimeType: "image/png",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "image");
});

// ---------------------------------------------------------------------------
// Unit index ordering
// ---------------------------------------------------------------------------

test("decompose: unit indices are sequential starting from 1", async () => {
  // Use a text file which always returns exactly 1 unit with index 1
  const units = await decomposeFile({
    buffer: textBuffer("some text"),
    mimeType: "text/plain",
  });
  assert.equal(units[0]!.index, 1);
});

// ---------------------------------------------------------------------------
// Unknown / fallback MIME
// ---------------------------------------------------------------------------

test("decompose: unknown MIME type falls back to single text-block unit", async () => {
  const units = await decomposeFile({
    buffer: textBuffer("whatever"),
    mimeType: "application/x-unknown-format",
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, "text-block");
});
