// ---------------------------------------------------------------------------
// Tests: policy front-matter, rule anchors and verdicts.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  buildRuleCitationInstructions,
  checkPolicyVerdicts,
  DocumentPoliciesConfigError,
  extractPolicyRules,
  loadPolicies,
  parsePolicyFile,
  PolicyFrontMatterError,
  PolicyRuleError,
  type DocumentPoliciesManifest,
} from "../src/index.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function manifest(overrides: Partial<DocumentPoliciesManifest> = {}): DocumentPoliciesManifest {
  return {
    policiesDir: "policies",
    policies: [{ name: "identity", file: "identity/policy.md" }],
    failOnMissingFile: true,
    failOnEmptyPolicy: true,
    ...overrides,
  };
}
const reader = (files: Record<string, string>) => (path: string) => {
  for (const [key, value] of Object.entries(files)) if (resolve(key) === path) return value;
  return undefined;
};

const POLICY = [
  "---",
  "# identity checks",
  "appliesTo: [passport, \"id-card\"]",
  "severity: error",
  "component: document-pipeline",
  "outputSchema: identity.schema.json",
  "examples:",
  "  - examples/ok.md",
  "  - 'examples/expired.md'",
  "owner: kyc-team",
  "---",
  "# Identity policy",
  "",
  "## Passport must be valid {#passport-valid}",
  "The passport is the primary identity document.",
  "",
  "- Expiry date is after the submission date {#passport-expiry}",
  "  (use the MRZ when the visual zone is unreadable)",
  "- Name matches the application {#name-match}",
  "",
  "## Notes",
  "Not a rule: {#ignored} because this is plain text.",
  "```",
  "- Example rule in a code block {#example-only}",
  "```",
].join("\n");

const FILES = {
  "policies/identity/policy.md": POLICY,
  "policies/identity/identity.schema.json": '{"type":"object","required":["verdicts"]}',
  "policies/identity/examples/ok.md": "ok example",
  "policies/identity/examples/expired.md": "expired example",
};

// ---------------------------------------------------------------------------
// Front-matter
// ---------------------------------------------------------------------------

test("front-matter: typed fields, referenced files, unknown keys, body without the block", () => {
  const [policy] = loadPolicies(manifest(), { readFile: reader(FILES) });
  assert.ok(policy);
  assert.deepEqual(policy.appliesTo, ["passport", "id-card"]);
  assert.equal(policy.severity, "error");
  assert.equal(policy.component, "document-pipeline");
  assert.deepEqual(policy.meta, { owner: "kyc-team" });
  assert.ok(policy.text.startsWith("# Identity policy"), "body excludes the front-matter block");
  assert.equal(policy.contentHash, sha(POLICY), "hash covers the whole file, front-matter included");

  assert.deepEqual(policy.outputSchema?.schema, { type: "object", required: ["verdicts"] });
  assert.equal(policy.outputSchema?.path, resolve("policies/identity/identity.schema.json"));
  assert.equal(policy.outputSchema?.contentHash, sha('{"type":"object","required":["verdicts"]}'));
  assert.deepEqual(
    policy.examples?.map((e) => [e.path, e.text]),
    [
      [resolve("policies/identity/examples/ok.md"), "ok example"],
      [resolve("policies/identity/examples/expired.md"), "expired example"],
    ],
  );
});

test("front-matter: files without it load exactly as before", () => {
  const plain = "---\nThis horizontal rule starts the body.\n---\nMore text.";
  const files = { "policies/identity/policy.md": plain };
  const [policy] = loadPolicies(manifest(), { readFile: reader(files) });
  assert.equal(policy!.text, plain, "a --- block that is not key: value lines is body text");
  assert.equal(policy!.contentHash, sha(plain));
  assert.equal(policy!.appliesTo, undefined);
  assert.equal(policy!.severity, undefined);
  assert.deepEqual(policy!.rules, []);
  assert.equal(parsePolicyFile("---\nno closing line").frontMatter, undefined);
  assert.equal(parsePolicyFile("Body only").body, "Body only");
});

test("front-matter: scalar appliesTo, flow lists, CRLF and BOM", () => {
  const parsed = parsePolicyFile("﻿---\r\nappliesTo: invoice\r\nexamples: [a.md, b.md]\r\n---\r\nBody\r\nline 2");
  assert.deepEqual(parsed.frontMatter?.appliesTo, ["invoice"]);
  assert.deepEqual(parsed.frontMatter?.examples, ["a.md", "b.md"]);
  assert.equal(parsed.body, "Body\r\nline 2");
});

test("front-matter: broken blocks are config errors", () => {
  const bad = (block: string) => () => parsePolicyFile(`---\n${block}\n---\nBody`);
  assert.throws(bad("severity: fatal"), PolicyFrontMatterError);
  assert.throws(bad("severity: [error, info]"), /single non-empty value/);
  assert.throws(bad("appliesTo: a\nappliesTo: b"), /duplicate key/);
  assert.throws(bad("appliesTo: [a, b"), /unclosed list/);
  assert.throws(bad("meta: {a: 1}"), /nested maps/);
  assert.throws(bad("appliesTo: a\nthis is not a key line"), /expected "key: value"/);
  assert.throws(bad("severity: error\n  - stray"), /list item without/);

  const files = { "policies/identity/policy.md": "---\nseverity: loud\n---\nBody" };
  assert.throws(() => loadPolicies(manifest(), { readFile: reader(files) }), DocumentPoliciesConfigError);
});

test("front-matter: missing or invalid referenced files follow the manifest flags", () => {
  const missingSchema = { ...FILES, "policies/identity/identity.schema.json": undefined } as unknown as Record<string, string>;
  delete (missingSchema as Record<string, unknown>)["policies/identity/identity.schema.json"];
  assert.throws(() => loadPolicies(manifest(), { readFile: reader(missingSchema) }), /outputSchema not found/);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(loadPolicies(manifest({ failOnMissingFile: false }), { readFile: reader(missingSchema) }), []);
  } finally {
    console.warn = warn;
  }

  const notJson = { ...FILES, "policies/identity/identity.schema.json": "{ nope" };
  assert.throws(() => loadPolicies(manifest(), { readFile: reader(notJson) }), /not valid JSON/);
  const notObject = { ...FILES, "policies/identity/identity.schema.json": "[1]" };
  assert.throws(() => loadPolicies(manifest(), { readFile: reader(notObject) }), /must be a JSON object/);

  const emptyBody = { "policies/identity/policy.md": "---\nseverity: info\n---\n   \n" };
  assert.throws(() => loadPolicies(manifest(), { readFile: reader(emptyBody) }), /is empty/);
});

// ---------------------------------------------------------------------------
// Rule anchors and verdicts
// ---------------------------------------------------------------------------

test("rules: headings and list items with {#id}; code blocks and plain text ignored", () => {
  const [policy] = loadPolicies(manifest(), { readFile: reader(FILES) });
  assert.deepEqual(
    policy!.rules!.map((r) => r.id),
    ["passport-valid", "passport-expiry", "name-match"],
  );
  const [valid, expiry, name] = policy!.rules!;
  assert.match(valid!.text, /^Passport must be valid\nThe passport is the primary identity document\./);
  assert.match(valid!.text, /Name matches the application/, "a heading rule covers its section");
  assert.doesNotMatch(valid!.text, /Notes/, "…up to the next heading of the same level");
  assert.equal(expiry!.text, "Expiry date is after the submission date\n(use the MRZ when the visual zone is unreadable)");
  assert.equal(name!.text, "Name matches the application");
  assert.equal(expiry!.severity, "error", "rules inherit the policy severity");
  assert.equal(expiry!.line, 6);
  assert.match(policy!.text, /\{#passport-expiry\}/, "anchors stay in the text so the model can cite them");
});

test("rules: duplicate ids are errors", () => {
  assert.throws(() => extractPolicyRules("- a {#x}\n- b {#x}"), PolicyRuleError);
  assert.throws(
    () => loadPolicies(manifest(), { readFile: reader({ "policies/identity/policy.md": "- a {#x}\n- b {#x}" }) }),
    /duplicate rule id "x" on lines 1 and 2/,
  );
});

test("verdicts: valid entries kept, unknown/duplicate/malformed dropped with reasons", () => {
  const rules = extractPolicyRules("- a {#expiry}\n- b {#name}\n- c {#address}", "warning");
  const output = JSON.stringify({
    verdicts: [
      { ruleId: "expiry", outcome: "fail", evidence: [{ quote: "EXP 2020-01-01", groupId: "g1", sourceUnitIndex: 1 }], note: "expired" },
      { ruleId: "expiry", outcome: "pass", evidence: ["dup"] },
      { ruleId: "invented", outcome: "pass", evidence: ["x"] },
      { ruleId: "name", outcome: "pass" },
      { ruleId: "address", outcome: "maybe", evidence: ["x"] },
      "junk",
    ],
  });
  const check = checkPolicyVerdicts("```json\n" + output + "\n```", rules);
  assert.deepEqual(check.verdicts, [
    {
      ruleId: "expiry",
      outcome: "fail",
      evidence: [{ quote: "EXP 2020-01-01", groupId: "g1", sourceUnitIndex: 1 }],
      note: "expired",
      severity: "warning",
    },
  ]);
  assert.deepEqual(check.missingRuleIds, ["name", "address"]);
  assert.equal(check.problems.length, 5);
  assert.match(check.problems.join("\n"), /second verdict for "expiry"/);
  assert.match(check.problems.join("\n"), /unknown ruleId "invented"/);
  assert.match(check.problems.join("\n"), /"pass" without evidence/);
  assert.match(check.problems.join("\n"), /outcome must be one of/);
});

test("verdicts: arrays, string evidence, uncertain without evidence, custom evidence rule, bad JSON", () => {
  const rules = extractPolicyRules("- a {#r1}\n- b {#r2}");
  const check = checkPolicyVerdicts(
    [
      { ruleId: "r1", outcome: "uncertain" },
      { ruleId: "r2", outcome: "pass", evidence: "Name: JANE DOE" },
    ],
    rules,
  );
  assert.deepEqual(check.verdicts.map((v) => [v.ruleId, v.evidence]), [
    ["r1", []],
    ["r2", [{ quote: "Name: JANE DOE" }]],
  ]);
  assert.deepEqual(check.missingRuleIds, []);

  const strict = checkPolicyVerdicts([{ ruleId: "r1", outcome: "uncertain" }], rules, {
    requireEvidenceFor: ["pass", "fail", "uncertain"],
  });
  assert.equal(strict.verdicts.length, 0);

  assert.deepEqual(checkPolicyVerdicts("not json", rules).problems, ["output is not valid JSON."]);
  assert.match(checkPolicyVerdicts({ nope: 1 }, rules).problems[0]!, /must be an array/);
});

test("citation instructions list every rule id; empty without rules", () => {
  const rules = extractPolicyRules("## A {#a}\ntext\n- b {#b}");
  const text = buildRuleCitationInstructions(rules);
  assert.match(text, /^- a$/m);
  assert.match(text, /^- b$/m);
  assert.match(text, /"verdicts"/);
  assert.equal(buildRuleCitationInstructions([]), "");
});
