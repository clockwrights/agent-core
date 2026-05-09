import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { RegisteredTool } from "../toolRegistry.js";
import type { SkillEntry } from "./skillTypes.js";

export interface ReadSkillDetails {
  name?: string;
  filePath?: string;
  chars?: number;
  status: "ok" | "not_found" | "ambiguous" | "invalid_request";
}

interface ReadSkillInput {
  name?: string;
  filePath?: string;
}

export function createSkillToolDefinitions(skills: SkillEntry[]): RegisteredTool[] {
  if (!skills.length) return [];

  return [
    {
      tool: createReadSkillTool(skills),
      metadata: {
        source: "system",
        risk: "read"
      }
    }
  ];
}

function createReadSkillTool(skills: SkillEntry[]): AgentTool<any, ReadSkillDetails> {
  return {
    name: "read_skill",
    label: "Read Skill",
    description: "Read the full instructions for one loaded skill by name or listed file path.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Skill name from the available skills prompt." })),
      filePath: Type.Optional(Type.String({ description: "Skill file path from the available skills prompt." }))
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const input = params as ReadSkillInput;
      const match = findSkill(skills, input);

      if (match.status !== "ok") {
        return textResult(match.message, {
          name: input.name,
          filePath: input.filePath,
          status: match.status
        });
      }

      const skill = match.skill;
      return textResult(skill.body, {
        name: skill.name,
        filePath: skill.filePath,
        chars: skill.body.length,
        status: "ok"
      });
    }
  };
}

function findSkill(
  skills: SkillEntry[],
  input: ReadSkillInput
):
  | { status: "ok"; skill: SkillEntry }
  | { status: "not_found" | "ambiguous" | "invalid_request"; message: string } {
  const name = input.name?.trim();
  const filePath = input.filePath?.trim();

  if (!name && !filePath) {
    return {
      status: "invalid_request",
      message: "Provide either a skill name or a skill file path."
    };
  }

  if (filePath) {
    const skill = skills.find((candidate) => candidate.filePath === filePath);
    if (!skill) {
      return {
        status: "not_found",
        message: `No loaded skill has file path: ${filePath}`
      };
    }
    return { status: "ok", skill };
  }

  const exactMatches = skills.filter((skill) => skill.name === name);
  if (exactMatches.length === 1) return { status: "ok", skill: exactMatches[0] };
  if (exactMatches.length > 1) return ambiguousSkillResult(name ?? "", exactMatches);

  const normalizedName = normalizeName(name ?? "");
  const normalizedMatches = skills.filter((skill) => normalizeName(skill.name) === normalizedName);
  if (normalizedMatches.length === 1) return { status: "ok", skill: normalizedMatches[0] };
  if (normalizedMatches.length > 1) return ambiguousSkillResult(name ?? "", normalizedMatches);

  return {
    status: "not_found",
    message: `No loaded skill has name: ${name}`
  };
}

function ambiguousSkillResult(name: string, matches: SkillEntry[]): { status: "ambiguous"; message: string } {
  const locations = matches.map((skill) => `- ${skill.name}: ${skill.filePath}`).join("\n");
  return {
    status: "ambiguous",
    message: `Multiple loaded skills match "${name}". Call read_skill with one of these filePath values:\n${locations}`
  };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function textResult(text: string, details: ReadSkillDetails): AgentToolResult<ReadSkillDetails> {
  return {
    content: [{ type: "text", text }],
    details
  };
}
