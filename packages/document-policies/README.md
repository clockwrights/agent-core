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
  text: string;             // policy body (front-matter removed, if any)
  version: string;
  sourcePath: string;       // absolute path the body was read from
  contentHash: string;      // SHA-256 of the file as read, useful for boot-time audit logs
  // From front-matter (see below); only set when present:
  appliesTo?: string[];
  severity?: "info" | "warning" | "error";
  component?: string;
  outputSchema?: { path: string; schema: Record<string, unknown>; contentHash: string };
  examples?: { path: string; text: string; contentHash: string }[];
  meta?: Record<string, string | string[]>;   // keys this package does not interpret
  rules?: PolicyRule[];     // `{#rule-id}` anchors; always set by the loader ([] when none)
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

## Front-matter (optional)

A policy file may start with a front-matter block. Files without one load exactly as before.

```markdown
---
appliesTo: [passport, id-card]
severity: error
component: document-pipeline
outputSchema: identity.schema.json
examples:
  - examples/passport-ok.md
  - examples/passport-expired.md
owner: kyc-team
---
# Identity documents
...
```

| Key | Becomes | Notes |
|---|---|---|
| `appliesTo` | `appliesTo: string[]` | Document labels/types; a single value becomes a one-item list. |
| `severity` | `severity` | `info`, `warning` or `error`. Rules inherit it. |
| `component` | `component` | Free text naming the consumer. |
| `outputSchema` | `outputSchema: { path, schema, contentHash }` | JSON Schema file, relative to the policy file. Must be a JSON object. |
| `examples` | `examples: { path, text, contentHash }[]` | Files relative to the policy file, read as text. |
| anything else | `meta` | Kept verbatim. |

The format is a small YAML subset, parsed without dependencies: `key: value`, `key: [a, b]` (no commas inside items), `key:` followed by `  - item` lines, optional quotes, `#` comment lines. Nested maps are not supported.

- A `---` block counts as front-matter only when the file's first line is exactly `---`, a closing `---` exists, and the first non-comment line inside looks like `key:`. A Markdown file that opens with a horizontal rule followed by prose stays plain body text.
- Once a block counts as front-matter, a line that does not parse, an unknown `severity`, a duplicate key or an unreadable `outputSchema` is a `DocumentPoliciesConfigError`.
- Missing `outputSchema` / `examples` files follow `failOnMissingFile` (throw, or warn and skip the whole policy).
- `text` is the body without the block; `contentHash` covers the whole file, so a metadata change shows up in the audit log. Registries that hash `text` (like `DocumentPolicyRegistry`) will hash only the body.

---

## Rule anchors and verdicts

End a heading or list item with `{#rule-id}` to make it a citable rule:

```markdown
## Passport must be valid {#passport-valid}
- Expiry date is after the submission date {#passport-expiry}
- Name matches the application {#name-match}
```

- `LoadedPolicy.rules` lists them: `{ id, text, line, severity? }`. A heading rule's text runs to the next heading of the same or higher level; a list-item rule includes its indented continuation lines. Anchors in fenced code blocks or plain paragraphs are ignored; duplicate ids are a config error.
- The anchors stay in `text`, so the model sees the ids it should cite.
- `buildRuleCitationInstructions(rules)` returns prompt text asking for `{"verdicts": [{ ruleId, outcome, evidence[], note? }]}` with `outcome` one of `pass`, `fail`, `not_applicable`, `uncertain`.
- `checkPolicyVerdicts(output, rules, { requireEvidenceFor? })` validates the model's answer (object, array or JSON string, fences allowed). It never throws on model output: verdicts citing unknown rules, second verdicts for a rule, bad outcomes and `pass`/`fail` without evidence are dropped and explained in `problems`; rules with no valid verdict are listed in `missingRuleIds`. Kept verdicts carry the rule's severity.

```ts
const prompt = `${policy.text}\n\n${buildRuleCitationInstructions(policy.rules ?? [])}`;
const reply = await myModel(prompt);
const { verdicts, missingRuleIds, problems } = checkPolicyVerdicts(reply, policy.rules ?? []);
```

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
