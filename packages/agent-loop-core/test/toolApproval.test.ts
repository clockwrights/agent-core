import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { runAgent, type AgentTool, type BeforeToolCallContext } from "@maya-ai/tool-agent-runtime";
import { createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";
import {
  createMcpRuntime,
  createMcpToolDefinitions,
  createToolApprovalPolicy,
  createUntrustedOriginTracker,
  DEFAULT_RISK_APPROVAL,
  effectiveToolRisk,
  externalContentToolNames,
  skillAllowedTools,
  type McpRuntime,
  type RegisteredTool,
  type SkillEntry,
  type ToolMetadata
} from "../src/index.js";

const params = Type.Object({});

function tool(name: string, calls?: string[]): AgentTool<typeof params> {
  return {
    name,
    label: name,
    description: name,
    parameters: params,
    execute: async () => {
      calls?.push(name);
      return { content: [{ type: "text", text: `${name} ok` }], details: {} };
    }
  };
}

function def(name: string, metadata: Partial<ToolMetadata> & Pick<ToolMetadata, "risk">, calls?: string[]): RegisteredTool {
  return { tool: tool(name, calls), metadata: { source: "domain", ...metadata } };
}

/** Context for a call to `name`; the policy only reads `toolCall.name`. */
function call(name: string): BeforeToolCallContext {
  return { toolCall: { id: "c1", name, arguments: {} }, tool: tool(name), turn: 1, messages: [] };
}

const defs = [
  def("search", { risk: "read" }),
  def("save_note", { risk: "write" }),
  def("web_fetch", { risk: "external" }),
  def("mcp__fs__read", { risk: "external", source: "mcp", mcpServer: "fs", annotations: { readOnlyHint: true } }),
  def("mcp__fs__rm", { risk: "external", source: "mcp", mcpServer: "fs", annotations: { destructiveHint: true } }),
  def("mcp__web__get", { risk: "external", source: "mcp", mcpServer: "web", annotations: { readOnlyHint: true } })
];

test("defaults: read tools run, write and external tools ask with reason and JSON data", () => {
  assert.deepEqual(DEFAULT_RISK_APPROVAL, { read: "allow", write: "ask", external: "ask" });
  const policy = createToolApprovalPolicy(defs);
  assert.deepEqual(policy(call("search")), { action: "allow" });
  assert.deepEqual(policy(call("save_note")), {
    action: "ask",
    reason: 'write tool "save_note" requires approval',
    data: { rule: "risk", risk: "write", source: "domain" }
  });
  const external = policy(call("mcp__fs__read"));
  assert.equal(external.action, "ask", "MCP read-only hints are not trusted by default");
  assert.deepEqual(external.action === "ask" && external.data, {
    rule: "risk",
    risk: "external",
    source: "mcp",
    mcpServer: "fs"
  });
});

test("risk actions are configurable; tools rules are final", () => {
  const tracker = { origin: () => "untrusted" };
  const policy = createToolApprovalPolicy(defs, {
    risk: { write: "allow", external: "deny" },
    tools: { search: "deny", web_fetch: "allow", save_note: "allow" },
    untrusted: tracker
  });
  assert.deepEqual(policy(call("search")), {
    action: "deny",
    message: 'Tool "search" is not allowed by the approval policy.'
  });
  assert.deepEqual(policy(call("web_fetch")), { action: "allow" }, "a tools rule is not escalated by taint");
  assert.deepEqual(policy(call("save_note")), { action: "allow" });
  assert.equal(policy(call("mcp__web__get")).action, "deny");
});

test("unknown tools ask by default; unknownTools changes that", () => {
  const asked = createToolApprovalPolicy(defs)(call("not_registered"));
  assert.equal(asked.action, "ask");
  assert.deepEqual(asked.action === "ask" && asked.data, { rule: "unknown-tool" });
  assert.equal(createToolApprovalPolicy(defs, { unknownTools: "deny" })(call("not_registered")).action, "deny");
  assert.equal(createToolApprovalPolicy(defs, { tools: { not_registered: "allow" } })(call("not_registered")).action, "allow");
});

test("skill allowed-tools become pre-approvals (exact names only)", () => {
  const skill = (name: string, allowedTools?: string[]): SkillEntry => ({
    name,
    description: name,
    filePath: `${name}/SKILL.md`,
    sourceRoot: ".",
    body: "",
    ...(allowedTools ? { allowedTools } : {})
  });
  const names = skillAllowedTools([
    skill("notes", ["save_note", "search"]),
    skill("shell", ["Bash(git:*)", "save_note"]),
    skill("none")
  ]);
  assert.deepEqual(names, ["save_note", "search"]);

  const policy = createToolApprovalPolicy(defs, { preApproved: names });
  assert.deepEqual(policy(call("save_note")), { action: "allow" });
  assert.equal(policy(call("web_fetch")).action, "ask");
});

test("MCP hints: destructive only adds caution; read-only lowers risk only for trusted servers", () => {
  const rm = defs.find((d) => d.tool.name === "mcp__fs__rm")!.metadata;
  const fsRead = defs.find((d) => d.tool.name === "mcp__fs__read")!.metadata;
  const webGet = defs.find((d) => d.tool.name === "mcp__web__get")!.metadata;

  assert.equal(effectiveToolRisk(fsRead), "external");
  assert.equal(effectiveToolRisk(fsRead, { trustReadOnlyHints: ["fs"] }), "read");
  assert.equal(effectiveToolRisk(webGet, { trustReadOnlyHints: ["fs"] }), "external");
  assert.equal(effectiveToolRisk(webGet, { trustReadOnlyHints: true }), "read");
  assert.equal(effectiveToolRisk(rm, { trustReadOnlyHints: true }), "external", "no read-only claim, no change");

  const trusting = createToolApprovalPolicy(defs, { trustReadOnlyHints: ["fs"] });
  assert.deepEqual(trusting(call("mcp__fs__read")), { action: "allow" });
  assert.equal(trusting(call("mcp__web__get")).action, "ask");

  // Even when external tools are allowed (or pre-approved), a destructive hint asks.
  const lenient = createToolApprovalPolicy(defs, { risk: { external: "allow" } });
  assert.deepEqual(lenient(call("mcp__fs__rm")), {
    action: "ask",
    reason: '"mcp__fs__rm" is marked destructive by its MCP server',
    data: { rule: "destructive-hint", risk: "external", source: "mcp", mcpServer: "fs" }
  });
  assert.equal(createToolApprovalPolicy(defs, { preApproved: ["mcp__fs__rm"] })(call("mcp__fs__rm")).action, "ask");
  assert.deepEqual(lenient(call("mcp__web__get")), { action: "allow" });
  // A hint never relaxes a deny.
  assert.equal(createToolApprovalPolicy(defs, { risk: { external: "deny" } })(call("mcp__fs__rm")).action, "deny");
});

test("untrusted content: write and external tools ask once an external tool has returned", () => {
  const tracker = createUntrustedOriginTracker(externalContentToolNames(defs));
  const policy = createToolApprovalPolicy(defs, {
    risk: { write: "allow", external: "allow" },
    untrusted: tracker
  });
  assert.deepEqual(policy(call("save_note")), { action: "allow" }, "trusted session");

  tracker.onEvent({ type: "tool_execution_end", toolCallId: "x", toolName: "web_fetch", result: undefined, isError: false } as never);
  const save = policy(call("save_note"));
  assert.deepEqual(save, {
    action: "ask",
    reason: 'the session has read untrusted content (from web_fetch); write tool "save_note" requires approval',
    data: { rule: "untrusted", risk: "write", source: "domain", untrustedSources: ["web_fetch"] }
  });
  assert.equal(policy(call("web_fetch")).action, "ask");
  assert.deepEqual(policy(call("search")), { action: "allow" }, "read tools are not escalated");

  const onlyExternal = createToolApprovalPolicy(defs, {
    risk: { write: "allow", external: "allow" },
    untrusted: tracker,
    escalateWhenUntrusted: ["external"]
  });
  assert.deepEqual(onlyExternal(call("save_note")), { action: "allow" });
  tracker.reset();
  assert.deepEqual(policy(call("web_fetch")), { action: "allow" }, "reset starts a trusted session");
  // Any origin other than "trusted" counts as untrusted.
  assert.equal(createToolApprovalPolicy(defs, { risk: { write: "allow" }, untrusted: { origin: () => "unverified" } })(call("save_note")).action, "ask");
});

test("invalid configuration is a RangeError", () => {
  assert.throws(() => createToolApprovalPolicy(defs, { risk: { write: "maybe" as never } }), /risk\.write/);
  assert.throws(() => createToolApprovalPolicy(defs, { risk: { admin: "allow" } as never }), /Unknown tool risk "admin"/);
  assert.throws(() => createToolApprovalPolicy(defs, { tools: { search: "yes" as never } }), /tools\.search/);
  assert.throws(() => createToolApprovalPolicy(defs, { unknownTools: "skip" as never }), /unknownTools/);
});

test("createMcpToolDefinitions records the server and annotations without changing risk", async () => {
  const runtime = {
    getCatalog: async () => ({
      generatedAt: "t",
      servers: {},
      diagnostics: [],
      tools: [
        { serverName: "fs", toolName: "read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        { serverName: "fs", toolName: "list", inputSchema: { type: "object", properties: {} } }
      ]
    }),
    callTool: async () => ({ content: [] }),
    dispose: async () => {}
  } as unknown as McpRuntime;
  const [read, list] = await createMcpToolDefinitions(runtime);
  assert.deepEqual(read!.metadata, { source: "mcp", risk: "external", mcpServer: "fs", annotations: { readOnlyHint: true } });
  assert.deepEqual(list!.metadata, { source: "mcp", risk: "external", mcpServer: "fs" });
});

test("a real stdio MCP server: boolean annotation hints reach the catalog and registry", async () => {
  const runtime = createMcpRuntime({
    enabled: true,
    config: {
      enabled: true,
      servers: {
        notes: {
          transport: "stdio",
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/annotatedMcpServer.mjs", import.meta.url))]
        }
      }
    }
  });
  try {
    const catalog = await runtime.getCatalog();
    assert.deepEqual(catalog.diagnostics.filter((d) => d.level === "error"), []);
    const hints = Object.fromEntries(catalog.tools.map((t) => [t.toolName, t.annotations]));
    assert.deepEqual(hints, {
      lookup: { readOnlyHint: true, openWorldHint: false },
      wipe: { destructiveHint: true, idempotentHint: true },
      plain: undefined,
      odd: undefined
    });

    const definitions = await createMcpToolDefinitions(runtime);
    const policy = createToolApprovalPolicy(definitions, { trustReadOnlyHints: ["notes"], risk: { external: "allow" } });
    assert.deepEqual(policy(call("mcp__notes__lookup")), { action: "allow" });
    assert.equal(policy(call("mcp__notes__wipe")).action, "ask");
    assert.deepEqual(policy(call("mcp__notes__plain")), { action: "allow" });
  } finally {
    await runtime.dispose();
  }
});

test("end to end: the policy pauses a write tool, an approval resumes it, reads run freely", async () => {
  const calls: string[] = [];
  const definitions = [def("search", { risk: "read" }, calls), def("save_note", { risk: "write" }, calls)];
  const tools = definitions.map((d) => d.tool);
  const beforeToolCall = createToolApprovalPolicy(definitions);
  const replay = createReplayModel([
    replyToolCalls([{ name: "search", id: "a" }]),
    replyToolCalls([{ name: "save_note", id: "b" }]),
    replyText("saved")
  ]);

  const first = await runAgent({ systemPrompt: "s", model: replay.model, tools, prompt: "go", beforeToolCall });
  assert.equal(first.reason, "interrupted");
  assert.deepEqual(calls, ["search"]);
  assert.equal(first.state.interruptions?.[0]?.toolName, "save_note");
  assert.equal(first.state.interruptions?.[0]?.reason, 'write tool "save_note" requires approval');

  const second = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools,
    beforeToolCall,
    resumeFrom: first.state,
    approvals: { b: { approve: true } }
  });
  replay.dispose();
  assert.equal(second.reason, "completed");
  assert.equal(second.text, "saved");
  assert.deepEqual(calls, ["search", "save_note"]);
});
