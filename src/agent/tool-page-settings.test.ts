import { afterEach, describe, expect, it } from "vitest";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleTranslatorConfigStore, { DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import { converterPageSettings, SettingsResolver, translatorPageSettings } from "./tool-page-settings";

afterEach(() => useSubtitleTranslatorConfigStore.setState({ preferences: { ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } }));

describe("tool page settings", () => {
  it("prefers the request, then the tool page, then the built-in default", () => {
    const settings = new SettingsResolver();
    expect(settings.pick("a", "user", "page", "default")).toBe("user");
    expect(settings.pick("b", undefined, "page", "default")).toBe("page");
    expect(settings.pick("c", undefined, undefined, "default")).toBe("default");
    expect(settings.applied).toEqual({ a: { value: "user", source: "user" }, b: { value: "page", source: "tool_page" }, c: { value: "default", source: "default" } });
  });

  it("ignores page values outside what the tools accept", () => {
    useSubtitleTranslatorConfigStore.setState({ preferences: { ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES, targetLang: "XX", customSliceLength: 99999 } as never });
    const page = translatorPageSettings();
    expect(page.targetLang).toBeUndefined();
    expect(page.customSliceLength).toBeUndefined();
    expect(page.sourceLang).toBe("JA");
  });

  it("reuses a converter output folder only when the page chose one", () => {
    useSubtitleConverterStore.setState({ outputMode: "custom", outputURL: " D:/subs " } as never);
    expect(converterPageSettings()).toMatchObject({ outputMode: "custom", outputDir: "D:/subs" });
    useSubtitleConverterStore.setState({ outputMode: "custom", outputURL: "" } as never);
    expect(converterPageSettings().outputDir).toBeUndefined();
  });
});
