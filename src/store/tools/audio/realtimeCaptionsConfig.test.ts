import { describe, expect, it } from "vitest";
import {
  DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
  buildRealtimeCaptionsSessionConfig,
  canStartOpenAIRealtimeCaptions,
  createRealtimeCaptionLine,
  formatRealtimeCaptionLines,
  normalizeRealtimeCaptionsPreferences,
  resolveRealtimeCaptionsMode,
} from "./realtimeCaptionsConfig";

describe("realtime captions config helpers", () => {
  it("builds OpenAI Realtime caption session requests without API config fields", () => {
    const request = buildRealtimeCaptionsSessionConfig(
      {
        ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
        language: "zh",
        instructions: "Only transcribe user speech.",
        inputAudioFormat: "pcmu",
        turnDetection: "manual",
      },
      "openai_realtime",
    );

    expect(request).toEqual({
      assignmentKey: "realtimeCaptions",
      mode: "caption",
      language: "zh",
      inputAudioFormat: "pcmu",
      turnDetection: "server_vad",
    });
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("modelKey");
  });

  it("distinguishes OpenAI realtime from chunked near-realtime modes", () => {
    expect(
      resolveRealtimeCaptionsMode("openai_realtime", [
        "realtime_transcription",
      ]),
    ).toBe("openai_realtime");
    expect(
      resolveRealtimeCaptionsMode("mimo_chat_audio", [
        "streaming_transcription",
      ]),
    ).toBe("chunked_near_realtime");
    expect(canStartOpenAIRealtimeCaptions("mimo_chat_audio", [
      "streaming_transcription",
    ])).toBe(false);
  });

  it("normalizes non-Realtime preferences and formats transcript output", () => {
    expect(
      normalizeRealtimeCaptionsPreferences(
        {
          ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
          inputAudioFormat: "pcmu",
          turnDetection: "manual",
          showAssistantTranscript: true,
        },
        "mimo_chat_audio",
      ),
    ).toMatchObject({
      inputAudioFormat: "pcm16",
      turnDetection: "server_vad",
      showAssistantTranscript: false,
    });

    const lines = [
      createRealtimeCaptionLine({
        id: "line_1",
        role: "user",
        text: "hello",
        startedAtMs: 0,
        endedAtMs: 1250,
      }),
    ];
    expect(formatRealtimeCaptionLines(lines, "txt")).toBe("hello");
    expect(formatRealtimeCaptionLines(lines, "srt")).toContain(
      "00:00:00,000 --> 00:00:01,250",
    );
  });
});
