import { loadSkills } from "./skillLoader.js";
import { formatSkillsForPrompt } from "./skillPrompt.js";
import type { SkillConfig, SkillsRuntimeContext } from "./skillTypes.js";

export async function createSkillsRuntimeContext(config: SkillConfig): Promise<SkillsRuntimeContext> {
  const result = await loadSkills(config);
  const skillsPrompt = formatSkillsForPrompt(result.skills, {
    maxPromptChars: config.maxPromptChars
  });
  return {
    skillsPrompt,
    skills: result.skills,
    diagnostics: result.diagnostics
  };
}
