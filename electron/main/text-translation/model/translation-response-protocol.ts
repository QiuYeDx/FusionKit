import {
  parseSemanticMemoryPatch,
  type SemanticMemoryPatch,
  type SemanticMemoryWarning,
} from "../memory/memory-patch";
import {
  validateProtectedPlaceholders,
  type ProtectedPlaceholder,
} from "../parsing/protected-placeholders";

export interface SequentialProtocolMarkers {
  translation: string;
  memoryPatch: string;
  end: string;
}

export interface ParsedSequentialTranslationResponse {
  translatedText: string;
  memoryPatch?: SemanticMemoryPatch;
  memoryUpdated: boolean;
  warnings: SemanticMemoryWarning[];
}

export interface MarkdownProtocolMarkers {
  start: string;
  end: string;
  itemPrefix: string;
  item(id: string): string;
}

export interface MarkdownExpectedUnitTranslation {
  unitId: string;
  sourceText?: string;
  placeholders?: ProtectedPlaceholder[];
}

export interface MarkdownExpectedBlockTranslation {
  blockId: string;
  sourceText?: string;
  placeholders?: ProtectedPlaceholder[];
}

export interface MarkdownUnitTranslationProtocolResult {
  unitId: string;
  translatedText: string;
  placeholders?: ProtectedPlaceholder[];
}

export interface MarkdownBlockTranslationProtocolResult {
  blockId: string;
  translatedMarkdown: string;
  placeholders?: ProtectedPlaceholder[];
}

export interface ParsedMarkdownTargetOnlyTranslationResponse {
  protocol: "markdown_boundary_v1";
  results: MarkdownUnitTranslationProtocolResult[];
}

export interface ParsedMarkdownBilingualTranslationResponse {
  protocol: "markdown_boundary_v1";
  translations: MarkdownBlockTranslationProtocolResult[];
}

export interface ParsedSequentialMarkdownTargetOnlyTranslationResponse
  extends Omit<ParsedSequentialTranslationResponse, "translatedText"> {
  protocol: "sequential_markdown_boundary_v1";
  results: MarkdownUnitTranslationProtocolResult[];
}

export interface ParsedSequentialMarkdownBilingualTranslationResponse
  extends Omit<ParsedSequentialTranslationResponse, "translatedText"> {
  protocol: "sequential_markdown_boundary_v1";
  translations: MarkdownBlockTranslationProtocolResult[];
}

export type TranslationProtocolErrorCode =
  | "response_empty"
  | "response_truncated"
  | "response_blocked"
  | "response_finish_error"
  | "sequential_boundary_invalid"
  | "markdown_boundary_invalid"
  | "markdown_id_mismatch"
  | "placeholder_mismatch";

export class TranslationProtocolError extends Error {
  constructor(
    readonly code: TranslationProtocolErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryInstruction?: string,
  ) {
    super(message);
    this.name = "TranslationProtocolError";
  }
}

export function createSequentialProtocolMarkers(
  protocolId: string,
): SequentialProtocolMarkers {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(protocolId)) {
    throw new TranslationProtocolError(
      "sequential_boundary_invalid",
      "Sequential protocol id must contain only letters, numbers, underscores, or hyphens.",
      false,
    );
  }

  return {
    translation: `<<<FUSIONKIT_TRANSLATION:${protocolId}>>>`,
    memoryPatch: `<<<FUSIONKIT_MEMORY_PATCH:${protocolId}>>>`,
    end: `<<<FUSIONKIT_END:${protocolId}>>>`,
  };
}

export function formatSequentialTranslationResponse(
  protocolId: string,
  translatedText: string,
  memoryPatch: unknown,
): string {
  const markers = createSequentialProtocolMarkers(protocolId);
  return [
    markers.translation,
    translatedText,
    markers.memoryPatch,
    JSON.stringify(memoryPatch),
    markers.end,
  ].join("\n");
}

export function createMarkdownTargetOnlyProtocolMarkers(
  protocolId: string,
): MarkdownProtocolMarkers {
  const id = validateMarkdownProtocolId(protocolId);
  return {
    start: `<<<FUSIONKIT_MARKDOWN_TARGET_ONLY:${id}>>>`,
    end: `<<<FUSIONKIT_MARKDOWN_END:${id}>>>`,
    itemPrefix: `<<<FUSIONKIT_MD_UNIT:${id}:`,
    item: (unitId: string) =>
      `<<<FUSIONKIT_MD_UNIT:${id}:${validateMarkdownItemId(unitId)}>>>`,
  };
}

export function createMarkdownBilingualProtocolMarkers(
  protocolId: string,
): MarkdownProtocolMarkers {
  const id = validateMarkdownProtocolId(protocolId);
  return {
    start: `<<<FUSIONKIT_MARKDOWN_BILINGUAL:${id}>>>`,
    end: `<<<FUSIONKIT_MARKDOWN_END:${id}>>>`,
    itemPrefix: `<<<FUSIONKIT_MD_BLOCK:${id}:`,
    item: (blockId: string) =>
      `<<<FUSIONKIT_MD_BLOCK:${id}:${validateMarkdownItemId(blockId)}>>>`,
  };
}

export function formatMarkdownTargetOnlyTranslationResponse(
  protocolId: string,
  results: MarkdownUnitTranslationProtocolResult[],
): string {
  const markers = createMarkdownTargetOnlyProtocolMarkers(protocolId);
  return formatMarkdownItemResponse(
    markers,
    results.map((result) => ({
      id: result.unitId,
      text: result.translatedText,
    })),
  );
}

export function formatMarkdownBilingualTranslationResponse(
  protocolId: string,
  translations: MarkdownBlockTranslationProtocolResult[],
): string {
  const markers = createMarkdownBilingualProtocolMarkers(protocolId);
  return formatMarkdownItemResponse(
    markers,
    translations.map((translation) => ({
      id: translation.blockId,
      text: translation.translatedMarkdown,
    })),
  );
}

export function parseMarkdownTargetOnlyTranslationResponse(input: {
  text: string;
  finishReason?: string;
  protocolId: string;
  expectedUnits: MarkdownExpectedUnitTranslation[];
}): ParsedMarkdownTargetOnlyTranslationResponse {
  validateFinishReason(input.finishReason);
  const markers = createMarkdownTargetOnlyProtocolMarkers(input.protocolId);
  const sectionById = parseMarkdownItemSections({
    text: normalizeModelText(input.text),
    markers,
    expectedIds: input.expectedUnits.map((unit) => unit.unitId),
  });

  return {
    protocol: "markdown_boundary_v1",
    results: input.expectedUnits.map((unit) => {
      const translatedText = readValidatedMarkdownItemText({
        id: unit.unitId,
        text: sectionById.get(unit.unitId) ?? "",
        placeholders: unit.placeholders ?? [],
      });
      return {
        unitId: unit.unitId,
        translatedText,
        ...(unit.placeholders?.length ? { placeholders: unit.placeholders } : {}),
      };
    }),
  };
}

export function parseMarkdownBilingualTranslationResponse(input: {
  text: string;
  finishReason?: string;
  protocolId: string;
  expectedBlocks: MarkdownExpectedBlockTranslation[];
}): ParsedMarkdownBilingualTranslationResponse {
  validateFinishReason(input.finishReason);
  const markers = createMarkdownBilingualProtocolMarkers(input.protocolId);
  const sectionById = parseMarkdownItemSections({
    text: normalizeModelText(input.text),
    markers,
    expectedIds: input.expectedBlocks.map((block) => block.blockId),
  });

  return {
    protocol: "markdown_boundary_v1",
    translations: input.expectedBlocks.map((block) => {
      const translatedMarkdown = readValidatedMarkdownItemText({
        id: block.blockId,
        text: sectionById.get(block.blockId) ?? "",
        placeholders: block.placeholders ?? [],
      });
      return {
        blockId: block.blockId,
        translatedMarkdown,
        ...(block.placeholders?.length
          ? { placeholders: block.placeholders }
          : {}),
      };
    }),
  };
}

export function parseSequentialMarkdownTargetOnlyTranslationResponse(input: {
  text: string;
  finishReason?: string;
  sequentialProtocolId: string;
  markdownProtocolId?: string;
  expectedUnits: MarkdownExpectedUnitTranslation[];
}): ParsedSequentialMarkdownTargetOnlyTranslationResponse {
  const sequential = parseSequentialTranslationResponse({
    text: input.text,
    finishReason: input.finishReason,
    protocolId: input.sequentialProtocolId,
  });
  const markdown = parseMarkdownTargetOnlyTranslationResponse({
    text: sequential.translatedText,
    protocolId: input.markdownProtocolId ?? input.sequentialProtocolId,
    expectedUnits: input.expectedUnits,
  });

  return {
    protocol: "sequential_markdown_boundary_v1",
    results: markdown.results,
    memoryPatch: sequential.memoryPatch,
    memoryUpdated: sequential.memoryUpdated,
    warnings: sequential.warnings,
  };
}

export function parseSequentialMarkdownBilingualTranslationResponse(input: {
  text: string;
  finishReason?: string;
  sequentialProtocolId: string;
  markdownProtocolId?: string;
  expectedBlocks: MarkdownExpectedBlockTranslation[];
}): ParsedSequentialMarkdownBilingualTranslationResponse {
  const sequential = parseSequentialTranslationResponse({
    text: input.text,
    finishReason: input.finishReason,
    protocolId: input.sequentialProtocolId,
  });
  const markdown = parseMarkdownBilingualTranslationResponse({
    text: sequential.translatedText,
    protocolId: input.markdownProtocolId ?? input.sequentialProtocolId,
    expectedBlocks: input.expectedBlocks,
  });

  return {
    protocol: "sequential_markdown_boundary_v1",
    translations: markdown.translations,
    memoryPatch: sequential.memoryPatch,
    memoryUpdated: sequential.memoryUpdated,
    warnings: sequential.warnings,
  };
}

export function buildMarkdownTargetOnlyTranslationPrompt(input: {
  sourceLang: string;
  targetLang: string;
  protocolId: string;
  units: MarkdownExpectedUnitTranslation[];
  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossaryText?: string;
}): string {
  const markers = createMarkdownTargetOnlyProtocolMarkers(input.protocolId);
  return buildMarkdownTranslationPrompt({
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    outputDescription: "Markdown target-only unit translations",
    markers,
    items: input.units.map((unit) => ({
      id: unit.unitId,
      sourceText: unit.sourceText,
      placeholders: unit.placeholders,
      bodyHint: "<translated text for this unit>",
    })),
    documentBackground: input.documentBackground,
    translationInstructions: input.translationInstructions,
    styleInstructions: input.styleInstructions,
    glossaryText: input.glossaryText,
  });
}

export function buildMarkdownBilingualTranslationPrompt(input: {
  sourceLang: string;
  targetLang: string;
  protocolId: string;
  blocks: MarkdownExpectedBlockTranslation[];
  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossaryText?: string;
}): string {
  const markers = createMarkdownBilingualProtocolMarkers(input.protocolId);
  return buildMarkdownTranslationPrompt({
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    outputDescription: "Markdown bilingual block translations",
    markers,
    items: input.blocks.map((block) => ({
      id: block.blockId,
      sourceText: block.sourceText,
      placeholders: block.placeholders,
      bodyHint: "<translated Markdown fragment for this block>",
    })),
    documentBackground: input.documentBackground,
    translationInstructions: input.translationInstructions,
    styleInstructions: input.styleInstructions,
    glossaryText: input.glossaryText,
  });
}

export function parseSequentialTranslationResponse(input: {
  text: string;
  finishReason?: string;
  protocolId: string;
}): ParsedSequentialTranslationResponse {
  validateFinishReason(input.finishReason);
  const markers = createSequentialProtocolMarkers(input.protocolId);
  const sections = splitSequentialSections(normalizeModelText(input.text), markers);
  const translatedText = sections.translatedText.trim();
  if (!translatedText) {
    throw new TranslationProtocolError(
      "response_empty",
      "Sequential translation response is empty.",
      true,
    );
  }

  const patch = parseSemanticMemoryPatch(sections.memoryPatchText);
  return {
    translatedText,
    memoryPatch: patch.success ? patch.patch : undefined,
    memoryUpdated: patch.success,
    warnings: patch.warning ? [patch.warning] : [],
  };
}

export function buildSequentialTranslationPrompt(input: {
  sourceLang: string;
  targetLang: string;
  protocolId: string;
  memoryJson: string;
  sourceText: string;
  recentSourceText?: string;
  recentTranslatedText?: string;
  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossaryText?: string;
}): string {
  const markers = createSequentialProtocolMarkers(input.protocolId);
  return [
    `Source language: ${input.sourceLang}`,
    `Target language: ${input.targetLang}`,
    "",
    "Return exactly this protocol and no extra explanation:",
    markers.translation,
    "<translated text>",
    markers.memoryPatch,
    "{\"currentSceneSummary\":\"...\"}",
    markers.end,
    "",
    "Memory patch must be strict JSON using only the allowed SemanticMemoryPatch fields.",
    "If nothing changed in memory, return {} for the memory patch.",
    "",
    input.documentBackground
      ? `Document background:\n${input.documentBackground}`
      : undefined,
    input.translationInstructions
      ? `Translation instructions:\n${input.translationInstructions}`
      : undefined,
    input.styleInstructions
      ? `Style instructions:\n${input.styleInstructions}`
      : undefined,
    input.glossaryText ? `User glossary:\n${input.glossaryText}` : undefined,
    `Current semantic memory:\n${input.memoryJson}`,
    input.recentSourceText
      ? `Recent source tail:\n${input.recentSourceText}`
      : undefined,
    input.recentTranslatedText
      ? `Recent translation tail:\n${input.recentTranslatedText}`
      : undefined,
    `Current segment:\n${input.sourceText}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function normalizeModelText(text: string): string {
  let normalized = text.replace(/^\uFEFF/, "").trim();

  while (/^<think>/i.test(normalized)) {
    const closingIndex = normalized.toLowerCase().indexOf("</think>");
    if (closingIndex < 0) break;
    normalized = normalized.slice(closingIndex + "</think>".length).trim();
  }

  const orphanClosingIndex = normalized.toLowerCase().indexOf("</think>");
  if (
    orphanClosingIndex >= 0 &&
    orphanClosingIndex < 4_096 &&
    !normalized.slice(0, orphanClosingIndex).includes("<<<FUSIONKIT_")
  ) {
    normalized = normalized
      .slice(orphanClosingIndex + "</think>".length)
      .trim();
  }

  return normalized;
}

export function buildProtectedPlaceholderRetryInstruction(
  placeholders: ProtectedPlaceholder[],
): string {
  const tokens = placeholders.map((placeholder) => placeholder.token);
  return [
    "Retry the translation and preserve every protected Markdown placeholder exactly once.",
    "Copy placeholder tokens byte-for-byte and keep their original order inside each item.",
    `Expected placeholders: ${tokens.join(", ") || "(none)"}.`,
    "Return only the required FusionKit Markdown protocol; do not add explanations or code fences.",
  ].join("\n");
}

function validateFinishReason(finishReason: string | undefined): void {
  switch (finishReason) {
    case undefined:
    case "stop":
      return;
    case "length":
      throw new TranslationProtocolError(
        "response_truncated",
        "Model response was truncated by its output-token limit.",
        true,
      );
    case "content-filter":
      throw new TranslationProtocolError(
        "response_blocked",
        "Model response was blocked by a content filter.",
        false,
      );
    case "tool-calls":
    case "error":
      throw new TranslationProtocolError(
        "response_finish_error",
        `Unexpected translation finish reason: ${finishReason}.`,
        true,
      );
    default:
      return;
  }
}

function splitSequentialSections(
  text: string,
  markers: SequentialProtocolMarkers,
): {
  translatedText: string;
  memoryPatchText: string;
} {
  const translationIndex = uniqueMarkerIndex(text, markers.translation);
  const memoryPatchIndex = uniqueMarkerIndex(text, markers.memoryPatch);
  const endIndex = uniqueMarkerIndex(text, markers.end);

  const prefix = text.slice(0, translationIndex).trim();
  const suffix = text.slice(endIndex + markers.end.length).trim();
  if (
    prefix ||
    suffix ||
    translationIndex >= memoryPatchIndex ||
    memoryPatchIndex >= endIndex
  ) {
    throw invalidBoundaryError();
  }

  return {
    translatedText: text.slice(
      translationIndex + markers.translation.length,
      memoryPatchIndex,
    ),
    memoryPatchText: text.slice(
      memoryPatchIndex + markers.memoryPatch.length,
      endIndex,
    ),
  };
}

function uniqueMarkerIndex(text: string, marker: string): number {
  const first = text.indexOf(marker);
  if (first < 0 || first !== text.lastIndexOf(marker)) {
    throw invalidBoundaryError();
  }
  return first;
}

function invalidBoundaryError(): TranslationProtocolError {
  return new TranslationProtocolError(
    "sequential_boundary_invalid",
    "Sequential response markers are missing, duplicated, or out of order.",
    true,
  );
}

function formatMarkdownItemResponse(
  markers: MarkdownProtocolMarkers,
  items: { id: string; text: string }[],
): string {
  return [
    markers.start,
    ...items.flatMap((item) => [markers.item(item.id), item.text]),
    markers.end,
  ].join("\n");
}

function buildMarkdownTranslationPrompt(input: {
  sourceLang: string;
  targetLang: string;
  outputDescription: string;
  markers: MarkdownProtocolMarkers;
  items: {
    id: string;
    sourceText?: string;
    placeholders?: ProtectedPlaceholder[];
    bodyHint: string;
  }[];
  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossaryText?: string;
}): string {
  return [
    `Source language: ${input.sourceLang}`,
    `Target language: ${input.targetLang}`,
    `Output: ${input.outputDescription}`,
    "",
    "Return exactly this protocol and no extra explanation:",
    input.markers.start,
    ...input.items.flatMap((item) => [
      input.markers.item(item.id),
      item.bodyHint,
    ]),
    input.markers.end,
    "",
    "Every expected id must appear exactly once and in the listed order.",
    "Do not wrap the protocol in Markdown code fences.",
    "Preserve protected placeholders exactly once, byte-for-byte, and in order within each item.",
    "If a source item contains protected placeholders, keep those placeholder tokens in the translated item instead of translating or deleting them.",
    "",
    input.documentBackground
      ? `Document background:\n${input.documentBackground}`
      : undefined,
    input.translationInstructions
      ? `Translation instructions:\n${input.translationInstructions}`
      : undefined,
    input.styleInstructions
      ? `Style instructions:\n${input.styleInstructions}`
      : undefined,
    input.glossaryText ? `User glossary:\n${input.glossaryText}` : undefined,
    "Source items:",
    ...input.items.map((item) =>
      [
        input.markers.item(item.id),
        item.sourceText ?? "",
        `Expected placeholders: ${
          item.placeholders?.map((placeholder) => placeholder.token).join(", ") ??
          "(none)"
        }`,
      ].join("\n"),
    ),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function parseMarkdownItemSections(input: {
  text: string;
  markers: MarkdownProtocolMarkers;
  expectedIds: string[];
}): Map<string, string> {
  const envelope = splitMarkdownEnvelope(input.text, input.markers);
  const markerPattern = new RegExp(
    `^${escapeRegExp(input.markers.itemPrefix)}([A-Za-z0-9_-]{1,180})>>>[ \\t]*$`,
    "gm",
  );
  const markerMatches = [...envelope.matchAll(markerPattern)];
  const genericMarkerPattern = new RegExp(
    `<<<FUSIONKIT_MD_(?:UNIT|BLOCK):`,
    "g",
  );
  const genericMarkerCount = [...envelope.matchAll(genericMarkerPattern)].length;

  if (genericMarkerCount !== markerMatches.length) {
    throw markdownBoundaryInvalidError();
  }

  if (markerMatches.length === 0) {
    assertMarkdownIds([], input.expectedIds);
    return new Map();
  }

  const prefix = envelope.slice(0, markerMatches[0].index).trim();
  if (prefix) throw markdownBoundaryInvalidError();

  const actualIds = markerMatches.map((match) => match[1]);
  assertMarkdownIds(actualIds, input.expectedIds);

  const sectionById = new Map<string, string>();
  for (let index = 0; index < markerMatches.length; index += 1) {
    const match = markerMatches[index];
    const id = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < markerMatches.length
        ? markerMatches[index + 1].index ?? envelope.length
        : envelope.length;
    sectionById.set(id, envelope.slice(start, end));
  }

  return sectionById;
}

function splitMarkdownEnvelope(
  text: string,
  markers: MarkdownProtocolMarkers,
): string {
  const startIndex = uniqueMarkdownMarkerIndex(text, markers.start);
  const endIndex = uniqueMarkdownMarkerIndex(text, markers.end);
  const prefix = text.slice(0, startIndex).trim();
  const suffix = text.slice(endIndex + markers.end.length).trim();
  if (prefix || suffix || startIndex >= endIndex) {
    throw markdownBoundaryInvalidError();
  }
  return text.slice(startIndex + markers.start.length, endIndex);
}

function uniqueMarkdownMarkerIndex(text: string, marker: string): number {
  const first = text.indexOf(marker);
  if (first < 0 || first !== text.lastIndexOf(marker)) {
    throw markdownBoundaryInvalidError();
  }
  return first;
}

function assertMarkdownIds(actualIds: string[], expectedIds: string[]): void {
  const issues: string[] = [];
  const actualCounts = countValues(actualIds);
  const expectedSet = new Set(expectedIds);

  for (const expectedId of expectedIds) {
    if (!actualCounts.has(expectedId)) issues.push(`missing:${expectedId}`);
  }
  for (const [actualId, count] of actualCounts) {
    if (count > 1) issues.push(`duplicate:${actualId}`);
    if (!expectedSet.has(actualId)) issues.push(`unknown:${actualId}`);
  }
  if (
    issues.length === 0 &&
    actualIds.some((actualId, index) => actualId !== expectedIds[index])
  ) {
    issues.push("out_of_order");
  }

  if (issues.length === 0) return;

  throw new TranslationProtocolError(
    "markdown_id_mismatch",
    `Markdown response item ids failed validation: ${issues.join(", ")}.`,
    true,
  );
}

function readValidatedMarkdownItemText(input: {
  id: string;
  text: string;
  placeholders: ProtectedPlaceholder[];
}): string {
  const translatedText = stripMarkdownProtocolLineBreaks(input.text);
  if (!translatedText.trim()) {
    throw new TranslationProtocolError(
      "response_empty",
      `Markdown translation item is empty: ${input.id}.`,
      true,
    );
  }

  const validation = validateProtectedPlaceholders(
    translatedText,
    input.placeholders,
  );
  if (!validation.ok) {
    throw new TranslationProtocolError(
      "placeholder_mismatch",
      `Protected placeholder validation failed for ${input.id}: ${validation.errors.join(" ")}`,
      true,
      buildProtectedPlaceholderRetryInstruction(input.placeholders),
    );
  }

  return translatedText;
}

function stripMarkdownProtocolLineBreaks(text: string): string {
  let normalized = text;
  if (normalized.startsWith("\r\n")) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("\r\n")) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function validateMarkdownProtocolId(protocolId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(protocolId)) {
    throw new TranslationProtocolError(
      "markdown_boundary_invalid",
      "Markdown protocol id must contain only letters, numbers, underscores, or hyphens.",
      false,
    );
  }
  return protocolId;
}

function validateMarkdownItemId(itemId: string): string {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(itemId)) {
    throw new TranslationProtocolError(
      "markdown_boundary_invalid",
      "Markdown item id must contain only letters, numbers, underscores, or hyphens.",
      false,
    );
  }
  return itemId;
}

function markdownBoundaryInvalidError(): TranslationProtocolError {
  return new TranslationProtocolError(
    "markdown_boundary_invalid",
    "Markdown response markers are missing, duplicated, wrapped, or out of order.",
    true,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
