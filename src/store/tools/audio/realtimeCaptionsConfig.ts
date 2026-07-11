import type {
  AudioApiDialect,
  AudioRealtimeSessionConfig,
  AudioRealtimeSessionCloseReason,
  AudioRole,
} from "@/type/audio";

export type RealtimeCaptionsLanguage =
  | "auto"
  | "zh"
  | "en"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es";

export type RealtimeCaptionsOutputFormat = "txt" | "srt";

export type RealtimeCaptionsMode =
  | "openai_realtime"
  | "chunked_near_realtime"
  | "unsupported";

export interface RealtimeCaptionsPreferences {
  language: RealtimeCaptionsLanguage;
  instructions: string;
  inputAudioFormat: "pcm16" | "pcmu" | "pcma";
  turnDetection: "server_vad" | "manual";
  outputFormat: RealtimeCaptionsOutputFormat;
  showAssistantTranscript: boolean;
}

export interface RealtimeCaptionLine {
  id: string;
  role: AudioRole;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
}

export type RealtimeCaptionsMicState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "muted";

export type RealtimeCaptionsSessionStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "listening"
  | "stopping"
  | "completed"
  | "failed";

export const DEFAULT_REALTIME_CAPTIONS_PREFERENCES: RealtimeCaptionsPreferences = {
  language: "auto",
  instructions: "",
  inputAudioFormat: "pcm16",
  turnDetection: "server_vad",
  outputFormat: "txt",
  showAssistantTranscript: false,
};

export const REALTIME_CAPTIONS_LANGUAGES: RealtimeCaptionsLanguage[] = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
];

export const REALTIME_CAPTIONS_OUTPUT_FORMATS: RealtimeCaptionsOutputFormat[] = [
  "txt",
  "srt",
];

export function resolveRealtimeCaptionsMode(
  dialect: AudioApiDialect | undefined,
  capabilities: string[] = [],
): RealtimeCaptionsMode {
  if (dialect === "openai_realtime") {
    return capabilities.includes("realtime_transcription")
      ? "openai_realtime"
      : "unsupported";
  }

  if (
    (dialect === "mimo_chat_audio" || dialect === "openai_audio") &&
    capabilities.includes("streaming_transcription")
  ) {
    return "chunked_near_realtime";
  }

  return "unsupported";
}

export function canStartOpenAIRealtimeCaptions(
  dialect: AudioApiDialect | undefined,
  capabilities: string[] = [],
): boolean {
  return resolveRealtimeCaptionsMode(dialect, capabilities) === "openai_realtime";
}

export function normalizeRealtimeCaptionsPreferences(
  preferences: RealtimeCaptionsPreferences,
  dialect?: AudioApiDialect,
): RealtimeCaptionsPreferences {
  if (dialect !== "openai_realtime") {
    return {
      ...preferences,
      inputAudioFormat: "pcm16",
      turnDetection: "server_vad",
      showAssistantTranscript: false,
    };
  }
  return {
    ...preferences,
    // Realtime transcription sessions do not produce assistant responses, and
    // gpt-realtime-whisper does not accept a prompt today.
    instructions: "",
    showAssistantTranscript: false,
    turnDetection: "server_vad",
  };
}

export function buildRealtimeCaptionsSessionConfig(
  preferences: RealtimeCaptionsPreferences,
  dialect?: AudioApiDialect,
): AudioRealtimeSessionConfig {
  const normalized = normalizeRealtimeCaptionsPreferences(preferences, dialect);
  return {
    assignmentKey: "realtimeCaptions",
    mode: "caption",
    ...(normalized.language !== "auto"
      ? { language: normalized.language }
      : {}),
    ...(normalized.instructions.trim()
      ? { instructions: normalized.instructions.trim() }
      : {}),
    inputAudioFormat: normalized.inputAudioFormat,
    turnDetection: normalized.turnDetection,
  };
}

export function formatRealtimeCaptionLines(
  lines: RealtimeCaptionLine[],
  format: RealtimeCaptionsOutputFormat,
): string {
  if (format === "srt") {
    return lines
      .map((line, index) => [
        String(index + 1),
        `${formatSrtTime(line.startedAtMs)} --> ${formatSrtTime(line.endedAtMs)}`,
        line.text.trim(),
      ].join("\n"))
      .join("\n\n");
  }

  return lines
    .map((line) => {
      const rolePrefix = line.role === "assistant" ? "[assistant] " : "";
      return `${rolePrefix}${line.text.trim()}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function createRealtimeCaptionLine(args: {
  role: AudioRole;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  id?: string;
}): RealtimeCaptionLine {
  return {
    id: args.id ?? `caption_${args.endedAtMs}_${Math.random().toString(36).slice(2, 8)}`,
    role: args.role,
    text: args.text,
    startedAtMs: Math.max(0, args.startedAtMs),
    endedAtMs: Math.max(args.startedAtMs, args.endedAtMs),
  };
}

export function getRealtimeSessionCloseStatus(
  reason: AudioRealtimeSessionCloseReason,
): RealtimeCaptionsSessionStatus {
  return reason === "error" ? "failed" : "completed";
}

function formatSrtTime(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `,${String(millis).padStart(3, "0")}`;
}
