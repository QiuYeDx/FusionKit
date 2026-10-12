import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zh from "../../src/locales/zh/knowledge.json";
import en from "../../src/locales/en/knowledge.json";
import { diagnosticText, languagePairLabel } from "../../src/pages/TranslationKnowledge/labels";

const i18n = createInstance();
await i18n.init({ lng: "zh", resources: { zh: { knowledge: zh }, en: { knowledge: en } } });

describe("translation material labels", () => {
  it("names translation directions in the interface language and keeps unknown tags as written", () => {
    expect(languagePairLabel(i18n.getFixedT("zh", "knowledge"), { source: "ja", target: "zh-Hans" })).toBe(`${zh.languages.ja} → ${zh.languages["zh-Hans"]}`);
    expect(languagePairLabel(i18n.getFixedT("en", "knowledge"), { source: "yue", target: "en" })).toBe(`yue → ${en.languages.en}`);
  });

  it("explains known diagnostics and falls back to the diagnostic's own message", () => {
    const t = i18n.getFixedT("zh", "knowledge");
    expect(diagnosticText(t, { code: "UNSUPPORTED_SCHEMA_VERSION", message: "x" })).toBe(zh.diagnostic.UNSUPPORTED_SCHEMA_VERSION);
    expect(diagnosticText(t, { code: "SOMETHING_NEW", message: "Raw message" })).toBe("Raw message");
  });
});
