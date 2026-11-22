// ---------------------------------------------------------------------------
// Policy front-matter — a small, dependency-free subset of YAML.
//
// A policy file may start with a front-matter block:
//
//   ---
//   appliesTo: [passport, id-card]
//   severity: error
//   component: document-pipeline
//   outputSchema: identity.schema.json
//   examples:
//     - examples/passport-ok.md
//     - examples/passport-expired.md
//   ---
//   <policy body>
//
// Supported: `key: value`, `key: [a, b]` flow lists, `key:` followed by
// `  - item` block lists, optional single/double quotes, `#` comment lines.
// Nested maps are not supported.
//
// Detection keeps today's behaviour for files without front-matter: a block
// counts as front-matter only when the first line is exactly `---`, a closing
// `---` line exists, and the first non-comment line looks like `key:`. Once a
// block counts as front-matter, any line that does not parse is an error.
// ---------------------------------------------------------------------------

export type PolicySeverity = "info" | "warning" | "error";
export const POLICY_SEVERITIES: readonly PolicySeverity[] = ["info", "warning", "error"];

export type PolicyFrontMatter = {
  /** Document labels/types this policy applies to. A scalar becomes a one-item list. */
  appliesTo?: string[];
  /** Default severity for this policy's rules. */
  severity?: PolicySeverity;
  /** JSON Schema file for the expected output, relative to the policy file. */
  outputSchema?: string;
  /** Which component consumes the policy (free text, e.g. "document-pipeline"). */
  component?: string;
  /** Example files (few-shot material), relative to the policy file. */
  examples?: string[];
  /** Keys this package does not interpret, kept verbatim. */
  extra: Record<string, string | string[]>;
};

export type ParsedPolicyFile = {
  /** Undefined when the file has no front-matter. */
  frontMatter?: PolicyFrontMatter;
  /** The policy body: the whole file when there is no front-matter. */
  body: string;
};

export class PolicyFrontMatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyFrontMatterError";
  }
}

const KEY_LINE = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/;
const LIST_ITEM = /^\s+-\s+(.*)$/;

/** Split a policy file into front-matter and body. Throws PolicyFrontMatterError on a broken block. */
export function parsePolicyFile(raw: string): ParsedPolicyFile {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { body: raw };
  const close = lines.findIndex((line, i) => i > 0 && (line === "---" || line === "..."));
  if (close < 0) return { body: raw };

  const block = lines.slice(1, close);
  const firstContent = block.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (firstContent === undefined || !KEY_LINE.test(firstContent)) return { body: raw };

  const values = parseBlock(block);
  const body = lines.slice(close + 1).join(text.includes("\r\n") ? "\r\n" : "\n");
  return { frontMatter: interpret(values), body };
}

function parseBlock(block: string[]): Map<string, string | string[]> {
  const values = new Map<string, string | string[]>();
  let listKey: string | undefined;
  block.forEach((line, i) => {
    const where = `front-matter line ${i + 2}`;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (!listKey) throw new PolicyFrontMatterError(`${where}: list item without a "key:" line above it.`);
      (values.get(listKey) as string[]).push(unquote(item[1]!.trim()));
      return;
    }
    const keyLine = KEY_LINE.exec(line);
    if (!keyLine) throw new PolicyFrontMatterError(`${where}: expected "key: value", got "${line.trim()}".`);
    const key = keyLine[1]!;
    if (values.has(key)) throw new PolicyFrontMatterError(`${where}: duplicate key "${key}".`);
    const value = (keyLine[2] ?? "").trim();
    if (value === "") {
      values.set(key, []);
      listKey = key;
      return;
    }
    listKey = undefined;
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) throw new PolicyFrontMatterError(`${where}: unclosed list for "${key}".`);
      const inner = value.slice(1, -1).trim();
      values.set(key, inner === "" ? [] : inner.split(",").map((part) => unquote(part.trim())));
      return;
    }
    if (value.startsWith("{")) throw new PolicyFrontMatterError(`${where}: nested maps are not supported ("${key}").`);
    values.set(key, unquote(value));
  });
  return values;
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

function interpret(values: Map<string, string | string[]>): PolicyFrontMatter {
  const out: PolicyFrontMatter = { extra: {} };
  for (const [key, value] of values) {
    switch (key) {
      case "appliesTo":
        out.appliesTo = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
        break;
      case "severity": {
        const severity = scalar(key, value);
        if (!POLICY_SEVERITIES.includes(severity as PolicySeverity)) {
          throw new PolicyFrontMatterError(
            `"severity" must be one of ${POLICY_SEVERITIES.join(", ")}; got "${severity}".`,
          );
        }
        out.severity = severity as PolicySeverity;
        break;
      }
      case "outputSchema":
        out.outputSchema = scalar(key, value);
        break;
      case "component":
        out.component = scalar(key, value);
        break;
      case "examples":
        out.examples = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
        break;
      default:
        out.extra[key] = value;
    }
  }
  return out;
}

function scalar(key: string, value: string | string[]): string {
  if (Array.isArray(value) || value === "") {
    throw new PolicyFrontMatterError(`"${key}" must be a single non-empty value.`);
  }
  return value;
}
