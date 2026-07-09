import type {
  AudioApiDialect,
  AudioRealtimeSessionConfig,
  AudioRealtimeSessionCloseReason,
  AudioRole,
} from "@/type/audio";

export interface RealtimeVoicePreferences {
  voice: string;
  instructions: string;
  turnDetection: "server_vad" | "manual";
  inputAudioFormat: "pcm16" | "opus";
  outputAudioFormat: "pcm16" | "opus";
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

export const DEFAULT_REALTIME_VOICE_PREFERENCES: RealtimeVoicePreferences = {
  voice: "marin",
  instructions: "",
  turnDetection: "server_vad",
  inputAudioFormat: "pcm16",
  outputAudioFormat: "pcm16",
};

export const OPENAI_REALTIME_VOICE_PRESETS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "marin",
  "sage",
  "verse",
];

export function canStartRealtimeVoice(
  dialect: AudioApiDialect | undefined,
  capabilities: string[] = [],
): boolean {
  return (
    dialect === "openai_realtime" &&
    capabilities.includes("realtime_duplex_voice")
  );
}

export function buildRealtimeVoiceSessionConfig(
  preferences: RealtimeVoicePreferences,
): AudioRealtimeSessionConfig {
  return {
    assignmentKey: "realtimeVoice",
    mode: "duplex_voice",
    ...(preferences.voice.trim() ? { voice: preferences.voice.trim() } : {}),
    ...(preferences.instructions.trim()
      ? { instructions: preferences.instructions.trim() }
      : {}),
    turnDetection: preferences.turnDetection,
    inputAudioFormat: preferences.inputAudioFormat,
    outputAudioFormat: preferences.outputAudioFormat,
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
