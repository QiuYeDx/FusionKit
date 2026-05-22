import { describe, expect, it } from "vitest";
import { classifyAgentOperationIntent } from "./name-translation-intent";

describe("agent operation intent split", () => {
  it.each([
    "把 /tmp/a.srt 翻译成中文",
    "翻译字幕内容",
    "translate these SRT subtitles to Chinese",
  ])("keeps subtitle content translation separate: %s", (text) => {
    expect(classifyAgentOperationIntent(text)).toBe("subtitle_translation");
  });

  it.each([
    "把 /tmp/a.srt 文件名翻译成中文",
    "把 /tmp/日剧 里面的文件名翻译成英文",
    "重命名这个文件夹",
    "rename the folder names to English",
  ])("detects filename/folder-name translation: %s", (text) => {
    expect(classifyAgentOperationIntent(text)).toBe("name_translation");
  });

  it("does not force a tool for ordinary chat", () => {
    expect(classifyAgentOperationIntent("你好，今天能做点什么？")).toBe(
      "unknown"
    );
  });
});
