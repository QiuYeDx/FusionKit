import { describe, expect, it } from "vitest";
import type {
  AudioApiProfile,
  AudioTaskAssignment,
} from "@/type/audio";
import {
  createStandaloneAudioToolConfigSummarySelector,
  MIMO_VOICE_PRESETS,
  resolveStandaloneAudioToolConfigSummary,
} from "./audioToolConfig";

describe("audioToolConfig", () => {
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
