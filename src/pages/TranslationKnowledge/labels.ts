import type { TFunction } from "i18next";
import type { LanguagePair } from "@/translation-knowledge/schemas";

const LANGUAGE_KEYS = {
  ja: "languages.ja",
  en: "languages.en",
  "zh-Hans": "languages.zh-Hans",
  "zh-Hant": "languages.zh-Hant",
  ko: "languages.ko",
  fr: "languages.fr",
  de: "languages.de",
  es: "languages.es",
  ru: "languages.ru",
  pt: "languages.pt",
} as const;

export function languageLabel(t: TFunction<"knowledge">, value: string) {
  const key = LANGUAGE_KEYS[value as keyof typeof LANGUAGE_KEYS];
  return key ? t(key) : value;
}

export function languagePairLabel(t: TFunction<"knowledge">, pair: LanguagePair) {
  return `${languageLabel(t, pair.source)} → ${languageLabel(t, pair.target)}`;
}

const DIAGNOSTIC_KEYS = {
  UNSUPPORTED_SCHEMA_VERSION: "diagnostic.UNSUPPORTED_SCHEMA_VERSION",
  SCHEMA_INVALID: "diagnostic.SCHEMA_INVALID",
  MISSING_REFERENCE: "diagnostic.MISSING_REFERENCE",
  DUPLICATE_ID: "diagnostic.DUPLICATE_ID",
  LANGUAGE_TAG: "diagnostic.LANGUAGE_TAG",
  KEEP_SOURCE_TARGET: "diagnostic.KEEP_SOURCE_TARGET",
  ALIAS_IS_SOURCE: "diagnostic.ALIAS_IS_SOURCE",
  PRESET_LANGUAGE_MISMATCH: "diagnostic.PRESET_LANGUAGE_MISMATCH",
  LIMIT_FILE_BYTES: "diagnostic.LIMIT_FILE_BYTES",
  DUPLICATE_TERM: "diagnostic.DUPLICATE_TERM",
  TERM_DISAGREEMENT: "diagnostic.TERM_DISAGREEMENT",
  EXPORT_PRIVATE_CONTENT: "diagnostic.EXPORT_PRIVATE_CONTENT",
  RESTORE_ID_EXISTS: "diagnostic.RESTORE_ID_EXISTS",
} as const;

/** A validation or import diagnostic in words; codes without their own text show the diagnostic's message. */
export function diagnosticText(t: TFunction<"knowledge">, diagnostic: { code: string; message: string }) {
  const key = DIAGNOSTIC_KEYS[diagnostic.code as keyof typeof DIAGNOSTIC_KEYS];
  return key ? t(key) : diagnostic.message;
}
