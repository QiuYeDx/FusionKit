import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "./resources";
import {
  DEFAULT_NAMESPACE,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  NAMESPACES,
  normalizeLanguage,
  resolveInitialLanguage,
  SUPPORTED_LANGUAGES,
} from "./constants";

const initialLanguage = resolveInitialLanguage();

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  ns: NAMESPACES,
  defaultNS: DEFAULT_NAMESPACE,
  load: "languageOnly",
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

i18n.on("languageChanged", (lng) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(lng));
  } catch {
    // 忽略存储失败
  }
});

export default i18n;
