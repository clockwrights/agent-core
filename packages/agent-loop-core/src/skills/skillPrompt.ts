import type { SkillEntry, SkillsRuntimeContext } from "./skillTypes.js";

export interface FormatSkillsPromptOptions {
  maxPromptChars?: number;
  readToolName?: string;
}

const defaultMaxPromptChars = 12_000;

export function formatSkillsForPrompt(skills: SkillEntry[], options: FormatSkillsPromptOptions = {}): string {
  if (!skills.length) return "";

  const maxPromptChars = options.maxPromptChars ?? defaultMaxPromptChars;
  const readToolName = options.readToolName ?? "read_skill";
  const header = [
    "<skills>",
    "Available skills are reusable procedures. Use a skill only when it is relevant to the user's request.",
    `If you need full instructions, call ${readToolName} with the skill name or listed file path.`,
    ""
  ].join("\n");
  const footer = "\n</skills>";
  const entries: string[] = [];

  for (const skill of skills) {
    const entry = [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>"
    ].join("\n");
    const nextPrompt = `${header}${entries.concat(entry).join("\n")}${footer}`;
    if (nextPrompt.length > maxPromptChars) break;
    entries.push(entry);
  }

  if (!entries.length) return "";
  return `${header}${entries.join("\n")}${footer}`;
}

export function appendSkillsPromptToSystemPrompt(systemPrompt: string, context: Pick<SkillsRuntimeContext, "skillsPrompt">): string {
  const skillsPrompt = context.skillsPrompt.trim();
  if (!skillsPrompt) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${skillsPrompt}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
