import { describe, expect, it } from "vitest";
import { Model } from "@/type/model";
import type {
  AudioApiProfile,
  AudioModelAssignment,
  AudioModelProfile,
  AudioTaskAssignment,
} from "@/type/audio";
import type { ModelProfile } from "@/type/model";
import {
  createAudioToolConfigSummarySelector,
  createStandaloneAudioToolConfigSummarySelector,
  MIMO_VOICE_PRESETS,
  resolveAudioToolConfigSummary,
  resolveStandaloneAudioToolConfigSummary,
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

  it("resolves standalone routes without exposing API credentials", () => {
    const state = createStandaloneState();
    const summary = resolveStandaloneAudioToolConfigSummary(
      state,
      "transcription",
    );

    expect(summary).toMatchObject({
      assignmentKey: "transcription",
      status: "ready",
      profileId: "standalone_openai",
      profileName: "Standalone OpenAI",
      providerPreset: "openai",
      audioDialect: "openai_audio",
      modelKey: "gpt-4o-transcribe",
      route: {
        transport: "openai_audio",
        model: "gpt-4o-transcribe",
        enabled: true,
      },
      capabilities: ["file_transcription"],
      verificationStatus: "verified",
    });
    expect(JSON.stringify(summary)).not.toMatch(/standalone-secret|apiKey/i);
  });

  it("fails closed for missing, disabled, and incompatible standalone routes", () => {
    const state = createStandaloneState();
    expect(
      resolveStandaloneAudioToolConfigSummary(
        { ...state, assignment: { ...state.assignment, transcription: null } },
        "transcription",
      ).status,
    ).toBe("audio_api_not_configured");

    expect(
      resolveStandaloneAudioToolConfigSummary(
        {
          ...state,
          profiles: state.profiles.map((profile) => ({
            ...profile,
            routes: {
              ...profile.routes,
              transcription: {
                ...profile.routes.transcription!,
                enabled: false,
              },
            },
          })),
        },
        "transcription",
      ).status,
    ).toBe("audio_route_not_configured");

    expect(
      resolveStandaloneAudioToolConfigSummary(
        {
          ...state,
          profiles: state.profiles.map((profile) => ({
            ...profile,
            routes: {
              ...profile.routes,
              transcription: {
                ...profile.routes.transcription!,
                transport: "mimo_chat_audio" as const,
              },
            },
          })),
        },
        "transcription",
      ).status,
    ).toBe("audio_route_not_configured");
  });

  it("treats standalone profiles with incomplete credentials as unconfigured", () => {
    const state = createStandaloneState();

    for (const patch of [{ apiKey: "  " }, { baseUrl: "" }]) {
      const summary = resolveStandaloneAudioToolConfigSummary(
        {
          ...state,
          profiles: state.profiles.map((profile) => ({ ...profile, ...patch })),
        },
        "transcription",
      );

      expect(summary).toMatchObject({
        status: "audio_api_not_configured",
        profileId: "standalone_openai",
        capabilities: [],
      });
    }
  });

  it("keeps standalone summary snapshots referentially stable", () => {
    const state = createStandaloneState();
    const selector = createStandaloneAudioToolConfigSummarySelector(
      "transcription",
    );
    const first = selector(state);

    expect(selector(state)).toBe(first);
    expect(selector({ ...state })).toBe(first);

    const changed = {
      ...state,
      assignment: { ...state.assignment, transcription: null },
    };
    expect(selector(changed)).not.toBe(first);
    expect(selector(changed)).toBe(selector(changed));
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

function createStandaloneState(): {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
} {
  return {
    profiles: [
      {
        id: "standalone_openai",
        name: "Standalone OpenAI",
        providerPreset: "openai",
        apiKey: "standalone-secret",
        baseUrl: "https://api.openai.com/v1",
        routes: {
          transcription: {
            transport: "openai_audio",
            model: "gpt-4o-transcribe",
            enabled: true,
          },
          speechSynthesis: {},
        },
        verification: {
          transcription: { status: "verified" },
        },
      },
    ],
    assignment: {
      transcription: "standalone_openai",
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: null,
    },
  };
}
