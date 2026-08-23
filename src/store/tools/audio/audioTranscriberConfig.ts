import type {
  AudioApiDialect,
  AudioOutputPathMode,
  AudioTimestampGranularity,
  AudioTranscriptionResponseFormat,
} from "@/type/audio";
import { isAudioTranscriptionResponseFormat } from "@/type/audio";
import {
  resolveTranscriptionRouteDefinition,
  type AudioTranscriptionRouteConstraints,
} from "@/lib/audio-provider-registry";
import type {
  AudioInputSelectionSource,
  CreateAudioTranscriptionIpcRequest,
} from "@/type/audioIpc";
import {
  normalizeAudioOutputDirectoryLabel,
  type AudioOutputDirectoryAuthorization,
} from "./audioOutputDirectory";
import {
  resolveStandaloneAudioToolConfigSummary,
  type AudioToolConfigSummary,
  type StandaloneAudioToolConfigState,
} from "./audioToolConfig";

export type AudioTranscriberOutputMode = "display_only" | Extract<
  AudioOutputPathMode,
  "source_dir" | "custom_dir"
>;

export interface SelectedAudioInput {
  sourceFile: File;
  selectionSource?: AudioInputSelectionSource;
  fileName: string;
  fileToken: string | null;
  mimeType: AudioTranscriberMimeType;
  sizeBytes: number;
  expiresAt?: number;
  modifiedAt?: number;
}

export interface AudioTranscriberPreferences {
  language: string;
  responseFormat: AudioTranscriptionResponseFormat;
  timestampGranularities: AudioTimestampGranularity[];
  prompt: string;
  stream: boolean;
  outputMode: AudioTranscriberOutputMode;
  outputDir: string;
}

export interface AudioTranscriptionConfigSummary extends AudioToolConfigSummary {
  assignmentKey: "transcription";
  routeFamily?: NonNullable<
    ReturnType<typeof resolveTranscriptionRouteDefinition>
  >["family"];
  constraints?: AudioTranscriptionRouteConstraints;
}

export interface AudioTranscriberFieldVisibility {
  language: boolean;
  prompt: boolean;
  timestampGranularities: boolean;
  stream: boolean;
  responseFormatSelect: boolean;
  responseFormatSummary: boolean;
}

export type AudioTranscriberMimeType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/mp3"
  | "audio/mp4"
  | "audio/flac"
  | "audio/ogg"
  | "audio/webm";

export type AudioTranscriberFileIssueCode =
  | "file_path_unavailable"
  | "unsupported_file"
  | "unsupported_file_for_mimo"
  | "file_too_large";

export interface AudioTranscriberFileIssue {
  code: AudioTranscriberFileIssueCode;
  details?: Record<string, unknown>;
}

export type AudioTranscriberFileValidationResult =
  | { ok: true; mimeType: AudioTranscriberMimeType }
  | { ok: false; issue: AudioTranscriberFileIssue };

export const DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES: AudioTranscriberPreferences = {
  language: "auto",
  responseFormat: "json",
  timestampGranularities: [],
  prompt: "",
  stream: false,
  outputMode: "display_only",
  outputDir: "",
};

export const OPENAI_AUDIO_TRANSCRIBER_ACCEPT =
  ".wav,.wave,.mp3,.mpeg,.mpga,.m4a,.mp4,.flac,.ogg,.oga,.webm";

export const MIMO_AUDIO_TRANSCRIBER_ACCEPT = ".wav,.wave,.mp3,.mpeg,.mpga";

export const OPENAI_AUDIO_TRANSCRIBER_MAX_BYTES = 25 * 1024 * 1024;
export const MIMO_AUDIO_TRANSCRIBER_MAX_BASE64_BYTES = 10 * 1024 * 1024;

const DEFAULT_AUDIO_TRANSCRIBER_LANGUAGES = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
] as const;

const AUDIO_MIME_BY_EXTENSION: Record<string, AudioTranscriberMimeType> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  webm: "audio/webm",
};

const NORMALIZED_AUDIO_MIME: Record<string, AudioTranscriberMimeType> = {
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
  "audio/ogg": "audio/ogg",
  "audio/webm": "audio/webm",
};

const OPENAI_AUDIO_TRANSCRIBER_MIME_TYPES = new Set<AudioTranscriberMimeType>([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
]);

const MIMO_AUDIO_TRANSCRIBER_MIME_TYPES = new Set<AudioTranscriberMimeType>([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
]);

export function getAudioTranscriberAccept(
  dialect?: AudioApiDialect,
): string {
  return dialect === "mimo_chat_audio"
    ? MIMO_AUDIO_TRANSCRIBER_ACCEPT
    : OPENAI_AUDIO_TRANSCRIBER_ACCEPT;
}

export function getAudioTranscriberResponseFormats(
  constraints: AudioTranscriptionRouteConstraints,
): AudioTranscriptionResponseFormat[] {
  return [...constraints.responseFormats];
}

export function getAudioTranscriberLanguages(
  constraints: AudioTranscriptionRouteConstraints,
): string[] {
  return constraints.languages
    ? [...constraints.languages]
    : [...DEFAULT_AUDIO_TRANSCRIBER_LANGUAGES];
}

export function inferAudioTranscriberMimeType(
  fileName: string,
  explicitMimeType?: string,
): AudioTranscriberMimeType | undefined {
  const normalized = normalizeAudioTranscriberMimeType(explicitMimeType);
  if (normalized) return normalized;

  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MIME_BY_EXTENSION[extension];
}

export function isAudioTranscriberMimeAllowed(
  mimeType: AudioTranscriberMimeType,
  dialect?: AudioApiDialect,
): boolean {
  if (dialect === "mimo_chat_audio") {
    return MIMO_AUDIO_TRANSCRIBER_MIME_TYPES.has(mimeType);
  }
  return OPENAI_AUDIO_TRANSCRIBER_MIME_TYPES.has(mimeType);
}

export function getAudioTranscriberBase64ByteLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export function validateAudioTranscriberFile(
  file: Pick<File, "name" | "type" | "size">,
  dialect?: AudioApiDialect,
): AudioTranscriberFileValidationResult {
  const mimeType = inferAudioTranscriberMimeType(file.name, file.type);
  if (!mimeType) {
    return { ok: false, issue: { code: "unsupported_file" } };
  }
  if (!isAudioTranscriberMimeAllowed(mimeType, dialect)) {
    return {
      ok: false,
      issue: {
        code:
          dialect === "mimo_chat_audio"
            ? "unsupported_file_for_mimo"
            : "unsupported_file",
        details: { mimeType },
      },
    };
  }

  if (dialect === "mimo_chat_audio") {
    const base64Bytes = getAudioTranscriberBase64ByteLength(file.size);
    if (base64Bytes > MIMO_AUDIO_TRANSCRIBER_MAX_BASE64_BYTES) {
      return {
        ok: false,
        issue: {
          code: "file_too_large",
          details: {
            sizeBytes: file.size,
            base64Bytes,
            maxBase64Bytes: MIMO_AUDIO_TRANSCRIBER_MAX_BASE64_BYTES,
          },
        },
      };
    }
  } else if (file.size > OPENAI_AUDIO_TRANSCRIBER_MAX_BYTES) {
    return {
      ok: false,
      issue: {
        code: "file_too_large",
        details: {
          sizeBytes: file.size,
          maxBytes: OPENAI_AUDIO_TRANSCRIBER_MAX_BYTES,
        },
      },
    };
  }

  return { ok: true, mimeType };
}

export function resolveAudioTranscriptionConfigSummary(
  state: StandaloneAudioToolConfigState,
): AudioTranscriptionConfigSummary {
  const base = resolveStandaloneAudioToolConfigSummary(state, "transcription");
  if (base.status !== "ready" || !base.route || !base.profileId) {
    return { ...base, assignmentKey: "transcription" };
  }

  const profile = state.profiles.find(
    (candidate) => candidate.id === base.profileId,
  );
  const definition = profile
    ? resolveTranscriptionRouteDefinition({
        providerPreset: profile.providerPreset,
        transport: base.route.transport,
        model: base.route.model,
      })
    : undefined;
  if (!definition) {
    return {
      ...base,
      assignmentKey: "transcription",
      status: "audio_route_not_configured",
      capabilities: [],
    };
  }

  return {
    ...base,
    assignmentKey: "transcription",
    capabilities: [
      "file_transcription",
      ...(definition.constraints.supportsStreaming
        ? ["streaming_transcription" as const]
        : []),
    ],
    routeFamily: definition.family,
    constraints: definition.constraints,
  };
}

export function resolveAudioTranscriberFieldVisibility(
  constraints: AudioTranscriptionRouteConstraints,
  responseFormat: AudioTranscriptionResponseFormat,
): AudioTranscriberFieldVisibility {
  return {
    language:
      constraints.languages === undefined || constraints.languages.length > 0,
    prompt: constraints.supportsPrompt,
    timestampGranularities:
      constraints.supportsTimestampGranularities &&
      responseFormat === "verbose_json",
    stream: constraints.supportsStreaming,
    responseFormatSelect: constraints.responseFormats.length > 1,
    responseFormatSummary: constraints.responseFormats.length === 1,
  };
}

export function normalizeAudioTranscriberPreferences(
  preferences: AudioTranscriberPreferences,
  constraints: AudioTranscriptionRouteConstraints,
): AudioTranscriberPreferences {
  const responseFormats = getAudioTranscriberResponseFormats(constraints);
  const languages = getAudioTranscriberLanguages(constraints);
  const responseFormat = responseFormats.includes(preferences.responseFormat)
    ? preferences.responseFormat
    : responseFormats[0] ?? "json";
  const language = languages.includes(preferences.language)
    ? preferences.language
    : languages[0] ?? "auto";

  return {
    ...preferences,
    language,
    responseFormat,
    prompt: constraints.supportsPrompt ? preferences.prompt : "",
    stream: constraints.supportsStreaming && preferences.stream,
    timestampGranularities:
      constraints.supportsTimestampGranularities &&
      responseFormat === "verbose_json"
        ? preferences.timestampGranularities
        : [],
  };
}

export function sanitizeAudioTranscriberPreferences(
  value: unknown,
): AudioTranscriberPreferences {
  const record = isRecord(value) ? value : {};
  const timestampGranularities = Array.isArray(record.timestampGranularities)
    ? record.timestampGranularities.filter(isAudioTimestampGranularity)
    : DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.timestampGranularities;
  return {
    language: stringOr(
      record.language,
      DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.language,
    ),
    responseFormat: isAudioTranscriptionResponseFormat(record.responseFormat)
      ? record.responseFormat
      : DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.responseFormat,
    timestampGranularities,
    prompt: stringOr(record.prompt, DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.prompt),
    stream: booleanOr(record.stream, DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.stream),
    outputMode: isAudioTranscriberOutputMode(record.outputMode)
      ? record.outputMode
      : DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES.outputMode,
    outputDir: normalizeAudioOutputDirectoryLabel(record.outputDir),
  };
}

export function buildAudioTranscriptionRequest(options: {
  requestId: string;
  file: SelectedAudioInput & { fileToken: string };
  preferences: AudioTranscriberPreferences;
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null;
  constraints: AudioTranscriptionRouteConstraints;
}): CreateAudioTranscriptionIpcRequest {
  const preferences = normalizeAudioTranscriberPreferences(
    options.preferences,
    options.constraints,
  );
  const request: CreateAudioTranscriptionIpcRequest = {
    assignmentKey: "transcription",
    requestId: options.requestId,
    fileToken: options.file.fileToken,
    fileName: options.file.fileName,
    mimeType: options.file.mimeType,
    responseFormat: preferences.responseFormat,
  };

  if (
    preferences.language &&
    ((options.constraints.languages?.length ?? 0) > 0 ||
      preferences.language !== "auto")
  ) {
    request.language = preferences.language;
  }
  if (options.constraints.supportsPrompt && preferences.prompt.trim()) {
    request.prompt = preferences.prompt.trim();
  }
  if (
    options.constraints.supportsTimestampGranularities &&
    preferences.responseFormat === "verbose_json" &&
    preferences.timestampGranularities.length > 0
  ) {
    request.timestampGranularities = preferences.timestampGranularities;
  }
  if (options.constraints.supportsStreaming && preferences.stream) {
    request.stream = true;
  }
  if (preferences.outputMode !== "display_only") {
    request.outputPathMode = preferences.outputMode;
    if (
      preferences.outputMode === "custom_dir" &&
      options.outputDirectoryAuthorization
    ) {
      request.outputDirToken =
        options.outputDirectoryAuthorization.outputDirToken;
    }
  }

  return request;
}

function normalizeAudioTranscriberMimeType(
  mimeType: string | undefined,
): AudioTranscriberMimeType | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return NORMALIZED_AUDIO_MIME[normalized];
}

function isAudioTimestampGranularity(
  value: unknown,
): value is AudioTimestampGranularity {
  return value === "segment" || value === "word";
}

function isAudioTranscriberOutputMode(
  value: unknown,
): value is AudioTranscriberOutputMode {
  return (
    value === "display_only" ||
    value === "source_dir" ||
    value === "custom_dir"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
