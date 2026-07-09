import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioIpcError } from "@/type/audioIpc";
import type { AudioRole } from "@/type/audio";
import {
  DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
  type RealtimeCaptionLine,
  type RealtimeCaptionsMicState,
  type RealtimeCaptionsPreferences,
  type RealtimeCaptionsSessionStatus,
} from "./realtimeCaptionsConfig";

export interface RealtimeCaptionsUiError {
  code: AudioIpcError["code"] | "renderer_error";
  message: string;
  field?: string;
  details?: AudioIpcError["details"];
}

interface RealtimeCaptionsStore {
  preferences: RealtimeCaptionsPreferences;
  status: RealtimeCaptionsSessionStatus;
  micState: RealtimeCaptionsMicState;
  sessionId: string | null;
  startedAtMs: number | null;
  lastError: RealtimeCaptionsUiError | null;
  lines: RealtimeCaptionLine[];
  partial: Partial<Record<AudioRole, string>>;

  updatePreferences: (patch: Partial<RealtimeCaptionsPreferences>) => void;
  setStatus: (status: RealtimeCaptionsSessionStatus) => void;
  setMicState: (state: RealtimeCaptionsMicState) => void;
  setSessionId: (sessionId: string | null) => void;
  setStartedAtMs: (startedAtMs: number | null) => void;
  setLastError: (error: RealtimeCaptionsUiError | null) => void;
  setPartial: (role: AudioRole, text: string) => void;
  clearPartial: (role?: AudioRole) => void;
  addLine: (line: RealtimeCaptionLine) => void;
  clearTranscript: () => void;
  resetSessionState: () => void;
}

const useRealtimeCaptionsStore = create<RealtimeCaptionsStore>()(
  persist(
    (set) => ({
      preferences: DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
      status: "idle",
      micState: "idle",
      sessionId: null,
      startedAtMs: null,
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
      clearTranscript: () =>
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
          lastError: null,
          partial: {},
        }),
    }),
    {
      name: "fusionkit-realtime-captions",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);

export default useRealtimeCaptionsStore;
