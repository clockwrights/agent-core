// ---------------------------------------------------------------------------
// Pipeline Defaults — env-driven configuration for per-request fallbacks
//
// Per-request overrides win in this priority order:
//
//   1. Query string / programmatic `request.<field>`
//   2. Environment variable (read once at boot via `loadPipelineDefaults`)
//   3. Built-in defaults (`BUILT_IN_DEFAULTS`)
//
// Validation: invalid env values are logged as warnings and silently fall
// back to the built-in default for that field. The pipeline never refuses
// to start because of a bad env var — it just runs with sane defaults.
//
// Environment variables read:
//   LLM_DEFAULT_EXECUTION_MODE    deterministic-first | hybrid | full-multimodal
//   LLM_DEFAULT_TIER_A_THRESHOLD  number in [0, 1]
//   LLM_DEFAULT_TIER_B_THRESHOLD  number in [0, 1]
//   LLM_DEFAULT_MIN_TIER          tier-a | tier-b | tier-c
// ---------------------------------------------------------------------------

import type {
  ClassificationTier,
  DocumentPipelineExecutionMode,
} from "./types.js";

/**
 * Default values for per-request fields that the route applies when the
 * caller has not specified a value. Read from environment at server boot.
 */
export type PipelineDefaults = {
  executionMode: DocumentPipelineExecutionMode;
  /** Min Tier-A confidence to short-circuit the pipeline. */
  tierAThreshold: number;
  /** Min Tier-B confidence to skip Tier C. */
  tierBThreshold: number;
  /**
   * Minimum tier the classifier may attempt. Tiers below this are skipped.
   * - "tier-a" (default): full A → B → C cascade
   * - "tier-b": skip Tier A entirely, force LLM
   * - "tier-c": skip A and B, go straight to multimodal LLM
   */
  minTier: ClassificationTier;
  /** Field citations on by default (`LLM_DEFAULT_FIELD_CITATIONS`). Absent: off. */
  fieldCitations?: boolean;
};

export const BUILT_IN_DEFAULTS: PipelineDefaults = {
  executionMode: "hybrid",
  tierAThreshold: 0.8,
  tierBThreshold: 0.6,
  minTier: "tier-a",
};

const VALID_MODES: DocumentPipelineExecutionMode[] = [
  "deterministic-first",
  "hybrid",
  "full-multimodal",
];
const VALID_TIERS: ClassificationTier[] = ["tier-a", "tier-b", "tier-c"];

/**
 * Read pipeline defaults from process environment.
 *
 * Pass a custom `env` for testing.
 */
export function loadPipelineDefaults(
  env: NodeJS.ProcessEnv = process.env,
): PipelineDefaults {
  const fieldCitations = parseBoolean(env["LLM_DEFAULT_FIELD_CITATIONS"], "LLM_DEFAULT_FIELD_CITATIONS");
  return {
    executionMode:
      parseMode(env["LLM_DEFAULT_EXECUTION_MODE"]) ??
      BUILT_IN_DEFAULTS.executionMode,
    tierAThreshold:
      parseThreshold(
        env["LLM_DEFAULT_TIER_A_THRESHOLD"],
        "LLM_DEFAULT_TIER_A_THRESHOLD",
      ) ?? BUILT_IN_DEFAULTS.tierAThreshold,
    tierBThreshold:
      parseThreshold(
        env["LLM_DEFAULT_TIER_B_THRESHOLD"],
        "LLM_DEFAULT_TIER_B_THRESHOLD",
      ) ?? BUILT_IN_DEFAULTS.tierBThreshold,
    minTier:
      parseTier(env["LLM_DEFAULT_MIN_TIER"]) ?? BUILT_IN_DEFAULTS.minTier,
    ...(fieldCitations !== undefined ? { fieldCitations } : {}),
  };
}

// ---------------------------------------------------------------------------
// Parsers — return undefined on invalid/missing input (caller falls back)
// ---------------------------------------------------------------------------

function parseMode(
  raw: string | undefined,
): DocumentPipelineExecutionMode | undefined {
  if (raw === undefined || raw === "") return undefined;
  if ((VALID_MODES as readonly string[]).includes(raw)) {
    return raw as DocumentPipelineExecutionMode;
  }
  console.warn(
    `[pipeline-config] LLM_DEFAULT_EXECUTION_MODE="${raw}" is not one of ${VALID_MODES.join(
      ", ",
    )}; using built-in default "${BUILT_IN_DEFAULTS.executionMode}".`,
  );
  return undefined;
}

function parseThreshold(
  raw: string | undefined,
  fieldName: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(
      `[pipeline-config] ${fieldName}="${raw}" is not a number in [0, 1]; using built-in default.`,
    );
    return undefined;
  }
  return n;
}

function parseBoolean(raw: string | undefined, fieldName: string): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  console.warn(`[pipeline-config] ${fieldName}="${raw}" is not true/false/1/0; using built-in default.`);
  return undefined;
}

function parseTier(raw: string | undefined): ClassificationTier | undefined {
  if (raw === undefined || raw === "") return undefined;
  if ((VALID_TIERS as readonly string[]).includes(raw)) {
    return raw as ClassificationTier;
  }
  console.warn(
    `[pipeline-config] LLM_DEFAULT_MIN_TIER="${raw}" is not one of ${VALID_TIERS.join(
      ", ",
    )}; using built-in default "${BUILT_IN_DEFAULTS.minTier}".`,
  );
  return undefined;
}
