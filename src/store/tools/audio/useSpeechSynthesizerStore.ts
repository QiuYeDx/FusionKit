import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioModelProfile, SpeechSynthesisResult } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
  sanitizeSpeechSynthesizerPreferences,
  type SelectedVoiceSample,
  type SpeechSynthesizerPreferences,
} from "./speechSynthesizerConfig";

export type SpeechSynthesizerStatus =
  | "idle"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export interface SpeechSynthesizerUiError {
  code: AudioIpcError["code"] | "renderer_error";
  message: string;
  field?: string;
  details?: AudioIpcError["details"];
}

export interface SpeechSynthesisStreamUiStats {
  firstChunkLatencyMs?: number;
  chunkCount: number;
  totalBytes: number;
  streamMode?: "incremental" | "final_only";
}

interface SpeechSynthesizerStore {
  preferences: SpeechSynthesizerPreferences;
  voiceSample: SelectedVoiceSample | null;
  result: SpeechSynthesisResult | null;
  status: SpeechSynthesizerStatus;
  lastError: SpeechSynthesizerUiError | null;
  activeRequestId: string | null;
  activeMode: "non_stream" | "stream" | null;
  streamText: string;
  streamStats: SpeechSynthesisStreamUiStats;
  profileSeedKey: string | null;
  profileDefaultOverrides: Partial<Record<"voice" | "responseFormat" | "mimoMode" | "stream", true>>;

  updatePreferences: (patch: Partial<SpeechSynthesizerPreferences>) => void;
  seedProfileDefaults: (profileId: string, defaults: AudioModelProfile["defaults"]) => void;
  setVoiceSample: (sample: SelectedVoiceSample | null) => void;
  setResult: (result: SpeechSynthesisResult | null) => void;
  setStatus: (status: SpeechSynthesizerStatus) => void;
  setLastError: (error: SpeechSynthesizerUiError | null) => void;
  setActiveRequest: (
    requestId: string | null,
    mode: "non_stream" | "stream" | null,
  ) => void;
  beginTask: (
    requestId: string,
    mode: "non_stream" | "stream",
  ) => void;
  invalidateTask: (requestId?: string) => void;
  appendStreamText: (text: string) => void;
  updateStreamStats: (patch: Partial<SpeechSynthesisStreamUiStats>) => void;
  resetTaskState: () => void;
}

const DEFAULT_STREAM_STATS: SpeechSynthesisStreamUiStats = {
  chunkCount: 0,
  totalBytes: 0,
};

const useSpeechSynthesizerStore = create<SpeechSynthesizerStore>()(
  persist(
    (set) => ({
      preferences: DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
      voiceSample: null,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      activeMode: null,
      streamText: "",
      streamStats: DEFAULT_STREAM_STATS,
      profileSeedKey: null,
      profileDefaultOverrides: {},

      updatePreferences: (patch) =>
        set((state) => ({
          preferences: { ...state.preferences, ...patch },
          profileDefaultOverrides: {
            ...state.profileDefaultOverrides,
            ...(Object.prototype.hasOwnProperty.call(patch, "voice") ? { voice: true as const } : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "responseFormat") ? { responseFormat: true as const } : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "mimoMode") ? { mimoMode: true as const } : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "stream") ? { stream: true as const } : {}),
          },
        })),
      seedProfileDefaults: (profileId, defaults) =>
        set((state) => {
          const profileSeedKey = `${profileId}:${JSON.stringify(defaults)}`;
          if (profileSeedKey === state.profileSeedKey) return state;
          const next = { ...state.preferences };
          if (!state.profileDefaultOverrides.voice && defaults.ttsVoice) {
            next.voice = defaults.ttsVoice;
          }
          if (!state.profileDefaultOverrides.responseFormat && defaults.ttsResponseFormat) {
            next.responseFormat = defaults.ttsResponseFormat;
          }
          if (!state.profileDefaultOverrides.mimoMode && defaults.mimoTtsMode) {
            next.mimoMode = defaults.mimoTtsMode;
          }
          if (!state.profileDefaultOverrides.stream && defaults.streamSpeechByDefault !== undefined) {
            next.stream = defaults.streamSpeechByDefault;
          }
          return {
            profileSeedKey,
            preferences: sanitizeSpeechSynthesizerPreferences(next),
          };
        }),
      setVoiceSample: (sample) =>
        set({
          voiceSample: sample,
          result: null,
          lastError: null,
        }),
      setResult: (result) => set({ result }),
      setStatus: (status) => set({ status }),
      setLastError: (error) => set({ lastError: error }),
      setActiveRequest: (requestId, mode) =>
        set({ activeRequestId: requestId, activeMode: mode }),
      beginTask: (requestId, mode) =>
        set({
          result: null,
          status: mode === "stream" ? "streaming" : "running",
          lastError: null,
          activeRequestId: requestId,
          activeMode: mode,
          streamText: "",
          streamStats: DEFAULT_STREAM_STATS,
        }),
      invalidateTask: (requestId) =>
        set((state) => {
          if (requestId && state.activeRequestId !== requestId) return state;
          return {
            activeRequestId: null,
            activeMode: null,
          };
        }),
      appendStreamText: (text) =>
        set((state) => ({ streamText: `${state.streamText}${text}` })),
      updateStreamStats: (patch) =>
        set((state) => ({
          streamStats: {
            ...state.streamStats,
            ...patch,
          },
        })),
      resetTaskState: () =>
        set({
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          activeMode: null,
          streamText: "",
          streamStats: DEFAULT_STREAM_STATS,
        }),
    }),
    {
      name: "fusionkit-speech-synthesizer",
      storage: createJSONStorage(() => localStorage),
      version: 3,
      migrate: (persistedState, version) => {
        const persisted = (persistedState ?? {}) as Record<string, unknown>;
        if (version >= 3) return persisted;
        const preferences = (persisted.preferences ?? {}) as Record<string, unknown>;
        return {
          ...persisted,
          profileSeedKey: null,
          profileDefaultOverrides: {
            ...(Object.prototype.hasOwnProperty.call(preferences, "voice") ? { voice: true } : {}),
            ...(Object.prototype.hasOwnProperty.call(preferences, "responseFormat") ? { responseFormat: true } : {}),
            ...(Object.prototype.hasOwnProperty.call(preferences, "mimoMode") ? { mimoMode: true } : {}),
            ...(Object.prototype.hasOwnProperty.call(preferences, "stream") ? { stream: true } : {}),
          },
        };
      },
      partialize: (state) => ({
        preferences: state.preferences,
        profileSeedKey: state.profileSeedKey,
        profileDefaultOverrides: state.profileDefaultOverrides,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<SpeechSynthesizerStore>;
        return {
          ...currentState,
          ...persisted,
          preferences: sanitizeSpeechSynthesizerPreferences(
            persisted.preferences,
          ),
          // Runtime task state must never survive hydration.
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          activeMode: null,
          streamText: "",
          streamStats: DEFAULT_STREAM_STATS,
          profileDefaultOverrides: persisted.profileDefaultOverrides ?? {},
        };
      },
    },
  ),
);

export default useSpeechSynthesizerStore;
