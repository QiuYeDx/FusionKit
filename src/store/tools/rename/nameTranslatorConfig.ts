import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  normalizeNameTranslationOptions,
  type NameTranslationOptions,
} from "@/services/rename/nameTypes";

export const NAME_TRANSLATOR_STORE_VERSION = 1;
export const NAME_TRANSLATOR_STORAGE_KEY = "fusionkit-name-translator";

const SCOPES = ["self", "children", "descendants"] as const;
const TARGET_KINDS = ["files", "directories", "both"] as const;
const SOURCE_LANGUAGES = [
  "auto",
  "ZH",
  "JA",
  "EN",
  "KO",
  "FR",
  "DE",
  "ES",
  "RU",
  "PT",
] as const;
const TARGET_LANGUAGES = [
  "ZH",
  "JA",
  "EN",
  "KO",
  "FR",
  "DE",
  "ES",
  "RU",
  "PT",
] as const;
const NAMING_STYLES = [
  "preserve",
  "space",
  "kebab",
  "snake",
  "title",
  "lower",
] as const;
const OUTPUT_MODES = [
  "target_only",
  "bilingual_target_first",
  "bilingual_original_first",
] as const;
const COLLISION_POLICIES = ["fail", "append_index"] as const;

export function sanitizeNameTranslatorPreferences(
  value: unknown,
): NameTranslationOptions {
  const saved = isRecord(value) ? value : {};
  return normalizeNameTranslationOptions({
    roots: [],
    scope: oneOf(
      saved.scope,
      SCOPES,
      "self",
    ),
    targetKind: oneOf(
      saved.targetKind,
      TARGET_KINDS,
      DEFAULT_NAME_TRANSLATION_OPTIONS.targetKind,
    ),
    recursive: booleanOr(
      saved.recursive,
      DEFAULT_NAME_TRANSLATION_OPTIONS.recursive,
    ),
    maxDepth: boundedIntegerOr(
      saved.maxDepth,
      0,
      20,
      DEFAULT_NAME_TRANSLATION_OPTIONS.maxDepth,
    ),
    includeHidden: booleanOr(
      saved.includeHidden,
      DEFAULT_NAME_TRANSLATION_OPTIONS.includeHidden,
    ),
    includeRoot: booleanOr(
      saved.includeRoot,
      DEFAULT_NAME_TRANSLATION_OPTIONS.includeRoot,
    ),
    sourceLang: oneOf(
      saved.sourceLang,
      SOURCE_LANGUAGES,
      DEFAULT_NAME_TRANSLATION_OPTIONS.sourceLang,
    ),
    targetLang: oneOf(
      saved.targetLang,
      TARGET_LANGUAGES,
      DEFAULT_NAME_TRANSLATION_OPTIONS.targetLang,
    ),
    namingStyle: oneOf(
      saved.namingStyle,
      NAMING_STYLES,
      DEFAULT_NAME_TRANSLATION_OPTIONS.namingStyle,
    ),
    outputMode: oneOf(
      saved.outputMode,
      OUTPUT_MODES,
      DEFAULT_NAME_TRANSLATION_OPTIONS.outputMode,
    ),
    bilingualSeparator:
      typeof saved.bilingualSeparator === "string"
        ? saved.bilingualSeparator.slice(0, 64)
        : DEFAULT_NAME_TRANSLATION_OPTIONS.bilingualSeparator,
    preserveExtension: booleanOr(
      saved.preserveExtension,
      DEFAULT_NAME_TRANSLATION_OPTIONS.preserveExtension,
    ),
    preserveLeadingDot: booleanOr(
      saved.preserveLeadingDot,
      DEFAULT_NAME_TRANSLATION_OPTIONS.preserveLeadingDot,
    ),
    preserveTechnicalTokens: booleanOr(
      saved.preserveTechnicalTokens,
      DEFAULT_NAME_TRANSLATION_OPTIONS.preserveTechnicalTokens,
    ),
    collisionPolicy: oneOf(
      saved.collisionPolicy,
      COLLISION_POLICIES,
      DEFAULT_NAME_TRANSLATION_OPTIONS.collisionPolicy,
    ),
  });
}

function oneOf<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  fallback: TValues[number],
): TValues[number] {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? (value as TValues[number])
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedIntegerOr(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
    ? (value as number)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
