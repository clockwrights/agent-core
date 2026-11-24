// ---------------------------------------------------------------------------
// Tests: createFailover, pickWeighted, createLoadBalancer.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFailover,
  createLoadBalancer,
  FailoverTimeoutError,
  getErrorStatus,
  pickWeighted,
  type FailoverAttempt,
} from "../src/index.js";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** A target that fails `failures` times with the given errors, then returns its name. */
function target(name: string, errors: unknown[] = [], log: string[] = []) {
  let calls = 0;
  return async (input: string) => {
    log.push(`${name}:${input}`);
    const error = errors[calls++];
    if (error !== undefined) throw error;
    return `${name}(${input})`;
  };
}

test("createFailover: primary success never touches fallbacks", async () => {
  const log: string[] = [];
  const run = createFailover(target("a", [], log), [target("b", [], log)]);
  assert.equal(await run("x"), "a(x)");
  assert.deepEqual(log, ["a:x"]);
});

test("createFailover: moves through fallbacks in order and reports attempts", async () => {
  const log: string[] = [];
  const attempts: FailoverAttempt[] = [];
  const run = createFailover(target("a", [new Error("down")], log), [target("b", [httpError(500)], log), target("c", [], log)], {
    onAttemptFailed: (a) => attempts.push(a),
  });
  assert.equal(await run("x"), "c(x)");
  assert.deepEqual(log, ["a:x", "b:x", "c:x"]);
  assert.deepEqual(attempts.map((a) => [a.targetIndex, a.attempt, a.next]), [[0, 1, "fallback"], [1, 1, "fallback"]]);
});

test("createFailover: every target failing rethrows the last error", async () => {
  const last = httpError(503);
  const run = createFailover(target("a", [new Error("first")]), [target("b", [last])]);
  await assert.rejects(run("x"), (err) => err === last);
});

test("createFailover: retries each target with doubling, capped backoff before falling back", async () => {
  const log: string[] = [];
  const sleeps: number[] = [];
  const run = createFailover(target("a", [httpError(429), httpError(429), httpError(429)], log), [target("b", [httpError(429)], log)], {
    retry: { maxAttempts: 3, backoffMs: 100, maxBackoffMs: 150 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(await run("x"), "b(x)");
  assert.deepEqual(log, ["a:x", "a:x", "a:x", "b:x", "b:x"]);
  assert.deepEqual(sleeps, [100, 150, 100], "100, 200→150 on a; then 100 on b");
});

test("createFailover: onStatusCodes limits which errors move on", async () => {
  const log: string[] = [];
  const run = createFailover(target("a", [httpError(400)], log), [target("b", [], log)], {
    retry: { onStatusCodes: [429, 503] },
  });
  await assert.rejects(run("x"), /HTTP 400/);
  assert.deepEqual(log, ["a:x"], "a 400 is not in the list: rethrown, no fallback");

  const viaResponse = createFailover(target("a", [{ response: { status: 503 } }]), [target("b")], { retry: { onStatusCodes: [503] } });
  assert.equal(await viaResponse("y"), "b(y)");
});

test("createFailover: shouldFallback overrides the default decision", async () => {
  const run = createFailover(target("a", [new Error("content filter")]), [target("b")], {
    shouldFallback: (err) => !(err instanceof Error && /content filter/.test(err.message)),
  });
  await assert.rejects(run("x"), /content filter/);
});

test("createFailover: timeoutMs turns a slow attempt into a failure", async () => {
  const slow = (_input: string) => new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 200));
  const errors: unknown[] = [];
  const run = createFailover(slow, [target("b")], {
    retry: { timeoutMs: 10, onStatusCodes: [503] },
    onAttemptFailed: (a) => errors.push(a.error),
  });
  assert.equal(await run("x"), "b(x)", "timeouts move on even with an onStatusCodes list");
  assert.ok(errors[0] instanceof FailoverTimeoutError);
  assert.equal((errors[0] as FailoverTimeoutError).timeoutMs, 10);
});

test("getErrorStatus reads status, statusCode and response.status", () => {
  assert.equal(getErrorStatus({ status: 429 }), 429);
  assert.equal(getErrorStatus({ statusCode: 500 }), 500);
  assert.equal(getErrorStatus({ response: { status: 503 } }), 503);
  assert.equal(getErrorStatus(new Error("x")), undefined);
  assert.equal(getErrorStatus("x"), undefined);
});

test("pickWeighted: weights decide the share; zero weights never picked; bad input throws", () => {
  const targets = [{ target: "a", weight: 3 }, { target: "b" }, { target: "z", weight: 0 }];
  assert.equal(pickWeighted(targets, () => 0), "a");
  assert.equal(pickWeighted(targets, () => 0.74), "a");
  assert.equal(pickWeighted(targets, () => 0.75), "b");
  assert.equal(pickWeighted(targets, () => 0.9999999999), "b");
  assert.throws(() => pickWeighted([]), /at least one target/);
  assert.throws(() => pickWeighted([{ target: "a", weight: 0 }]), /at least one target/);
  assert.throws(() => pickWeighted([{ target: "a", weight: -1 }]), /finite and >= 0/);
});

test("createLoadBalancer: forwards each call to a weighted pick", async () => {
  const picks = [0.1, 0.9, 0.5];
  const balanced = createLoadBalancer(
    [
      { target: target("a"), weight: 1 },
      { target: target("b"), weight: 1 },
    ],
    () => picks.shift()!,
  );
  assert.deepEqual([await balanced("1"), await balanced("2"), await balanced("3")], ["a(1)", "b(2)", "b(3)"]);
  assert.throws(() => createLoadBalancer([]), /at least one target/);
});

test("composition: a load-balanced primary with a failover chain", async () => {
  const log: string[] = [];
  const primary = createLoadBalancer([{ target: target("a", [httpError(503)], log) }], () => 0);
  const run = createFailover(primary, [target("b", [], log)], { retry: { onStatusCodes: [503] } });
  assert.equal(await run("x"), "b(x)");
  assert.deepEqual(log, ["a:x", "b:x"]);
});
