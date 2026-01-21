import { LangEnum } from "@/type/lang";

export const LANGUAGE_STORAGE_KEY = "lang";
export const DEFAULT_LANGUAGE = LangEnum.ZH;
export const FALLBACK_LANGUAGE = LangEnum.ZH;
export const SUPPORTED_LANGUAGES = Object.values(LangEnum) as LangEnum[];

export const NAMESPACES = [
  "common",
  "home",
  "tools",
  "about",
  "setting",
  "subtitle",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NAMESPACE: Namespace = "common";

export const normalizeLanguage = (lng?: string | null): LangEnum => {
  if (!lng) return DEFAULT_LANGUAGE;
  const base = lng.split("-")[0] as LangEnum;
  return SUPPORTED_LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
};

export const resolveInitialLanguage = (): LangEnum => {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored);
  } catch {
    return DEFAULT_LANGUAGE;
  }
};
