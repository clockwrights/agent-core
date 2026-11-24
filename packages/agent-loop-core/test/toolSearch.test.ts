import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { runToolAgent, type AgentMessage, type AgentTool, type PrepareStepResult } from "@maya-ai/tool-agent-runtime";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
import { collectEvents, createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";
import { createMcpToolDefinitions, createToolSearch, toolSearchToolName, type McpRuntime, type RegisteredTool } from "../src/index.js";

const calls: string[] = [];
function tool(name: string, description: string, params: string[] = []): AgentTool<any> {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object(Object.fromEntries(params.map((p) => [p, Type.Optional(Type.String())]))),
    execute: async () => {
      calls.push(name);
      return { content: [{ type: "text", text: `${name} ran` }], details: {} };
    }
  };
}

function catalog(): RegisteredTool[] {
  return [
    { tool: tool("answer", "Answer the user directly."), metadata: { source: "domain", risk: "read" } },
    { tool: tool("calendar_createEvent", "Create a calendar event.", ["title", "startsAt"]), metadata: { source: "mcp", risk: "external", deferred: true } },
    { tool: tool("calendar_listEvents", "List upcoming calendar events.", ["from", "to"]), metadata: { source: "mcp", risk: "external", deferred: true } },
    { tool: tool("mail_send", "Send an email message.", ["to", "subject"]), metadata: { source: "mcp", risk: "external", deferred: true } },
    { tool: tool("files_search", "Search documents by keyword.", ["query"]), metadata: { source: "domain", risk: "read" } }
  ];
}

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const step = (search: ReturnType<typeof createToolSearch>, turn: number, steps = 0) =>
  search.prepareStep({ turn, steps: Array.from({ length: steps }) as never, messages: [] }) as PrepareStepResult;

test("nothing deferred: tools unchanged, no tool_search, hook is a no-op", () => {
  const plain: RegisteredTool[] = [{ tool: tool("a", "A."), metadata: { source: "domain", risk: "read" } }];
  const search = createToolSearch(plain);
  assert.deepEqual(search.tools.map((t) => t.name), ["a"]);
  assert.equal(search.prepareStep({ turn: 1, steps: [], messages: [] }), undefined);
});

test("deferred tools are hidden behind tool_search; metadata and the deferred option both count", () => {
  const search = createToolSearch(catalog(), { deferred: ["files_search"] });
  assert.deepEqual(search.deferredNames, ["calendar_createEvent", "calendar_listEvents", "mail_send", "files_search"]);
  assert.ok(search.tools.some((t) => t.name === toolSearchToolName));
  assert.deepEqual(search.definitions.at(-1)!.metadata, { source: "system", risk: "read" });
  assert.deepEqual(step(search, 1).activeTools, ["answer", toolSearchToolName]);
  const searchTool = search.tools.find((t) => t.name === toolSearchToolName)!;
  assert.match(searchTool.description, /Search 4 additional tools/);
});

test("keyword search ranks by relevance, splits camelCase/snake_case and loads matches", async () => {
  const search = createToolSearch(catalog());
  const searchTool = search.tools.find((t) => t.name === toolSearchToolName)!;
  const result = await searchTool.execute("s", { query: "create a calendar event", limit: 2 });
  assert.deepEqual(result.details.matches, ["calendar_createEvent", "calendar_listEvents"]);
  assert.match(text(result), /- calendar_createEvent: Create a calendar event\. \(parameters: title, startsAt\)/);
  assert.deepEqual(search.discovered, ["calendar_createEvent", "calendar_listEvents"]);
  assert.deepEqual(step(search, 2, 1).activeTools, [
    "answer",
    "files_search",
    toolSearchToolName,
    "calendar_createEvent",
    "calendar_listEvents"
  ]);

  const bySubject = await searchTool.execute("s", { query: "subject" });
  assert.deepEqual(bySubject.details.matches, ["mail_send"], "parameter names are searchable");
  const none = await searchTool.execute("s", { query: "weather forecast" });
  assert.deepEqual(none.details.matches, []);
  assert.match(text(none), /No tools match "weather forecast"/);
});

test("regex mode matches names and descriptions; bad or huge patterns are errors", async () => {
  const search = createToolSearch(catalog());
  const searchTool = search.tools.find((t) => t.name === toolSearchToolName)!;
  const result = await searchTool.execute("s", { query: "^calendar_", mode: "regex" });
  assert.deepEqual(result.details.matches, ["calendar_createEvent", "calendar_listEvents"]);
  await assert.rejects(searchTool.execute("s", { query: "(unclosed", mode: "regex" }), /Invalid regex/);
  await assert.rejects(searchTool.execute("s", { query: "a".repeat(201), mode: "regex" }), /longer than 200/);
});

test("discoveries reset at the start of each run", async () => {
  const search = createToolSearch(catalog());
  const searchTool = search.tools.find((t) => t.name === toolSearchToolName)!;
  await searchTool.execute("s", { query: "email" });
  assert.deepEqual(search.discovered, ["mail_send"]);
  step(search, 1, 0);
  assert.deepEqual(search.discovered, []);
});

test("end to end: hidden until searched, then callable", async () => {
  calls.length = 0;
  const search = createToolSearch(catalog());
  const replay = createReplayModel([
    replyToolCalls([{ name: "mail_send", id: "early" }]),
    replyToolCalls([{ name: toolSearchToolName, arguments: { query: "send email" }, id: "s" }]),
    replyToolCalls([{ name: "mail_send", arguments: { to: "a@example.test" }, id: "late" }]),
    replyText("sent")
  ]);
  const events = collectEvents();
  await runToolAgent(
    { systemPrompt: "s", model: replay.model, tools: search.tools, prompt: "email the team", prepareStep: search.prepareStep },
    events.emit
  );
  replay.dispose();

  assert.deepEqual(replay.calls[0]!.tools!.map((t) => t.name), ["answer", "files_search", toolSearchToolName]);
  assert.deepEqual(
    replay.calls[2]!.tools!.map((t) => t.name),
    ["answer", "mail_send", "files_search", toolSearchToolName],
    "the discovered tool is offered; the other deferred tools stay hidden"
  );
  const results = events.ofType("agent_end")[0]!.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
  assert.equal(results[0]!.isError, true, "calling a hidden tool before searching fails");
  assert.match((results[0]!.content[0] as { text: string }).text, /Tool "mail_send" not found/);
  assert.equal(results[2]!.isError, false);
  assert.deepEqual(calls, ["mail_send"], "the hidden tool only ran after it was found");
});

test("createMcpToolDefinitions marks tools deferred for all or selected servers", async () => {
  const runtime = {
    getCatalog: async () => ({
      generatedAt: "t",
      servers: {},
      diagnostics: [],
      tools: [
        { serverName: "calendar", toolName: "create", inputSchema: { type: "object", properties: {} } },
        { serverName: "mail", toolName: "send", inputSchema: { type: "object", properties: {} } }
      ]
    }),
    callTool: async () => ({ content: [] }),
    dispose: async () => {}
  } as unknown as McpRuntime;

  const none = await createMcpToolDefinitions(runtime);
  assert.equal(none.some((d) => d.metadata.deferred), false);
  const all = await createMcpToolDefinitions(runtime, { defer: true });
  assert.ok(all.every((d) => d.metadata.deferred === true));
  const some = await createMcpToolDefinitions(runtime, { defer: ["mail"] });
  assert.deepEqual(some.map((d) => d.metadata.deferred === true), [false, true]);
});
