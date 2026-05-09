import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMarkdownWikiEngine,
  createMarkdownWikiMaintenanceToolDefinitions,
  type MarkdownWikiEngineFile,
  type MarkdownWikiEngineStore
} from "@maya-ai/agent-loop-core";

test("markdown wiki engine sync creates support files, index, log, and relationships", () => {
  const store = createMemoryStore({
    "notes/alpha.md": "# Alpha\n\nThis is the first useful page."
  });
  const engine = createMarkdownWikiEngine({
    store,
    metadata: {
      app: "Demo App"
    },
    relationshipTypes: ["relates_to"],
    clock: () => "2026-04-29T10:00:00.000Z"
  });

  const changed = engine.sync({
    log: {
      action: "sync",
      details: "updated wiki",
      affectedFiles: ["notes/alpha.md"]
    },
    relationships: [
      {
        from: "notes/alpha.md",
        to: "index.md",
        type: "relates_to",
        evidence: "alpha appears in the generated index"
      }
    ]
  });

  assert.deepEqual(new Set(changed), new Set(["index.md", "log.md", "graph/relationships.jsonl", "graph/context-brief.md", "graph/open-gaps.md"]));
  assert.match(store.readFile("index.md") ?? "", /# Wiki Index/);
  assert.match(store.readFile("index.md") ?? "", /App: Demo App/);
  assert.match(store.readFile("index.md") ?? "", /notes\/alpha\.md/);
  assert.match(store.readFile("log.md") ?? "", /\[2026-04-29\] sync \| updated wiki \| updated: notes\/alpha\.md/);
  assert.match(store.readFile("graph/relationships.jsonl") ?? "", /"type":"relates_to"/);
  assert.equal(engine.recordRelationships([{ from: "notes/alpha.md", to: "index.md", type: "relates_to", evidence: "duplicate" }]), 0);
});

test("markdown wiki engine lint reports broken links and relationship problems", () => {
  const store = createMemoryStore({
    "index.md": "# Index\n\nSee [[missing-page]].",
    "log.md": "# Log\n",
    "graph/context-brief.md": "# Context\n",
    "graph/open-gaps.md": "# Gaps\n",
    "graph/relationships.jsonl": [
      JSON.stringify({ from: "missing.md", to: "index.md", type: "unknown", evidence: "missing file" }),
      "{not-json"
    ].join("\n")
  });
  const engine = createMarkdownWikiEngine({
    store,
    relationshipTypes: ["relates_to"],
    clock: () => "2026-04-29T10:00:00.000Z"
  });

  const report = engine.lint();
  const issueIds = new Set(report.issues.map((issue) => issue.id));

  assert.equal(report.issueCount, 4);
  assert.equal(report.criticalCount, 1);
  assert.equal(report.warningCount, 3);
  assert.ok(issueIds.has("broken-link-index.md-missing-page"));
  assert.ok(issueIds.has("unknown-edge-type-0"));
  assert.ok(issueIds.has("dangling-edge-0-missing.md"));
  assert.ok(issueIds.has("invalid-edge-json-1"));
});

test("markdown wiki maintenance tools call the core engine", async () => {
  const store = createMemoryStore({
    "notes/alpha.md": "# Alpha\n\nUseful page."
  });
  const engine = createMarkdownWikiEngine({
    store,
    relationshipTypes: ["relates_to"],
    clock: () => "2026-04-29T10:00:00.000Z"
  });
  engine.ensureSupportFiles();
  const tools = Object.fromEntries(createMarkdownWikiMaintenanceToolDefinitions(engine).map((definition) => [definition.tool.name, definition.tool]));

  const lintResult = await tools.wiki_lint.execute("lint", {});
  assert.match(lintResult.content[0]?.type === "text" ? lintResult.content[0].text : "", /"issueCount": 0/);

  const logResult = await tools.wiki_append_log.execute("log", {
    action: "decision",
    details: "captured maintenance tool behavior",
    affectedFiles: ["notes/alpha.md"]
  });
  assert.equal(logResult.details.status, "ok");
  assert.match(store.readFile("log.md") ?? "", /decision \| captured maintenance tool behavior/);

  const relationshipResult = await tools.wiki_record_relationship.execute("rel", {
    from: "notes/alpha.md",
    to: "index.md",
    type: "relates_to",
    evidence: "alpha is indexed"
  });
  assert.equal(relationshipResult.details.added, 1);
  assert.match(store.readFile("graph/relationships.jsonl") ?? "", /"from":"notes\/alpha.md"/);

  const updateResult = await tools.wiki_update_index.execute("index", {});
  assert.equal(updateResult.details.status, "ok");
  assert.ok(updateResult.details.changedFiles?.includes("index.md"));
});

function createMemoryStore(initial: Record<string, string>): MarkdownWikiEngineStore {
  const files = new Map<string, MarkdownWikiEngineFile>();
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, { path, content, updatedAt: "2026-04-29T09:00:00.000Z" });
  }

  return {
    listFiles() {
      return Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path));
    },
    readFile(path) {
      return files.get(path)?.content;
    },
    writeFile(path, content) {
      files.set(path, { path, content: content.trimEnd() + "\n", updatedAt: "2026-04-29T10:00:00.000Z" });
    }
  };
}
