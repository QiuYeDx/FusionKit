import { promises as fs } from "fs";
import path from "path";
import type { TranslationLanguage } from "@/type/subtitle";
import type {
  TextTranslationConflictPolicy,
  TextTranslationOutputPathMode,
} from "@/type/textTranslation";
import type { Root, RootContent } from "mdast";
import type { TranslationUnit } from "../types";
import {
  collectMarkdownTranslatableSpans,
  parseMarkdownAst,
} from "../parsing/markdown-parser";
import {
  restoreProtectedPlaceholders,
  type ProtectedPlaceholder,
} from "../parsing/protected-placeholders";
import { resolveTxtOutputPath } from "./text-output-assembler";

export interface MarkdownUnitTranslationResult {
  unitId: string;
  translatedText: string;
  stale?: boolean;
  placeholders?: ProtectedPlaceholder[];
}

export interface MarkdownBilingualBlock {
  blockId: string;
  nodeType: string;
  occurrence: number;
  start: number;
  end: number;
  sourceText: string;
  quoteDepth: number;
}

export interface MarkdownBlockTranslationResult {
  blockId: string;
  translatedMarkdown: string;
  stale?: boolean;
  placeholders?: ProtectedPlaceholder[];
}

export interface AssembleMarkdownTargetOnlyOptions {
  sourceText: string;
  units: TranslationUnit[];
  results: MarkdownUnitTranslationResult[];
}

export interface AssembleMarkdownBilingualOptions {
  sourceText: string;
  translations: MarkdownBlockTranslationResult[];
  ast?: Root;
}

export interface WriteMarkdownTargetOnlyOutputOptions
  extends AssembleMarkdownTargetOnlyOptions {
  sourcePath: string;
  targetLang: TranslationLanguage;
  outputPathMode: TextTranslationOutputPathMode;
  conflictPolicy: TextTranslationConflictPolicy;
  outputDir?: string;
}

export interface WriteMarkdownTargetOnlyOutputResult {
  outputPath: string;
  bytesWritten: number;
}

interface MarkdownReplacement {
  start: number;
  end: number;
  text: string;
  unitId: string;
}

interface MarkdownInsertion {
  offset: number;
  text: string;
  blockId: string;
}

export function assembleMarkdownTargetOnlyContent(
  options: AssembleMarkdownTargetOnlyOptions,
): string {
  const resultByUnitId = new Map(
    options.results.map((result) => [result.unitId, result]),
  );
  const replacements = options.units
    .filter((unit) => unit.translatable)
    .map((unit): MarkdownReplacement => {
      const result = resultByUnitId.get(unit.unitId);
      if (!result) {
        throw new Error(`Missing Markdown translation result for unit: ${unit.unitId}`);
      }
      if (result.stale) {
        throw new Error(`Stale Markdown translation result cannot be assembled: ${unit.unitId}`);
      }
      return {
        unitId: unit.unitId,
        start: unit.sourceStart,
        end: unit.sourceEnd,
        text: restoreProtectedPlaceholders(
          result.translatedText,
          result.placeholders ?? [],
        ),
      };
    });

  assertReplacementRanges(options.sourceText, replacements);

  let output = options.sourceText;
  for (const replacement of [...replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.text +
      output.slice(replacement.end);
  }
  return output;
}

export async function writeMarkdownTargetOnlyOutput(
  options: WriteMarkdownTargetOnlyOutputOptions,
): Promise<WriteMarkdownTargetOnlyOutputResult> {
  const content = assembleMarkdownTargetOnlyContent(options);
  const outputPath = await resolveTxtOutputPath(options);
  await atomicWriteUtf8(outputPath, content);
  return {
    outputPath,
    bytesWritten: Buffer.byteLength(content, "utf-8"),
  };
}

export function collectMarkdownBilingualBlocks(
  sourceText: string,
  ast: Root = parseMarkdownAst(sourceText),
): MarkdownBilingualBlock[] {
  const occurrences = new Map<string, number>();
  const blocks: MarkdownBilingualBlock[] = [];

  for (const node of ast.children) {
    const range = getBlockRange(sourceText, node);
    if (!range || !isTranslatableBlock(sourceText, node)) continue;

    const occurrence = (occurrences.get(node.type) ?? 0) + 1;
    occurrences.set(node.type, occurrence);
    blocks.push({
      blockId: `md_block_${String(blocks.length).padStart(6, "0")}`,
      nodeType: node.type,
      occurrence,
      start: range.start,
      end: range.end,
      sourceText: range.source,
      quoteDepth: node.type === "blockquote" ? detectQuoteDepth(range.source) + 1 : 1,
    });
  }

  return blocks;
}

export function assembleMarkdownBilingualContent(
  options: AssembleMarkdownBilingualOptions,
): string {
  const ast = options.ast ?? parseMarkdownAst(options.sourceText);
  const blocks = collectMarkdownBilingualBlocks(options.sourceText, ast);
  const translationByBlockId = new Map(
    options.translations.map((translation) => [translation.blockId, translation]),
  );
  const insertions = blocks
    .map((block): MarkdownInsertion | null => {
      const translation = translationByBlockId.get(block.blockId);
      if (!translation) {
        throw new Error(`Missing Markdown block translation: ${block.blockId}`);
      }
      if (translation.stale) {
        throw new Error(
          `Stale Markdown block translation cannot be assembled: ${block.blockId}`,
        );
      }
      const translatedMarkdown = restoreProtectedPlaceholders(
        translation.translatedMarkdown,
        translation.placeholders ?? [],
      );
      if (!translatedMarkdown.trim()) return null;
      return {
        blockId: block.blockId,
        offset: block.end,
        text: `\n\n${quoteMarkdown(translatedMarkdown, block.quoteDepth)}`,
      };
    })
    .filter((insertion): insertion is MarkdownInsertion => Boolean(insertion));

  assertInsertionRanges(options.sourceText, insertions);

  let output = options.sourceText;
  for (const insertion of [...insertions].sort(
    (left, right) => right.offset - left.offset,
  )) {
    output =
      output.slice(0, insertion.offset) +
      insertion.text +
      output.slice(insertion.offset);
  }
  return output;
}

function assertReplacementRanges(
  sourceText: string,
  replacements: MarkdownReplacement[],
): void {
  const ordered = [...replacements].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return left.end - right.end;
  });
  let previousEnd = -1;

  for (const replacement of ordered) {
    if (
      !Number.isInteger(replacement.start) ||
      !Number.isInteger(replacement.end) ||
      replacement.start < 0 ||
      replacement.end > sourceText.length ||
      replacement.start >= replacement.end
    ) {
      throw new Error(
        `Invalid Markdown replacement range for unit ${replacement.unitId}: ${replacement.start}-${replacement.end}`,
      );
    }
    if (replacement.start < previousEnd) {
      throw new Error(
        `Overlapping Markdown replacement range for unit ${replacement.unitId}: ${replacement.start}-${replacement.end}`,
      );
    }
    previousEnd = replacement.end;
  }
}

async function atomicWriteUtf8(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${Date.now()}.tmp`,
  );
  await fs.writeFile(temporaryPath, content, { encoding: "utf-8" });
  await fs.rename(temporaryPath, targetPath);
}

function getBlockRange(
  sourceText: string,
  node: RootContent,
): { start: number; end: number; source: string } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || start >= end) return undefined;
  return {
    start,
    end,
    source: sourceText.slice(start, end),
  };
}

function isTranslatableBlock(sourceText: string, node: RootContent): boolean {
  return (
    collectMarkdownTranslatableSpans(sourceText, {
      type: "root",
      children: [node],
    }).length > 0
  );
}

function detectQuoteDepth(markdown: string): number {
  const quotedLine = markdown
    .split("\n")
    .map((line) => line.match(/^(\s*(?:>\s*)+)/)?.[1] ?? "")
    .filter(Boolean)
    .sort((left, right) => left.length - right.length)[0];

  if (!quotedLine) return 1;
  return quotedLine.split(">").length - 1;
}

function quoteMarkdown(markdown: string, depth: number): string {
  const prefix = Array.from({ length: depth }, () => ">").join(" ");
  return markdown
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix} ${line}` : prefix))
    .join("\n");
}

function assertInsertionRanges(
  sourceText: string,
  insertions: MarkdownInsertion[],
): void {
  for (const insertion of insertions) {
    if (
      !Number.isInteger(insertion.offset) ||
      insertion.offset < 0 ||
      insertion.offset > sourceText.length
    ) {
      throw new Error(
        `Invalid Markdown insertion offset for block ${insertion.blockId}: ${insertion.offset}`,
      );
    }
  }
}
