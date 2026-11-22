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
  /**
   * What the model can do. Well-known keys: `vision`, `documents`, `tools`,
   * `reasoning`; any other key is allowed. Used by `components.*.requires`
   * load-time checks. A profile without `capabilities` is not checked.
   */
  capabilities?: LlmCapabilities;
  /**
   * Per-million-token rates in pi-ai's `Model.cost` shape. Not a second cost
   * calculator: apps copy it onto the model they build so pi-ai computes
   * `usage.cost` as usual (useful for custom or self-hosted models pi-ai has
   * no rates for).
   */
  pricing?: LlmPricing;
};

export type LlmCapabilities = {
  vision?: boolean;
  documents?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  [capability: string]: boolean | undefined;
};

/** USD per million tokens, same units and keys as pi-ai's `Model.cost`. */
export type LlmPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Retry policy for one routing target before moving to the next. */
export type LlmRetryPolicy = {
  /** Total attempts per target, including the first. Default 1 (no retry). */
  maxAttempts?: number;
  /** Delay before the first retry; doubles per retry. Default 0. */
  backoffMs?: number;
  /** Upper bound for the retry delay. Default: no bound. */
  maxBackoffMs?: number;
  /**
   * Only errors with one of these HTTP status codes are retried or fall back
   * (read from `status`, `statusCode` or `response.status`). Default: any error.
   */
  onStatusCodes?: number[];
  /** Per-attempt timeout; a timed-out attempt counts as a failure. Default: none. */
  timeoutMs?: number;
};

export type LlmRoutingTarget = {
  profile: string;
  /** Relative share of calls. Default 1. */
  weight?: number;
};

export type ComponentRouting = {
  /** Profile used as primary for this component. */
  profile: string;
  /**
   * Single fallback profile, tried only on thrown errors from the primary.
   * Kept as an alias: it is treated as the first entry of `fallbacks`.
   */
  fallback?: string;
  /** Ordered fallback chain, tried in order after the primary fails. */
  fallbacks?: string[];
  /** Retry policy applied to each target before moving to the next. */
  retry?: LlmRetryPolicy;
  /**
   * Weighted primaries: each call picks one target by weight. Must include
   * `profile`. Applied only by routers given `withLoadBalance`.
   */
  loadBalance?: LlmRoutingTarget[];
  /**
   * Capabilities this component needs. Checked at load against every profile
   * it can route to (primary, load-balance targets, fallbacks) that declares
   * `capabilities`.
   */
  requires?: string[];
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
): ResolvedComponentRouting | null {
  const profilesByName = new Map(config.profiles.map((p) => [p.name, p]));
  const routing = config.components?.[componentId];

  const primaryName = routing?.profile ?? config.defaultProfile;
  const primary = profilesByName.get(primaryName);
  if (!primary) return null;

  const fallbacks = fallbackNames(routing)
    .map((name) => profilesByName.get(name))
    .filter((p): p is LlmProfile => p !== undefined);

  const resolved: ResolvedComponentRouting = { primary, fallback: fallbacks[0] ?? null, fallbacks };
  if (routing?.retry) resolved.retry = routing.retry;
  if (routing?.loadBalance) {
    const targets = routing.loadBalance
      .map((t) => ({ profile: profilesByName.get(t.profile), weight: t.weight ?? 1 }))
      .filter((t): t is { profile: LlmProfile; weight: number } => t.profile !== undefined);
    if (targets.length > 0) resolved.loadBalance = targets;
  }
  return resolved;
}

export type ResolvedComponentRouting = {
  primary: LlmProfile;
  /** First fallback, or null. Same as `fallbacks[0]`; kept for existing callers. */
  fallback: LlmProfile | null;
  /** Ordered fallback chain (`fallback` alias first, duplicates removed). */
  fallbacks: LlmProfile[];
  retry?: LlmRetryPolicy;
  /** Weighted primaries (weights default to 1). Includes `primary`. */
  loadBalance?: Array<{ profile: LlmProfile; weight: number }>;
};

/** `fallback` alias first, then `fallbacks`, without duplicates or the primary. */
function fallbackNames(routing: ComponentRouting | undefined): string[] {
  if (!routing) return [];
  const names = [...(routing.fallback ? [routing.fallback] : []), ...(routing.fallbacks ?? [])];
  return [...new Set(names)].filter((name) => name !== routing.profile);
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
    const validated: LlmProfile = {
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
    };
    const capabilities = validateCapabilities(profile["capabilities"], name, report);
    if (capabilities) validated.capabilities = capabilities;
    const pricing = validatePricing(profile["pricing"], name, report);
    if (pricing) validated.pricing = pricing;
    validatedProfiles.push(validated);
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
      const validated: ComponentRouting = { profile };
      if (fallback !== undefined && (typeof fallback !== "string" || !profileNames.has(fallback))) {
        report(`component "${componentId}" references unknown fallback "${String(fallback)}"; dropping fallback.`);
      } else if (typeof fallback === "string") {
        validated.fallback = fallback;
      }
      const fallbacks = validateFallbacks(r["fallbacks"], componentId, profileNames, report);
      if (fallbacks) validated.fallbacks = fallbacks;
      const retry = validateRetry(r["retry"], componentId, report);
      if (retry) validated.retry = retry;
      const loadBalance = validateLoadBalance(r["loadBalance"], componentId, profile, profileNames, report);
      if (loadBalance) validated.loadBalance = loadBalance;
      const requires = validateRequires(r["requires"], componentId, report);
      if (requires) {
        validated.requires = requires;
        checkRequiredCapabilities(validated, componentId, validatedProfiles, report);
      }
      validatedComponents[componentId] = validated;
    }
  }

  return {
    profiles: validatedProfiles,
    defaultProfile,
    ...(validatedComponents ? { components: validatedComponents } : {}),
  };
}

// ---------------------------------------------------------------------------
// Field validators. Each reports a problem and returns undefined for a bad
// value (non-strict: the field is dropped; strict: `report` throws).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCapabilities(raw: unknown, profileName: string, report: Reporter): LlmCapabilities | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || Object.values(raw).some((v) => typeof v !== "boolean")) {
    report(`profile "${profileName}" "capabilities" must be an object of booleans; ignoring it.`);
    return undefined;
  }
  return { ...(raw as Record<string, boolean>) };
}

function validatePricing(raw: unknown, profileName: string, report: Reporter): LlmPricing | undefined {
  if (raw === undefined) return undefined;
  const rate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (
    !isPlainObject(raw) ||
    !rate(raw["input"]) ||
    !rate(raw["output"]) ||
    (raw["cacheRead"] !== undefined && !rate(raw["cacheRead"])) ||
    (raw["cacheWrite"] !== undefined && !rate(raw["cacheWrite"]))
  ) {
    report(
      `profile "${profileName}" "pricing" needs non-negative numbers for input and output (cacheRead/cacheWrite optional), in USD per million tokens; ignoring it.`,
    );
    return undefined;
  }
  const pricing: LlmPricing = { input: raw["input"] as number, output: raw["output"] as number };
  if (raw["cacheRead"] !== undefined) pricing.cacheRead = raw["cacheRead"] as number;
  if (raw["cacheWrite"] !== undefined) pricing.cacheWrite = raw["cacheWrite"] as number;
  return pricing;
}

function validateFallbacks(
  raw: unknown,
  componentId: string,
  profileNames: Set<string>,
  report: Reporter,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    report(`component "${componentId}" "fallbacks" must be an array of profile names; ignoring it.`);
    return undefined;
  }
  const kept: string[] = [];
  for (const name of raw) {
    if (typeof name !== "string" || !profileNames.has(name)) {
      report(`component "${componentId}" references unknown fallback "${String(name)}"; dropping it.`);
      continue;
    }
    kept.push(name);
  }
  return kept.length > 0 ? kept : undefined;
}

function validateRetry(raw: unknown, componentId: string, report: Reporter): LlmRetryPolicy | undefined {
  if (raw === undefined) return undefined;
  const bad = (why: string) => {
    report(`component "${componentId}" "retry" ${why}; ignoring retry.`);
    return undefined;
  };
  if (!isPlainObject(raw)) return bad("must be an object");
  const count = (v: unknown, min: number) => v === undefined || (Number.isInteger(v) && (v as number) >= min);
  if (!count(raw["maxAttempts"], 1)) return bad("maxAttempts must be an integer >= 1");
  if (!count(raw["backoffMs"], 0)) return bad("backoffMs must be an integer >= 0");
  if (!count(raw["maxBackoffMs"], 0)) return bad("maxBackoffMs must be an integer >= 0");
  if (!count(raw["timeoutMs"], 1)) return bad("timeoutMs must be an integer >= 1");
  const codes = raw["onStatusCodes"];
  if (codes !== undefined && (!Array.isArray(codes) || !codes.every((c) => Number.isInteger(c)))) {
    return bad("onStatusCodes must be an array of integers");
  }
  const retry: LlmRetryPolicy = {};
  for (const key of ["maxAttempts", "backoffMs", "maxBackoffMs", "timeoutMs"] as const) {
    if (raw[key] !== undefined) retry[key] = raw[key] as number;
  }
  if (codes !== undefined) retry.onStatusCodes = [...(codes as number[])];
  return retry;
}

function validateLoadBalance(
  raw: unknown,
  componentId: string,
  primary: string,
  profileNames: Set<string>,
  report: Reporter,
): LlmRoutingTarget[] | undefined {
  if (raw === undefined) return undefined;
  const bad = (why: string) => {
    report(`component "${componentId}" "loadBalance" ${why}; ignoring loadBalance.`);
    return undefined;
  };
  if (!Array.isArray(raw) || raw.length === 0) return bad("must be a non-empty array of { profile, weight? }");
  const targets: LlmRoutingTarget[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry["profile"] !== "string") return bad("entries need a profile name");
    const name = entry["profile"];
    if (!profileNames.has(name)) return bad(`references unknown profile "${name}"`);
    if (seen.has(name)) return bad(`lists "${name}" twice`);
    const weight = entry["weight"];
    if (weight !== undefined && !(typeof weight === "number" && Number.isFinite(weight) && weight > 0)) {
      return bad(`weight for "${name}" must be a positive number`);
    }
    seen.add(name);
    targets.push(weight === undefined ? { profile: name } : { profile: name, weight });
  }
  if (!seen.has(primary)) return bad(`must include the component's profile "${primary}"`);
  return targets;
}

function validateRequires(raw: unknown, componentId: string, report: Reporter): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && c !== "")) {
    report(`component "${componentId}" "requires" must be an array of capability names; ignoring it.`);
    return undefined;
  }
  return raw.length > 0 ? [...(raw as string[])] : undefined;
}

/**
 * Check every profile the component can route to against `requires`. Only
 * profiles that declare `capabilities` are checked (a missing key counts as
 * false). A fallback that lacks a capability is dropped; a primary or
 * load-balance target that lacks one is reported and kept.
 */
function checkRequiredCapabilities(
  routing: ComponentRouting,
  componentId: string,
  profiles: LlmProfile[],
  report: Reporter,
): void {
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const missing = (name: string): string[] => {
    const capabilities = byName.get(name)?.capabilities;
    if (!capabilities) return [];
    return (routing.requires ?? []).filter((c) => capabilities[c] !== true);
  };

  const primaries = [routing.profile, ...(routing.loadBalance ?? []).map((t) => t.profile)];
  for (const name of new Set(primaries)) {
    const lacking = missing(name);
    if (lacking.length > 0) {
      report(`component "${componentId}" requires ${lacking.join(", ")} but profile "${name}" does not declare it.`);
    }
  }

  const decided = new Map<string, boolean>();
  const keep = (name: string): boolean => {
    const known = decided.get(name);
    if (known !== undefined) return known;
    const lacking = missing(name);
    if (lacking.length > 0) {
      report(
        `component "${componentId}" requires ${lacking.join(", ")} but fallback "${name}" does not declare it; dropping that fallback.`,
      );
    }
    decided.set(name, lacking.length === 0);
    return lacking.length === 0;
  };
  if (routing.fallback !== undefined && !keep(routing.fallback)) delete routing.fallback;
  if (routing.fallbacks) {
    const kept = routing.fallbacks.filter(keep);
    if (kept.length > 0) routing.fallbacks = kept;
    else delete routing.fallbacks;
  }
}
