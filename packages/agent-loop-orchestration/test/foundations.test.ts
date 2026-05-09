import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATION_POLICY,
  RegistryTransitionError,
  RegistryUnknownRunError,
  checkActiveCount,
  checkDepth,
  createInMemoryChildRunRegistry,
  resolveToolPolicyForPreset,
  type ChildRunRequest,
  type ChildRunResultEnvelope,
  type PresetOverrides
} from "@maya-ai/agent-loop-orchestration";

function buildRequest(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    runId: overrides.runId ?? "child-1",
    parentRunId: overrides.parentRunId ?? "parent-1",
    parentDepth: overrides.parentDepth ?? 0,
    label: overrides.label ?? "research-pass",
    description: overrides.description ?? "Collect relevant facts.",
    prompt: overrides.prompt ?? "Read X and report Y.",
    contextMode: overrides.contextMode ?? "isolated",
    executionMode: overrides.executionMode ?? "blocking_inline",
    profile: overrides.profile,
    maxTokens: overrides.maxTokens,
    timeoutMs: overrides.timeoutMs,
    allowWriteTools: overrides.allowWriteTools,
    idempotencyKey: overrides.idempotencyKey,
    metadata: overrides.metadata
  };
}

function buildResult(runId: string, overrides: Partial<ChildRunResultEnvelope> = {}): ChildRunResultEnvelope {
  const startedAt = overrides.startedAt ?? "2026-05-07T10:00:00.000Z";
  const endedAt = overrides.endedAt ?? "2026-05-07T10:00:01.000Z";
  return {
    runId,
    parentRunId: overrides.parentRunId ?? "parent-1",
    label: overrides.label ?? "research-pass",
    status: overrides.status ?? "completed",
    summary: overrides.summary ?? "Done.",
    text: overrides.text,
    evidence: overrides.evidence,
    toolCalls: overrides.toolCalls ?? [],
    proposedChanges: overrides.proposedChanges,
    changedFiles: overrides.changedFiles,
    warnings: overrides.warnings,
    failure: overrides.failure,
    idempotencyKey: overrides.idempotencyKey,
    startedAt,
    endedAt,
    durationMs: overrides.durationMs ?? Date.parse(endedAt) - Date.parse(startedAt)
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: create -> markRunning -> markCompleted advances status", () => {
  const registry = createInMemoryChildRunRegistry({ clock: () => "2026-05-07T10:00:00.000Z" });
  const request = buildRequest();

  const handle = registry.create(request);
  assert.equal(handle.status, "pending");
  assert.equal(handle.startedAt, "2026-05-07T10:00:00.000Z");

  registry.markRunning(request.runId);
  assert.equal(registry.get(request.runId)?.status, "running");

  registry.markCompleted(buildResult(request.runId));
  assert.equal(registry.get(request.runId)?.status, "completed");
  assert.equal(registry.getResult(request.runId)?.summary, "Done.");
});

test("registry: markFailed records failure and sets endedAt", () => {
  const registry = createInMemoryChildRunRegistry();
  const request = buildRequest({ runId: "child-fail" });
  registry.create(request);
  registry.markRunning(request.runId);
  registry.markFailed(
    request.runId,
    { code: "tool_error", message: "boom", retryable: false },
    "2026-05-07T10:00:02.000Z"
  );
  const handle = registry.get(request.runId);
  assert.equal(handle?.status, "failed");
  assert.equal(handle?.endedAt, "2026-05-07T10:00:02.000Z");
});

test("registry: markTimedOut and markCancelled fill default failure shape", () => {
  const registry = createInMemoryChildRunRegistry();
  const t = buildRequest({ runId: "t" });
  const c = buildRequest({ runId: "c" });
  registry.create(t);
  registry.create(c);
  registry.markRunning(t.runId);
  registry.markRunning(c.runId);
  registry.markTimedOut(t.runId, "2026-05-07T10:00:03.000Z");
  registry.markCancelled(c.runId, "2026-05-07T10:00:03.000Z");

  const snap = registry.snapshot();
  const tEntry = snap.entries.find((e) => e.handle.runId === "t");
  const cEntry = snap.entries.find((e) => e.handle.runId === "c");
  assert.equal(tEntry?.handle.status, "timed_out");
  assert.equal(tEntry?.failure?.code, "timeout");
  assert.equal(cEntry?.handle.status, "cancelled");
  assert.equal(cEntry?.failure?.code, "cancelled");
});

test("registry: invalid transitions throw RegistryTransitionError", () => {
  const registry = createInMemoryChildRunRegistry();
  const request = buildRequest({ runId: "bad" });
  registry.create(request);
  // pending -> completed is not allowed; must go through running
  assert.throws(
    () => registry.markCompleted(buildResult("bad")),
    (err: unknown) => err instanceof RegistryTransitionError
  );
});

test("registry: double completion is rejected", () => {
  const registry = createInMemoryChildRunRegistry();
  const request = buildRequest({ runId: "once" });
  registry.create(request);
  registry.markRunning(request.runId);
  registry.markCompleted(buildResult("once"));
  assert.throws(
    () => registry.markCompleted(buildResult("once")),
    (err: unknown) => err instanceof RegistryTransitionError
  );
});

test("registry: unknown runId throws RegistryUnknownRunError", () => {
  const registry = createInMemoryChildRunRegistry();
  assert.throws(
    () => registry.markRunning("ghost"),
    (err: unknown) => err instanceof RegistryUnknownRunError
  );
});

test("registry: listByParent returns children in creation order", () => {
  const registry = createInMemoryChildRunRegistry();
  registry.create(buildRequest({ runId: "a", parentRunId: "p" }));
  registry.create(buildRequest({ runId: "b", parentRunId: "p" }));
  registry.create(buildRequest({ runId: "c", parentRunId: "other" }));
  registry.create(buildRequest({ runId: "d", parentRunId: "p" }));
  const children = registry.listByParent("p").map((h) => h.runId);
  assert.deepEqual(children, ["a", "b", "d"]);
});

test("registry: activeCount reflects pending + running children only", () => {
  const registry = createInMemoryChildRunRegistry();
  registry.create(buildRequest({ runId: "a", parentRunId: "p" })); // pending
  registry.create(buildRequest({ runId: "b", parentRunId: "p" }));
  registry.markRunning("b"); // running
  registry.create(buildRequest({ runId: "c", parentRunId: "p" }));
  registry.markRunning("c");
  registry.markCompleted(buildResult("c")); // completed -> not counted
  assert.equal(registry.activeCount("p"), 2);
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("policy: default values match Phase 1 plan", () => {
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.maxDepth, 1);
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.maxActiveChildrenPerParent, 3);
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.defaultContextMode, "isolated");
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.defaultAllowWriteTools, false);
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.defaultStateMutationMode, "proposal_only");
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.synthesisMode, "separate_call");
});

test("policy: checkDepth rejects when parentDepth >= maxDepth", () => {
  const policy = { ...DEFAULT_ORCHESTRATION_POLICY, maxDepth: 1 };
  assert.equal(checkDepth(policy, 0).ok, true);
  const result = checkDepth(policy, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "depth_exceeded");
});

test("policy: checkActiveCount rejects when at limit", () => {
  const policy = { ...DEFAULT_ORCHESTRATION_POLICY, maxActiveChildrenPerParent: 3 };
  assert.equal(checkActiveCount(policy, 2).ok, true);
  const result = checkActiveCount(policy, 3);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "active_limit_exceeded");
});

// ---------------------------------------------------------------------------
// Preset resolver
// ---------------------------------------------------------------------------

test("preset resolver: read_only_research enables only memory + system sources", () => {
  const policy = resolveToolPolicyForPreset("read_only_research");
  assert.equal(policy.sources.domain, false);
  assert.equal(policy.sources.mcp, false);
  assert.equal(policy.sources.memory, true);
  assert.equal(policy.sources.system, true);
  assert.deepEqual(policy.allow, []);
  assert.deepEqual(policy.deny, []);
});

test("preset resolver: read_and_validation enables domain reads (consumer supplies allowlist)", () => {
  const policy = resolveToolPolicyForPreset("read_and_validation");
  assert.equal(policy.sources.domain, true);
  // Default allow is empty — consumer adapter narrows via overrides.
  assert.deepEqual(policy.allow, []);
});

test("preset resolver: unknown preset falls through to a fully-restricted policy", () => {
  const policy = resolveToolPolicyForPreset("does_not_exist");
  assert.equal(policy.enabled, true);
  // Every source gate off → no tools resolve through this policy.
  assert.equal(policy.sources.domain, false);
  assert.equal(policy.sources.mcp, false);
  assert.equal(policy.sources.memory, false);
  assert.equal(policy.sources.system, false);
});

test("preset resolver: PresetOverrides extend allow / deny without mutating defaults", () => {
  const overrides: PresetOverrides = {
    read_and_validation: { allow: ["domain_tool_a", "domain_tool_b"] },
    limited_write_candidate_generation: { deny: ["dangerous_write"] }
  };
  const ro = resolveToolPolicyForPreset("read_and_validation", overrides);
  const lw = resolveToolPolicyForPreset("limited_write_candidate_generation", overrides);
  assert.deepEqual(ro.allow, ["domain_tool_a", "domain_tool_b"]);
  assert.deepEqual(lw.deny, ["dangerous_write"]);

  // Same call without overrides must remain unaffected.
  const baseline = resolveToolPolicyForPreset("read_and_validation");
  assert.deepEqual(baseline.allow, []);
});

// ---------------------------------------------------------------------------
// Reusability check (lightweight): the public surface contains no domain terms.
// ---------------------------------------------------------------------------

test("reusability: no domain identifiers leak through the public surface", async () => {
  const mod = await import("@maya-ai/agent-loop-orchestration");
  const exported = Object.keys(mod);
  const forbidden = ["journey", "wiki", "role"];
  for (const name of exported) {
    const lower = name.toLowerCase();
    for (const term of forbidden) {
      assert.ok(
        !lower.includes(term),
        `Exported identifier "${name}" contains forbidden domain term "${term}"`
      );
    }
  }
});
