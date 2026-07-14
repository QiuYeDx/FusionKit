import type {
  AudioRealtimeSessionConfig,
  AudioRealtimeSessionCloseReason,
  AudioRole,
} from "@/type/audio";
import {
  resolveRealtimeRouteDefinition,
  type AudioRealtimeRouteConstraints,
} from "@/lib/audio-provider-registry";
import {
  resolveStandaloneAudioToolConfigSummary,
  type AudioToolConfigSummary,
  type StandaloneAudioToolConfigState,
} from "./audioToolConfig";

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
export type RealtimeCaptionsInputAudioFormat = "pcm16" | "pcmu" | "pcma";

export type RealtimeCaptionsMode =
  | "openai_realtime"
  | "chunked_near_realtime"
  | "unsupported";

export interface RealtimeCaptionsPreferences {
  language: RealtimeCaptionsLanguage;
  instructions: string;
  inputAudioFormat: RealtimeCaptionsInputAudioFormat;
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

export interface RealtimeCaptionsConfigSummary
  extends AudioToolConfigSummary {
  mode: RealtimeCaptionsMode;
  constraints?: AudioRealtimeRouteConstraints;
  languages: RealtimeCaptionsLanguage[];
  inputAudioFormats: RealtimeCaptionsInputAudioFormat[];
}

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

export const REALTIME_CAPTIONS_INPUT_AUDIO_FORMATS:
  RealtimeCaptionsInputAudioFormat[] = ["pcm16", "pcmu", "pcma"];

export function resolveRealtimeCaptionsConfigSummary(
  state: StandaloneAudioToolConfigState,
): RealtimeCaptionsConfigSummary {
  const base = resolveStandaloneAudioToolConfigSummary(
    state,
    "realtimeCaptions",
  );
  const fallback: RealtimeCaptionsConfigSummary = {
    ...base,
    mode: "unsupported",
    languages: [],
    inputAudioFormats: [],
  };
  if (
    base.status !== "ready" ||
    !base.providerPreset ||
    !base.route
  ) {
    return fallback;
  }

  const definition = resolveRealtimeRouteDefinition({
    providerPreset: base.providerPreset,
    assignmentKey: "realtimeCaptions",
    transport: base.route.transport,
    model: base.route.model,
  });
  if (!definition) {
    return {
      ...fallback,
      status: "audio_route_not_configured",
      capabilities: [],
    };
  }

  const mode = definition.constraints.mode === "caption"
    ? "openai_realtime"
    : definition.constraints.mode === "chunked_near_realtime"
      ? "chunked_near_realtime"
      : "unsupported";
  if (mode === "unsupported") {
    return {
      ...fallback,
      status: "audio_route_not_configured",
      capabilities: [],
    };
  }

  return {
    ...base,
    mode,
    constraints: definition.constraints,
    languages: normalizeRealtimeCaptionLanguages(
      definition.constraints.languages,
    ),
    inputAudioFormats: normalizeRealtimeInputAudioFormats(
      definition.constraints.inputAudioFormats,
    ),
  };
}

export function getRealtimeCaptionsRouteIdentity(
  summary: RealtimeCaptionsConfigSummary,
): string {
  return [
    summary.status,
    summary.profileId ?? "",
    summary.providerPreset ?? "",
    summary.route?.transport ?? "",
    summary.route?.model ?? "",
    summary.route?.enabled === true ? "enabled" : "disabled",
    summary.mode,
  ].join(":");
}

export function normalizeRealtimeCaptionsPreferences(
  preferences: RealtimeCaptionsPreferences,
  constraints?: AudioRealtimeRouteConstraints,
): RealtimeCaptionsPreferences {
  const languages = normalizeRealtimeCaptionLanguages(constraints?.languages);
  const inputAudioFormats = normalizeRealtimeInputAudioFormats(
    constraints?.inputAudioFormats,
  );
  const language = languages.includes(preferences.language)
    ? preferences.language
    : languages.includes("auto")
      ? "auto"
      : languages[0] ?? "auto";
  const inputAudioFormat = inputAudioFormats.includes(
    preferences.inputAudioFormat,
  )
    ? preferences.inputAudioFormat
    : inputAudioFormats[0] ?? "pcm16";
  return {
    ...preferences,
    language,
    inputAudioFormat,
    instructions: constraints?.supportsInstructions
      ? preferences.instructions
      : "",
    showAssistantTranscript: false,
    turnDetection: "server_vad",
  };
}

export function buildRealtimeCaptionsSessionConfig(
  preferences: RealtimeCaptionsPreferences,
  constraints: AudioRealtimeRouteConstraints,
): AudioRealtimeSessionConfig {
  const normalized = normalizeRealtimeCaptionsPreferences(
    preferences,
    constraints,
  );
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

function normalizeRealtimeCaptionLanguages(
  values: readonly string[] | undefined,
): RealtimeCaptionsLanguage[] {
  if (!values) return [...REALTIME_CAPTIONS_LANGUAGES];
  return values.filter(isRealtimeCaptionsLanguage);
}

function normalizeRealtimeInputAudioFormats(
  values: readonly string[] | undefined,
): RealtimeCaptionsInputAudioFormat[] {
  if (!values) return [];
  return values.filter(isRealtimeCaptionsInputAudioFormat);
}

function isRealtimeCaptionsLanguage(
  value: string,
): value is RealtimeCaptionsLanguage {
  return REALTIME_CAPTIONS_LANGUAGES.includes(
    value as RealtimeCaptionsLanguage,
  );
}

function isRealtimeCaptionsInputAudioFormat(
  value: string,
): value is RealtimeCaptionsInputAudioFormat {
  return REALTIME_CAPTIONS_INPUT_AUDIO_FORMATS.includes(
    value as RealtimeCaptionsInputAudioFormat,
  );
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
