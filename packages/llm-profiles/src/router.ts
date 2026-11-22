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
//     declare a fallback still receive only the primary instance. With
//     several `fallbacks`, it is chained: withFailover(p, withFailover(f1, f2)).
//
//   - `withFallbacks?(primary, fallbacks, context)` — optional, takes
//     precedence over `withFailover`; sees the whole chain and `retry`.
//
//   - `withLoadBalance?(targets)` — optional wrapper for weighted primaries.
//
// Provider construction is memoised per profile name so multiple components
// referencing the same profile share one instance.
// ---------------------------------------------------------------------------

import type { LlmProfile, LlmRetryPolicy, LlmRoutingConfig } from "./profiles.js";
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
  /**
   * Optional wrapper for the whole fallback chain. Takes precedence over
   * `withFailover`. Receives the routing's `retry` policy and the profiles in
   * chain order (primary first), e.g. to build the provider around
   * `createFailover`. Called when the component has fallbacks or `retry`.
   */
  withFallbacks?: (primary: P, fallbacks: P[], context: FallbackContext) => P;
  /**
   * Optional wrapper for weighted primaries (`components.*.loadBalance`),
   * e.g. built on `createLoadBalancer`. When omitted, `loadBalance` is
   * ignored and the component's `profile` is the primary.
   */
  withLoadBalance?: (targets: Array<{ provider: P; weight: number; profile: LlmProfile }>) => P;
};

export type FallbackContext = {
  componentId: string;
  retry?: LlmRetryPolicy;
  /** Primary first, then fallbacks, in the order tried. */
  profiles: LlmProfile[];
};

/**
 * Build a router from a validated config.
 */
export function createLlmRouter<P>(
  config: LlmRoutingConfig,
  options: CreateLlmRouterOptions<P>,
): LlmRouter<P> {
  const { factory, withFailover, withFallbacks, withLoadBalance } = options;
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

      const primary =
        resolved.loadBalance && withLoadBalance
          ? withLoadBalance(
              resolved.loadBalance.map((t) => ({
                provider: providerForProfile(t.profile),
                weight: t.weight,
                profile: t.profile,
              })),
            )
          : providerForProfile(resolved.primary);
      const fallbacks = resolved.fallbacks.map(providerForProfile);

      if (withFallbacks && (fallbacks.length > 0 || resolved.retry)) {
        const context: FallbackContext = {
          componentId,
          profiles: [resolved.primary, ...resolved.fallbacks],
        };
        if (resolved.retry) context.retry = resolved.retry;
        return withFallbacks(primary, fallbacks, context);
      }
      if (fallbacks.length === 0 || !withFailover) return primary;

      // One fallback: exactly the old call. Several: chain right to left,
      // so `withFailover(primary, withFailover(fb1, fb2))`.
      const chain = fallbacks.reduceRight((rest, fallback) => withFailover(fallback, rest));
      return withFailover(primary, chain);
    },
  };
}
