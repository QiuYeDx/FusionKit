import type {
  AudioRealtimeSessionCloseReason,
  AudioRealtimeSessionConfig,
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

export type RealtimeVoiceAudioFormat = "pcm16" | "pcmu" | "pcma";

export interface RealtimeVoicePreferences {
  voice: string;
  instructions: string;
  turnDetection: "server_vad" | "manual";
  inputAudioFormat: RealtimeVoiceAudioFormat;
  outputAudioFormat: RealtimeVoiceAudioFormat;
}

export type RealtimeVoiceSessionStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "stopping"
  | "completed"
  | "failed";

export type RealtimeVoiceMicState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "muted";

export interface RealtimeVoiceLine {
  id: string;
  role: AudioRole;
  text: string;
  final: boolean;
  createdAtMs: number;
}

export interface RealtimeVoiceConfigSummary extends AudioToolConfigSummary {
  constraints?: AudioRealtimeRouteConstraints;
  voices: string[];
  inputAudioFormats: RealtimeVoiceAudioFormat[];
  outputAudioFormats: RealtimeVoiceAudioFormat[];
}

export const DEFAULT_REALTIME_VOICE_PREFERENCES: RealtimeVoicePreferences = {
  voice: "marin",
  instructions: "",
  turnDetection: "server_vad",
  inputAudioFormat: "pcm16",
  outputAudioFormat: "pcm16",
};

export const REALTIME_VOICE_AUDIO_FORMATS: RealtimeVoiceAudioFormat[] = [
  "pcm16",
  "pcmu",
  "pcma",
];

export function resolveRealtimeVoiceConfigSummary(
  state: StandaloneAudioToolConfigState,
): RealtimeVoiceConfigSummary {
  const base = resolveStandaloneAudioToolConfigSummary(
    state,
    "realtimeVoice",
  );
  const fallback: RealtimeVoiceConfigSummary = {
    ...base,
    voices: [],
    inputAudioFormats: [],
    outputAudioFormats: [],
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
    assignmentKey: "realtimeVoice",
    transport: base.route.transport,
    model: base.route.model,
  });
  if (!definition || definition.constraints.mode !== "duplex_voice") {
    return {
      ...fallback,
      status: "audio_route_not_configured",
      capabilities: [],
    };
  }

  return {
    ...base,
    constraints: definition.constraints,
    voices: normalizeRealtimeVoices(definition.constraints.voices),
    inputAudioFormats: normalizeRealtimeAudioFormats(
      definition.constraints.inputAudioFormats,
    ),
    outputAudioFormats: normalizeRealtimeAudioFormats(
      definition.constraints.outputAudioFormats,
    ),
  };
}

export function getRealtimeVoiceRouteIdentity(
  summary: RealtimeVoiceConfigSummary,
): string {
  return [
    summary.status,
    summary.profileId ?? "",
    summary.providerPreset ?? "",
    summary.route?.transport ?? "",
    summary.route?.model ?? "",
    summary.route?.enabled === true ? "enabled" : "disabled",
  ].join(":");
}

export function normalizeRealtimeVoicePreferences(
  preferences: RealtimeVoicePreferences,
  constraints?: AudioRealtimeRouteConstraints,
): RealtimeVoicePreferences {
  const voices = normalizeRealtimeVoices(constraints?.voices);
  const requestedVoice = preferences.voice.trim();
  const voice = voices.length === 0
    ? requestedVoice || DEFAULT_REALTIME_VOICE_PREFERENCES.voice
    : voices.includes(requestedVoice)
      ? requestedVoice
      : voices.includes(DEFAULT_REALTIME_VOICE_PREFERENCES.voice)
        ? DEFAULT_REALTIME_VOICE_PREFERENCES.voice
        : voices[0];
  const inputAudioFormats = normalizeRealtimeAudioFormats(
    constraints?.inputAudioFormats,
  );
  const outputAudioFormats = normalizeRealtimeAudioFormats(
    constraints?.outputAudioFormats,
  );

  return {
    ...preferences,
    voice,
    instructions: constraints?.supportsInstructions
      ? preferences.instructions
      : "",
    turnDetection: "server_vad",
    inputAudioFormat: resolveAudioFormat(
      preferences.inputAudioFormat,
      inputAudioFormats,
    ),
    outputAudioFormat: resolveAudioFormat(
      preferences.outputAudioFormat,
      outputAudioFormats,
    ),
  };
}

export function buildRealtimeVoiceSessionConfig(
  preferences: RealtimeVoicePreferences,
  constraints: AudioRealtimeRouteConstraints,
): AudioRealtimeSessionConfig {
  const normalized = normalizeRealtimeVoicePreferences(
    preferences,
    constraints,
  );
  return {
    assignmentKey: "realtimeVoice",
    mode: "duplex_voice",
    ...(constraints.supportsVoice && normalized.voice
      ? { voice: normalized.voice }
      : {}),
    ...(constraints.supportsInstructions && normalized.instructions.trim()
      ? { instructions: normalized.instructions.trim() }
      : {}),
    turnDetection: "server_vad",
    inputAudioFormat: normalized.inputAudioFormat,
    outputAudioFormat: normalized.outputAudioFormat,
  };
}

export function createRealtimeVoiceLine(args: {
  role: AudioRole;
  text: string;
  final?: boolean;
  id?: string;
  createdAtMs?: number;
}): RealtimeVoiceLine {
  const createdAtMs = args.createdAtMs ?? Date.now();
  return {
    id: args.id ?? `voice_${createdAtMs}_${Math.random().toString(36).slice(2, 8)}`,
    role: args.role,
    text: args.text,
    final: args.final ?? true,
    createdAtMs,
  };
}

export function getRealtimeVoiceCloseStatus(
  reason: AudioRealtimeSessionCloseReason,
): RealtimeVoiceSessionStatus {
  return reason === "error" ? "failed" : "completed";
}

function normalizeRealtimeVoices(
  values: readonly string[] | undefined,
): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeRealtimeAudioFormats(
  values: readonly string[] | undefined,
): RealtimeVoiceAudioFormat[] {
  if (!values) return [];
  return values.filter(isRealtimeVoiceAudioFormat);
}

function resolveAudioFormat(
  requested: RealtimeVoiceAudioFormat,
  available: RealtimeVoiceAudioFormat[],
): RealtimeVoiceAudioFormat {
  if (available.includes(requested)) return requested;
  if (available.includes("pcm16")) return "pcm16";
  return available[0] ?? "pcm16";
}

function isRealtimeVoiceAudioFormat(
  value: string,
): value is RealtimeVoiceAudioFormat {
  return REALTIME_VOICE_AUDIO_FORMATS.includes(
    value as RealtimeVoiceAudioFormat,
  );
}
