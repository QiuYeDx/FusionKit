import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SpeechSynthesisMode } from "@/type/audio";
import type {
  AudioIpcError,
  AuthorizedSpeechSynthesisResult,
} from "@/type/audioIpc";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
  sanitizeSpeechSynthesizerPreferences,
  type SelectedVoiceSample,
  type SpeechSynthesizerPreferences,
} from "./speechSynthesizerConfig";
import type { AudioOutputDirectoryAuthorization } from "./audioOutputDirectory";

export const SPEECH_SYNTHESIZER_STORE_VERSION = 5;

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
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null;
  voiceSample: SelectedVoiceSample | null;
  voiceSampleAuthorizationPending: boolean;
  result: AuthorizedSpeechSynthesisResult | null;
  status: SpeechSynthesizerStatus;
  lastError: SpeechSynthesizerUiError | null;
  activeRequestId: string | null;
  activeMode: "non_stream" | "stream" | null;
  streamText: string;
  streamStats: SpeechSynthesisStreamUiStats;

  updatePreferences: (patch: Partial<SpeechSynthesizerPreferences>) => void;
  setSpeechMode: (mode: SpeechSynthesisMode) => void;
  setOutputDirectoryAuthorization: (
    authorization: AudioOutputDirectoryAuthorization | null,
  ) => void;
  setVoiceSample: (sample: SelectedVoiceSample | null) => void;
  setVoiceSampleAuthorizationPending: (pending: boolean) => void;
  setResult: (result: AuthorizedSpeechSynthesisResult | null) => void;
  setStatus: (status: SpeechSynthesizerStatus) => void;
  setLastError: (error: SpeechSynthesizerUiError | null) => void;
  setActiveRequest: (
    requestId: string | null,
    mode: "non_stream" | "stream" | null,
  ) => void;
  beginTask: (requestId: string, mode: "non_stream" | "stream") => void;
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
      preferences: sanitizeSpeechSynthesizerPreferences(
        DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
      ),
      outputDirectoryAuthorization: null,
      voiceSample: null,
      voiceSampleAuthorizationPending: false,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      activeMode: null,
      streamText: "",
      streamStats: DEFAULT_STREAM_STATS,

      updatePreferences: (patch) =>
        set((state) => {
          const modeInputDrafts = {
            ...state.preferences.modeInputDrafts,
            ...(patch.modeInputDrafts ?? {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "input")
              ? { [state.preferences.speechMode]: patch.input ?? "" }
              : {}),
          };
          const preferences = sanitizeSpeechSynthesizerPreferences({
            ...state.preferences,
            ...patch,
            modeInputDrafts,
          });
          return {
            preferences,
            ...(Object.prototype.hasOwnProperty.call(patch, "outputDir") &&
            patch.outputDir !== state.preferences.outputDir
              ? { outputDirectoryAuthorization: null }
              : {}),
          };
        }),
      setSpeechMode: (mode) =>
        set((state) => {
          if (state.preferences.speechMode === mode) return state;
          const modeInputDrafts = {
            ...state.preferences.modeInputDrafts,
            [state.preferences.speechMode]: state.preferences.input,
          };
          const input = modeInputDrafts[mode] ?? state.preferences.input;
          return {
            preferences: sanitizeSpeechSynthesizerPreferences({
              ...state.preferences,
              speechMode: mode,
              input,
              modeInputDrafts: {
                ...modeInputDrafts,
                [mode]: input,
              },
            }),
          };
        }),
      setOutputDirectoryAuthorization: (outputDirectoryAuthorization) =>
        set({ outputDirectoryAuthorization }),
      setVoiceSample: (voiceSample) =>
        set({
          voiceSample,
          voiceSampleAuthorizationPending: false,
        }),
      setVoiceSampleAuthorizationPending: (voiceSampleAuthorizationPending) =>
        set({ voiceSampleAuthorizationPending }),
      setResult: (result) => set({ result }),
      setStatus: (status) => set({ status }),
      setLastError: (lastError) => set({ lastError }),
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
            ...(state.status === "running" || state.status === "streaming"
              ? { status: "cancelled" as const }
              : {}),
          };
        }),
      appendStreamText: (text) =>
        set((state) => ({ streamText: `${state.streamText}${text}` })),
      updateStreamStats: (patch) =>
        set((state) => ({
          streamStats: { ...state.streamStats, ...patch },
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
          outputDirectoryAuthorization: null,
        }),
    }),
    {
      name: "fusionkit-speech-synthesizer",
      storage: createJSONStorage(() => localStorage),
      version: SPEECH_SYNTHESIZER_STORE_VERSION,
      migrate: (persistedState, version) =>
        migrateSpeechSynthesizerPersistedState(persistedState, version),
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (persistedState, currentState) => {
        const persisted = isRecord(persistedState) ? persistedState : {};
        return {
          ...currentState,
          preferences: sanitizeSpeechSynthesizerPreferences(
            persisted.preferences,
          ),
          // Runtime authorizations and task state never survive hydration.
          outputDirectoryAuthorization: null,
          voiceSample: null,
          voiceSampleAuthorizationPending: false,
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          activeMode: null,
          streamText: "",
          streamStats: DEFAULT_STREAM_STATS,
        };
      },
    },
  ),
);

export function migrateSpeechSynthesizerPersistedState(
  persistedState: unknown,
  _version: number,
): Record<string, unknown> {
  const persisted = isRecord(persistedState) ? persistedState : {};
  return {
    preferences: sanitizeSpeechSynthesizerPreferences(persisted.preferences),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useSpeechSynthesizerStore;
