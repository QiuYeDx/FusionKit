import { describe, expect, it } from "vitest";
import { Model } from "@/type/model";
import type { AudioModelProfile } from "@/type/audio";
import {
  getDefaultAudioCapabilities,
  resolveAudioCapabilities,
  resolveAudioRuntimeModelConfig,
  validateAudioCapability,
} from "@/type/audio";

function createAudioProfile(
  overrides: Partial<AudioModelProfile> = {},
): AudioModelProfile {
  return {
    id: "audio_openai",
    name: "OpenAI Audio",
    connectionProfileId: "conn_openai",
    audioDialect: "openai_audio",
    capabilities: [],
    models: {
      transcription: "gpt-4o-transcribe",
      speechSynthesis: "gpt-4o-mini-tts",
      realtime: "gpt-realtime",
    },
    defaults: {},
    ...overrides,
  };
}

describe("audio capability matrix", () => {
  it("resolves conservative default capabilities per dialect", () => {
    expect(getDefaultAudioCapabilities("openai_audio")).toEqual([
      "file_transcription",
      "streaming_transcription",
      "speech_synthesis",
      "streaming_speech_synthesis",
    ]);
    expect(getDefaultAudioCapabilities("mimo_chat_audio")).toContain(
      "mimo_voice_clone",
    );
    expect(getDefaultAudioCapabilities("openai_realtime")).toEqual([
      "realtime_transcription",
      "realtime_duplex_voice",
    ]);
  });

  it("uses explicit profile capabilities when provided", () => {
    const profile = createAudioProfile({
      capabilities: ["speech_synthesis", "speech_synthesis"],
    });

    expect(resolveAudioCapabilities(profile)).toEqual(["speech_synthesis"]);
  });

  it("allows MiMo for speech and chunked captions but not WebRTC duplex voice", () => {
    const mimo = createAudioProfile({
      id: "audio_mimo",
      audioDialect: "mimo_chat_audio",
      capabilities: getDefaultAudioCapabilities("mimo_chat_audio"),
      models: {
        transcription: "mimo-v2.5-asr",
        speechSynthesis: "mimo-v2.5-tts",
      },
    });

    expect(validateAudioCapability(mimo, "speechSynthesis").ok).toBe(true);
    expect(validateAudioCapability(mimo, "realtimeCaptions").ok).toBe(true);

    const voice = validateAudioCapability(mimo, "realtimeVoice");
    expect(voice.ok).toBe(false);
    if (!voice.ok) {
      expect(voice.issue.code).toBe("unsupported_audio_capability");
      expect(voice.issue.missingCapabilities).toEqual(["realtime_duplex_voice"]);
    }
  });

  it("allows OpenAI Realtime for duplex voice but not file speech synthesis", () => {
    const realtime = createAudioProfile({
      audioDialect: "openai_realtime",
      capabilities: getDefaultAudioCapabilities("openai_realtime"),
      models: {
        realtime: "gpt-realtime",
      },
    });

    expect(validateAudioCapability(realtime, "realtimeVoice").ok).toBe(true);

    const speech = validateAudioCapability(realtime, "speechSynthesis");
    expect(speech.ok).toBe(false);
    if (!speech.ok) {
      expect(speech.issue.missingCapabilities).toEqual(["speech_synthesis"]);
    }
  });

  it("resolves runtime model config from global audio and connection profiles", () => {
    const audioProfile = createAudioProfile({
      id: "audio_task",
      connectionProfileId: "conn_openai",
      models: {
        transcription: "gpt-4o-transcribe",
        speechSynthesis: "gpt-4o-mini-tts",
        realtime: "gpt-realtime",
      },
    });

    const result = resolveAudioRuntimeModelConfig({
      audioProfile,
      connectionProfile: {
        id: "conn_openai",
        provider: Model.OpenAI,
        apiKey: "sk-runtime-only",
        baseUrl: "https://api.openai.com/v1",
      },
      assignmentKey: "speechSynthesis",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toMatchObject({
        audioProfileId: "audio_task",
        connectionProfileId: "conn_openai",
        provider: Model.OpenAI,
        modelKey: "gpt-4o-mini-tts",
        audioDialect: "openai_audio",
      });
      expect(result.config.apiKey).toBe("sk-runtime-only");
    }
  });

  it("reports missing global profile, connection profile, or assignment model", () => {
    const missingProfile = resolveAudioRuntimeModelConfig({
      audioProfile: null,
      connectionProfile: null,
      assignmentKey: "transcription",
    });
    expect(missingProfile.ok).toBe(false);
    if (!missingProfile.ok) {
      expect(missingProfile.issue.code).toBe("audio_profile_not_configured");
    }

    const missingConnection = resolveAudioRuntimeModelConfig({
      audioProfile: createAudioProfile(),
      connectionProfile: null,
      assignmentKey: "transcription",
    });
    expect(missingConnection.ok).toBe(false);
    if (!missingConnection.ok) {
      expect(missingConnection.issue.code).toBe("connection_profile_not_configured");
    }

    const missingModel = resolveAudioRuntimeModelConfig({
      audioProfile: createAudioProfile({
        models: {
          transcription: "",
        },
      }),
      connectionProfile: {
        id: "conn_openai",
        provider: Model.OpenAI,
        apiKey: "sk-runtime-only",
        baseUrl: "https://api.openai.com/v1",
      },
      assignmentKey: "transcription",
    });
    expect(missingModel.ok).toBe(false);
    if (!missingModel.ok) {
      expect(missingModel.issue.code).toBe("audio_model_not_configured");
    }
  });
});
