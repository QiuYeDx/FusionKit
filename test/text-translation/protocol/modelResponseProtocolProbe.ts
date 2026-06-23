import { z } from "zod";

const protocolIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const characterPatchSchema = z
  .object({
    sourceName: z.string().min(1).max(200),
    translatedName: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(20).optional(),
    description: z.string().max(2_000).optional(),
    relationships: z.array(z.string().min(1).max(500)).max(30).optional(),
    pronounOrGenderNotes: z.string().max(500).optional(),
  })
  .strict();

const terminologyPatchSchema = z
  .object({
    source: z.string().min(1).max(300),
    target: z.string().min(1).max(300),
    note: z.string().max(1_000).optional(),
  })
  .strict();

export const semanticMemoryPatchSchema = z
  .object({
    documentSummary: z.string().max(12_000).optional(),
    currentChapterSummary: z.string().max(8_000).optional(),
    currentSceneSummary: z.string().max(8_000).optional(),
    characterUpserts: z.array(characterPatchSchema).max(50).optional(),
    terminologyUpserts: z.array(terminologyPatchSchema).max(100).optional(),
    styleRulesToAdd: z.array(z.string().min(1).max(1_000)).max(30).optional(),
    unresolvedContextToAdd: z
      .array(z.string().min(1).max(1_000))
      .max(30)
      .optional(),
    unresolvedContextToResolve: z
      .array(z.string().min(1).max(1_000))
      .max(30)
      .optional(),
    recentContinuityNotesToAdd: z
      .array(z.string().min(1).max(1_000))
      .max(50)
      .optional(),
  })
  .strict();

export type SemanticMemoryPatch = z.infer<typeof semanticMemoryPatchSchema>;

export interface ResponseUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface TranslationResponseInput {
  text: string;
  finishReason?:
    | "stop"
    | "length"
    | "content-filter"
    | "tool-calls"
    | "error"
    | "other";
  usage?: ResponseUsage;
  expectedPlaceholders?: string[];
}

export interface ParsedPlainTranslationResponse {
  translatedText: string;
  warnings: string[];
  usage?: ResponseUsage;
}

export interface ParsedSequentialTranslationResponse
  extends ParsedPlainTranslationResponse {
  memoryPatch?: SemanticMemoryPatch;
  memoryUpdated: boolean;
  protocol: "boundary_v1";
}

export type TranslationProtocolErrorCode =
  | "response_empty"
  | "response_truncated"
  | "response_blocked"
  | "response_finish_error"
  | "sequential_boundary_invalid"
  | "structured_response_invalid"
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

export interface SequentialProtocolMarkers {
  translation: string;
  memoryPatch: string;
  end: string;
}

export function createSequentialProtocolMarkers(
  protocolId: string,
): SequentialProtocolMarkers {
  const id = protocolIdSchema.parse(protocolId);
  return {
    translation: `<<<FUSIONKIT_TRANSLATION:${id}>>>`,
    memoryPatch: `<<<FUSIONKIT_MEMORY_PATCH:${id}>>>`,
    end: `<<<FUSIONKIT_END:${id}>>>`,
  };
}

export function formatSequentialResponse(
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

export function parsePlainTranslationResponse(
  input: TranslationResponseInput,
): ParsedPlainTranslationResponse {
  const warnings = validateFinishReason(input.finishReason);
  const translatedText = normalizeModelText(input.text);
  assertNonEmpty(translatedText);
  assertPlaceholders(translatedText, input.expectedPlaceholders ?? []);

  return {
    translatedText,
    warnings,
    usage: input.usage,
  };
}

export function parseSequentialTranslationResponse(
  input: TranslationResponseInput,
  protocolId: string,
): ParsedSequentialTranslationResponse {
  const warnings = validateFinishReason(input.finishReason);
  const normalized = normalizeModelText(input.text);
  const markers = createSequentialProtocolMarkers(protocolId);
  const sections = splitSequentialSections(normalized, markers);
  const translatedText = sections.translatedText.trim();

  assertNonEmpty(translatedText);
  assertPlaceholders(translatedText, input.expectedPlaceholders ?? []);

  const patchResult = parseMemoryPatch(sections.memoryPatchText);
  if (!patchResult.success) {
    warnings.push(`memory_patch_invalid:${patchResult.reason}`);
  }

  return {
    translatedText,
    memoryPatch: patchResult.success ? patchResult.patch : undefined,
    memoryUpdated: patchResult.success,
    protocol: "boundary_v1",
    warnings,
    usage: input.usage,
  };
}

export function parseStructuredSequentialJson(
  input: TranslationResponseInput,
): {
  translatedText: string;
  memoryPatch: SemanticMemoryPatch;
} {
  validateFinishReason(input.finishReason);
  const normalized = normalizeModelText(input.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new TranslationProtocolError(
      "structured_response_invalid",
      "Structured response is not valid JSON",
      true,
    );
  }

  const result = z
    .object({
      translatedText: z.string().min(1),
      memoryPatch: semanticMemoryPatchSchema,
    })
    .strict()
    .safeParse(parsed);

  if (!result.success) {
    throw new TranslationProtocolError(
      "structured_response_invalid",
      "Structured response failed schema validation",
      true,
    );
  }

  assertPlaceholders(
    result.data.translatedText,
    input.expectedPlaceholders ?? [],
  );
  return result.data;
}

export function validatePlaceholders(
  translatedText: string,
  expectedPlaceholders: string[],
): string[] {
  const actual = translatedText.match(/⟦FKP:[^⟧\r\n]+⟧/g) ?? [];
  const expectedSet = new Set(expectedPlaceholders);
  const issues: string[] = [];

  for (const placeholder of expectedPlaceholders) {
    const count = actual.filter((value) => value === placeholder).length;
    if (count === 0) issues.push(`missing:${placeholder}`);
    if (count > 1) issues.push(`duplicate:${placeholder}`);
  }

  for (const placeholder of new Set(actual)) {
    if (!expectedSet.has(placeholder)) {
      issues.push(`unknown:${placeholder}`);
    }
  }

  const knownActual = actual.filter((placeholder) =>
    expectedSet.has(placeholder),
  );
  if (
    knownActual.length === expectedPlaceholders.length &&
    knownActual.some(
      (placeholder, index) => placeholder !== expectedPlaceholders[index],
    )
  ) {
    issues.push("out_of_order");
  }

  return issues;
}

export function buildPlaceholderRetryInstruction(
  expectedPlaceholders: string[],
): string {
  return [
    "Retry the translation and preserve every protected placeholder exactly once.",
    "Copy placeholders byte-for-byte and keep their original order.",
    `Expected placeholders: ${expectedPlaceholders.join(", ") || "(none)"}.`,
    "Return only the required response protocol; do not add explanations or code fences.",
  ].join("\n");
}

export function normalizeModelText(text: string): string {
  let normalized = text.replace(/^\uFEFF/, "").trim();

  while (/^<think>/i.test(normalized)) {
    const closingIndex = normalized.toLowerCase().indexOf("</think>");
    if (closingIndex < 0) break;
    normalized = normalized
      .slice(closingIndex + "</think>".length)
      .trim();
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

function validateFinishReason(
  finishReason: TranslationResponseInput["finishReason"],
): string[] {
  switch (finishReason) {
    case undefined:
    case "stop":
      return [];
    case "other":
      return ["finish_reason_other"];
    case "length":
      throw new TranslationProtocolError(
        "response_truncated",
        "Model response was truncated by its output-token limit",
        true,
      );
    case "content-filter":
      throw new TranslationProtocolError(
        "response_blocked",
        "Model response was blocked by a content filter",
        false,
      );
    case "tool-calls":
    case "error":
      throw new TranslationProtocolError(
        "response_finish_error",
        `Unexpected translation finish reason: ${finishReason}`,
        true,
      );
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
    "Sequential response markers are missing, duplicated, or out of order",
    true,
  );
}

function parseMemoryPatch(
  text: string,
):
  | { success: true; patch: SemanticMemoryPatch }
  | { success: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { success: false, reason: "invalid_json" };
  }

  const result = semanticMemoryPatchSchema.safeParse(parsed);
  if (!result.success) {
    return { success: false, reason: "schema_validation_failed" };
  }
  return { success: true, patch: result.data };
}

function assertNonEmpty(translatedText: string): void {
  if (!translatedText.trim()) {
    throw new TranslationProtocolError(
      "response_empty",
      "Translation response is empty",
      true,
    );
  }
}

function assertPlaceholders(
  translatedText: string,
  expectedPlaceholders: string[],
): void {
  const issues = validatePlaceholders(translatedText, expectedPlaceholders);
  if (issues.length === 0) return;

  throw new TranslationProtocolError(
    "placeholder_mismatch",
    `Protected placeholder validation failed: ${issues.join(", ")}`,
    true,
    buildPlaceholderRetryInstruction(expectedPlaceholders),
  );
}
