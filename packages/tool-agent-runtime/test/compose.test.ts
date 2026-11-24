// ---------------------------------------------------------------------------
// Tests: composePrepareSteps.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { composePrepareSteps, type PrepareStep, type PrepareStepContext } from "../src/index.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const context = (messages: Message[] = [user("a"), user("b"), user("c")]): PrepareStepContext => ({
  turn: 2,
  steps: [],
  messages
});

test("compose: no hooks, or hooks returning nothing → undefined", async () => {
  assert.equal(await composePrepareSteps()(context()), undefined);
  assert.equal(await composePrepareSteps(undefined, () => undefined)(context()), undefined);
});

test("compose: last scalar wins, activeTools intersect, messages chain", async () => {
  const seen: number[] = [];
  const dropFirst: PrepareStep = ({ messages }) => ({ messages: messages.slice(1), systemPrompt: "first" });
  const dropLast: PrepareStep = async ({ messages }) => {
    seen.push(messages.length);
    return { messages: messages.slice(0, -1), activeTools: ["a", "b", "c"], reasoning: "low" };
  };
  const narrow: PrepareStep = () => ({ activeTools: ["c", "b", "z"], systemPrompt: "last", reasoning: "high" });

  const result = await composePrepareSteps(dropFirst, dropLast, narrow)(context());
  assert.deepEqual(seen, [2], "the second hook saw the first hook's messages");
  assert.deepEqual(result?.messages?.map((m) => m.content), ["b"]);
  assert.deepEqual(result?.activeTools, ["b", "c"], "intersection, in the first list's order");
  assert.equal(result?.systemPrompt, "last");
  assert.equal(result?.reasoning, "high");
});
