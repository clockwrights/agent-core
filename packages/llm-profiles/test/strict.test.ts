// ---------------------------------------------------------------------------
// Tests: strict mode and extended ${VAR} syntax.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { LlmProfilesConfigError, loadLlmRoutingConfig, type LoadLlmRoutingOptions } from "../src/index.js";

const FILE = "/cfg.json";

function load(config: unknown, env: Record<string, string> = {}, extra: Partial<LoadLlmRoutingOptions> = {}) {
  const text = typeof config === "string" ? config : JSON.stringify(config);
  return loadLlmRoutingConfig({ filePath: FILE, readFile: (p) => (p === FILE ? text : undefined), env, ...extra });
}

const strict = { strict: true } as const;

function silenceWarnings(t: TestContext) {
  return t.mock.method(console, "warn", () => {});
}

const VALID = {
  profiles: [{ name: "p", provider: "openai", model: "m", apiKey: "k" }],
  defaultProfile: "p",
};

// ---------------------------------------------------------------------------
// ${VAR:-default}
// ---------------------------------------------------------------------------

test("${VAR:-default}: uses the env value when set", () => {
  const cfg = load({ ...VALID, profiles: [{ ...VALID.profiles[0], baseUrl: "${GATEWAY_URL:-https://default.example/v1}" }] }, {
    GATEWAY_URL: "https://custom.example/v1",
  });
  assert.equal(cfg!.profiles[0]!.baseUrl, "https://custom.example/v1");
});

test("${VAR:-default}: uses the default when unset or empty, without warning", (t) => {
  const warn = silenceWarnings(t);
  const config = { ...VALID, profiles: [{ ...VALID.profiles[0], baseUrl: "${GATEWAY_URL:-https://default.example/v1}" }] };
  assert.equal(load(config)!.profiles[0]!.baseUrl, "https://default.example/v1");
  assert.equal(load(config, { GATEWAY_URL: "" })!.profiles[0]!.baseUrl, "https://default.example/v1");
  assert.equal(warn.mock.callCount(), 0);
});

test("${VAR:-}: empty default is allowed", () => {
  const cfg = load({ ...VALID, profiles: [{ ...VALID.profiles[0], baseUrl: "${GATEWAY_URL:-}" }] });
  assert.equal(cfg!.profiles[0]!.baseUrl, "");
});

// ---------------------------------------------------------------------------
// ${VAR:?message}
// ---------------------------------------------------------------------------

const REQUIRED = { ...VALID, profiles: [{ ...VALID.profiles[0], apiKey: "${OPENAI_API_KEY:?set it in .env}" }] };

test("${VAR:?message}: set → value", () => {
  assert.equal(load(REQUIRED, { OPENAI_API_KEY: "sk-1" })!.profiles[0]!.apiKey, "sk-1");
});

test("${VAR:?message}: unset (non-strict) → warns with the message and ignores the config", (t) => {
  const warn = silenceWarnings(t);
  assert.equal(load(REQUIRED), null);
  const message = String(warn.mock.calls[0]!.arguments[0]);
  assert.match(message, /required env var OPENAI_API_KEY is not set: set it in \.env/);
});

test("${VAR:?message}: empty counts as unset; strict throws", () => {
  assert.throws(
    () => load(REQUIRED, { OPENAI_API_KEY: "" }, strict),
    (err: unknown) =>
      err instanceof LlmProfilesConfigError &&
      err.source === FILE &&
      /required env var OPENAI_API_KEY is not set: set it in \.env/.test(err.message),
  );
});

test("plain ${VAR}: unchanged behaviour — unset → empty string with a warning (non-strict)", (t) => {
  const warn = silenceWarnings(t);
  const cfg = load({ ...VALID, profiles: [{ ...VALID.profiles[0], apiKey: "${MISSING}" }] });
  assert.equal(cfg!.profiles[0]!.apiKey, "");
  assert.equal(warn.mock.callCount(), 1);
});

test("only whole-string references are interpolated", () => {
  const cfg = load({ ...VALID, profiles: [{ ...VALID.profiles[0], baseUrl: "https://${HOST}/v1" }] }, { HOST: "x" });
  assert.equal(cfg!.profiles[0]!.baseUrl, "https://${HOST}/v1");
});

// ---------------------------------------------------------------------------
// strict mode
// ---------------------------------------------------------------------------

test("strict: a valid config loads exactly as in non-strict mode", () => {
  assert.deepEqual(load(VALID, {}, strict), load(VALID));
});

test("strict: absent config still returns null", () => {
  assert.equal(loadLlmRoutingConfig({ filePath: "/nope", readFile: () => undefined, env: {}, strict: true }), null);
});

const STRICT_FAILURES: Array<[string, unknown, RegExp]> = [
  ["malformed JSON", "{ nope", /failed to parse \/cfg\.json/],
  ["non-object config", "[]", /missing non-empty "profiles" array/],
  ["empty profiles", { profiles: [], defaultProfile: "x" }, /missing non-empty "profiles" array/],
  ["profile missing model", { profiles: [{ name: "p", provider: "x" }], defaultProfile: "p" }, /profile #0 "p" is missing model/],
  ["non-object profile", { profiles: [VALID.profiles[0], 42], defaultProfile: "p" }, /profile #1 is not an object/],
  ["duplicate profile", { profiles: [VALID.profiles[0], VALID.profiles[0]], defaultProfile: "p" }, /duplicate profile name "p"/],
  ["unknown defaultProfile", { ...VALID, defaultProfile: "ghost" }, /"defaultProfile" must reference a known profile/],
  ["unknown component profile", { ...VALID, components: { a: { profile: "ghost" } } }, /component "a" references unknown profile "ghost"/],
  ["unknown component fallback", { ...VALID, components: { a: { profile: "p", fallback: "ghost" } } }, /unknown fallback "ghost"/],
  ["non-object component", { ...VALID, components: { a: "p" } }, /component "a" routing is not an object/],
  ["unset ${VAR}", { ...VALID, profiles: [{ ...VALID.profiles[0], apiKey: "${MISSING}" }] }, /env var MISSING referenced in config is not set/],
];

for (const [label, config, pattern] of STRICT_FAILURES) {
  test(`strict: ${label} → LlmProfilesConfigError`, (t) => {
    const warn = silenceWarnings(t);
    assert.throws(
      () => load(config, {}, strict),
      (err: unknown) => err instanceof LlmProfilesConfigError && err.name === "LlmProfilesConfigError" && pattern.test(err.message),
    );
    assert.equal(warn.mock.callCount(), 0, "strict mode throws instead of warning");
  });
}

test("strict: env source is named LLM_PROFILES_JSON on the error", () => {
  assert.throws(
    () => loadLlmRoutingConfig({ filePath: "/nope", readFile: () => undefined, env: { LLM_PROFILES_JSON: "{ bad" }, strict: true }),
    (err: unknown) => err instanceof LlmProfilesConfigError && err.source === "LLM_PROFILES_JSON",
  );
});

test("strict: errors never contain secrets", () => {
  const secret = "sk-live-should-not-leak";
  const cases = [
    { profiles: [{ name: "p", provider: "x", apiKey: secret }], defaultProfile: "p" },
    `{"profiles":[{"apiKey": ${secret}}]}`,
  ];
  for (const config of cases) {
    try {
      load(config, {}, strict);
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(err instanceof LlmProfilesConfigError);
      assert.doesNotMatch((err as Error).message, /sk-live/);
    }
  }
});
