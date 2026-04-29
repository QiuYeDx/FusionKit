import { describe, expect, it } from "vitest";
import { cleanTranslatedLrcContent } from "../../electron/main/translation/lrc-utils";

describe("cleanTranslatedLrcContent", () => {
  it("keeps valid LRC lines and trims indentation", () => {
    const result = cleanTranslatedLrcContent(`
      [01:54.80]Recordamos lo que queremos recordar.
        [01:54.80]我们记得自己想记得的东西。
      This is an explanation that should be removed.
    `);

    expect(result).toBe(
      [
        "[01:54.80]Recordamos lo que queremos recordar.",
        "[01:54.80]我们记得自己想记得的东西。",
      ].join("\n"),
    );
  });

  it("removes markdown fences while preserving LRC content", () => {
    const result = cleanTranslatedLrcContent(`
      \`\`\`lrc
      [02:01.20]Por eso la literatura y la vida
      [02:01.20]所以文学与生活
      \`\`\`
    `);

    expect(result).toBe(
      [
        "[02:01.20]Por eso la literatura y la vida",
        "[02:01.20]所以文学与生活",
      ].join("\n"),
    );
  });

  it("returns an empty string when no valid LRC line exists", () => {
    expect(cleanTranslatedLrcContent("Here is the translation.")).toBe("");
    expect(cleanTranslatedLrcContent(undefined)).toBe("");
  });
});
