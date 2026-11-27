/**
 * "inherit" context mode: the child continues from the parent's real model
 * request (same tools, system prompt, session id and messages), so the
 * provider's prompt cache serves everything up to the delegating turn.
 *
 * Reusability: domain-neutral. The parent request comes from the runtime's
 * tool execution context; which parent tools the child may run comes from
 * the parent's registered tool metadata and the child's preset policy.
 */

import type { ToolExecutionContext } from "@maya-ai/tool-agent-runtime";
import { resolveTools, type RegisteredTool, type ToolPolicy } from "@maya-ai/agent-loop-core";
import type { InheritedParentRequest } from "./orchestrationTypes.js";

/** Names of the delegation tools; an inherit child may never run them. */
export const DELEGATION_TOOL_NAMES: readonly string[] = ["delegate_task", "delegate_tasks"];

/** Turns on `contextMode: "inherit"` for a delegate tool. */
export interface InheritModeOptions {
  /**
   * The parent's registered tools, with risk / source metadata. The child is
   * shown all of the parent's tools (the cache needs the same list) but may
   * run only those its preset policy allows, never the delegation tools.
   * Omitted: the child may run none of them.
   */
  parentTools?: readonly RegisteredTool[];
}

/** Description of the "inherit" value added to the `contextMode` parameter. */
export const INHERIT_CONTEXT_MODE_DESCRIPTION =
  "inherit: the delegate continues from this conversation (cheapest when it needs most of what you know; use isolated for independent checks).";

/**
 * The parent request an inherit child replays, from the delegate tool's
 * execution context. `undefined` when the tool was not run by the runtime
 * or the call has no model request (a pending call resumed from saved state).
 */
export function inheritedRequestFromContext(
  context: ToolExecutionContext | undefined
): InheritedParentRequest | undefined {
  const request = context?.request;
  if (!request) return undefined;
  const inherited: InheritedParentRequest = {
    systemPrompt: request.systemPrompt,
    tools: request.tools,
    messages: request.messages,
    modelId: request.model.id
  };
  if (context.sessionId !== undefined) inherited.sessionId = context.sessionId;
  if (request.reasoning !== undefined) inherited.reasoning = request.reasoning;
  return inherited;
}

/** Parent tool names an inherit child may run under `policy`. */
export function inheritAllowedToolNames(
  parentTools: readonly RegisteredTool[] | undefined,
  policy: ToolPolicy
): Set<string> {
  if (!parentTools || parentTools.length === 0) return new Set();
  const allowed = new Set(resolveTools([...parentTools], policy).map((tool) => tool.name));
  for (const name of DELEGATION_TOOL_NAMES) allowed.delete(name);
  return allowed;
}
