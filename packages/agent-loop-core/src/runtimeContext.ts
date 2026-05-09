import type { RegisteredTool, ToolPolicy } from "./toolRegistry.js";
import { defaultToolPolicy } from "./toolRegistry.js";

export interface AgentRuntimeDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  source: "mcp" | "memory" | "skills" | "runtime";
}

export interface AgentRuntimeContext {
  toolDefinitions: RegisteredTool[];
  toolPolicy: ToolPolicy;
  skillsPrompt: string;
  memoryPrompt: string;
  diagnostics: AgentRuntimeDiagnostic[];
  dispose?: () => Promise<void>;
}

export type AgentRuntimeContextFactory<TState> = (state: TState) => Promise<AgentRuntimeContext | undefined>;

export function emptyAgentRuntimeContext(): AgentRuntimeContext {
  return {
    toolDefinitions: [],
    toolPolicy: defaultToolPolicy,
    skillsPrompt: "",
    memoryPrompt: "",
    diagnostics: []
  };
}

export async function disposeAgentRuntimeContext(context: AgentRuntimeContext): Promise<void> {
  await context.dispose?.();
}
