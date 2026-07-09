import type { Model, ModelProfile } from "@/type/model";

export const AUDIO_API_DIALECTS = [
  "openai_audio",
  "mimo_chat_audio",
  "openai_realtime",
] as const;

export type AudioApiDialect = (typeof AUDIO_API_DIALECTS)[number];

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

export const MIMO_SPEECH_SYNTHESIS_MODES = [
  "preset_voice",
  "voice_design",
  "voice_clone",
] as const;

export type MimoSpeechSynthesisMode =
  (typeof MIMO_SPEECH_SYNTHESIS_MODES)[number];

export type AudioModelVerificationStatus =
  | "untested"
  | "verified"
  | "degraded"
  | "failed";

export interface AudioModelProfile {
  id: string;
  name: string;
  connectionProfileId: string;
  audioDialect: AudioApiDialect;
  capabilities: AudioCapability[];
  models: {
    transcription?: string;
    speechSynthesis?: string;
    realtime?: string;
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

export type AudioModelAssignment = Record<AudioAssignmentKey, string | null>;

export const DEFAULT_AUDIO_MODEL_ASSIGNMENT: AudioModelAssignment = {
  transcription: null,
  speechSynthesis: null,
  realtimeCaptions: null,
  realtimeVoice: null,
};

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
}

export interface SpeechSynthesisResult {
  outputPath: string;
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
  inputAudioFormat?: "pcm16" | "opus";
  outputAudioFormat?: "pcm16" | "opus";
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
  return isOneOfString(value, AUDIO_API_DIALECTS);
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

export function isAudioSpeechResponseFormat(
  value: unknown,
): value is AudioSpeechResponseFormat {
  return isOneOfString(value, AUDIO_SPEECH_RESPONSE_FORMATS);
}

export function isMimoSpeechSynthesisMode(
  value: unknown,
): value is MimoSpeechSynthesisMode {
  return isOneOfString(value, MIMO_SPEECH_SYNTHESIS_MODES);
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
    case "realtimeVoice":
      return normalizeOptionalString(profile.models.realtime);
  }
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
