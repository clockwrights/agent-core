# Document Policies

> **Reusable component.** Lives at `server/src/document-policies/`. Self-contained — zero imports from outside the directory except external npm deps and node built-ins. This document travels with the component.

Related repository: [`maya-intelligence/agent-core`](https://github.com/maya-intelligence/agent-core)

Loads named natural-language policies from a manifest plus separate body files. Emits a plain `LoadedPolicy[]`. The component is **registry-agnostic**: it has no opinion about what the caller does with the result. Apps glue the loaded policies into whatever registry their pipeline uses (in this app, the `DocumentPolicyRegistry` from [`document-pipeline`](./document-pipeline.md)).

---

## Why this component exists

The naïve approach is to declare policies inline in code (`registry.register("identity-documents", "...long natural-language text...")`). That puts product copy in a TypeScript wiring file and turns "update the rule" into "merge a code change". This component moves bodies to standalone Markdown files and the mapping into a small JSON manifest, so policies become a config-only operation — and the loader pieces are reusable across apps.

What's reusable lives here. What's app-specific (which registry to call, how to enforce policies at runtime) lives in the consumer app.

---

## Public API

```ts
import {
  loadConfiguredPolicies,
  loadPoliciesManifest,
  loadPolicies,
  DocumentPoliciesConfigError,
  type DocumentPoliciesManifest,
  type LoadedPolicy,
} from "./document-policies";
```

### Types

```ts
type PolicyManifestEntry = {
  name: string;            // referenced via your app's policy lookup
  file: string;            // body path, relative to policiesDir
  version?: string;        // defaults to "1.0.0"
};

type DocumentPoliciesManifest = {
  policiesDir: string;             // default "server/policies"
  policies: PolicyManifestEntry[];
  failOnMissingFile: boolean;      // default true
  failOnEmptyPolicy: boolean;      // default true
};

type LoadedPolicy = {
  name: string;
  text: string;
  version: string;
  sourcePath: string;       // absolute path the body was read from
  contentHash: string;      // SHA-256, useful for boot-time audit logs
};
```

### Functions

```ts
function loadPoliciesManifest(opts?: {
  filePath?: string;                                // default "server/config/document-policies.json"
  env?: NodeJS.ProcessEnv;                          // default process.env
  readFile?: (path: string) => string | undefined;  // overridable for tests
}): DocumentPoliciesManifest | null;

function loadPolicies(
  manifest: DocumentPoliciesManifest,
  opts?: { readFile?: (path: string) => string | undefined },
): LoadedPolicy[];

// Convenience: loadPoliciesManifest then loadPolicies; empty array when manifest absent
function loadConfiguredPolicies(opts?): LoadedPolicy[];
```

### Errors

`DocumentPoliciesConfigError` is thrown for fatal configuration problems. It carries a `source` field (the manifest or body path) so audit logs can pinpoint which file is at fault.

---

## Configuration sources

| Source | Precedence | When to use |
|---|---|---|
| `server/config/document-policies.json` | 1 (default) | Standard placement for repo-tracked manifests. |
| `DOCUMENT_POLICIES_MANIFEST` env var (path) | Override | Containerised deployments that mount the manifest at a different path. |
| _(neither)_ | — | Loader returns `null`. Consumer typically warns and runs in open-vocabulary mode. |

The manifest only contains paths/names. **Policy bodies are never inlined in env vars** — they live in their own files (typically Markdown) so they can be reviewed and diffed in PRs.

`${ENV_VAR}` interpolation is supported for `policiesDir` so deployments can relocate the policy folder via env without a config change.

---

## Manifest example

`server/config/document-policies.json`:

```json
{
  "policiesDir": "server/policies",
  "policies": [
    { "name": "identity-documents", "file": "identity-documents.md" },
    { "name": "contract-review",    "file": "contract-review.md", "version": "1.2.0" }
  ],
  "failOnMissingFile": true,
  "failOnEmptyPolicy": true
}
```

`server/policies/identity-documents.md` and `server/policies/contract-review.md` contain the natural-language policy bodies. Markdown is conventional but not required — any text format works.

---

## Failure modes

| Situation | Behaviour |
|---|---|
| Manifest absent, no env override | Loader returns `null`. Consumer typically logs a warning and runs without policies. |
| `DOCUMENT_POLICIES_MANIFEST` set but file missing | **Throws** — operator clearly intended to point at a manifest. |
| Manifest present but malformed JSON | **Throws**. |
| Manifest references a missing policy file (`failOnMissingFile: true`, default) | **Throws**. Set the flag to `false` to downgrade to warn-and-skip. |
| Manifest references an empty policy file (`failOnEmptyPolicy: true`, default) | **Throws**. Set the flag to `false` to allow. |
| Duplicate policy name in manifest | **Throws** — ambiguous, no good silent recovery. |
| Entry missing `name` or `file` | **Throws**. |

The intent is "loud and early" for any deploy mistake. The only soft state is a fully-absent manifest.

---

## Boot-time audit log

After a successful load, this app logs one line per policy with `name`, `version`, the first 12 chars of `contentHash`, and the resolved `sourcePath`:

```
[document-policies] loaded 2 policies: [
  { name: 'identity-documents', version: '1.0.0', contentHash: 'bcd069e38a1c', sourcePath: '…/server/policies/identity-documents.md' },
  { name: 'contract-review',    version: '1.0.0', contentHash: 'a8de270d5d3d', sourcePath: '…/server/policies/contract-review.md' }
]
```

Policy *bodies* are never logged — hashes + paths are sufficient for auditability without exposing customer-shaped sample data.

---

## Integration sketch

```ts
import { loadConfiguredPolicies } from "./document-policies";
import { DocumentPolicyRegistry } from "./document-pipeline/policy.js"; // or any registry

const registry = new DocumentPolicyRegistry();
for (const p of loadConfiguredPolicies()) {
  registry.register(p.name, p.text, p.version);
}
```

The reusable lib needs no changes for a different registry implementation, different policy body formats, or different manifest locations.

---

## Tests

In this app, tests live at `server/test/document-pipeline/document-policies.test.ts` (17 tests):

- Manifest loader: absent-returns-null, valid round-trip, malformed JSON throws, missing `policies` array throws, duplicate name throws, broken entry shapes throw, env override path missing throws, `${ENV_VAR}` interpolation, explicit `failOnMissingFile=false` / `failOnEmptyPolicy=false` honoured.
- Body loader: defaults version to "1.0.0", computes SHA-256 hash, missing-with-fail throws, missing-without-fail warns and skips, empty-with-fail throws, empty-without-fail warns and skips.
- `loadConfiguredPolicies`: empty when manifest absent, full round-trip when both manifest and bodies present.
- Integration: `LoadedPolicy[]` registers cleanly into a real `DocumentPolicyRegistry`.

---

## Extracting to Another App

1. Copy or package `server/src/document-policies/`.
2. No runtime deps beyond Node built-ins (`node:crypto`, `node:fs`, `node:path`).
3. Decide your file layout — typically `server/policies/<name>.md` next to a `server/config/document-policies.json` manifest, but any layout works as long as `policiesDir` and `file` paths agree.
4. Drop a `server/config/document-policies.json` and the body files.
5. Call `loadConfiguredPolicies()` at boot, then loop and register each `LoadedPolicy` into your runtime registry.

The reusable module emits a plain `LoadedPolicy[]` and lets the caller register them into whatever sink they choose. It has no dependency on `document-pipeline/` or any specific registry implementation.

## Provenance

Crafted with generous assistance from AI generation and automation workflows.
Humans were primarily on testing duty, quality patrol, and occasional mischief containment.
