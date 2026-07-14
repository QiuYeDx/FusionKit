import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioIpcError } from "@/type/audioIpc";
import type { AudioRole } from "@/type/audio";
import {
  DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
  REALTIME_CAPTIONS_LANGUAGES,
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
  partial: Record<string, { role: AudioRole; text: string }>;

  updatePreferences: (patch: Partial<RealtimeCaptionsPreferences>) => void;
  setStatus: (status: RealtimeCaptionsSessionStatus) => void;
  setMicState: (state: RealtimeCaptionsMicState) => void;
  setSessionId: (sessionId: string | null) => void;
  setStartedAtMs: (startedAtMs: number | null) => void;
  setLastError: (error: RealtimeCaptionsUiError | null) => void;
  setPartial: (key: string, role: AudioRole, text: string) => void;
  clearPartial: (key?: string) => void;
  addLine: (line: RealtimeCaptionLine) => void;
  clearTranscript: () => void;
  resetSessionState: () => void;
}

export const REALTIME_CAPTIONS_STORE_VERSION = 4;

const useRealtimeCaptionsStore = create<RealtimeCaptionsStore>()(
  persist(
    (set) => ({
      preferences: { ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES },
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
      version: REALTIME_CAPTIONS_STORE_VERSION,
      migrate: migrateRealtimeCaptionsPersistedState,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          preferences: sanitizeRealtimeCaptionsPreferences(saved.preferences),
        } as RealtimeCaptionsStore;
      },
    },
  ),
);

export default useRealtimeCaptionsStore;

export function migrateRealtimeCaptionsPersistedState(
  persisted: unknown,
  _version: number,
): Pick<RealtimeCaptionsStore, "preferences"> {
  const saved = isRecord(persisted) ? persisted : {};
  return {
    preferences: sanitizeRealtimeCaptionsPreferences(saved.preferences),
  };
}

export function sanitizeRealtimeCaptionsPreferences(
  value: unknown,
): RealtimeCaptionsPreferences {
  const saved = isRecord(value) ? value : {};
  const language = saved.language as RealtimeCaptionsPreferences["language"];
  return {
    ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
    language: REALTIME_CAPTIONS_LANGUAGES.includes(language) ? language : "auto",
    inputAudioFormat:
      saved.inputAudioFormat === "pcmu" || saved.inputAudioFormat === "pcma"
        ? saved.inputAudioFormat
        : "pcm16",
    turnDetection: "server_vad",
    outputFormat: saved.outputFormat === "srt" ? "srt" : "txt",
    instructions: "",
    showAssistantTranscript: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
