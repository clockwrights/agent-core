/**
 * Orchestration policy, limits, and the preset → ToolPolicy resolver.
 *
 * Reusability rule: this module is domain-neutral. Domain-specific tool
 * names are NOT referenced here. The consumer adapter supplies them through
 * `PresetOverrides` at construction time.
 *
 * Compressed layout: limits + policy + preset resolver live together because
 * all three are configuration concerns for the orchestrator.
 */

import { defaultToolPolicy, type ToolPolicy } from "@maya-ai/agent-loop-core";
import type { ChildContextMode } from "./orchestrationTypes.js";

// ---------------------------------------------------------------------------
// Policy preset names
// ---------------------------------------------------------------------------

/**
 * Domain-neutral preset names. Consumers map these onto concrete domain
 * tools via `PresetOverrides`; orchestration itself only reasons about
 * source gates (`domain` / `mcp` / `memory` / `system`).
 */
export const TOOL_POLICY_PRESETS = [
  "read_only_research",
  "read_and_memory",
  "read_and_validation",
  "limited_write_candidate_generation"
] as const;

export type ToolPolicyPreset = (typeof TOOL_POLICY_PRESETS)[number];

// ---------------------------------------------------------------------------
// Synthesis mode
// ---------------------------------------------------------------------------

/**
 * Phase 1 ships only `"separate_call"` (a dedicated synthesis loop, no tools).
 * `"inline_tool_result"` is reserved as a Stage 16 candidate if cost or
 * latency become a problem.
 */
export type SynthesisMode = "separate_call" | "inline_tool_result";

// ---------------------------------------------------------------------------
// Orchestration policy
// ---------------------------------------------------------------------------

export interface OrchestrationPolicy {
  /** Maximum delegation depth. Phase 1 default: 1 (parent → leaf children). */
  maxDepth: number;
  /** Maximum concurrent active children for a single parent. */
  maxActiveChildrenPerParent: number;
  /** Default per-child timeout in milliseconds. */
  defaultChildTimeoutMs: number;
  /** Default child token budget. Lower than parent on purpose. */
  defaultChildTokenBudget: number;
  /** Default context-fork mode. Phase 1 default: "isolated". */
  defaultContextMode: ChildContextMode;
  /** Whether children may receive write-capable domain tools. Phase 1 default: false. */
  defaultAllowWriteTools: boolean;
  /** Whether children may apply mutations directly. Phase 1: "proposal_only". */
  defaultStateMutationMode: "proposal_only" | "direct_apply";
  /** Synthesis execution mode. Phase 1 default: "separate_call". */
  synthesisMode: SynthesisMode;
  /** Cap for child prompt size in characters. */
  maxChildPromptChars: number;
  /** Cap for `maxTokens` overrides supplied by the LLM. */
  maxChildTokens: number;
  /**
   * Maximum number of child runs executing concurrently inside a single
   * batched delegation call (`delegate_tasks`). Has no effect on the
   * single-task `delegate_task` tool, which is always sequential. The
   * plan recommends a small initial value so the parallel path is bounded
   * before observability of fan-out timings is in place.
   */
  maxConcurrentChildren: number;
  /**
   * Cap on the number of tasks per `delegate_tasks` call. Defaults to
   * `maxActiveChildrenPerParent`. Larger batches are rejected at the
   * tool boundary.
   */
  maxBatchTasks: number;
}

export const DEFAULT_ORCHESTRATION_POLICY: OrchestrationPolicy = {
  maxDepth: 1,
  maxActiveChildrenPerParent: 3,
  defaultChildTimeoutMs: 120_000,
  defaultChildTokenBudget: 800,
  defaultContextMode: "isolated",
  defaultAllowWriteTools: false,
  defaultStateMutationMode: "proposal_only",
  synthesisMode: "separate_call",
  maxChildPromptChars: 16_000,
  maxChildTokens: 4_000,
  maxConcurrentChildren: 2,
  maxBatchTasks: 3
};

// ---------------------------------------------------------------------------
// Limit-check helpers
// ---------------------------------------------------------------------------

export type LimitCheckResult =
  | { ok: true }
  | { ok: false; code: "depth_exceeded" | "active_limit_exceeded"; message: string };

export function checkDepth(
  policy: OrchestrationPolicy,
  parentDepth: number
): LimitCheckResult {
  if (parentDepth >= policy.maxDepth) {
    return {
      ok: false,
      code: "depth_exceeded",
      message: `parentDepth ${parentDepth} >= maxDepth ${policy.maxDepth}`
    };
  }
  return { ok: true };
}

export function checkActiveCount(
  policy: OrchestrationPolicy,
  activeCount: number
): LimitCheckResult {
  if (activeCount >= policy.maxActiveChildrenPerParent) {
    return {
      ok: false,
      code: "active_limit_exceeded",
      message: `active children ${activeCount} >= maxActiveChildrenPerParent ${policy.maxActiveChildrenPerParent}`
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Preset → ToolPolicy resolver
// ---------------------------------------------------------------------------

/**
 * Per-preset additions to allow / deny applied on top of the domain-neutral
 * default. The consumer adapter populates this with its own domain tool
 * names. Orchestration treats the strings as opaque.
 */
export interface PresetOverrides {
  [presetName: string]: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * Resolves a preset name to a concrete `ToolPolicy`.
 *
 * Domain-neutral defaults set source gates only. The consumer supplies
 * domain-specific allow/deny entries via `overrides`.
 *
 * Unknown preset names fall through to a fully-restricted policy
 * (every source disabled). This is conservative on purpose: a typo
 * should produce a child that can't reach any tool, not one that
 * silently inherits broad access.
 */
export function resolveToolPolicyForPreset(
  preset: string,
  overrides?: PresetOverrides
): ToolPolicy {
  const base = defaultPresetBase(preset);
  const ov = overrides?.[preset];
  return {
    ...base,
    allow: [...base.allow, ...(ov?.allow ?? [])],
    deny: [...base.deny, ...(ov?.deny ?? [])]
  };
}

function defaultPresetBase(preset: string): ToolPolicy {
  switch (preset) {
    case "read_only_research":
    case "read_and_memory":
      return {
        enabled: true,
        sources: { domain: false, mcp: false, memory: true, system: true },
        allow: [],
        deny: []
      };
    case "read_and_validation":
      return {
        enabled: true,
        sources: { domain: true, mcp: false, memory: true, system: true },
        allow: [],
        deny: []
      };
    case "limited_write_candidate_generation":
      return {
        enabled: true,
        sources: { domain: true, mcp: false, memory: true, system: true },
        allow: [],
        deny: []
      };
    default:
      return {
        ...defaultToolPolicy,
        enabled: true,
        sources: { domain: false, mcp: false, memory: false, system: false },
        allow: [],
        deny: []
      };
  }
}
