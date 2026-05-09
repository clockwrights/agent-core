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
  ComponentRouting,
  LlmRoutingConfig,
  LoadLlmRoutingOptions,
} from "./profiles.js";
export { loadLlmRoutingConfig, resolveComponentRouting } from "./profiles.js";

export type { LlmRouter, CreateLlmRouterOptions } from "./router.js";
export { createLlmRouter } from "./router.js";
