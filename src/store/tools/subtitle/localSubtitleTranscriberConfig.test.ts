import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
  sanitizeLocalSubtitleTranscriberPreferences,
} from "./localSubtitleTranscriberConfig";

describe("local subtitle transcriber preferences", () => {
  it("defaults missing or invalid choices to pauses and enforces its VAD dependency", () => {
    expect(sanitizeLocalSubtitleTranscriberPreferences({ windowStrategy: "acoustic_quiet_v1" }).windowStrategy).toBe("acoustic_quiet_v1");
    for (const windowStrategy of [undefined, "arbitrary", null]) {
      expect(sanitizeLocalSubtitleTranscriberPreferences({ windowStrategy, vadEnabled: false })).toMatchObject({windowStrategy: "acoustic_quiet_v1", vadEnabled: true});
    }
  });
  it("uses the frozen safe defaults", () => {
    expect(sanitizeLocalSubtitleTranscriberPreferences(undefined)).toEqual(
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
    );
  });

  it("keeps valid persisted preferences without free text or capabilities", () => {
    expect(
      sanitizeLocalSubtitleTranscriberPreferences({
        modelId: "custom.ggml-model",
        devicePreference: "cuda",
        language: "zh-Hans",
        vadEnabled: false,
        windowStrategy: "fixed_v1",
        // Removed v1 preference must not survive persisted-state sanitization.
        qualityPreset: "balanced",
        beamSize: 3,
        temperature: 0.25,
        vadMinSilenceMs: 750,
        maxCueDurationMs: 6_000,
        maxCueChars: 72,
        maxLineChars: 36,
        outputFormats: ["LRC", "SRT", "LRC"],
        outputMode: "custom",
        outputDirectoryDisplayLabel: "Subtitles",
        initialPrompt: "must be ignored",
        outputDirToken: "must-be-ignored",
      }),
    ).toEqual({
      modelId: "custom.ggml-model",
      devicePreference: "cuda",
      language: "zh-Hans",
      vadEnabled: false,
      windowStrategy: "fixed_v1",
      beamSize: 3,
      temperature: 0.25,
      vadMinSilenceMs: 750,
      maxCueDurationMs: 6_000,
      maxCueChars: 72,
      maxLineChars: 36,
      outputFormats: ["LRC", "SRT"],
      outputMode: "custom",
      outputDirectoryDisplayLabel: "Subtitles",
    });
  });

  it("falls back field by field for malformed persisted values", () => {
    expect(
      sanitizeLocalSubtitleTranscriberPreferences({
        modelId: "../../model",
        devicePreference: "vulkan",
        language: "not a language",
        vadEnabled: "yes",
        beamSize: 0,
        temperature: Number.NaN,
        vadMinSilenceMs: 99,
        maxCueDurationMs: 15_001,
        maxCueChars: 19,
        maxLineChars: 1_025,
        outputFormats: ["TXT"],
        outputMode: "anywhere",
      }),
    ).toEqual(DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES);
  });

  it.each(["/private/exports", "..", "nested\\exports", "bad\u0000name", " "])(
    "rejects unsafe custom directory display label %j",
    (outputDirectoryDisplayLabel) => {
      expect(
        sanitizeLocalSubtitleTranscriberPreferences({
          ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
          outputMode: "custom",
          outputDirectoryDisplayLabel,
        }).outputDirectoryDisplayLabel,
      ).toBeNull();
    },
  );

  it("drops a safe directory label when output mode is source", () => {
    expect(
      sanitizeLocalSubtitleTranscriberPreferences({
        ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
        outputDirectoryDisplayLabel: "Subtitles",
      }).outputDirectoryDisplayLabel,
    ).toBeNull();
  });
});
