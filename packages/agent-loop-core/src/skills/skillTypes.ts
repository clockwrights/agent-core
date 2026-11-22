export interface SkillConfig {
  enabled: boolean;
  roots: string[];
  allow?: string[];
  deny?: string[];
  maxSkillFileBytes?: number;
  maxPromptChars?: number;
  /**
   * Register `read_skill_file`, which lists and reads the files bundled in a
   * skill's folder (scripts, references, assets), scoped to that folder.
   * Default false.
   */
  fileAccess?: boolean;
  /** Maximum size of a file returned by `read_skill_file`. Default 256 KiB. */
  maxResourceBytes?: number;
  /**
   * Skip skills that break the Agent Skills naming rules (name format, name
   * matching the folder, description length) instead of only reporting a
   * warning diagnostic. Default false.
   */
  strictValidation?: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  /** Path of the skill's SKILL.md. */
  filePath: string;
  sourceRoot: string;
  /**
   * Folder holding SKILL.md and any bundled files. Always set by the loader;
   * optional so hand-built entries stay valid (defaults to the folder of
   * `filePath`).
   */
  directory?: string;
  body: string;
  /** Optional `license` frontmatter field. */
  license?: string;
  /** Optional `compatibility` frontmatter field (environment requirements). */
  compatibility?: string;
  /**
   * Optional `allowed-tools` frontmatter field (space-separated tool names),
   * parsed into a list. Informational for now: nothing pre-approves tools.
   */
  allowedTools?: string[];
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
