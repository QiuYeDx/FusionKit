import { describe, expect, it } from "vitest";
import {
  canAssignAudioProfileToTask,
  clearAudioProfileFromAssignment,
  filterAudioProfilesByConnectionIds,
  isConnectionProfileReferencedByAudioProfile,
  migrateAudioModelProfiles,
  normalizeAudioModelAssignment,
  normalizeAudioModelProfileForRuntime,
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
    const normalized = normalizeAudioModelProfileForRuntime(
      createProfile({
        id: "audio_mimo",
        audioDialect: "mimo_chat_audio",
        capabilities: [],
      }),
    );

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

  it("filters profiles by live connection profile ids and normalizes assignments", () => {
    const live = createProfile({ id: "audio_live", connectionProfileId: "conn_live" });
    const stale = createProfile({
      id: "audio_stale",
      connectionProfileId: "conn_deleted",
    });
    const filtered = filterAudioProfilesByConnectionIds(
      [live, stale],
      new Set(["conn_live"]),
    );

    expect(filtered).toEqual([live]);
    expect(
      normalizeAudioModelAssignment(
        {
          transcription: "audio_live",
          speechSynthesis: "audio_stale",
          realtimeCaptions: 42,
          realtimeVoice: "audio_live",
        },
        new Set(["audio_live"]),
      ),
    ).toEqual({
      transcription: "audio_live",
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: "audio_live",
    });
  });

  it("clears removed audio profiles from every assignment", () => {
    expect(
      clearAudioProfileFromAssignment(
        {
          transcription: "audio_old",
          speechSynthesis: "audio_other",
          realtimeCaptions: "audio_old",
          realtimeVoice: "audio_old",
        },
        "audio_old",
      ),
    ).toEqual({
      transcription: null,
      speechSynthesis: "audio_other",
      realtimeCaptions: null,
      realtimeVoice: null,
    });
  });

  it("detects connection profile references and assignment eligibility", () => {
    const speechOnly = createProfile({
      capabilities: ["speech_synthesis"],
      models: {
        speechSynthesis: "gpt-4o-mini-tts",
      },
    });

    expect(
      isConnectionProfileReferencedByAudioProfile(
        [speechOnly],
        "conn_openai",
      ),
    ).toBe(true);
    expect(canAssignAudioProfileToTask(speechOnly, "speechSynthesis")).toBe(true);
    expect(canAssignAudioProfileToTask(speechOnly, "transcription")).toBe(false);
  });
});
