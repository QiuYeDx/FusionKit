import { describe, expect, it } from "vitest";
import { parseSubtitleCueDocument, renderSubtitleCueResponse, subtitleWithoutTranslation, validateCommittedSubtitle } from "./subtitleCueProtocol";

const srt = "7\r\n00:00:01,005 --> 00:00:03,025 X1:10\r\n第一行\r\n第二行\r\n\r\n7\r\n00:00:05.000 --> 00:00:06.000\r\n第三行";
const lrc = "[ar:Artist]\n[offset:-100]\n\n[00:01.05][00:02.05]第一行\n[00:01.05]第二行\n[00:03.00]\n";
const payload = (cues: unknown[]) => JSON.stringify({cues});

describe("subtitle cue wire protocol", () => {
  it("locks SRT numbers/timing/settings and reconstructs source order from reordered IDs", () => {
    const document = parseSubtitleCueDocument(srt, "SRT");
    expect(document.cues).toEqual([{id: "cue-1", lines: ["第一行", "第二行"]}, {id: "cue-2", lines: ["第三行"]}]);
    const response = payload([{id: "cue-2", lines: ["Third"]}, {id: "cue-1", lines: ["First", "Second"]}]);
    const target = renderSubtitleCueResponse(document, response, false);
    expect(target).toBe("7\n00:00:01,005 --> 00:00:03,025 X1:10\nFirst\nSecond\n\n7\n00:00:05.000 --> 00:00:06.000\nThird");
    expect(() => validateCommittedSubtitle(document, target, false)).not.toThrow();
    const bilingual = renderSubtitleCueResponse(document, response, true);
    expect(bilingual).toContain("第一行\nFirst\n第二行\nSecond");
    expect(() => validateCommittedSubtitle(document, bilingual, true)).not.toThrow();
  });

  it("preserves LRC metadata, blank/empty cues, repeated and multiple timestamps", () => {
    const document = parseSubtitleCueDocument(lrc, "LRC");
    const response = payload([{id: "cue-1", lines: ["First"]}, {id: "cue-2", lines: ["Second"]}]);
    const target = renderSubtitleCueResponse(document, response, false);
    expect(target).toBe(lrc.replace("第一行", "First").replace("第二行", "Second"));
    const bilingual = renderSubtitleCueResponse(document, response, true);
    expect(bilingual).toBe(lrc.replace("[00:01.05][00:02.05]第一行", "[00:01.05][00:02.05]第一行\n[00:01.05][00:02.05]First").replace("[00:01.05]第二行", "[00:01.05]第二行\n[00:01.05]Second"));
    expect(() => validateCommittedSubtitle(document, bilingual, true)).not.toThrow();
    expect(() => validateCommittedSubtitle(document, target, false)).not.toThrow();
  });

  it.each([
    [],
    [{id: "cue-1", lines: ["One"]}, {id: "cue-1", lines: ["Again"]}],
    [{id: "cue-1", lines: ["One"]}, {id: "cue-9", lines: ["Extra"]}],
    [{id: "cue-1", lines: ["One"]}, {id: "cue-2", lines: ["Two"]}, {id: "cue-3", lines: ["Extra"]}],
    [{id: "cue-1", lines: []}, {id: "cue-2", lines: ["Two"]}],
    [{id: "cue-1", lines: ["One", "More"]}, {id: "cue-2", lines: ["Two"]}],
    [{id: "cue-1", lines: [" "]}, {id: "cue-2", lines: ["Two"]}],
    [{id: "cue-1", lines: [12]}, {id: "cue-2", lines: ["Two"]}],
    [{id: "cue-1", lines: ["One"], time: "changed"}, {id: "cue-2", lines: ["Two"]}],
  ])("rejects incomplete or ambiguous cue coverage %#", (...entries) => {
    // Vitest expands each row's array into arguments.
    const document = parseSubtitleCueDocument("[00:01.00]一\n[00:02.00]二", "LRC");
    expect(() => renderSubtitleCueResponse(document, payload(entries), false)).toThrow("字幕结构校验失败");
  });

  it.each(["One\n[00:02.00]Extra", "[00:02.00]Extra", "00:00:00,000 --> 00:00:01,000", "[ar:Injected]", "<00:01.00>Word", "A\u2028B", "A\u0000B"])("rejects structural content in translated lines: %j", line => {
    const document = parseSubtitleCueDocument("[00:01.00]一", "LRC");
    expect(() => renderSubtitleCueResponse(document, payload([{id: "cue-1", lines: [line]}]), false)).toThrow();
  });

  it.each(["[00:01.00]translated", '{"cues":', 'Here is the result: {"cues":[]}', '{"cues":[],"explanation":"hello"}', 'null'])("rejects non-protocol model output: %s", response => {
    expect(() => renderSubtitleCueResponse(parseSubtitleCueDocument("[00:01.00]一", "LRC"), response, false)).toThrow();
  });

  it("accepts only a complete JSON fence and preserves Unicode", () => {
    const document = parseSubtitleCueDocument("[00:01.00]日本語", "LRC");
    const output = renderSubtitleCueResponse(document, '```json\n{"cues":[{"id":"cue-1","lines":["中文 👩‍🚀 café"]}]}\n```', false);
    expect(output).toBe("[00:01.00]中文 👩‍🚀 café");
  });

  it.each(["[00:61.00]bad", "untimed", "[00:01.00]<00:01.01>enhanced"])("fails unsupported LRC source before translation: %s", source => {
    expect(() => parseSubtitleCueDocument(source, "LRC")).toThrow();
  });

  it.each(["1\ninvalid\nText", "1\n00:00:03,000 --> 00:00:01,000\nText"])("rejects malformed SRT: %s", source => {
    expect(() => parseSubtitleCueDocument(source, "SRT")).toThrow();
  });

  it("passes metadata-only input through without a model request", () => {
    const source = "[ar:Artist]\n\n[00:01.00]";
    expect(subtitleWithoutTranslation(parseSubtitleCueDocument(source, "LRC"))).toBe(source);
  });

  it("rejects legacy timing edits, missing/extra cues and altered bilingual originals", () => {
    const document = parseSubtitleCueDocument("[00:01.00]原文", "LRC");
    for (const translated of ["[00:02.00]译文", "[00:01.00]译文\n[00:02.00]多余", ""]) {
      expect(() => validateCommittedSubtitle(document, translated, false)).toThrow();
    }
    expect(() => validateCommittedSubtitle(document, "[00:01.00]改动\n[00:01.00]译文", true)).toThrow();
  });
});
