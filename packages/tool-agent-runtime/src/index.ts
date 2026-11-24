/**
 * tool-agent-runtime.
 *
 * Provides:
 * - Type definitions: AgentTool, AgentToolResult, AgentToolUpdateCallback,
 *   AgentMessage, AgentEvent
 * - runToolAgent: drives a multi-turn tool-calling loop.
 *
 * Reusability: domain-neutral. No imports from any consumer-app code.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./steps.js";
export * from "./loop.js";
export * from "./runState.js";
