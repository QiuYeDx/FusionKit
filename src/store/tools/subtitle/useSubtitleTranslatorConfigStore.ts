import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleSliceType,
  SUPPORTED_LANGUAGES,
  type TranslationLanguage,
  type TranslationOutputMode,
} from "@/type/subtitle";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const SUBTITLE_TRANSLATOR_CONFIG_STORE_VERSION = 1;
export const SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY =
  "fusionkit-subtitle-translator-config";

const LEGACY_TRANSLATOR_STORAGE_KEY = "fusionkit-subtitle-translator";
const LEGACY_OUTPUT_URL_STORAGE_KEY = "subtitle-translator-output-url";
const LEGACY_KEYS = Object.freeze({
  outputMode: "subtitle-translator-output-mode",
  conflictPolicy: "subtitle-translator-conflict-policy",
  concurrentSlices: "subtitle-translator-concurrent-slices",
  sourceLang: "subtitle-translator-source-lang",
  targetLang: "subtitle-translator-target-lang",
  translationOutputMode: "subtitle-translator-translation-output-mode",
});

export interface SubtitleTranslatorConfigPreferences {
  readonly sourceLang: TranslationLanguage;
  readonly targetLang: TranslationLanguage;
  readonly translationOutputMode: TranslationOutputMode;
  readonly sliceType: SubtitleSliceType;
  readonly customSliceLength: number;
  readonly outputMode: OutputPathMode;
  readonly outputDirectoryDisplayLabel: string | null;
  readonly conflictPolicy: OutputConflictPolicy;
  readonly concurrentSlices: boolean;
  readonly thinkingEnabled: boolean;
}

export interface SubtitleTranslatorConfigStore {
  readonly preferences: SubtitleTranslatorConfigPreferences;
  readonly migrationStatus: "ready" | "failed";
  updatePreferences(
    patch: Partial<SubtitleTranslatorConfigPreferences>,
  ): void;
}

export interface SubtitleTranslatorConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES = Object.freeze({
  sourceLang: "JA",
  targetLang: "ZH",
  translationOutputMode: "bilingual",
  sliceType: SubtitleSliceType.NORMAL,
  customSliceLength: DEFAULT_SLICE_LENGTH_MAP[SubtitleSliceType.CUSTOM],
  outputMode: "custom",
  outputDirectoryDisplayLabel: null,
  conflictPolicy: "index",
  concurrentSlices: true,
  thinkingEnabled: false,
} satisfies SubtitleTranslatorConfigPreferences);

export function sanitizeSubtitleTranslatorConfigPreferences(
  value: unknown,
): SubtitleTranslatorConfigPreferences {
  const record = isRecord(value) ? value : {};
  const sourceLang = translationLanguageOr(
    record.sourceLang,
    DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.sourceLang,
  );
  let targetLang = translationLanguageOr(
    record.targetLang,
    DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.targetLang,
  );
  if (targetLang === sourceLang) {
    targetLang = SUPPORTED_LANGUAGES.find(
      (language) => language.code !== sourceLang,
    )?.code ?? DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.targetLang;
  }
  const outputMode = oneOf(
    record.outputMode,
    ["custom", "source"] as const,
    DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.outputMode,
  );
  return Object.freeze({
    sourceLang,
    targetLang,
    translationOutputMode: oneOf(
      record.translationOutputMode,
      ["bilingual", "target_only"] as const,
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.translationOutputMode,
    ),
    sliceType: oneOf(
      record.sliceType,
      Object.values(SubtitleSliceType),
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.sliceType,
    ),
    customSliceLength: boundedIntegerOr(
      record.customSliceLength,
      1,
      100_000,
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.customSliceLength,
    ),
    outputMode,
    outputDirectoryDisplayLabel:
      outputMode === "custom"
        ? sanitizeDirectoryDisplayLabel(record.outputDirectoryDisplayLabel)
        : null,
    conflictPolicy: oneOf(
      record.conflictPolicy,
      ["index", "overwrite"] as const,
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.conflictPolicy,
    ),
    concurrentSlices:
      typeof record.concurrentSlices === "boolean"
        ? record.concurrentSlices
        : DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.concurrentSlices,
    thinkingEnabled:
      typeof record.thinkingEnabled === "boolean"
        ? record.thinkingEnabled
        : DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.thinkingEnabled,
  });
}

export function subtitleTranslatorDirectoryDisplayLabel(
  pathOrLabel: unknown,
): string | null {
  if (typeof pathOrLabel !== "string") return null;
  const components = pathOrLabel.split(/[\\/]/u).filter(Boolean);
  return sanitizeDirectoryDisplayLabel(components.at(-1));
}

export function bootstrapLegacySubtitleTranslatorConfig(
  storage: SubtitleTranslatorConfigStorage,
): "migrated" | "already_complete" | "failed" {
  try {
    if (hasReadableTargetConfig(storage)) {
      return cleanupLegacyTranslatorPath(storage)
        ? "already_complete"
        : "failed";
    }
    const legacyState = parseLegacyTranslatorState(
      storage.getItem(LEGACY_TRANSLATOR_STORAGE_KEY),
    );
    const preferences = sanitizeSubtitleTranslatorConfigPreferences({
      sourceLang: storage.getItem(LEGACY_KEYS.sourceLang),
      targetLang: storage.getItem(LEGACY_KEYS.targetLang),
      translationOutputMode: storage.getItem(
        LEGACY_KEYS.translationOutputMode,
      ),
      sliceType: legacyState.sliceType,
      customSliceLength: legacyState.customSliceLength,
      outputMode: storage.getItem(LEGACY_KEYS.outputMode),
      outputDirectoryDisplayLabel: subtitleTranslatorDirectoryDisplayLabel(
        legacyState.outputURL,
      ),
      conflictPolicy: storage.getItem(LEGACY_KEYS.conflictPolicy),
      concurrentSlices: parseLegacyBoolean(
        storage.getItem(LEGACY_KEYS.concurrentSlices),
      ),
    });
    const serialized = JSON.stringify({
      state: { preferences },
      version: SUBTITLE_TRANSLATOR_CONFIG_STORE_VERSION,
    });
    storage.setItem(SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY, serialized);
    if (storage.getItem(SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY) !== serialized) {
      return "failed";
    }
    return cleanupLegacyTranslatorPath(storage) ? "migrated" : "failed";
  } catch {
    return "failed";
  }
}

function hasReadableTargetConfig(storage: SubtitleTranslatorConfigStorage): boolean {
  try {
    const raw = storage.getItem(SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return isRecord(parsed) && isRecord(parsed.state) &&
      isRecord(parsed.state.preferences);
  } catch {
    return false;
  }
}

function cleanupLegacyTranslatorPath(
  storage: SubtitleTranslatorConfigStorage,
): boolean {
  const raw = storage.getItem(LEGACY_TRANSLATOR_STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.state)) return false;
      const { outputURL: _outputURL, ...safeState } = parsed.state;
      const safeValue = JSON.stringify({ ...parsed, state: safeState });
      storage.setItem(LEGACY_TRANSLATOR_STORAGE_KEY, safeValue);
      const readback: unknown = JSON.parse(
        storage.getItem(LEGACY_TRANSLATOR_STORAGE_KEY) ?? "null",
      );
      if (
        !isRecord(readback) ||
        !isRecord(readback.state) ||
        Object.prototype.hasOwnProperty.call(readback.state, "outputURL")
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (storage.getItem(LEGACY_OUTPUT_URL_STORAGE_KEY) !== null) {
    if (!storage.removeItem) return false;
    storage.removeItem(LEGACY_OUTPUT_URL_STORAGE_KEY);
    if (storage.getItem(LEGACY_OUTPUT_URL_STORAGE_KEY) !== null) return false;
  }
  return true;
}

const legacyBootstrapResult = (() => {
  try {
    return globalThis.localStorage
      ? bootstrapLegacySubtitleTranslatorConfig(globalThis.localStorage)
      : "failed";
  } catch {
    return "failed";
  }
})();

const useSubtitleTranslatorConfigStore =
  create<SubtitleTranslatorConfigStore>()(
    persist(
      (set, get) => ({
        preferences: sanitizeSubtitleTranslatorConfigPreferences(
          DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
        ),
        migrationStatus:
          legacyBootstrapResult === "failed" ? "failed" : "ready",
        updatePreferences: (patch) =>
          set({
            preferences: sanitizeSubtitleTranslatorConfigPreferences({
              ...get().preferences,
              ...patch,
            }),
          }),
      }),
      {
        name: SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY,
        storage: createJSONStorage(() => localStorage),
        version: SUBTITLE_TRANSLATOR_CONFIG_STORE_VERSION,
        partialize: (state) => ({
          preferences: sanitizeSubtitleTranslatorConfigPreferences(
            state.preferences,
          ),
        }),
        migrate: (persisted) => {
          const saved = isRecord(persisted) ? persisted : {};
          return {
            preferences: sanitizeSubtitleTranslatorConfigPreferences(
              saved.preferences,
            ),
          };
        },
        merge: (persisted, current) => {
          const saved = isRecord(persisted) ? persisted : {};
          return {
            ...current,
            preferences: sanitizeSubtitleTranslatorConfigPreferences(
              saved.preferences,
            ),
          };
        },
      },
    ),
  );

function parseLegacyTranslatorState(value: string | null): {
  readonly outputURL?: unknown;
  readonly sliceType?: unknown;
  readonly customSliceLength?: unknown;
} {
  try {
    const parsed: unknown = value ? JSON.parse(value) : undefined;
    if (!isRecord(parsed) || !isRecord(parsed.state)) return {};
    const state = parsed.state;
    const sliceLengthMap = isRecord(state.sliceLengthMap)
      ? state.sliceLengthMap
      : {};
    return {
      outputURL: state.outputURL,
      sliceType: state.sliceType,
      customSliceLength: sliceLengthMap[SubtitleSliceType.CUSTOM],
    };
  } catch {
    return {};
  }
}

function parseLegacyBoolean(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

function sanitizeDirectoryDisplayLabel(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function translationLanguageOr(
  value: unknown,
  fallback: TranslationLanguage,
): TranslationLanguage {
  return SUPPORTED_LANGUAGES.some((language) => language.code === value)
    ? value as TranslationLanguage
    : fallback;
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
    ? value as number
    : fallback;
}

function oneOf<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  fallback: TValues[number],
): TValues[number] {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? value as TValues[number]
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useSubtitleTranslatorConfigStore;
