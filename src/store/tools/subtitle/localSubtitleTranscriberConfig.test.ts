import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
  sanitizeLocalSubtitleTranscriberPreferences,
} from "./localSubtitleTranscriberConfig";

describe("local subtitle transcriber preferences", () => {
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
      qualityPreset: "balanced",
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
        qualityPreset: "maximum",
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
