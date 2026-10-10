import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { biligameCodeSchema, WEB_SOURCES, type WebSource } from "@/web-lookup/contract";

export const BILIGAME_WIKI_LIMIT = 10;

export interface WebLookupSettings {
  /** Off until the user allows the assistant to send search words to the chosen sites. */
  enabled: boolean;
  sources: Record<WebSource, boolean>;
  /** Bilibili game wiki codes, as in wiki.biligame.com/zzz; the first is the default. */
  biligameWikis: string[];
}

interface WebLookupStore extends WebLookupSettings {
  setEnabled: (enabled: boolean) => void;
  setSource: (source: WebSource, enabled: boolean) => void;
  setBiligameWikis: (codes: string[]) => void;
}

export const DEFAULT_WEB_LOOKUP_SETTINGS: WebLookupSettings = {
  enabled: false,
  sources: Object.fromEntries(WEB_SOURCES.map((source) => [source, true])) as Record<WebSource, boolean>,
  biligameWikis: [],
};

/** Splits typed wiki codes; returns the invalid ones too so the field can say which. */
export function parseBiligameWikis(text: string): { codes: string[]; invalid: string[] } {
  const parts = [...new Set(text.split(/[\s,，、]+/).map((part) => part.trim().toLowerCase()).filter(Boolean))];
  return {
    codes: parts.filter((part) => biligameCodeSchema.safeParse(part).success),
    invalid: parts.filter((part) => !biligameCodeSchema.safeParse(part).success),
  };
}

/** Persisted settings with anything unknown or malformed replaced by its default. */
export function sanitizeWebLookupSettings(value: Partial<WebLookupSettings> | undefined): WebLookupSettings {
  const sources = { ...DEFAULT_WEB_LOOKUP_SETTINGS.sources };
  for (const source of WEB_SOURCES) {
    if (typeof value?.sources?.[source] === "boolean") sources[source] = value.sources[source];
  }
  const wikis = (Array.isArray(value?.biligameWikis) ? value.biligameWikis : [])
    .flatMap((code) => { const parsed = biligameCodeSchema.safeParse(code); return parsed.success ? [parsed.data] : []; });
  return {
    enabled: value?.enabled === true,
    sources,
    biligameWikis: [...new Set(wikis)].slice(0, BILIGAME_WIKI_LIMIT),
  };
}

const useWebLookupStore = create<WebLookupStore>()(
  persist(
    (set) => ({
      ...DEFAULT_WEB_LOOKUP_SETTINGS,
      setEnabled: (enabled) => set({ enabled }),
      setSource: (source, enabled) => set((state) => ({ sources: { ...state.sources, [source]: enabled } })),
      setBiligameWikis: (codes) => set({ biligameWikis: sanitizeWebLookupSettings({ biligameWikis: codes }).biligameWikis }),
    }),
    {
      name: "fusionkit-web-lookup",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ enabled, sources, biligameWikis }) => ({ enabled, sources, biligameWikis }),
      merge: (persisted, current) => ({ ...current, ...sanitizeWebLookupSettings(persisted as Partial<WebLookupSettings>) }),
    },
  ),
);

export default useWebLookupStore;
