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
import { resolve } from "node:path";
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
  text: string;
  version: string;
  /** Absolute path the body was read from. Useful for boot-time audit logs. */
  sourcePath: string;
  /** SHA-256 of the policy body. Useful for boot-time audit logs. */
  contentHash: string;
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

    out.push({
      name: entry.name,
      text,
      version: entry.version ?? "1.0.0",
      sourcePath,
      contentHash: sha256(text),
    });
  }

  return out;
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
