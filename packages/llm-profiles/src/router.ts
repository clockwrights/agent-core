// ---------------------------------------------------------------------------
// LLM Routing — reusable, provider-agnostic
//
// `createLlmRouter<P>` resolves a `LlmRoutingConfig` into per-component
// provider instances of any type `P`. The caller supplies:
//
//   - `factory(profile)` — how to construct a `P` from an `LlmProfile`. This
//     is where app-specific provider construction lives (e.g. wrapping a
//     tool-agent-runtime call, or any other runtime).
//
//   - `withFailover?(primary, fallback)` — optional wrapper applied when a
//     component declares a `fallback` profile. Apps decide failover semantics
//     for their own provider interface (which methods to wrap, whether empty
//     responses count as failure, etc.). When omitted, components that
//     declare a fallback still receive only the primary instance.
//
// Provider construction is memoised per profile name so multiple components
// referencing the same profile share one instance.
// ---------------------------------------------------------------------------

import type { LlmProfile, LlmRoutingConfig } from "./profiles.js";
import { resolveComponentRouting } from "./profiles.js";

export type LlmRouter<P> = {
  /**
   * Return the provider configured for the named component. When the
   * component has a fallback profile and `withFailover` was supplied at
   * construction time, the returned provider is the wrapped (failover-aware)
   * instance.
   */
  forComponent(componentId: string): P;
};

export type CreateLlmRouterOptions<P> = {
  /** How to construct a provider from a profile. Required. */
  factory: (profile: LlmProfile) => P;
  /**
   * Optional failover wrapper. Applied only when the component declares a
   * `fallback` profile. Apps decide which methods of `P` participate in
   * failover and what counts as failure.
   */
  withFailover?: (primary: P, fallback: P) => P;
};

/**
 * Build a router from a validated config.
 */
export function createLlmRouter<P>(
  config: LlmRoutingConfig,
  options: CreateLlmRouterOptions<P>,
): LlmRouter<P> {
  const { factory, withFailover } = options;
  const cache = new Map<string, P>();

  const providerForProfile = (profile: LlmProfile): P => {
    const cached = cache.get(profile.name);
    if (cached !== undefined) return cached;
    const provider = factory(profile);
    cache.set(profile.name, provider);
    return provider;
  };

  return {
    forComponent(componentId: string): P {
      const resolved = resolveComponentRouting(config, componentId);
      if (!resolved) {
        throw new Error(
          `[llm-router] cannot resolve component "${componentId}" — no matching profile and no defaultProfile fallback.`,
        );
      }

      const primary = providerForProfile(resolved.primary);
      if (!resolved.fallback || !withFailover) return primary;

      const fallback = providerForProfile(resolved.fallback);
      return withFailover(primary, fallback);
    },
  };
}
