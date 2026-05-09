import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_FORK_CONTEXT_CHARS,
  DEFAULT_MAX_SLICE_CHARS,
  buildChildSystemPrompt,
  buildForkedContextBlock,
  type ChildRunRequest,
  type ParentContextSlice
} from "@maya-ai/agent-loop-orchestration";

import type { AgentRuntimeContext } from "@maya-ai/agent-loop-core";

// ---------------------------------------------------------------------------
// Fixtures
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

function buildRequest(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    runId: overrides.runId ?? "child-1",
    parentRunId: overrides.parentRunId ?? "parent-1",
    parentDepth: overrides.parentDepth ?? 0,
    label: overrides.label ?? "research-pass",
    description: overrides.description ?? "Investigate X.",
    prompt: overrides.prompt ?? "Read X and report Y.",
    contextMode: overrides.contextMode ?? "isolated",
    executionMode: overrides.executionMode ?? "blocking_inline",
    parentContext: overrides.parentContext
  };
}

const SAMPLE_SLICES: ParentContextSlice[] = [
  { label: "objective", content: "Decide whether to proceed with plan B.", kind: "summary" },
  { label: "evidence-1", content: "Note from yesterday: blockers cleared." },
  { label: "evidence-2", content: "Customer feedback positive." }
];

// ---------------------------------------------------------------------------
// buildForkedContextBlock
// ---------------------------------------------------------------------------

test("fork block: returns undefined when slices are missing or empty", () => {
  assert.equal(buildForkedContextBlock(undefined), undefined);
  assert.equal(buildForkedContextBlock([]), undefined);
});

test("fork block: skips slices with empty/whitespace-only content", () => {
  const block = buildForkedContextBlock([
    { label: "blank", content: "" },
    { label: "ws", content: "   \n\t   " },
    { label: "real", content: "Useful detail." }
  ]);
  assert.ok(block);
  assert.match(block!, /Useful detail/);
  assert.doesNotMatch(block!, /### blank/);
  assert.doesNotMatch(block!, /### ws/);
});

test("fork block: returns undefined when every slice is empty", () => {
  const block = buildForkedContextBlock([
    { label: "a", content: "" },
    { label: "b", content: "   " }
  ]);
  assert.equal(block, undefined);
});

test("fork block: header uses kind suffix when provided", () => {
  const block = buildForkedContextBlock([
    { label: "objective", content: "x", kind: "summary" },
    { label: "fact", content: "y" }
  ]);
  assert.ok(block);
  assert.match(block!, /^### objective \(summary\)$/m);
  assert.match(block!, /^### fact$/m);
});

test("fork block: opens with the [Optional Parent Context] header", () => {
  const block = buildForkedContextBlock(SAMPLE_SLICES);
  assert.ok(block);
  assert.ok(block!.startsWith("[Optional Parent Context]"));
});

test("fork block: preserves slice order", () => {
  const block = buildForkedContextBlock(SAMPLE_SLICES);
  assert.ok(block);
  const objectiveIdx = block!.indexOf("### objective");
  const evidence1Idx = block!.indexOf("### evidence-1");
  const evidence2Idx = block!.indexOf("### evidence-2");
  assert.ok(objectiveIdx < evidence1Idx);
  assert.ok(evidence1Idx < evidence2Idx);
});

test("fork block: long single slice is truncated to maxSliceChars with ellipsis", () => {
  const huge = "A".repeat(5_000);
  const block = buildForkedContextBlock([{ label: "big", content: huge }], {
    maxSliceChars: 500
  });
  assert.ok(block);
  // Truncated content + ellipsis (500 chars total).
  assert.match(block!, /A{499}…/);
  // Original full content is NOT present.
  assert.equal(block!.includes("A".repeat(501)), false);
});

test("fork block: total cap drops later slices and adds truncation note", () => {
  const big = "B".repeat(1_000);
  const slices: ParentContextSlice[] = [
    { label: "first", content: big },
    { label: "second", content: big },
    { label: "third", content: big }
  ];
  const block = buildForkedContextBlock(slices, {
    maxChars: 1_500,
    maxSliceChars: 1_000
  });
  assert.ok(block);
  assert.match(block!, /### first/);
  assert.doesNotMatch(block!, /### third/);
  assert.match(block!, /\(parent context truncated\)/);
});

test("fork block: under the cap produces no truncation note", () => {
  const block = buildForkedContextBlock(SAMPLE_SLICES);
  assert.ok(block);
  assert.doesNotMatch(block!, /\(parent context truncated\)/);
});

test("fork block: deterministic for fixed input", () => {
  const a = buildForkedContextBlock(SAMPLE_SLICES);
  const b = buildForkedContextBlock(SAMPLE_SLICES);
  assert.equal(a, b);
});

test("fork block: malformed slice label is sanitised, never breaks the section header", () => {
  const block = buildForkedContextBlock([
    { label: "line\nbreak\twhitespace", content: "ok" },
    { label: "   ", content: "also ok" }
  ]);
  assert.ok(block);
  assert.match(block!, /^### line break whitespace$/m);
  assert.match(block!, /^### \(unlabelled\)$/m);
});

test("fork block: maxChars smaller than header returns undefined", () => {
  const block = buildForkedContextBlock(SAMPLE_SLICES, { maxChars: 5 });
  assert.equal(block, undefined);
});

test("fork block: defaults are exposed and reasonable", () => {
  assert.ok(DEFAULT_MAX_FORK_CONTEXT_CHARS > 0);
  assert.ok(DEFAULT_MAX_SLICE_CHARS > 0);
  assert.ok(DEFAULT_MAX_SLICE_CHARS < DEFAULT_MAX_FORK_CONTEXT_CHARS);
});

// ---------------------------------------------------------------------------
// buildChildSystemPrompt — fork vs isolated
// ---------------------------------------------------------------------------

test("prompt: isolated mode never includes [Optional Parent Context], even if slices supplied", () => {
  const prompt = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "isolated",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  assert.doesNotMatch(prompt, /\[Optional Parent Context\]/);
  assert.doesNotMatch(prompt, /### objective/);
});

test("prompt: fork mode with slices includes the [Optional Parent Context] block", () => {
  const prompt = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "fork",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  assert.match(prompt, /\[Optional Parent Context\]/);
  assert.match(prompt, /### objective/);
  assert.match(prompt, /### evidence-1/);
});

test("prompt: fork mode without slices skips the optional block cleanly", () => {
  const prompt = buildChildSystemPrompt({
    request: buildRequest({ contextMode: "fork" }),
    runtime: emptyRuntime()
  });
  assert.doesNotMatch(prompt, /\[Optional Parent Context\]/);
  // Trailing-empty-section sanity check.
  assert.doesNotMatch(prompt, /\n\n\s*$/);
});

test("prompt: fork section appears AFTER the deliverable section", () => {
  const prompt = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "fork",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  const deliverableIdx = prompt.indexOf("[Expected Deliverable]");
  const forkIdx = prompt.indexOf("[Optional Parent Context]");
  assert.ok(deliverableIdx >= 0);
  assert.ok(forkIdx >= 0);
  assert.ok(deliverableIdx < forkIdx, "deliverable should precede parent context");
});

test("prompt: isolated and fork prompts visibly differ for the same request", () => {
  const isolated = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "isolated",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  const forked = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "fork",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  assert.notEqual(isolated, forked);
  assert.ok(forked.length > isolated.length);
});

test("prompt: deterministic for fixed inputs (both modes)", () => {
  const args = {
    request: buildRequest({ contextMode: "fork", parentContext: SAMPLE_SLICES }),
    runtime: emptyRuntime()
  } as const;
  assert.equal(buildChildSystemPrompt(args), buildChildSystemPrompt(args));

  const isolatedArgs = {
    request: buildRequest({ contextMode: "isolated" }),
    runtime: emptyRuntime()
  } as const;
  assert.equal(
    buildChildSystemPrompt(isolatedArgs),
    buildChildSystemPrompt(isolatedArgs)
  );
});

test("prompt: forkContextOptions are honoured", () => {
  const huge = "C".repeat(3_000);
  const prompt = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "fork",
      parentContext: [{ label: "big", content: huge }]
    }),
    runtime: emptyRuntime(),
    forkContextOptions: { maxSliceChars: 100 }
  });
  // The full 3,000-char content must NOT appear; the truncated version should.
  assert.equal(prompt.includes("C".repeat(3_000)), false);
  assert.match(prompt, /C{99}…/);
});

test("prompt: contextMode is reported in the operating-constraints block", () => {
  const isolated = buildChildSystemPrompt({
    request: buildRequest({ contextMode: "isolated" }),
    runtime: emptyRuntime()
  });
  const forked = buildChildSystemPrompt({
    request: buildRequest({ contextMode: "fork" }),
    runtime: emptyRuntime()
  });
  assert.match(isolated, /Context mode: isolated\./);
  assert.match(forked, /Context mode: fork\./);
});

// ---------------------------------------------------------------------------
// Reusability check on the rendered output
// ---------------------------------------------------------------------------

test("reusability: rendered prompt contains no consumer-domain terms", () => {
  const prompt = buildChildSystemPrompt({
    request: buildRequest({
      contextMode: "fork",
      parentContext: SAMPLE_SLICES
    }),
    runtime: emptyRuntime()
  });
  for (const term of ["journey", "wiki", "Journey", "Wiki"]) {
    assert.equal(
      prompt.includes(term),
      false,
      `Rendered prompt unexpectedly contains domain term "${term}"`
    );
  }
});
