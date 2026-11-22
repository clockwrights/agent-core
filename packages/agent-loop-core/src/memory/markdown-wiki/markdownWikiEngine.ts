import { collectPinnedMemory, type PinnedMemoryOptions } from "../pinnedMemory.js";

export interface MarkdownWikiEngineFile {
  path: string;
  content: string;
  updatedAt?: string;
}

export interface MarkdownWikiEngineStore {
  listFiles(): MarkdownWikiEngineFile[];
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
}

export interface MarkdownWikiSupportFile {
  path: string;
  createContent: (context: MarkdownWikiEngineRenderContext) => string;
}

export interface MarkdownWikiGeneratedFile {
  path: string;
  render: (context: MarkdownWikiEngineRenderContext) => string;
}

export interface MarkdownWikiRelationship {
  from: string;
  to: string;
  type: string;
  evidence: string;
  date?: string;
  /** Who recorded the edge; set when the maintenance tools are given a provenance source. */
  provenance?: { tool: string; origin: string; session?: string; actor?: string };
}

export interface MarkdownWikiLogEntry {
  action: string;
  details: string;
  affectedFiles?: string[];
}

export interface MarkdownWikiIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  category: string;
  file: string;
  message: string;
  suggestion: string;
}

export interface MarkdownWikiLintReport {
  generatedAt: string;
  issueCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  issues: MarkdownWikiIssue[];
}

export interface MarkdownWikiEngineRenderContext {
  files: MarkdownWikiEngineFile[];
  nowIso: string;
  date: string;
  metadata: Record<string, string | undefined>;
  readRelationships: () => MarkdownWikiRelationship[];
  renderIndex: (options?: MarkdownWikiIndexRenderOptions) => string;
}

export interface MarkdownWikiIndexRenderOptions {
  title?: string;
  subtitle?: string;
  selfPath?: string;
  metadataLabels?: Record<string, string>;
}

export interface MarkdownWikiEngineConfig {
  store: MarkdownWikiEngineStore;
  metadata?: Record<string, string | undefined>;
  requiredFiles?: MarkdownWikiSupportFile[];
  generatedFiles?: MarkdownWikiGeneratedFile[];
  relationshipTypes?: readonly string[];
  logPath?: string;
  relationshipsPath?: string;
  categorizePath?: (path: string) => string;
  summarizeContent?: (content: string) => string;
  clock?: () => string;
  /** When set, lint warns if the pinned (always-loaded) tier is over budget or holds untrusted or missing pages. */
  pinned?: PinnedMemoryOptions;
}

export interface MarkdownWikiSyncOptions {
  log?: MarkdownWikiLogEntry;
  relationships?: MarkdownWikiRelationship[];
}

export interface MarkdownWikiEngine {
  ensureSupportFiles(): string[];
  sync(options?: MarkdownWikiSyncOptions): string[];
  updateGeneratedFiles(): string[];
  appendLog(entry: MarkdownWikiLogEntry): void;
  recordRelationships(relationships: MarkdownWikiRelationship[]): number;
  readRelationships(): MarkdownWikiRelationship[];
  lint(): MarkdownWikiLintReport;
  renderIndex(options?: MarkdownWikiIndexRenderOptions): string;
  /** Paths the engine maintains itself (support, generated, log, relationship files). */
  managedPaths?(): string[];
}

const defaultLogPath = "log.md";
const defaultRelationshipsPath = "graph/relationships.jsonl";

export function createMarkdownWikiEngine(config: MarkdownWikiEngineConfig): MarkdownWikiEngine {
  return new DefaultMarkdownWikiEngine(config);
}

export function createDefaultMarkdownWikiSupportFiles(): MarkdownWikiSupportFile[] {
  return [
    {
      path: "index.md",
      createContent: () => "# Wiki Index\n\n_Auto-generated catalog. Do not edit manually._\n"
    },
    {
      path: defaultLogPath,
      createContent: (context) => `# Wiki Log\n\n## [${context.date}] init | markdown wiki initialized\n`
    },
    {
      path: defaultRelationshipsPath,
      createContent: () => ""
    },
    {
      path: "graph/context-brief.md",
      createContent: () => "# Context Brief\n\n_Auto-generated compressed context. Do not edit manually._\n"
    },
    {
      path: "graph/open-gaps.md",
      createContent: () => "# Open Gaps\n\n_Auto-generated gap map. Do not edit manually._\n"
    }
  ];
}

export function createDefaultMarkdownWikiGeneratedFiles(): MarkdownWikiGeneratedFile[] {
  return [
    {
      path: "index.md",
      render: (context) => context.renderIndex()
    },
    {
      path: "graph/context-brief.md",
      render: (context) => {
        const relationships = context.readRelationships().slice(-20);
        return [
          "# Context Brief",
          "",
          "_Auto-generated compressed context. Do not edit manually._",
          "",
          "## Recent Relationships",
          "",
          relationships.length
            ? relationships.map((edge) => `- ${edge.from} --${edge.type}--> ${edge.to}: ${edge.evidence}`).join("\n")
            : "- No relationships recorded yet.",
          ""
        ].join("\n");
      }
    },
    {
      path: "graph/open-gaps.md",
      render: () => "# Open Gaps\n\n_Auto-generated gap map. Do not edit manually._\n\n- No app-specific gap renderer configured.\n"
    }
  ];
}

export function renderMarkdownWikiIndex(input: {
  files: MarkdownWikiEngineFile[];
  categorizePath?: (path: string) => string;
  summarizeContent?: (content: string) => string;
  options?: MarkdownWikiIndexRenderOptions;
  metadata?: Record<string, string | undefined>;
}): string {
  const options = input.options ?? {};
  const title = options.title ?? "Wiki Index";
  const subtitle = options.subtitle ?? "_Auto-generated catalog. Do not edit manually._";
  const selfPath = options.selfPath ?? "index.md";
  const files = input.files
    .filter((file) => normalizeMarkdownWikiPath(file.path) !== normalizeMarkdownWikiPath(selfPath))
    .sort((left, right) => left.path.localeCompare(right.path));
  const grouped = new Map<string, MarkdownWikiEngineFile[]>();

  for (const file of files) {
    const category = input.categorizePath?.(file.path) ?? defaultCategoryForPath(file.path);
    const list = grouped.get(category) ?? [];
    list.push(file);
    grouped.set(category, list);
  }

  const metadata = renderMetadata(input.metadata ?? {}, options.metadataLabels ?? {});
  const sections = Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, categoryFiles]) => {
      const entries = categoryFiles
        .map((file) => {
          const fileTitle = extractMarkdownTitle(file.content) || file.path;
          const summary = (input.summarizeContent ?? summarizeMarkdownContent)(file.content);
          return `- path: \`${file.path}\`\n  title: ${fileTitle}\n  summary: ${summary || "No summary available."}\n  updated: ${file.updatedAt ?? "unknown"}`;
        })
        .join("\n");
      return `## ${category}\n\n${entries}`;
    })
    .join("\n\n");

  return [`# ${title}`, "", subtitle, "", metadata, sections].filter((part) => part.trim()).join("\n\n") + "\n";
}

export function extractMarkdownTitle(content: string): string | undefined {
  return content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.replace(/^#\s+/, "")
    .trim();
}

export function summarizeMarkdownContent(content: string): string {
  // Leading frontmatter (tags, provenance) is metadata, not summary text.
  const lines = stripLeadingFrontmatter(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("_Auto-generated"));
  const text = lines.slice(0, 3).join(" ").replace(/\s+/g, " ");
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function stripLeadingFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---", 4);
  return end === -1 ? normalized : normalized.slice(end + 4);
}

export function normalizeMarkdownWikiPath(filePath: string | undefined): string {
  return (filePath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

class DefaultMarkdownWikiEngine implements MarkdownWikiEngine {
  private readonly requiredFiles: MarkdownWikiSupportFile[];
  private readonly generatedFiles: MarkdownWikiGeneratedFile[];
  private readonly logPath: string;
  private readonly relationshipsPath: string;

  constructor(private readonly config: MarkdownWikiEngineConfig) {
    this.requiredFiles = config.requiredFiles ?? createDefaultMarkdownWikiSupportFiles();
    this.generatedFiles = config.generatedFiles ?? createDefaultMarkdownWikiGeneratedFiles();
    this.logPath = normalizeMarkdownWikiPath(config.logPath ?? defaultLogPath);
    this.relationshipsPath = normalizeMarkdownWikiPath(config.relationshipsPath ?? defaultRelationshipsPath);
  }

  ensureSupportFiles(): string[] {
    const changed: string[] = [];
    const context = this.renderContext();
    for (const file of this.requiredFiles) {
      const path = normalizeMarkdownWikiPath(file.path);
      if (this.hasFile(path)) continue;
      this.writeFile(path, file.createContent(context));
      changed.push(path);
    }
    return changed;
  }

  sync(options: MarkdownWikiSyncOptions = {}): string[] {
    const changed = new Set<string>(this.ensureSupportFiles());
    if (options.relationships?.length) {
      const added = this.recordRelationships(options.relationships);
      if (added > 0) changed.add(this.relationshipsPath);
    }
    if (options.log) {
      this.appendLog(options.log);
      changed.add(this.logPath);
    }
    for (const path of this.updateGeneratedFiles()) changed.add(path);
    return Array.from(changed);
  }

  updateGeneratedFiles(): string[] {
    const changed: string[] = [];
    const context = this.renderContext();
    for (const file of this.generatedFiles) {
      const path = normalizeMarkdownWikiPath(file.path);
      this.writeFile(path, file.render(context));
      changed.push(path);
    }
    return changed;
  }

  appendLog(entry: MarkdownWikiLogEntry): void {
    this.ensureSupportFiles();
    const current = this.config.store.readFile(this.logPath)?.trimEnd() || "# Wiki Log";
    const affected = entry.affectedFiles?.length ? ` | updated: ${entry.affectedFiles.join(", ")}` : "";
    this.writeFile(this.logPath, `${current}\n\n## [${this.dateOnly()}] ${entry.action} | ${entry.details}${affected}\n`);
  }

  recordRelationships(relationships: MarkdownWikiRelationship[]): number {
    this.ensureSupportFiles();
    const existing = this.readRelationships();
    const keys = new Set(existing.map((edge) => relationshipKey(edge)));
    const next = [...existing];
    let added = 0;

    for (const relationship of relationships) {
      const edge = { ...relationship, date: relationship.date ?? this.dateOnly() };
      const key = relationshipKey(edge);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(edge);
      added += 1;
    }

    const content = next.map((edge) => JSON.stringify(edge)).join("\n") + (next.length ? "\n" : "");
    this.writeFile(this.relationshipsPath, content);
    return added;
  }

  readRelationships(): MarkdownWikiRelationship[] {
    const content = this.config.store.readFile(this.relationshipsPath) ?? "";
    const relationships: MarkdownWikiRelationship[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        relationships.push(JSON.parse(trimmed) as MarkdownWikiRelationship);
      } catch {
        continue;
      }
    }
    return relationships;
  }

  lint(): MarkdownWikiLintReport {
    const issues: MarkdownWikiIssue[] = [];
    issues.push(...this.checkSupportFiles());
    issues.push(...this.checkBrokenWikiLinks());
    issues.push(...this.checkRelationships());
    issues.push(...this.checkPinnedMemory());
    return {
      generatedAt: this.nowIso(),
      issueCount: issues.length,
      criticalCount: issues.filter((issue) => issue.severity === "critical").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
      issues
    };
  }

  managedPaths(): string[] {
    return Array.from(
      new Set([
        ...this.requiredFiles.map((file) => normalizeMarkdownWikiPath(file.path)),
        ...this.generatedFiles.map((file) => normalizeMarkdownWikiPath(file.path)),
        this.logPath,
        this.relationshipsPath
      ])
    );
  }

  renderIndex(options?: MarkdownWikiIndexRenderOptions): string {
    return renderMarkdownWikiIndex({
      files: this.config.store.listFiles(),
      categorizePath: this.config.categorizePath,
      summarizeContent: this.config.summarizeContent,
      metadata: this.config.metadata,
      options
    });
  }

  private renderContext(): MarkdownWikiEngineRenderContext {
    return {
      files: this.config.store.listFiles(),
      nowIso: this.nowIso(),
      date: this.dateOnly(),
      metadata: this.config.metadata ?? {},
      readRelationships: () => this.readRelationships(),
      renderIndex: (options) => this.renderIndex(options)
    };
  }

  private checkPinnedMemory(): MarkdownWikiIssue[] {
    if (!this.config.pinned) return [];
    const pinned = collectPinnedMemory(this.config.store.listFiles(), this.config.pinned);
    const issues: MarkdownWikiIssue[] = [];
    if (pinned.overBudget) {
      issues.push({
        id: "pinned-over-budget",
        severity: "warning",
        category: "pinned-memory",
        file: this.config.pinned.prefix ?? pinned.omitted.find((o) => o.reason === "over_budget")?.path ?? "",
        message: `Pinned memory needs ${pinned.requestedChars} characters but the budget is ${pinned.maxChars}; ${pinned.omitted.filter((o) => o.reason === "over_budget").length} page(s) are left out of every session.`,
        suggestion: "Condense the pinned pages or move detail into regular pages that are searched on demand."
      });
    }
    for (const omission of pinned.omitted) {
      if (omission.reason === "untrusted") {
        issues.push({
          id: `pinned-untrusted-${omission.path}`,
          severity: "warning",
          category: "pinned-memory",
          file: omission.path,
          message: "Pinned page has untrusted provenance and is excluded from the always-loaded tier.",
          suggestion: "Review the page; rewrite it from a trusted session if it should stay pinned."
        });
      } else if (omission.reason === "missing") {
        issues.push({
          id: `pinned-missing-${omission.path}`,
          severity: "warning",
          category: "pinned-memory",
          file: omission.path,
          message: "Pinned page does not exist.",
          suggestion: "Create the page or remove it from the pinned paths."
        });
      }
    }
    return issues;
  }

  private checkSupportFiles(): MarkdownWikiIssue[] {
    return this.requiredFiles
      .map((file) => normalizeMarkdownWikiPath(file.path))
      .filter((path) => !this.hasFile(path))
      .map((path) => ({
        id: `missing-support-${path}`,
        severity: "critical" as const,
        category: "support-files",
        file: path,
        message: "Required markdown wiki support file is missing.",
        suggestion: "Run the markdown wiki sync step to regenerate support files."
      }));
  }

  private checkBrokenWikiLinks(): MarkdownWikiIssue[] {
    const issues: MarkdownWikiIssue[] = [];
    const files = this.config.store.listFiles();
    const paths = new Set(files.map((file) => normalizeMarkdownWikiPath(file.path)));
    const slugs = new Set(
      files.map((file) =>
        normalizeMarkdownWikiPath(file.path)
          .split("/")
          .pop()
          ?.replace(/\.md$/, "")
      )
    );
    const linkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

    for (const file of files) {
      let match: RegExpExecArray | null;
      while ((match = linkRe.exec(file.content))) {
        const target = normalizeMarkdownWikiPath(match[1]);
        if (!paths.has(target) && !paths.has(`${target}.md`) && !slugs.has(target)) {
          issues.push({
            id: `broken-link-${file.path}-${target}`,
            severity: "warning",
            category: "links",
            file: file.path,
            message: `Wikilink [[${target}]] does not resolve to a known markdown wiki file.`,
            suggestion: "Create the target file or update the link."
          });
        }
      }
    }

    return issues;
  }

  private checkRelationships(): MarkdownWikiIssue[] {
    const issues: MarkdownWikiIssue[] = [];
    const paths = new Set(this.config.store.listFiles().map((file) => normalizeMarkdownWikiPath(file.path)));
    const validTypes = new Set(this.config.relationshipTypes ?? []);
    const content = this.config.store.readFile(this.relationshipsPath) ?? "";

    content.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let edge: MarkdownWikiRelationship;
      try {
        edge = JSON.parse(trimmed) as MarkdownWikiRelationship;
      } catch {
        issues.push({
          id: `invalid-edge-json-${index}`,
          severity: "critical",
          category: "graph",
          file: this.relationshipsPath,
          message: "Relationship edge is not valid JSON.",
          suggestion: "Regenerate or remove the malformed relationship line."
        });
        return;
      }

      if (!edge.from || !edge.to || !edge.type) {
        issues.push({
          id: `invalid-edge-${index}`,
          severity: "critical",
          category: "graph",
          file: this.relationshipsPath,
          message: "Relationship edge is missing from, to, or type.",
          suggestion: "Regenerate the relationship with all required fields."
        });
      }

      if (validTypes.size > 0 && !validTypes.has(edge.type)) {
        issues.push({
          id: `unknown-edge-type-${index}`,
          severity: "warning",
          category: "graph",
          file: this.relationshipsPath,
          message: `Unknown relationship type: ${edge.type}.`,
          suggestion: "Use one of the relationship types defined by this markdown wiki layout."
        });
      }

      for (const endpoint of [edge.from, edge.to]) {
        const normalized = normalizeMarkdownWikiPath(endpoint);
        if (normalized.endsWith(".md") && !paths.has(normalized)) {
          issues.push({
            id: `dangling-edge-${index}-${normalized}`,
            severity: "warning",
            category: "graph",
            file: this.relationshipsPath,
            message: `Relationship references missing file ${normalized}.`,
            suggestion: "Create the target file or remove the relationship."
          });
        }
      }
    });

    return issues;
  }

  private hasFile(path: string): boolean {
    const normalized = normalizeMarkdownWikiPath(path);
    return this.config.store.listFiles().some((file) => normalizeMarkdownWikiPath(file.path) === normalized);
  }

  private writeFile(path: string, content: string): void {
    this.config.store.writeFile(normalizeMarkdownWikiPath(path), content);
  }

  private nowIso(): string {
    return this.config.clock?.() ?? new Date().toISOString();
  }

  private dateOnly(): string {
    return this.nowIso().slice(0, 10);
  }
}

function relationshipKey(edge: Pick<MarkdownWikiRelationship, "from" | "to" | "type">): string {
  return `${edge.from}|${edge.to}|${edge.type}`;
}

function renderMetadata(metadata: Record<string, string | undefined>, labels: Record<string, string>): string {
  return Object.entries(metadata)
    .filter(([, value]) => value)
    .map(([key, value]) => `${labels[key] ?? titleCase(key)}: ${value}`)
    .join("  \n");
}

function defaultCategoryForPath(path: string): string {
  const normalized = normalizeMarkdownWikiPath(path);
  if (normalized.startsWith("graph/")) return "Graph";
  if (normalized.startsWith("raw/")) return "Raw Sources";
  if (normalized.startsWith("sessions/")) return "Sessions";
  if (normalized.startsWith("outputs/")) return "Outputs";
  return "Core";
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
