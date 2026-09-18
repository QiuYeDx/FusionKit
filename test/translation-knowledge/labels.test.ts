import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zh from "../../src/locales/zh/knowledge.json";
import { languagePairLabel, scopeSummary } from "../../src/pages/TranslationKnowledge/labels";
import { knowledgeFixture } from "./fixtures";

const i18n = createInstance();
await i18n.init({ lng: "zh", resources: { zh: { knowledge: zh } } });
const t = i18n.getFixedT("zh", "knowledge");

describe("translation material summaries", () => {
  it("does not show an unrestricted scope when only a condition is present", () => {
    const scope = knowledgeFixture().entries[0].scope;
    scope.requiredSubjects = [];
    scope.condition = { mode: "requires_confirmation", text: "仅用于游戏实况" };
    expect(scopeSummary(t, scope, [])).toBe("使用前需确认: 仅用于游戏实况");
    scope.condition = { mode: "advisory", text: "说话者语气轻松" };
    expect(scopeSummary(t, scope, [])).toBe("提供语境提示: 说话者语气轻松");
    scope.condition = { mode: "none" };
    expect(scopeSummary(t, scope, [])).toBe(zh.scope.general);
  });

  it("keeps subject requirements and confirmation conditions visible together", () => {
    const data = knowledgeFixture();
    const scope = data.entries[0].scope;
    const subject = data.subjects[0];
    scope.requiredSubjects = [{ subjectId: subject.id, role: "speaker" }];
    scope.condition = { mode: "requires_confirmation", text: "正式场合" };
    expect(scopeSummary(t, scope, data.subjects)).toBe(`${subject.name} · 说话者 / 使用前需确认: 正式场合`);
  });

  it("localizes common language names and preserves custom tags", () => {
    const pair = { source: "en", target: "zh-Hans" };
    expect(languagePairLabel(t, pair)).toBe("英语 → 简体中文");
    expect(pair).toEqual({ source: "en", target: "zh-Hans" });
    expect(languagePairLabel(t, { source: "it", target: "zh-Hant" })).toBe("it → 繁体中文");
  });
});
