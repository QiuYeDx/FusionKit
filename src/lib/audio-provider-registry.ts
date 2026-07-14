import {
  AUDIO_SPEECH_MAX_INPUT_CHARS,
  AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
  SPEECH_SYNTHESIS_MODES,
  type AudioApiProfile,
  type AudioApiRoutes,
  type AudioAssignmentKey,
  type AudioRouteKey,
  type AudioRoute,
  type AudioSpeechResponseFormat,
  type AudioProviderPreset,
  type AudioTranscriptionModelFamily,
  type AudioTranscriptionResponseFormat,
  type AudioTransport,
  type SpeechSynthesisMode,
} from "@/type/audio";

export type AudioEndpointStrategy =
  | "openai_v1"
  | "mimo_v1"
  | "custom_openai_compatible";

export type AudioRouteFieldAvailability =
  | "required"
  | "optional"
  | "unsupported";

export interface AudioTranscriptionRouteConstraints {
  responseFormats: readonly AudioTranscriptionResponseFormat[];
  languages?: readonly string[];
  supportsPrompt: boolean;
  supportsStreaming: boolean;
  supportsTimestampGranularities: boolean;
}

export interface AudioTranscriptionRouteDefinition {
  family: AudioTranscriptionModelFamily;
  constraints: AudioTranscriptionRouteConstraints;
}

export interface AudioSpeechRouteConstraints {
  mode: SpeechSynthesisMode;
  responseFormats: readonly AudioSpeechResponseFormat[];
  supportsStreaming: boolean;
  streamResponseFormat?: AudioSpeechResponseFormat;
  finalResponseFormat?: AudioSpeechResponseFormat;
  inputRequired: boolean;
  maxInputChars: number;
  maxInstructionsChars?: number;
  allowEmptyInputWhenOptimizeTextPreview: boolean;
  fields: {
    voice: AudioRouteFieldAvailability;
    instructions: AudioRouteFieldAvailability;
    speed: AudioRouteFieldAvailability;
    styleInstruction: AudioRouteFieldAvailability;
    voiceDesignPrompt: AudioRouteFieldAvailability;
    optimizeTextPreview: AudioRouteFieldAvailability;
    referenceAudio: AudioRouteFieldAvailability;
    audioTags: AudioRouteFieldAvailability;
  };
}

export interface AudioRealtimeRouteConstraints {
  mode: "caption" | "duplex_voice" | "chunked_near_realtime";
  supportsInstructions: boolean;
  supportsLanguage: boolean;
  supportsVoice: boolean;
  languages?: readonly string[];
  inputAudioFormats?: readonly ("pcm16" | "pcmu" | "pcma")[];
}

export interface AudioRealtimeRouteDefinition {
  constraints: AudioRealtimeRouteConstraints;
}

export interface AudioProviderDefinition {
  preset: AudioProviderPreset;
  defaultBaseUrl: string;
  endpointStrategy: AudioEndpointStrategy;
  routes: AudioApiRoutes;
  constraints: {
    transcription?: AudioTranscriptionRouteConstraints;
    speechSynthesis: Partial<
      Record<SpeechSynthesisMode, AudioSpeechRouteConstraints>
    >;
    realtimeCaptions?: AudioRealtimeRouteConstraints;
    realtimeVoice?: AudioRealtimeRouteConstraints;
  };
}

export const MIMO_TTS_MODEL_BY_MODE: Readonly<
  Record<SpeechSynthesisMode, string>
> = Object.freeze({
  preset_voice: "mimo-v2.5-tts",
  voice_design: "mimo-v2.5-tts-voicedesign",
  voice_clone: "mimo-v2.5-tts-voiceclone",
});

const OPENAI_SPEECH_FORMATS = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
] as const satisfies readonly AudioSpeechResponseFormat[];

const MIMO_SPEECH_FORMATS = [
  "wav",
  "pcm16",
] as const satisfies readonly AudioSpeechResponseFormat[];

const OPENAI_REALTIME_CAPTION_LANGUAGES = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
] as const;

const OPENAI_REALTIME_INPUT_AUDIO_FORMATS = [
  "pcm16",
  "pcmu",
  "pcma",
] as const;

const OPENAI_WHISPER_TRANSCRIPTION_CONSTRAINTS = {
  responseFormats: ["json", "text", "srt", "verbose_json", "vtt"],
  supportsPrompt: true,
  supportsStreaming: false,
  supportsTimestampGranularities: true,
} as const satisfies AudioTranscriptionRouteConstraints;

const AUDIO_PROVIDER_REGISTRY: Record<
  AudioProviderPreset,
  AudioProviderDefinition
> = {
  openai: {
    preset: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    endpointStrategy: "openai_v1",
    routes: {
      transcription: route("openai_audio", "gpt-4o-transcribe"),
      speechSynthesis: {
        preset_voice: route("openai_audio", "gpt-4o-mini-tts"),
      },
      realtimeCaptions: route("openai_realtime", "gpt-realtime-whisper"),
      realtimeVoice: route("openai_realtime", "gpt-realtime"),
    },
    constraints: {
      transcription: {
        responseFormats: ["json"],
        supportsPrompt: true,
        supportsStreaming: true,
        supportsTimestampGranularities: false,
      },
      speechSynthesis: {
        preset_voice: speechConstraints({
          mode: "preset_voice",
          responseFormats: OPENAI_SPEECH_FORMATS,
          maxInputChars: AUDIO_SPEECH_MAX_INPUT_CHARS,
          maxInstructionsChars: AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
          fields: {
            voice: "required",
            instructions: "optional",
            speed: "optional",
          },
        }),
      },
      realtimeCaptions: {
        mode: "caption",
        supportsInstructions: false,
        supportsLanguage: true,
        supportsVoice: false,
        languages: OPENAI_REALTIME_CAPTION_LANGUAGES,
        inputAudioFormats: OPENAI_REALTIME_INPUT_AUDIO_FORMATS,
      },
      realtimeVoice: {
        mode: "duplex_voice",
        supportsInstructions: true,
        supportsLanguage: false,
        supportsVoice: true,
      },
    },
  },
  mimo: {
    preset: "mimo",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    endpointStrategy: "mimo_v1",
    routes: {
      transcription: route("mimo_chat_audio", "mimo-v2.5-asr"),
      speechSynthesis: createMimoSpeechRoutes(),
      realtimeCaptions: route("mimo_chat_audio", "mimo-v2.5-asr"),
    },
    constraints: {
      transcription: {
        responseFormats: ["json", "text"],
        languages: ["auto", "zh", "en"],
        supportsPrompt: false,
        supportsStreaming: true,
        supportsTimestampGranularities: false,
      },
      speechSynthesis: {
        preset_voice: speechConstraints({
          mode: "preset_voice",
          responseFormats: MIMO_SPEECH_FORMATS,
          maxInputChars: AUDIO_SPEECH_MAX_INPUT_CHARS,
          supportsStreaming: true,
          streamResponseFormat: "pcm16",
          finalResponseFormat: "wav",
          fields: {
            voice: "required",
            styleInstruction: "optional",
          },
        }),
        voice_design: speechConstraints({
          mode: "voice_design",
          responseFormats: MIMO_SPEECH_FORMATS,
          maxInputChars: AUDIO_SPEECH_MAX_INPUT_CHARS,
          supportsStreaming: true,
          streamResponseFormat: "pcm16",
          finalResponseFormat: "wav",
          allowEmptyInputWhenOptimizeTextPreview: true,
          fields: {
            voiceDesignPrompt: "required",
            optimizeTextPreview: "optional",
          },
        }),
        voice_clone: speechConstraints({
          mode: "voice_clone",
          responseFormats: MIMO_SPEECH_FORMATS,
          maxInputChars: AUDIO_SPEECH_MAX_INPUT_CHARS,
          supportsStreaming: true,
          streamResponseFormat: "pcm16",
          finalResponseFormat: "wav",
          fields: {
            styleInstruction: "optional",
            referenceAudio: "required",
          },
        }),
      },
      realtimeCaptions: {
        mode: "chunked_near_realtime",
        supportsInstructions: false,
        supportsLanguage: true,
        supportsVoice: false,
      },
    },
  },
  custom_openai_compatible: {
    preset: "custom_openai_compatible",
    defaultBaseUrl: "",
    endpointStrategy: "custom_openai_compatible",
    routes: {
      speechSynthesis: {},
    },
    constraints: {
      transcription: {
        responseFormats: ["json"],
        supportsPrompt: true,
        supportsStreaming: false,
        supportsTimestampGranularities: false,
      },
      speechSynthesis: {
        preset_voice: speechConstraints({
          mode: "preset_voice",
          responseFormats: OPENAI_SPEECH_FORMATS,
          maxInputChars: AUDIO_SPEECH_MAX_INPUT_CHARS,
          maxInstructionsChars: AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
          fields: {
            voice: "required",
            instructions: "optional",
            speed: "optional",
          },
        }),
      },
      realtimeCaptions: {
        mode: "caption",
        supportsInstructions: false,
        supportsLanguage: true,
        supportsVoice: false,
        languages: OPENAI_REALTIME_CAPTION_LANGUAGES,
        inputAudioFormats: OPENAI_REALTIME_INPUT_AUDIO_FORMATS,
      },
      realtimeVoice: {
        mode: "duplex_voice",
        supportsInstructions: true,
        supportsLanguage: false,
        supportsVoice: true,
      },
    },
  },
};

export function getAudioProviderDefinition(
  preset: AudioProviderPreset,
): AudioProviderDefinition {
  return cloneDefinition(AUDIO_PROVIDER_REGISTRY[preset]);
}

export function inferAudioProviderPresetFromLegacy(options: {
  transport: AudioTransport;
  connectionProvider?: string;
}): { preset: AudioProviderPreset; needsAttention: boolean } {
  if (options.transport === "mimo_chat_audio") {
    return { preset: "mimo", needsAttention: false };
  }
  if (options.connectionProvider === "OpenAI") {
    return { preset: "openai", needsAttention: false };
  }
  return { preset: "custom_openai_compatible", needsAttention: true };
}

export function createDefaultAudioApiRoutes(
  preset: AudioProviderPreset,
): AudioApiRoutes {
  return cloneRoutes(AUDIO_PROVIDER_REGISTRY[preset].routes);
}

export function getSpeechRouteConstraints(
  preset: AudioProviderPreset,
  mode: SpeechSynthesisMode,
): AudioSpeechRouteConstraints | undefined {
  const constraints =
    AUDIO_PROVIDER_REGISTRY[preset].constraints.speechSynthesis[mode];
  return constraints ? cloneSpeechConstraints(constraints) : undefined;
}

export function resolveTranscriptionRouteDefinition(options: {
  providerPreset: AudioProviderPreset;
  transport: AudioTransport;
  model: string;
}): AudioTranscriptionRouteDefinition | undefined {
  const model = options.model.trim().toLowerCase();
  if (
    !model ||
    !isAudioRouteTransportSupported({
      preset: options.providerPreset,
      assignmentKey: "transcription",
      transport: options.transport,
    })
  ) {
    return undefined;
  }

  if (options.providerPreset === "mimo") {
    if (model !== "mimo-v2.5-asr") return undefined;
    return transcriptionDefinition(
      "mimo_asr",
      AUDIO_PROVIDER_REGISTRY.mimo.constraints.transcription,
    );
  }

  if (isOpenAIWhisperTranscriptionModel(model)) {
    return transcriptionDefinition(
      "openai_whisper",
      OPENAI_WHISPER_TRANSCRIPTION_CONSTRAINTS,
    );
  }

  if (isOpenAIGptTranscriptionModel(model)) {
    return transcriptionDefinition(
      "openai_gpt_transcribe",
      AUDIO_PROVIDER_REGISTRY.openai.constraints.transcription,
    );
  }

  if (options.providerPreset === "custom_openai_compatible") {
    return transcriptionDefinition(
      "openai_compatible_unknown",
      AUDIO_PROVIDER_REGISTRY.custom_openai_compatible.constraints.transcription,
    );
  }

  return undefined;
}

export function getRealtimeRouteConstraints(
  preset: AudioProviderPreset,
  assignmentKey: "realtimeCaptions" | "realtimeVoice",
): AudioRealtimeRouteConstraints | undefined {
  const constraints = AUDIO_PROVIDER_REGISTRY[preset].constraints[assignmentKey];
  return constraints ? cloneRealtimeConstraints(constraints) : undefined;
}

export function resolveRealtimeRouteDefinition(options: {
  providerPreset: AudioProviderPreset;
  assignmentKey: "realtimeCaptions" | "realtimeVoice";
  transport: AudioTransport;
  model: string;
}): AudioRealtimeRouteDefinition | undefined {
  const model = options.model.trim().toLowerCase();
  if (
    !model ||
    !isAudioRouteTransportSupported({
      preset: options.providerPreset,
      assignmentKey: options.assignmentKey,
      transport: options.transport,
    })
  ) {
    return undefined;
  }

  if (options.providerPreset === "mimo") {
    if (
      options.assignmentKey !== "realtimeCaptions" ||
      model !== "mimo-v2.5-asr"
    ) {
      return undefined;
    }
  } else if (options.providerPreset === "openai") {
    const knownModel = options.assignmentKey === "realtimeCaptions"
      ? isOpenAIRealtimeCaptionModel(model)
      : isOpenAIRealtimeVoiceModel(model);
    if (!knownModel) return undefined;
  }

  const constraints = getRealtimeRouteConstraints(
    options.providerPreset,
    options.assignmentKey,
  );
  if (!constraints) return undefined;

  if (
    options.providerPreset === "mimo" &&
    options.assignmentKey === "realtimeCaptions"
  ) {
    const transcription = resolveTranscriptionRouteDefinition({
      providerPreset: options.providerPreset,
      transport: options.transport,
      model: options.model,
    });
    if (!transcription) return undefined;
    constraints.languages = transcription.constraints.languages
      ? [...transcription.constraints.languages]
      : undefined;
  }

  return { constraints };
}

export function getAvailableSpeechSynthesisModes(
  profileOrRoutes: Pick<AudioApiProfile, "routes"> | AudioApiRoutes,
): SpeechSynthesisMode[] {
  const routes = "routes" in profileOrRoutes
    ? profileOrRoutes.routes
    : profileOrRoutes;
  return SPEECH_SYNTHESIS_MODES.filter((mode) =>
    isConfiguredRoute(routes.speechSynthesis[mode]),
  );
}

export function canAudioApiHandleTask(
  profile: Pick<AudioApiProfile, "routes"> | null | undefined,
  assignmentKey: AudioAssignmentKey,
): boolean {
  if (!profile) return false;

  switch (assignmentKey) {
    case "transcription":
      return isConfiguredRoute(profile.routes.transcription);
    case "speechSynthesis":
      return getAvailableSpeechSynthesisModes(profile).length > 0;
    case "realtimeCaptions":
      return isConfiguredRoute(profile.routes.realtimeCaptions);
    case "realtimeVoice":
      return isConfiguredRoute(profile.routes.realtimeVoice);
  }
}

export function resolveAudioApiRoute(
  profile: Pick<AudioApiProfile, "routes">,
  assignmentKey: AudioAssignmentKey,
  speechMode?: SpeechSynthesisMode,
): AudioRoute | undefined {
  let selected: AudioRoute | undefined;
  switch (assignmentKey) {
    case "transcription":
      selected = profile.routes.transcription;
      break;
    case "speechSynthesis":
      selected = speechMode
        ? profile.routes.speechSynthesis[speechMode]
        : undefined;
      break;
    case "realtimeCaptions":
      selected = profile.routes.realtimeCaptions;
      break;
    case "realtimeVoice":
      selected = profile.routes.realtimeVoice;
      break;
  }

  return isConfiguredRoute(selected) ? { ...selected } : undefined;
}

export function getAudioRouteKey(
  assignmentKey: AudioAssignmentKey,
  speechMode?: SpeechSynthesisMode,
): AudioRouteKey | undefined {
  if (assignmentKey !== "speechSynthesis") return assignmentKey;
  return speechMode ? `speechSynthesis.${speechMode}` : undefined;
}

export function isAudioRouteTransportSupported(options: {
  preset: AudioProviderPreset;
  assignmentKey: AudioAssignmentKey;
  transport: AudioTransport;
  speechMode?: SpeechSynthesisMode;
}): boolean {
  const { preset, assignmentKey, transport, speechMode } = options;

  if (assignmentKey === "speechSynthesis") {
    if (!speechMode || !AUDIO_PROVIDER_REGISTRY[preset].constraints
      .speechSynthesis[speechMode]) {
      return false;
    }
  }

  if (preset === "mimo") {
    return (
      transport === "mimo_chat_audio" && assignmentKey !== "realtimeVoice"
    );
  }

  if (assignmentKey === "transcription" || assignmentKey === "speechSynthesis") {
    return transport === "openai_audio";
  }
  return transport === "openai_realtime";
}

function route(
  transport: AudioRoute["transport"],
  model: string,
): AudioRoute {
  return { transport, model, enabled: true };
}

function createMimoSpeechRoutes(): AudioApiRoutes["speechSynthesis"] {
  return Object.fromEntries(
    SPEECH_SYNTHESIS_MODES.map((mode) => [
      mode,
      route("mimo_chat_audio", MIMO_TTS_MODEL_BY_MODE[mode]),
    ]),
  ) as Record<SpeechSynthesisMode, AudioRoute>;
}

function speechConstraints(options: {
  mode: SpeechSynthesisMode;
  responseFormats: readonly AudioSpeechResponseFormat[];
  supportsStreaming?: boolean;
  streamResponseFormat?: AudioSpeechResponseFormat;
  finalResponseFormat?: AudioSpeechResponseFormat;
  inputRequired?: boolean;
  maxInputChars: number;
  maxInstructionsChars?: number;
  allowEmptyInputWhenOptimizeTextPreview?: boolean;
  fields?: Partial<AudioSpeechRouteConstraints["fields"]>;
}): AudioSpeechRouteConstraints {
  return {
    mode: options.mode,
    responseFormats: [...options.responseFormats],
    supportsStreaming: options.supportsStreaming ?? false,
    ...(options.streamResponseFormat
      ? { streamResponseFormat: options.streamResponseFormat }
      : {}),
    ...(options.finalResponseFormat
      ? { finalResponseFormat: options.finalResponseFormat }
      : {}),
    inputRequired: options.inputRequired ?? true,
    maxInputChars: options.maxInputChars,
    ...(options.maxInstructionsChars !== undefined
      ? { maxInstructionsChars: options.maxInstructionsChars }
      : {}),
    allowEmptyInputWhenOptimizeTextPreview:
      options.allowEmptyInputWhenOptimizeTextPreview ?? false,
    fields: {
      voice: "unsupported",
      instructions: "unsupported",
      speed: "unsupported",
      styleInstruction: "unsupported",
      voiceDesignPrompt: "unsupported",
      optimizeTextPreview: "unsupported",
      referenceAudio: "unsupported",
      audioTags: "unsupported",
      ...options.fields,
    },
  };
}

function transcriptionDefinition(
  family: AudioTranscriptionModelFamily,
  constraints: AudioTranscriptionRouteConstraints | undefined,
): AudioTranscriptionRouteDefinition | undefined {
  return constraints
    ? { family, constraints: cloneTranscriptionConstraints(constraints) }
    : undefined;
}

function isOpenAIGptTranscriptionModel(model: string): boolean {
  if (model.includes("diarize")) return false;
  return (
    model === "gpt-4o-transcribe" ||
    model.startsWith("gpt-4o-transcribe-") ||
    model === "gpt-4o-mini-transcribe" ||
    model.startsWith("gpt-4o-mini-transcribe-")
  );
}

function isOpenAIWhisperTranscriptionModel(model: string): boolean {
  return model === "whisper-1" || model.startsWith("whisper-1-");
}

function isOpenAIRealtimeCaptionModel(model: string): boolean {
  return model === "gpt-realtime-whisper" ||
    model.startsWith("gpt-realtime-whisper-");
}

function isOpenAIRealtimeVoiceModel(model: string): boolean {
  return (
    model === "gpt-realtime" ||
    model.startsWith("gpt-realtime-")
  ) && !model.includes("whisper") && !model.includes("transcrib");
}

function isConfiguredRoute(
  routeValue: AudioRoute | null | undefined,
): routeValue is AudioRoute {
  return Boolean(
    routeValue?.enabled &&
    routeValue.model.trim() &&
    routeValue.transport,
  );
}

function cloneDefinition(
  definition: AudioProviderDefinition,
): AudioProviderDefinition {
  return {
    ...definition,
    routes: cloneRoutes(definition.routes),
    constraints: {
      ...(definition.constraints.transcription
        ? {
            transcription: cloneTranscriptionConstraints(
              definition.constraints.transcription,
            ),
          }
        : {}),
      speechSynthesis: Object.fromEntries(
        Object.entries(definition.constraints.speechSynthesis).map(
          ([mode, constraints]) => [
            mode,
            constraints
              ? cloneSpeechConstraints(constraints)
              : constraints,
          ],
        ),
      ),
      ...(definition.constraints.realtimeCaptions
        ? {
            realtimeCaptions: cloneRealtimeConstraints(
              definition.constraints.realtimeCaptions,
            ),
          }
        : {}),
      ...(definition.constraints.realtimeVoice
        ? {
            realtimeVoice: cloneRealtimeConstraints(
              definition.constraints.realtimeVoice,
            ),
          }
        : {}),
    },
  };
}

function cloneRoutes(routes: AudioApiRoutes): AudioApiRoutes {
  return {
    ...(routes.transcription
      ? { transcription: { ...routes.transcription } }
      : {}),
    speechSynthesis: Object.fromEntries(
      Object.entries(routes.speechSynthesis).map(([mode, routeValue]) => [
        mode,
        routeValue ? { ...routeValue } : routeValue,
      ]),
    ),
    ...(routes.realtimeCaptions
      ? { realtimeCaptions: { ...routes.realtimeCaptions } }
      : {}),
    ...(routes.realtimeVoice
      ? { realtimeVoice: { ...routes.realtimeVoice } }
      : {}),
  };
}

function cloneSpeechConstraints(
  constraints: AudioSpeechRouteConstraints,
): AudioSpeechRouteConstraints {
  return {
    ...constraints,
    responseFormats: [...constraints.responseFormats],
    fields: { ...constraints.fields },
  };
}

function cloneTranscriptionConstraints(
  constraints: AudioTranscriptionRouteConstraints,
): AudioTranscriptionRouteConstraints {
  return {
    ...constraints,
    responseFormats: [...constraints.responseFormats],
    ...(constraints.languages
      ? { languages: [...constraints.languages] }
      : {}),
  };
}

function cloneRealtimeConstraints(
  constraints: AudioRealtimeRouteConstraints,
): AudioRealtimeRouteConstraints {
  return {
    ...constraints,
    ...(constraints.languages
      ? { languages: [...constraints.languages] }
      : {}),
    ...(constraints.inputAudioFormats
      ? { inputAudioFormats: [...constraints.inputAudioFormats] }
      : {}),
  };
}
