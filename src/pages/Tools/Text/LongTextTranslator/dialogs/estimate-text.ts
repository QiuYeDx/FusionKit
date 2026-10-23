import type { Estimate } from '@/long-text/contract';
import { formatCost, formatTokens } from '@/utils/tokenEstimate';

/** "low–high", or one value when both bounds read the same. */
function range(low: string, high: string): string {
  return low === high ? low : `${low}–${high}`;
}

/** "52.1K–84.6K": the input plus output tokens of an estimate's lower and upper bound. */
export function tokenRange(estimate: Pick<Estimate, 'inputTokens' | 'outputTokens'>): string {
  const [inputLow, inputHigh] = estimate.inputTokens;
  const [outputLow, outputHigh] = estimate.outputTokens;
  return range(formatTokens(inputLow + outputLow), formatTokens(inputHigh + outputHigh));
}

/** Below this the page writes "<$0.001"; the shared `formatCost` would switch to per-mille dollars. */
const MIN_COST = 0.001;

/** "$0.031–0.050": one currency sign for both bounds; "<$0.001" for less than a tenth of a cent. */
export function costRangeText([low, high]: readonly [number, number]): string {
  if (high < MIN_COST) return `<$${MIN_COST}`;
  const lowText = low < MIN_COST ? `<$${MIN_COST}` : formatCost(low);
  const highText = formatCost(high);
  if (lowText === highText) return lowText;
  return range(lowText, highText.slice(1));
}

/**
 * A character count the way the page writes long counts: "38.2万" in Chinese and Japanese, "382.1K" in
 * English. Typed as a number for i18next's `count` option, like `groupedCount`.
 */
export function compactCount(value: number, language: string): number {
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value) as unknown as number;
}
