/**
 * Per-step control: stop conditions (`stopWhen`) and the `prepareStep` hook.
 */

import type { Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentStep, AgentTool, AgentUsage } from "./types.js";

/** State passed to stop conditions after each turn's tool batch. */
export interface StopConditionState {
  /** Every completed turn so far, oldest first. */
  steps: readonly AgentStep[];
  /** Usage summed over the run so far. */
  totalUsage: AgentUsage;
}

/**
 * Return true to end the run (reason "stop_condition"). Evaluated after a
 * turn's tool batch has run, and only when the run would otherwise continue.
 */
export type StopCondition = (state: StopConditionState) => boolean | Promise<boolean>;

/** True once `count` turns have completed. */
export function stepCountIs(count: number): StopCondition {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be a positive integer, got ${count}`);
  return ({ steps }) => steps.length >= count;
}

/** True when the last turn called any of the named tools (any tool when no names are given). */
export function hasToolCall(...toolNames: string[]): StopCondition {
  return ({ steps }) => {
    const last = steps[steps.length - 1];
    if (!last) return false;
    return last.message.content.some(
      (c) => c.type === "toolCall" && (toolNames.length === 0 || toolNames.includes(c.name)),
    );
  };
}

/** Context passed to `prepareStep` before each model call. */
export interface PrepareStepContext {
  /** 1-based number of the turn about to start. */
  turn: number;
  /** Completed turns so far, oldest first. */
  steps: readonly AgentStep[];
  /** The full conversation so far (what the model would see without overrides). */
  messages: readonly Message[];
}

/**
 * Overrides for one model call. Every field is optional; omitted fields keep
 * the run's values. Overrides apply to this step only and are not persisted.
 */
export interface PrepareStepResult {
  model?: Model<any>;
  systemPrompt?: string;
  reasoning?: ThinkingLevel;
  /**
   * Names of the tools offered to the model for this step (a subset of the
   * run's tools). The same subset is used to execute this step's tool calls;
   * a call to a tool outside it gets a "not found" error result. Unknown
   * names are ignored.
   */
  activeTools?: string[];
  /**
   * Messages sent to the model for this step instead of the full
   * conversation (e.g. pruned or with old tool results cleared). The run's
   * own transcript is unchanged.
   */
  messages?: Message[];
}

export type PrepareStep = (
  context: PrepareStepContext,
) => PrepareStepResult | void | Promise<PrepareStepResult | void>;

/** Tools offered for a step: the run's tools, narrowed by `activeTools` when given. */
export function selectActiveTools(tools: AgentTool<any>[], activeTools: string[] | undefined): AgentTool<any>[] {
  if (!activeTools) return tools;
  const wanted = new Set(activeTools);
  return tools.filter((t) => wanted.has(t.name));
}
