// ---------------------------------------------------------------------------
// Tests: the execution context passed to tools as the fifth `execute` argument.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { runAgent, type AgentTool, type ToolExecutionContext } from "../src/index.js";
import { createReplayModel, recordTool, replyText, replyToolCalls, type ReplayModel, type ReplayStep } from "../src/testing.js";

const models: ReplayModel[] = [];
afterEach(() => {
  while (models.length) models.pop()!.dispose();
});

function script(...steps: ReplayStep[]): ReplayModel {
  const replay = createReplayModel(steps);
  models.push(replay);
  return replay;
}

function contextTool(name: string, seen: ToolExecutionContext[]): AgentTool {
  return {
    name,
    label: name,
    description: `Records its context (${name}).`,
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, context) => {
      seen.push(context!);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

test("tools receive the call id, turn, session id and the request as sent", async () => {
  const seen: ToolExecutionContext[] = [];
  const probe = contextTool("probe", seen);
  const replay = script(
    replyToolCalls([{ name: "probe", id: "c1" }]),
    replyToolCalls([{ name: "probe", id: "c2" }]),
    replyText("done"),
  );
  const result = await runAgent({
    systemPrompt: "base",
    model: replay.model,
    tools: [probe],
    prompt: "go",
    sessionId: "s-1",
    reasoning: "low",
  });
  assert.equal(result.reason, "completed");
  assert.deepEqual(
    seen.map((c) => [c.toolCallId, c.turn, c.sessionId]),
    [
      ["c1", 1, "s-1"],
      ["c2", 2, "s-1"],
    ],
  );
  for (const [i, context] of seen.entries()) {
    const request = context.request!;
    assert.equal(request.model, replay.model);
    assert.equal(request.reasoning, "low");
    assert.equal(request.systemPrompt, replay.calls[i]!.systemPrompt);
    assert.deepEqual(request.tools.map((t) => t.name), replay.calls[i]!.tools!.map((t) => t.name));
    assert.deepEqual(request.messages, replay.calls[i]!.messages);
    assert.ok(Object.isFrozen(request.messages) && Object.isFrozen(request.tools));
  }
  // The snapshot of turn 1 does not grow with the transcript.
  assert.equal(seen[0]!.request!.messages.length, 1);
  assert.equal(seen[1]!.request!.messages.length, 3);
});

test("the request reflects prepareStep overrides; one snapshot per batch", async () => {
  const seen: ToolExecutionContext[] = [];
  const a = contextTool("a", seen);
  const b = contextTool("b", seen);
  const hidden = contextTool("hidden", seen);
  const replay = script(
    replyToolCalls([
      { name: "a", id: "x1" },
      { name: "b", id: "x2" },
    ]),
    replyText("done"),
  );
  await runAgent({
    systemPrompt: "base",
    model: replay.model,
    tools: [a, b, hidden],
    prompt: "go",
    prepareStep: () => ({ systemPrompt: "stepped", activeTools: ["b", "a"] }),
  });
  assert.equal(seen.length, 2);
  const [first, second] = seen;
  assert.equal(first!.request, second!.request, "tools of one batch share the snapshot");
  assert.equal(first!.request!.systemPrompt, "stepped");
  assert.deepEqual(first!.request!.tools.map((t) => t.name), replay.calls[0]!.tools!.map((t) => t.name));
  assert.equal(first!.request!.tools.some((t) => t.name === "hidden"), false);
  assert.equal(first!.sessionId, undefined, "no session id when the run has none");
  assert.equal(first!.request!.reasoning, undefined);
});

test("pending calls resumed from a saved state get a context without a request", async () => {
  const seen: ToolExecutionContext[] = [];
  const probe = contextTool("probe", seen);
  const replay = script(replyToolCalls([{ name: "probe", id: "p1" }]), replyText("done"));
  const first = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools: [probe],
    prompt: "go",
    beforeToolCall: () => ({ action: "ask" }),
  });
  assert.equal(first.reason, "interrupted");
  assert.equal(seen.length, 0);

  const resumed = await runAgent({
    systemPrompt: "s",
    model: replay.model,
    tools: [probe],
    resumeFrom: first.state,
    approvals: { p1: { approve: true } },
  });
  assert.equal(resumed.reason, "completed");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolCallId, "p1");
  assert.equal(seen[0]!.turn, 1);
  assert.equal(seen[0]!.request, undefined);
});

test("recordTool forwards and records the context; tools that ignore it are unaffected", async () => {
  const plain: AgentTool = {
    name: "plain",
    label: "plain",
    description: "Ignores the context.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "fine" }], details: {} }),
  };
  const recorded = recordTool(plain);
  const replay = script(replyToolCalls([{ name: "plain", id: "r1" }]), replyText("done"));
  const result = await runAgent({ systemPrompt: "s", model: replay.model, tools: [recorded.tool], prompt: "go", sessionId: "rs" });
  assert.equal(result.reason, "completed");
  assert.equal(recorded.calls[0]!.context?.toolCallId, "r1");
  assert.equal(recorded.calls[0]!.context?.sessionId, "rs");
  assert.equal(recorded.calls[0]!.result?.content[0]?.type, "text");
});
