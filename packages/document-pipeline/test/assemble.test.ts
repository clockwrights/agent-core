// ---------------------------------------------------------------------------
// Tests: Analysis Package Assembly and Processing Log Helpers
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleAnalysisPackage,
  createProcessingLog,
  logStage,
} from "../src/assemble.js";
import type {
  FileRecord,
  DocumentUnit,
  UnitExtractionResult,
  SegmentationMap,
  ClassifiedDocumentGroup,
  DocumentPolicy,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFileRecord(): FileRecord {
  return {
    fileName: "test.pdf",
    contentHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    sizeBytes: 1024,
    mimeType: "application/pdf",
    ingestedAt: new Date().toISOString(),
  };
}

function makeUnit(index: number): DocumentUnit {
  return { index, kind: "page", sourceFileIndex: 0 };
}

function makeExtraction(unitIndex: number): UnitExtractionResult {
  return { unitIndex, text: "Sample text", blocks: [], images: [], extractorId: "pdf", ocrUsed: false };
}

function makeSegmentationMap(groupId: string, unitIndices: number[]): SegmentationMap {
  return {
    groups: [{ id: groupId, unitIndices, confidence: 1, segmentationMethod: "single-group" }],
  };
}

function makeClassifiedGroup(groupId: string): ClassifiedDocumentGroup {
  return {
    groupId,
    label: "passport",
    unsupported: false,
    classificationTier: "tier-b",
    classificationConfidence: 0.9,
    fields: [{ name: "name", value: "John Doe", confidence: 0.95, sourceUnitIndex: 1, method: "llm-text" }],
    uncertaintyFlags: [],
  };
}

function makePolicy(): DocumentPolicy {
  return {
    name: "test-policy",
    version: "1.0.0",
    contentHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    policyText: "Policy text here",
  };
}

// ---------------------------------------------------------------------------
// createProcessingLog
// ---------------------------------------------------------------------------

test("createProcessingLog: returns empty array", () => {
  const log = createProcessingLog();
  assert.deepEqual(log, []);
  assert.ok(Array.isArray(log));
});

// ---------------------------------------------------------------------------
// logStage
// ---------------------------------------------------------------------------

test("logStage: appends entry with required fields", () => {
  const log = createProcessingLog();
  logStage(log, "ingest", "ok");

  assert.equal(log.length, 1);
  assert.equal(log[0]!.stage, "ingest");
  assert.equal(log[0]!.status, "ok");
});

test("logStage: appends detail when provided", () => {
  const log = createProcessingLog();
  logStage(log, "decompose", "partial", "some issue");

  assert.equal(log[0]!.detail, "some issue");
});

test("logStage: durationMs is undefined when no startMs", () => {
  const log = createProcessingLog();
  logStage(log, "segment", "ok");

  assert.equal(log[0]!.durationMs, undefined);
});

test("logStage: durationMs is non-negative number when startMs provided", () => {
  const log = createProcessingLog();
  const startMs = Date.now() - 50;
  logStage(log, "extract", "ok", undefined, startMs);

  const duration = log[0]!.durationMs;
  assert.ok(typeof duration === "number", "durationMs should be a number");
  assert.ok(duration >= 0, "durationMs should be non-negative");
});

test("logStage: multiple calls append sequentially", () => {
  const log = createProcessingLog();
  logStage(log, "ingest", "ok");
  logStage(log, "decompose", "ok");
  logStage(log, "extract", "failed", "extraction error");

  assert.equal(log.length, 3);
  assert.equal(log[0]!.stage, "ingest");
  assert.equal(log[1]!.stage, "decompose");
  assert.equal(log[2]!.stage, "extract");
  assert.equal(log[2]!.status, "failed");
});

// ---------------------------------------------------------------------------
// assembleAnalysisPackage — happy path
// ---------------------------------------------------------------------------

test("assembleAnalysisPackage: builds complete AnalysisPackage from valid input", () => {
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy: makePolicy(),
    processingLog: [],
  };

  const pkg = assembleAnalysisPackage(input);

  assert.deepEqual(pkg.fileRecords, input.fileRecords);
  assert.deepEqual(pkg.units, input.units);
  assert.deepEqual(pkg.unitExtractions, input.unitExtractions);
  assert.deepEqual(pkg.classifiedGroups, input.classifiedGroups);
  assert.ok(Array.isArray(pkg.processingLog));
});

test("assembleAnalysisPackage: processingLog includes 'assembly' stage with 'ok'", () => {
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy: null,
    processingLog: [],
  };

  const pkg = assembleAnalysisPackage(input);

  const assemblyEntry = pkg.processingLog.find((e) => e.stage === "assembly");
  assert.ok(assemblyEntry !== undefined, "Should have an assembly log entry");
  assert.equal(assemblyEntry.status, "ok");
});

test("assembleAnalysisPackage: policyRef is populated when policy provided", () => {
  const policy = makePolicy();
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy,
    processingLog: [],
  };

  const pkg = assembleAnalysisPackage(input);

  assert.ok(pkg.policyRef !== null);
  assert.equal(pkg.policyRef!.name, policy.name);
  assert.equal(pkg.policyRef!.version, policy.version);
  assert.equal(pkg.policyRef!.contentHash, policy.contentHash);
});

test("assembleAnalysisPackage: policyRef is null when policy is null", () => {
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy: null,
    processingLog: [],
  };

  const pkg = assembleAnalysisPackage(input);
  assert.equal(pkg.policyRef, null);
});

test("assembleAnalysisPackage: existing processingLog entries are preserved", () => {
  const priorLog = createProcessingLog();
  logStage(priorLog, "ingest", "ok");
  logStage(priorLog, "decompose", "ok");

  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy: null,
    processingLog: priorLog,
  };

  const pkg = assembleAnalysisPackage(input);

  assert.ok(pkg.processingLog.some((e) => e.stage === "ingest"));
  assert.ok(pkg.processingLog.some((e) => e.stage === "decompose"));
  assert.ok(pkg.processingLog.some((e) => e.stage === "assembly"));
});

// ---------------------------------------------------------------------------
// assembleAnalysisPackage — validation warnings
// ---------------------------------------------------------------------------

test("assembleAnalysisPackage: mismatched unit/extraction → assembly status 'partial'", () => {
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1), makeUnit(2)], // unit 2 has no extraction
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy: null,
    processingLog: [],
  };

  const pkg = assembleAnalysisPackage(input);
  const assemblyEntry = pkg.processingLog.find((e) => e.stage === "assembly");

  assert.ok(assemblyEntry !== undefined);
  assert.equal(assemblyEntry.status, "partial");
  assert.ok(typeof assemblyEntry.detail === "string" && assemblyEntry.detail.length > 0);
});

test("assembleAnalysisPackage: is pure — same input same output", () => {
  const policy = makePolicy();
  const input = {
    fileRecords: [makeFileRecord()],
    units: [makeUnit(1)],
    unitExtractions: [makeExtraction(1)],
    segmentationMap: makeSegmentationMap("g1", [1]),
    classifiedGroups: [makeClassifiedGroup("g1")],
    policy,
    processingLog: [],
  };

  const pkg1 = assembleAnalysisPackage({ ...input, processingLog: [] });
  const pkg2 = assembleAnalysisPackage({ ...input, processingLog: [] });

  assert.equal(pkg1.policyRef?.name, pkg2.policyRef?.name);
  assert.equal(pkg1.policyRef?.contentHash, pkg2.policyRef?.contentHash);
});
