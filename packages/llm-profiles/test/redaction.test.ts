// ---------------------------------------------------------------------------
// Tests: secrets never reach warnings; redaction helpers.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test, type TestContext } from "node:test";
import {
  REDACTED,
  createSecretRedactor,
  loadLlmRoutingConfig,
  redactProfile,
  type LlmProfile,
} from "../src/index.js";

const SECRET = "sk-live-0123456789abcdef";

/** Capture every console.warn call as the text a console would print. */
function captureWarnings(t: TestContext): () => string {
  const warn = t.mock.method(console, "warn", () => {});
  return () =>
    warn.mock.calls
      .map((call) => call.arguments.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "))
      .join("\n");
}

test("loader: malformed profile with an interpolated key logs no secret", (t) => {
  const warnings = captureWarnings(t);
  const filePath = "/cfg.json";
  const cfg = JSON.stringify({
    profiles: [
      { name: "ok", provider: "openai", model: "m", apiKey: "${OK_KEY}" },
      // missing model → rejected and warned about
      { name: "broken", provider: "openai", apiKey: "${BROKEN_KEY}" },
    ],
    defaultProfile: "ok",
  });

  const config = loadLlmRoutingConfig({
    filePath,
    readFile: (p) => (p === filePath ? cfg : undefined),
    env: { OK_KEY: "sk-ok-key-1234", BROKEN_KEY: SECRET },
  });

  assert.ok(config);
  assert.equal(config!.profiles.length, 1);
  const text = warnings();
  assert.match(text, /profile #1 "broken" is missing model/);
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, /sk-ok-key-1234/);
});

test("loader: malformed profile without a name is described by index only", (t) => {
  const warnings = captureWarnings(t);
  const filePath = "/cfg.json";
  const cfg = JSON.stringify({
    profiles: [
      { name: "ok", provider: "openai", model: "m" },
      { provider: "openai", apiKey: SECRET },
    ],
    defaultProfile: "ok",
  });

  loadLlmRoutingConfig({ filePath, readFile: (p) => (p === filePath ? cfg : undefined), env: {} });

  const text = warnings();
  assert.match(text, /profile #1 is missing name\/model/);
  assert.doesNotMatch(text, new RegExp(SECRET));
});

test("loader: invalid JSON in LLM_PROFILES_JSON does not echo the raw text", (t) => {
  const warnings = captureWarnings(t);
  // Unquoted value: V8's SyntaxError quotes a snippet of the input here.
  const envText = `{"profiles":[{"name":"p","provider":"x","model":"y","apiKey": ${SECRET}}]}`;

  const config = loadLlmRoutingConfig({
    filePath: "/nope",
    readFile: () => undefined,
    env: { LLM_PROFILES_JSON: envText },
  });

  assert.equal(config, null);
  const text = warnings();
  assert.match(text, /failed to parse LLM_PROFILES_JSON/);
  assert.doesNotMatch(text, /sk-live/);
});

test("loader: invalid JSON in the config file does not echo the raw text", (t) => {
  const warnings = captureWarnings(t);
  const filePath = "/cfg.json";
  const fileText = `{"profiles":[{"apiKey": ${SECRET}}]}`;

  const config = loadLlmRoutingConfig({
    filePath,
    readFile: (p) => (p === filePath ? fileText : undefined),
    env: {},
  });

  assert.equal(config, null);
  const text = warnings();
  assert.match(text, /failed to parse \/cfg\.json/);
  assert.doesNotMatch(text, /sk-live/);
});

test("redactProfile: hides apiKey and baseUrl credentials without mutating the input", () => {
  const profile: LlmProfile = {
    name: "p",
    provider: "openai",
    model: "m",
    apiKey: SECRET,
    baseUrl: "https://user:hunter22@gateway.example/v1",
  };

  const safe = redactProfile(profile);

  assert.equal(safe.apiKey, REDACTED);
  assert.doesNotMatch(safe.baseUrl!, /hunter22/);
  assert.doesNotMatch(safe.baseUrl!, /user:/);
  assert.match(safe.baseUrl!, /gateway\.example\/v1/);
  assert.equal(profile.apiKey, SECRET, "input must not be modified");
  assert.equal(safe.name, "p");
});

test("redactProfile: leaves profiles without secrets unchanged", () => {
  const profile: LlmProfile = { name: "p", provider: "x", model: "m", baseUrl: "https://gateway.example/v1" };
  assert.deepEqual(redactProfile(profile), profile);
});

test("createSecretRedactor: scrubs every configured secret from text", () => {
  const redact = createSecretRedactor({
    profiles: [
      { name: "a", provider: "x", model: "m", apiKey: SECRET },
      { name: "b", provider: "x", model: "m", apiKey: "sk-other-9999", baseUrl: "https://u:p%40ss@h.example" },
      { name: "c", provider: "x", model: "m", apiKey: "" },
    ],
    defaultProfile: "a",
  });

  const message = `401 from provider: key ${SECRET} rejected; retry with sk-other-9999 via p@ss`;
  const out = redact(message);

  assert.doesNotMatch(out, /sk-live|sk-other|p@ss/);
  assert.equal(out.split(REDACTED).length - 1, 3);
  assert.equal(redact("nothing secret here"), "nothing secret here");
});

test("createSecretRedactor: accepts a profile array and replaces longer secrets first", () => {
  const redact = createSecretRedactor([
    { name: "a", provider: "x", model: "m", apiKey: "abcd" },
    { name: "b", provider: "x", model: "m", apiKey: "abcd-efgh" },
  ]);
  assert.equal(redact("abcd-efgh and abcd"), `${REDACTED} and ${REDACTED}`);
});
