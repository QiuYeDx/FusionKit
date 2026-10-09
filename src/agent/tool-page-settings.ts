import useSubtitleTranslatorConfigStore from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import useNameTranslatorConfigStore, { type NameTranslatorConfig } from "@/store/tools/rename/nameTranslatorConfig";
import { isSubtitleConvertFormat, type SubtitleConvertFormat } from "@/type/subtitle";

/** Where a setting the agent applied came from. */
export type SettingSource = "user" | "tool_page" | "default";
export type AppliedSettings = Record<string, { value: unknown; source: SettingSource }>;

export const TRANSLATION_LANGUAGES = ["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"] as const;
export type AgentTranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

/**
 * Resolves settings in order: what the request specified, the tool page's
 * current setting, then the built-in default, and remembers each choice for
 * the tool receipt so the agent can say what it used.
 */
export class SettingsResolver {
  readonly applied: AppliedSettings = {};
  pick<T>(name: string, requested: T | undefined, page: T | undefined, fallback: T): T {
    if (requested !== undefined) return this.note(name, requested, "user");
    if (page !== undefined) return this.note(name, page, "tool_page");
    return this.note(name, fallback, "default");
  }
  note<T>(name: string, value: T, source: SettingSource): T {
    this.applied[name] = { value, source };
    return value;
  }
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : undefined;
const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const conflict = (value: unknown) => oneOf(["index", "overwrite"] as const, value);
/** Store reads must never break a tool: a missing or broken store means no page settings. */
function safely<T extends object>(read: () => T): Partial<T> {
  try { return read(); } catch { return {}; }
}

export function translatorPageSettings() {
  return safely(() => {
    const preferences = useSubtitleTranslatorConfigStore.getState().preferences;
    const length = preferences.customSliceLength;
    return {
      sourceLang: oneOf(TRANSLATION_LANGUAGES, preferences.sourceLang),
      targetLang: oneOf(TRANSLATION_LANGUAGES, preferences.targetLang),
      translationOutputMode: oneOf(["bilingual", "target_only"] as const, preferences.translationOutputMode),
      sliceType: oneOf(["NORMAL", "SENSITIVE", "CUSTOM"] as const, preferences.sliceType),
      customSliceLength: typeof length === "number" && Number.isInteger(length) && length >= 100 && length <= 2000 ? length : undefined,
      outputMode: oneOf(["source", "custom"] as const, preferences.outputMode),
      conflictPolicy: conflict(preferences.conflictPolicy),
      concurrentSlices: bool(preferences.concurrentSlices),
      thinkingEnabled: bool(preferences.thinkingEnabled),
    };
  });
}

/** A custom output directory the user chose on the converter or extractor page. */
function legacyOutput(outputMode: unknown, outputURL: unknown) {
  return oneOf(["source", "custom"] as const, outputMode) === "custom" && typeof outputURL === "string" && outputURL.trim()
    ? { outputMode: "custom" as const, outputDir: outputURL.trim() } : { outputMode: oneOf(["source", "custom"] as const, outputMode) };
}

export function converterPageSettings() {
  return safely(() => {
    const state = useSubtitleConverterStore.getState();
    return {
      to: isSubtitleConvertFormat(state.toFormat) ? state.toFormat as SubtitleConvertFormat : undefined,
      conflictPolicy: conflict(state.conflictPolicy),
      ...legacyOutput(state.outputMode, state.outputURL),
    };
  });
}

export function extractorPageSettings() {
  return safely(() => {
    const state = useSubtitleExtractorStore.getState();
    return { keep: oneOf(TRANSLATION_LANGUAGES, state.keep), conflictPolicy: conflict(state.conflictPolicy), ...legacyOutput(state.outputMode, state.outputURL) };
  });
}

export function nameTranslatorPageSettings(): Partial<NameTranslatorConfig> {
  return safely(() => ({ ...useNameTranslatorConfigStore.getState().config }));
}
