import {
  SPEECH_SYNTHESIS_MODES,
  type AudioApiProfile,
  type AudioProviderPreset,
  type AudioRoute,
  type AudioSpeechResponseFormat,
  type AudioTaskAssignment,
  type SpeechSynthesisMode,
  type SpeechSynthesisIntent,
} from "@/type/audio";
import {
  isAudioSpeechResponseFormat,
  isSpeechSynthesisMode,
} from "@/type/audio";
import type { CreateSpeechSynthesisIpcRequest } from "@/type/audioIpc";
import {
  getAvailableSpeechSynthesisModes,
  getSpeechRouteConstraints,
  isAudioRouteTransportSupported,
  resolveAudioApiRoute,
  type AudioSpeechRouteConstraints,
} from "@/lib/audio-provider-registry";
import {
  isAudioOutputDirectoryAuthorizationValid,
  normalizeAudioOutputDirectoryLabel,
  type AudioOutputDirectoryAuthorization,
} from "./audioOutputDirectory";
import type {
  AudioToolConfigSummary,
} from "./audioToolConfig";

export type SpeechSynthesizerOutputMode = "temp" | "custom_dir";

export interface SelectedVoiceSample {
  sourceFile?: File;
  fileToken: string | null;
  fileName: string;
  mimeType: "audio/wav" | "audio/mpeg" | "audio/mp3";
  sizeBytes: number;
  expiresAt?: number;
  modifiedAt?: number;
}

export interface SpeechSynthesizerPreferences {
  input: string;
  modeInputDrafts: Partial<Record<SpeechSynthesisMode, string>>;
  speechMode: SpeechSynthesisMode;
  voice: string;
  instructions: string;
  responseFormat: AudioSpeechResponseFormat;
  speed: number;
  stream: boolean;
  outputMode: SpeechSynthesizerOutputMode;
  outputDir: string;
  fileNameHint: string;
  styleInstruction: string;
  voiceDesignPrompt: string;
  optimizeTextPreview: boolean;
}

export interface SpeechSynthesisFieldVisibility {
  voice: boolean;
  instructions: boolean;
  speed: boolean;
  styleInstruction: boolean;
  voiceDesignPrompt: boolean;
  optimizeTextPreview: boolean;
  referenceAudio: boolean;
  responseFormatSelect: boolean;
  responseFormatSummary: boolean;
  stream: boolean;
}

export type SpeechSynthesisConfigStatus =
  | "ready"
  | "audio_api_not_configured"
  | "audio_route_not_configured";

export interface SpeechSynthesisConfigSummary extends AudioToolConfigSummary {
  assignmentKey: "speechSynthesis";
  status: SpeechSynthesisConfigStatus;
  providerPreset?: AudioProviderPreset;
  availableModes: SpeechSynthesisMode[];
  activeMode?: SpeechSynthesisMode;
  route?: AudioRoute;
  constraints?: AudioSpeechRouteConstraints;
  migrationNeedsAttention?: boolean;
}

export interface SpeechSynthesisSubmissionSnapshot {
  profileId?: string;
  providerPreset?: AudioProviderPreset;
  mode?: SpeechSynthesisMode;
  routeTransport?: AudioRoute["transport"];
  routeModel?: string;
  sourceFile?: File;
}

export type SpeechSynthesisSubmitIssueCode =
  | "no_input"
  | "no_voice"
  | "invalid_voice"
  | "input_too_long"
  | "instructions_too_long"
  | "voice_design_prompt_required"
  | "voice_sample_required"
  | "voice_sample_authorizing"
  | "output_dir_required";

export type VoiceSampleIssueCode =
  | "voice_sample_path_unavailable"
  | "unsupported_voice_sample"
  | "voice_sample_too_large";

export interface VoiceSampleIssue {
  code: VoiceSampleIssueCode;
  details?: Record<string, unknown>;
}

export type VoiceSampleValidationResult =
  | { ok: true; mimeType: SelectedVoiceSample["mimeType"] }
  | { ok: false; issue: VoiceSampleIssue };

const DEFAULT_MODE_INPUT_DRAFTS: Record<SpeechSynthesisMode, string> = {
  preset_voice: "",
  voice_design: "",
  voice_clone: "",
};

export const DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES: SpeechSynthesizerPreferences = {
  input: "",
  modeInputDrafts: { ...DEFAULT_MODE_INPUT_DRAFTS },
  speechMode: "preset_voice",
  voice: "alloy",
  instructions: "",
  responseFormat: "mp3",
  speed: 1,
  stream: false,
  outputMode: "temp",
  outputDir: "",
  fileNameHint: "",
  styleInstruction: "",
  voiceDesignPrompt: "",
  optimizeTextPreview: false,
};

export const MIMO_VOICE_SAMPLE_ACCEPT = ".wav,.wave,.mp3,.mpeg,.mpga";
export const MIMO_VOICE_SAMPLE_MAX_BASE64_BYTES = 10 * 1024 * 1024;

const VOICE_SAMPLE_MIME_BY_EXTENSION: Record<
  string,
  SelectedVoiceSample["mimeType"]
> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
};

const NORMALIZED_VOICE_SAMPLE_MIME: Record<
  string,
  SelectedVoiceSample["mimeType"]
> = {
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
};

export function resolveSpeechSynthesisConfigSummary(
  state: Pick<{ profiles: AudioApiProfile[]; assignment: AudioTaskAssignment },
    "profiles" | "assignment">,
  preferredMode: SpeechSynthesisMode,
): SpeechSynthesisConfigSummary {
  const profileId = state.assignment.speechSynthesis;
  const profile = profileId
    ? state.profiles.find((candidate) => candidate.id === profileId)
    : undefined;
  if (!profile) {
    return {
      assignmentKey: "speechSynthesis",
      status: "audio_api_not_configured",
      availableModes: [],
      capabilities: [],
    };
  }

  const availableModes = getAvailableSpeechSynthesisModes(profile).filter(
    (mode) => {
      const route = resolveAudioApiRoute(profile, "speechSynthesis", mode);
      return Boolean(
        route &&
        getSpeechRouteConstraints(profile.providerPreset, mode) &&
        isAudioRouteTransportSupported({
          preset: profile.providerPreset,
          assignmentKey: "speechSynthesis",
          transport: route.transport,
          speechMode: mode,
        }),
      );
    },
  );
  const activeMode = resolveAvailableSpeechMode(availableModes, preferredMode);
  if (!activeMode) {
    return {
      assignmentKey: "speechSynthesis",
      status: "audio_route_not_configured",
      profileId: profile.id,
      profileName: profile.name,
      providerPreset: profile.providerPreset,
      availableModes,
      capabilities: [],
      migrationNeedsAttention: profile.migration?.needsAttention,
    };
  }

  const route = resolveAudioApiRoute(profile, "speechSynthesis", activeMode);
  const constraints = getSpeechRouteConstraints(
    profile.providerPreset,
    activeMode,
  );
  return {
    assignmentKey: "speechSynthesis",
    status: route && constraints ? "ready" : "audio_route_not_configured",
    profileId: profile.id,
    profileName: profile.name,
    providerPreset: profile.providerPreset,
    availableModes,
    capabilities: [
      "speech_synthesis",
      ...(constraints?.supportsStreaming
        ? ["streaming_speech_synthesis" as const]
        : []),
    ],
    activeMode,
    ...(route ? { route } : {}),
    ...(route
      ? { audioDialect: route.transport, modelKey: route.model }
      : {}),
    ...(constraints ? { constraints } : {}),
    migrationNeedsAttention: profile.migration?.needsAttention,
  };
}

export function createSpeechSynthesisSubmissionSnapshot(
  summary: SpeechSynthesisConfigSummary,
  voiceSample: SelectedVoiceSample | null,
): SpeechSynthesisSubmissionSnapshot {
  return {
    profileId: summary.profileId,
    providerPreset: summary.providerPreset,
    mode: summary.activeMode,
    routeTransport: summary.route?.transport,
    routeModel: summary.route?.model,
    sourceFile:
      summary.constraints?.fields.referenceAudio !== "unsupported"
        ? voiceSample?.sourceFile
        : undefined,
  };
}

export function isSpeechSynthesisSubmissionSnapshotCurrent(
  snapshot: SpeechSynthesisSubmissionSnapshot,
  summary: SpeechSynthesisConfigSummary,
  voiceSample: SelectedVoiceSample | null,
): boolean {
  return (
    summary.status === "ready" &&
    snapshot.profileId === summary.profileId &&
    snapshot.providerPreset === summary.providerPreset &&
    snapshot.mode === summary.activeMode &&
    snapshot.routeTransport === summary.route?.transport &&
    snapshot.routeModel === summary.route?.model &&
    (snapshot.sourceFile === undefined ||
      snapshot.sourceFile === voiceSample?.sourceFile)
  );
}

export function resolveAvailableSpeechMode(
  availableModes: readonly SpeechSynthesisMode[],
  preferredMode: SpeechSynthesisMode,
): SpeechSynthesisMode | undefined {
  if (availableModes.includes(preferredMode)) return preferredMode;
  if (availableModes.includes("preset_voice")) return "preset_voice";
  return SPEECH_SYNTHESIS_MODES.find((mode) => availableModes.includes(mode));
}

export function normalizeSpeechSynthesizerPreferences(
  preferences: SpeechSynthesizerPreferences,
  constraints: AudioSpeechRouteConstraints,
): SpeechSynthesizerPreferences {
  const stream = preferences.stream && constraints.supportsStreaming;
  const responseFormat = resolveResponseFormat(
    preferences.responseFormat,
    constraints,
    stream,
  );
  return {
    ...preferences,
    speechMode: constraints.mode,
    stream,
    responseFormat,
    speed: constraints.fields.speed === "unsupported"
      ? 1
      : clampSpeechSpeed(preferences.speed),
    optimizeTextPreview:
      constraints.fields.optimizeTextPreview !== "unsupported"
        ? preferences.optimizeTextPreview
        : false,
  };
}

export function getSpeechSynthesizerResponseFormats(
  constraints: AudioSpeechRouteConstraints,
  stream: boolean,
): AudioSpeechResponseFormat[] {
  if (stream && constraints.streamResponseFormat) {
    return [constraints.streamResponseFormat];
  }
  if (constraints.finalResponseFormat) {
    return [constraints.finalResponseFormat];
  }
  return [...constraints.responseFormats];
}

export function resolveSpeechSynthesisFieldVisibility(
  constraints: AudioSpeechRouteConstraints,
  stream: boolean,
): SpeechSynthesisFieldVisibility {
  const responseFormats = getSpeechSynthesizerResponseFormats(
    constraints,
    stream,
  );
  return {
    voice: constraints.fields.voice !== "unsupported",
    instructions: constraints.fields.instructions !== "unsupported",
    speed: constraints.fields.speed !== "unsupported",
    styleInstruction:
      constraints.fields.styleInstruction !== "unsupported",
    voiceDesignPrompt:
      constraints.fields.voiceDesignPrompt !== "unsupported",
    optimizeTextPreview:
      constraints.fields.optimizeTextPreview !== "unsupported",
    referenceAudio: constraints.fields.referenceAudio !== "unsupported",
    responseFormatSelect: responseFormats.length > 1,
    responseFormatSummary: responseFormats.length === 1,
    stream: constraints.supportsStreaming,
  };
}

export function buildSpeechSynthesisRequest(options: {
  requestId: string;
  preferences: SpeechSynthesizerPreferences;
  constraints: AudioSpeechRouteConstraints;
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null;
  voiceSample?: SelectedVoiceSample | null;
}): CreateSpeechSynthesisIpcRequest {
  const preferences = normalizeSpeechSynthesizerPreferences(
    options.preferences,
    options.constraints,
  );
  const styleInstruction = preferences.styleInstruction.trim();
  const intent = buildSpeechSynthesisIntent(
    preferences,
    options.constraints,
    options.voiceSample ?? null,
    styleInstruction,
  );
  return {
    assignmentKey: "speechSynthesis",
    requestId: options.requestId,
    input: preferences.input,
    intent,
    responseFormat: preferences.responseFormat,
    ...(options.constraints.fields.instructions !== "unsupported" &&
        preferences.instructions.trim()
      ? { instructions: preferences.instructions.trim() }
      : {}),
    ...(options.constraints.fields.speed !== "unsupported" &&
        preferences.speed !== 1
      ? { speed: preferences.speed }
      : {}),
    ...(options.constraints.supportsStreaming
      ? { stream: preferences.stream }
      : {}),
    ...(preferences.outputMode === "custom_dir"
      ? {
          outputPathMode: "custom_dir" as const,
          ...(options.outputDirectoryAuthorization
            ? {
                outputDirToken:
                  options.outputDirectoryAuthorization.outputDirToken,
              }
            : {}),
        }
      : { outputPathMode: "temp" as const }),
    ...(preferences.fileNameHint.trim()
      ? { fileNameHint: preferences.fileNameHint.trim() }
      : {}),
  };
}

export function resolveSpeechSynthesisSubmitIssue(options: {
  preferences: SpeechSynthesizerPreferences;
  constraints: AudioSpeechRouteConstraints;
  voiceSample: SelectedVoiceSample | null;
  voiceSampleAuthorizationPending: boolean;
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null;
}): SpeechSynthesisSubmitIssueCode | null {
  const preferences = normalizeSpeechSynthesizerPreferences(
    options.preferences,
    options.constraints,
  );
  const fields = options.constraints.fields;
  const inputCanBeEmpty =
    options.constraints.allowEmptyInputWhenOptimizeTextPreview &&
    preferences.optimizeTextPreview;
  if (
    options.constraints.inputRequired &&
    !preferences.input.trim() &&
    !inputCanBeEmpty
  ) {
    return "no_input";
  }
  if (fields.voice === "required" && !preferences.voice.trim()) {
    return "no_voice";
  }
  if (!isSpeechSynthesisVoiceSupported(preferences.voice, options.constraints)) {
    return "invalid_voice";
  }
  if (preferences.input.length > options.constraints.maxInputChars) {
    return "input_too_long";
  }
  if (
    fields.instructions !== "unsupported" &&
    options.constraints.maxInstructionsChars !== undefined &&
    preferences.instructions.length > options.constraints.maxInstructionsChars
  ) {
    return "instructions_too_long";
  }
  if (
    fields.voiceDesignPrompt === "required" &&
    !preferences.voiceDesignPrompt.trim()
  ) {
    return "voice_design_prompt_required";
  }
  if (
    fields.referenceAudio === "required" &&
    options.voiceSampleAuthorizationPending
  ) {
    return "voice_sample_authorizing";
  }
  if (
    fields.referenceAudio === "required" &&
    (!options.voiceSample ||
      (!options.voiceSample.fileToken && !options.voiceSample.sourceFile))
  ) {
    return "voice_sample_required";
  }
  if (
    preferences.outputMode === "custom_dir" &&
    !isAudioOutputDirectoryAuthorizationValid(
      options.outputDirectoryAuthorization,
      preferences.outputDir,
    )
  ) {
    return "output_dir_required";
  }
  return null;
}

export function isSpeechSynthesisVoiceSupported(
  voice: string,
  constraints: AudioSpeechRouteConstraints,
): boolean {
  const normalized = voice.trim();
  return !constraints.voices || constraints.voices.includes(normalized);
}

export function clampSpeechSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(0.25, value));
}

export function sanitizeSpeechSynthesizerPreferences(
  value: unknown,
): SpeechSynthesizerPreferences {
  const defaults = DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES;
  if (!isRecord(value)) {
    return {
      ...defaults,
      modeInputDrafts: { ...defaults.modeInputDrafts },
    };
  }
  const speechMode = isSpeechSynthesisMode(value.speechMode)
    ? value.speechMode
    : isSpeechSynthesisMode(value.mimoMode)
      ? value.mimoMode
      : defaults.speechMode;
  const input = stringOr(value.input, defaults.input);
  const modeInputDrafts = sanitizeModeInputDrafts(value.modeInputDrafts);
  if (!Object.prototype.hasOwnProperty.call(modeInputDrafts, speechMode)) {
    modeInputDrafts[speechMode] = input;
  }
  return {
    input,
    modeInputDrafts,
    speechMode,
    voice: stringOr(value.voice, defaults.voice),
    instructions: stringOr(value.instructions, defaults.instructions),
    responseFormat: isAudioSpeechResponseFormat(value.responseFormat)
      ? value.responseFormat
      : defaults.responseFormat,
    speed: clampSpeechSpeed(numberOr(value.speed, defaults.speed)),
    stream: booleanOr(value.stream, defaults.stream),
    outputMode: value.outputMode === "custom_dir" ? "custom_dir" : "temp",
    outputDir: normalizeAudioOutputDirectoryLabel(
      stringOr(value.outputDir, defaults.outputDir),
    ),
    fileNameHint: stringOr(value.fileNameHint, defaults.fileNameHint),
    styleInstruction: stringOr(
      value.styleInstruction,
      stringOr(value.mimoStyleInstruction, defaults.styleInstruction),
    ),
    voiceDesignPrompt: stringOr(
      value.voiceDesignPrompt,
      defaults.voiceDesignPrompt,
    ),
    optimizeTextPreview: booleanOr(
      value.optimizeTextPreview,
      defaults.optimizeTextPreview,
    ),
  };
}

export function inferVoiceSampleMimeType(
  fileName: string,
  explicitMimeType?: string,
): SelectedVoiceSample["mimeType"] | undefined {
  const normalized = normalizeVoiceSampleMimeType(explicitMimeType);
  if (normalized) return normalized;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return VOICE_SAMPLE_MIME_BY_EXTENSION[extension];
}

export function validateVoiceSampleFile(
  file: Pick<File, "name" | "type" | "size">,
): VoiceSampleValidationResult {
  const mimeType = inferVoiceSampleMimeType(file.name, file.type);
  if (!mimeType) {
    return { ok: false, issue: { code: "unsupported_voice_sample" } };
  }
  const base64Bytes = getBase64ByteLength(file.size);
  if (base64Bytes > MIMO_VOICE_SAMPLE_MAX_BASE64_BYTES) {
    return {
      ok: false,
      issue: {
        code: "voice_sample_too_large",
        details: {
          sizeBytes: file.size,
          base64Bytes,
          maxBase64Bytes: MIMO_VOICE_SAMPLE_MAX_BASE64_BYTES,
        },
      },
    };
  }
  return { ok: true, mimeType };
}

export function getBase64ByteLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

function buildSpeechSynthesisIntent(
  preferences: SpeechSynthesizerPreferences,
  constraints: AudioSpeechRouteConstraints,
  voiceSample: SelectedVoiceSample | null,
  styleInstruction: string,
): SpeechSynthesisIntent {
  if (constraints.mode === "preset_voice") {
    return {
      mode: "preset_voice",
      voice: preferences.voice.trim(),
      ...(constraints.fields.styleInstruction !== "unsupported" &&
          styleInstruction
        ? { styleInstruction }
        : {}),
    };
  }
  if (constraints.mode === "voice_design") {
    return {
      mode: "voice_design",
      voiceDesignPrompt: preferences.voiceDesignPrompt.trim(),
      ...(constraints.fields.optimizeTextPreview !== "unsupported"
        ? { optimizeTextPreview: preferences.optimizeTextPreview }
        : {}),
    };
  }
  return {
    mode: "voice_clone",
    voiceSampleToken: voiceSample?.fileToken ?? "",
    ...(constraints.fields.styleInstruction !== "unsupported" &&
        styleInstruction
      ? { styleInstruction }
      : {}),
  };
}

function resolveResponseFormat(
  current: AudioSpeechResponseFormat,
  constraints: AudioSpeechRouteConstraints,
  stream: boolean,
): AudioSpeechResponseFormat {
  if (stream && constraints.streamResponseFormat) {
    return constraints.streamResponseFormat;
  }
  if (constraints.finalResponseFormat) {
    return constraints.finalResponseFormat;
  }
  return constraints.responseFormats.includes(current)
    ? current
    : constraints.responseFormats[0] ?? "mp3";
}

function sanitizeModeInputDrafts(
  value: unknown,
): Partial<Record<SpeechSynthesisMode, string>> {
  const drafts: Partial<Record<SpeechSynthesisMode, string>> = {};
  if (!isRecord(value)) return drafts;
  for (const mode of SPEECH_SYNTHESIS_MODES) {
    if (typeof value[mode] === "string") drafts[mode] = value[mode];
  }
  return drafts;
}

function normalizeVoiceSampleMimeType(
  mimeType: string | undefined,
): SelectedVoiceSample["mimeType"] | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return NORMALIZED_VOICE_SAMPLE_MIME[normalized];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
