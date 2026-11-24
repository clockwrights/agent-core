// ---------------------------------------------------------------------------
// llm-profiles — reusable LLM profile config + generic router.
//
// This module is sibling to `agent-loop/core/` and `document-pipeline/`:
// fully reusable across apps, zero imports from outside the directory.
// Apps supply their own provider factory and (optionally) a failover wrapper
// for their own provider interface.
// ---------------------------------------------------------------------------

export type {
  LlmProfile,
  LlmCapabilities,
  LlmPricing,
  LlmRetryPolicy,
  LlmRoutingTarget,
  ComponentRouting,
  ResolvedComponentRouting,
  LlmRoutingConfig,
  LoadLlmRoutingOptions,
} from "./profiles.js";
export { LlmProfilesConfigError, loadLlmRoutingConfig, resolveComponentRouting } from "./profiles.js";

export { REDACTED, redactProfile, createSecretRedactor } from "./redact.js";

export type { LlmRouter, CreateLlmRouterOptions, FallbackContext } from "./router.js";
export { createLlmRouter } from "./router.js";

export type { AsyncFn, FailoverAttempt, CreateFailoverOptions, WeightedTarget } from "./failover.js";
export {
  createFailover,
  createLoadBalancer,
  pickWeighted,
  getErrorStatus,
  FailoverTimeoutError,
} from "./failover.js";
