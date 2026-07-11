import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioIpcError } from "@/type/audioIpc";
import type { AudioModelProfile, AudioRole } from "@/type/audio";
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
  profileSeedKey: string | null;
  profileLanguageOverridden: boolean;

  updatePreferences: (patch: Partial<RealtimeCaptionsPreferences>) => void;
  seedProfileDefaults: (
    profileId: string,
    defaults: AudioModelProfile["defaults"],
  ) => void;
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
      profileSeedKey: null,
      profileLanguageOverridden: false,

      updatePreferences: (patch) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...patch,
          },
          ...(Object.prototype.hasOwnProperty.call(patch, "language")
            ? { profileLanguageOverridden: true }
            : {}),
        })),
      seedProfileDefaults: (profileId, defaults) =>
        set((state) => {
          const profileSeedKey = `${profileId}:${defaults.language ?? ""}`;
          if (profileSeedKey === state.profileSeedKey) return state;
          const candidate = defaults.language as RealtimeCaptionsPreferences["language"];
          const language = REALTIME_CAPTIONS_LANGUAGES.includes(candidate)
            ? candidate
            : undefined;
          return {
            profileSeedKey,
            preferences:
              language && !state.profileLanguageOverridden
                ? { ...state.preferences, language }
                : state.preferences,
          };
        }),
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
      version: 3,
      migrate: (persisted) => {
        const value = persisted as { preferences?: Partial<RealtimeCaptionsPreferences> };
        return {
          preferences: {
            ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES,
            ...(value?.preferences ?? {}),
            inputAudioFormat:
              value?.preferences?.inputAudioFormat === "pcmu" ||
              value?.preferences?.inputAudioFormat === "pcma"
                ? value.preferences.inputAudioFormat
                : "pcm16",
            turnDetection: "server_vad",
            instructions: "",
            showAssistantTranscript: false,
          },
          profileSeedKey: null,
          profileLanguageOverridden:
            value?.preferences?.language !== undefined &&
            value.preferences.language !== "auto",
        };
      },
      partialize: (state) => ({
        preferences: state.preferences,
        profileSeedKey: state.profileSeedKey,
        profileLanguageOverridden: state.profileLanguageOverridden,
      }),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          ...saved,
          preferences: sanitizeCaptionsPreferences(saved.preferences),
          profileSeedKey:
            typeof saved.profileSeedKey === "string" ? saved.profileSeedKey : null,
          profileLanguageOverridden: saved.profileLanguageOverridden === true,
        } as RealtimeCaptionsStore;
      },
    },
  ),
);

export default useRealtimeCaptionsStore;

function sanitizeCaptionsPreferences(value: unknown): RealtimeCaptionsPreferences {
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
