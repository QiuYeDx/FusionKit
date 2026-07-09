import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SpeechSynthesisResult } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
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

  updatePreferences: (patch: Partial<SpeechSynthesizerPreferences>) => void;
  setVoiceSample: (sample: SelectedVoiceSample | null) => void;
  setResult: (result: SpeechSynthesisResult | null) => void;
  setStatus: (status: SpeechSynthesizerStatus) => void;
  setLastError: (error: SpeechSynthesizerUiError | null) => void;
  setActiveRequest: (
    requestId: string | null,
    mode: "non_stream" | "stream" | null,
  ) => void;
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

      updatePreferences: (patch) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...patch,
          },
        })),
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
      version: 1,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);

export default useSpeechSynthesizerStore;
