/**
 * End-to-end integration tests for the orchestrator (Stage 8 milestone).
 *
 * These tests use a scripted LLM stub that simulates what the
 * tool-agent-runtime loop does: receive a system+user prompt and a
 * tool list, fire a sequence of tool calls in order (each tool's
 * `execute` is invoked synchronously during this call), then return the
 * `ToolAgentOutput` shape (text + tool-call summary). Each scripted
 * invocation consumes one entry from a queue.
 *
 * Behaviour exercised:
 *   1. Parent loop calls `delegate_task` N times, each spawning a real
 *      child run through `executeChildRun`.
 *   2. Children execute sequentially because `delegate_task` is
 *      blocking-inline — the parent's tool loop awaits each child
 *      before issuing the next.
 *   3. The orchestrator collects results from the registry and runs
 *      synthesis as a separate `runToolAgentLoop` call.
 *   4. Counts (`childCounts`) match registry state.
 *   5. All-failure path still produces a useful synthesis prompt.
 *   6. Mixed-success path delivers both completed and failed children
 *      to synthesis in registry order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDelegateTaskTool,
  createInMemoryChildRunRegistry,
  runOrchestrator,
  type DelegateToolContext
} from "@maya-ai/agent-loop-orchestration";

import type { AgentTool } from "@maya-ai/tool-agent-runtime";
import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";
import type {
  ToolAgentInput,
  ToolAgentOutput,
  ToolLlmAdapter
} from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Scripted LLM stub
// ---------------------------------------------------------------------------

interface ScriptedToolCall {
  toolName: string;
  args: unknown;
}

interface ScriptedTurn {
  /** Tool calls to fire (in order) during this LLM call. Each invokes the tool's execute. */
  toolCalls?: ScriptedToolCall[];
  /** Final text returned by this LLM call. Defaults to "" when only an error is scripted. */
  text?: string;
  /** When set, the call rejects with this before any tool calls fire. */
  throwError?: unknown;
}

interface ScriptedAdapter extends ToolLlmAdapter {
  calls: ToolAgentInput[];
  remainingScripts(): number;
}

function buildScriptedAdapter(scripts: ScriptedTurn[]): ScriptedAdapter {
  const calls: ToolAgentInput[] = [];
  let i = 0;
  return {
    calls,
    remainingScripts: () => Math.max(0, scripts.length - i),
    metadata: () => ({ enabled: true }),
    async runToolAgent(input) {
      calls.push(input);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i++;
      if (script.throwError !== undefined) throw script.throwError;

      const executedSummaries: ToolAgentOutput["toolCalls"] = [];
      for (const call of script.toolCalls ?? []) {
        const tool = input.tools.find((t) => t.name === call.toolName);
        if (!tool) {
          executedSummaries.push({ name: call.toolName, args: call.args, isError: true });
          continue;
        }
        try {
          await tool.execute("toolCallId-" + executedSummaries.length, call.args);
          executedSummaries.push({ name: call.toolName, args: call.args, isError: false });
        } catch {
          executedSummaries.push({ name: call.toolName, args: call.args, isError: true });
        }
      }
      return { text: script.text ?? "", toolCalls: executedSummaries };
    }
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function emptyRuntime(): AgentRuntimeContext {
  return {
    toolDefinitions: [],
    toolPolicy: {
      enabled: true,
      sources: { domain: false, mcp: false, memory: false, system: false },
      allow: [],
      deny: []
    },
    skillsPrompt: "",
    memoryPrompt: "",
    diagnostics: []
  };
}

function buildDelegateContextStub(
  llm: ToolLlmAdapter,
  registry: ReturnType<typeof createInMemoryChildRunRegistry>,
  parentRunId: string
): DelegateToolContext {
  let clockCount = 0;
  return {
    parentRunId,
    parentDepth: 0,
    llm,
    registry,
    clock: () => `2026-05-07T13:00:${String(clockCount++).padStart(2, "0")}.000Z`,
    runtimeFactory: async () => emptyRuntime()
  };
}

function buildDelegateTool(
  llm: ToolLlmAdapter,
  registry: ReturnType<typeof createInMemoryChildRunRegistry>,
  parentRunId: string
): AgentTool<any> {
  return createDelegateTaskTool(buildDelegateContextStub(llm, registry, parentRunId));
}

const VALID_DELEGATE_ARGS = (label: string, prompt: string) => ({
  label,
  description: `Description for ${label}`,
  prompt
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("integration: parent fires two delegate_task calls; both children run, synthesis follows", async () => {
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-1";

  // Script: parent fires 2 delegate_task calls. Each delegate_task call
  // triggers ONE child runToolAgent call (consumes a script). Then synthesis.
  // Queue order: [parent, child-A, child-B, synthesis].
  const llm = buildScriptedAdapter([
    {
      toolCalls: [
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("alpha", "do A") },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("bravo", "do B") }
      ],
      text: "(parent done)"
    },
    { text: "Child A finished its work successfully." },
    { text: "Child B reported two findings." },
    { text: "Final synthesised answer for the user." }
  ]);

  const delegateTool = buildDelegateTool(llm, registry, parentRunId);
  const out = await runOrchestrator({
    parentRunId,
    parentObjective: "Answer the user's question",
    parentSystemPrompt: "system",
    parentPrompt: "prompt",
    parentTools: [delegateTool],
    llm,
    registry
  });

  assert.equal(out.didSynthesize, true);
  assert.equal(out.finalText, "Final synthesised answer for the user.");
  assert.equal(out.childCounts.total, 2);
  assert.equal(out.childCounts.completed, 2);
  assert.equal(out.childCounts.failed, 0);
  assert.deepEqual(out.state.phaseHistory, [
    "prepare",
    "plan",
    "delegate",
    "wait",
    "synthesize",
    "finalize"
  ]);

  // Exactly four LLM calls: parent + 2 children + synthesis.
  assert.equal(llm.calls.length, 4);
  assert.equal(llm.remainingScripts(), 0);

  // Sequential delivery: child A's session id appears before child B's in the call log.
  const sessionsOrder = llm.calls.map((c) => c.sessionId);
  // Index 0 = parent, 1 = first child (alpha), 2 = second child (bravo), 3 = synthesis.
  assert.equal(sessionsOrder[0], parentRunId);
  assert.equal(sessionsOrder[3], `${parentRunId}-synthesis`);
  // The child sessionIds are uuids; just confirm they're distinct from parent + synthesis.
  assert.notEqual(sessionsOrder[1], parentRunId);
  assert.notEqual(sessionsOrder[2], parentRunId);
  assert.notEqual(sessionsOrder[1], sessionsOrder[2]);

  // Synthesis prompt contains both labels in registry insertion order.
  const synthesisPrompt = llm.calls[3].prompt;
  const alphaIdx = synthesisPrompt.indexOf("### alpha");
  const bravoIdx = synthesisPrompt.indexOf("### bravo");
  assert.ok(alphaIdx >= 0 && bravoIdx >= 0);
  assert.ok(alphaIdx < bravoIdx);

  // Registry ground truth.
  const handles = registry.listByParent(parentRunId);
  assert.equal(handles.length, 2);
  assert.equal(handles[0].label, "alpha");
  assert.equal(handles[1].label, "bravo");
  assert.equal(handles[0].status, "completed");
  assert.equal(handles[1].status, "completed");
});

test("integration: mixed success/failure surfaces both in synthesis prompt with failure code", async () => {
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-2";

  const llm = buildScriptedAdapter([
    {
      toolCalls: [
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("good", "ok") },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("bad", "fail") }
      ],
      text: "(parent done)"
    },
    { text: "Good child completed." },
    { throwError: new Error("provider 502") }, // bad child fails
    { text: "Final answer noting the partial failure." }
  ]);

  const delegateTool = buildDelegateTool(llm, registry, parentRunId);
  const out = await runOrchestrator({
    parentRunId,
    parentObjective: "Help despite errors",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [delegateTool],
    llm,
    registry
  });

  assert.equal(out.didSynthesize, true);
  assert.equal(out.childCounts.total, 2);
  assert.equal(out.childCounts.completed, 1);
  assert.equal(out.childCounts.failed, 1);

  // Synthesis prompt must include the failure entry.
  const synthesisPrompt = llm.calls[3].prompt;
  assert.match(synthesisPrompt, /### good/);
  assert.match(synthesisPrompt, /### bad/);
  assert.match(synthesisPrompt, /Failure code: unknown/); // mapped from the thrown Error
});

test("integration: all-children-failed path still synthesizes (does not short-circuit)", async () => {
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-3";

  const llm = buildScriptedAdapter([
    {
      toolCalls: [
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("c1", "x") },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("c2", "y") }
      ],
      text: "(parent done)"
    },
    { throwError: new Error("provider 500 #1") },
    { throwError: new Error("provider 500 #2") },
    { text: "I'm sorry — every subtask failed. Here's what I tried..." }
  ]);

  const delegateTool = buildDelegateTool(llm, registry, parentRunId);
  const out = await runOrchestrator({
    parentRunId,
    parentObjective: "Try anyway",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [delegateTool],
    llm,
    registry
  });

  assert.equal(out.didSynthesize, true);
  assert.equal(out.childCounts.total, 2);
  assert.equal(out.childCounts.completed, 0);
  assert.equal(out.childCounts.failed, 2);
  assert.match(out.finalText, /every subtask failed/i);

  // Sanity: phase history is the full path; we did not bail to finalize early.
  assert.deepEqual(out.state.phaseHistory, [
    "prepare",
    "plan",
    "delegate",
    "wait",
    "synthesize",
    "finalize"
  ]);
});

test("integration: validation rejection from delegate_task does NOT advance the registry", async () => {
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-4";

  // Parent fires one delegate_task with empty label, then a valid one. The
  // empty-label call returns a validation_error envelope without touching
  // the registry; the valid call creates a normal child.
  const llm = buildScriptedAdapter([
    {
      toolCalls: [
        { toolName: "delegate_task", args: { ...VALID_DELEGATE_ARGS("ignored", "x"), label: "" } },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("real", "y") }
      ],
      text: "(parent done)"
    },
    // Only ONE child runtime call expected (the validation rejection skips it).
    { text: "Real child completed." },
    { text: "Final." }
  ]);

  const delegateTool = buildDelegateTool(llm, registry, parentRunId);
  const out = await runOrchestrator({
    parentRunId,
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [delegateTool],
    llm,
    registry
  });

  assert.equal(out.childCounts.total, 1, "registry should hold only the valid child");
  assert.equal(registry.listByParent(parentRunId).length, 1);
  assert.equal(registry.listByParent(parentRunId)[0].label, "real");

  // Total LLM calls: parent + 1 valid child + synthesis = 3 (NOT 4).
  assert.equal(llm.calls.length, 3);
});

test("integration: progress messages tag both parent and child timelines", async () => {
  const messages: string[] = [];
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-5";

  const llm = buildScriptedAdapter([
    {
      toolCalls: [{ toolName: "delegate_task", args: VALID_DELEGATE_ARGS("only", "x") }],
      text: "(parent done)"
    },
    { text: "child done" },
    { text: "synth done" }
  ]);

  const delegateContext = buildDelegateContextStub(llm, registry, parentRunId);
  delegateContext.onProgress = (m) => messages.push(m);
  const delegateTool = createDelegateTaskTool(delegateContext);

  await runOrchestrator({
    parentRunId,
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [delegateTool],
    llm,
    registry,
    onProgress: (m) => messages.push(m)
  });

  // Parent timeline: "[child:parent:int-5] planning delegated work", "delegated 1 task(s)", etc.
  assert.ok(messages.some((m) => m.includes("[child:parent:int-5]") && m.includes("planning")));
  assert.ok(messages.some((m) => m.includes("delegated 1 task")));
  // Child timeline: tagged with the child label.
  assert.ok(messages.some((m) => m.includes("[child:only]")));
});

test("integration: registry getResult agrees with state.childResults for every child", async () => {
  const registry = createInMemoryChildRunRegistry();
  const parentRunId = "int-6";

  const llm = buildScriptedAdapter([
    {
      toolCalls: [
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("a", "x") },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("b", "y") },
        { toolName: "delegate_task", args: VALID_DELEGATE_ARGS("c", "z") }
      ],
      text: "(parent done)"
    },
    { text: "A done" },
    { text: "B done" },
    { text: "C done" },
    { text: "Final." }
  ]);

  const delegateTool = buildDelegateTool(llm, registry, parentRunId);
  const out = await runOrchestrator({
    parentRunId,
    parentObjective: "x",
    parentSystemPrompt: "s",
    parentPrompt: "p",
    parentTools: [delegateTool],
    llm,
    registry
  });

  assert.equal(out.state.childResults.length, 3);
  for (const result of out.state.childResults) {
    const fromRegistry = registry.getResult(result.runId);
    assert.deepEqual(fromRegistry, result, `registry vs state divergence for ${result.label}`);
  }
});
