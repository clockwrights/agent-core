// ---------------------------------------------------------------------------
// Tests: llm/profiles.ts — loader for the multi-profile routing config.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadLlmRoutingConfig,
  resolveComponentRouting,
  type LlmRoutingConfig,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = {
  profiles: [
    { name: "primary", provider: "openai", model: "gpt-5.2", apiKey: "${OPENAI_API_KEY}" },
    { name: "vision", provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "${ANTHROPIC_KEY}" },
  ],
  defaultProfile: "primary",
  components: {
    "main-agent": { profile: "primary", fallback: "vision" },
    "document-pipeline.tier-c": { profile: "vision" },
  },
};

function makeReader(map: Record<string, string>): (path: string) => string | undefined {
  return (p) => map[p];
}

// ---------------------------------------------------------------------------
// Source priority — file beats env
// ---------------------------------------------------------------------------

test("loadLlmRoutingConfig: file present → file wins over LLM_PROFILES_JSON env", () => {
  const filePath = "/fake/llm-profiles.json";
  const fileContents = JSON.stringify(MINIMAL_CONFIG);
  const envOnly = JSON.stringify({
    profiles: [{ name: "env-only", provider: "x", model: "y" }],
    defaultProfile: "env-only",
  });

  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: fileContents }),
    env: { LLM_PROFILES_JSON: envOnly, OPENAI_API_KEY: "k1", ANTHROPIC_KEY: "k2" },
  });

  assert.ok(config, "config should be returned");
  assert.equal(config!.defaultProfile, "primary");
  assert.equal(config!.profiles.length, 2);
});

test("loadLlmRoutingConfig: no file → falls back to LLM_PROFILES_JSON env", () => {
  const envText = JSON.stringify(MINIMAL_CONFIG);
  const config = loadLlmRoutingConfig({
    filePath: "/nope",
    readFile: makeReader({}),
    env: { LLM_PROFILES_JSON: envText, OPENAI_API_KEY: "k1", ANTHROPIC_KEY: "k2" },
  });

  assert.ok(config);
  assert.equal(config!.profiles.length, 2);
});

test("loadLlmRoutingConfig: neither file nor env → returns null", () => {
  const config = loadLlmRoutingConfig({
    filePath: "/nope",
    readFile: makeReader({}),
    env: {},
  });
  assert.equal(config, null);
});

test("loadLlmRoutingConfig: empty LLM_PROFILES_JSON env → returns null", () => {
  const config = loadLlmRoutingConfig({
    filePath: "/nope",
    readFile: makeReader({}),
    env: { LLM_PROFILES_JSON: "" },
  });
  assert.equal(config, null);
});

// ---------------------------------------------------------------------------
// Env var interpolation
// ---------------------------------------------------------------------------

test("loadLlmRoutingConfig: ${ENV_VAR} placeholders are substituted from env", () => {
  const filePath = "/cfg.json";
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: JSON.stringify(MINIMAL_CONFIG) }),
    env: { OPENAI_API_KEY: "sk-real-openai", ANTHROPIC_KEY: "sk-real-anthropic" },
  });

  assert.ok(config);
  const primary = config!.profiles.find((p) => p.name === "primary")!;
  const vision = config!.profiles.find((p) => p.name === "vision")!;
  assert.equal(primary.apiKey, "sk-real-openai");
  assert.equal(vision.apiKey, "sk-real-anthropic");
});

test("loadLlmRoutingConfig: missing referenced env var → empty string (warning emitted)", () => {
  const filePath = "/cfg.json";
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: JSON.stringify(MINIMAL_CONFIG) }),
    env: { OPENAI_API_KEY: "sk-1" }, // ANTHROPIC_KEY missing
  });

  assert.ok(config);
  const vision = config!.profiles.find((p) => p.name === "vision")!;
  assert.equal(vision.apiKey, "", "missing env var should produce empty string");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("loadLlmRoutingConfig: malformed JSON → returns null (warns, does not throw)", () => {
  const filePath = "/cfg.json";
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: "{ this is : not valid json" }),
    env: {},
  });
  assert.equal(config, null);
});

test("loadLlmRoutingConfig: defaultProfile not in profiles → returns null", () => {
  const filePath = "/cfg.json";
  const bad = JSON.stringify({
    profiles: [{ name: "a", provider: "openai", model: "x", apiKey: "k" }],
    defaultProfile: "does-not-exist",
  });
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: bad }),
    env: {},
  });
  assert.equal(config, null);
});

test("loadLlmRoutingConfig: empty profiles array → returns null", () => {
  const filePath = "/cfg.json";
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: JSON.stringify({ profiles: [], defaultProfile: "x" }) }),
    env: {},
  });
  assert.equal(config, null);
});

test("loadLlmRoutingConfig: component referencing unknown profile → component dropped, config still returned", () => {
  const filePath = "/cfg.json";
  const cfg = JSON.stringify({
    profiles: [{ name: "p1", provider: "openai", model: "m", apiKey: "k" }],
    defaultProfile: "p1",
    components: {
      "main-agent": { profile: "p1" },
      "bogus-component": { profile: "does-not-exist" },
    },
  });
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: cfg }),
    env: {},
  });
  assert.ok(config);
  assert.ok(config!.components?.["main-agent"]);
  assert.equal(config!.components?.["bogus-component"], undefined);
});

test("loadLlmRoutingConfig: component fallback unknown → fallback dropped but primary kept", () => {
  const filePath = "/cfg.json";
  const cfg = JSON.stringify({
    profiles: [{ name: "p1", provider: "openai", model: "m", apiKey: "k" }],
    defaultProfile: "p1",
    components: { "main-agent": { profile: "p1", fallback: "ghost" } },
  });
  const config = loadLlmRoutingConfig({
    filePath,
    readFile: makeReader({ [filePath]: cfg }),
    env: {},
  });
  assert.ok(config);
  assert.equal(config!.components?.["main-agent"]?.profile, "p1");
  assert.equal(config!.components?.["main-agent"]?.fallback, undefined);
});

// ---------------------------------------------------------------------------
// resolveComponentRouting
// ---------------------------------------------------------------------------

const RESOLVED_CFG: LlmRoutingConfig = {
  profiles: [
    { name: "primary", provider: "openai", model: "gpt-5.2", apiKey: "k1" },
    { name: "vision", provider: "anthropic", model: "claude", apiKey: "k2" },
    { name: "fallback", provider: "openai", model: "gpt-4o", apiKey: "k3" },
  ],
  defaultProfile: "primary",
  components: {
    "main-agent": { profile: "primary", fallback: "fallback" },
    "document-pipeline.tier-c": { profile: "vision" },
  },
};

test("resolveComponentRouting: known component returns its profile + fallback", () => {
  const r = resolveComponentRouting(RESOLVED_CFG, "main-agent");
  assert.ok(r);
  assert.equal(r!.primary.name, "primary");
  assert.equal(r!.fallback?.name, "fallback");
});

test("resolveComponentRouting: known component without fallback → fallback null", () => {
  const r = resolveComponentRouting(RESOLVED_CFG, "document-pipeline.tier-c");
  assert.ok(r);
  assert.equal(r!.primary.name, "vision");
  assert.equal(r!.fallback, null);
});

test("resolveComponentRouting: unknown component falls back to defaultProfile", () => {
  const r = resolveComponentRouting(RESOLVED_CFG, "no-such-component");
  assert.ok(r);
  assert.equal(r!.primary.name, "primary");
  assert.equal(r!.fallback, null);
});
