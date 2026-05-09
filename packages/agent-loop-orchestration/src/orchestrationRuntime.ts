/**
 * Child-scoped runtime construction.
 *
 * `createChildRuntimeContext` builds an `AgentRuntimeContext` for one child
 * run. Phase 1 disables MCP / memory / skills by default — the consumer can
 * widen this later via `ChildRuntimeOptions`. The tool policy comes from
 * the policy preset on the request, narrowed by `PresetOverrides` if the
 * consumer supplied any.
 *
 * Reusability: domain-neutral. Consumers that need richer child runtimes
 * (e.g. their own memory store) supply the runtime through
 * `runtimeFactory` on `ExecuteChildRunInput` rather than reaching in here.
 */

import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import { createAgentRuntimeContextFromConfig } from "@maya-ai/agent-loop-core";
import { resolveTools, type ToolPolicy } from "@maya-ai/agent-loop-core";
import {
  resolveToolPolicyForPreset,
  type PresetOverrides
} from "./orchestrationPolicy.js";
import type { ChildRunRequest } from "./orchestrationTypes.js";

export const DEFAULT_CHILD_PRESET = "read_only_research";

export interface ChildRuntimeOptions {
  /** Optional consumer-supplied overrides for `resolveToolPolicyForPreset`. */
  presetOverrides?: PresetOverrides;
  /**
   * Optional override for the resolved tool policy. When supplied, this
   * replaces the preset-derived policy entirely. Use with care — bypasses
   * the preset-based source gates.
   */
  toolPolicyOverride?: ToolPolicy;
}

export async function createChildRuntimeContext(input: {
  request: ChildRunRequest;
  options?: ChildRuntimeOptions;
}): Promise<AgentRuntimeContext> {
  const presetName = input.request.profile?.toolPolicyPreset ?? DEFAULT_CHILD_PRESET;
  const toolPolicy =
    input.options?.toolPolicyOverride ??
    resolveToolPolicyForPreset(presetName, input.options?.presetOverrides);

  return createAgentRuntimeContextFromConfig({
    mcp: undefined,
    memory: { enabled: false },
    skills: { enabled: false, roots: [] },
    toolPolicy
  });
}

export function buildChildTools(runtime: AgentRuntimeContext): AgentTool<any>[] {
  return resolveTools(runtime.toolDefinitions, runtime.toolPolicy);
}
