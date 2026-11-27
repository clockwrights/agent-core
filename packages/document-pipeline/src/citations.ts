// ---------------------------------------------------------------------------
// Field citations
//
// With `fieldCitations`, the classifier asks the model for a verbatim quote
// per field. This module checks each quote against the units' extracted text
// (no LLM): it finds the character span, the file and page, and a bounding box
// when the unit has positioned layout blocks (OCR word boxes).
// ---------------------------------------------------------------------------

import type {
  BoundingBox,
  ClassifiedDocumentGroup,
  DocumentGroup,
  DocumentUnit,
  ExtractedField,
  FieldCitation,
  LayoutBlock,
  UnitExtractionResult,
} from "./types.js";

/** Longest quote kept on a citation, in characters. */
export const MAX_CITATION_QUOTE_CHARS = 300;

/** Everything a citation is checked against. */
export type CitationContext = {
  group: DocumentGroup;
  units: DocumentUnit[];
  extractions: UnitExtractionResult[];
};

type Normalized = { text: string; map: number[] };

/**
 * Normalize for matching: Unicode NFKC, lower case, whitespace runs to one
 * space, trimmed. `map[i]` is the index in the original string of the
 * character that produced normalized position `i`.
 */
function normalizeWithMap(source: string): Normalized {
  let text = "";
  const map: number[] = [];
  let lastWasSpace = true; // drops leading whitespace
  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    if (/\s/u.test(ch)) {
      if (!lastWasSpace) {
        text += " ";
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      const normalized = ch.normalize("NFKC").toLowerCase();
      for (let k = 0; k < normalized.length; k++) map.push(i);
      text += normalized;
      lastWasSpace = false;
    }
    i += ch.length;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** End index (exclusive) in the original string of normalized position `pos`. */
function originalEnd(source: string, map: number[], pos: number): number {
  const start = map[pos]!;
  return start + String.fromCodePoint(source.codePointAt(start)!).length;
}

/**
 * Character span of `quote` in `text`, ignoring case, Unicode width forms and
 * whitespace differences. `undefined` when the quote is not there.
 */
export function findQuoteSpan(text: string, quote: string): { start: number; end: number } | undefined {
  const q = normalizeWithMap(quote).text;
  if (!q) return undefined;
  const t = normalizeWithMap(text);
  const at = t.text.indexOf(q);
  if (at < 0) return undefined;
  return { start: t.map[at]!, end: originalEnd(text, t.map, at + q.length - 1) };
}

/**
 * Normalized box covering the layout blocks that overlap `span` of `text`.
 * Blocks are aligned to the text in order (each block found after the
 * previous one); when the alignment fails, or no overlapping block has a box,
 * the result is `undefined`.
 */
export function boxForSpan(
  text: string,
  blocks: readonly LayoutBlock[],
  span: { start: number; end: number },
): BoundingBox | undefined {
  if (blocks.length === 0) return undefined;
  const t = normalizeWithMap(text);
  const boxes: BoundingBox[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const b = normalizeWithMap(block.text).text;
    if (!b) continue;
    const at = t.text.indexOf(b, cursor);
    if (at < 0) return undefined;
    cursor = at + b.length;
    const start = t.map[at]!;
    const end = originalEnd(text, t.map, at + b.length - 1);
    if (start < span.end && end > span.start && block.boundingBox) boxes.push(block.boundingBox);
  }
  return unionBoxes(boxes);
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox | undefined {
  const first = boxes[0];
  if (!first) return undefined;
  const same = boxes.filter((b) => b.coordSpace === first.coordSpace);
  const x = Math.min(...same.map((b) => b.x));
  const y = Math.min(...same.map((b) => b.y));
  const right = Math.max(...same.map((b) => b.x + b.width));
  const bottom = Math.max(...same.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y, coordSpace: first.coordSpace };
}

/** 1-based page of a unit within its file. */
function pageOf(unit: DocumentUnit | undefined, units: DocumentUnit[]): number {
  if (!unit) return 1;
  const sameFile = units
    .filter((u) => u.sourceFileIndex === unit.sourceFileIndex)
    .map((u) => u.index)
    .sort((a, b) => a - b);
  return sameFile.indexOf(unit.index) + 1;
}

/**
 * Check one field's quote against the group's units. Returns the citation
 * (or `undefined` for an empty value or quote) and the unit it was found in.
 */
export function citeQuote(
  field: Pick<ExtractedField, "value" | "sourceUnitIndex">,
  quote: string | undefined,
  context: CitationContext,
  options: { deterministic?: boolean } = {},
): FieldCitation | undefined {
  const trimmed = (quote ?? "").trim().slice(0, MAX_CITATION_QUOTE_CHARS);
  if (!trimmed || !field.value) return undefined;

  const { group, units, extractions } = context;
  const unitMap = new Map(units.map((u) => [u.index, u]));
  const extractionMap = new Map(extractions.map((e) => [e.unitIndex, e]));
  const named = group.unitIndices.includes(field.sourceUnitIndex) ? field.sourceUnitIndex : undefined;
  const order = named === undefined ? group.unitIndices : [named, ...group.unitIndices.filter((i) => i !== named)];

  for (const unitIndex of order) {
    const extraction = extractionMap.get(unitIndex);
    const text = extraction?.text ?? "";
    if (!text.trim()) continue;
    const span = findQuoteSpan(text, trimmed);
    if (!span) continue;
    const unit = unitMap.get(unitIndex);
    const citation: FieldCitation = {
      unitIndex,
      sourceFileIndex: unit?.sourceFileIndex ?? 0,
      page: pageOf(unit, units),
      quote: trimmed,
      textSpan: span,
      status: options.deterministic ? "deterministic" : "verified",
    };
    const box = boxForSpan(text, extraction?.blocks ?? [], span);
    if (box) citation.boundingBox = box;
    return citation;
  }

  // Not found. "unverifiable" when there was nothing to check against: the
  // named unit has no text, or no unit of the group has any.
  const reported = named ?? group.unitIndices[0] ?? field.sourceUnitIndex;
  const hasText = (index: number) => Boolean((extractionMap.get(index)?.text ?? "").trim());
  const checkable = named !== undefined ? hasText(named) : group.unitIndices.some(hasText);
  const unit = unitMap.get(reported);
  return {
    unitIndex: reported,
    sourceFileIndex: unit?.sourceFileIndex ?? 0,
    page: pageOf(unit, units),
    quote: trimmed,
    status: checkable ? "not-found" : "unverifiable",
  };
}

/**
 * Attach citations to every field of a classified group, from the quotes the
 * classifier collected (`quotes`, keyed by field). Corrects `sourceUnitIndex`
 * when a quote is found in another unit of the group (flag
 * `source-unit-corrected:<field>` for model-reported units), and sets
 * `boundingBox` from the citation's box. Mutates and returns `result`.
 */
export function attachFieldCitations(
  result: ClassifiedDocumentGroup,
  quotes: { get(field: ExtractedField): string | undefined },
  context: CitationContext,
): ClassifiedDocumentGroup {
  for (const field of result.fields) {
    const deterministic = field.method === "deterministic";
    const citation = citeQuote(field, quotes.get(field), context, { deterministic });
    field.citations = citation ? [citation] : [];
    if (!citation || !citation.textSpan) continue;
    if (citation.unitIndex !== field.sourceUnitIndex) {
      field.sourceUnitIndex = citation.unitIndex;
      if (!deterministic) result.uncertaintyFlags.push(`source-unit-corrected:${field.name}`);
    }
    if (citation.boundingBox) field.boundingBox = citation.boundingBox;
  }
  return result;
}
