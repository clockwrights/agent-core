import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  createReadSkillFileTool,
  createSkillToolDefinitions,
  createSkillsRuntimeContext,
  loadSkills,
  validateSkillEntry,
  type SkillEntry
} from "../src/index.js";

let root = "";
let symlinkCreated = false;
let dirLinkCreated = false;

async function write(rel: string, content: string | Buffer) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

const skillMd = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Does ${name} things.\n${extra}---\n# ${name}\nUse the reference files.\n`;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-test-"));
  await write("pdf-tools/SKILL.md", skillMd("pdf-tools", "license: MIT\nallowed-tools: Read Bash(git:*)\ncompatibility: Node 22\n"));
  await write("pdf-tools/references/api.md", "# API\nCall extract().\n");
  await write("pdf-tools/scripts/run.sh", "#!/bin/sh\necho run\n");
  await write("pdf-tools/assets/logo.bin", Buffer.from([0x89, 0x00, 0x01, 0x02]));
  await write("pdf-tools/references/big.txt", "x".repeat(2_000));
  await write("Bad_Name/SKILL.md", skillMd("Bad_Name"));
  await write("mismatch/SKILL.md", skillMd("other-name"));
  await write("secret.txt", "outside the skill");
  try {
    await fs.symlink(path.join(root, "secret.txt"), path.join(root, "pdf-tools", "escape.txt"));
    symlinkCreated = true;
  } catch {
    symlinkCreated = false; // e.g. Windows without symlink privilege
  }
  try {
    // Directory link out of the skill folder: a junction on Windows (no privilege needed), a symlink elsewhere.
    await fs.symlink(path.join(root, "mismatch"), path.join(root, "pdf-tools", "escape-dir"), "junction");
    dirLinkCreated = true;
  } catch {
    dirLinkCreated = false;
  }
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function skills(extra: Partial<Parameters<typeof loadSkills>[0]> = {}) {
  return loadSkills({ enabled: true, roots: [root], ...extra });
}

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

test("loader: optional fields are parsed and the skill folder recorded", async () => {
  const { skills: loaded } = await skills();
  const pdf = loaded.find((s) => s.name === "pdf-tools")!;
  assert.equal(pdf.license, "MIT");
  assert.equal(pdf.compatibility, "Node 22");
  assert.deepEqual(pdf.allowedTools, ["Read", "Bash(git:*)"]);
  assert.equal(await fs.realpath(pdf.directory!), await fs.realpath(path.join(root, "pdf-tools")));
});

test("loader: spec violations are warnings by default (skills still load)", async () => {
  const { skills: loaded, diagnostics } = await skills();
  assert.deepEqual(loaded.map((s) => s.name).sort(), ["Bad_Name", "other-name", "pdf-tools"]);
  const warnings = diagnostics.filter((d) => d.level === "warning").map((d) => d.message);
  assert.ok(warnings.some((m) => /"Bad_Name" must use only lowercase letters/.test(m)));
  assert.ok(warnings.some((m) => /"other-name" does not match its folder name "mismatch"/.test(m)));
});

test("loader: strictValidation skips invalid skills with error diagnostics", async () => {
  const { skills: loaded, diagnostics } = await skills({ strictValidation: true });
  assert.deepEqual(loaded.map((s) => s.name), ["pdf-tools"]);
  assert.ok(diagnostics.some((d) => d.level === "error" && /Skill skipped \(strictValidation\)/.test(d.message)));
});

test("validateSkillEntry: name length, format, double hyphens, description length", () => {
  const base = { name: "ok-name", description: "fine", filePath: "/s/ok-name/SKILL.md" };
  assert.deepEqual(validateSkillEntry(base), []);
  assert.equal(validateSkillEntry({ ...base, name: "a".repeat(65), filePath: `/s/${"a".repeat(65)}/SKILL.md` }).length, 1);
  assert.equal(validateSkillEntry({ ...base, name: "bad--name", filePath: "/s/bad--name/SKILL.md" }).length, 1);
  assert.equal(validateSkillEntry({ ...base, name: "-lead", filePath: "/s/-lead/SKILL.md" }).length, 1);
  assert.equal(validateSkillEntry({ ...base, description: "d".repeat(1025) }).length, 1);
});

// ---------------------------------------------------------------------------
// Registration and prompt
// ---------------------------------------------------------------------------

test("read_skill_file is registered only with fileAccess; the prompt mentions it then", async () => {
  const { skills: loaded } = await skills();
  assert.deepEqual(createSkillToolDefinitions(loaded).map((d) => d.tool.name), ["read_skill"]);
  const withFiles = createSkillToolDefinitions(loaded, { fileAccess: true });
  assert.deepEqual(withFiles.map((d) => [d.tool.name, d.metadata.risk]), [["read_skill", "read"], ["read_skill_file", "read"]]);

  const plain = await createSkillsRuntimeContext({ enabled: true, roots: [root] });
  const files = await createSkillsRuntimeContext({ enabled: true, roots: [root], fileAccess: true });
  assert.equal(plain.skillsPrompt.includes("read_skill_file"), false);
  assert.match(files.skillsPrompt, /list or read them with read_skill_file/);
});

// ---------------------------------------------------------------------------
// read_skill_file
// ---------------------------------------------------------------------------

async function fileTool(maxResourceBytes?: number) {
  const { skills: loaded } = await skills();
  return createReadSkillFileTool(loaded, { maxResourceBytes });
}

test("read_skill_file: without a path it lists the skill's files", async () => {
  const tool = await fileTool();
  const result = await tool.execute("c", { skill: "pdf-tools" });
  const listing = text(result);
  for (const entry of ["SKILL.md", "references/", "references/api.md", "scripts/run.sh", "assets/logo.bin"]) {
    assert.ok(listing.includes(`- ${entry}`), `missing ${entry} in:\n${listing}`);
  }
  assert.equal(result.details.kind, "listing");
});

test("read_skill_file: reads a bundled file; a folder path lists that folder", async () => {
  const tool = await fileTool();
  const file = await tool.execute("c", { skill: "pdf-tools", path: "references/api.md" });
  assert.equal(text(file), "# API\nCall extract().\n");
  assert.deepEqual(file.details, { skill: "pdf-tools", path: "references/api.md", kind: "file", bytes: 22 });

  const folder = await tool.execute("c", { skill: "pdf-tools", path: "scripts" });
  assert.match(text(folder), /under scripts\/:\n- scripts\/run\.sh/);
  assert.equal((await tool.execute("c", { skill: "pdf-tools", path: "references\\api.md" })).details.kind, "file");
});

test("read_skill_file: paths outside the skill folder are rejected", async () => {
  const tool = await fileTool();
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "../secret.txt" }), /outside the folder of skill "pdf-tools"/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "../mismatch/SKILL.md" }), /outside the folder/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: path.join(root, "secret.txt") }), /not an absolute path/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "C:/Windows/win.ini" }), /not an absolute path/);
});

test("read_skill_file: a symlink pointing outside the skill folder is rejected", async (t) => {
  if (!symlinkCreated) {
    t.skip("symlinks cannot be created in this environment");
    return;
  }
  const tool = await fileTool();
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "escape.txt" }), /outside the folder/);
});

test("read_skill_file: a directory link pointing outside the skill folder is rejected", async (t) => {
  if (!dirLinkCreated) {
    t.skip("directory links cannot be created in this environment");
    return;
  }
  const tool = await fileTool();
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "escape-dir/SKILL.md" }), /outside the folder/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "escape-dir" }), /outside the folder/);
});

test("read_skill_file: missing files, binary files, size limit and unknown skills are errors", async () => {
  const tool = await fileTool(1_000);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "nope.md" }), /No file or folder "nope\.md"/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "assets/logo.bin" }), /looks binary/);
  await assert.rejects(tool.execute("c", { skill: "pdf-tools", path: "references/big.txt" }), /2000 bytes, above the 1000-byte limit/);
  await assert.rejects(tool.execute("c", { skill: "unknown" }), /No loaded skill is named "unknown"/);
});

test("read_skill_file: hand-built entries without directory use the folder of filePath", async () => {
  const entry: SkillEntry = {
    name: "pdf-tools",
    description: "d",
    filePath: path.join(root, "pdf-tools", "SKILL.md"),
    sourceRoot: root,
    body: ""
  };
  const tool = createReadSkillFileTool([entry]);
  assert.match(text(await tool.execute("c", { skill: "pdf-tools", path: "references/api.md" })), /Call extract/);
});
