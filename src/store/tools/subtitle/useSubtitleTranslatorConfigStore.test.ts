import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const localStorage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  return { localStorage, values };
});

import { SubtitleSliceType } from "@/type/subtitle";
import useSubtitleTranslatorConfigStore, {
  DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
  SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY,
  bootstrapLegacySubtitleTranslatorConfig,
  sanitizeSubtitleTranslatorConfigPreferences,
  subtitleTranslatorDirectoryDisplayLabel,
} from "./useSubtitleTranslatorConfigStore";

beforeEach(() => {
  useSubtitleTranslatorConfigStore.setState({
    preferences: sanitizeSubtitleTranslatorConfigPreferences(
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
    ),
    migrationStatus: "ready",
  });
  storage.values.clear();
});

describe("subtitle translator safe config store", () => {
  it("migrates safe preferences without deleting or copying legacy paths", () => {
    const legacyEnvelope = JSON.stringify({
      state: {
        outputURL: "C:\\Users\\private-user\\Subtitle Exports",
        sliceType: SubtitleSliceType.CUSTOM,
        sliceLengthMap: { [SubtitleSliceType.CUSTOM]: 777 },
      },
      version: 0,
    });
    storage.values.set("fusionkit-subtitle-translator", legacyEnvelope);
    storage.values.set("subtitle-translator-output-mode", "custom");
    storage.values.set("subtitle-translator-conflict-policy", "overwrite");
    storage.values.set("subtitle-translator-concurrent-slices", "false");
    storage.values.set("subtitle-translator-source-lang", "EN");
    storage.values.set("subtitle-translator-target-lang", "JA");
    storage.values.set(
      "subtitle-translator-translation-output-mode",
      "target_only",
    );

    expect(
      bootstrapLegacySubtitleTranslatorConfig(storage.localStorage),
    ).toBe("migrated");
    const persisted = storage.values.get(
      SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY,
    ) ?? "";
    expect(JSON.parse(persisted)).toMatchObject({
      state: {
        preferences: {
          sourceLang: "EN",
          targetLang: "JA",
          translationOutputMode: "target_only",
          sliceType: "CUSTOM",
          customSliceLength: 777,
          outputMode: "custom",
          outputDirectoryDisplayLabel: "Subtitle Exports",
          conflictPolicy: "overwrite",
          concurrentSlices: false,
        },
      },
    });
    expect(persisted).not.toMatch(/private-user|C:\\Users/u);
    expect(storage.values.get("fusionkit-subtitle-translator")).toBe(
      legacyEnvelope,
    );
    expect(storage.values.get("subtitle-translator-output-mode")).toBe(
      "custom",
    );
  });

  it("sanitizes invalid values and stores only the preference whitelist", () => {
    const sanitized = sanitizeSubtitleTranslatorConfigPreferences({
      sourceLang: "ZH",
      targetLang: "ZH",
      outputMode: "custom",
      outputDirectoryDisplayLabel: "/private/output",
      customSliceLength: -1,
      capabilityToken: "private-capability",
      apiKey: "private-api-key",
    });
    expect(sanitized.sourceLang).toBe("ZH");
    expect(sanitized.targetLang).toBe("JA");
    expect(sanitized.outputDirectoryDisplayLabel).toBeNull();
    expect(sanitized.customSliceLength).toBe(
      DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES.customSliceLength,
    );

    useSubtitleTranslatorConfigStore.getState().updatePreferences({
      outputMode: "source",
      sourceLang: "EN",
    });
    const persisted = storage.values.get(
      SUBTITLE_TRANSLATOR_CONFIG_STORAGE_KEY,
    ) ?? "";
    expect(persisted).toContain('"sourceLang":"EN"');
    expect(persisted).not.toMatch(/private-(?:capability|api-key)|outputURL/u);
  });

  it("derives only a safe display leaf from legacy paths", () => {
    expect(
      subtitleTranslatorDirectoryDisplayLabel("/Users/private/Exports"),
    ).toBe("Exports");
    expect(
      subtitleTranslatorDirectoryDisplayLabel("C:\\Private\\Subtitles"),
    ).toBe("Subtitles");
    expect(subtitleTranslatorDirectoryDisplayLabel("../")).toBeNull();
  });

  it("does not report migration success without exact target readback", () => {
    const values = new Map<string, string>();
    const storageWithoutReadback = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => undefined,
    };
    expect(
      bootstrapLegacySubtitleTranslatorConfig(storageWithoutReadback),
    ).toBe("failed");
  });
});
