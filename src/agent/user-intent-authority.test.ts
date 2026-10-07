import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./types";
import { userMentionedDirectory, userRequestedOverwrite } from "./user-intent-authority";

const user = (content: string): AgentMessage => ({ id: content, role: "user", content, timestamp: 1 });

describe("user intent authority", () => {
  it.each(["同名文件直接覆盖", "覆盖已有文件", "Overwrite existing files", "replace the old ones", "既存ファイルを上書きして"])("accepts explicit overwrite: %s", (text) => {
    expect(userRequestedOverwrite(text)).toBe(true);
  });
  it.each(["转成 LRC", "不要覆盖", "别覆盖原文件", "Do not overwrite anything", "don't replace files", "keep both copies"])("rejects missing or negated overwrite: %s", (text) => {
    expect(userRequestedOverwrite(text)).toBe(false);
  });
  it("matches whole typed directories across separators and CJK neighbours", () => {
    const messages = [user("输出到D:\\Subs\\out目录"), { ...user("C:/Secret"), role: "assistant" as const }];
    expect(userMentionedDirectory(messages, "D:/Subs/out")).toBe(true);
    expect(userMentionedDirectory(messages, "d:\\subs\\out\\")).toBe(true);
    expect(userMentionedDirectory(messages, "D:/Subs")).toBe(false);
    expect(userMentionedDirectory(messages, "D:/Subs/o")).toBe(false);
    expect(userMentionedDirectory(messages, "C:/Secret")).toBe(false);
    expect(userMentionedDirectory([user("save to /")], "/")).toBe(false);
  });
});
