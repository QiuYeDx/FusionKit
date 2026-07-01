import path from "path";
import type {
  CountTextTokens,
  TranslationSegment,
  TranslationUnit,
} from "../types";
import { countTextTokens } from "./token-counter";

export interface PlanTranslationSegmentsOptions {
  fileId: string;
  units: TranslationUnit[];
  sliceTokenLimit: number;
  startingGlobalIndex?: number;
  countTokens?: CountTextTokens;
}

export function planTranslationSegments(
  options: PlanTranslationSegmentsOptions,
): TranslationSegment[] {
  if (options.sliceTokenLimit <= 0) {
    throw new Error("sliceTokenLimit must be greater than zero.");
  }

  const orderedUnits = [...options.units].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.sourceStart - right.sourceStart;
  });

  const segments: TranslationSegment[] = [];
  const countTokens = options.countTokens ?? countTextTokens;
  let currentUnits: TranslationUnit[] = [];
  let currentTokenCount = 0;

  const flush = () => {
    if (currentUnits.length === 0) return;

    const globalIndex = (options.startingGlobalIndex ?? 0) + segments.length;
    const sourceText = joinSegmentSourceText(currentUnits);
    segments.push({
      segmentId: createSegmentId(options.fileId, segments.length),
      fileId: options.fileId,
      indexInFile: segments.length,
      globalIndex,
      unitIds: currentUnits.map((unit) => unit.unitId),
      sourceTokenCount: currentTokenCount,
      sourceTextSnapshotPath: path.posix.join(
        "segments",
        "source",
        `${String(globalIndex).padStart(8, "0")}.txt`,
      ),
      sourceText,
      startsMidUnit: startsInsideSplitUnit(currentUnits[0]),
      endsMidUnit: endsInsideSplitUnit(currentUnits[currentUnits.length - 1]),
    });

    currentUnits = [];
    currentTokenCount = 0;
  };

  for (const unit of orderedUnits) {
    if (!unit.translatable && unit.tokenCount === 0) continue;

    const candidateUnits = [...currentUnits, unit];
    const candidateTokenCount = countTokens(joinSegmentSourceText(candidateUnits));
    const wouldExceed =
      currentUnits.length > 0 &&
      candidateTokenCount > options.sliceTokenLimit;

    if (wouldExceed) flush();

    currentUnits.push(unit);
    currentTokenCount = countTokens(joinSegmentSourceText(currentUnits));

    if (currentTokenCount >= options.sliceTokenLimit) {
      flush();
    }
  }

  flush();
  return segments;
}

function joinSegmentSourceText(units: TranslationUnit[]): string {
  return units.map((unit) => unit.sourceText).join("\n\n");
}

function startsInsideSplitUnit(unit: TranslationUnit): boolean {
  const context = unit.structuralContext;
  return Boolean(
    context?.splitFromUnitId &&
      context.splitPartIndex !== undefined &&
      context.splitPartIndex > 0,
  );
}

function endsInsideSplitUnit(unit: TranslationUnit): boolean {
  const context = unit.structuralContext;
  return Boolean(
    context?.splitFromUnitId &&
      context.splitPartIndex !== undefined &&
      context.splitPartCount !== undefined &&
      context.splitPartIndex < context.splitPartCount - 1,
  );
}

function createSegmentId(fileId: string, indexInFile: number): string {
  return `${fileId}_s_${String(indexInFile).padStart(6, "0")}`;
}
