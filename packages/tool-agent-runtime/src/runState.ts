/**
 * Serializable run state.
 *
 * A `RunState` is the progress of a run: transcript, counters and summed
 * usage. It holds no configuration (model, tools, API keys, system prompt,
 * hooks, limits), so it is safe to persist and a resumed run may change any
 * of those. Every `agent_end` event carries one; `runAgent` returns one; pass
 * it back as `resumeFrom` to continue.
 */

import type { AgentEndReason, AgentMessage, AgentUsage } from "./types.js";

/** Current `RunState.version`. */
export const RUN_STATE_VERSION = 1;

export interface RunState {
  version: 1;
  /** Full transcript (pi-ai messages: plain JSON, images as base64). */
  messages: AgentMessage[];
  /** Model calls made so far, across every invocation of this run. */
  turns: number;
  /** Tool calls executed so far, across every invocation of this run. */
  toolCallsExecuted: number;
  /** Usage summed over every model call so far. */
  usage: AgentUsage;
  /** Why the latest invocation ended. Absent in checkpoints taken mid-run. */
  endReason?: AgentEndReason;
  /** The error message when `endReason` is "error" or "aborted". */
  errorMessage?: string;
  /** Free caller data (JSON). The runtime copies it through untouched. */
  metadata?: Record<string, unknown>;
}

/** Thrown by `serializeRunState` / `parseRunState` and for an invalid `resumeFrom`. */
export class RunStateError extends Error {
  override readonly name = "RunStateError";
}

/**
 * JSON text for a state. Throws `RunStateError` when the state holds a value
 * JSON would drop or change (functions, class instances such as Date or Map,
 * NaN/Infinity, undefined inside arrays, cycles), naming the path and, for
 * tool results, the tool — so a tool returning non-JSON `details` is found
 * before a resume silently loses data.
 */
export function serializeRunState(state: RunState): string {
  state.messages.forEach((message, i) => {
    const problem = findNonJson(message, `messages[${i}]`, new Set());
    if (problem) {
      const tool = message.role === "toolResult" ? ` (tool "${message.toolName}")` : "";
      throw new RunStateError(`RunState is not JSON-safe at ${problem}${tool}`);
    }
  });
  const { messages: _messages, ...rest } = state;
  const problem = findNonJson(rest, "state", new Set());
  if (problem) throw new RunStateError(`RunState is not JSON-safe at ${problem}`);
  return JSON.stringify(state);
}

function findNonJson(value: unknown, path: string, stack: Set<object>): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${path}: ${value}`;
  if (typeof value !== "object") return `${path}: ${typeof value}`;
  if (stack.has(value)) return `${path}: circular reference`;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] === undefined) return `${path}[${i}]: undefined in an array`;
        const problem = findNonJson(value[i], `${path}[${i}]`, stack);
        if (problem) return problem;
      }
      return undefined;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return `${path}: ${(value as object).constructor?.name ?? "non-plain object"}`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue; // JSON omits the key; nothing is lost
      const problem = findNonJson(child, `${path}.${key}`, stack);
      if (problem) return problem;
    }
    return undefined;
  } finally {
    stack.delete(value);
  }
}

const ROLES = new Set(["user", "assistant", "toolResult"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/**
 * Validate a state from JSON text or a parsed value and return a copy.
 * Throws `RunStateError` for malformed input and for versions this runtime
 * does not know (newer states need a newer runtime).
 */
export function parseRunState(input: string | unknown): RunState {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (err) {
      throw new RunStateError(`RunState is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const bad = (why: string): never => {
    throw new RunStateError(`Invalid RunState: ${why}`);
  };
  if (!isPlainObject(value)) bad("expected an object");
  const s = value as Record<string, unknown>;

  if (s.version !== RUN_STATE_VERSION) {
    if (typeof s.version === "number" && s.version > RUN_STATE_VERSION) {
      throw new RunStateError(
        `RunState version ${s.version} is newer than this runtime supports (${RUN_STATE_VERSION}); upgrade @maya-ai/tool-agent-runtime`,
      );
    }
    bad(`unknown version ${JSON.stringify(s.version)}`);
  }
  if (!Array.isArray(s.messages)) bad("messages must be an array");
  (s.messages as unknown[]).forEach((m, i) => {
    if (!isPlainObject(m) || !ROLES.has(String(m.role))) bad(`messages[${i}] must be a user, assistant or toolResult message`);
  });
  for (const key of ["turns", "toolCallsExecuted"] as const) {
    if (!Number.isInteger(s[key]) || (s[key] as number) < 0) bad(`${key} must be a non-negative integer`);
  }
  const usage = s.usage;
  if (!isPlainObject(usage) || !isPlainObject(usage.cost)) bad("usage must be an object with a cost object");
  const u = usage as Record<string, unknown> & { cost: Record<string, unknown> };
  for (const key of USAGE_KEYS) if (typeof u[key] !== "number") bad(`usage.${key} must be a number`);
  for (const key of COST_KEYS) if (typeof u.cost[key] !== "number") bad(`usage.cost.${key} must be a number`);
  if (s.endReason !== undefined && typeof s.endReason !== "string") bad("endReason must be a string");
  if (s.errorMessage !== undefined && typeof s.errorMessage !== "string") bad("errorMessage must be a string");
  if (s.metadata !== undefined && !isPlainObject(s.metadata)) bad("metadata must be an object");

  const state: RunState = {
    version: RUN_STATE_VERSION,
    messages: (s.messages as AgentMessage[]).slice(),
    turns: s.turns as number,
    toolCallsExecuted: s.toolCallsExecuted as number,
    usage: { ...(u as unknown as AgentUsage), cost: { ...(u.cost as unknown as AgentUsage["cost"]) } },
  };
  if (s.endReason !== undefined) state.endReason = s.endReason as AgentEndReason;
  if (s.errorMessage !== undefined) state.errorMessage = s.errorMessage as string;
  if (s.metadata !== undefined) state.metadata = s.metadata as Record<string, unknown>;
  return state;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
