# @maya-ai/llm-profiles

Multi-LLM routing made reusable. Defines the profile config schema, a file-and-env loader with `${ENV_VAR}` interpolation, component-id resolution, and a generic memoising router. Provider construction and failover wrapping are supplied by the consumer app — the package is provider-agnostic.

Zero runtime dependencies beyond Node built-ins (`node:fs`, `node:path`).

## Install

```bash
npm install @maya-ai/llm-profiles
```

---

## Why this component exists

Many apps end up wanting to send *different* LLM calls to *different* models — a fast cheap text model for one subsystem, a multimodal model for another, a stronger reasoning model for a third — sometimes with failover when the primary errors. This component packages the common parts (config schema, validation, env interpolation, component lookup, per-profile memoisation) so a second app doesn't reinvent them.

What's reusable lives here. What's app-specific (provider construction, the failover wrapper for *your* provider interface) stays in the consumer app.

---

## Public API

```ts
import {
  loadLlmRoutingConfig,
  LlmProfilesConfigError,
  resolveComponentRouting,
  createLlmRouter,
  redactProfile,
  createSecretRedactor,
  createFailover,
  createLoadBalancer,
  pickWeighted,
  type LlmProfile,
  type LlmRoutingConfig,
  type LlmRouter,
} from "@maya-ai/llm-profiles";
```

### Types

```ts
type LlmProfile = {
  name: string;
  provider: string;          // e.g. "openai", "anthropic", or any app-defined label
  model: string;
  apiKey?: string;           // may be "${ENV_VAR}"
  baseUrl?: string;
  thinkingLevel?: string;    // loose string — apps narrow when needed
  maxTokens?: number;
  contextWindow?: number;
  capabilities?: { vision?: boolean; documents?: boolean; tools?: boolean; reasoning?: boolean; [k: string]: boolean | undefined };
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; // USD per million tokens
};

type ComponentRouting = {
  profile: string;           // primary profile name
  fallback?: string;         // optional fallback profile name (alias: first entry of `fallbacks`)
  fallbacks?: string[];      // ordered fallback chain
  retry?: {                  // applied to each target before moving to the next
    maxAttempts?: number;    // total attempts per target, default 1
    backoffMs?: number;      // first retry delay, doubles per retry, default 0
    maxBackoffMs?: number;
    onStatusCodes?: number[];// only these HTTP statuses retry/fall back; default: any error
    timeoutMs?: number;      // per attempt
  };
  loadBalance?: { profile: string; weight?: number }[]; // weighted primaries; must include `profile`
  requires?: string[];       // capabilities checked at load time
};

type LlmRoutingConfig = {
  profiles: LlmProfile[];
  defaultProfile: string;    // must reference a profile name
  components?: Record<string, ComponentRouting>;
};
```

`thinkingLevel` is intentionally `string` rather than a closed union — keeps the schema runtime-agnostic. Apps narrow to their concrete enum when converting.

All routing fields beyond `profile` and `fallback` are optional; configs without them load and route exactly as before. Invalid values are dropped with a warning (or throw with `strict: true`).

**Capabilities and `requires`.** A component can list the capabilities it needs (`"requires": ["vision"]`). At load time every profile it can route to — primary, `loadBalance` targets, fallbacks — is checked, but only if that profile declares `capabilities` (a missing key counts as `false`). A fallback that lacks a capability is dropped; a primary or load-balance target is reported and kept. In strict mode any mismatch throws.

**Pricing.** `pricing` uses the same keys and units as pi-ai's `Model.cost` (USD per million tokens). It is not a second cost calculator: copy it onto the pi-ai model you build (useful for custom or self-hosted models pi-ai has no rates for), and pi-ai keeps computing `usage.cost`, which the runtime aggregates.

### Loader

```ts
function loadLlmRoutingConfig(opts?: {
  filePath?: string;                                // default "config/llm-profiles.json" (resolved against process CWD)
  env?: NodeJS.ProcessEnv;                          // default process.env
  readFile?: (path: string) => string | undefined;  // overridable for tests
  strict?: boolean;                                 // throw LlmProfilesConfigError instead of warning (default false)
}): LlmRoutingConfig | null;
```

Priority:

1. `config/llm-profiles.json` (or whatever `filePath` you supply), if present.
2. `LLM_PROFILES_JSON` env var (raw JSON string).
3. Returns `null` — caller should fall back to a single-LLM path.

Env interpolation: a config string that is *exactly* one of these forms is replaced at load time (strings that merely contain `${…}` are left as is):

| Form | Result |
|---|---|
| `${NAME}` | Value of `NAME`. Unset → empty string and a warning (downstream provider construction may then fail at first use). |
| `${NAME:-default}` | Value of `NAME`, or `default` when `NAME` is unset or empty. No warning. |
| `${NAME:?message}` | Value of `NAME`. Unset or empty → configuration error with `message`: the config is ignored (`null`) after a warning, or `LlmProfilesConfigError` in strict mode. |

Validation problems (missing `defaultProfile`, dangling component references, malformed JSON, missing required fields on a profile, duplicate profile names) produce a `console.warn` and the loader returns `null` — the consumer falls back to its single-LLM path rather than failing. Smaller problems (an unknown component profile or fallback, a malformed or duplicate profile entry) drop just that item.

**Strict mode** — `loadLlmRoutingConfig({ strict: true })` throws `LlmProfilesConfigError` (with `source` set to the file path or `"LLM_PROFILES_JSON"`) for every one of those problems, including an unset `${NAME}`, instead of warning and degrading. Use it in production so a broken config fails at startup rather than silently falling back. A missing config (no file and no env var) still returns `null`.

Warnings never contain secrets: a rejected profile is described by its index, name and missing fields (never the object itself), and a JSON parse failure is reported by line/column only, because the raw `SyntaxError` message quotes a snippet of the input.

### Redaction helpers

Profiles returned by the loader hold real credentials. Use these before logging profiles or forwarding provider errors, events or trace attributes:

```ts
function redactProfile(profile: LlmProfile): LlmProfile;
// copy with apiKey → "[REDACTED]" and user:password@ in baseUrl redacted; input unchanged

function createSecretRedactor(source: LlmRoutingConfig | LlmProfile[]): (text: string) => string;
// replaces every configured API key and baseUrl credential found in `text` with "[REDACTED]"
```

```ts
const redact = createSecretRedactor(config);
try { await provider.call(...) } catch (err) { log.error(redact(String(err))); }
```

### Component resolution

```ts
function resolveComponentRouting(
  config: LlmRoutingConfig,
  componentId: string,
): {
  primary: LlmProfile;
  fallback: LlmProfile | null;        // = fallbacks[0], kept for existing callers
  fallbacks: LlmProfile[];            // `fallback` first, then `fallbacks`, duplicates and the primary removed
  retry?: LlmRetryPolicy;
  loadBalance?: { profile: LlmProfile; weight: number }[];
} | null;
```

Returns the explicit component routing if present, otherwise falls back to `defaultProfile`. Returns `null` only if neither resolves (caller should treat as misconfiguration).

### Generic router

```ts
function createLlmRouter<P>(
  config: LlmRoutingConfig,
  options: {
    factory: (profile: LlmProfile) => P;
    withFailover?: (primary: P, fallback: P) => P;
    withFallbacks?: (primary: P, fallbacks: P[], context: { componentId: string; retry?: LlmRetryPolicy; profiles: LlmProfile[] }) => P;
    withLoadBalance?: (targets: { provider: P; weight: number; profile: LlmProfile }[]) => P;
  },
): LlmRouter<P>;

type LlmRouter<P> = {
  forComponent(componentId: string): P;
};
```

- `factory` constructs a `P` (your app's provider type) from a profile. Memoised per profile name — one call per unique profile, even when many components share it.
- `withFailover` wraps `(primary, fallback)` only when the component declares a `fallback`. Apps decide failover semantics for *their* provider interface (which methods to wrap, what counts as failure). Omit it and components with a fallback still receive only the primary instance. With one fallback the call is exactly as before; with several `fallbacks` it is chained right to left: `withFailover(primary, withFailover(fb1, fb2))`.
- `withFallbacks` (optional) wraps the whole chain at once and also receives `retry`; it takes precedence over `withFailover` and is called when the component has fallbacks or a `retry` policy.
- `withLoadBalance` (optional) wraps the `loadBalance` targets into one provider, which then acts as the primary of the chain. Without it, `loadBalance` is ignored.

---

## Configuration sources

| Source | Precedence | When to use |
|---|---|---|
| `config/llm-profiles.json` | 1 (highest) | Local development, self-hosted servers. Use `${ENV_VAR}` interpolation to keep API keys out of the file. |
| `LLM_PROFILES_JSON` env var (raw JSON string) | 2 | Containerised deployments where mounting a config file is awkward. |
| _(neither)_ | 3 | Loader returns `null`; caller falls back to its legacy single-LLM path. |

---

## Example: end-to-end

`config/llm-profiles.json`:

```json
{
  "profiles": [
    { "name": "primary",   "provider": "openai",    "model": "gpt-5.2",           "apiKey": "${OPENAI_API_KEY}" },
    { "name": "vision",    "provider": "anthropic", "model": "claude-sonnet-4.7", "apiKey": "${ANTHROPIC_API_KEY}" },
    { "name": "fast-text", "provider": "together",  "model": "deepseek-v4-pro",   "apiKey": "${TOGETHER_API_KEY}", "baseUrl": "https://api.together.xyz/v1" }
  ],
  "defaultProfile": "primary",
  "components": {
    "main-agent":               { "profile": "primary" },
    "document-pipeline":        { "profile": "fast-text", "fallback": "primary" },
    "document-pipeline.tier-c": { "profile": "vision",    "fallback": "primary" }
  }
}
```

Bootstrap example (in your consumer app):

```ts
const config = loadLlmRoutingConfig();
if (!config) {
  // legacy single-LLM path
  return createLlmProvider();
}

const router = createLlmRouter<LlmProvider>(config, {
  factory: (profile) => createLlmProvider(profileToRuntimeConfig(profile)),
  withFailover: (primary, fallback) => new RoutingLlmProvider(primary, fallback),
});

const mainLlm       = router.forComponent("main-agent");
const pipelineLlm   = router.forComponent("document-pipeline");
const pipelineTierC = router.forComponent("document-pipeline.tier-c");
```

Component identifiers are app-defined — strings in the config — so a different app uses whatever taxonomy makes sense for its subsystems.

---

## Failover semantics

The router calls `withFailover(primary, fallback)` once per component. **What counts as a failure is up to the wrapper.** A simple wrapper that catches thrown errors might be enough; an app that also wants to retry on empty / low-confidence responses supplies a richer wrapper without touching this package.

Provider construction is memoised per profile name, so multiple components pointing at the same profile share one underlying client.

### Ready-made helpers

Most apps write the same wrapper, so the package ships dependency-free helpers that work on plain async functions — wrap the one method that calls the model:

```ts
import { createFailover, createLoadBalancer, createLlmRouter } from "@maya-ai/llm-profiles";

type Generate = (req: Request) => Promise<Response>;

const router = createLlmRouter<Generate>(config, {
  factory: (profile) => makeGenerate(profile),
  withLoadBalance: (targets) => createLoadBalancer(targets.map((t) => ({ target: t.provider, weight: t.weight }))),
  withFallbacks: (primary, fallbacks, { retry }) =>
    createFailover(primary, fallbacks, { retry, onAttemptFailed: (a) => log.warn(a) }),
});
```

- `createFailover(primary, fallbacks, { retry?, shouldFallback?, onAttemptFailed?, sleep? })` tries the primary, retries per `retry` (doubling `backoffMs`, capped by `maxBackoffMs`), then moves through the fallbacks in order and rethrows the last error if all fail. By default every error moves on; with `retry.onStatusCodes` only errors with those statuses do (`status`, `statusCode` or `response.status`, see `getErrorStatus`); `shouldFallback` overrides both. `retry.timeoutMs` turns a slow attempt into a `FailoverTimeoutError` (the underlying call is not cancelled).
- `pickWeighted(targets, random?)` and `createLoadBalancer(targets, random?)` pick by weight (default 1); inject `random` for deterministic tests.
- The helper is named `createFailover` so it does not clash with the router's `withFailover` option.

## License

MIT.

## Provenance

Assembled through a delightfully rogue mix of AI tools and automation. Humans mostly appeared for testing, verification, and strategic eyebrow-raising.
