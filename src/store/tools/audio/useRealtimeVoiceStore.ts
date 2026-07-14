import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioIpcError } from "@/type/audioIpc";
import type { AudioRole } from "@/type/audio";
import {
  DEFAULT_REALTIME_VOICE_PREFERENCES,
  type RealtimeVoiceLine,
  type RealtimeVoiceMicState,
  type RealtimeVoicePreferences,
  type RealtimeVoiceSessionStatus,
} from "./realtimeVoiceConfig";

export interface RealtimeVoiceUiError {
  code: AudioIpcError["code"] | "renderer_error";
  message: string;
  field?: string;
  details?: AudioIpcError["details"];
}

interface RealtimeVoiceStore {
  preferences: RealtimeVoicePreferences;
  status: RealtimeVoiceSessionStatus;
  micState: RealtimeVoiceMicState;
  sessionId: string | null;
  startedAtMs: number | null;
  assistantSpeaking: boolean;
  activeResponseId: string | null;
  muted: boolean;
  lastError: RealtimeVoiceUiError | null;
  lines: RealtimeVoiceLine[];
  partial: Record<string, { role: AudioRole; text: string }>;

  updatePreferences: (patch: Partial<RealtimeVoicePreferences>) => void;
  setStatus: (status: RealtimeVoiceSessionStatus) => void;
  setMicState: (state: RealtimeVoiceMicState) => void;
  setSessionId: (sessionId: string | null) => void;
  setStartedAtMs: (startedAtMs: number | null) => void;
  setAssistantSpeaking: (speaking: boolean) => void;
  setActiveResponseId: (responseId: string | null) => void;
  setMuted: (muted: boolean) => void;
  setLastError: (error: RealtimeVoiceUiError | null) => void;
  setPartial: (key: string, role: AudioRole, text: string) => void;
  clearPartial: (key?: string) => void;
  addLine: (line: RealtimeVoiceLine) => void;
  clearConversation: () => void;
  resetSessionState: () => void;
}

export const REALTIME_VOICE_STORE_VERSION = 4;

const useRealtimeVoiceStore = create<RealtimeVoiceStore>()(
  persist(
    (set) => ({
      preferences: { ...DEFAULT_REALTIME_VOICE_PREFERENCES },
      status: "idle",
      micState: "idle",
      sessionId: null,
      startedAtMs: null,
      assistantSpeaking: false,
      activeResponseId: null,
      muted: false,
      lastError: null,
      lines: [],
      partial: {},
      updatePreferences: (patch) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...patch,
          },
        })),
      setStatus: (status) => set({ status }),
      setMicState: (micState) => set({ micState }),
      setSessionId: (sessionId) => set({ sessionId }),
      setStartedAtMs: (startedAtMs) => set({ startedAtMs }),
      setAssistantSpeaking: (assistantSpeaking) => set({ assistantSpeaking }),
      setActiveResponseId: (activeResponseId) => set({ activeResponseId }),
      setMuted: (muted) => set({ muted }),
      setLastError: (lastError) => set({ lastError }),
      setPartial: (key, role, text) =>
        set((state) => ({
          partial: {
            ...state.partial,
            [key]: { role, text },
          },
        })),
      clearPartial: (key) =>
        set((state) => {
          if (!key) return { partial: {} };
          const next = { ...state.partial };
          delete next[key];
          return { partial: next };
        }),
      addLine: (line) =>
        set((state) => ({
          lines: [...state.lines, line].slice(-2000),
        })),
      clearConversation: () =>
        set({
          lines: [],
          partial: {},
          lastError: null,
        }),
      resetSessionState: () =>
        set({
          status: "idle",
          micState: "idle",
          sessionId: null,
          startedAtMs: null,
          activeResponseId: null,
          assistantSpeaking: false,
          muted: false,
          lastError: null,
          partial: {},
        }),
    }),
    {
      name: "fusionkit-realtime-voice",
      storage: createJSONStorage(() => localStorage),
      version: REALTIME_VOICE_STORE_VERSION,
      migrate: migrateRealtimeVoicePersistedState,
      partialize: (state) => ({
        preferences: sanitizeRealtimeVoicePreferences(state.preferences),
      }),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          preferences: sanitizeRealtimeVoicePreferences(saved.preferences),
        } as RealtimeVoiceStore;
      },
    },
  ),
);

export default useRealtimeVoiceStore;

export function migrateRealtimeVoicePersistedState(
  persisted: unknown,
  _version: number,
): Pick<RealtimeVoiceStore, "preferences"> {
  const saved = isRecord(persisted) ? persisted : {};
  return {
    preferences: sanitizeRealtimeVoicePreferences(saved.preferences),
  };
}

export function sanitizeRealtimeVoicePreferences(
  value: unknown,
): RealtimeVoicePreferences {
  const saved = isRecord(value) ? value : {};
  const format = (candidate: unknown) =>
    candidate === "pcmu" || candidate === "pcma" ? candidate : "pcm16";
  return {
    ...DEFAULT_REALTIME_VOICE_PREFERENCES,
    voice: typeof saved.voice === "string" && saved.voice.trim()
      ? saved.voice.trim().slice(0, 120)
      : DEFAULT_REALTIME_VOICE_PREFERENCES.voice,
    instructions: typeof saved.instructions === "string"
      ? saved.instructions.slice(0, 4096)
      : "",
    turnDetection: "server_vad",
    inputAudioFormat: format(saved.inputAudioFormat),
    outputAudioFormat: format(saved.outputAudioFormat),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
