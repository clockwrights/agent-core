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
// `${ENV_VAR}` interpolation: any string of the form `${NAME}` is replaced
// with `process.env.NAME` at load time, keeping secrets out of the file.
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
// Public loader
// ---------------------------------------------------------------------------

export type LoadLlmRoutingOptions = {
  /** Override the file path. Defaults to `config/llm-profiles.json`. */
  filePath?: string;
  /** Override the env namespace. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the file system reader (used by tests). Returns `undefined` when the file is absent. */
  readFile?: (path: string) => string | undefined;
};

/**
 * Load the routing config. Returns `null` when neither source is present, so
 * callers can fall back to a legacy single-LLM path.
 *
 * Priority (file wins):
 *   1. config/llm-profiles.json
 *   2. LLM_PROFILES_JSON env var
 *
 * Validation issues (missing default profile, dangling component references,
 * malformed JSON) are reported via `console.warn` and the function returns
 * `null` — the caller starts on the legacy path rather than failing.
 */
export function loadLlmRoutingConfig(
  options: LoadLlmRoutingOptions = {},
): LlmRoutingConfig | null {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileSyncSafe;
  const filePath = options.filePath ?? resolve(DEFAULT_CONFIG_PATH);

  const fileText = readFile(filePath);
  const envText = env.LLM_PROFILES_JSON;

  let raw: unknown;
  let source: "file" | "env";

  if (fileText !== undefined) {
    source = "file";
    try {
      raw = JSON.parse(fileText);
    } catch (err) {
      console.warn(
        `[llm-profiles] failed to parse ${filePath}; falling back to legacy single-LLM config.`,
        err,
      );
      return null;
    }
  } else if (envText && envText.trim() !== "") {
    source = "env";
    try {
      raw = JSON.parse(envText);
    } catch (err) {
      console.warn(
        "[llm-profiles] failed to parse LLM_PROFILES_JSON; falling back to legacy single-LLM config.",
        err,
      );
      return null;
    }
  } else {
    return null;
  }

  const interpolated = interpolateEnv(raw, env);
  const validated = validateConfig(interpolated, source);
  return validated;
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

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // ENOENT and friends: file simply doesn't exist or isn't readable.
    return undefined;
  }
}

const ENV_INTERPOLATION_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/**
 * Walk the parsed JSON tree and replace any string of the form `${VAR}` with
 * the matching env value. Strings that don't match the pattern are passed
 * through unchanged. Missing env vars produce an empty string and a warning;
 * downstream validation may reject the resulting profile.
 */
function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    const match = ENV_INTERPOLATION_RE.exec(value);
    if (!match) return value;
    const varName = match[1]!;
    const resolved = env[varName];
    if (resolved === undefined) {
      console.warn(`[llm-profiles] env var ${varName} referenced in config is not set.`);
      return "";
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env);
    }
    return out;
  }
  return value;
}

function validateConfig(raw: unknown, source: "file" | "env"): LlmRoutingConfig | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`[llm-profiles] ${source} config is not an object; ignoring.`);
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const profiles = obj["profiles"];
  const defaultProfile = obj["defaultProfile"];
  const components = obj["components"];

  if (!Array.isArray(profiles) || profiles.length === 0) {
    console.warn(`[llm-profiles] ${source} config missing non-empty "profiles" array; ignoring.`);
    return null;
  }

  const validatedProfiles: LlmProfile[] = [];
  const profileNames = new Set<string>();
  for (const p of profiles) {
    if (!p || typeof p !== "object") continue;
    const profile = p as Record<string, unknown>;
    const name = profile["name"];
    const provider = profile["provider"];
    const model = profile["model"];
    if (typeof name !== "string" || typeof provider !== "string" || typeof model !== "string") {
      console.warn("[llm-profiles] profile is missing name/provider/model; ignoring it.", profile);
      continue;
    }
    if (profileNames.has(name)) {
      console.warn(`[llm-profiles] duplicate profile name "${name}"; ignoring later instances.`);
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
    console.warn(`[llm-profiles] ${source} config has no valid profiles; ignoring.`);
    return null;
  }

  if (typeof defaultProfile !== "string" || !profileNames.has(defaultProfile)) {
    console.warn(
      `[llm-profiles] ${source} config "defaultProfile" must reference a known profile; ignoring config.`,
    );
    return null;
  }

  let validatedComponents: Record<string, ComponentRouting> | undefined;
  if (components && typeof components === "object") {
    validatedComponents = {};
    for (const [componentId, routing] of Object.entries(components as Record<string, unknown>)) {
      if (!routing || typeof routing !== "object") continue;
      const r = routing as Record<string, unknown>;
      const profile = r["profile"];
      const fallback = r["fallback"];
      if (typeof profile !== "string" || !profileNames.has(profile)) {
        console.warn(
          `[llm-profiles] component "${componentId}" references unknown profile "${String(profile)}"; ignoring.`,
        );
        continue;
      }
      if (fallback !== undefined && (typeof fallback !== "string" || !profileNames.has(fallback))) {
        console.warn(
          `[llm-profiles] component "${componentId}" references unknown fallback "${String(fallback)}"; dropping fallback.`,
        );
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
