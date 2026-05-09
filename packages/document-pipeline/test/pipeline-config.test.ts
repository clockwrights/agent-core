// ---------------------------------------------------------------------------
// Tests: pipeline-config — env-driven defaults
//
// Verifies that loadPipelineDefaults():
//   - returns BUILT_IN_DEFAULTS when no env vars are set
//   - parses valid env values
//   - silently falls back (with a warning) on invalid env values
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILT_IN_DEFAULTS,
  loadPipelineDefaults,
} from "../src/pipeline-config.js";

// ---------------------------------------------------------------------------
// Empty env
// ---------------------------------------------------------------------------

test("pipeline-config: empty env returns BUILT_IN_DEFAULTS", () => {
  const cfg = loadPipelineDefaults({});
  assert.deepEqual(cfg, BUILT_IN_DEFAULTS);
});

test("pipeline-config: BUILT_IN_DEFAULTS has expected values", () => {
  assert.equal(BUILT_IN_DEFAULTS.executionMode, "hybrid");
  assert.equal(BUILT_IN_DEFAULTS.tierAThreshold, 0.8);
  assert.equal(BUILT_IN_DEFAULTS.tierBThreshold, 0.6);
  assert.equal(BUILT_IN_DEFAULTS.minTier, "tier-a");
});

// ---------------------------------------------------------------------------
// Valid env values
// ---------------------------------------------------------------------------

test("pipeline-config: valid env values are parsed", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_EXECUTION_MODE: "full-multimodal",
    LLM_DEFAULT_TIER_A_THRESHOLD: "0.9",
    LLM_DEFAULT_TIER_B_THRESHOLD: "0.5",
    LLM_DEFAULT_MIN_TIER: "tier-b",
  });
  assert.equal(cfg.executionMode, "full-multimodal");
  assert.equal(cfg.tierAThreshold, 0.9);
  assert.equal(cfg.tierBThreshold, 0.5);
  assert.equal(cfg.minTier, "tier-b");
});

test("pipeline-config: each env var falls back independently", () => {
  // Only override one — the rest must keep built-in defaults.
  const cfg = loadPipelineDefaults({ LLM_DEFAULT_MIN_TIER: "tier-c" });
  assert.equal(cfg.executionMode, BUILT_IN_DEFAULTS.executionMode);
  assert.equal(cfg.tierAThreshold, BUILT_IN_DEFAULTS.tierAThreshold);
  assert.equal(cfg.tierBThreshold, BUILT_IN_DEFAULTS.tierBThreshold);
  assert.equal(cfg.minTier, "tier-c");
});

test("pipeline-config: threshold boundary values 0 and 1 are accepted", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_TIER_A_THRESHOLD: "0",
    LLM_DEFAULT_TIER_B_THRESHOLD: "1",
  });
  assert.equal(cfg.tierAThreshold, 0);
  assert.equal(cfg.tierBThreshold, 1);
});

// ---------------------------------------------------------------------------
// Invalid env values — fall back silently with a warning
// ---------------------------------------------------------------------------

test("pipeline-config: unknown executionMode falls back to default", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_EXECUTION_MODE: "lightspeed",
  });
  assert.equal(cfg.executionMode, BUILT_IN_DEFAULTS.executionMode);
});

test("pipeline-config: non-numeric threshold falls back to default", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_TIER_A_THRESHOLD: "fifty-percent",
  });
  assert.equal(cfg.tierAThreshold, BUILT_IN_DEFAULTS.tierAThreshold);
});

test("pipeline-config: out-of-range threshold falls back to default", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_TIER_A_THRESHOLD: "1.5",
    LLM_DEFAULT_TIER_B_THRESHOLD: "-0.1",
  });
  assert.equal(cfg.tierAThreshold, BUILT_IN_DEFAULTS.tierAThreshold);
  assert.equal(cfg.tierBThreshold, BUILT_IN_DEFAULTS.tierBThreshold);
});

test("pipeline-config: empty-string env values are treated as unset", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_EXECUTION_MODE: "",
    LLM_DEFAULT_TIER_A_THRESHOLD: "",
    LLM_DEFAULT_TIER_B_THRESHOLD: "",
    LLM_DEFAULT_MIN_TIER: "",
  });
  assert.deepEqual(cfg, BUILT_IN_DEFAULTS);
});

test("pipeline-config: unknown minTier falls back to default", () => {
  const cfg = loadPipelineDefaults({
    LLM_DEFAULT_MIN_TIER: "tier-zeta",
  });
  assert.equal(cfg.minTier, BUILT_IN_DEFAULTS.minTier);
});
