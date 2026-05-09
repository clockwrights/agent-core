/**
 * tool-agent-runtime — in-house replacement for @mariozechner/pi-agent-core.
 *
 * Provides:
 * - Type definitions: AgentTool, AgentToolResult, AgentToolUpdateCallback,
 *   AgentMessage, AgentEvent (structurally compatible with pi-agent-core shapes)
 * - runToolAgent: drives the tool-calling loop using @mariozechner/pi-ai
 *   directly, with full AbortSignal support for cancellation
 *
 * Reusability: domain-neutral. No imports from any consumer-app code.
 */
export * from "./types.js";
export * from "./loop.js";
