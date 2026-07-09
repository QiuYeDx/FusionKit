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
  partial: Partial<Record<AudioRole, string>>;

  updatePreferences: (patch: Partial<RealtimeVoicePreferences>) => void;
  setStatus: (status: RealtimeVoiceSessionStatus) => void;
  setMicState: (state: RealtimeVoiceMicState) => void;
  setSessionId: (sessionId: string | null) => void;
  setStartedAtMs: (startedAtMs: number | null) => void;
  setAssistantSpeaking: (speaking: boolean) => void;
  setActiveResponseId: (responseId: string | null) => void;
  setMuted: (muted: boolean) => void;
  setLastError: (error: RealtimeVoiceUiError | null) => void;
  setPartial: (role: AudioRole, text: string) => void;
  clearPartial: (role?: AudioRole) => void;
  addLine: (line: RealtimeVoiceLine) => void;
  clearConversation: () => void;
  resetSessionState: () => void;
}

const useRealtimeVoiceStore = create<RealtimeVoiceStore>()(
  persist(
    (set) => ({
      preferences: DEFAULT_REALTIME_VOICE_PREFERENCES,
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
      setPartial: (role, text) =>
        set((state) => ({
          partial: {
            ...state.partial,
            [role]: text,
          },
        })),
      clearPartial: (role) =>
        set((state) => {
          if (!role) return { partial: {} };
          const next = { ...state.partial };
          delete next[role];
          return { partial: next };
        }),
      addLine: (line) =>
        set((state) => ({
          lines: [...state.lines, line],
        })),
      clearConversation: () =>
        set({
          lines: [],
          partial: {},
          activeResponseId: null,
          assistantSpeaking: false,
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
      version: 1,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);

export default useRealtimeVoiceStore;
