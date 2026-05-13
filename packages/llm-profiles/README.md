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
  resolveComponentRouting,
  createLlmRouter,
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
};

type ComponentRouting = {
  profile: string;           // primary profile name
  fallback?: string;         // optional fallback profile name
};

type LlmRoutingConfig = {
  profiles: LlmProfile[];
  defaultProfile: string;    // must reference a profile name
  components?: Record<string, ComponentRouting>;
};
```

`thinkingLevel` is intentionally `string` rather than a closed union — keeps the schema runtime-agnostic. Apps narrow to their concrete enum when converting.

### Loader

```ts
function loadLlmRoutingConfig(opts?: {
  filePath?: string;                                // default "config/llm-profiles.json" (resolved against process CWD)
  env?: NodeJS.ProcessEnv;                          // default process.env
  readFile?: (path: string) => string | undefined;  // overridable for tests
}): LlmRoutingConfig | null;
```

Priority:

1. `config/llm-profiles.json` (or whatever `filePath` you supply), if present.
2. `LLM_PROFILES_JSON` env var (raw JSON string).
3. Returns `null` — caller should fall back to a single-LLM path.

`${ENV_VAR}` interpolation: any string of the form `${NAME}` is replaced with `process.env.NAME` at load time. Missing env vars produce a warning and an empty string; downstream provider construction may then fail loudly at first use.

Validation problems (missing `defaultProfile`, dangling component references, malformed JSON, missing required fields on a profile, duplicate profile names) produce a `console.warn` and the loader returns `null` — the consumer falls back to its single-LLM path rather than failing.

### Component resolution

```ts
function resolveComponentRouting(
  config: LlmRoutingConfig,
  componentId: string,
): { primary: LlmProfile; fallback: LlmProfile | null } | null;
```

Returns the explicit component routing if present, otherwise falls back to `defaultProfile`. Returns `null` only if neither resolves (caller should treat as misconfiguration).

### Generic router

```ts
function createLlmRouter<P>(
  config: LlmRoutingConfig,
  options: {
    factory: (profile: LlmProfile) => P;
    withFailover?: (primary: P, fallback: P) => P;
  },
): LlmRouter<P>;

type LlmRouter<P> = {
  forComponent(componentId: string): P;
};
```

- `factory` constructs a `P` (your app's provider type) from a profile. Memoised per profile name — one call per unique profile, even when many components share it.
- `withFailover` wraps `(primary, fallback)` only when the component declares a `fallback`. Apps decide failover semantics for *their* provider interface (which methods to wrap, what counts as failure). Omit it and components with a fallback still receive only the primary instance.

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

## License

MIT.

## Provenance

Assembled through a delightfully rogue mix of AI tools and automation. Humans mostly appeared for testing, verification, and strategic eyebrow-raising.
