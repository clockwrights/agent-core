import fs from "node:fs/promises";
import path from "node:path";
import type { LoadSkillsResult, SkillConfig, SkillDiagnostic, SkillEntry } from "./skillTypes.js";

const defaultMaxSkillFileBytes = 128 * 1024;

interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export async function loadSkills(config: SkillConfig): Promise<LoadSkillsResult> {
  const diagnostics: SkillDiagnostic[] = [];
  if (!config.enabled) {
    diagnostics.push({
      level: "info",
      message: "Skills loader is disabled."
    });
    return { skills: [], diagnostics };
  }

  const skills: SkillEntry[] = [];
  for (const rawRoot of config.roots) {
    const root = path.resolve(rawRoot);
    const rootStat = await statSafe(root);
    if (!rootStat?.isDirectory()) {
      diagnostics.push({
        level: "warning",
        message: `Skill root does not exist or is not a directory: ${root}`
      });
      continue;
    }

    const resolvedRoot = await fs.realpath(root);
    const skillFiles = await findSkillFiles(resolvedRoot, diagnostics);
    for (const filePath of skillFiles) {
      const skill = await loadSkillFile({
        filePath,
        sourceRoot: resolvedRoot,
        maxSkillFileBytes: config.maxSkillFileBytes ?? defaultMaxSkillFileBytes,
        diagnostics
      });
      if (skill) skills.push(skill);
    }
  }

  return { skills: filterSkills(skills, config), diagnostics };
}

async function findSkillFiles(root: string, diagnostics: SkillDiagnostic[]): Promise<string[]> {
  const candidates: string[] = [];
  const rootSkill = path.join(root, "SKILL.md");
  if (await isFileInsideRoot(rootSkill, root)) {
    candidates.push(await fs.realpath(rootSkill));
  }

  let entries: DirectoryEntry[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      level: "warning",
      message: `Could not read skill root: ${root}. ${errorMessage(error)}`
    });
    return candidates;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "SKILL.md");
    if (await isFileInsideRoot(candidate, root)) {
      candidates.push(await fs.realpath(candidate));
    }
  }

  return Array.from(new Set(candidates)).sort((a, b) => a.localeCompare(b));
}

async function loadSkillFile(input: {
  filePath: string;
  sourceRoot: string;
  maxSkillFileBytes: number;
  diagnostics: SkillDiagnostic[];
}): Promise<SkillEntry | undefined> {
  const { filePath, sourceRoot, maxSkillFileBytes, diagnostics } = input;
  if (!isPathInsideRoot(filePath, sourceRoot)) {
    diagnostics.push({
      level: "warning",
      filePath,
      message: "Skill file resolved outside its configured root; skipped."
    });
    return undefined;
  }

  const stat = await statSafe(filePath);
  if (!stat?.isFile()) return undefined;
  if (stat.size > maxSkillFileBytes) {
    diagnostics.push({
      level: "warning",
      filePath,
      message: `Skill file exceeds ${maxSkillFileBytes} bytes; skipped.`
    });
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push({
      level: "warning",
      filePath,
      message: `Could not read skill file. ${errorMessage(error)}`
    });
    return undefined;
  }

  const parsed = parseSkillFile(raw.replace(/\r\n/g, "\n"));
  if (!parsed) {
    diagnostics.push({
      level: "error",
      filePath,
      message: "Skill file must start with YAML-style frontmatter delimited by ---."
    });
    return undefined;
  }

  const name = parsed.frontmatter.name?.trim();
  const description = parsed.frontmatter.description?.trim();
  if (!name || !description) {
    diagnostics.push({
      level: "error",
      filePath,
      message: "Skill frontmatter requires single-line name and description fields."
    });
    return undefined;
  }

  return {
    name,
    description,
    filePath,
    sourceRoot,
    body: parsed.body.trim()
  };
}

function parseSkillFile(content: string): ParsedSkillFile | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return undefined;

  const frontmatterText = content.slice(4, end).trim();
  const body = content.slice(end + "\n---".length).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};

  for (const line of frontmatterText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    frontmatter[match[1]] = unquoteYamlScalar(match[2]);
  }

  return { frontmatter, body };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function isFileInsideRoot(filePath: string, root: string): Promise<boolean> {
  const stat = await statSafe(filePath);
  if (!stat?.isFile()) return false;
  const realFilePath = await fs.realpath(filePath);
  return isPathInsideRoot(realFilePath, root);
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function statSafe(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filterSkills(skills: SkillEntry[], config: SkillConfig): SkillEntry[] {
  const allow = normalizeNameSet(config.allow ?? []);
  const deny = normalizeNameSet(config.deny ?? []);
  return skills.filter((skill) => {
    const name = skill.name.trim();
    if (allow.size > 0 && !allow.has(name)) return false;
    if (deny.has(name)) return false;
    return true;
  });
}

function normalizeNameSet(names: string[]): Set<string> {
  return new Set(names.map((name) => name.trim()).filter(Boolean));
}
