import { countTextTokens } from "../planning/token-counter";
import {
  DEFAULT_TEXT_TRANSLATION_OPTIONS,
  TEXT_TRANSLATION_TOKEN_LIMITS,
} from "@/type/textTranslation";
import {
  cloneSemanticMemory,
  type SemanticMemory,
  type SemanticMemoryTerminologyEntry,
} from "./semantic-memory";

export type CountSemanticMemoryTokens = (text: string) => number;

export interface TrimSemanticMemoryResult {
  memory: SemanticMemory;
  estimatedTokens: number;
  budget: number;
  overBudget: boolean;
  dropped: {
    modelTerminology: number;
    characters: number;
    styleRules: number;
    unresolvedContext: number;
    recentContinuityNotes: number;
  };
}

export interface ResolveSemanticMemoryBudgetInput {
  semanticMemoryTokenLimit?: number;
  modelContextTokenLimit: number;
  systemAndInstructionsTokens?: number;
  glossaryTokens?: number;
  currentSegmentTokens: number;
  recentWindowTokens?: number;
  outputTokenReserve: number;
  safetyMarginTokens?: number;
}

export interface ResolvedSemanticMemoryBudget {
  configuredLimit: number;
  effectiveBudget: number;
  availableForMemory: number;
  safetyMarginTokens: number;
  fixedContextTokens: number;
}

export function resolveSemanticMemoryBudget(
  input: ResolveSemanticMemoryBudgetInput,
): ResolvedSemanticMemoryBudget {
  const configuredLimit = Math.max(
    0,
    Math.trunc(
      input.semanticMemoryTokenLimit ??
        DEFAULT_TEXT_TRANSLATION_OPTIONS.semanticMemoryTokenLimit,
    ),
  );
  const safetyMarginTokens =
    input.safetyMarginTokens ??
    Math.max(
      TEXT_TRANSLATION_TOKEN_LIMITS.safetyMarginMinTokens,
      Math.ceil(
        input.modelContextTokenLimit *
          TEXT_TRANSLATION_TOKEN_LIMITS.safetyMarginRatio,
      ),
    );
  const fixedContextTokens =
    (input.systemAndInstructionsTokens ?? 0) +
    (input.glossaryTokens ?? 0) +
    input.currentSegmentTokens +
    (input.recentWindowTokens ?? 0) +
    input.outputTokenReserve +
    safetyMarginTokens;
  const availableForMemory = input.modelContextTokenLimit - fixedContextTokens;

  return {
    configuredLimit,
    effectiveBudget: Math.max(0, Math.min(configuredLimit, availableForMemory)),
    availableForMemory,
    safetyMarginTokens,
    fixedContextTokens,
  };
}

export function estimateSemanticMemoryTokens(
  memory: SemanticMemory,
  countTokens: CountSemanticMemoryTokens = countTextTokens,
): number {
  return countTokens(JSON.stringify(memory));
}

export function trimSemanticMemoryToBudget(
  memory: SemanticMemory,
  budget: number,
  countTokens: CountSemanticMemoryTokens = countTextTokens,
): TrimSemanticMemoryResult {
  const candidate = cloneSemanticMemory(memory);
  const dropped = {
    modelTerminology: 0,
    characters: 0,
    styleRules: 0,
    unresolvedContext: 0,
    recentContinuityNotes: 0,
  };
  const normalizedBudget = Math.max(0, Math.trunc(budget));

  const overBudget = () =>
    estimateSemanticMemoryTokens(candidate, countTokens) > normalizedBudget;

  trimModelTerminology(candidate.terminology, overBudget, () => {
    dropped.modelTerminology += 1;
  });

  if (overBudget()) {
    candidate.documentSummary = trimText(candidate.documentSummary, 1200);
  }
  if (overBudget()) {
    candidate.documentSummary = trimText(candidate.documentSummary, 600);
  }
  if (overBudget()) {
    candidate.currentChapterSummary = trimText(
      candidate.currentChapterSummary,
      600,
    );
    candidate.currentSceneSummary = trimText(candidate.currentSceneSummary, 800);
  }
  trimFromStart(candidate.characters, overBudget, () => {
    dropped.characters += 1;
  });
  trimFromStart(candidate.recentContinuityNotes, overBudget, () => {
    dropped.recentContinuityNotes += 1;
  });
  trimFromStart(candidate.unresolvedContext, overBudget, () => {
    dropped.unresolvedContext += 1;
  });

  const estimatedTokens = estimateSemanticMemoryTokens(candidate, countTokens);
  return {
    memory: candidate,
    estimatedTokens,
    budget: normalizedBudget,
    overBudget: estimatedTokens > normalizedBudget,
    dropped,
  };
}

function trimFromStart<T>(
  items: T[],
  shouldContinue: () => boolean,
  onDrop: () => void,
): void {
  while (items.length > 0 && shouldContinue()) {
    items.shift();
    onDrop();
  }
}

function trimModelTerminology(
  terminology: SemanticMemoryTerminologyEntry[],
  shouldContinue: () => boolean,
  onDrop: () => void,
): void {
  for (let index = terminology.length - 1; index >= 0 && shouldContinue(); index -= 1) {
    if (terminology[index].origin === "user") continue;
    terminology.splice(index, 1);
    onDrop();
  }
}

function trimText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trimEnd();
}
