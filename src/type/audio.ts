import { Model, type ModelProfile } from "@/type/model";

export const AUDIO_TRANSPORTS = [
  "openai_audio",
  "mimo_chat_audio",
  "openai_realtime",
] as const;

export type AudioTransport = (typeof AUDIO_TRANSPORTS)[number];

/** @deprecated Use AudioTransport for standalone audio API routes. */
export const AUDIO_API_DIALECTS = AUDIO_TRANSPORTS;

/** @deprecated Use AudioTransport for standalone audio API routes. */
export type AudioApiDialect = AudioTransport;

export const AUDIO_PROVIDER_PRESETS = [
  "openai",
  "mimo",
  "custom_openai_compatible",
] as const;

export type AudioProviderPreset = (typeof AUDIO_PROVIDER_PRESETS)[number];

export const AUDIO_CAPABILITIES = [
  "file_transcription",
  "streaming_transcription",
  "speech_synthesis",
  "streaming_speech_synthesis",
  "realtime_transcription",
  "realtime_duplex_voice",
  "mimo_voice_design",
  "mimo_voice_clone",
] as const;

export type AudioCapability = (typeof AUDIO_CAPABILITIES)[number];

export const AUDIO_ASSIGNMENT_KEYS = [
  "transcription",
  "speechSynthesis",
  "realtimeCaptions",
  "realtimeVoice",
] as const;

export type AudioAssignmentKey = (typeof AUDIO_ASSIGNMENT_KEYS)[number];

export const AUDIO_TRANSCRIPTION_RESPONSE_FORMATS = [
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
] as const;

export type AudioTranscriptionResponseFormat =
  (typeof AUDIO_TRANSCRIPTION_RESPONSE_FORMATS)[number];

export type AudioTranscriptionModelFamily =
  | "openai_gpt_transcribe"
  | "openai_whisper"
  | "mimo_asr"
  | "openai_compatible_unknown"
  | "unsupported";

export interface AudioTranscriptionModelMatrix {
  family: AudioTranscriptionModelFamily;
  modelSupported: boolean;
  responseFormats: AudioTranscriptionResponseFormat[];
  supportsPrompt: boolean;
  supportsStream: boolean;
  supportsTimestampGranularities: boolean;
}

export interface AudioTranscriptionModelContext {
  audioDialect?: AudioApiDialect;
  provider?: Model;
  modelKey?: string;
}

export const AUDIO_SPEECH_RESPONSE_FORMATS = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
  "pcm16",
] as const;

export type AudioSpeechResponseFormat =
  (typeof AUDIO_SPEECH_RESPONSE_FORMATS)[number];

export const AUDIO_SPEECH_MAX_INPUT_CHARS = 4096;
export const AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS = 4096;

export const SPEECH_SYNTHESIS_MODES = [
  "preset_voice",
  "voice_design",
  "voice_clone",
] as const;

export type SpeechSynthesisMode = (typeof SPEECH_SYNTHESIS_MODES)[number];

/** @deprecated Use SPEECH_SYNTHESIS_MODES. */
export const MIMO_SPEECH_SYNTHESIS_MODES = SPEECH_SYNTHESIS_MODES;

/** @deprecated Use SpeechSynthesisMode. */
export type MimoSpeechSynthesisMode = SpeechSynthesisMode;

export type AudioRouteVerificationStatus =
  | "untested"
  | "verified"
  | "degraded"
  | "failed";

export interface AudioRoute {
  transport: AudioTransport;
  model: string;
  enabled: boolean;
}

export interface AudioApiRoutes {
  transcription?: AudioRoute;
  speechSynthesis: Partial<Record<SpeechSynthesisMode, AudioRoute>>;
  realtimeCaptions?: AudioRoute;
  realtimeVoice?: AudioRoute;
}

export interface AudioRouteVerification {
  status: AudioRouteVerificationStatus;
  updatedAt?: string;
}

export interface AudioApiProfile {
  id: string;
  name: string;
  providerPreset: AudioProviderPreset;
  baseUrl: string;
  apiKey: string;
  routes: AudioApiRoutes;
  verification?: Partial<Record<string, AudioRouteVerification>>;
  migration?: {
    source: "legacy_audio_profile";
    sourceId: string;
    needsAttention?: boolean;
  };
}

export type AudioTaskRouteIntent =
  | { assignmentKey: "transcription" }
  | {
      assignmentKey: "speechSynthesis";
      mode: SpeechSynthesisMode;
    }
  | { assignmentKey: "realtimeCaptions" }
  | { assignmentKey: "realtimeVoice" };

export type AudioRouteKey =
  | "transcription"
  | `speechSynthesis.${SpeechSynthesisMode}`
  | "realtimeCaptions"
  | "realtimeVoice";

export interface ResolvedAudioRouteConfig {
  audioProfileId: string;
  providerPreset: AudioProviderPreset;
  assignmentKey: AudioAssignmentKey;
  routeKey: AudioRouteKey;
  apiKey: string;
  baseUrl: string;
  transport: AudioTransport;
  model: string;
}

export interface AudioRouteResolutionIssue {
  code:
    | "stale_audio_config"
    | "audio_api_not_configured"
    | "audio_route_not_configured"
    | "invalid_task_parameters";
  message: string;
  assignmentKey: AudioAssignmentKey;
  mode?: SpeechSynthesisMode;
}

export type AudioRouteResolutionResult =
  | { ok: true; config: ResolvedAudioRouteConfig }
  | { ok: false; issue: AudioRouteResolutionIssue };

/** @deprecated Use AudioRouteVerificationStatus. */
export type AudioModelVerificationStatus = AudioRouteVerificationStatus;

export interface AudioModelProfile {
  id: string;
  name: string;
  connectionProfileId: string;
  audioDialect: AudioApiDialect;
  capabilities: AudioCapability[];
  models: {
    transcription?: string;
    speechSynthesis?: string;
    /** @deprecated Migrated to the two task-specific Realtime model fields. */
    realtime?: string;
    realtimeTranscription?: string;
    realtimeVoice?: string;
  };
  defaults: {
    language?: "auto" | "zh" | "en" | string;
    transcriptionResponseFormat?: AudioTranscriptionResponseFormat;
    ttsVoice?: string;
    ttsResponseFormat?: AudioSpeechResponseFormat;
    realtimeVoice?: string;
    mimoTtsMode?: MimoSpeechSynthesisMode;
    streamSpeechByDefault?: boolean;
  };
  verification?: {
    streamingSpeech?: AudioModelVerificationStatus;
    realtimeVoice?: Exclude<AudioModelVerificationStatus, "degraded">;
    updatedAt?: string;
  };
}

export type AudioTaskAssignment = Record<AudioAssignmentKey, string | null>;

export const DEFAULT_AUDIO_TASK_ASSIGNMENT: AudioTaskAssignment = {
  transcription: null,
  speechSynthesis: null,
  realtimeCaptions: null,
  realtimeVoice: null,
};

/** @deprecated Use AudioTaskAssignment. */
export type AudioModelAssignment = AudioTaskAssignment;

/** @deprecated Use DEFAULT_AUDIO_TASK_ASSIGNMENT. */
export const DEFAULT_AUDIO_MODEL_ASSIGNMENT = DEFAULT_AUDIO_TASK_ASSIGNMENT;

export interface AudioRuntimeModelConfig {
  audioProfileId: string;
  connectionProfileId: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  audioDialect: AudioApiDialect;
  modelKey: string;
  capabilities: AudioCapability[];
}

/**
 * Transitional main-to-adapter DTO. Public IPC and trusted route resolution
 * use providerPreset/transport/model instead of these legacy field names.
 */
export interface AudioRuntimeAdapterModelConfig {
  audioProfileId: string;
  provider: Model;
  providerPreset?: AudioProviderPreset;
  apiKey: string;
  baseUrl: string;
  audioDialect: AudioTransport;
  modelKey: string;
}

export type AudioOutputPathMode = "temp" | "source_dir" | "custom_dir";

export type AudioTimestampGranularity = "word" | "segment";

export interface AudioTranscriptSegment {
  id?: number | string;
  start?: number;
  end?: number;
  text: string;
}

export interface AudioTranscriptWord {
  word: string;
  start?: number;
  end?: number;
}

export interface CreateAudioTranscriptionRequest {
  assignmentKey: "transcription";
  requestId?: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  language?: "auto" | "zh" | "en" | string;
  prompt?: string;
  responseFormat: AudioTranscriptionResponseFormat;
  temperature?: number;
  timestampGranularities?: AudioTimestampGranularity[];
  stream?: boolean;
  outputPathMode?: AudioOutputPathMode;
  outputDir?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  responseFormat: AudioTranscriptionResponseFormat;
  outputPath?: string;
  outputToken?: string;
  rawJson?: unknown;
  rawText?: string;
  segments?: AudioTranscriptSegment[];
  words?: AudioTranscriptWord[];
  model?: string;
  durationMs?: number;
  streamMode?: "incremental" | "final_only";
}

export interface MimoSpeechOptions {
  mode: MimoSpeechSynthesisMode;
  styleInstruction?: string;
  voiceDesignPrompt?: string;
  optimizeTextPreview?: boolean;
  voiceSamplePath?: string;
  voiceSampleMime?: "audio/mpeg" | "audio/mp3" | "audio/wav";
  audioTagsEnabled?: boolean;
}

export type SpeechSynthesisIntent =
  | {
      mode: "preset_voice";
      voice: string;
      styleInstruction?: string;
    }
  | {
      mode: "voice_design";
      voiceDesignPrompt: string;
      optimizeTextPreview?: boolean;
    }
  | {
      mode: "voice_clone";
      voiceSampleToken: string;
      styleInstruction?: string;
    };

export interface CreateSpeechSynthesisRequest {
  assignmentKey: "speechSynthesis";
  requestId?: string;
  input: string;
  voice?: string;
  instructions?: string;
  responseFormat: AudioSpeechResponseFormat;
  speed?: number;
  stream?: boolean;
  outputPathMode?: AudioOutputPathMode;
  outputDir?: string;
  fileNameHint?: string;
  mimoOptions?: MimoSpeechOptions;
}

export interface AudioStreamStats {
  firstChunkLatencyMs?: number;
  chunkCount?: number;
  totalBytes?: number;
  sampleRate?: number;
  channels?: number;
  streamMode?: "incremental" | "final_only";
  streamEncoding?: "pcm16";
}

export interface SpeechSynthesisResult {
  outputPath: string;
  outputToken?: string;
  mimeType: string;
  responseFormat: AudioSpeechResponseFormat;
  sizeBytes: number;
  model?: string;
  durationMs?: number;
  streamStats?: AudioStreamStats;
}

export interface AudioRealtimeSessionConfig {
  assignmentKey: "realtimeCaptions" | "realtimeVoice";
  mode: "caption" | "duplex_voice";
  instructions?: string;
  language?: string;
  voice?: string;
  turnDetection?: "server_vad" | "manual";
  inputAudioFormat?: "pcm16" | "pcmu" | "pcma";
  outputAudioFormat?: "pcm16" | "pcmu" | "pcma";
}

export type AudioRealtimeSessionCloseReason = "user" | "page_unload" | "error";

export type AudioRole = "user" | "assistant";

export const AUDIO_DIALECT_DEFAULT_CAPABILITIES: Record<
  AudioApiDialect,
  AudioCapability[]
> = {
  openai_audio: [
    "file_transcription",
    "streaming_transcription",
    "speech_synthesis",
    "streaming_speech_synthesis",
  ],
  mimo_chat_audio: [
    "file_transcription",
    "streaming_transcription",
    "speech_synthesis",
    "streaming_speech_synthesis",
    "mimo_voice_design",
    "mimo_voice_clone",
  ],
  openai_realtime: [
    "realtime_transcription",
    "realtime_duplex_voice",
  ],
};

const AUDIO_ASSIGNMENT_CAPABILITY_REQUIREMENTS: Record<
  AudioAssignmentKey,
  AudioCapability[][]
> = {
  transcription: [["file_transcription"]],
  speechSynthesis: [["speech_synthesis"]],
  realtimeCaptions: [["realtime_transcription"], ["streaming_transcription"]],
  realtimeVoice: [["realtime_duplex_voice"]],
};

export interface AudioCapabilityValidationIssue {
  code:
    | "audio_profile_not_configured"
    | "connection_profile_not_configured"
    | "audio_model_not_configured"
    | "unsupported_audio_capability";
  message: string;
  assignmentKey?: AudioAssignmentKey;
  missingCapabilities?: AudioCapability[];
}

export type AudioCapabilityValidationResult =
  | { ok: true }
  | { ok: false; issue: AudioCapabilityValidationIssue };

export type AudioRuntimeModelConfigResult =
  | { ok: true; config: AudioRuntimeModelConfig }
  | { ok: false; issue: AudioCapabilityValidationIssue };

export function isAudioApiDialect(value: unknown): value is AudioApiDialect {
  return isAudioTransport(value);
}

export function isAudioTransport(value: unknown): value is AudioTransport {
  return isOneOfString(value, AUDIO_TRANSPORTS);
}

export function isAudioProviderPreset(
  value: unknown,
): value is AudioProviderPreset {
  return isOneOfString(value, AUDIO_PROVIDER_PRESETS);
}

export function isAudioCapability(value: unknown): value is AudioCapability {
  return isOneOfString(value, AUDIO_CAPABILITIES);
}

export function isAudioAssignmentKey(
  value: unknown,
): value is AudioAssignmentKey {
  return isOneOfString(value, AUDIO_ASSIGNMENT_KEYS);
}

export function isAudioTranscriptionResponseFormat(
  value: unknown,
): value is AudioTranscriptionResponseFormat {
  return isOneOfString(value, AUDIO_TRANSCRIPTION_RESPONSE_FORMATS);
}

/**
 * Resolves the file-ASR request matrix before a request reaches an adapter.
 *
 * OpenAI's GPT-4o transcription models only accept JSON output and support
 * SSE streaming. Whisper accepts the legacy output formats and timestamps,
 * but ignores `stream`. Unknown OpenAI-compatible providers use the smallest
 * portable contract instead of inheriting Whisper-only fields.
 */
export function resolveAudioTranscriptionModelMatrix(
  context: AudioTranscriptionModelContext,
): AudioTranscriptionModelMatrix {
  const audioDialect = context.audioDialect;
  const modelKey = normalizeOptionalString(context.modelKey)?.toLowerCase();

  if (audioDialect === "mimo_chat_audio") {
    return {
      family: modelKey === "mimo-v2.5-asr" ? "mimo_asr" : "unsupported",
      modelSupported: modelKey === "mimo-v2.5-asr",
      responseFormats: ["json", "text"],
      supportsPrompt: false,
      supportsStream: true,
      supportsTimestampGranularities: false,
    };
  }

  if (audioDialect !== "openai_audio" || !modelKey) {
    return unsupportedTranscriptionMatrix();
  }

  if (isOpenAIWhisperTranscriptionModel(modelKey)) {
    return {
      family: "openai_whisper",
      modelSupported: true,
      responseFormats: ["json", "text", "srt", "verbose_json", "vtt"],
      supportsPrompt: true,
      supportsStream: false,
      supportsTimestampGranularities: true,
    };
  }

  if (isOpenAIGptTranscriptionModel(modelKey)) {
    return {
      family: "openai_gpt_transcribe",
      modelSupported: true,
      responseFormats: ["json"],
      supportsPrompt: true,
      supportsStream: true,
      supportsTimestampGranularities: false,
    };
  }

  if (context.provider === Model.OpenAI) {
    return unsupportedTranscriptionMatrix();
  }

  return {
    family: "openai_compatible_unknown",
    modelSupported: true,
    responseFormats: ["json"],
    supportsPrompt: true,
    supportsStream: false,
    supportsTimestampGranularities: false,
  };
}

export function isAudioSpeechResponseFormat(
  value: unknown,
): value is AudioSpeechResponseFormat {
  return isOneOfString(value, AUDIO_SPEECH_RESPONSE_FORMATS);
}

export function isMimoSpeechSynthesisMode(
  value: unknown,
): value is MimoSpeechSynthesisMode {
  return isSpeechSynthesisMode(value);
}

export function isSpeechSynthesisMode(
  value: unknown,
): value is SpeechSynthesisMode {
  return isOneOfString(value, SPEECH_SYNTHESIS_MODES);
}

export function getDefaultAudioCapabilities(
  audioDialect: AudioApiDialect,
): AudioCapability[] {
  return [...AUDIO_DIALECT_DEFAULT_CAPABILITIES[audioDialect]];
}

export function resolveAudioCapabilities(
  profileOrDialect: Pick<AudioModelProfile, "audioDialect" | "capabilities"> | AudioApiDialect,
): AudioCapability[] {
  if (typeof profileOrDialect === "string") {
    return getDefaultAudioCapabilities(profileOrDialect);
  }

  return profileOrDialect.capabilities.length > 0
    ? dedupeCapabilities(profileOrDialect.capabilities)
    : getDefaultAudioCapabilities(profileOrDialect.audioDialect);
}

export function validateAudioCapability(
  profile: AudioModelProfile | null | undefined,
  assignmentKey: AudioAssignmentKey,
): AudioCapabilityValidationResult {
  if (!profile) {
    return {
      ok: false,
      issue: {
        code: "audio_profile_not_configured",
        message: "Audio profile is not configured.",
        assignmentKey,
      },
    };
  }

  const capabilities = new Set(resolveAudioCapabilities(profile));
  const alternatives = AUDIO_ASSIGNMENT_CAPABILITY_REQUIREMENTS[assignmentKey];
  const satisfied = alternatives.some((requiredSet) =>
    requiredSet.every((capability) => capabilities.has(capability)),
  );

  if (satisfied) {
    return { ok: true };
  }

  return {
    ok: false,
    issue: {
      code: "unsupported_audio_capability",
      message: "Audio profile does not support the requested capability.",
      assignmentKey,
      missingCapabilities: alternatives[0],
    },
  };
}

export function resolveAudioRuntimeModelConfig(args: {
  audioProfile: AudioModelProfile | null | undefined;
  connectionProfile: Pick<
    ModelProfile,
    "id" | "provider" | "apiKey" | "baseUrl"
  > | null | undefined;
  assignmentKey: AudioAssignmentKey;
}): AudioRuntimeModelConfigResult {
  const audioProfile = args.audioProfile;
  if (!audioProfile) {
    return {
      ok: false,
      issue: {
        code: "audio_profile_not_configured",
        message: "Audio profile is not configured.",
        assignmentKey: args.assignmentKey,
      },
    };
  }

  const capability = validateAudioCapability(audioProfile, args.assignmentKey);
  if (!capability.ok) return capability;

  if (!args.connectionProfile) {
    return {
      ok: false,
      issue: {
        code: "connection_profile_not_configured",
        message: "Connection profile is not configured.",
        assignmentKey: args.assignmentKey,
      },
    };
  }

  const modelKey = getAudioModelKeyForAssignment(audioProfile, args.assignmentKey);
  if (!modelKey) {
    return {
      ok: false,
      issue: {
        code: "audio_model_not_configured",
        message: "Audio model is not configured for this assignment.",
        assignmentKey: args.assignmentKey,
      },
    };
  }

  return {
    ok: true,
    config: {
      audioProfileId: audioProfile.id,
      connectionProfileId: args.connectionProfile.id,
      provider: args.connectionProfile.provider,
      apiKey: args.connectionProfile.apiKey,
      baseUrl: args.connectionProfile.baseUrl,
      audioDialect: audioProfile.audioDialect,
      modelKey,
      capabilities: resolveAudioCapabilities(audioProfile),
    },
  };
}

export function getAudioModelKeyForAssignment(
  profile: AudioModelProfile,
  assignmentKey: AudioAssignmentKey,
): string | undefined {
  switch (assignmentKey) {
    case "transcription":
      return normalizeOptionalString(profile.models.transcription);
    case "speechSynthesis":
      return normalizeOptionalString(profile.models.speechSynthesis);
    case "realtimeCaptions":
      return profile.audioDialect === "openai_realtime"
        ? normalizeOptionalString(
            profile.models.realtimeTranscription ?? profile.models.realtime,
          )
        : normalizeOptionalString(profile.models.transcription);
    case "realtimeVoice":
      return normalizeOptionalString(
        profile.models.realtimeVoice ?? profile.models.realtime,
      );
  }
}

function isOpenAIGptTranscriptionModel(modelKey: string): boolean {
  if (modelKey.includes("diarize")) return false;
  return (
    modelKey === "gpt-4o-transcribe" ||
    modelKey.startsWith("gpt-4o-transcribe-") ||
    modelKey === "gpt-4o-mini-transcribe" ||
    modelKey.startsWith("gpt-4o-mini-transcribe-")
  );
}

function isOpenAIWhisperTranscriptionModel(modelKey: string): boolean {
  return modelKey === "whisper-1" || modelKey.startsWith("whisper-1-");
}

function unsupportedTranscriptionMatrix(): AudioTranscriptionModelMatrix {
  return {
    family: "unsupported",
    modelSupported: false,
    responseFormats: ["json"],
    supportsPrompt: false,
    supportsStream: false,
    supportsTimestampGranularities: false,
  };
}

function dedupeCapabilities(
  capabilities: readonly AudioCapability[],
): AudioCapability[] {
  return [...new Set(capabilities)];
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isOneOfString<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === "string" && allowedValues.includes(value as T);
}
