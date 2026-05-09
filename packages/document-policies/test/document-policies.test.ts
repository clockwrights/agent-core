// ---------------------------------------------------------------------------
// Tests: document-policies/ — manifest loader + policy file loader.
//
// The reusable module emits `LoadedPolicy[]` from a manifest. App glue (in
// `server/src/index.ts`) is what hands these to `DocumentPolicyRegistry` —
// we cover that integration with a small additional test below.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  DocumentPoliciesConfigError,
  loadConfiguredPolicies,
  loadPolicies,
  loadPoliciesManifest,
} from "../src/index.js";
import { DocumentPolicyRegistry } from "@maya-ai/document-pipeline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FsStub = (path: string) => string | undefined;

function fs(map: Record<string, string>): FsStub {
  return (path) => {
    // Match either the raw key or its resolved form, so callers can pass
    // relative or absolute paths in their fixtures.
    if (Object.prototype.hasOwnProperty.call(map, path)) return map[path];
    for (const [key, value] of Object.entries(map)) {
      if (resolve(key) === path) return value;
    }
    return undefined;
  };
}

const SIMPLE_MANIFEST = JSON.stringify({
  policiesDir: "policies",
  policies: [
    { name: "identity", file: "identity.md" },
    { name: "contract", file: "contract.md", version: "2.0.0" },
  ],
});

// ---------------------------------------------------------------------------
// loadPoliciesManifest
// ---------------------------------------------------------------------------

test("loadPoliciesManifest: returns null when manifest is absent and no env override", () => {
  const result = loadPoliciesManifest({
    env: {},
    readFile: () => undefined,
  });
  assert.equal(result, null);
});

test("loadPoliciesManifest: parses a valid manifest and applies defaults", () => {
  const manifest = loadPoliciesManifest({
    filePath: "/fake/manifest.json",
    env: {},
    readFile: fs({ "/fake/manifest.json": SIMPLE_MANIFEST }),
  });
  assert.ok(manifest);
  assert.equal(manifest.policiesDir, "policies");
  assert.equal(manifest.failOnMissingFile, true);
  assert.equal(manifest.failOnEmptyPolicy, true);
  assert.deepEqual(manifest.policies, [
    { name: "identity", file: "identity.md" },
    { name: "contract", file: "contract.md", version: "2.0.0" },
  ]);
});

test("loadPoliciesManifest: malformed JSON throws DocumentPoliciesConfigError", () => {
  assert.throws(
    () =>
      loadPoliciesManifest({
        filePath: "/fake/m.json",
        env: {},
        readFile: fs({ "/fake/m.json": "{ not: valid json" }),
      }),
    DocumentPoliciesConfigError,
  );
});

test("loadPoliciesManifest: missing policies array throws", () => {
  assert.throws(
    () =>
      loadPoliciesManifest({
        filePath: "/fake/m.json",
        env: {},
        readFile: fs({ "/fake/m.json": JSON.stringify({ policiesDir: "x" }) }),
      }),
    /must contain a "policies" array/,
  );
});

test("loadPoliciesManifest: duplicate policy name throws", () => {
  const dup = JSON.stringify({
    policiesDir: "p",
    policies: [
      { name: "x", file: "a.md" },
      { name: "x", file: "b.md" },
    ],
  });
  assert.throws(
    () =>
      loadPoliciesManifest({
        filePath: "/fake/m.json",
        env: {},
        readFile: fs({ "/fake/m.json": dup }),
      }),
    /duplicate policy name "x"/,
  );
});

test("loadPoliciesManifest: entry missing name or file throws", () => {
  for (const broken of [
    JSON.stringify({ policies: [{ file: "x.md" }] }),
    JSON.stringify({ policies: [{ name: "x" }] }),
    JSON.stringify({ policies: [{ name: "", file: "x.md" }] }),
    JSON.stringify({ policies: [{ name: "x", file: "" }] }),
  ]) {
    assert.throws(
      () =>
        loadPoliciesManifest({
          filePath: "/fake/m.json",
          env: {},
          readFile: fs({ "/fake/m.json": broken }),
        }),
      DocumentPoliciesConfigError,
    );
  }
});

test("loadPoliciesManifest: env override path missing → throws (operator error)", () => {
  assert.throws(
    () =>
      loadPoliciesManifest({
        env: { DOCUMENT_POLICIES_MANIFEST: "/does/not/exist.json" },
        readFile: () => undefined,
      }),
    /manifest file not found/,
  );
});

test("loadPoliciesManifest: ${ENV_VAR} interpolation in policiesDir", () => {
  const manifest = loadPoliciesManifest({
    filePath: "/fake/m.json",
    env: { POLICIES_HOME: "/var/policies" },
    readFile: fs({
      "/fake/m.json": JSON.stringify({
        policiesDir: "${POLICIES_HOME}",
        policies: [{ name: "a", file: "a.md" }],
      }),
    }),
  });
  assert.ok(manifest);
  assert.equal(manifest.policiesDir, "/var/policies");
});

test("loadPoliciesManifest: failOnMissingFile and failOnEmptyPolicy honour explicit false", () => {
  const manifest = loadPoliciesManifest({
    filePath: "/fake/m.json",
    env: {},
    readFile: fs({
      "/fake/m.json": JSON.stringify({
        policiesDir: "p",
        policies: [{ name: "a", file: "a.md" }],
        failOnMissingFile: false,
        failOnEmptyPolicy: false,
      }),
    }),
  });
  assert.ok(manifest);
  assert.equal(manifest.failOnMissingFile, false);
  assert.equal(manifest.failOnEmptyPolicy, false);
});

// ---------------------------------------------------------------------------
// loadPolicies
// ---------------------------------------------------------------------------

test("loadPolicies: reads bodies, defaults version, computes content hash", () => {
  const dir = resolve("policies");
  const idPath = resolve(dir, "identity.md");
  const ctPath = resolve(dir, "contract.md");

  const policies = loadPolicies(
    {
      policiesDir: "policies",
      policies: [
        { name: "identity", file: "identity.md" },
        { name: "contract", file: "contract.md", version: "2.0.0" },
      ],
      failOnMissingFile: true,
      failOnEmptyPolicy: true,
    },
    {
      readFile: (p) => {
        if (p === idPath) return "identity body";
        if (p === ctPath) return "contract body";
        return undefined;
      },
    },
  );

  assert.equal(policies.length, 2);
  assert.equal(policies[0]!.name, "identity");
  assert.equal(policies[0]!.version, "1.0.0");
  assert.equal(policies[0]!.text, "identity body");
  assert.match(policies[0]!.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(policies[1]!.version, "2.0.0");
  assert.notEqual(policies[0]!.contentHash, policies[1]!.contentHash);
});

test("loadPolicies: missing file with failOnMissingFile=true throws", () => {
  assert.throws(
    () =>
      loadPolicies(
        {
          policiesDir: "p",
          policies: [{ name: "x", file: "missing.md" }],
          failOnMissingFile: true,
          failOnEmptyPolicy: true,
        },
        { readFile: () => undefined },
      ),
    /file not found/,
  );
});

test("loadPolicies: missing file with failOnMissingFile=false → warn and skip", () => {
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned++;
  };
  try {
    const policies = loadPolicies(
      {
        policiesDir: "p",
        policies: [
          { name: "x", file: "missing.md" },
          { name: "y", file: "present.md" },
        ],
        failOnMissingFile: false,
        failOnEmptyPolicy: true,
      },
      {
        readFile: (path) => (path.endsWith("present.md") ? "yes" : undefined),
      },
    );
    assert.equal(policies.length, 1);
    assert.equal(policies[0]!.name, "y");
    assert.ok(warned >= 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("loadPolicies: empty body with failOnEmptyPolicy=true throws", () => {
  assert.throws(
    () =>
      loadPolicies(
        {
          policiesDir: "p",
          policies: [{ name: "x", file: "x.md" }],
          failOnMissingFile: true,
          failOnEmptyPolicy: true,
        },
        { readFile: () => "   \n  " },
      ),
    /is empty/,
  );
});

test("loadPolicies: empty body with failOnEmptyPolicy=false → warn and skip", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const policies = loadPolicies(
      {
        policiesDir: "p",
        policies: [{ name: "x", file: "x.md" }],
        failOnMissingFile: true,
        failOnEmptyPolicy: false,
      },
      { readFile: () => "" },
    );
    assert.equal(policies.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// loadConfiguredPolicies
// ---------------------------------------------------------------------------

test("loadConfiguredPolicies: returns empty when manifest is absent", () => {
  const result = loadConfiguredPolicies({
    env: {},
    readFile: () => undefined,
  });
  assert.deepEqual(result, []);
});

test("loadConfiguredPolicies: full manifest+body load round-trip", () => {
  const manifestPath = "/fake/manifest.json";
  const policiesDir = resolve("policies");

  const result = loadConfiguredPolicies({
    filePath: manifestPath,
    env: {},
    readFile: (p) => {
      if (p === manifestPath) {
        return JSON.stringify({
          policiesDir: "policies",
          policies: [{ name: "identity", file: "id.md" }],
        });
      }
      if (p === resolve(policiesDir, "id.md")) return "Identity policy body";
      return undefined;
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "identity");
  assert.equal(result[0]!.text, "Identity policy body");
});

// ---------------------------------------------------------------------------
// Integration with DocumentPolicyRegistry
// ---------------------------------------------------------------------------

test("integration: loaded policies register cleanly into DocumentPolicyRegistry", () => {
  const policiesDir = resolve("p");
  const loaded = loadConfiguredPolicies({
    filePath: "/m.json",
    env: {},
    readFile: (path) => {
      if (path === "/m.json") {
        return JSON.stringify({
          policiesDir: "p",
          policies: [
            { name: "a", file: "a.md", version: "1.2.3" },
            { name: "b", file: "b.md" },
          ],
        });
      }
      if (path === resolve(policiesDir, "a.md")) return "policy a";
      if (path === resolve(policiesDir, "b.md")) return "policy b";
      return undefined;
    },
  });

  const registry = new DocumentPolicyRegistry();
  for (const p of loaded) registry.register(p.name, p.text, p.version);

  assert.equal(registry.size, 2);
  const a = registry.get("a")!;
  assert.equal(a.version, "1.2.3");
  assert.equal(a.policyText, "policy a");
  const b = registry.get("b")!;
  assert.equal(b.version, "1.0.0");
});
