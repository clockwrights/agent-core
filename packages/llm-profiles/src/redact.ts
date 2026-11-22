// ---------------------------------------------------------------------------
// Secret redaction helpers
//
// Resolved profiles carry real credentials after `${ENV_VAR}` interpolation.
// These helpers let apps log, trace or surface profiles and provider errors
// without leaking them. The loader itself never logs a resolved profile.
// ---------------------------------------------------------------------------

import type { LlmProfile, LlmRoutingConfig } from "./profiles.js";

/** Placeholder written in place of a secret. */
export const REDACTED = "[REDACTED]";

/**
 * Secrets shorter than this are not scrubbed from free text: replacing very
 * short strings would mangle unrelated text without protecting anything.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Return a copy of `profile` that is safe to log: `apiKey` is replaced with
 * `[REDACTED]` (when set and non-empty) and any `user:password@` credentials
 * in `baseUrl` are redacted. The input is not modified.
 */
export function redactProfile(profile: LlmProfile): LlmProfile {
  const copy: LlmProfile = { ...profile };
  if (copy.apiKey) copy.apiKey = REDACTED;
  if (copy.baseUrl) copy.baseUrl = redactUrlCredentials(copy.baseUrl);
  return copy;
}

/**
 * Build a function that replaces every secret found in the given profiles
 * (API keys and `baseUrl` credentials) with `[REDACTED]` in arbitrary text.
 * Use it on provider error messages, event payloads or trace attributes
 * before they leave the process.
 */
export function createSecretRedactor(
  source: LlmRoutingConfig | readonly LlmProfile[],
): (text: string) => string {
  const profiles = Array.isArray(source) ? source : (source as LlmRoutingConfig).profiles;
  const secrets = new Set<string>();
  for (const profile of profiles) {
    if (profile.apiKey) secrets.add(profile.apiKey);
    for (const credential of urlCredentials(profile.baseUrl)) secrets.add(credential);
  }
  // Longest first so a secret that contains another is replaced whole.
  const ordered = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  return (text: string): string => {
    let out = text;
    for (const secret of ordered) out = out.split(secret).join(REDACTED);
    return out;
  };
}

function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    return parsed.toString();
  } catch {
    // Not a parseable URL: leave it as is; it carries no structured credentials.
    return url;
  }
}

function urlCredentials(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    const out: string[] = [];
    if (parsed.username) out.push(parsed.username, decodeURIComponent(parsed.username));
    if (parsed.password) out.push(parsed.password, decodeURIComponent(parsed.password));
    return out;
  } catch {
    return [];
  }
}
