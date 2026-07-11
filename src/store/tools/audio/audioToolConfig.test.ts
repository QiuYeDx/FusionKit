import { describe, expect, it } from "vitest";
import { Model } from "@/type/model";
import type {
  AudioModelAssignment,
  AudioModelProfile,
} from "@/type/audio";
import type { ModelProfile } from "@/type/model";
import {
  createAudioToolConfigSummarySelector,
  MIMO_VOICE_PRESETS,
  resolveAudioToolConfigSummary,
} from "./audioToolConfig";

describe("audioToolConfig", () => {
  it("resolves ready global audio assignment summaries without API keys", () => {
    const summary = resolveAudioToolConfigSummary(
      createState({
        audioProfiles: [
          {
            id: "audio_openai",
            name: "OpenAI Audio",
            connectionProfileId: "profile_openai",
            audioDialect: "openai_audio",
            capabilities: [
              "file_transcription",
              "speech_synthesis",
            ],
            models: {
              transcription: "gpt-4o-transcribe",
              speechSynthesis: "gpt-4o-mini-tts",
            },
            defaults: {},
          },
        ],
        audioAssignment: {
          transcription: "audio_openai",
          speechSynthesis: "audio_openai",
          realtimeCaptions: null,
          realtimeVoice: null,
        },
      }),
      "transcription",
    );

    expect(summary).toMatchObject({
      status: "ready",
      profileName: "OpenAI Audio",
      audioDialect: "openai_audio",
      modelKey: "gpt-4o-transcribe",
      connectionProfile: {
        id: "profile_openai",
        name: "OpenAI",
        provider: Model.OpenAI,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("sk-audio-tool");
  });

  it("reports unconfigured, missing model, and unsupported capability states", () => {
    const baseProfile: AudioModelProfile = {
      id: "audio_speech",
      name: "Speech Only",
      connectionProfileId: "profile_openai",
      audioDialect: "openai_audio",
      capabilities: ["speech_synthesis"],
      models: {
        speechSynthesis: "gpt-4o-mini-tts",
      },
      defaults: {},
    };

    expect(
      resolveAudioToolConfigSummary(
        createState({
          audioProfiles: [baseProfile],
          audioAssignment: {
            transcription: null,
            speechSynthesis: "audio_speech",
            realtimeCaptions: null,
            realtimeVoice: null,
          },
        }),
        "transcription",
      ).status,
    ).toBe("profile_not_configured");

    expect(
      resolveAudioToolConfigSummary(
        createState({
          audioProfiles: [
            {
              ...baseProfile,
              capabilities: ["file_transcription"],
            },
          ],
          audioAssignment: {
            transcription: "audio_speech",
            speechSynthesis: null,
            realtimeCaptions: null,
            realtimeVoice: null,
          },
        }),
        "transcription",
      ).status,
    ).toBe("model_missing");

    expect(
      resolveAudioToolConfigSummary(
        createState({
          audioProfiles: [baseProfile],
          audioAssignment: {
            transcription: "audio_speech",
            speechSynthesis: null,
            realtimeCaptions: null,
            realtimeVoice: null,
          },
        }),
        "transcription",
      ).status,
    ).toBe("unsupported_capability");
  });

  it("keeps MiMo voice presets available for speech UI defaults", () => {
    expect(MIMO_VOICE_PRESETS.map((voice) => voice.id)).toEqual(
      expect.arrayContaining([
        "mimo_default",
        "冰糖",
        "Mia",
        "Dean",
      ]),
    );
  });

  it("returns a cached summary for the same external-store snapshot", () => {
    const state = createState({
      audioProfiles: [],
      audioAssignment: {
        transcription: null,
        speechSynthesis: null,
        realtimeCaptions: null,
        realtimeVoice: null,
      },
    });
    const selector = createAudioToolConfigSummarySelector("transcription");

    const firstSummary = selector(state);

    expect(selector(state)).toBe(firstSummary);
    expect(selector({ ...state })).toBe(firstSummary);

    const changedState = {
      ...state,
      audioAssignment: {
        ...state.audioAssignment,
        transcription: "missing-profile",
      },
    };
    const changedSummary = selector(changedState);

    expect(changedSummary).not.toBe(firstSummary);
    expect(selector(changedState)).toBe(changedSummary);
  });
});

function createState(overrides: {
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;
}) {
  return {
    profiles: [
      {
        id: "profile_openai",
        name: "OpenAI",
        provider: Model.OpenAI,
        apiKey: "sk-audio-tool",
        baseUrl: "https://api.openai.com/v1",
        modelKey: "gpt-5",
        tokenPricing: {
          inputTokensPerMillion: 1,
          outputTokensPerMillion: 2,
        },
        apiFormat: "responses",
        outputTokenParameter: "max_completion_tokens",
      } satisfies ModelProfile,
    ],
    ...overrides,
  };
}
