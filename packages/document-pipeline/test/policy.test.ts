// ---------------------------------------------------------------------------
// Tests: Document Policy Registry and Prompt Builders
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DocumentPolicyRegistry,
  defaultPolicyRegistry,
  buildClassificationPrompt,
  buildFieldExtractionPrompt,
} from "../src/policy.js";
import type {
  DocumentGroup,
  DocumentUnit,
  UnitExtractionResult,
} from "../src/types.js";

const SAMPLE_POLICY_TEXT = `Recognised types: national-id, passport.
For national-id: extract full name, ID number, date of birth.
For passport: extract full name, passport number, expiry date.
Unknown documents: mark as unsupported.`;

function makeGroup(id: string, unitIndices = [1]): DocumentGroup {
  return { id, unitIndices, confidence: 0.9, segmentationMethod: "single-group" };
}

function makeUnit(index: number): DocumentUnit {
  return { index, kind: "page", sourceFileIndex: 0 };
}

function makeExtraction(unitIndex: number, text: string): UnitExtractionResult {
  return { unitIndex, text, blocks: [], images: [], extractorId: "test", ocrUsed: false };
}

// ---------------------------------------------------------------------------
// DocumentPolicyRegistry
// ---------------------------------------------------------------------------

test("policy registry: register stores and returns the policy", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("my-policy", SAMPLE_POLICY_TEXT, "1.0.0");

  assert.equal(policy.name, "my-policy");
  assert.equal(policy.version, "1.0.0");
  assert.equal(policy.policyText, SAMPLE_POLICY_TEXT);
  assert.match(policy.contentHash, /^[0-9a-f]{64}$/);
});

test("policy registry: get returns the stored policy", () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("my-policy", SAMPLE_POLICY_TEXT);
  const retrieved = registry.get("my-policy");

  assert.ok(retrieved !== undefined);
  assert.equal(retrieved.name, "my-policy");
});

test("policy registry: get returns undefined for unknown name", () => {
  const registry = new DocumentPolicyRegistry();
  assert.equal(registry.get("does-not-exist"), undefined);
});

test("policy registry: list returns all registered policies", () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("alpha", "Policy alpha text");
  registry.register("beta", "Policy beta text");

  const listed = registry.list();
  const names = listed.map((p) => p.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("beta"));
  assert.equal(listed.length, 2);
});

test("policy registry: re-registering same name replaces the policy", () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("p", "old text");
  registry.register("p", "new text");

  assert.equal(registry.get("p")?.policyText, "new text");
  assert.equal(registry.size, 1);
});

test("policy registry: remove deletes the policy", () => {
  const registry = new DocumentPolicyRegistry();
  registry.register("p", "some text");
  registry.remove("p");

  assert.equal(registry.get("p"), undefined);
  assert.equal(registry.size, 0);
});

test("policy registry: remove is a no-op for unknown name", () => {
  const registry = new DocumentPolicyRegistry();
  assert.doesNotThrow(() => registry.remove("nonexistent"));
});

test("policy registry: version defaults to '1.0.0'", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("p", "text");
  assert.equal(policy.version, "1.0.0");
});

test("policy registry: throws when name is empty", () => {
  const registry = new DocumentPolicyRegistry();
  assert.throws(() => registry.register("", "some text"), /Policy name must not be empty/);
});

test("policy registry: throws when text is empty", () => {
  const registry = new DocumentPolicyRegistry();
  assert.throws(() => registry.register("my-policy", "   "), /Policy text must not be empty/);
});

test("policy registry: contentHash is deterministic for same text", () => {
  const r1 = new DocumentPolicyRegistry();
  const r2 = new DocumentPolicyRegistry();
  assert.equal(
    r1.register("p", SAMPLE_POLICY_TEXT).contentHash,
    r2.register("p", SAMPLE_POLICY_TEXT).contentHash,
  );
});

test("policy registry: contentHash differs for different text", () => {
  const registry = new DocumentPolicyRegistry();
  const p1 = registry.register("p1", "text one");
  const p2 = registry.register("p2", "text two");
  assert.notEqual(p1.contentHash, p2.contentHash);
});

test("defaultPolicyRegistry: is a DocumentPolicyRegistry instance", () => {
  assert.ok(defaultPolicyRegistry instanceof DocumentPolicyRegistry);
});

// ---------------------------------------------------------------------------
// buildClassificationPrompt
// ---------------------------------------------------------------------------

test("buildClassificationPrompt: returns systemPrompt and userPrompt strings", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("test-policy", SAMPLE_POLICY_TEXT);
  const group = makeGroup("group-1", [1, 2]);
  const units = [makeUnit(1), makeUnit(2)];
  const extractions = [
    makeExtraction(1, "MUSTERMANN HANS <<<<<<<<<<<<<<<<<"),
    makeExtraction(2, "Second page text"),
  ];

  const prompt = buildClassificationPrompt(policy, group, units, extractions);

  assert.equal(typeof prompt.systemPrompt, "string");
  assert.equal(typeof prompt.userPrompt, "string");
  assert.ok(prompt.systemPrompt.length > 0);
  assert.ok(prompt.userPrompt.length > 0);
});

test("buildClassificationPrompt: embeds policy text in the prompt", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("test-policy", SAMPLE_POLICY_TEXT);
  const prompt = buildClassificationPrompt(
    policy,
    makeGroup("g"),
    [makeUnit(1)],
    [makeExtraction(1, "Sample text")],
  );
  const combined = prompt.systemPrompt + prompt.userPrompt;
  assert.ok(
    combined.includes("national-id") || combined.includes("Recognised types"),
    "Policy content should be present in the prompt",
  );
});

test("buildClassificationPrompt: works without a policy (open-vocabulary mode)", () => {
  const prompt = buildClassificationPrompt(
    undefined,
    makeGroup("g"),
    [makeUnit(1)],
    [makeExtraction(1, "some text")],
  );
  assert.equal(typeof prompt.systemPrompt, "string");
  assert.equal(typeof prompt.userPrompt, "string");
  assert.ok(prompt.systemPrompt.length > 0);
});

test("buildClassificationPrompt: includes extracted text in userPrompt", () => {
  const UNIQUE_TEXT = "UNIQUE_MARKER_X7Q2Z9";
  const prompt = buildClassificationPrompt(
    undefined,
    makeGroup("g"),
    [makeUnit(1)],
    [makeExtraction(1, UNIQUE_TEXT)],
  );
  assert.ok(prompt.userPrompt.includes(UNIQUE_TEXT), "Extracted text should appear in userPrompt");
});

// ---------------------------------------------------------------------------
// buildFieldExtractionPrompt
// ---------------------------------------------------------------------------

test("buildFieldExtractionPrompt: returns a string", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("test-policy", SAMPLE_POLICY_TEXT);
  const prompt = buildFieldExtractionPrompt("full name", "national-id", policy);

  assert.equal(typeof prompt, "string");
  assert.ok(prompt.length > 0);
});

test("buildFieldExtractionPrompt: embeds the fieldName in the prompt", () => {
  const registry = new DocumentPolicyRegistry();
  const policy = registry.register("test-policy", SAMPLE_POLICY_TEXT);
  const FIELD = "date_of_birth_UNIQUE";

  const prompt = buildFieldExtractionPrompt(FIELD, "national-id", policy);

  assert.ok(prompt.includes(FIELD), "Field name should appear in the prompt");
});

test("buildFieldExtractionPrompt: works without a policy", () => {
  const prompt = buildFieldExtractionPrompt("invoice_number", "invoice", undefined);
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.length > 0);
});
