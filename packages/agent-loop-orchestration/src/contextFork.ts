/**
 * Context-fork rendering (Stage 5).
 *
 * Produces the `[Optional Parent Context]` block appended to a child's
 * system prompt when `contextMode === "fork"`. The consumer pre-selects
 * which slices to fork over (orchestration never inspects parent state
 * directly); this module is responsible only for:
 *
 *   1. Skipping empty slices.
 *   2. Truncating individual long slices.
 *   3. Capping the total rendered block.
 *   4. Producing stable, deterministic output for fixed inputs.
 *
 * Reusability: domain-neutral. Slice labels and content are treated as
 * opaque text. No consumer-domain terms appear in identifiers or output.
 */

import type { ParentContextSlice } from "./orchestrationTypes.js";

export const DEFAULT_MAX_FORK_CONTEXT_CHARS = 6_000;
export const DEFAULT_MAX_SLICE_CHARS = 2_000;

export interface ForkContextOptions {
  /** Total character cap on the rendered block (header + slices + truncation note). */
  maxChars?: number;
  /** Per-slice cap; long slices are truncated individually before assembly. */
  maxSliceChars?: number;
}

const HEADER = "[Optional Parent Context]";
const TRUNCATED_NOTE = "(parent context truncated)";

/**
 * Render parent-context slices into the prompt block.
 *
 * Returns `undefined` when there is nothing to include (no slices, or all
 * slices empty after trimming, or the available budget is too small for
 * even the header). The `undefined` return lets the prompt builder skip
 * the block cleanly without emitting a trailing empty section.
 */
export function buildForkedContextBlock(
  slices: ParentContextSlice[] | undefined,
  options: ForkContextOptions = {}
): string | undefined {
  if (!slices || slices.length === 0) return undefined;

  const maxChars = options.maxChars ?? DEFAULT_MAX_FORK_CONTEXT_CHARS;
  const maxSliceChars = options.maxSliceChars ?? DEFAULT_MAX_SLICE_CHARS;
  if (maxChars <= HEADER.length) return undefined;

  const renderedSlices: string[] = [];
  let used = HEADER.length;
  let truncated = false;

  for (const slice of slices) {
    const content = normaliseContent(slice.content);
    if (!content) continue;

    const block = formatSlice(slice.label, slice.kind, content, maxSliceChars);
    // +2 for the "\n\n" separator between sections.
    const cost = block.length + 2;
    const noteReserve = TRUNCATED_NOTE.length + 2;

    if (used + cost > maxChars - noteReserve) {
      truncated = true;
      break;
    }
    renderedSlices.push(block);
    used += cost;
  }

  if (renderedSlices.length === 0) return undefined;

  const sections = [HEADER, ...renderedSlices];
  if (truncated) sections.push(TRUNCATED_NOTE);
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normaliseContent(raw: string | undefined): string {
  if (!raw) return "";
  return raw.trim();
}

function formatSlice(
  label: string,
  kind: string | undefined,
  content: string,
  maxSliceChars: number
): string {
  const safeLabel = sanitiseLabel(label);
  const header = kind ? `### ${safeLabel} (${kind})` : `### ${safeLabel}`;
  const truncatedContent =
    content.length > maxSliceChars ? `${content.slice(0, Math.max(0, maxSliceChars - 1))}…` : content;
  return `${header}\n${truncatedContent}`;
}

function sanitiseLabel(label: string): string {
  // Strip newlines so a malformed slice label can't break the section header.
  // No domain rules — purely structural.
  const cleaned = label.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "(unlabelled)";
}
