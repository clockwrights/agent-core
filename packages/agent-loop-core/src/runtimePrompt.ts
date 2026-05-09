import type { AgentRuntimeContext } from "./runtimeContext.js";

export function appendRuntimePromptsToSystemPrompt(
  systemPrompt: string,
  context: Pick<AgentRuntimeContext, "skillsPrompt" | "memoryPrompt">
): string {
  const additions = [context.skillsPrompt, context.memoryPrompt]
    .map((prompt) => prompt.trim())
    .filter(Boolean);
  if (!additions.length) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${additions.join("\n\n")}\n`;
}
