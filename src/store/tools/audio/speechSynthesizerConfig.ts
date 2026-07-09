import type {
  AudioApiDialect,
  AudioSpeechResponseFormat,
  CreateSpeechSynthesisRequest,
  MimoSpeechSynthesisMode,
} from "@/type/audio";

export type SpeechSynthesizerOutputMode = "temp" | "custom_dir";

export interface SelectedVoiceSample {
  fileName: string;
  filePath: string;
  mimeType: "audio/wav" | "audio/mpeg" | "audio/mp3";
  sizeBytes: number;
  modifiedAt?: number;
}

export interface SpeechSynthesizerPreferences {
  input: string;
  voice: string;
  instructions: string;
  responseFormat: AudioSpeechResponseFormat;
  speed: number;
  stream: boolean;
  outputMode: SpeechSynthesizerOutputMode;
  outputDir: string;
  fileNameHint: string;
  mimoMode: MimoSpeechSynthesisMode;
  mimoStyleInstruction: string;
  voiceDesignPrompt: string;
  optimizeTextPreview: boolean;
  audioTagsEnabled: boolean;
}

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

export const DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES: SpeechSynthesizerPreferences = {
  input: "",
  voice: "alloy",
  instructions: "",
  responseFormat: "mp3",
  speed: 1,
  stream: false,
  outputMode: "temp",
  outputDir: "",
  fileNameHint: "",
  mimoMode: "preset_voice",
  mimoStyleInstruction: "",
  voiceDesignPrompt: "",
  optimizeTextPreview: false,
  audioTagsEnabled: false,
};

export const MIMO_TTS_MODEL_BY_MODE: Record<MimoSpeechSynthesisMode, string> = {
  preset_voice: "mimo-v2.5-tts",
  voice_design: "mimo-v2.5-tts-voicedesign",
  voice_clone: "mimo-v2.5-tts-voiceclone",
};

export const MIMO_VOICE_SAMPLE_ACCEPT = ".wav,.wave,.mp3,.mpeg,.mpga";
export const MIMO_VOICE_SAMPLE_MAX_BASE64_BYTES = 10 * 1024 * 1024;

const OPENAI_SPEECH_FORMATS: AudioSpeechResponseFormat[] = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
];

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

export function getSpeechSynthesizerResponseFormats(
  dialect?: AudioApiDialect,
  stream = false,
): AudioSpeechResponseFormat[] {
  if (dialect === "mimo_chat_audio") {
    return stream ? ["pcm16"] : ["wav"];
  }
  return OPENAI_SPEECH_FORMATS;
}

export function canStreamSpeechSynthesis(
  dialect: AudioApiDialect | undefined,
  capabilities: string[],
): boolean {
  return (
    dialect === "mimo_chat_audio" &&
    capabilities.includes("streaming_speech_synthesis")
  );
}

export function getMimoModeForModel(
  modelKey: string | undefined,
): MimoSpeechSynthesisMode | undefined {
  const entry = Object.entries(MIMO_TTS_MODEL_BY_MODE).find(
    ([, model]) => model === modelKey,
  );
  return entry?.[0] as MimoSpeechSynthesisMode | undefined;
}

export function isMimoModeCompatibleWithModel(
  mode: MimoSpeechSynthesisMode,
  modelKey: string | undefined,
): boolean {
  return MIMO_TTS_MODEL_BY_MODE[mode] === modelKey;
}

export function normalizeSpeechSynthesizerPreferences(
  preferences: SpeechSynthesizerPreferences,
  dialect?: AudioApiDialect,
  capabilities: string[] = [],
): SpeechSynthesizerPreferences {
  if (dialect === "mimo_chat_audio") {
    const stream = preferences.stream &&
      canStreamSpeechSynthesis(dialect, capabilities);
    return {
      ...preferences,
      stream,
      responseFormat: stream ? "pcm16" : "wav",
      speed: 1,
    };
  }

  const responseFormats = getSpeechSynthesizerResponseFormats(dialect, false);
  return {
    ...preferences,
    stream: false,
    responseFormat: responseFormats.includes(preferences.responseFormat)
      ? preferences.responseFormat
      : "mp3",
    mimoStyleInstruction: "",
    voiceDesignPrompt: "",
    optimizeTextPreview: false,
    audioTagsEnabled: false,
  };
}

export function buildSpeechSynthesisRequest(options: {
  requestId: string;
  preferences: SpeechSynthesizerPreferences;
  dialect?: AudioApiDialect;
  capabilities?: string[];
  voiceSample?: SelectedVoiceSample | null;
}): CreateSpeechSynthesisRequest {
  const preferences = normalizeSpeechSynthesizerPreferences(
    options.preferences,
    options.dialect,
    options.capabilities ?? [],
  );
  const request: CreateSpeechSynthesisRequest = {
    assignmentKey: "speechSynthesis",
    requestId: options.requestId,
    input: preferences.input,
    responseFormat: preferences.responseFormat,
    ...(preferences.outputMode === "custom_dir"
      ? {
          outputPathMode: "custom_dir",
          outputDir: preferences.outputDir,
        }
      : { outputPathMode: "temp" }),
    ...(preferences.fileNameHint.trim()
      ? { fileNameHint: preferences.fileNameHint.trim() }
      : {}),
  };

  if (options.dialect === "mimo_chat_audio") {
    request.stream = preferences.stream;
    if (preferences.mimoMode === "preset_voice") {
      request.voice = preferences.voice.trim() || "mimo_default";
    }
    const styleInstruction = preferences.mimoStyleInstruction.trim();
    const voiceDesignPrompt = preferences.voiceDesignPrompt.trim();
    request.mimoOptions = {
      mode: preferences.mimoMode,
      ...(styleInstruction ? { styleInstruction } : {}),
      ...(voiceDesignPrompt ? { voiceDesignPrompt } : {}),
      ...(preferences.optimizeTextPreview
        ? { optimizeTextPreview: true }
        : {}),
      ...(preferences.audioTagsEnabled ? { audioTagsEnabled: true } : {}),
      ...(preferences.mimoMode === "voice_clone" && options.voiceSample
        ? {
            voiceSamplePath: options.voiceSample.filePath,
            voiceSampleMime: options.voiceSample.mimeType,
          }
        : {}),
    };
    return request;
  }

  request.voice = preferences.voice.trim();
  if (preferences.instructions.trim()) {
    request.instructions = preferences.instructions.trim();
  }
  if (preferences.speed !== 1) {
    request.speed = preferences.speed;
  }
  return request;
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

function normalizeVoiceSampleMimeType(
  mimeType: string | undefined,
): SelectedVoiceSample["mimeType"] | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return NORMALIZED_VOICE_SAMPLE_MIME[normalized];
}
