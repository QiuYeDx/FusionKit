import { describe, expect, it } from "vitest";
import {
  DEFAULT_REALTIME_VOICE_PREFERENCES,
  buildRealtimeVoiceSessionConfig,
  canStartRealtimeVoice,
  createRealtimeVoiceLine,
  getRealtimeVoiceCloseStatus,
} from "./realtimeVoiceConfig";

describe("realtime voice config helpers", () => {
  it("builds duplex voice session requests without API config fields", () => {
    const request = buildRealtimeVoiceSessionConfig({
      ...DEFAULT_REALTIME_VOICE_PREFERENCES,
      voice: "marin",
      instructions: "Answer briefly.",
      inputAudioFormat: "opus",
      outputAudioFormat: "pcm16",
    });

    expect(request).toEqual({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
      voice: "marin",
      instructions: "Answer briefly.",
      turnDetection: "server_vad",
      inputAudioFormat: "opus",
      outputAudioFormat: "pcm16",
    });
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("modelKey");
  });

  it("only enables OpenAI realtime duplex profiles", () => {
    expect(canStartRealtimeVoice("openai_realtime", [
      "realtime_duplex_voice",
    ])).toBe(true);
    expect(canStartRealtimeVoice("mimo_chat_audio", [
      "streaming_speech_synthesis",
    ])).toBe(false);
  });

  it("creates lines and maps close status", () => {
    expect(
      createRealtimeVoiceLine({
        role: "assistant",
        text: "hello",
        final: false,
        createdAtMs: 10,
      }),
    ).toMatchObject({
      role: "assistant",
      text: "hello",
      final: false,
      createdAtMs: 10,
    });
    expect(getRealtimeVoiceCloseStatus("error")).toBe("failed");
    expect(getRealtimeVoiceCloseStatus("user")).toBe("completed");
  });
});
