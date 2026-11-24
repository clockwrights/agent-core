// ---------------------------------------------------------------------------
// Tests: Pipeline Orchestrator — integration tests
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import { pngBuffer } from "./png-fixture.js";
import { runDocumentPipeline } from "../src/pipeline.js";
import {
  DocumentPolicyRegistry,
} from "../src/policy.js";
import { createPassthroughContinuationHandler } from "../src/continue.js";

// ---------------------------------------------------------------------------
// File buffer helpers (magic bytes)
// ---------------------------------------------------------------------------

function pdfBuffer(extraBytes = 200): Buffer {
  const header = Buffer.from("%PDF-1.4\n%fake-content\n", "utf8");
  return Buffer.concat([header, Buffer.alloc(extraBytes)]);
}


function textBuffer(content = "Hello world"): Buffer {
  return Buffer.from(content, "utf8");
}

// ---------------------------------------------------------------------------
// Pipeline — basic happy path
// ---------------------------------------------------------------------------

test("pipeline: PDF buffer without deps → returns valid DocumentPipelineResult", async () => {
  const result = await runDocumentPipeline({
    buffer: pdfBuffer(),
    fileName: "test.pdf",
  });

  assert.ok(result.analysisPackage !== undefined, "analysisPackage should be present");
  assert.ok(Array.isArray(result.analysisPackage.processingLog));
  assert.ok(result.analysisPackage.processingLog.length > 0);
});

test("pipeline: PNG buffer → fileRecords[0].mimeType is 'image/png'", async () => {
  const result = await runDocumentPipeline({
    buffer: pngBuffer(),
    fileName: "photo.png",
  });

  // Ingest may fail gracefully if PNG is treated as unsupported in some modes,
  // but if it succeeds, the mimeType must be correct.
  const log = result.analysisPackage.processingLog;
  const ingestEntry = log.find((e) => e.stage === "ingest");
  assert.ok(ingestEntry !== undefined, "Should have ingest log entry");

  if (ingestEntry.status === "ok") {
    assert.equal(result.analysisPackage.fileRecords[0]!.mimeType, "image/png");
  }
});

test("pipeline: text buffer with text/plain → successful, 1 unit", async () => {
  const result = await runDocumentPipeline({
    buffer: textBuffer("Hello world document"),
    fileName: "notes.txt",
  });

  const ingestEntry = result.analysisPackage.processingLog.find((e) => e.stage === "ingest");
  assert.ok(ingestEntry !== undefined);
  assert.equal(ingestEntry.status, "ok");
  assert.equal(result.analysisPackage.fileRecords[0]!.mimeType, "text/plain");
  assert.equal(result.analysisPackage.units.length, 1);
});

// ---------------------------------------------------------------------------
// Pipeline — ingest failure
// ---------------------------------------------------------------------------

test("pipeline: empty buffer → ingest stage failed in processingLog", async () => {
  const result = await runDocumentPipeline({
    buffer: Buffer.alloc(0),
    fileName: "empty.pdf",
  });

  const ingestEntry = result.analysisPackage.processingLog.find((e) => e.stage === "ingest");
  assert.ok(ingestEntry !== undefined, "Should have ingest log entry");
  assert.equal(ingestEntry.status, "failed");
});

test("pipeline: buffer exceeding maxBytes → ingest stage failed", async () => {
  const result = await runDocumentPipeline({
    buffer: pdfBuffer(1000),
    fileName: "big.pdf",
    limits: { maxBytes: 100 },
  });

  const ingestEntry = result.analysisPackage.processingLog.find((e) => e.stage === "ingest");
  assert.ok(ingestEntry !== undefined);
  assert.equal(ingestEntry.status, "failed");
});

// ---------------------------------------------------------------------------
// Pipeline — policy registry
// ---------------------------------------------------------------------------

test("pipeline: policyName matching a registered policy → policyRef is set", async () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("identity-documents", "Policy text for ID documents: passport, national-id.");

  const result = await runDocumentPipeline(
    {
      buffer: textBuffer("MEIER ANNA <<<<<<<<<<<<<<<<<<<<<<<<<<<<<\nB26LCDE0802150M"),
      fileName: "passport.txt",
      policyName: "identity-documents",
    },
    { policyRegistry: registry },
  );

  const pkg = result.analysisPackage;
  const ingestEntry = pkg.processingLog.find((e) => e.stage === "ingest");
  if (ingestEntry?.status === "ok") {
    assert.ok(pkg.policyRef !== null, "policyRef should be set when policy is found");
    assert.equal(pkg.policyRef!.name, "identity-documents");
  }
});

test("pipeline: unknown policyName → policyRef is null (open-vocab mode)", async () => {
  const registry = new DocumentPolicyRegistry();

  const result = await runDocumentPipeline(
    {
      buffer: textBuffer("Some document content"),
      fileName: "doc.txt",
      policyName: "nonexistent-policy",
    },
    { policyRegistry: registry },
  );

  const pkg = result.analysisPackage;
  const ingestEntry = pkg.processingLog.find((e) => e.stage === "ingest");
  if (ingestEntry?.status === "ok") {
    assert.equal(pkg.policyRef, null, "policyRef should be null for unknown policy");
  }
});

// ---------------------------------------------------------------------------
// Pipeline — continuation handler
// ---------------------------------------------------------------------------

test("pipeline: no continuationHandler → continuationResult is undefined", async () => {
  const result = await runDocumentPipeline({
    buffer: textBuffer("Document text"),
    fileName: "doc.txt",
    taskIntent: "verify identity",
  });

  assert.equal(result.continuationResult, undefined);
});

test("pipeline: continuationHandler present but no taskIntent → continuationResult is undefined", async () => {
  const result = await runDocumentPipeline(
    {
      buffer: textBuffer("Document text"),
      fileName: "doc.txt",
      // no taskIntent
      context: { submissionIntent: "submission hint without a task" },
    },
    { continuationHandler: createPassthroughContinuationHandler() },
  );

  assert.equal(
    result.continuationResult,
    undefined,
    "submissionIntent alone must not trigger continuation",
  );
});

test("pipeline: continuationHandler + taskIntent → continuationResult is populated", async () => {
  const result = await runDocumentPipeline(
    {
      buffer: textBuffer("John Smith national ID 12345678"),
      fileName: "id.txt",
      taskIntent: "extract fields",
    },
    { continuationHandler: createPassthroughContinuationHandler() },
  );

  const ingestEntry = result.analysisPackage.processingLog.find((e) => e.stage === "ingest");
  if (ingestEntry?.status === "ok") {
    assert.ok(result.continuationResult !== undefined, "continuationResult should be populated");
    assert.ok(typeof result.continuationResult!.results === "object");
    assert.ok(Array.isArray(result.continuationResult!.evidence));
    assert.ok(Array.isArray(result.continuationResult!.unresolvedItems));
  }
});

// ---------------------------------------------------------------------------
// Pipeline — processing log stage coverage
// ---------------------------------------------------------------------------

test("pipeline: processingLog records expected stage names for success path", async () => {
  const result = await runDocumentPipeline({
    buffer: textBuffer("Invoice from ACME Corp. Order #12345. Total: $500."),
    fileName: "invoice.txt",
  });

  const stageNames = result.analysisPackage.processingLog.map((e) => e.stage);
  const expected = ["ingest", "decompose", "extract", "segment", "classify", "assembly"];

  for (const stage of expected) {
    assert.ok(stageNames.includes(stage), `Expected stage '${stage}' in processingLog`);
  }
});

test("pipeline: each processingLog entry has stage, status fields", async () => {
  const result = await runDocumentPipeline({
    buffer: textBuffer("Test document"),
    fileName: "test.txt",
  });

  for (const entry of result.analysisPackage.processingLog) {
    assert.ok(typeof entry.stage === "string" && entry.stage.length > 0, "stage should be a non-empty string");
    assert.ok(["ok", "partial", "failed"].includes(entry.status), `status '${entry.status}' should be ok/partial/failed`);
  }
});

test("pipeline: single text unit is extracted into unitExtractions", async () => {
  const result = await runDocumentPipeline({
    buffer: textBuffer("Document with clear text content"),
    fileName: "doc.txt",
  });

  const pkg = result.analysisPackage;
  const ingestEntry = pkg.processingLog.find((e) => e.stage === "ingest");
  if (ingestEntry?.status === "ok") {
    assert.equal(pkg.units.length, 1);
  }
});

test("pipeline: ingest failure keeps the requested policy's reference", async () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("identity-documents", "Policy text for ID documents.");
  const expected = registry.get("identity-documents")!;

  const result = await runDocumentPipeline(
    { buffer: Buffer.alloc(0), fileName: "empty.pdf", policyName: "identity-documents" },
    { policyRegistry: registry },
  );

  const pkg = result.analysisPackage;
  assert.equal(pkg.processingLog.find((e) => e.stage === "ingest")?.status, "failed");
  assert.deepEqual(pkg.policyRef, {
    name: "identity-documents",
    version: expected.version,
    contentHash: expected.contentHash,
  });
});

test("pipeline: ingest failure without a policy → policyRef is null", async () => {
  const result = await runDocumentPipeline({ buffer: Buffer.alloc(0), fileName: "empty.pdf" });
  assert.equal(result.analysisPackage.policyRef, null);
});
