// ---------------------------------------------------------------------------
// Tests: OCR Plugin Interface — helpers and null plugin
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNullOcrPlugin,
  validateOcrPlugin,
  wordBoxesToLayoutBlocks,
} from "../src/ocr.js";
import type { OCRResult } from "../src/ocr.js";

// ---------------------------------------------------------------------------
// createNullOcrPlugin
// ---------------------------------------------------------------------------

test("null OCR plugin: satisfies OCRPlugin contract", () => {
  const plugin = createNullOcrPlugin();
  assert.equal(typeof plugin.id, "string");
  assert.ok(plugin.id.length > 0);
  assert.equal(typeof plugin.label, "string");
  assert.ok(Array.isArray(plugin.supportedMimeTypes));
  assert.ok(Array.isArray(plugin.supportedLanguages));
  assert.equal(typeof plugin.recognize, "function");
});

test("null OCR plugin: recognize always returns empty result", async () => {
  const plugin = createNullOcrPlugin();
  const result = await plugin.recognize(Buffer.from("fake-image"), "image/png");
  assert.equal(result.text, "");
  assert.deepEqual(result.wordBoxes, []);
  assert.equal(result.confidence, 0);
});

test("null OCR plugin: recognize is stable across multiple calls", async () => {
  const plugin = createNullOcrPlugin();
  const r1 = await plugin.recognize(Buffer.alloc(10), "image/jpeg");
  const r2 = await plugin.recognize(Buffer.alloc(10), "image/jpeg");
  assert.deepEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// validateOcrPlugin
// ---------------------------------------------------------------------------

test("validateOcrPlugin: accepts a valid OCRPlugin object", () => {
  const plugin = createNullOcrPlugin();
  assert.equal(validateOcrPlugin(plugin), true);
});

test("validateOcrPlugin: rejects null", () => {
  assert.equal(validateOcrPlugin(null), false);
});

test("validateOcrPlugin: rejects plain object without required fields", () => {
  assert.equal(validateOcrPlugin({ id: "x" }), false);
});

test("validateOcrPlugin: rejects when id is empty string", () => {
  const plugin = {
    id: "",
    label: "test",
    supportedMimeTypes: [],
    supportedLanguages: [],
    recognize: async () => ({ text: "", wordBoxes: [], confidence: 0 }),
  };
  assert.equal(validateOcrPlugin(plugin), false);
});

test("validateOcrPlugin: rejects when recognize is not a function", () => {
  const plugin = {
    id: "x",
    label: "test",
    supportedMimeTypes: [],
    supportedLanguages: [],
    recognize: "not-a-function",
  };
  assert.equal(validateOcrPlugin(plugin), false);
});

// ---------------------------------------------------------------------------
// wordBoxesToLayoutBlocks
// ---------------------------------------------------------------------------

test("wordBoxesToLayoutBlocks: normalises pixel coords to 0-1 range", () => {
  const ocrResult: OCRResult = {
    text: "hello",
    wordBoxes: [
      {
        text: "hello",
        boundingBox: { x: 100, y: 50, width: 200, height: 30, coordSpace: "pixels" },
        confidence: 0.9,
      },
    ],
  };

  const blocks = wordBoxesToLayoutBlocks(ocrResult, 1000, 500);
  assert.equal(blocks.length, 1);
  const bb = blocks[0]!.boundingBox!;
  assert.equal(bb.coordSpace, "normalized");
  assert.ok(Math.abs(bb.x - 0.1) < 0.0001);
  assert.ok(Math.abs(bb.y - 0.1) < 0.0001);
  assert.ok(Math.abs(bb.width - 0.2) < 0.0001);
  assert.ok(Math.abs(bb.height - 0.06) < 0.0001);
  assert.equal(blocks[0]!.confidence, 0.9);
});

test("wordBoxesToLayoutBlocks: passes through already-normalized boxes unchanged", () => {
  const ocrResult: OCRResult = {
    text: "hello",
    wordBoxes: [
      {
        text: "hello",
        boundingBox: { x: 0.25, y: 0.5, width: 0.1, height: 0.05, coordSpace: "normalized" },
        confidence: 0.9,
      },
    ],
  };

  const blocks = wordBoxesToLayoutBlocks(ocrResult, 1000, 500);
  const bb = blocks[0]!.boundingBox!;
  assert.equal(bb.coordSpace, "normalized");
  // Provider-supplied normalized coords must NOT be re-divided by image dims.
  assert.equal(bb.x, 0.25);
  assert.equal(bb.y, 0.5);
  assert.equal(bb.width, 0.1);
  assert.equal(bb.height, 0.05);
});

test("wordBoxesToLayoutBlocks: empty wordBoxes with text returns single block", () => {
  const ocrResult: OCRResult = {
    text: "some text",
    wordBoxes: [],
    confidence: 0.75,
  };

  const blocks = wordBoxesToLayoutBlocks(ocrResult, 800, 600);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.text, "some text");
  assert.equal(blocks[0]!.confidence, 0.75);
  assert.equal(blocks[0]!.boundingBox, undefined);
});

test("wordBoxesToLayoutBlocks: empty wordBoxes with empty text returns empty array", () => {
  const ocrResult: OCRResult = {
    text: "  ",
    wordBoxes: [],
  };

  const blocks = wordBoxesToLayoutBlocks(ocrResult, 800, 600);
  assert.equal(blocks.length, 0);
});

test("wordBoxesToLayoutBlocks: multiple word boxes produce one block each", () => {
  const ocrResult: OCRResult = {
    text: "hello world",
    wordBoxes: [
      { text: "hello", boundingBox: { x: 0, y: 0, width: 100, height: 20, coordSpace: "pixels" }, confidence: 0.8 },
      { text: "world", boundingBox: { x: 110, y: 0, width: 100, height: 20, coordSpace: "pixels" }, confidence: 0.85 },
    ],
  };

  const blocks = wordBoxesToLayoutBlocks(ocrResult, 400, 100);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.text, "hello");
  assert.equal(blocks[1]!.text, "world");
});

test("wordBoxesToLayoutBlocks: guards against zero image dimensions", () => {
  const ocrResult: OCRResult = {
    text: "x",
    wordBoxes: [
      { text: "x", boundingBox: { x: 0, y: 0, width: 0, height: 0, coordSpace: "pixels" }, confidence: 1 },
    ],
  };

  // Should not divide by zero — uses max(dim, 1) internally
  assert.doesNotThrow(() => wordBoxesToLayoutBlocks(ocrResult, 0, 0));
});
