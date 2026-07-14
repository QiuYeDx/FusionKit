import { describe, expect, it } from "vitest";
import type { AudioApiProfile, AudioTaskAssignment } from "@/type/audio";
import {
  DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
  buildRealtimeCaptionsSessionConfig,
  createRealtimeCaptionLine,
  formatRealtimeCaptionLines,
  getRealtimeCaptionsRouteIdentity,
  normalizeRealtimeCaptionsPreferences,
  resolveRealtimeCaptionsConfigSummary,
} from "./realtimeCaptionsConfig";

const EMPTY_ASSIGNMENT: AudioTaskAssignment = {
  transcription: null,
  speechSynthesis: null,
  realtimeCaptions: null,
  realtimeVoice: null,
};

describe("realtime captions config helpers", () => {
  it("resolves OpenAI Realtime fields from the complete standalone route", () => {
    const profile = createProfile({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "gpt-realtime-whisper",
    });
    const summary = resolveRealtimeCaptionsConfigSummary({
      profiles: [profile],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeCaptions: profile.id },
    });

    expect(summary).toMatchObject({
      status: "ready",
      profileId: profile.id,
      providerPreset: "openai",
      audioDialect: "openai_realtime",
      modelKey: "gpt-realtime-whisper",
      mode: "openai_realtime",
      inputAudioFormats: ["pcm16", "pcmu", "pcma"],
    });
    expect(summary.languages).toEqual([
      "auto",
      "zh",
      "en",
      "ja",
      "ko",
      "fr",
      "de",
      "es",
    ]);

    const request = buildRealtimeCaptionsSessionConfig(
      {
        ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
        language: "zh",
        instructions: "Must not be sent by this route.",
        inputAudioFormat: "pcmu",
        turnDetection: "manual",
      },
      summary.constraints!,
    );
    expect(request).toEqual({
      assignmentKey: "realtimeCaptions",
      mode: "caption",
      language: "zh",
      inputAudioFormat: "pcmu",
      turnDetection: "server_vad",
    });
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("baseUrl");
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("transport");
  });

  it("derives MiMo chunk mode and language options from its ASR route", () => {
    const profile = createProfile({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
    });
    const summary = resolveRealtimeCaptionsConfigSummary({
      profiles: [profile],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeCaptions: profile.id },
    });

    expect(summary).toMatchObject({
      status: "ready",
      mode: "chunked_near_realtime",
      languages: ["auto", "zh", "en"],
      inputAudioFormats: [],
    });
    expect(normalizeRealtimeCaptionsPreferences(
      {
        ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
        language: "ja",
        inputAudioFormat: "pcma",
        showAssistantTranscript: true,
      },
      summary.constraints,
    )).toMatchObject({
      language: "auto",
      inputAudioFormat: "pcm16",
      turnDetection: "server_vad",
      showAssistantTranscript: false,
    });
  });

  it("fails closed for missing, disabled, mismatched, and unknown built-in routes", () => {
    expect(resolveRealtimeCaptionsConfigSummary({
      profiles: [],
      assignment: EMPTY_ASSIGNMENT,
    })).toMatchObject({
      status: "audio_api_not_configured",
      mode: "unsupported",
    });

    const unknown = createProfile({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "unknown-realtime-model",
    });
    expect(resolveRealtimeCaptionsConfigSummary({
      profiles: [unknown],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeCaptions: unknown.id },
    })).toMatchObject({
      status: "audio_route_not_configured",
      mode: "unsupported",
    });

    const mismatched = createProfile({
      providerPreset: "mimo",
      transport: "openai_realtime",
      model: "mimo-v2.5-asr",
    });
    expect(resolveRealtimeCaptionsConfigSummary({
      profiles: [mismatched],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeCaptions: mismatched.id },
    }).status).toBe("audio_route_not_configured");

    const disabled = createProfile({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
      enabled: false,
    });
    expect(resolveRealtimeCaptionsConfigSummary({
      profiles: [disabled],
      assignment: { ...EMPTY_ASSIGNMENT, realtimeCaptions: disabled.id },
    }).status).toBe("audio_route_not_configured");
  });

  it("changes route identity when the trusted route changes", () => {
    const first = createProfile({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "gpt-realtime-whisper",
    });
    const second = {
      ...first,
      routes: {
        ...first.routes,
        realtimeCaptions: {
          ...first.routes.realtimeCaptions!,
          model: "gpt-realtime-whisper-2026-07-01",
        },
      },
    };
    const assignment = { ...EMPTY_ASSIGNMENT, realtimeCaptions: first.id };
    const firstIdentity = getRealtimeCaptionsRouteIdentity(
      resolveRealtimeCaptionsConfigSummary({ profiles: [first], assignment }),
    );
    const secondIdentity = getRealtimeCaptionsRouteIdentity(
      resolveRealtimeCaptionsConfigSummary({ profiles: [second], assignment }),
    );

    expect(secondIdentity).not.toBe(firstIdentity);
  });

  it("formats transcript output", () => {
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

function createProfile(options: {
  providerPreset: AudioApiProfile["providerPreset"];
  transport: NonNullable<
    AudioApiProfile["routes"]["realtimeCaptions"]
  >["transport"];
  model: string;
  enabled?: boolean;
}): AudioApiProfile {
  return {
    id: "captions_profile",
    name: "Captions API",
    providerPreset: options.providerPreset,
    baseUrl: "https://audio.example.test/v1",
    apiKey: "secret",
    routes: {
      speechSynthesis: {},
      realtimeCaptions: {
        transport: options.transport,
        model: options.model,
        enabled: options.enabled ?? true,
      },
    },
  };
}
