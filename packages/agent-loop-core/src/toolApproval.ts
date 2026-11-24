import type { BeforeToolCallContext, ToolCallDecision } from "@maya-ai/tool-agent-runtime";
import type { RegisteredTool, ToolMetadata, ToolRisk } from "./toolRegistry.js";
import type { SkillEntry } from "./skills/skillTypes.js";

// Core boundary: domain-neutral. Turns registry metadata into a
// `beforeToolCall` hook for the tool-agent-runtime approval flow.

export type ToolApprovalAction = "allow" | "ask" | "deny";

/** Default action per risk: read tools run, write and external tools wait for approval. */
export const DEFAULT_RISK_APPROVAL: Readonly<Record<ToolRisk, ToolApprovalAction>> = Object.freeze({
  read: "allow",
  write: "ask",
  external: "ask"
});

export interface ToolApprovalPolicyOptions {
  /** Action per risk; unset risks use `DEFAULT_RISK_APPROVAL`. */
  risk?: Partial<Record<ToolRisk, ToolApprovalAction>>;
  /**
   * Per-tool actions by tool name. Final: they win over everything else,
   * including the escalations below.
   */
  tools?: Record<string, ToolApprovalAction>;
  /**
   * Tool names that run without asking (for example `skillAllowedTools(skills)`).
   * Still escalated to "ask" by a destructive hint or untrusted content.
   */
  preApproved?: Iterable<string>;
  /**
   * Let an MCP tool's `readOnlyHint: true` lower its risk to "read": `true`
   * for every tool, or a list of MCP server names. Default: no server. MCP
   * annotations are claims made by the server, so by default they only add
   * caution (`destructiveHint: true` turns "allow" into "ask").
   */
  trustReadOnlyHints?: boolean | string[];
  /**
   * Session taint, for example `createUntrustedOriginTracker(...)`. While
   * `origin()` is not "trusted", allowed tools whose risk is in
   * `escalateWhenUntrusted` ask instead.
   */
  untrusted?: { origin(): string; readonly sources?: readonly string[] };
  /** Risks escalated to "ask" while the session is untrusted. Default `["write", "external"]`. */
  escalateWhenUntrusted?: ToolRisk[];
  /** Action for tools missing from `definitions` (and from `tools`). Default "ask". */
  unknownTools?: ToolApprovalAction;
}

export interface EffectiveRiskOptions {
  trustReadOnlyHints?: boolean | string[];
}

/** Why a decision was made; included as `data.rule` on "ask" decisions. */
export type ToolApprovalRule = "tool" | "risk" | "pre-approved" | "destructive-hint" | "untrusted" | "unknown-tool";

/**
 * A tool's risk after MCP annotations: `metadata.risk`, lowered to "read"
 * only when the tool says `readOnlyHint: true` and its server is trusted
 * through `trustReadOnlyHints`.
 */
export function effectiveToolRisk(metadata: ToolMetadata, options: EffectiveRiskOptions = {}): ToolRisk {
  if (metadata.annotations?.readOnlyHint === true && isServerTrusted(metadata.mcpServer, options.trustReadOnlyHints)) {
    return "read";
  }
  return metadata.risk;
}

/**
 * Tool names listed in the skills' `allowed-tools`, without duplicates.
 * Entries using a pattern syntax (containing "(", for example `Bash(git:*)`)
 * are left out: only exact tool names are pre-approved.
 */
export function skillAllowedTools(skills: readonly SkillEntry[]): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const name of skill.allowedTools ?? []) {
      if (!name.includes("(")) names.add(name);
    }
  }
  return [...names];
}

/**
 * Build a `beforeToolCall` hook from registry metadata. For each call:
 * 1. a `tools` rule for the name decides, final;
 * 2. a tool missing from `definitions` gets `unknownTools` (default "ask");
 * 3. otherwise a pre-approved name is allowed, else the action for its
 *    effective risk (see `effectiveToolRisk`) applies;
 * 4. an "allow" from step 3 becomes "ask" when the tool carries an explicit
 *    `destructiveHint: true` (and no `readOnlyHint: true`), or when the
 *    session is untrusted and the risk is in `escalateWhenUntrusted`.
 * "ask" decisions carry `reason` and JSON `data` `{ rule, risk?, source?,
 * mcpServer?, untrustedSources? }`.
 */
export function createToolApprovalPolicy(
  definitions: readonly RegisteredTool[],
  options: ToolApprovalPolicyOptions = {}
): (context: BeforeToolCallContext) => ToolCallDecision {
  const riskActions: Record<ToolRisk, ToolApprovalAction> = { ...DEFAULT_RISK_APPROVAL };
  for (const [risk, action] of Object.entries(options.risk ?? {})) {
    if (!(risk in DEFAULT_RISK_APPROVAL)) throw new RangeError(`Unknown tool risk "${risk}" in approval policy.`);
    if (action !== undefined) riskActions[risk as ToolRisk] = checkAction(action, `risk.${risk}`);
  }
  const toolActions = new Map<string, ToolApprovalAction>();
  for (const [name, action] of Object.entries(options.tools ?? {})) {
    toolActions.set(name, checkAction(action, `tools.${name}`));
  }
  const unknownAction = checkAction(options.unknownTools ?? "ask", "unknownTools");
  const preApproved = new Set(options.preApproved ?? []);
  const escalate = new Set<ToolRisk>(options.escalateWhenUntrusted ?? ["write", "external"]);
  const byName = new Map<string, ToolMetadata>();
  for (const definition of definitions) {
    if (!byName.has(definition.tool.name)) byName.set(definition.tool.name, definition.metadata);
  }

  return ({ toolCall }) => {
    const name = toolCall.name;
    const ruled = toolActions.get(name);
    if (ruled !== undefined) return decide(ruled, name, { rule: "tool" }, `"${name}" requires approval`);

    const metadata = byName.get(name);
    if (!metadata) return decide(unknownAction, name, { rule: "unknown-tool" }, `"${name}" is not a registered tool`);

    const risk = effectiveToolRisk(metadata, options);
    const facts = {
      risk,
      source: metadata.source,
      ...(metadata.mcpServer !== undefined ? { mcpServer: metadata.mcpServer } : {})
    };
    const pre = preApproved.has(name);
    const action = pre ? "allow" : riskActions[risk];
    if (action !== "allow") return decide(action, name, { rule: "risk", ...facts }, `${risk} tool "${name}" requires approval`);

    if (metadata.annotations?.destructiveHint === true && metadata.annotations.readOnlyHint !== true) {
      return {
        action: "ask",
        reason: `"${name}" is marked destructive by its MCP server`,
        data: { rule: "destructive-hint", ...facts }
      };
    }
    if (options.untrusted && options.untrusted.origin() !== "trusted" && escalate.has(risk)) {
      const sources = options.untrusted.sources ?? [];
      return {
        action: "ask",
        reason:
          `the session has read untrusted content` +
          (sources.length ? ` (from ${sources.join(", ")})` : "") +
          `; ${risk} tool "${name}" requires approval`,
        data: { rule: "untrusted", ...facts, ...(sources.length ? { untrustedSources: [...sources] } : {}) }
      };
    }
    return { action: "allow" };
  };
}

function decide(
  action: ToolApprovalAction,
  name: string,
  data: Record<string, unknown> & { rule: ToolApprovalRule },
  reason: string
): ToolCallDecision {
  if (action === "allow") return { action: "allow" };
  if (action === "deny") return { action: "deny", message: `Tool "${name}" is not allowed by the approval policy.` };
  return { action: "ask", reason, data };
}

function checkAction(action: unknown, where: string): ToolApprovalAction {
  if (action === "allow" || action === "ask" || action === "deny") return action;
  throw new RangeError(`Approval policy ${where} must be "allow", "ask" or "deny", got ${JSON.stringify(action)}.`);
}

function isServerTrusted(server: string | undefined, trust: boolean | string[] | undefined): boolean {
  if (trust === true) return true;
  if (Array.isArray(trust)) return server !== undefined && trust.includes(server);
  return false;
}
