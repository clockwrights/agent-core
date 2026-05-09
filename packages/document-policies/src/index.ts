// ---------------------------------------------------------------------------
// document-policies — reusable policy manifest + loader.
//
// Sibling to `agent-loop/core/`, `document-pipeline/`, and `llm-profiles/`:
// fully reusable, zero imports from outside this directory. Apps consume
// the emitted `LoadedPolicy[]` and glue it into their own policy registry
// (e.g. `DocumentPolicyRegistry` from `document-pipeline/`).
// ---------------------------------------------------------------------------

export type {
  PolicyManifestEntry,
  DocumentPoliciesManifest,
  LoadManifestOptions,
} from "./manifest.js";
export { loadPoliciesManifest, DocumentPoliciesConfigError } from "./manifest.js";

export type {
  LoadedPolicy,
  LoadPoliciesOptions,
  LoadConfiguredPoliciesOptions,
} from "./loader.js";
export { loadPolicies, loadConfiguredPolicies } from "./loader.js";
