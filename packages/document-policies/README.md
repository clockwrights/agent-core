# @maya-ai/document-policies

Loads named natural-language policies from a manifest plus separate body files. Emits a plain `LoadedPolicy[]`. The package is **registry-agnostic**: it has no opinion about what the caller does with the result. Apps glue the loaded policies into whatever registry their pipeline uses — for example, the `DocumentPolicyRegistry` from [`@maya-ai/document-pipeline`](https://www.npmjs.com/package/@maya-ai/document-pipeline).

Zero runtime dependencies beyond Node built-ins (`node:crypto`, `node:fs`, `node:path`).

## Install

```bash
npm install @maya-ai/document-policies
```

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
} from "@maya-ai/document-policies";
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

`LoadedPolicy` exposes `name`, `version`, `contentHash`, and `sourcePath` — everything an app needs for a per-policy startup log. A typical line includes the first 12 chars of `contentHash` and the resolved path:

```
[document-policies] loaded 2 policies: [
  { name: 'identity-documents', version: '1.0.0', contentHash: 'bcd069e38a1c', sourcePath: '…/policies/identity-documents.md' },
  { name: 'contract-review',    version: '1.0.0', contentHash: 'a8de270d5d3d', sourcePath: '…/policies/contract-review.md' }
]
```

Policy *bodies* are never logged by this package — hashes + paths are sufficient for auditability without exposing customer-shaped sample data.

---

## Integration sketch

```ts
import { loadConfiguredPolicies } from "@maya-ai/document-policies";
import { DocumentPolicyRegistry } from "@maya-ai/document-pipeline"; // or any registry

const registry = new DocumentPolicyRegistry();
for (const p of loadConfiguredPolicies()) {
  registry.register(p.name, p.text, p.version);
}
```

The reusable lib needs no changes for a different registry implementation, different policy body formats, or different manifest locations.

---

## License

MIT.

## Provenance

Crafted with generous assistance from AI generation and automation workflows. Humans were primarily on testing duty, quality patrol, and occasional mischief containment.
