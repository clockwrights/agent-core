// ---------------------------------------------------------------------------
// Document Policies Loader — reusable
//
// Reads policy bodies from disk based on a `DocumentPoliciesManifest` and
// emits a plain `LoadedPolicy[]`. The loader has no opinion about what the
// caller does with the result — apps glue them into a registry of their own
// choosing (e.g. `DocumentPolicyRegistry` from `document-pipeline/`).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parsePolicyFile, type ParsedPolicyFile, type PolicySeverity } from "./frontMatter.js";
import { extractPolicyRules, type PolicyRule } from "./rules.js";
import {
  DocumentPoliciesConfigError,
  loadPoliciesManifest,
  type DocumentPoliciesManifest,
  type LoadManifestOptions,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoadedPolicy = {
  name: string;
  /** Policy body. Without front-matter this is the whole file, unchanged. */
  text: string;
  version: string;
  /** Absolute path the body was read from. Useful for boot-time audit logs. */
  sourcePath: string;
  /**
   * SHA-256 of the policy file as read (front-matter included, so metadata
   * changes are visible in audits). Equals the body hash for files without
   * front-matter. Referenced files carry their own hashes.
   */
  contentHash: string;
  /** Front-matter fields (only set when the file has front-matter). */
  appliesTo?: string[];
  severity?: PolicySeverity;
  component?: string;
  /** Parsed JSON Schema from `outputSchema:` (path relative to the policy file). */
  outputSchema?: { path: string; schema: Record<string, unknown>; contentHash: string };
  /** Files listed under `examples:` (paths relative to the policy file). */
  examples?: Array<{ path: string; text: string; contentHash: string }>;
  /** Front-matter keys this package does not interpret, kept verbatim. */
  meta?: Record<string, string | string[]>;
  /**
   * Rules anchored with `{#rule-id}` in the body. The loader always sets it
   * (empty when there are none); optional in the type so hand-built values
   * stay valid.
   */
  rules?: PolicyRule[];
};

export type LoadPoliciesOptions = {
  /** Override the file-system reader (used by tests). Returns `undefined` when the file is absent. */
  readFile?: (path: string) => string | undefined;
};

export type LoadConfiguredPoliciesOptions = LoadManifestOptions & LoadPoliciesOptions;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read every policy body referenced by the manifest. Returns the list in the
 * same order the manifest declared them.
 *
 * Throws `DocumentPoliciesConfigError` for fatal issues (missing file with
 * `failOnMissingFile`, empty body with `failOnEmptyPolicy`, etc.). When the
 * fail flags are off, the offending entry is skipped with a warning.
 */
export function loadPolicies(
  manifest: DocumentPoliciesManifest,
  options: LoadPoliciesOptions = {},
): LoadedPolicy[] {
  const readFile = options.readFile ?? readFileSyncSafe;
  const policiesDir = resolve(manifest.policiesDir);
  const out: LoadedPolicy[] = [];

  for (const entry of manifest.policies) {
    const sourcePath = resolve(policiesDir, entry.file);
    const text = readFile(sourcePath);

    if (text === undefined) {
      if (manifest.failOnMissingFile) {
        throw new DocumentPoliciesConfigError(
          `policy "${entry.name}" file not found at "${sourcePath}".`,
          sourcePath,
        );
      }
      console.warn(
        `[document-policies] policy "${entry.name}" file not found at "${sourcePath}"; skipping.`,
      );
      continue;
    }

    if (text.trim() === "") {
      if (manifest.failOnEmptyPolicy) {
        throw new DocumentPoliciesConfigError(
          `policy "${entry.name}" body at "${sourcePath}" is empty.`,
          sourcePath,
        );
      }
      console.warn(
        `[document-policies] policy "${entry.name}" body at "${sourcePath}" is empty; skipping.`,
      );
      continue;
    }

    const loaded = buildLoadedPolicy(entry.name, entry.version ?? "1.0.0", sourcePath, text, manifest, readFile);
    if (loaded) out.push(loaded);
  }

  return out;
}

function buildLoadedPolicy(
  name: string,
  version: string,
  sourcePath: string,
  raw: string,
  manifest: DocumentPoliciesManifest,
  readFile: (path: string) => string | undefined,
): LoadedPolicy | null {
  let parsed: ParsedPolicyFile;
  let rules: PolicyRule[];
  try {
    parsed = parsePolicyFile(raw);
    rules = extractPolicyRules(parsed.body, parsed.frontMatter?.severity);
  } catch (err) {
    // A present-but-broken policy file is always a bug: never fall back silently.
    throw new DocumentPoliciesConfigError(`policy "${name}" at "${sourcePath}": ${(err as Error).message}`, sourcePath);
  }

  const policy: LoadedPolicy = { name, text: parsed.body, version, sourcePath, contentHash: sha256(raw), rules };
  const fm = parsed.frontMatter;
  if (!fm) return policy;

  if (parsed.body.trim() === "") {
    if (manifest.failOnEmptyPolicy) {
      throw new DocumentPoliciesConfigError(`policy "${name}" body at "${sourcePath}" is empty.`, sourcePath);
    }
    console.warn(`[document-policies] policy "${name}" body at "${sourcePath}" is empty; skipping.`);
    return null;
  }
  if (fm.appliesTo) policy.appliesTo = fm.appliesTo;
  if (fm.severity) policy.severity = fm.severity;
  if (fm.component) policy.component = fm.component;
  if (Object.keys(fm.extra).length > 0) policy.meta = fm.extra;

  // Referenced files resolve against the policy file's folder.
  const baseDir = dirname(sourcePath);
  const readReferenced = (relative: string, what: string): { path: string; text: string } | null => {
    const path = resolve(baseDir, relative);
    const text = readFile(path);
    if (text !== undefined) return { path, text };
    if (manifest.failOnMissingFile) {
      throw new DocumentPoliciesConfigError(`policy "${name}" ${what} not found at "${path}".`, path);
    }
    console.warn(`[document-policies] policy "${name}" ${what} not found at "${path}"; skipping the policy.`);
    return null;
  };

  if (fm.outputSchema) {
    const file = readReferenced(fm.outputSchema, "outputSchema");
    if (!file) return null;
    let schema: unknown;
    try {
      schema = JSON.parse(file.text);
    } catch (err) {
      throw new DocumentPoliciesConfigError(
        `policy "${name}" outputSchema at "${file.path}" is not valid JSON: ${(err as Error).message}`,
        file.path,
      );
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new DocumentPoliciesConfigError(
        `policy "${name}" outputSchema at "${file.path}" must be a JSON object.`,
        file.path,
      );
    }
    policy.outputSchema = { path: file.path, schema: schema as Record<string, unknown>, contentHash: sha256(file.text) };
  }

  if (fm.examples) {
    const examples: NonNullable<LoadedPolicy["examples"]> = [];
    for (const relative of fm.examples) {
      const file = readReferenced(relative, `example "${relative}"`);
      if (!file) return null;
      examples.push({ path: file.path, text: file.text, contentHash: sha256(file.text) });
    }
    policy.examples = examples;
  }

  return policy;
}

/**
 * Convenience: load the manifest and then read all policy bodies. Returns an
 * empty list when the manifest is absent (open-vocabulary path).
 */
export function loadConfiguredPolicies(
  options: LoadConfiguredPoliciesOptions = {},
): LoadedPolicy[] {
  const manifest = loadPoliciesManifest(options);
  if (!manifest) return [];
  return loadPolicies(manifest, options);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
