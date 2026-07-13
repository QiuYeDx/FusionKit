import type {
  AudioApiProfile,
  AudioTaskAssignment,
} from "@/type/audio";

export interface LegacyAudioMigrationFixture {
  source: {
    version: 4 | 5;
    state: {
      profiles: unknown[];
      assignment: unknown;
      audioProfiles: unknown[];
      audioAssignment: unknown;
    };
  };
  existingTarget?: {
    profiles: AudioApiProfile[];
    assignment: AudioTaskAssignment;
  };
  expected: {
    profiles: AudioApiProfile[];
    assignment: AudioTaskAssignment;
  };
}

const EMPTY_ASSIGNMENT: AudioTaskAssignment = {
  transcription: null,
  speechSynthesis: null,
  realtimeCaptions: null,
  realtimeVoice: null,
};

const OPENAI_CONNECTION = {
  id: "connection_openai",
  name: "OpenAI",
  provider: "OpenAI",
  apiKey: "fixture-openai-key",
  baseUrl: "https://api.openai.com/v1/responses?trace=1",
  modelKey: "gpt-5",
  tokenPricing: {
    inputTokensPerMillion: 1,
    outputTokensPerMillion: 1,
  },
  apiFormat: "responses",
};

const MIMO_CONNECTION = {
  id: "connection_mimo",
  name: "MiMo",
  provider: "Other",
  apiKey: "fixture-mimo-key",
  baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  modelKey: "unused-text-model",
  tokenPricing: {
    inputTokensPerMillion: 0,
    outputTokensPerMillion: 0,
  },
  apiFormat: "chat_completions",
};

export const LEGACY_AUDIO_MIGRATION_FIXTURES = {
  textOnly: {
    source: source({ profiles: [OPENAI_CONNECTION] }),
    expected: {
      profiles: [],
      assignment: { ...EMPTY_ASSIGNMENT },
    },
  },
  openAiFileAudio: {
    source: source({
      profiles: [OPENAI_CONNECTION],
      audioProfiles: [
        legacyAudioProfile({
          id: "audio_openai",
          name: "OpenAI Audio",
          connectionProfileId: OPENAI_CONNECTION.id,
          audioDialect: "openai_audio",
          models: {
            transcription: "gpt-4o-transcribe",
            speechSynthesis: "gpt-4o-mini-tts",
          },
        }),
      ],
      audioAssignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_openai",
        speechSynthesis: "audio_openai",
      },
    }),
    expected: {
      profiles: [
        {
          id: "audio_openai",
          name: "OpenAI Audio",
          providerPreset: "openai",
          apiKey: "fixture-openai-key",
          baseUrl: "https://api.openai.com/v1",
          routes: {
            transcription: {
              transport: "openai_audio",
              model: "gpt-4o-transcribe",
              enabled: true,
            },
            speechSynthesis: {
              preset_voice: {
                transport: "openai_audio",
                model: "gpt-4o-mini-tts",
                enabled: true,
              },
            },
          },
          migration: {
            source: "legacy_audio_profile",
            sourceId: "audio_openai",
          },
        },
      ],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_openai",
        speechSynthesis: "audio_openai",
      },
    },
  },
  sharedMimoConnection: {
    source: source({
      profiles: [MIMO_CONNECTION],
      audioProfiles: [
        legacyAudioProfile({
          id: "audio_mimo_known",
          name: "MiMo Known",
          connectionProfileId: MIMO_CONNECTION.id,
          audioDialect: "mimo_chat_audio",
          models: {
            transcription: "mimo-v2.5-asr",
            speechSynthesis: "mimo-v2.5-tts",
          },
          defaults: { mimoTtsMode: "voice_clone" },
        }),
        legacyAudioProfile({
          id: "audio_mimo_custom",
          name: "MiMo Custom",
          connectionProfileId: MIMO_CONNECTION.id,
          audioDialect: "mimo_chat_audio",
          models: { speechSynthesis: "mimo-custom-clone" },
          defaults: { mimoTtsMode: "voice_clone" },
        }),
      ],
      audioAssignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_mimo_known",
        speechSynthesis: "audio_mimo_custom",
      },
    }),
    expected: {
      profiles: [
        expectedMimoProfile({
          id: "audio_mimo_known",
          name: "MiMo Known",
          includeTranscription: true,
        }),
        expectedMimoProfile({
          id: "audio_mimo_custom",
          name: "MiMo Custom",
          voiceCloneModel: "mimo-custom-clone",
          needsAttention: true,
        }),
      ],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_mimo_known",
        speechSynthesis: "audio_mimo_custom",
      },
    },
  },
  missingConnectionAndRealtimeFallback: {
    source: source({
      version: 4,
      profiles: [OPENAI_CONNECTION],
      audioProfiles: [
        legacyAudioProfile({
          id: "audio_missing_connection",
          name: "Missing Connection",
          connectionProfileId: "connection_deleted",
          audioDialect: "mimo_chat_audio",
          models: { speechSynthesis: "mimo-v2.5-tts-voicedesign" },
          defaults: { mimoTtsMode: "voice_design" },
        }),
        legacyAudioProfile({
          id: "audio_realtime_legacy",
          name: "Realtime Legacy",
          connectionProfileId: OPENAI_CONNECTION.id,
          audioDialect: "openai_realtime",
          models: { realtime: "gpt-realtime-legacy" },
        }),
      ],
      audioAssignment: {
        transcription: null,
        speechSynthesis: "audio_missing_connection",
        realtimeCaptions: "audio_realtime_legacy",
        realtimeVoice: "audio_realtime_legacy",
      },
    }),
    expected: {
      profiles: [
        expectedMimoProfile({
          id: "audio_missing_connection",
          name: "Missing Connection",
          apiKey: "",
          baseUrl: "",
          needsAttention: true,
        }),
        {
          id: "audio_realtime_legacy",
          name: "Realtime Legacy",
          providerPreset: "openai",
          apiKey: "fixture-openai-key",
          baseUrl: "https://api.openai.com/v1",
          routes: {
            speechSynthesis: {},
            realtimeCaptions: {
              transport: "openai_realtime",
              model: "gpt-realtime-legacy",
              enabled: true,
            },
            realtimeVoice: {
              transport: "openai_realtime",
              model: "gpt-realtime-legacy",
              enabled: true,
            },
          },
          migration: {
            source: "legacy_audio_profile",
            sourceId: "audio_realtime_legacy",
          },
        },
      ],
      assignment: {
        transcription: null,
        speechSynthesis: "audio_missing_connection",
        realtimeCaptions: "audio_realtime_legacy",
        realtimeVoice: "audio_realtime_legacy",
      },
    },
  },
  idempotentExistingTarget: {
    source: source({
      profiles: [MIMO_CONNECTION],
      audioProfiles: [
        legacyAudioProfile({
          id: "audio_mimo_known",
          name: "MiMo Known",
          connectionProfileId: MIMO_CONNECTION.id,
          audioDialect: "mimo_chat_audio",
          models: { speechSynthesis: "mimo-v2.5-tts" },
        }),
      ],
      audioAssignment: {
        ...EMPTY_ASSIGNMENT,
        speechSynthesis: "audio_mimo_known",
      },
    }),
    existingTarget: {
      profiles: [
        expectedMimoProfile({
          id: "audio_mimo_known",
          name: "MiMo Known",
        }),
        {
          id: "audio_manual",
          name: "Manual custom API",
          providerPreset: "custom_openai_compatible",
          apiKey: "manual-key",
          baseUrl: "https://audio.example/v1",
          routes: { speechSynthesis: {} },
        },
      ],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        speechSynthesis: "audio_mimo_known",
      },
    },
    expected: {
      profiles: [
        expectedMimoProfile({
          id: "audio_mimo_known",
          name: "MiMo Known",
        }),
        {
          id: "audio_manual",
          name: "Manual custom API",
          providerPreset: "custom_openai_compatible",
          apiKey: "manual-key",
          baseUrl: "https://audio.example/v1",
          routes: { speechSynthesis: {} },
        },
      ],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        speechSynthesis: "audio_mimo_known",
      },
    },
  },
  assignmentNeedsAttention: {
    source: source({
      profiles: [OPENAI_CONNECTION],
      audioProfiles: [
        legacyAudioProfile({
          id: "audio_speech_only",
          name: "Speech only",
          connectionProfileId: OPENAI_CONNECTION.id,
          audioDialect: "openai_audio",
          models: { speechSynthesis: "gpt-4o-mini-tts" },
        }),
      ],
      audioAssignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_speech_only",
      },
    }),
    expected: {
      profiles: [
        {
          id: "audio_speech_only",
          name: "Speech only",
          providerPreset: "openai",
          apiKey: "fixture-openai-key",
          baseUrl: "https://api.openai.com/v1",
          routes: {
            speechSynthesis: {
              preset_voice: {
                transport: "openai_audio",
                model: "gpt-4o-mini-tts",
                enabled: true,
              },
            },
          },
          migration: {
            source: "legacy_audio_profile",
            sourceId: "audio_speech_only",
            needsAttention: true,
          },
        },
      ],
      assignment: {
        ...EMPTY_ASSIGNMENT,
        transcription: "audio_speech_only",
      },
    },
  },
} satisfies Record<string, LegacyAudioMigrationFixture>;

function source(options: {
  version?: 4 | 5;
  profiles?: unknown[];
  audioProfiles?: unknown[];
  audioAssignment?: AudioTaskAssignment;
}): LegacyAudioMigrationFixture["source"] {
  return {
    version: options.version ?? 5,
    state: {
      profiles: options.profiles ?? [],
      assignment: { agent: null, taskExecution: null },
      audioProfiles: options.audioProfiles ?? [],
      audioAssignment: options.audioAssignment ?? { ...EMPTY_ASSIGNMENT },
    },
  };
}

function legacyAudioProfile(options: {
  id: string;
  name: string;
  connectionProfileId: string;
  audioDialect: "openai_audio" | "mimo_chat_audio" | "openai_realtime";
  models: Record<string, string>;
  defaults?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...options,
    capabilities: [],
    defaults: options.defaults ?? {},
  };
}

function expectedMimoProfile(options: {
  id: string;
  name: string;
  includeTranscription?: boolean;
  voiceCloneModel?: string;
  needsAttention?: boolean;
  apiKey?: string;
  baseUrl?: string;
}): AudioApiProfile {
  return {
    id: options.id,
    name: options.name,
    providerPreset: "mimo",
    apiKey: options.apiKey ?? "fixture-mimo-key",
    baseUrl: options.baseUrl ?? "https://api.xiaomimimo.com/v1",
    routes: {
      ...(options.includeTranscription
        ? {
            transcription: {
              transport: "mimo_chat_audio" as const,
              model: "mimo-v2.5-asr",
              enabled: true,
            },
            realtimeCaptions: {
              transport: "mimo_chat_audio" as const,
              model: "mimo-v2.5-asr",
              enabled: true,
            },
          }
        : {}),
      speechSynthesis: {
        preset_voice: {
          transport: "mimo_chat_audio",
          model: "mimo-v2.5-tts",
          enabled: true,
        },
        voice_design: {
          transport: "mimo_chat_audio",
          model: "mimo-v2.5-tts-voicedesign",
          enabled: true,
        },
        voice_clone: {
          transport: "mimo_chat_audio",
          model: options.voiceCloneModel ?? "mimo-v2.5-tts-voiceclone",
          enabled: true,
        },
      },
    },
    migration: {
      source: "legacy_audio_profile",
      sourceId: options.id,
      ...(options.needsAttention ? { needsAttention: true } : {}),
    },
  };
}
