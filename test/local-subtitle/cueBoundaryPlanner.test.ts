import { describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_LIMITS } from "../../src/type/localSubtitle";
import {
  LocalSubtitleCuePlanError,
  planLocalSubtitleSegmentCue,
  type LocalSubtitleCueSource,
} from "../../electron/main/local-subtitle/cue-boundary-planner";

const targets = { maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 };
const source = (text: string): LocalSubtitleCueSource => ({
  timelineDomain: "original_media", startMs: 2500, endMs: 16590, text,
});

describe("segment-only cue planning", () => {
  it.each([
    "ああもしもし私だそうだイオリだお前は誰だそうかお兄さんか",
    "はは知っておる私が通話をかけたのだそなたがお兄さんだと知らないはずがなかろう",
    "うん",
    "supercalifragilisticexpialidocious",
    "👩‍💻é✈️🇨🇳".repeat(4),
  ])("never creates a timed cut or a word-internal line break: %s", text => {
    for (const duration of [500, 3000, 7000, 15000]) {
      const plan = planLocalSubtitleSegmentCue(source(text), {
        maxCueDurationMs: duration, maxCueChars: 20, maxLineChars: 10,
      });
      expect(plan).toMatchObject({ startMs: 2500, endMs: 16590, text });
      expect(plan).not.toHaveProperty("estimatedTiming");
      expect(plan.lines).toHaveLength(1);
    }
  });

  it.each([
    "あ、もしもしー。そうだ、私だ。お前は誰だ？",
    "First sentence! Second sentence? Third sentence.",
    "値段は1,234円です。Really? 👩‍💻éありがとう。",
    "一、 二、 三、 四、 五、 六。",
    "Again again again again again again.",
  ])("covers each source position exactly once and keeps punctuation: %s", text => {
    const plan = planLocalSubtitleSegmentCue(source(text), {...targets, maxLineChars: 10});
    const units = Array.from(new Intl.Segmenter("und", {granularity: "grapheme"}).segment(text), x => x.segment);
    let cursor = 0;
    for (const line of plan.lines) {
      expect(line.startGrapheme).toBe(cursor);
      expect(line.endGrapheme).toBeGreaterThan(cursor);
      cursor = line.endGrapheme;
    }
    expect(cursor).toBe(units.length);
    expect(plan.lines.map(line => units.slice(line.startGrapheme, line.endGrapheme).join("")).join("")).toBe(text);
    expect(plan.text.replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
    expect(plan.text).not.toContain("1,\n234");
    expect(plan.text.split("\n").every(line => line.trim().length > 0)).toBe(true);
    expect(plan.lines.length).toBeLessThanOrEqual(4);
    expect(Object.isFrozen(plan.lines[0])).toBe(true);
  });

  it("relaxes the line target to meet the four-line format limit", () => {
    const text = Array.from({length: 40}, (_, index) => `word${index}`).join(" ");
    const plan = planLocalSubtitleSegmentCue(source(text), {...targets, maxLineChars: 10});
    expect(plan.lines.length).toBeLessThanOrEqual(4);
    expect(plan.exceedsDisplayTarget).toBe(true);
    expect(plan.text.replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
  });

  it("fails explicitly at hard format limits without manufacturing timestamps", () => {
    for (const text of ["語".repeat(1025), "word ".repeat(820).trim()]) {
      expect(() => planLocalSubtitleSegmentCue(source(text), targets)).toThrow(LocalSubtitleCuePlanError);
      try { planLocalSubtitleSegmentCue(source(text), targets); }
      catch (error) {
        expect(error).toMatchObject({reason: "limit_exceeded"});
        expect(String(error)).not.toContain(text);
      }
    }
    expect(planLocalSubtitleSegmentCue(source("語".repeat(1024)), targets).text).toHaveLength(1024);
  });

  it.each([
    {timelineDomain: "vad_compressed"}, {startMs: -1}, {startMs: 17000},
    {endMs: 2500}, {endMs: Number.NaN}, {endMs: LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1},
    {text: ""}, {text: " raw "}, {text: "first\nsecond"},
  ])("rejects unsupported or invalid source evidence: %j", invalid => {
    expect(() => planLocalSubtitleSegmentCue({...source("valid"), ...invalid} as LocalSubtitleCueSource, targets))
      .toThrow(LocalSubtitleCuePlanError);
  });
});
