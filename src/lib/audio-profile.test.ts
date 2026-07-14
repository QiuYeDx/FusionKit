import { describe, expect, it } from "vitest";
import {
  migrateAudioModelProfiles,
  normalizeAudioModelAssignment,
} from "./audio-profile";
import type { AudioModelProfile } from "@/type/audio";

function createProfile(
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

describe("audio profile helpers", () => {
  it("normalizes empty capabilities to dialect defaults", () => {
    const [normalized] = migrateAudioModelProfiles([
      createProfile({
        id: "audio_mimo",
        audioDialect: "mimo_chat_audio",
        capabilities: [],
      }),
    ]);

    expect(normalized.capabilities).toContain("mimo_voice_design");
    expect(normalized.capabilities).toContain("streaming_speech_synthesis");
  });

  it("migrates valid persisted profiles and drops malformed entries", () => {
    const migrated = migrateAudioModelProfiles([
      {
        id: "audio_openai",
        name: "OpenAI Audio",
        connectionProfileId: "conn_openai",
        audioDialect: "openai_audio",
        capabilities: ["speech_synthesis", "unknown"],
        models: {
          speechSynthesis: " gpt-4o-mini-tts ",
        },
        defaults: {
          ttsResponseFormat: "wav",
          streamSpeechByDefault: true,
          mimoTtsMode: "invalid",
        },
      },
      {
        id: "broken_missing_connection",
        name: "Broken",
        audioDialect: "openai_audio",
      },
    ]);

    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      id: "audio_openai",
      capabilities: ["speech_synthesis"],
      models: {
        speechSynthesis: "gpt-4o-mini-tts",
      },
      defaults: {
        ttsResponseFormat: "wav",
        streamSpeechByDefault: true,
      },
    });
    expect(migrated[0].defaults).not.toHaveProperty("mimoTtsMode");
  });

  it("normalizes assignments against retained legacy audio profile ids", () => {
    expect(
      normalizeAudioModelAssignment(
        {
          transcription: "audio_live",
          speechSynthesis: "audio_stale",
          realtimeCaptions: 42,
          realtimeVoice: "audio_missing",
        },
        new Set(["audio_live", "audio_stale"]),
      ),
    ).toEqual({
      transcription: "audio_live",
      speechSynthesis: "audio_stale",
      realtimeCaptions: null,
      realtimeVoice: null,
    });
  });
});
