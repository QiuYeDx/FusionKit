import {
  parseSemanticMemoryPatch,
  type SemanticMemoryPatch,
  type SemanticMemoryWarning,
} from "../memory/memory-patch";

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

export type TranslationProtocolErrorCode =
  | "response_empty"
  | "response_truncated"
  | "response_blocked"
  | "response_finish_error"
  | "sequential_boundary_invalid";

export class TranslationProtocolError extends Error {
  constructor(
    readonly code: TranslationProtocolErrorCode,
    message: string,
    readonly retryable: boolean,
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
