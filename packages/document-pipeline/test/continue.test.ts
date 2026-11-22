// ---------------------------------------------------------------------------
// Tests: Continuation Interface — passthrough handler, LLM handler, prompt builder
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContinuationPrompt,
  createPassthroughContinuationHandler,
  createLlmContinuationHandler,
} from "../src/continue.js";
import type {
  AnalysisPackage,
  ClassifiedDocumentGroup,
} from "../src/types.js";
import type { PipelineLlmAdapter } from "../src/llm.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFileRecord() {
  return {
    fileName: "test.pdf",
    contentHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    sizeBytes: 1024,
    mimeType: "application/pdf",
    ingestedAt: new Date().toISOString(),
  };
}

function makeGroup(
  groupId: string,
  overrides: Partial<ClassifiedDocumentGroup> = {},
): ClassifiedDocumentGroup {
  return {
    groupId,
    label: "passport",
    unsupported: false,
    classificationTier: "tier-b",
    classificationConfidence: 0.9,
    fields: [{ name: "name", value: "John Doe", confidence: 0.95, sourceUnitIndex: 1, method: "llm-text" }],
    uncertaintyFlags: [],
    ...overrides,
  };
}

function makePackage(overrides: Partial<AnalysisPackage> = {}): AnalysisPackage {
  return {
    fileRecords: [makeFileRecord()],
    units: [{ index: 1, kind: "page", sourceFileIndex: 0 }],
    unitExtractions: [{ unitIndex: 1, text: "Sample text", blocks: [], images: [], extractorId: "pdf", ocrUsed: false }],
    segmentationMap: { groups: [{ id: "group-1", unitIndices: [1], confidence: 1, segmentationMethod: "single-group" }] },
    classifiedGroups: [makeGroup("group-1")],
    policyRef: null,
    processingLog: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildContinuationPrompt (pure function)
// ---------------------------------------------------------------------------

test("buildContinuationPrompt: includes task intent in output", () => {
  const pkg = makePackage();
  const INTENT = "verify_identity_UNIQUE";
  const prompt = buildContinuationPrompt(pkg, INTENT);
  assert.ok(prompt.includes(INTENT), "Task intent should appear in prompt");
});

test("buildContinuationPrompt: includes file name", () => {
  const pkg = makePackage();
  const prompt = buildContinuationPrompt(pkg, "do something");
  assert.ok(prompt.includes("test.pdf"), "File name should appear in prompt");
});

test("buildContinuationPrompt: includes group label in output", () => {
  const pkg = makePackage();
  const prompt = buildContinuationPrompt(pkg, "do something");
  assert.ok(prompt.includes("passport"), "Group label should appear in prompt");
});

test("buildContinuationPrompt: includes extracted field name and value", () => {
  const pkg = makePackage();
  const prompt = buildContinuationPrompt(pkg, "do something");
  assert.ok(prompt.includes("name"), "Field name should appear in prompt");
  assert.ok(prompt.includes("John Doe"), "Field value should appear in prompt");
});

test("buildContinuationPrompt: includes appContext keys when provided", () => {
  const pkg = makePackage();
  const appContext = { country: "DE", workflow: "onboarding" };
  const prompt = buildContinuationPrompt(pkg, "intent", appContext);
  assert.ok(prompt.includes("country"), "appContext key should appear in prompt");
  assert.ok(prompt.includes("DE"), "appContext value should appear in prompt");
});

test("buildContinuationPrompt: includes policyRef when present in package", () => {
  const pkg = makePackage({
    policyRef: { name: "identity-documents", version: "2.1.0", contentHash: "deadbeef" },
  });
  const prompt = buildContinuationPrompt(pkg, "verify identity");
  assert.ok(prompt.includes("identity-documents"), "Policy name should appear in prompt");
});

test("buildContinuationPrompt: omits policyRef block when null", () => {
  const pkg = makePackage({ policyRef: null });
  const prompt = buildContinuationPrompt(pkg, "intent");
  assert.ok(!prompt.includes("Policy:"), "Should not include policy block when null");
});

// ---------------------------------------------------------------------------
// createPassthroughContinuationHandler
// ---------------------------------------------------------------------------

test("passthrough handler: returns all fields as results", async () => {
  const handler = createPassthroughContinuationHandler();
  const pkg = makePackage();
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });

  assert.ok(typeof result.results === "object" && result.results !== null);
  assert.equal((result.results as Record<string, unknown>)["name"], "John Doe");
});

test("passthrough handler: evidence is populated with all fields", async () => {
  const handler = createPassthroughContinuationHandler();
  const pkg = makePackage();
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });

  assert.ok(Array.isArray(result.evidence));
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]!.fieldName, "name");
  assert.equal(result.evidence[0]!.groupId, "group-1");
  assert.equal(result.evidence[0]!.confidence, 0.95);
});

test("passthrough handler: multi-group package → keys prefixed with groupId", async () => {
  const handler = createPassthroughContinuationHandler();
  const pkg = makePackage({
    classifiedGroups: [
      makeGroup("group-1", { fields: [{ name: "name", value: "Alice", confidence: 0.9, sourceUnitIndex: 1, method: "llm-text" }] }),
      makeGroup("group-2", { fields: [{ name: "name", value: "Bob", confidence: 0.88, sourceUnitIndex: 2, method: "llm-text" }] }),
    ],
  });

  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });
  const keys = Object.keys(result.results as Record<string, unknown>);

  assert.ok(keys.includes("group-1.name"), "Should prefix single-group key with groupId");
  assert.ok(keys.includes("group-2.name"));
});

test("passthrough handler: unsupported group → unresolvedItems entry", async () => {
  const handler = createPassthroughContinuationHandler();
  const pkg = makePackage({
    classifiedGroups: [
      makeGroup("group-1", { unsupported: true, fields: [] }),
    ],
  });

  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });

  assert.ok(result.unresolvedItems.length > 0);
  assert.ok(result.unresolvedItems.some((i) => i.description.includes("group-1")));
});

test("passthrough handler: empty fields → unresolvedItems and manual-review suggestion", async () => {
  const handler = createPassthroughContinuationHandler();
  const pkg = makePackage({
    classifiedGroups: [makeGroup("group-1", { fields: [] })],
  });

  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });

  assert.ok(result.unresolvedItems.length > 0);
  assert.ok(
    result.suggestedNextSteps.some((s) => s.toLowerCase().includes("manual")),
    "Should suggest manual review when no fields resolved",
  );
});

// ---------------------------------------------------------------------------
// createLlmContinuationHandler — disabled LLM
// ---------------------------------------------------------------------------

test("LLM handler: disabled LLM → falls back to passthrough result", async () => {
  const disabledLlm: PipelineLlmAdapter = {
    enabled: false,
    generate: async () => { throw new Error("Should not be called"); },
  };

  const handler = createLlmContinuationHandler(disabledLlm);
  const pkg = makePackage();
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });

  // Should get a valid result without throwing
  assert.ok(typeof result.results === "object" && result.results !== null);
  // unresolvedItems should mention the disable reason
  assert.ok(result.unresolvedItems.some((i) => i.reason.includes("disabled")));
});

// ---------------------------------------------------------------------------
// createLlmContinuationHandler — LLM returning valid JSON
// ---------------------------------------------------------------------------

test("LLM handler: valid JSON response → parsed result returned", async () => {
  const llmResponse = {
    results: { identity_verified: "true" },
    evidence: [{ groupId: "group-1", fieldName: "name", confidence: 0.9 }],
    unresolvedItems: [],
    suggestedNextSteps: [],
  };

  const successLlm: PipelineLlmAdapter = {
    enabled: true,
    generate: async () => ({ text: JSON.stringify(llmResponse) }),
  };

  const handler = createLlmContinuationHandler(successLlm);
  const pkg = makePackage();
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify identity" });

  assert.deepEqual(result.results, llmResponse.results);
  assert.deepEqual(result.evidence, llmResponse.evidence);
});

// ---------------------------------------------------------------------------
// createLlmContinuationHandler — error cases
// ---------------------------------------------------------------------------

test("LLM handler: malformed JSON → falls back to passthrough result", async () => {
  const badLlm: PipelineLlmAdapter = {
    enabled: true,
    generate: async () => ({ text: "this is not json {{{" }),
  };

  const handler = createLlmContinuationHandler(badLlm);
  const pkg = makePackage();
  // Should not throw
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });
  assert.ok(typeof result.results === "object" && result.results !== null);
});

test("LLM handler: empty string response → falls back to passthrough result", async () => {
  const emptyLlm: PipelineLlmAdapter = {
    enabled: true,
    generate: async () => ({ text: "" }),
  };

  const handler = createLlmContinuationHandler(emptyLlm);
  const pkg = makePackage();
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });
  assert.ok(typeof result.results === "object");
});

test("LLM handler: LLM throws → falls back to passthrough result (no re-throw)", async () => {
  const throwingLlm: PipelineLlmAdapter = {
    enabled: true,
    generate: async () => { throw new Error("Network error"); },
  };

  const handler = createLlmContinuationHandler(throwingLlm);
  const pkg = makePackage();
  // Must NOT re-throw
  const result = await handler({ analysisPackage: pkg, taskIntent: "verify" });
  assert.ok(typeof result.results === "object");
  assert.ok(result.unresolvedItems.some((i) => i.reason.includes("error")));
});

test("buildContinuationPrompt: cites the policy as name@version#hash", () => {
  const pkg = makePackage({ policyRef: { name: "kyc", version: "2.1.0", contentHash: "abc123" } });
  const prompt = buildContinuationPrompt(pkg, "check");
  assert.ok(prompt.includes("Policy: kyc@2.1.0#abc123"), prompt);
});
