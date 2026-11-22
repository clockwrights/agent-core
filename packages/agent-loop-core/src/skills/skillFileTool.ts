import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { SkillEntry } from "./skillTypes.js";

// Level-3 progressive disclosure: files bundled with a skill (scripts,
// references, assets), readable only inside that skill's own folder.

export const readSkillFileToolName = "read_skill_file";

const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_LISTED_ENTRIES = 200;
const MAX_LIST_DEPTH = 3;

const parameters = Type.Object({
  skill: Type.String({ description: "Skill name from the available skills prompt." }),
  path: Type.Optional(
    Type.String({
      description:
        "File or folder path relative to the skill's folder, e.g. \"references/api.md\". Omit to list the skill's files."
    })
  )
});

export interface ReadSkillFileDetails {
  skill: string;
  path: string;
  kind: "file" | "listing";
  bytes?: number;
  entries?: number;
}

export interface ReadSkillFileToolOptions {
  /** Maximum size of a returned file. Default 256 KiB. */
  maxResourceBytes?: number;
}

/**
 * `read_skill_file`: list or read a file inside one skill's folder. Absolute
 * paths and paths that resolve outside the folder (including via symlinks)
 * are rejected, as are binary files and files above `maxResourceBytes`.
 */
export function createReadSkillFileTool(
  skills: SkillEntry[],
  options: ReadSkillFileToolOptions = {}
): AgentTool<typeof parameters, ReadSkillFileDetails> {
  const maxBytes = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  return {
    name: readSkillFileToolName,
    label: "Read Skill File",
    description:
      "List or read a file bundled with a skill (scripts, references, assets). Paths are relative to the skill's folder; omit the path to list its files.",
    parameters,
    execute: async (_toolCallId, { skill: skillName, path: requested }) => {
      const skill = findSkillByName(skills, skillName);
      const relative = (requested ?? "").trim().replace(/\\/g, "/");
      if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
        throw new Error("Use a path relative to the skill's folder, not an absolute path.");
      }

      const root = await fs.realpath(skill.directory ?? path.dirname(skill.filePath));
      const target = path.resolve(root, relative || ".");
      let real: string;
      try {
        real = await fs.realpath(target);
      } catch {
        throw new Error(`No file or folder "${relative}" in skill "${skill.name}".`);
      }
      if (!isInside(real, root)) {
        throw new Error(`Path "${relative}" is outside the folder of skill "${skill.name}".`);
      }

      const stat = await fs.stat(real);
      const shownPath = toPosix(path.relative(root, real)) || ".";
      if (stat.isDirectory()) {
        const entries = await listFiles(root, real);
        const truncated = entries.length > MAX_LISTED_ENTRIES;
        const shown = entries.slice(0, MAX_LISTED_ENTRIES);
        const text =
          `Files in skill "${skill.name}"${shownPath === "." ? "" : ` under ${shownPath}/`}:\n` +
          (shown.length ? shown.map((entry) => `- ${entry}`).join("\n") : "(empty)") +
          (truncated ? `\n(… ${entries.length - MAX_LISTED_ENTRIES} more not shown)` : "");
        return {
          content: [{ type: "text", text }],
          details: { skill: skill.name, path: shownPath, kind: "listing", entries: entries.length }
        };
      }

      if (stat.size > maxBytes) {
        throw new Error(`File "${shownPath}" is ${stat.size} bytes, above the ${maxBytes}-byte limit.`);
      }
      const buffer = await fs.readFile(real);
      if (buffer.subarray(0, 8192).includes(0)) {
        throw new Error(`File "${shownPath}" looks binary and cannot be shown as text.`);
      }
      return {
        content: [{ type: "text", text: buffer.toString("utf8") }],
        details: { skill: skill.name, path: shownPath, kind: "file", bytes: buffer.length }
      };
    }
  };
}

function findSkillByName(skills: SkillEntry[], name: string): SkillEntry {
  const trimmed = name.trim();
  const exact = skills.filter((skill) => skill.name === trimmed);
  const matches = exact.length ? exact : skills.filter((skill) => skill.name.toLowerCase() === trimmed.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Several loaded skills are named "${trimmed}"; rename one of them to use ${readSkillFileToolName}.`);
  }
  throw new Error(`No loaded skill is named "${trimmed}".`);
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Files under `dir` (relative to `root`, POSIX separators), folders suffixed with "/". */
async function listFiles(root: string, dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (out.length > MAX_LISTED_ENTRIES) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = toPosix(path.relative(root, full));
    if (entry.isDirectory()) {
      out.push(`${relative}/`);
      if (depth + 1 < MAX_LIST_DEPTH) await listFiles(root, full, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(relative);
    }
    if (out.length > MAX_LISTED_ENTRIES) break;
  }
  return out;
}
