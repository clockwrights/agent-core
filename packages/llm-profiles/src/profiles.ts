// ---------------------------------------------------------------------------
// LLM Profile Configuration — reusable
//
// Pure configuration types + loader for multi-LLM routing. Reusable across
// apps: this module knows nothing about any specific LLM SDK or consumer
// component. Apps consume the generic `createLlmRouter<P>` from `./router.js`
// and supply their own provider factory + optional failover wrapper.
//
// Configuration sources (file wins over env):
//   1. <filePath> (default: "config/llm-profiles.json")
//   2. LLM_PROFILES_JSON environment variable (raw JSON string)
//
// Env interpolation: a string that is exactly `${NAME}`, `${NAME:-default}` or
// `${NAME:?message}` is replaced from the environment at load time, keeping
// secrets out of the file.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LlmProfile = {
  /** Stable identifier referenced by `defaultProfile` and `components.*.profile`. */
  name: string;
  /** Provider id, e.g. "openai", "anthropic", or any app-defined label. */
  provider: string;
  /** Model id within the provider. */
  model: string;
  /** API key. May be `${ENV_VAR}` form. */
  apiKey?: string;
  /** Custom base URL for OpenAI-compatible providers. */
  baseUrl?: string;
  /**
   * Reasoning depth passed to compatible models. Loose `string` here so the
   * config schema stays runtime-agnostic; apps narrow this when converting to
   * their concrete provider runtime config.
   */
  thinkingLevel?: string;
  /** Output token budget. */
  maxTokens?: number;
  /** Approximate model context window. */
  contextWindow?: number;
};

export type ComponentRouting = {
  /** Profile used as primary for this component. */
  profile: string;
  /** Optional fallback profile, tried only on thrown errors from the primary. */
  fallback?: string;
};

export type LlmRoutingConfig = {
  profiles: LlmProfile[];
  /** Profile used when no component-specific routing applies. */
  defaultProfile: string;
  /** Per-component overrides keyed by component identifier. */
  components?: Record<string, ComponentRouting>;
};

// ---------------------------------------------------------------------------
// Default config file path
// ---------------------------------------------------------------------------

/**
 * Path resolution mirrors `dotenv.config()`: relative to the process CWD.
 */
const DEFAULT_CONFIG_PATH = "config/llm-profiles.json";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `loadLlmRoutingConfig({ strict: true })` for any configuration
 * problem that the non-strict loader would only warn about. `source` is the
 * config file path or `"LLM_PROFILES_JSON"`. Messages never contain secrets.
 */
export class LlmProfilesConfigError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(`[llm-profiles] ${message}`);
    this.name = "LlmProfilesConfigError";
  }
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export type LoadLlmRoutingOptions = {
  /** Override the file path. Defaults to `config/llm-profiles.json`. */
  filePath?: string;
  /** Override the env namespace. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the file system reader (used by tests). Returns `undefined` when the file is absent. */
  readFile?: (path: string) => string | undefined;
  /**
   * Throw `LlmProfilesConfigError` on any configuration problem instead of
   * warning and degrading (dropping the item or returning `null`).
   * Absent config (no file, no env var) still returns `null`. Default false.
   */
  strict?: boolean;
};

/**
 * Load the routing config. Returns `null` when neither source is present, so
 * callers can fall back to a legacy single-LLM path.
 *
 * Priority (file wins):
 *   1. config/llm-profiles.json
 *   2. LLM_PROFILES_JSON env var
 *
 * Default (non-strict): validation issues (missing default profile, dangling
 * component references, malformed JSON, missing env vars) are reported via
 * `console.warn`; fatal ones make the function return `null` so the caller
 * starts on the legacy path rather than failing. With `strict: true` every
 * such issue throws `LlmProfilesConfigError`.
 */
export function loadLlmRoutingConfig(
  options: LoadLlmRoutingOptions = {},
): LlmRoutingConfig | null {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileSyncSafe;
  const filePath = options.filePath ?? resolve(DEFAULT_CONFIG_PATH);

  const fileText = readFile(filePath);
  const envText = env.LLM_PROFILES_JSON;

  let text: string;
  let source: Source;
  if (fileText !== undefined) {
    text = fileText;
    source = { kind: "file", label: filePath };
  } else if (envText && envText.trim() !== "") {
    text = envText;
    source = { kind: "env", label: "LLM_PROFILES_JSON" };
  } else {
    return null;
  }

  const report = createReporter(source, options.strict === true);

  // Parse errors are reported by position only: V8's SyntaxError message
  // quotes a snippet of the input, which may contain a literal API key.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    report(`failed to parse ${source.label}${describeParseErrorLocation(err)}; falling back to legacy single-LLM config.`);
    return null;
  }

  const interpolation = { fatal: false };
  const interpolated = interpolateEnv(raw, env, report, interpolation);
  if (interpolation.fatal) return null;
  return validateConfig(interpolated, source.kind, report);
}

// ---------------------------------------------------------------------------
// Component resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a component identifier to its primary profile and optional fallback.
 * Falls back to the default profile when no component-specific routing exists.
 * Returns `null` for primary if neither the component nor the default profile
 * resolves (caller should treat this as misconfiguration).
 */
export function resolveComponentRouting(
  config: LlmRoutingConfig,
  componentId: string,
): { primary: LlmProfile; fallback: LlmProfile | null } | null {
  const profilesByName = new Map(config.profiles.map((p) => [p.name, p]));
  const routing = config.components?.[componentId];

  const primaryName = routing?.profile ?? config.defaultProfile;
  const primary = profilesByName.get(primaryName);
  if (!primary) return null;

  const fallback = routing?.fallback
    ? (profilesByName.get(routing.fallback) ?? null)
    : null;

  return { primary, fallback };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Source = { kind: "file" | "env"; label: string };

/** Reports a config problem: throws in strict mode, warns otherwise. */
type Reporter = (message: string) => void;

function createReporter(source: Source, strict: boolean): Reporter {
  return (message) => {
    if (strict) throw new LlmProfilesConfigError(message, source.label);
    console.warn(`[llm-profiles] ${message}`);
  };
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // ENOENT and friends: file simply doesn't exist or isn't readable.
    return undefined;
  }
}

/**
 * Describe where a JSON.parse failure happened without quoting the input.
 * Returns e.g. " (line 1 column 3)", " (position 12)" or "".
 */
function describeParseErrorLocation(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) return ` (line ${lineColumn[1]} column ${lineColumn[2]})`;
  const position = /position (\d+)/.exec(message);
  if (position) return ` (position ${position[1]})`;
  return "";
}

/**
 * Whole-string env references:
 *   ${NAME}          value of NAME; unset → "" with a warning
 *   ${NAME:-default} value of NAME, or `default` when NAME is unset or empty
 *   ${NAME:?message} value of NAME; unset or empty → config error
 */
const ENV_INTERPOLATION_RE = /^\$\{([A-Z_][A-Z0-9_]*)(?:(:-|:\?)([^}]*))?\}$/;

/**
 * Walk the parsed JSON tree and replace any string that is exactly an env
 * reference (see `ENV_INTERPOLATION_RE`). Other strings pass through
 * unchanged. A missing required var marks the interpolation fatal.
 */
function interpolateEnv(
  value: unknown,
  env: NodeJS.ProcessEnv,
  report: Reporter,
  state: { fatal: boolean },
): unknown {
  if (typeof value === "string") {
    const match = ENV_INTERPOLATION_RE.exec(value);
    if (!match) return value;
    const varName = match[1]!;
    const operator = match[2];
    const operand = match[3] ?? "";
    const resolved = env[varName];

    if (operator === ":-") {
      return resolved === undefined || resolved === "" ? operand : resolved;
    }
    if (operator === ":?") {
      if (resolved === undefined || resolved === "") {
        report(`required env var ${varName} is not set${operand ? `: ${operand}` : ""}; ignoring config.`);
        state.fatal = true;
        return "";
      }
      return resolved;
    }
    if (resolved === undefined) {
      report(`env var ${varName} referenced in config is not set.`);
      return "";
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env, report, state));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env, report, state);
    }
    return out;
  }
  return value;
}

function validateConfig(raw: unknown, source: "file" | "env", report: Reporter): LlmRoutingConfig | null {
  if (!raw || typeof raw !== "object") {
    report(`${source} config is not an object; ignoring.`);
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const profiles = obj["profiles"];
  const defaultProfile = obj["defaultProfile"];
  const components = obj["components"];

  if (!Array.isArray(profiles) || profiles.length === 0) {
    report(`${source} config missing non-empty "profiles" array; ignoring.`);
    return null;
  }

  const validatedProfiles: LlmProfile[] = [];
  const profileNames = new Set<string>();
  for (const [index, p] of profiles.entries()) {
    if (!p || typeof p !== "object") {
      report(`profile #${index} is not an object; ignoring it.`);
      continue;
    }
    const profile = p as Record<string, unknown>;
    const name = profile["name"];
    const provider = profile["provider"];
    const model = profile["model"];
    if (typeof name !== "string" || typeof provider !== "string" || typeof model !== "string") {
      // Never log the profile object itself: it holds interpolated secrets.
      const missing = [
        typeof name !== "string" ? "name" : null,
        typeof provider !== "string" ? "provider" : null,
        typeof model !== "string" ? "model" : null,
      ].filter(Boolean);
      const label = typeof name === "string" ? ` "${name}"` : "";
      report(`profile #${index}${label} is missing ${missing.join("/")}; ignoring it.`);
      continue;
    }
    if (profileNames.has(name)) {
      report(`duplicate profile name "${name}"; ignoring later instances.`);
      continue;
    }
    profileNames.add(name);
    validatedProfiles.push({
      name,
      provider,
      model,
      apiKey: typeof profile["apiKey"] === "string" ? (profile["apiKey"] as string) : undefined,
      baseUrl: typeof profile["baseUrl"] === "string" ? (profile["baseUrl"] as string) : undefined,
      thinkingLevel:
        typeof profile["thinkingLevel"] === "string" ? (profile["thinkingLevel"] as string) : undefined,
      maxTokens: typeof profile["maxTokens"] === "number" ? (profile["maxTokens"] as number) : undefined,
      contextWindow:
        typeof profile["contextWindow"] === "number" ? (profile["contextWindow"] as number) : undefined,
    });
  }

  if (validatedProfiles.length === 0) {
    report(`${source} config has no valid profiles; ignoring.`);
    return null;
  }

  if (typeof defaultProfile !== "string" || !profileNames.has(defaultProfile)) {
    report(`${source} config "defaultProfile" must reference a known profile; ignoring config.`);
    return null;
  }

  let validatedComponents: Record<string, ComponentRouting> | undefined;
  if (components && typeof components === "object") {
    validatedComponents = {};
    for (const [componentId, routing] of Object.entries(components as Record<string, unknown>)) {
      if (!routing || typeof routing !== "object") {
        report(`component "${componentId}" routing is not an object; ignoring.`);
        continue;
      }
      const r = routing as Record<string, unknown>;
      const profile = r["profile"];
      const fallback = r["fallback"];
      if (typeof profile !== "string" || !profileNames.has(profile)) {
        report(`component "${componentId}" references unknown profile "${String(profile)}"; ignoring.`);
        continue;
      }
      if (fallback !== undefined && (typeof fallback !== "string" || !profileNames.has(fallback))) {
        report(`component "${componentId}" references unknown fallback "${String(fallback)}"; dropping fallback.`);
        validatedComponents[componentId] = { profile };
        continue;
      }
      validatedComponents[componentId] = {
        profile,
        ...(typeof fallback === "string" ? { fallback } : {}),
      };
    }
  }

  return {
    profiles: validatedProfiles,
    defaultProfile,
    ...(validatedComponents ? { components: validatedComponents } : {}),
  };
}
