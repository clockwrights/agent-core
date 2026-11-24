// ---------------------------------------------------------------------------
// Tests: parent-side delegation guidance and brief template (opt-in).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ORCHESTRATION_POLICY,
  buildDelegationBrief,
  buildDelegationGuidance,
  createInMemoryChildRunRegistry,
  delegateTaskParameters,
  runOrchestrator
} from "@maya-ai/agent-loop-orchestration";
import type { ToolAgentInput, ToolLlmAdapter } from "@maya-ai/agent-loop-core";

test("guidance covers effort scaling, the five-part brief and partial results", () => {
  const text = buildDelegationGuidance();
  assert.ok(text.startsWith("[Delegation Guidance]"));
  for (const part of ["1. Objective", "2. Context", "3. Deliverable", "4. Scope", "5. Done when"]) {
    assert.ok(text.includes(part), `missing ${part}`);
  }
  assert.match(text, /do the work yourself; do not delegate/);
  assert.match(text, /"partial" means it stopped at a limit/);
  assert.equal(text.includes("\n\n"), false, "one block, no blank lines");
});

test("guidance reflects the policy's batch and concurrency limits", () => {
  const text = buildDelegationGuidance({ ...DEFAULT_ORCHESTRATION_POLICY, maxBatchTasks: 5, maxConcurrentChildren: 4 });
  assert.match(text, /at most 5 per call; 4 run at once/);
});

test("brief template renders the given parts in order and skips empty ones", () => {
  const brief = buildDelegationBrief({
    objective: "Find the three most cited papers on X.",
    context: "  ",
    deliverable: "Bullet list with title, year and citation count.",
    doneWhen: "Three papers found or ten sources checked."
  });
  assert.equal(
    brief,
    [
      "[Objective]\nFind the three most cited papers on X.",
      "[Deliverable]\nBullet list with title, year and citation count.",
      "[Done When]\nThree papers found or ten sources checked."
    ].join("\n\n")
  );
});

test("delegate tool describes maxTokens as a per-call output cap", () => {
  const props = (delegateTaskParameters as unknown as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props.maxTokens!.description ?? "", /Maximum output tokens per model call/);
});

async function parentSystemPromptSeen(appendDelegationGuidance: boolean | undefined): Promise<string> {
  const inputs: ToolAgentInput[] = [];
  const llm: ToolLlmAdapter = {
    metadata: () => ({ enabled: true }),
    runToolAgent: async (input) => {
      inputs.push(input);
      return { text: "done", toolCalls: [] };
    }
  };
  await runOrchestrator({
    parentRunId: "p-1",
    parentObjective: "objective",
    parentSystemPrompt: "BASE PROMPT",
    parentPrompt: "do it",
    parentTools: [],
    llm,
    registry: createInMemoryChildRunRegistry(),
    clock: () => "2026-01-01T00:00:00.000Z",
    ...(appendDelegationGuidance === undefined ? {} : { appendDelegationGuidance })
  });
  return inputs[0]!.systemPrompt;
}

test("runOrchestrator: guidance is appended only when asked", async () => {
  assert.equal(await parentSystemPromptSeen(undefined), "BASE PROMPT", "default: prompt used as given");
  assert.equal(await parentSystemPromptSeen(false), "BASE PROMPT");
  const withGuidance = await parentSystemPromptSeen(true);
  assert.equal(withGuidance, `BASE PROMPT\n\n${buildDelegationGuidance(DEFAULT_ORCHESTRATION_POLICY)}`);
});
