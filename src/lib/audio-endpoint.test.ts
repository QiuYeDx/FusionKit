import { describe, expect, it } from "vitest";
import { normalizeAudioEndpoint } from "./audio-endpoint";

describe("normalizeAudioEndpoint", () => {
  it("derives every audio endpoint from a base URL", () => {
    expect(normalizeAudioEndpoint("https://api.openai.com/v1")).toEqual({
      baseUrl: "https://api.openai.com/v1",
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
      audioSpeechUrl: "https://api.openai.com/v1/audio/speech",
      audioTranscriptionsUrl: "https://api.openai.com/v1/audio/transcriptions",
      realtimeClientSecretsUrl:
        "https://api.openai.com/v1/realtime/client_secrets",
      realtimeCallsUrl: "https://api.openai.com/v1/realtime/calls",
      modelsUrl: "https://api.openai.com/v1/models",
      originalInput: "https://api.openai.com/v1",
      detectedInputKind: "base_url",
    });
  });

  it("normalizes OpenAI audio speech full endpoint input", () => {
    expect(
      normalizeAudioEndpoint("https://api.openai.com/v1/audio/speech"),
    ).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      audioSpeechUrl: "https://api.openai.com/v1/audio/speech",
      detectedInputKind: "audio_speech_endpoint",
    });
  });

  it("normalizes OpenAI audio transcription full endpoint input", () => {
    expect(
      normalizeAudioEndpoint(
        "https://api.openai.com/v1/audio/transcriptions",
      ),
    ).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      audioTranscriptionsUrl: "https://api.openai.com/v1/audio/transcriptions",
      detectedInputKind: "audio_transcriptions_endpoint",
    });
  });

  it("normalizes MiMo chat completions full endpoint input", () => {
    expect(
      normalizeAudioEndpoint(
        "https://api.xiaomimimo.com/v1/chat/completions",
      ),
    ).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      chatCompletionsUrl:
        "https://api.xiaomimimo.com/v1/chat/completions",
      detectedInputKind: "chat_completions_endpoint",
    });
  });

  it("normalizes realtime and models full endpoint inputs", () => {
    expect(
      normalizeAudioEndpoint(
        " https://api.openai.com/v1/realtime/client_secrets/// ",
      ),
    ).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      realtimeClientSecretsUrl:
        "https://api.openai.com/v1/realtime/client_secrets",
      originalInput:
        " https://api.openai.com/v1/realtime/client_secrets/// ",
      detectedInputKind: "realtime_client_secrets_endpoint",
    });

    expect(
      normalizeAudioEndpoint("https://api.openai.com/v1/models"),
    ).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      modelsUrl: "https://api.openai.com/v1/models",
      detectedInputKind: "models_endpoint",
    });
  });

  it("keeps empty and unrelated URL paths stable", () => {
    expect(normalizeAudioEndpoint("   ")).toEqual({
      baseUrl: "",
      chatCompletionsUrl: "",
      audioSpeechUrl: "",
      audioTranscriptionsUrl: "",
      realtimeClientSecretsUrl: "",
      realtimeCallsUrl: "",
      modelsUrl: "",
      originalInput: "   ",
      detectedInputKind: "base_url",
    });

    expect(
      normalizeAudioEndpoint("https://provider.example/openai-compatible"),
    ).toMatchObject({
      baseUrl: "https://provider.example/openai-compatible",
      audioSpeechUrl:
        "https://provider.example/openai-compatible/audio/speech",
      detectedInputKind: "base_url",
    });
  });
});
