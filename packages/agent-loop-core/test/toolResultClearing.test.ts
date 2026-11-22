import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentMessage, AgentTool, PrepareStepResult } from "@maya-ai/tool-agent-runtime";
import { createReplayModel, replyText, replyToolCalls } from "@maya-ai/tool-agent-runtime/testing";
import {
  DEFAULT_CLEARING_EXCLUDED_TOOLS,
  createRuntimeToolLlmAdapter,
  createToolOutputStore,
  createToolResultClearing,
  type ToolResultClearingOptions
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------

type Turn = { tool: string; text?: string; isError?: boolean; image?: boolean };

function transcript(turns: Turn[]): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: "go", timestamp: 0 }];
  turns.forEach((turn, i) => {
    const id = `t${i + 1}`;
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id, name: turn.tool, arguments: {} }],
      api: "x",
      provider: "x",
      model: "x",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0
    });
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: turn.tool,
      content: [
        { type: "text", text: turn.text ?? `${turn.tool} output ${i + 1} `.padEnd(300, "x") },
        ...(turn.image ? [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }] : [])
      ],
      isError: turn.isError ?? false,
      timestamp: 0
    });
  });
  return messages;
}

const turns = (n: number, tool = "search"): Turn[] => Array.from({ length: n }, () => ({ tool }));

function apply(messages: AgentMessage[], options: ToolResultClearingOptions): AgentMessage[] | undefined {
  const result = createToolResultClearing(options)({ turn: 1, steps: [], messages }) as PrepareStepResult | undefined;
  return result?.messages;
}

const resultTexts = (messages: AgentMessage[]) =>
  messages
    .filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
    .map((m) => (m.content[0] as { text: string }).text);

const isStub = (text: string) => text.startsWith("[Earlier ");

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test("no override until a full batch of turns has aged out", () => {
  assert.equal(apply(transcript(turns(3)), { keepRecentTurns: 2, batchTurns: 2 }), undefined, "only 1 clearable");
  const edited = apply(transcript(turns(4)), { keepRecentTurns: 2, batchTurns: 2 })!;
  assert.deepEqual(resultTexts(edited).map(isStub), [true, true, false, false]);
});

test("batching: the boundary moves in steps, so the cleared prefix is stable between steps", () => {
  const options = { keepRecentTurns: 2, batchTurns: 2 };
  const at4 = apply(transcript(turns(4)), options)!;
  const at5 = apply(transcript(turns(5)), options)!;
  const at6 = apply(transcript(turns(6)), options)!;

  assert.deepEqual(resultTexts(at5).map(isStub), [true, true, false, false, false]);
  assert.deepEqual(resultTexts(at6).map(isStub), [true, true, true, true, false, false]);
  assert.deepEqual(at5.slice(0, at4.length), at4, "same prefix at 4 and 5 turns → prompt cache keeps hitting");
});

test("stub names the tool and the size removed; transcript objects are not mutated", () => {
  const messages = transcript(turns(2));
  const before = JSON.stringify(messages);
  const edited = apply(messages, { keepRecentTurns: 1, batchTurns: 1 })!;

  assert.match(resultTexts(edited)[0]!, /^\[Earlier search result cleared to save context \(300 characters\)\. Call the tool again if you need it\.\]$/);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(edited[1], messages[1], "assistant messages are passed through unchanged");
});

test("excluded tools, error results and short results are kept", () => {
  const messages = transcript([
    { tool: "memory_search" },
    { tool: "read_skill" },
    { tool: "search", isError: true },
    { tool: "search", text: "short" },
    { tool: "search" },
    { tool: "search" }
  ]);
  const edited = apply(messages, { keepRecentTurns: 1, batchTurns: 1, minChars: 50 })!;
  assert.deepEqual(resultTexts(edited).map(isStub), [false, false, false, false, true, false]);
  assert.ok(DEFAULT_CLEARING_EXCLUDED_TOOLS.includes("memory_get"));

  const custom = apply(messages, { keepRecentTurns: 1, batchTurns: 1, minChars: 0, excludeTools: [] })!;
  assert.deepEqual(resultTexts(custom).map(isStub), [true, true, false, true, true, false], "errors still kept");
});

test("with a store, the full text is kept and the stub points to read_tool_output; images are dropped", () => {
  const store = createToolOutputStore();
  const messages = transcript([{ tool: "fetch", image: true }, { tool: "fetch" }]);
  const original = (messages[2] as Extract<AgentMessage, { role: "toolResult" }>).content[0] as { text: string };
  const edited = apply(messages, { keepRecentTurns: 1, batchTurns: 1, store })!;

  const cleared = edited[2] as Extract<AgentMessage, { role: "toolResult" }>;
  assert.equal(cleared.content.length, 1);
  assert.match(
    (cleared.content[0] as { text: string }).text,
    /\(300 characters and images\)\. To read it again, call read_tool_output with \{"id": "t1"\}\.\]$/
  );
  assert.equal(store.get("t1"), original.text);
});

test("invalid options are rejected", () => {
  assert.throws(() => createToolResultClearing({ batchTurns: 0 }), RangeError);
  assert.throws(() => createToolResultClearing({ keepRecentTurns: -1 }), RangeError);
  assert.throws(() => createToolResultClearing({ minChars: 1.5 }), RangeError);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("end to end: the model sees stubs for old results while the transcript keeps them", async () => {
  const params = Type.Object({});
  const search: AgentTool<typeof params> = {
    name: "search",
    label: "Search",
    description: "Search.",
    parameters: params,
    execute: async (id) => ({ content: [{ type: "text", text: `big result ${id} `.padEnd(400, ".") }], details: {} })
  };
  const replay = createReplayModel([
    replyToolCalls([{ name: "search", id: "s1" }]),
    replyToolCalls([{ name: "search", id: "s2" }]),
    replyToolCalls([{ name: "search", id: "s3" }]),
    replyText("done")
  ]);
  const llm = createRuntimeToolLlmAdapter({
    model: replay.model,
    prepareStep: createToolResultClearing({ keepRecentTurns: 1, batchTurns: 1 })
  });
  const transcriptSeen: AgentMessage[][] = [];
  const output = await llm.runToolAgent({
    systemPrompt: "s",
    prompt: "go",
    sessionId: "x",
    tools: [search],
    onEvent: (e) => {
      if (e.type === "agent_end") transcriptSeen.push(e.messages);
    }
  });
  replay.dispose();

  assert.equal(output?.text, "done");
  const lastCall = replay.calls[3]!.messages;
  assert.deepEqual(resultTexts(lastCall).map(isStub), [true, true, false]);
  assert.deepEqual(resultTexts(transcriptSeen[0]!).map(isStub), [false, false, false], "transcript unchanged");
});
