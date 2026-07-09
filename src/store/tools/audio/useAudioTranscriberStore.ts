import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioTranscriptionResult } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  type AudioTranscriberPreferences,
  type SelectedAudioInput,
} from "./audioTranscriberConfig";

export type AudioTranscriberStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AudioTranscriberUiError {
  code: AudioIpcError["code"] | "renderer_error";
  message: string;
  field?: string;
  details?: AudioIpcError["details"];
}

interface AudioTranscriberStore {
  preferences: AudioTranscriberPreferences;
  selectedFile: SelectedAudioInput | null;
  result: AudioTranscriptionResult | null;
  status: AudioTranscriberStatus;
  lastError: AudioTranscriberUiError | null;
  activeRequestId: string | null;

  updatePreferences: (patch: Partial<AudioTranscriberPreferences>) => void;
  setSelectedFile: (file: SelectedAudioInput | null) => void;
  setResult: (result: AudioTranscriptionResult | null) => void;
  setStatus: (status: AudioTranscriberStatus) => void;
  setLastError: (error: AudioTranscriberUiError | null) => void;
  setActiveRequestId: (requestId: string | null) => void;
  resetTaskState: () => void;
}

const useAudioTranscriberStore = create<AudioTranscriberStore>()(
  persist(
    (set) => ({
      preferences: DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
      selectedFile: null,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,

      updatePreferences: (patch) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...patch,
          },
        })),
      setSelectedFile: (file) =>
        set({
          selectedFile: file,
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
        }),
      setResult: (result) => set({ result }),
      setStatus: (status) => set({ status }),
      setLastError: (error) => set({ lastError: error }),
      setActiveRequestId: (requestId) => set({ activeRequestId: requestId }),
      resetTaskState: () =>
        set({
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
        }),
    }),
    {
      name: "fusionkit-audio-transcriber",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);

export default useAudioTranscriberStore;
