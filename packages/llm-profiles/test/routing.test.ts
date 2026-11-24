// ---------------------------------------------------------------------------
// Tests: fallbacks[], retry, loadBalance; capabilities and pricing;
// router compatibility with single-fallback callers.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createLlmRouter,
  LlmProfilesConfigError,
  loadLlmRoutingConfig,
  resolveComponentRouting,
  type LlmRoutingConfig,
} from "../src/index.js";

const FILE = "/cfg.json";
function load(config: unknown, strict = false) {
  const text = JSON.stringify(config);
  return loadLlmRoutingConfig({ filePath: FILE, readFile: (p) => (p === FILE ? text : undefined), env: {}, strict });
}
const silence = (t: TestContext) => t.mock.method(console, "warn", () => {});
const warnings = (warn: ReturnType<typeof silence>) => warn.mock.calls.map((c) => String(c.arguments[0]));

const profile = (name: string, extra: Record<string, unknown> = {}) => ({ name, provider: "openai", model: `m-${name}`, ...extra });
const BASE = {
  profiles: [profile("a"), profile("b"), profile("c"), profile("d")],
  defaultProfile: "a",
};

// ---------------------------------------------------------------------------
// Loading and resolution
// ---------------------------------------------------------------------------

test("fallbacks: alias first, order kept, duplicates and the primary removed", () => {
  const cfg = load({
    ...BASE,
    components: { x: { profile: "a", fallback: "b", fallbacks: ["c", "b", "a", "d"] } },
  })!;
  assert.deepEqual(cfg.components!.x, { profile: "a", fallback: "b", fallbacks: ["c", "b", "a", "d"] });
  const resolved = resolveComponentRouting(cfg, "x")!;
  assert.deepEqual(resolved.fallbacks.map((p) => p.name), ["b", "c", "d"]);
  assert.equal(resolved.fallback!.name, "b", "fallback stays the first of the chain");
});

test("fallbacks: old single-fallback configs resolve exactly as before", () => {
  const cfg = load({ ...BASE, components: { x: { profile: "a", fallback: "b" }, y: { profile: "c" } } })!;
  assert.deepEqual(cfg.components, { x: { profile: "a", fallback: "b" }, y: { profile: "c" } });
  const x = resolveComponentRouting(cfg, "x")!;
  assert.equal(x.primary.name, "a");
  assert.equal(x.fallback!.name, "b");
  assert.deepEqual(x.fallbacks.map((p) => p.name), ["b"]);
  assert.equal(x.retry, undefined);
  assert.equal(x.loadBalance, undefined);
  assert.equal(resolveComponentRouting(cfg, "y")!.fallback, null);
  assert.deepEqual(resolveComponentRouting(cfg, "unknown-component")!.fallbacks, []);
});

test("retry and loadBalance are validated and resolved", () => {
  const cfg = load({
    ...BASE,
    components: {
      x: {
        profile: "a",
        retry: { maxAttempts: 3, backoffMs: 100, maxBackoffMs: 1000, onStatusCodes: [429, 503], timeoutMs: 30000 },
        loadBalance: [{ profile: "a", weight: 3 }, { profile: "b" }],
      },
    },
  })!;
  const resolved = resolveComponentRouting(cfg, "x")!;
  assert.deepEqual(resolved.retry, { maxAttempts: 3, backoffMs: 100, maxBackoffMs: 1000, onStatusCodes: [429, 503], timeoutMs: 30000 });
  assert.deepEqual(resolved.loadBalance!.map((t) => [t.profile.name, t.weight]), [["a", 3], ["b", 1]]);
});

test("bad fallbacks/retry/loadBalance: dropped with a warning, or thrown in strict mode", (t) => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ fallbacks: "b" }, /"fallbacks" must be an array/],
    [{ fallbacks: ["b", "zzz"] }, /unknown fallback "zzz"/],
    [{ retry: { maxAttempts: 0 } }, /maxAttempts must be an integer >= 1/],
    [{ retry: { onStatusCodes: ["429"] } }, /onStatusCodes must be an array of integers/],
    [{ retry: "fast" }, /"retry" must be an object/],
    [{ loadBalance: [] }, /must be a non-empty array/],
    [{ loadBalance: [{ profile: "b" }] }, /must include the component's profile "a"/],
    [{ loadBalance: [{ profile: "a" }, { profile: "a" }] }, /lists "a" twice/],
    [{ loadBalance: [{ profile: "a", weight: 0 }] }, /must be a positive number/],
    [{ loadBalance: [{ profile: "a" }, { profile: "nope" }] }, /unknown profile "nope"/],
  ];
  const warn = silence(t);
  for (const [extra, message] of cases) {
    warn.mock.resetCalls();
    const config = { ...BASE, components: { x: { profile: "a", ...extra } } };
    const cfg = load(config)!;
    assert.match(warnings(warn).join("\n"), message);
    const x = cfg.components!.x!;
    if ("fallbacks" in extra && Array.isArray(extra.fallbacks)) assert.deepEqual(x.fallbacks, ["b"]);
    else assert.deepEqual(x, { profile: "a" }, `bad field dropped for ${JSON.stringify(extra)}`);
    assert.throws(() => load(config, true), LlmProfilesConfigError);
  }
});

// ---------------------------------------------------------------------------
// Capabilities and pricing
// ---------------------------------------------------------------------------

test("capabilities and pricing are kept on the profile", () => {
  const cfg = load({
    ...BASE,
    profiles: [
      profile("a", {
        capabilities: { vision: true, tools: true, "json-mode": false },
        pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      }),
    ],
  })!;
  assert.deepEqual(cfg.profiles[0]!.capabilities, { vision: true, tools: true, "json-mode": false });
  assert.deepEqual(cfg.profiles[0]!.pricing, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  const plain = load(BASE)!;
  assert.equal("capabilities" in plain.profiles[0]!, false, "absent fields are not added");
  assert.equal("pricing" in plain.profiles[0]!, false);
});

test("bad capabilities or pricing: dropped with a warning, thrown in strict mode", (t) => {
  const warn = silence(t);
  for (const [extra, message] of [
    [{ capabilities: { vision: "yes" } }, /object of booleans/],
    [{ capabilities: ["vision"] }, /object of booleans/],
    [{ pricing: { input: 3 } }, /"pricing" needs non-negative numbers/],
    [{ pricing: { input: -1, output: 2 } }, /"pricing" needs/],
    [{ pricing: { input: 1, output: 2, cacheRead: "0.1" } }, /"pricing" needs/],
  ] as const) {
    warn.mock.resetCalls();
    const config = { ...BASE, profiles: [profile("a", extra)] };
    const cfg = load(config)!;
    assert.match(warnings(warn).join("\n"), message);
    assert.deepEqual(Object.keys(cfg.profiles[0]!).filter((k) => k === "capabilities" || k === "pricing"), []);
    assert.throws(() => load(config, true), LlmProfilesConfigError);
  }
});

test("requires: checked against primary, load-balance targets and fallbacks that declare capabilities", (t) => {
  const config = {
    profiles: [
      profile("vision", { capabilities: { vision: true, tools: true } }),
      profile("text", { capabilities: { tools: true } }),
      profile("unknown"),
      profile("vision2", { capabilities: { vision: true } }),
    ],
    defaultProfile: "vision",
    components: {
      ok: { profile: "vision", fallbacks: ["vision2", "unknown"], requires: ["vision"] },
      badFallback: { profile: "vision", fallback: "text", fallbacks: ["text", "vision2"], requires: ["vision"] },
      badPrimary: { profile: "text", requires: ["vision"] },
      badTarget: { profile: "vision", loadBalance: [{ profile: "vision" }, { profile: "text" }], requires: ["vision", "tools"] },
    },
  };
  const warn = silence(t);
  const cfg = load(config)!;
  const all = warnings(warn);

  assert.deepEqual(cfg.components!.ok, config.components.ok, "profiles without capabilities are not checked");
  assert.deepEqual(cfg.components!.badFallback, { profile: "vision", fallbacks: ["vision2"], requires: ["vision"] });
  assert.equal(all.filter((w) => /fallback "text" does not declare it; dropping/.test(w)).length, 1, "reported once");
  assert.deepEqual(cfg.components!.badPrimary, { profile: "text", requires: ["vision"] }, "a primary is reported, not dropped");
  assert.ok(all.some((w) => /"badPrimary" requires vision but profile "text"/.test(w)));
  assert.ok(all.some((w) => /"badTarget" requires vision but profile "text"/.test(w)));
  assert.ok(!all.some((w) => /"badTarget".*tools/.test(w)), "only the missing capability is named");

  assert.throws(() => load(config, true), /"badFallback" requires vision but fallback "text"/);
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type Provider = { id: string };
const factory = (p: { name: string }): Provider => ({ id: p.name });
const routingConfig = (components: LlmRoutingConfig["components"]): LlmRoutingConfig => ({
  profiles: BASE.profiles.map((p) => ({ name: p.name, provider: p.provider, model: p.model })),
  defaultProfile: "a",
  components,
});

test("router: old withFailover callers with one fallback get exactly the old call", () => {
  const calls: Array<[string, string]> = [];
  const router = createLlmRouter<Provider>(routingConfig({ x: { profile: "a", fallback: "b" }, y: { profile: "c" } }), {
    factory,
    withFailover: (primary, fallback) => {
      calls.push([primary.id, fallback.id]);
      return { id: `${primary.id}>${fallback.id}` };
    },
  });
  assert.equal(router.forComponent("x").id, "a>b");
  assert.equal(router.forComponent("y").id, "c");
  assert.deepEqual(calls, [["a", "b"]]);
});

test("router: several fallbacks chain through withFailover right to left", () => {
  const router = createLlmRouter<Provider>(routingConfig({ x: { profile: "a", fallbacks: ["b", "c", "d"] } }), {
    factory,
    withFailover: (primary, fallback) => ({ id: `(${primary.id}>${fallback.id})` }),
  });
  assert.equal(router.forComponent("x").id, "(a>(b>(c>d)))");
});

test("router: withFallbacks sees the whole chain and retry, and wins over withFailover", () => {
  const seen: unknown[] = [];
  const router = createLlmRouter<Provider>(
    routingConfig({
      x: { profile: "a", fallback: "b", fallbacks: ["c"], retry: { maxAttempts: 2 } },
      retryOnly: { profile: "d", retry: { maxAttempts: 3 } },
      plain: { profile: "c" },
    }),
    {
      factory,
      withFailover: () => assert.fail("withFallbacks takes precedence"),
      withFallbacks: (primary, fallbacks, context) => {
        seen.push({ primary: primary.id, fallbacks: fallbacks.map((f) => f.id), ...context, profiles: context.profiles.map((p) => p.name) });
        return { id: "wrapped" };
      },
    },
  );
  assert.equal(router.forComponent("x").id, "wrapped");
  assert.equal(router.forComponent("retryOnly").id, "wrapped", "retry alone is enough to wrap");
  assert.equal(router.forComponent("plain").id, "c", "nothing to wrap → plain provider");
  assert.deepEqual(seen, [
    { primary: "a", fallbacks: ["b", "c"], componentId: "x", retry: { maxAttempts: 2 }, profiles: ["a", "b", "c"] },
    { primary: "d", fallbacks: [], componentId: "retryOnly", retry: { maxAttempts: 3 }, profiles: ["d"] },
  ]);
});

test("router: withLoadBalance wraps weighted primaries; ignored when not supplied", () => {
  const config = routingConfig({ x: { profile: "a", loadBalance: [{ profile: "a", weight: 3 }, { profile: "b" }], fallback: "c" } });
  const router = createLlmRouter<Provider>(config, {
    factory,
    withLoadBalance: (targets) => ({ id: targets.map((t) => `${t.provider.id}*${t.weight}`).join("|") }),
    withFailover: (primary, fallback) => ({ id: `${primary.id}>${fallback.id}` }),
  });
  assert.equal(router.forComponent("x").id, "a*3|b*1>c", "the balanced group is the primary of the chain");

  const plain = createLlmRouter<Provider>(config, { factory });
  assert.equal(plain.forComponent("x").id, "a");
});

test("router: providers are still memoised per profile across chains", () => {
  let built = 0;
  const router = createLlmRouter<Provider>(routingConfig({ x: { profile: "a", fallbacks: ["b"] }, y: { profile: "b", fallbacks: ["a"] } }), {
    factory: (p) => {
      built++;
      return { id: p.name };
    },
    withFallbacks: (primary) => primary,
  });
  router.forComponent("x");
  router.forComponent("y");
  assert.equal(built, 2);
});
