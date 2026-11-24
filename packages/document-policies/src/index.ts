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

export type { PolicySeverity, PolicyFrontMatter, ParsedPolicyFile } from "./frontMatter.js";
export { parsePolicyFile, PolicyFrontMatterError, POLICY_SEVERITIES } from "./frontMatter.js";

export type {
  PolicyRule,
  PolicyEvidence,
  PolicyVerdict,
  PolicyVerdictOutcome,
  PolicyVerdictCheck,
  CheckPolicyVerdictsOptions,
} from "./rules.js";
export {
  extractPolicyRules,
  checkPolicyVerdicts,
  buildRuleCitationInstructions,
  PolicyRuleError,
  POLICY_VERDICT_OUTCOMES,
} from "./rules.js";
