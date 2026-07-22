import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleSegment,
  type LocalSubtitleTranscript,
} from "../../src/type/localSubtitle";
import {
  LocalSubtitleFormatError,
  encodeLocalSubtitleArtifact,
  formatLocalSubtitleArtifact,
  formatLocalSubtitleLrc,
  formatLocalSubtitleSrt,
  parseLocalSubtitleArtifactUtf8,
  parseLocalSubtitleLrcUtf8,
  parseLocalSubtitleSrtUtf8,
  projectLocalSubtitleLrcText,
  toPlainLocalSubtitleText,
  verifyLocalSubtitleArtifactRoundTrip,
  type ParsedLocalSubtitleArtifact,
} from "../../electron/main/local-subtitle/subtitle-formats";

const UTF8_ENCODER = new TextEncoder();

describe("local subtitle SRT and LRC formatting", () => {
  it("uses exact integer-millisecond SRT timestamps across minute and hour boundaries", () => {
    const value = formatLocalSubtitleSrt(
      transcript([
        segment(0, 1, "zero"),
        segment(9, 10, "nine"),
        segment(10, 11, "ten"),
        segment(11, 12, "eleven"),
        segment(59_999, 60_000, "minute edge"),
        segment(60_000, 60_001, "minute"),
        segment(3_600_001, 3_600_123, "hour"),
      ]),
    );

    expect(value).toBe(
      [
        "1\n00:00:00,000 --> 00:00:00,001\nzero",
        "2\n00:00:00,009 --> 00:00:00,010\nnine",
        "3\n00:00:00,010 --> 00:00:00,011\nten",
        "4\n00:00:00,011 --> 00:00:00,012\neleven",
        "5\n00:00:59,999 --> 00:01:00,000\nminute edge",
        "6\n00:01:00,000 --> 00:01:00,001\nminute",
        "7\n01:00:00,001 --> 01:00:00,123\nhour",
      ].join("\n\n") + "\n",
    );
  });

  it("floors standard LRC starts to centiseconds without merging equal labels", () => {
    const source = transcript([
      segment(0, 1, "zero"),
      segment(9, 10, "nine"),
      segment(10, 11, "ten"),
      segment(11, 12, "eleven"),
      segment(59_999, 60_000, "minute edge"),
      segment(60_000, 60_001, "minute"),
      segment(3_600_001, 3_600_123, "hour"),
    ]);

    const value = formatLocalSubtitleLrc(source);

    expect(value).toBe(
      [
        "[00:00.00]zero",
        "[00:00.00]nine",
        "[00:00.01]ten",
        "[00:00.01]eleven",
        "[00:59.99]minute edge",
        "[01:00.00]minute",
        "[60:00.00]hour",
        "",
      ].join("\n"),
    );

    const parsed = parseLocalSubtitleLrcUtf8(UTF8_ENCODER.encode(value));
    expect(parsed.cues.map((cue) => [cue.startMs, cue.text])).toEqual([
      [0, "zero"],
      [0, "nine"],
      [10, "ten"],
      [10, "eleven"],
      [59_990, "minute edge"],
      [60_000, "minute"],
      [3_600_000, "hour"],
    ]);
    expect(() =>
      verifyLocalSubtitleArtifactRoundTrip("LRC", source, parsed),
    ).not.toThrow();
  });

  it("formats the maximum supported timeline without overflowing either syntax", () => {
    const source = transcript([
      segment(
        LOCAL_SUBTITLE_LIMITS.maxDurationMs - 1,
        LOCAL_SUBTITLE_LIMITS.maxDurationMs,
        "last millisecond",
      ),
    ]);

    expect(formatLocalSubtitleSrt(source)).toBe(
      "1\n99:59:59,998 --> 99:59:59,999\nlast millisecond\n",
    );
    expect(formatLocalSubtitleLrc(source)).toBe(
      "[5999:59.99]last millisecond\n",
    );
  });

  it("emits LF-only UTF-8 without a BOM and derives plain text from parsed cues", () => {
    const source = transcript([
      segment(0, 500, "\u4f60\u597d\tworld\nsecond \ud83d\ude00"),
      segment(500, 1_000, "tail"),
    ]);

    const srtBytes = encodeLocalSubtitleArtifact("SRT", source);
    const srt = parseLocalSubtitleArtifactUtf8("SRT", srtBytes);
    expect(Array.from(srtBytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(srt.rawText).not.toContain("\r");
    expect(srt.cues[0]?.text).toBe("\u4f60\u597d\tworld\nsecond \ud83d\ude00");
    expect(toPlainLocalSubtitleText(srt)).toBe(
      "\u4f60\u597d\tworld\nsecond \ud83d\ude00\ntail",
    );
    expect(Object.isFrozen(srt)).toBe(true);
    expect(Object.isFrozen(srt.cues)).toBe(true);
    expect(() =>
      verifyLocalSubtitleArtifactRoundTrip("SRT", source, srt),
    ).not.toThrow();

    const lrc = parseLocalSubtitleArtifactUtf8(
      "LRC",
      encodeLocalSubtitleArtifact("LRC", source),
    );
    expect(lrc.cues[0]?.text).toBe("\u4f60\u597d\tworld second \ud83d\ude00");
    expect(toPlainLocalSubtitleText(lrc)).toBe(
      "\u4f60\u597d\tworld second \ud83d\ude00\ntail",
    );
  });

  it("projects the largest valid four-line cue into one bounded LRC line", () => {
    const multiline = ["a", "b", "c", "d"]
      .map((value) => value.repeat(LOCAL_SUBTITLE_LIMITS.maxLineChars))
      .join("\n");
    const projected = projectLocalSubtitleLrcText(multiline);

    expect(projected.length).toBe(
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars +
        LOCAL_SUBTITLE_LIMITS.maxCueLines -
        1,
    );
    expect(projected).not.toContain("\n");

    const value = formatLocalSubtitleLrc(
      transcript([segment(0, 1, multiline)]),
    );
    const parsed = parseLocalSubtitleLrcUtf8(UTF8_ENCODER.encode(value));
    expect(parsed.cues[0]?.text).toBe(projected);
  });

  it("rejects SRT-ambiguous empty cue lines while retaining the LRC projection", () => {
    const source = transcript([segment(0, 1, "first\n\nthird")]);

    expectFormatError(() => formatLocalSubtitleSrt(source), "invalid_content");
    expect(formatLocalSubtitleLrc(source)).toBe(
      "[00:00.00]first  third\n",
    );
  });

  it("dispatches only to the requested standard format", () => {
    const source = transcript([segment(0, 1, "cue")]);
    expect(formatLocalSubtitleArtifact("SRT", source)).toBe(
      formatLocalSubtitleSrt(source),
    );
    expect(formatLocalSubtitleArtifact("LRC", source)).toBe(
      formatLocalSubtitleLrc(source),
    );
  });

  it("rejects formatted output as soon as the UTF-8 byte limit is exceeded", () => {
    const cueText = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxCueLines },
      () => "x".repeat(LOCAL_SUBTITLE_LIMITS.maxLineChars),
    ).join("\n");
    const source = transcript(
      Array.from({ length: 4_100 }, (_, index) =>
        segment(index, index + 1, cueText),
      ),
    );

    expectFormatError(() => formatLocalSubtitleLrc(source), "limit_exceeded");
  });
});

describe("local subtitle artifact parse-back", () => {
  it.each([
    {
      label: "empty bytes",
      parse: () => parseLocalSubtitleSrtUtf8(new Uint8Array()),
    },
    {
      label: "UTF-8 BOM",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "\ufeff1\n00:00:00,000 --> 00:00:00,001\ncue\n",
          ),
        ),
    },
    {
      label: "invalid UTF-8",
      parse: () =>
        parseLocalSubtitleSrtUtf8(Uint8Array.from([0xc3, 0x28])),
    },
    {
      label: "CRLF",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "1\r\n00:00:00,000 --> 00:00:00,001\r\ncue\r\n",
          ),
        ),
    },
    {
      label: "missing final LF",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "1\n00:00:00,000 --> 00:00:00,001\ncue",
          ),
        ),
    },
    {
      label: "two final LFs",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "1\n00:00:00,000 --> 00:00:00,001\ncue\n\n",
          ),
        ),
    },
    {
      label: "non-consecutive SRT index",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "2\n00:00:00,000 --> 00:00:00,001\ncue\n",
          ),
        ),
    },
    {
      label: "non-canonical SRT timestamp",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            "1\n0:00:00,000 --> 00:00:00,001\ncue\n",
          ),
        ),
    },
    {
      label: "overlapping SRT cues",
      parse: () =>
        parseLocalSubtitleSrtUtf8(
          UTF8_ENCODER.encode(
            [
              "1\n00:00:00,000 --> 00:00:00,010\nfirst",
              "2\n00:00:00,009 --> 00:00:00,011\nsecond\n",
            ].join("\n\n"),
          ),
        ),
    },
  ])("rejects $label", ({ parse }) => {
    expectFormatError(parse, "invalid_content");
  });

  it.each([
    "[000:00.00]extra leading minute digit\n",
    "[00:00.000]three fractional digits\n",
    "[00:60.00]invalid seconds\n",
    "[00:00.00]\n",
    "[00:00.01]later\n[00:00.00]earlier\n",
  ])("rejects non-canonical or lossy standard LRC: %s", (rawText) => {
    expectFormatError(
      () => parseLocalSubtitleLrcUtf8(UTF8_ENCODER.encode(rawText)),
      "invalid_content",
    );
  });

  it("enforces artifact byte, cue, and timestamp limits", () => {
    expectFormatError(
      () =>
        parseLocalSubtitleLrcUtf8(
          new Uint8Array(LOCAL_SUBTITLE_LIMITS.maxArtifactBytes + 1),
        ),
      "limit_exceeded",
    );

    const tooManyCues = "[00:00.00]x\n".repeat(
      LOCAL_SUBTITLE_LIMITS.maxArtifactCues + 1,
    );
    expectFormatError(
      () => parseLocalSubtitleLrcUtf8(UTF8_ENCODER.encode(tooManyCues)),
      "limit_exceeded",
    );
    expectFormatError(
      () =>
        parseLocalSubtitleLrcUtf8(
          UTF8_ENCODER.encode("[6000:00.00]past supported duration\n"),
        ),
      "limit_exceeded",
    );
  });

  it("detects parse-back identity drift instead of treating syntax as sufficient", () => {
    const source = transcript([segment(11, 20, "canonical")]);
    const parsed = parseLocalSubtitleLrcUtf8(
      encodeLocalSubtitleArtifact("LRC", source),
    );
    const changed: ParsedLocalSubtitleArtifact = {
      ...parsed,
      cues: [{ startMs: 10, text: "different" }],
    };

    expectFormatError(
      () => verifyLocalSubtitleArtifactRoundTrip("LRC", source, changed),
      "invalid_content",
    );
  });

  it("rejects transcripts outside the frozen canonical schema", () => {
    const source = transcript([segment(0, 1, "valid")]);
    const changed = {
      ...source,
      segments: [{ ...source.segments[0], text: "bad\u0000text" }],
    } as LocalSubtitleTranscript;

    expectFormatError(
      () => encodeLocalSubtitleArtifact("SRT", changed),
      "invalid_content",
    );
  });
});

function segment(
  startMs: number,
  endMs: number,
  text: string,
): Omit<LocalSubtitleSegment, "id"> {
  return { startMs, endMs, text };
}

function transcript(
  segments: readonly Omit<LocalSubtitleSegment, "id">[],
): LocalSubtitleTranscript {
  return {
    schemaVersion: 1,
    source: {
      displayName: "fixture.wav",
      durationMs: Math.max(...segments.map((item) => item.endMs)),
    },
    model: {
      engine: "whisper_cpp",
      modelId: "fixture-model",
      modelHash: "a".repeat(64),
      backend: "cpu",
    },
    segments: segments.map((item, index) => ({
      ...item,
      id: `cue-${index + 1}`,
    })),
  };
}

function expectFormatError(
  operation: () => unknown,
  code: LocalSubtitleFormatError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitleFormatError);
    expect((error as LocalSubtitleFormatError).code).toBe(code);
    return;
  }
  throw new Error(`Expected LocalSubtitleFormatError(${code}).`);
}
