import { describe, expect, it } from "vitest";
import { createLocalSubtitleArtifactPreviewPage, filterLocalSubtitlePreview, parseLocalSubtitlePreview } from "./localSubtitlePreviewModel";

describe("read-only subtitle preview", () => {
  it("preserves multiline cues, repeated speech and real SRT ends", () => {
    const cues = parseLocalSubtitlePreview("1\r\n00:00:01,000 --> 00:00:02,500\r\nはい\r\nHello <script>\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nはい", "SRT");
    expect(cues).toEqual([{ number: 1, start: "00:00:01.000", end: "00:00:02.500", text: "はい\nHello <script>" },
      { number: 2, start: "00:00:05.000", end: "00:00:06.000", text: "はい" }]);
    expect(filterLocalSubtitlePreview(cues!, "はい")).toHaveLength(2);
    expect(filterLocalSubtitlePreview(cues!, "HELLO")).toEqual([cues![0]]);
    expect(filterLocalSubtitlePreview(cues!, "02.500")).toEqual([cues![0]]);
    expect(filterLocalSubtitlePreview(cues!, "[script]*")).toEqual([]);
  });
  it("never creates an end time or drops repeated tags in LRC", () => {
    expect(parseLocalSubtitlePreview("[ar:sample]\n[00:01.00][00:05.00]はい\n[00:05.00]はい", "LRC")).toEqual([
      { number: 1, start: "[00:01.00] [00:05.00]", text: "はい" }, { number: 2, start: "[00:05.00]", text: "はい" },
    ]);
  });
  it("signals fallback without partially hiding invalid file content", () => {
    expect(parseLocalSubtitlePreview("bad file", "SRT")).toBeNull();
    expect(parseLocalSubtitlePreview("[00:01.00]valid\ninvalid", "LRC")).toBeNull();
    expect(parseLocalSubtitlePreview("", "SRT")).toEqual([]);
  });
  it("keeps a long cue intact in reading view", () => {
    const text = "文字".repeat(8000);
    expect(parseLocalSubtitlePreview(`1\n00:00:00,000 --> 00:01:00,000\n${text}`, "SRT")![0].text).toBe(text);
  });
  it("reassembles raw pages exactly without splitting a surrogate pair", () => {
    const text = "1234😀5678😀\nlast";
    const first = createLocalSubtitleArtifactPreviewPage(text, 0, 5);
    const pages = Array.from({ length: first.pageCount }, (_, i) => createLocalSubtitleArtifactPreviewPage(text, i, 5).text);
    expect(pages.join("")).toBe(text);
    expect(pages.every(page => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(page))).toBe(true);
  });
});
