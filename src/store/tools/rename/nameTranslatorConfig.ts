import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  NAME_LANGUAGES,
  NAME_TRANSLATION_LIMITS,
  type NameLanguage,
  type NameSourceLanguage,
} from "@/name-translation/contract";
import {
  BILINGUAL_STYLES,
  DEFAULT_NAME_TEMPLATE,
  MAX_NAME_TEMPLATE_CHARS,
  bilingualTemplate,
  type BilingualOrder,
  type BilingualStyle,
} from "@/name-translation/naming-rules";

export const NAME_TRANSLATOR_STORAGE_KEY = "fusionkit-name-translator";
export const NAME_TRANSLATOR_STORE_VERSION = 3;

export type NameMode = "translated" | "bilingual" | "custom";
const NAME_MODES: readonly NameMode[] = ["translated", "bilingual", "custom"];
const BILINGUAL_ORDERS: readonly BilingualOrder[] = ["translated_first", "original_first"];

export interface NameTranslatorConfig {
  sourceLang: NameSourceLanguage;
  targetLang: NameLanguage;
  nameMode: NameMode;
  bilingualOrder: BilingualOrder;
  bilingualStyle: BilingualStyle;
  customTemplate: string;
  includeHidden: boolean;
  instructions: string;
}

export const DEFAULT_NAME_TRANSLATOR_CONFIG: NameTranslatorConfig = {
  sourceLang: "auto",
  targetLang: "ZH",
  nameMode: "translated",
  bilingualOrder: "translated_first",
  bilingualStyle: "paren",
  customTemplate: "{translated} ({original})",
  includeHidden: false,
  instructions: "",
};

/** The `{translated}` / `{original}` template the current settings produce. */
export function resolveNameTemplate(config: NameTranslatorConfig): string {
  if (config.nameMode === "bilingual") return bilingualTemplate(config.bilingualStyle, config.bilingualOrder);
  if (config.nameMode === "custom") return config.customTemplate;
  return DEFAULT_NAME_TEMPLATE;
}

/** v1 `outputMode` and v2 `format` presets expressed in the v3 fields. */
const LEGACY_FORMATS: Record<string, Partial<NameTranslatorConfig>> = {
  target_only: { nameMode: "translated" },
  translated: { nameMode: "translated" },
  bilingual_target_first: { nameMode: "bilingual", bilingualOrder: "translated_first", bilingualStyle: "paren" },
  translated_original: { nameMode: "bilingual", bilingualOrder: "translated_first", bilingualStyle: "paren" },
  bilingual_original_first: { nameMode: "bilingual", bilingualOrder: "original_first", bilingualStyle: "paren" },
  original_translated: { nameMode: "bilingual", bilingualOrder: "original_first", bilingualStyle: "paren" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function sanitizeNameTranslatorConfig(value: unknown): NameTranslatorConfig {
  const saved = isRecord(value) ? value : {};
  return {
    sourceLang: oneOf<NameSourceLanguage>(
      saved.sourceLang,
      ["auto", ...NAME_LANGUAGES],
      DEFAULT_NAME_TRANSLATOR_CONFIG.sourceLang,
    ),
    targetLang: oneOf(saved.targetLang, NAME_LANGUAGES, DEFAULT_NAME_TRANSLATOR_CONFIG.targetLang),
    nameMode: oneOf(saved.nameMode, NAME_MODES, DEFAULT_NAME_TRANSLATOR_CONFIG.nameMode),
    bilingualOrder: oneOf(saved.bilingualOrder, BILINGUAL_ORDERS, DEFAULT_NAME_TRANSLATOR_CONFIG.bilingualOrder),
    bilingualStyle: oneOf(saved.bilingualStyle, BILINGUAL_STYLES, DEFAULT_NAME_TRANSLATOR_CONFIG.bilingualStyle),
    customTemplate:
      typeof saved.customTemplate === "string"
        ? saved.customTemplate.slice(0, MAX_NAME_TEMPLATE_CHARS)
        : DEFAULT_NAME_TRANSLATOR_CONFIG.customTemplate,
    includeHidden:
      typeof saved.includeHidden === "boolean"
        ? saved.includeHidden
        : DEFAULT_NAME_TRANSLATOR_CONFIG.includeHidden,
    instructions:
      typeof saved.instructions === "string"
        ? saved.instructions.slice(0, NAME_TRANSLATION_LIMITS.maxInstructionsChars)
        : DEFAULT_NAME_TRANSLATOR_CONFIG.instructions,
  };
}

/**
 * v1 stored `{ options: { targetLang, sourceLang, outputMode, includeHidden, ... } }`;
 * v2 stored `{ config: { ..., format } }`.
 */
export function migrateNameTranslatorConfig(persisted: unknown, version: number): NameTranslatorConfig {
  if (version < 2) {
    const options = isRecord(persisted) && isRecord(persisted.options) ? persisted.options : {};
    return sanitizeNameTranslatorConfig({
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      includeHidden: options.includeHidden,
      ...(typeof options.outputMode === "string" ? LEGACY_FORMATS[options.outputMode] : {}),
    });
  }
  const config = isRecord(persisted) && isRecord(persisted.config) ? persisted.config : {};
  if (version < 3) {
    return sanitizeNameTranslatorConfig({
      ...config,
      ...(typeof config.format === "string" ? LEGACY_FORMATS[config.format] : {}),
    });
  }
  return sanitizeNameTranslatorConfig(config);
}

interface NameTranslatorConfigState {
  config: NameTranslatorConfig;
  updateConfig: (patch: Partial<NameTranslatorConfig>) => void;
}

const useNameTranslatorConfigStore = create<NameTranslatorConfigState>()(
  persist(
    (set) => ({
      config: DEFAULT_NAME_TRANSLATOR_CONFIG,
      updateConfig: (patch) =>
        set((state) => ({ config: sanitizeNameTranslatorConfig({ ...state.config, ...patch }) })),
    }),
    {
      name: NAME_TRANSLATOR_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: NAME_TRANSLATOR_STORE_VERSION,
      partialize: (state) => ({ config: state.config }),
      migrate: (persisted, version) => ({ config: migrateNameTranslatorConfig(persisted, version) }),
      merge: (persisted, current) => ({
        ...current,
        config: sanitizeNameTranslatorConfig(isRecord(persisted) ? persisted.config : undefined),
      }),
    },
  ),
);

export default useNameTranslatorConfigStore;
