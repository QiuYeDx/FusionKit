import { describe, expect, it } from "vitest";
import type { AudioApiProfile, AudioTaskAssignment } from "@/type/audio";
import {
  DEFAULT_REALTIME_VOICE_PREFERENCES,
  buildRealtimeVoiceSessionConfig,
  createRealtimeVoiceLine,
  getRealtimeVoiceCloseStatus,
  getRealtimeVoiceRouteIdentity,
  normalizeRealtimeVoicePreferences,
  resolveRealtimeVoiceConfigSummary,
} from "./realtimeVoiceConfig";

const EMPTY_ASSIGNMENT: AudioTaskAssignment = {
  transcription: null,
  speechSynthesis: null,
  realtimeCaptions: null,
  realtimeVoice: null,
};

describe("realtime voice config helpers", () => {
  it("resolves OpenAI duplex fields from the complete standalone route", () => {
    const profile = createProfile({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "gpt-realtime",
    });
    const summary = resolveRealtimeVoiceConfigSummary({
      profiles: [profile],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeVoice: profile.id },
    });

    expect(summary).toMatchObject({
      status: "ready",
      profileId: profile.id,
      providerPreset: "openai",
      audioDialect: "openai_realtime",
      modelKey: "gpt-realtime",
      inputAudioFormats: ["pcm16", "pcmu", "pcma"],
      outputAudioFormats: ["pcm16", "pcmu", "pcma"],
      voices: [
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "marin",
        "sage",
        "verse",
      ],
      constraints: {
        mode: "duplex_voice",
        supportsInstructions: true,
        supportsVoice: true,
      },
    });

    const request = buildRealtimeVoiceSessionConfig(
      {
        ...DEFAULT_REALTIME_VOICE_PREFERENCES,
        voice: "unknown-voice",
        instructions: "  Speak concisely.  ",
        turnDetection: "manual",
        inputAudioFormat: "pcmu",
        outputAudioFormat: "pcma",
      },
      summary.constraints!,
    );
    expect(request).toEqual({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
      voice: "marin",
      instructions: "Speak concisely.",
      turnDetection: "server_vad",
      inputAudioFormat: "pcmu",
      outputAudioFormat: "pcma",
    });
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("baseUrl");
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("transport");
    expect(request).not.toHaveProperty("providerPreset");
  });

  it("allows a custom OpenAI-compatible duplex model through shared constraints", () => {
    const profile = createProfile({
      providerPreset: "custom_openai_compatible",
      transport: "openai_realtime",
      model: "vendor-live-voice-v2",
    });
    const summary = resolveRealtimeVoiceConfigSummary({
      profiles: [profile],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeVoice: profile.id },
    });

    expect(summary).toMatchObject({
      status: "ready",
      providerPreset: "custom_openai_compatible",
      modelKey: "vendor-live-voice-v2",
      inputAudioFormats: ["pcm16", "pcmu", "pcma"],
      outputAudioFormats: ["pcm16", "pcmu", "pcma"],
    });
  });

  it("fails closed for missing, disabled, mismatched, and invalid built-in routes", () => {
    expect(resolveRealtimeVoiceConfigSummary({
      profiles: [],
      assignment: EMPTY_ASSIGNMENT,
    })).toMatchObject({
      status: "audio_api_not_configured",
      voices: [],
      inputAudioFormats: [],
      outputAudioFormats: [],
    });

    for (const profile of [
      createProfile({
        providerPreset: "openai",
        transport: "openai_realtime",
        model: "gpt-realtime-whisper",
      }),
      createProfile({
        providerPreset: "mimo",
        transport: "mimo_chat_audio",
        model: "mimo-v2.5-asr",
      }),
      createProfile({
        providerPreset: "openai",
        transport: "openai_realtime",
        model: "gpt-realtime",
        enabled: false,
      }),
    ]) {
      expect(resolveRealtimeVoiceConfigSummary({
        profiles: [profile],
        assignment: { ...EMPTY_ASSIGNMENT, realtimeVoice: profile.id },
      })).toMatchObject({
        status: "audio_route_not_configured",
        voices: [],
      });
    }
  });

  it("normalizes preferences against route constraints", () => {
    const summary = resolveRealtimeVoiceConfigSummary({
      profiles: [createProfile({
        providerPreset: "openai",
        transport: "openai_realtime",
        model: "gpt-realtime",
      })],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        realtimeVoice: "voice_profile",
      },
    });

    expect(normalizeRealtimeVoicePreferences(
      {
        ...DEFAULT_REALTIME_VOICE_PREFERENCES,
        voice: "not-allowed",
        turnDetection: "manual",
      },
      summary.constraints,
    )).toMatchObject({
      voice: "marin",
      turnDetection: "server_vad",
    });
  });

  it("changes route identity with the trusted route and keeps line helpers", () => {
    const first = createProfile({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "gpt-realtime",
    });
    const second = {
      ...first,
      routes: {
        ...first.routes,
        realtimeVoice: {
          ...first.routes.realtimeVoice!,
          model: "gpt-realtime-2026-07-01",
        },
      },
    };
    const assignment = { ...EMPTY_ASSIGNMENT, realtimeVoice: first.id };
    expect(getRealtimeVoiceRouteIdentity(
      resolveRealtimeVoiceConfigSummary({ profiles: [second], assignment }),
    )).not.toBe(getRealtimeVoiceRouteIdentity(
      resolveRealtimeVoiceConfigSummary({ profiles: [first], assignment }),
    ));

    expect(createRealtimeVoiceLine({
      id: "line_1",
      role: "assistant",
      text: "hello",
      createdAtMs: 10,
    })).toEqual({
      id: "line_1",
      role: "assistant",
      text: "hello",
      final: true,
      createdAtMs: 10,
    });
    expect(getRealtimeVoiceCloseStatus("error")).toBe("failed");
    expect(getRealtimeVoiceCloseStatus("user")).toBe("completed");
  });
});

function createProfile(options: {
  providerPreset: AudioApiProfile["providerPreset"];
  transport: NonNullable<
    AudioApiProfile["routes"]["realtimeVoice"]
  >["transport"];
  model: string;
  enabled?: boolean;
}): AudioApiProfile {
  return {
    id: "voice_profile",
    name: "Voice API",
    providerPreset: options.providerPreset,
    baseUrl: "https://audio.example.test/v1",
    apiKey: "secret",
    routes: {
      speechSynthesis: {},
      realtimeVoice: {
        transport: options.transport,
        model: options.model,
        enabled: options.enabled ?? true,
      },
    },
  };
}
