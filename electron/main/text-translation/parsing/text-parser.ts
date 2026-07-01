import type {
  CountTextTokens,
  TranslationUnit,
  TranslationUnitKind,
} from "../types";
import { countTextTokens } from "../planning/token-counter";

export interface ParseTxtTranslationUnitsOptions {
  fileId: string;
  text: string;
  maxUnitTokens: number;
  countTokens?: CountTextTokens;
}

interface TextRange {
  start: number;
  end: number;
  text: string;
  hardCut?: boolean;
}

export function parseTxtTranslationUnits(
  options: ParseTxtTranslationUnitsOptions,
): TranslationUnit[] {
  const countTokens = options.countTokens ?? countTextTokens;
  const naturalRanges = collectNaturalTextRanges(options.text);
  const units: TranslationUnit[] = [];

  for (const range of naturalRanges) {
    const kind = detectTxtUnitKind(range.text);
    const naturalUnitId = createUnitId(options.fileId, units.length);
    const splitRanges = splitRangeToTokenLimit(
      range,
      options.maxUnitTokens,
      countTokens,
    );

    for (const [partIndex, splitRange] of splitRanges.entries()) {
      const splitPartCount = splitRanges.length;
      units.push({
        unitId: createUnitId(options.fileId, units.length),
        fileId: options.fileId,
        order: units.length,
        kind,
        sourceStart: splitRange.start,
        sourceEnd: splitRange.end,
        sourceText: splitRange.text,
        translatable: splitRange.text.trim().length > 0,
        tokenCount: countTokens(splitRange.text),
        structuralContext:
          splitPartCount > 1
            ? {
                splitFromUnitId: naturalUnitId,
                splitPartIndex: partIndex,
                splitPartCount,
                hardCut: Boolean(splitRange.hardCut),
              }
            : undefined,
      });
    }
  }

  return units;
}

function collectNaturalTextRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let paragraphStart: number | undefined;
  let paragraphEnd = 0;
  let cursor = 0;

  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  for (const lineWithEnding of lines) {
    if (lineWithEnding === "") continue;

    const lineStart = cursor;
    const lineEndWithEnding = cursor + lineWithEnding.length;
    const lineText = lineWithEnding.endsWith("\n")
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    const lineEnd = lineStart + lineText.length;

    if (lineText.trim().length === 0) {
      if (paragraphStart !== undefined) {
        ranges.push({
          start: paragraphStart,
          end: paragraphEnd,
          text: text.slice(paragraphStart, paragraphEnd),
        });
        paragraphStart = undefined;
      }
    } else {
      paragraphStart ??= lineStart;
      paragraphEnd = lineEnd;
    }

    cursor = lineEndWithEnding;
  }

  if (paragraphStart !== undefined) {
    ranges.push({
      start: paragraphStart,
      end: paragraphEnd,
      text: text.slice(paragraphStart, paragraphEnd),
    });
  }

  return ranges;
}

function splitRangeToTokenLimit(
  range: TextRange,
  maxTokens: number,
  countTokens: CountTextTokens,
): TextRange[] {
  if (maxTokens <= 0) {
    throw new Error("maxUnitTokens must be greater than zero.");
  }
  if (countTokens(range.text) <= maxTokens) return [range];

  return splitByBoundaries(range, maxTokens, countTokens);
}

function splitByBoundaries(
  range: TextRange,
  maxTokens: number,
  countTokens: CountTextTokens,
): TextRange[] {
  const boundaries = collectPreferredBoundaries(range.text);
  const parts: TextRange[] = [];
  let localStart = 0;

  while (localStart < range.text.length) {
    const localEnd = findBestBoundary(
      range.text,
      localStart,
      boundaries,
      maxTokens,
      countTokens,
    );

    const hardCut = localEnd.hardCut;
    const text = range.text.slice(localStart, localEnd.index);
    parts.push({
      start: range.start + localStart,
      end: range.start + localEnd.index,
      text,
      hardCut,
    });
    localStart = localEnd.index;

    while (
      localStart < range.text.length &&
      /\s/.test(range.text[localStart]) &&
      countTokens(range.text[localStart]) === 0
    ) {
      localStart += 1;
    }
  }

  return parts.filter((part) => part.text.length > 0);
}

function collectPreferredBoundaries(text: string): number[] {
  const boundaries = new Set<number>();

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") {
      boundaries.add(index + 1);
    } else if (/[。！？!?；;：:]/.test(character)) {
      boundaries.add(index + 1);
    } else if (character === "." && /\s|$/.test(text[index + 1] ?? "")) {
      boundaries.add(index + 1);
    }
  }

  return [...boundaries].sort((left, right) => left - right);
}

function findBestBoundary(
  text: string,
  localStart: number,
  boundaries: number[],
  maxTokens: number,
  countTokens: CountTextTokens,
): { index: number; hardCut: boolean } {
  const possibleBoundaries = boundaries.filter((boundary) => boundary > localStart);
  let best: number | undefined;

  for (const boundary of possibleBoundaries) {
    const candidate = text.slice(localStart, boundary);
    if (countTokens(candidate) > maxTokens) break;
    best = boundary;
  }

  if (best !== undefined) return { index: best, hardCut: false };

  return {
    index: findHardCutIndex(text, localStart, maxTokens, countTokens),
    hardCut: true,
  };
}

function findHardCutIndex(
  text: string,
  localStart: number,
  maxTokens: number,
  countTokens: CountTextTokens,
): number {
  let localEnd = localStart + 1;
  let best = localEnd;

  while (localEnd <= text.length) {
    const candidate = text.slice(localStart, localEnd);
    if (countTokens(candidate) > maxTokens) break;
    best = localEnd;
    localEnd += 1;
  }

  return Math.max(best, localStart + 1);
}

function detectTxtUnitKind(text: string): TranslationUnitKind {
  const trimmed = text.trim();
  const isSingleLine = !trimmed.includes("\n");
  if (
    isSingleLine &&
    trimmed.length <= 120 &&
    /^(?:chapter|part|book|volume)\b|^第[一二三四五六七八九十百千万\d]+[章节卷部回]|^[一二三四五六七八九十百千万\d]+[、.．]/i.test(
      trimmed,
    )
  ) {
    return "heading";
  }
  return "paragraph";
}

function createUnitId(fileId: string, order: number): string {
  return `${fileId}_u_${String(order).padStart(6, "0")}`;
}
