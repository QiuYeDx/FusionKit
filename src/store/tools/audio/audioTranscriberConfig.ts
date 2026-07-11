import type {
  AudioApiDialect,
  AudioModelProfile,
  AudioOutputPathMode,
  AudioTimestampGranularity,
  AudioTranscriptionModelContext,
  AudioTranscriptionModelMatrix,
  AudioTranscriptionResponseFormat,
} from "@/type/audio";
import { resolveAudioTranscriptionModelMatrix } from "@/type/audio";
import type { CreateAudioTranscriptionIpcRequest } from "@/type/audioIpc";
import type { Model } from "@/type/model";

export type AudioTranscriberOutputMode = "display_only" | Extract<
  AudioOutputPathMode,
  "source_dir" | "custom_dir"
>;

export interface SelectedAudioInput {
  fileName: string;
  filePath: string;
  fileToken: string;
  mimeType: AudioTranscriberMimeType;
  sizeBytes: number;
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

export type AudioTranscriberProfileDefaultKey = "language" | "responseFormat";

export type AudioTranscriberProfileDefaultOverrides = Partial<
  Record<AudioTranscriberProfileDefaultKey, true>
>;

export interface AudioTranscriberProfileContext
  extends AudioTranscriptionModelContext {}

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

const MIMO_AUDIO_TRANSCRIBER_LANGUAGES = new Set(["auto", "zh", "en"]);

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
  context?: AudioApiDialect | AudioTranscriberProfileContext,
): AudioTranscriptionResponseFormat[] {
  return resolveAudioTranscriberModelMatrix(context).responseFormats;
}

export function getAudioTranscriberLanguages(
  context?: AudioApiDialect | AudioTranscriberProfileContext,
): string[] {
  const dialect = resolveAudioTranscriberProfileContext(context).audioDialect;
  if (dialect === "mimo_chat_audio") {
    return ["auto", "zh", "en"];
  }
  return ["auto", "zh", "en", "ja", "ko", "fr", "de", "es"];
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

export function normalizeAudioTranscriberPreferencesForDialect(
  preferences: AudioTranscriberPreferences,
  context?: AudioApiDialect | AudioTranscriberProfileContext,
): AudioTranscriberPreferences {
  const profileContext = resolveAudioTranscriberProfileContext(context);
  const dialect = profileContext.audioDialect;
  const matrix = resolveAudioTranscriptionModelMatrix(profileContext);
  const responseFormats = matrix.responseFormats;
  const languages = getAudioTranscriberLanguages(profileContext);
  const responseFormat = responseFormats.includes(preferences.responseFormat)
    ? preferences.responseFormat
    : responseFormats[0];
  const language = languages.includes(preferences.language)
    ? preferences.language
    : "auto";

  if (dialect === "mimo_chat_audio") {
    return {
      ...preferences,
      language: MIMO_AUDIO_TRANSCRIBER_LANGUAGES.has(language)
        ? language
        : "auto",
      responseFormat,
      timestampGranularities: [],
      prompt: "",
      stream: matrix.supportsStream && preferences.stream,
    };
  }

  return {
    ...preferences,
    language,
    responseFormat,
    prompt: matrix.supportsPrompt ? preferences.prompt : "",
    stream: matrix.supportsStream && preferences.stream,
    timestampGranularities:
      matrix.supportsTimestampGranularities && responseFormat === "verbose_json"
        ? preferences.timestampGranularities
        : [],
  };
}

export function resolveAudioTranscriberModelMatrix(
  context?: AudioApiDialect | AudioTranscriberProfileContext,
): AudioTranscriptionModelMatrix {
  return resolveAudioTranscriptionModelMatrix(
    resolveAudioTranscriberProfileContext(context),
  );
}

export function seedAudioTranscriberPreferencesFromProfile(
  preferences: AudioTranscriberPreferences,
  defaults: AudioModelProfile["defaults"],
  overrides: AudioTranscriberProfileDefaultOverrides,
): AudioTranscriberPreferences {
  return {
    ...preferences,
    ...(!overrides.language && defaults.language
      ? { language: defaults.language }
      : {}),
    ...(!overrides.responseFormat && defaults.transcriptionResponseFormat
      ? { responseFormat: defaults.transcriptionResponseFormat }
      : {}),
  };
}

export function createAudioTranscriberProfileSeedKey(
  profileId: string,
  defaults: AudioModelProfile["defaults"],
): string {
  return JSON.stringify([
    profileId,
    defaults.language ?? null,
    defaults.transcriptionResponseFormat ?? null,
  ]);
}

export function buildAudioTranscriptionRequest(options: {
  requestId: string;
  file: SelectedAudioInput;
  preferences: AudioTranscriberPreferences;
  dialect?: AudioApiDialect;
  provider?: Model;
  modelKey?: string;
}): CreateAudioTranscriptionIpcRequest {
  const profileContext: AudioTranscriberProfileContext = {
    audioDialect: options.dialect,
    provider: options.provider,
    modelKey: options.modelKey,
  };
  const matrix = resolveAudioTranscriptionModelMatrix(profileContext);
  const preferences = normalizeAudioTranscriberPreferencesForDialect(
    options.preferences,
    profileContext,
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
    (options.dialect === "mimo_chat_audio" || preferences.language !== "auto")
  ) {
    request.language = preferences.language;
  }
  if (matrix.supportsPrompt && preferences.prompt.trim()) {
    request.prompt = preferences.prompt.trim();
  }
  if (
    matrix.supportsTimestampGranularities &&
    preferences.responseFormat === "verbose_json" &&
    preferences.timestampGranularities.length > 0
  ) {
    request.timestampGranularities = preferences.timestampGranularities;
  }
  if (matrix.supportsStream && preferences.stream) {
    request.stream = true;
  }
  if (preferences.outputMode !== "display_only") {
    request.outputPathMode = preferences.outputMode;
    if (preferences.outputMode === "custom_dir") {
      request.outputDir = preferences.outputDir;
    }
  }

  return request;
}

function resolveAudioTranscriberProfileContext(
  context?: AudioApiDialect | AudioTranscriberProfileContext,
): AudioTranscriberProfileContext {
  return typeof context === "string" ? { audioDialect: context } : context ?? {};
}

function normalizeAudioTranscriberMimeType(
  mimeType: string | undefined,
): AudioTranscriberMimeType | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return NORMALIZED_AUDIO_MIME[normalized];
}
