export interface SkillConfig {
  enabled: boolean;
  roots: string[];
  allow?: string[];
  deny?: string[];
  maxSkillFileBytes?: number;
  maxPromptChars?: number;
}

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  sourceRoot: string;
  body: string;
}

export type SkillDiagnosticLevel = "info" | "warning" | "error";

export interface SkillDiagnostic {
  level: SkillDiagnosticLevel;
  message: string;
  filePath?: string;
}

export interface LoadSkillsResult {
  skills: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillsRuntimeContext {
  skillsPrompt: string;
  skills: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}
