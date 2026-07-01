import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { TranslationLanguage } from "@/type/subtitle";
import type {
  TextTranslationBilingualLabelMode,
  TextTranslationConflictPolicy,
  TextTranslationOutputMode,
  TextTranslationOutputPathMode,
} from "@/type/textTranslation";
import type { TranslationSegment } from "../types";

export interface TextTranslationSegmentResult {
  segmentId: string;
  translatedText: string;
  stale?: boolean;
}

export interface AssembleTxtTargetOnlyOptions {
  segments: TranslationSegment[];
  results: TextTranslationSegmentResult[];
}

export type TxtBilingualLabelMode = TextTranslationBilingualLabelMode;

export interface AssembleTxtBilingualOptions extends AssembleTxtTargetOnlyOptions {
  labelMode?: TxtBilingualLabelMode;
}

export interface ResolveTxtOutputPathOptions {
  sourcePath: string;
  targetLang: TranslationLanguage;
  outputPathMode: TextTranslationOutputPathMode;
  conflictPolicy: TextTranslationConflictPolicy;
  outputDir?: string;
}

export interface WriteTxtTargetOnlyOutputOptions
  extends AssembleTxtTargetOnlyOptions,
    ResolveTxtOutputPathOptions {}

export interface WriteTxtOutputOptions
  extends AssembleTxtBilingualOptions,
    ResolveTxtOutputPathOptions {
  outputMode: TextTranslationOutputMode;
}

export interface WriteTxtTargetOnlyOutputResult {
  outputPath: string;
  bytesWritten: number;
}

export function assembleTxtTargetOnlyContent(
  options: AssembleTxtTargetOnlyOptions,
): string {
  const resultBySegmentId = new Map(
    options.results.map((result) => [result.segmentId, result]),
  );
  const orderedSegments = [...options.segments].sort((left, right) => {
    if (left.globalIndex !== right.globalIndex) {
      return left.globalIndex - right.globalIndex;
    }
    return left.indexInFile - right.indexInFile;
  });

  let content = "";
  let previousSegment: TranslationSegment | undefined;

  for (const segment of orderedSegments) {
    const result = resultBySegmentId.get(segment.segmentId);
    if (!result) {
      throw new Error(`Missing translation result for segment: ${segment.segmentId}`);
    }
    if (result.stale) {
      throw new Error(`Stale translation result cannot be assembled: ${segment.segmentId}`);
    }

    if (previousSegment) {
      content += shouldJoinWithoutBlankLine(previousSegment, segment) ? "" : "\n\n";
    }
    content += result.translatedText;
    previousSegment = segment;
  }

  return content;
}

export function assembleTxtBilingualContent(
  options: AssembleTxtBilingualOptions,
): string {
  const resultBySegmentId = createResultMap(options.results);
  const blocks = groupSegmentsIntoNaturalBlocks(options.segments);
  const labelMode = options.labelMode ?? "none";

  return blocks
    .map((block) => {
      const sourceText = joinBlockSource(block);
      const translatedText = joinBlockTranslation(block, resultBySegmentId);
      if (!sourceText.trim() && !translatedText.trim()) return "";
      if (labelMode === "labels") {
        return [
          "[Original]",
          sourceText,
          "[Translation]",
          translatedText,
        ].join("\n");
      }
      return [sourceText, translatedText].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveTxtOutputPath(
  options: ResolveTxtOutputPathOptions,
): Promise<string> {
  const sourcePath = path.resolve(options.sourcePath);
  const outputDir =
    options.outputPathMode === "source"
      ? path.dirname(sourcePath)
      : options.outputDir;

  if (!outputDir) {
    throw new Error("Custom output directory is required.");
  }

  const parsed = path.parse(sourcePath);
  const languageSuffix = options.targetLang.toLowerCase();
  const baseOutputPath = path.join(
    outputDir,
    `${parsed.name}.${languageSuffix}${parsed.ext || ".txt"}`,
  );

  if (samePath(baseOutputPath, sourcePath)) {
    throw new Error("Text translation output path cannot overwrite source file.");
  }

  if (options.conflictPolicy === "overwrite") {
    return baseOutputPath;
  }

  return resolveIndexedPath(baseOutputPath, sourcePath);
}

export async function writeTxtTargetOnlyOutput(
  options: WriteTxtTargetOnlyOutputOptions,
): Promise<WriteTxtTargetOnlyOutputResult> {
  const content = assembleTxtTargetOnlyContent(options);
  const outputPath = await resolveTxtOutputPath(options);
  await atomicWriteUtf8(outputPath, content);
  return {
    outputPath,
    bytesWritten: Buffer.byteLength(content, "utf-8"),
  };
}

export async function writeTxtOutput(
  options: WriteTxtOutputOptions,
): Promise<WriteTxtTargetOnlyOutputResult> {
  const content =
    options.outputMode === "bilingual"
      ? assembleTxtBilingualContent(options)
      : assembleTxtTargetOnlyContent(options);
  const outputPath = await resolveTxtOutputPath(options);
  await atomicWriteUtf8(outputPath, content);
  return {
    outputPath,
    bytesWritten: Buffer.byteLength(content, "utf-8"),
  };
}

function createResultMap(
  results: TextTranslationSegmentResult[],
): Map<string, TextTranslationSegmentResult> {
  return new Map(results.map((result) => [result.segmentId, result]));
}

function groupSegmentsIntoNaturalBlocks(
  segments: TranslationSegment[],
): TranslationSegment[][] {
  const orderedSegments = [...segments].sort((left, right) => {
    if (left.globalIndex !== right.globalIndex) {
      return left.globalIndex - right.globalIndex;
    }
    return left.indexInFile - right.indexInFile;
  });
  const blocks: TranslationSegment[][] = [];

  for (const segment of orderedSegments) {
    const currentBlock = blocks[blocks.length - 1];
    const previousSegment = currentBlock?.[currentBlock.length - 1];
    if (
      currentBlock &&
      previousSegment &&
      shouldJoinWithoutBlankLine(previousSegment, segment)
    ) {
      currentBlock.push(segment);
    } else {
      blocks.push([segment]);
    }
  }

  return blocks;
}

function joinBlockSource(block: TranslationSegment[]): string {
  return block
    .map((segment, index) =>
      index > 0 && !shouldJoinWithoutBlankLine(block[index - 1], segment)
        ? `\n\n${segment.sourceText}`
        : segment.sourceText,
    )
    .join("");
}

function joinBlockTranslation(
  block: TranslationSegment[],
  resultBySegmentId: Map<string, TextTranslationSegmentResult>,
): string {
  let text = "";
  let previousSegment: TranslationSegment | undefined;
  for (const segment of block) {
    const result = resultBySegmentId.get(segment.segmentId);
    if (!result) {
      throw new Error(`Missing translation result for segment: ${segment.segmentId}`);
    }
    if (result.stale) {
      throw new Error(`Stale translation result cannot be assembled: ${segment.segmentId}`);
    }
    if (previousSegment) {
      text += shouldJoinWithoutBlankLine(previousSegment, segment) ? "" : "\n\n";
    }
    text += result.translatedText;
    previousSegment = segment;
  }
  return text;
}

function shouldJoinWithoutBlankLine(
  previous: TranslationSegment,
  current: TranslationSegment,
): boolean {
  return previous.endsMidUnit || current.startsMidUnit;
}

async function resolveIndexedPath(
  baseOutputPath: string,
  sourcePath: string,
): Promise<string> {
  const parsed = path.parse(baseOutputPath);
  let candidate = baseOutputPath;
  let index = 1;

  while (true) {
    if (samePath(candidate, sourcePath)) {
      candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      index += 1;
      continue;
    }

    try {
      await fs.access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
