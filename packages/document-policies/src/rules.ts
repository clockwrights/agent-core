// ---------------------------------------------------------------------------
// Policy rule anchors and verdicts.
//
// A rule is a heading or list item in the policy body that ends with an
// anchor `{#rule-id}`:
//
//   ### Passport must be valid {#passport-valid}
//   - Expiry date is after the submission date {#passport-expiry}
//
// The anchors stay in the policy text so the model can cite them. A verdict
// cites a rule by id and carries the evidence it relied on. This module
// extracts rules, builds the citation instructions for a prompt, and checks a
// model's verdicts against the policy's rules — it does not call a model.
// ---------------------------------------------------------------------------

import type { PolicySeverity } from "./frontMatter.js";

export type PolicyRule = {
  /** Anchor id, e.g. "passport-expiry". Unique within a policy. */
  id: string;
  /** Rule text without list/heading markers and without the anchor. */
  text: string;
  /** 1-based line in the policy body where the rule starts. */
  line: number;
  /** Severity from the policy's front-matter, when set. */
  severity?: PolicySeverity;
};

export class PolicyRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRuleError";
  }
}

const RULE_ID = "[A-Za-z][A-Za-z0-9_.:-]*";
const ANCHOR_AT_END = new RegExp(`\\s*\\{#(${RULE_ID})\\}\\s*$`);
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * Extract anchored rules from a policy body. A heading rule's text includes
 * the section body up to the next heading of the same or higher level; a
 * list-item rule's text includes its indented continuation lines. Anchors
 * inside fenced code blocks are ignored. Throws PolicyRuleError on duplicate ids.
 */
export function extractPolicyRules(body: string, severity?: PolicySeverity): PolicyRule[] {
  const lines = body.split(/\r?\n/);
  const rules: PolicyRule[] = [];
  const seen = new Map<string, number>();

  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return; // anchors inside fenced code are examples, not rules
    const anchor = ANCHOR_AT_END.exec(line);
    if (!anchor) return;
    const id = anchor[1]!;
    const head = line.slice(0, anchor.index);
    const heading = HEADING.exec(head);
    const item = heading ? null : LIST_ITEM.exec(head);
    if (!heading && !item) return; // anchors only count on headings and list items

    if (seen.has(id)) {
      throw new PolicyRuleError(`duplicate rule id "${id}" on lines ${seen.get(id)} and ${i + 1}.`);
    }
    seen.set(id, i + 1);

    const parts = [(heading ? heading[2]! : item![2]!).trim()];
    if (heading) {
      const level = heading[1]!.length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = HEADING.exec(lines[j]!);
        if (next && next[1]!.length <= level) break;
        parts.push(lines[j]!);
      }
    } else {
      const indent = item![1]!.length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "" || HEADING.test(next)) break;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        parts.push(next.trim());
      }
    }
    const rule: PolicyRule = { id, text: parts.join("\n").trim(), line: i + 1 };
    if (severity !== undefined) rule.severity = severity;
    rules.push(rule);
  });
  return rules;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type PolicyVerdictOutcome = "pass" | "fail" | "not_applicable" | "uncertain";
export const POLICY_VERDICT_OUTCOMES: readonly PolicyVerdictOutcome[] = [
  "pass",
  "fail",
  "not_applicable",
  "uncertain",
];

export type PolicyEvidence = {
  /** Verbatim text the verdict relies on. */
  quote?: string;
  /** Document group / field the evidence comes from, when known. */
  groupId?: string;
  fieldName?: string;
  /** 1-based unit (page) index, when known. */
  sourceUnitIndex?: number;
};

export type PolicyVerdict = {
  ruleId: string;
  outcome: PolicyVerdictOutcome;
  evidence: PolicyEvidence[];
  note?: string;
  /** Copied from the rule, when it has one. */
  severity?: PolicySeverity;
};

export type PolicyVerdictCheck = {
  /** Verdicts that cite a known rule and are well-formed. */
  verdicts: PolicyVerdict[];
  /** Rules that received no valid verdict. */
  missingRuleIds: string[];
  /** Human-readable reasons for every dropped or questionable entry. */
  problems: string[];
};

export type CheckPolicyVerdictsOptions = {
  /**
   * Outcomes that must cite at least one evidence item. Default
   * `["pass", "fail"]`; a verdict without evidence is dropped and reported.
   */
  requireEvidenceFor?: PolicyVerdictOutcome[];
};

/**
 * Check a model's verdicts against the policy's rules. Accepts the parsed
 * value or a JSON string (optionally fenced), either an array of verdicts or
 * an object with a `verdicts` array. Never throws on model output: invalid
 * entries are dropped and listed in `problems`.
 */
export function checkPolicyVerdicts(
  output: unknown,
  rules: readonly PolicyRule[],
  options: CheckPolicyVerdictsOptions = {},
): PolicyVerdictCheck {
  const requireEvidence = new Set(options.requireEvidenceFor ?? ["pass", "fail"]);
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const problems: string[] = [];
  const verdicts: PolicyVerdict[] = [];
  const answered = new Set<string>();

  const list = toVerdictList(output, problems);
  list.forEach((entry, i) => {
    const where = `verdicts[${i}]`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${where}: not an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const ruleId = e["ruleId"];
    if (typeof ruleId !== "string" || !byId.has(ruleId)) {
      problems.push(`${where}: unknown ruleId ${JSON.stringify(ruleId)}.`);
      return;
    }
    if (answered.has(ruleId)) {
      problems.push(`${where}: second verdict for "${ruleId}" ignored.`);
      return;
    }
    const outcome = e["outcome"];
    if (!POLICY_VERDICT_OUTCOMES.includes(outcome as PolicyVerdictOutcome)) {
      problems.push(`${where} (${ruleId}): outcome must be one of ${POLICY_VERDICT_OUTCOMES.join(", ")}.`);
      return;
    }
    const evidence = toEvidence(e["evidence"]);
    if (requireEvidence.has(outcome as PolicyVerdictOutcome) && evidence.length === 0) {
      problems.push(`${where} (${ruleId}): "${String(outcome)}" without evidence.`);
      return;
    }
    const verdict: PolicyVerdict = { ruleId, outcome: outcome as PolicyVerdictOutcome, evidence };
    if (typeof e["note"] === "string" && e["note"] !== "") verdict.note = e["note"];
    const severity = byId.get(ruleId)!.severity;
    if (severity !== undefined) verdict.severity = severity;
    verdicts.push(verdict);
    answered.add(ruleId);
  });

  return {
    verdicts,
    missingRuleIds: rules.map((rule) => rule.id).filter((id) => !answered.has(id)),
    problems,
  };
}

function toVerdictList(output: unknown, problems: string[]): unknown[] {
  let value = output;
  if (typeof value === "string") {
    const json = value
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      value = JSON.parse(json);
    } catch {
      problems.push("output is not valid JSON.");
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { verdicts?: unknown }).verdicts)) {
    return (value as { verdicts: unknown[] }).verdicts;
  }
  problems.push('output must be an array of verdicts or an object with a "verdicts" array.');
  return [];
}

function toEvidence(raw: unknown): PolicyEvidence[] {
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: PolicyEvidence[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim() !== "") out.push({ quote: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const evidence: PolicyEvidence = {};
    if (typeof r["quote"] === "string" && r["quote"] !== "") evidence.quote = r["quote"];
    if (typeof r["groupId"] === "string" && r["groupId"] !== "") evidence.groupId = r["groupId"];
    if (typeof r["fieldName"] === "string" && r["fieldName"] !== "") evidence.fieldName = r["fieldName"];
    if (typeof r["sourceUnitIndex"] === "number" && Number.isInteger(r["sourceUnitIndex"])) {
      evidence.sourceUnitIndex = r["sourceUnitIndex"];
    }
    if (Object.keys(evidence).length > 0) out.push(evidence);
  }
  return out;
}

/**
 * Prompt text asking the model to answer every rule with a verdict that cites
 * the rule id and its evidence. Append it to a prompt that already contains
 * the policy text. Returns "" when the policy has no anchored rules.
 */
export function buildRuleCitationInstructions(rules: readonly PolicyRule[]): string {
  if (rules.length === 0) return "";
  const ids = rules.map((rule) => `- ${rule.id}`).join("\n");
  return [
    "Answer every rule below with one verdict. Cite the rule by its id (the {#id} anchor in the policy).",
    ids,
    "",
    'Respond with JSON: {"verdicts": [{"ruleId": "<id>", "outcome": "pass" | "fail" | "not_applicable" | "uncertain",',
    '"evidence": [{"quote": "<verbatim text>", "groupId": "<group id>", "fieldName": "<field>", "sourceUnitIndex": <page>}],',
    '"note": "<optional>"}]}',
    "Every pass or fail needs at least one evidence item quoting the document. Do not invent rule ids.",
  ].join("\n");
}
