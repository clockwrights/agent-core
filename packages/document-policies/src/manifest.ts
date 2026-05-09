// ---------------------------------------------------------------------------
// Document Policies Manifest — reusable
//
// Loads the manifest that maps policy names to policy-text files. The
// manifest is a small JSON config; policy bodies live in separate files
// (typically Markdown) so they can be diffed in PRs and edited without
// touching code.
//
// Configuration sources (file wins over env override):
//   1. <filePath> (default: "server/config/document-policies.json")
//   2. DOCUMENT_POLICIES_MANIFEST env var (path to a manifest file)
//
// The manifest only contains paths/names — policy bodies are NOT inlined
// in env vars (4 KB+ Markdown in environment is hostile to operators).
//
// `${ENV_VAR}` interpolation is supported for `policiesDir` so deployments
// can relocate the policy folder via env without a config change.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PolicyManifestEntry = {
  /** Logical policy name as referenced via `?policyName=...`. */
  name: string;
  /** Path to the policy body, relative to `policiesDir`. */
  file: string;
  /** Optional semantic version. Defaults to "1.0.0" when omitted. */
  version?: string;
};

export type DocumentPoliciesManifest = {
  /** Folder that contains the policy body files. Resolved against process CWD. */
  policiesDir: string;
  policies: PolicyManifestEntry[];
  /** When true (default), a missing policy file fails the boot. */
  failOnMissingFile: boolean;
  /** When true (default), an empty policy file fails the boot. */
  failOnEmptyPolicy: boolean;
};

export type LoadManifestOptions = {
  /** Override the manifest path. Defaults to `server/config/document-policies.json`. */
  filePath?: string;
  /** Override env namespace. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the file-system reader (used by tests). Returns `undefined` when the file is absent. */
  readFile?: (path: string) => string | undefined;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DocumentPoliciesConfigError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`[document-policies] ${message}`);
    this.name = "DocumentPoliciesConfigError";
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MANIFEST_PATH = "server/config/document-policies.json";
const DEFAULT_POLICIES_DIR = "server/policies";

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load the manifest. Returns `null` when the manifest file is absent and no
 * `DOCUMENT_POLICIES_MANIFEST` env override is set. Throws
 * `DocumentPoliciesConfigError` when the manifest is present but malformed —
 * a present-but-broken config is always a bug and never falls back silently.
 */
export function loadPoliciesManifest(
  options: LoadManifestOptions = {},
): DocumentPoliciesManifest | null {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileSyncSafe;

  const overridePath = env.DOCUMENT_POLICIES_MANIFEST?.trim();
  const filePath = options.filePath ?? (overridePath ? resolve(overridePath) : resolve(DEFAULT_MANIFEST_PATH));

  const text = readFile(filePath);
  if (text === undefined) {
    if (overridePath) {
      // The operator explicitly pointed at a manifest path — missing it is fatal.
      throw new DocumentPoliciesConfigError(
        `manifest file not found at "${filePath}" (DOCUMENT_POLICIES_MANIFEST override).`,
        filePath,
      );
    }
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DocumentPoliciesConfigError(
      `failed to parse manifest at "${filePath}": ${(err as Error).message}`,
      filePath,
    );
  }

  return validateManifest(interpolateEnv(raw, env), filePath);
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

const ENV_INTERPOLATION_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    const match = ENV_INTERPOLATION_RE.exec(value);
    if (!match) return value;
    const varName = match[1]!;
    const resolved = env[varName];
    if (resolved === undefined) {
      console.warn(`[document-policies] env var ${varName} referenced in manifest is not set.`);
      return "";
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out;
  }
  return value;
}

function validateManifest(raw: unknown, source: string): DocumentPoliciesManifest {
  if (!raw || typeof raw !== "object") {
    throw new DocumentPoliciesConfigError(
      `manifest at "${source}" must be a JSON object.`,
      source,
    );
  }

  const obj = raw as Record<string, unknown>;
  const policiesRaw = obj["policies"];
  if (!Array.isArray(policiesRaw)) {
    throw new DocumentPoliciesConfigError(
      `manifest at "${source}" must contain a "policies" array.`,
      source,
    );
  }

  const policies: PolicyManifestEntry[] = [];
  const seenNames = new Set<string>();
  for (const [i, entry] of policiesRaw.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new DocumentPoliciesConfigError(
        `policies[${i}] in "${source}" is not an object.`,
        source,
      );
    }
    const e = entry as Record<string, unknown>;
    const name = e["name"];
    const file = e["file"];
    const version = e["version"];
    if (typeof name !== "string" || name.trim() === "") {
      throw new DocumentPoliciesConfigError(
        `policies[${i}] in "${source}" is missing a non-empty "name".`,
        source,
      );
    }
    if (typeof file !== "string" || file.trim() === "") {
      throw new DocumentPoliciesConfigError(
        `policies[${i}] (name="${name}") in "${source}" is missing a non-empty "file".`,
        source,
      );
    }
    if (seenNames.has(name)) {
      throw new DocumentPoliciesConfigError(
        `duplicate policy name "${name}" in "${source}".`,
        source,
      );
    }
    seenNames.add(name);
    policies.push({
      name,
      file,
      ...(typeof version === "string" && version.trim() !== "" ? { version } : {}),
    });
  }

  const policiesDirRaw = obj["policiesDir"];
  const policiesDir =
    typeof policiesDirRaw === "string" && policiesDirRaw.trim() !== ""
      ? policiesDirRaw
      : DEFAULT_POLICIES_DIR;

  const failOnMissingFile = obj["failOnMissingFile"] === false ? false : true;
  const failOnEmptyPolicy = obj["failOnEmptyPolicy"] === false ? false : true;

  return { policiesDir, policies, failOnMissingFile, failOnEmptyPolicy };
}
