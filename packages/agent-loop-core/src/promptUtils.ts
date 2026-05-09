/** Input item for prompt budget allocation. Higher priority values are kept before lower values. */
export interface PromptBudgetItem {
  /** Text content to include in the prompt. Units are JavaScript string characters. */
  content: string;
  /** Priority used for allocation. Higher numbers are retained before lower numbers. */
  priority: number;
}

/** Options for `fitWithinBudget()`. */
export interface FitWithinBudgetOptions {
  /**
   * Minimum character floor for a selected item. Items that cannot fit at
   * least this many characters after paragraph-boundary truncation are omitted.
   */
  minimumItemChars?: number;
}

/** Result item returned by `fitWithinBudget()`. */
export type BudgetedPromptItem<TItem extends PromptBudgetItem> = TItem & {
  /** Original item content length before any truncation, measured in characters. */
  originalLength: number;
  /** Whether `content` was shortened to fit the total budget. */
  truncated: boolean;
};

/**
 * Selects the highest-priority prompt items that fit within a total character
 * budget, truncating oversized selected items at the last paragraph boundary
 * before their allocation. The returned items preserve the caller's original
 * ordering so adapters can render prompts naturally after budget allocation.
 *
 * Callers are responsible for passing already domain-appropriate priorities and
 * for choosing a realistic budget in JavaScript string characters. If an item
 * has no paragraph boundary within the remaining budget, it is omitted instead
 * of being cut mid-paragraph.
 */
export function fitWithinBudget<TItem extends PromptBudgetItem>(
  items: readonly TItem[],
  budgetChars: number,
  options: FitWithinBudgetOptions = {}
): Array<BudgetedPromptItem<TItem>> {
  const totalBudget = Math.max(0, Math.floor(budgetChars));
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return [];

  const minimumItemChars = Math.max(0, Math.floor(options.minimumItemChars ?? 0));
  const selected = new Map<number, BudgetedPromptItem<TItem>>();
  let remainingBudget = totalBudget;

  const prioritized = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const priorityDelta = right.item.priority - left.item.priority;
      return priorityDelta || left.index - right.index;
    });

  for (const { item, index } of prioritized) {
    if (remainingBudget <= 0) break;

    const originalLength = item.content.length;
    if (originalLength <= remainingBudget) {
      selected.set(index, {
        ...item,
        originalLength,
        truncated: false
      });
      remainingBudget -= originalLength;
      continue;
    }

    if (remainingBudget < minimumItemChars) continue;

    const truncatedContent = truncateAtParagraphBoundary(item.content, remainingBudget);
    if (truncatedContent.length < minimumItemChars || truncatedContent.length === 0) continue;

    selected.set(index, {
      ...item,
      content: truncatedContent,
      originalLength,
      truncated: true
    });
    remainingBudget -= truncatedContent.length;
  }

  return Array.from(selected.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, item]) => item);
}

function truncateAtParagraphBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const boundaryPattern = /\n\s*\n/g;
  let lastBoundary = -1;
  let match: RegExpExecArray | null;
  while ((match = boundaryPattern.exec(content)) !== null) {
    if (match.index > maxChars) break;
    lastBoundary = match.index;
  }

  if (lastBoundary <= 0) return "";
  return content.slice(0, lastBoundary).trimEnd();
}
