import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  AudioIpcError,
  AuthorizedAudioTranscriptionResult,
} from "@/type/audioIpc";
import {
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  sanitizeAudioTranscriberPreferences,
  type AudioTranscriberPreferences,
  type SelectedAudioInput,
} from "./audioTranscriberConfig";
import type { AudioOutputDirectoryAuthorization } from "./audioOutputDirectory";

export const AUDIO_TRANSCRIBER_STORE_VERSION = 4;

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
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null;
  selectedFile: SelectedAudioInput | null;
  fileAuthorizationPending: boolean;
  result: AuthorizedAudioTranscriptionResult | null;
  status: AudioTranscriberStatus;
  lastError: AudioTranscriberUiError | null;
  activeRequestId: string | null;
  requestGeneration: number;

  updatePreferences: (patch: Partial<AudioTranscriberPreferences>) => void;
  setOutputDirectoryAuthorization: (
    authorization: AudioOutputDirectoryAuthorization | null,
  ) => void;
  setSelectedFile: (file: SelectedAudioInput | null) => void;
  setFileAuthorizationPending: (pending: boolean) => void;
  setResult: (result: AuthorizedAudioTranscriptionResult | null) => void;
  setStatus: (status: AudioTranscriberStatus) => void;
  setLastError: (error: AudioTranscriberUiError | null) => void;
  beginRequest: (requestId: string) => number;
  invalidateActiveRequest: (
    status?: Extract<AudioTranscriberStatus, "idle" | "cancelled">,
  ) => { requestId: string; generation: number } | null;
  isRequestCurrent: (requestId: string, generation: number) => boolean;
  resetTaskState: () => void;
}

const useAudioTranscriberStore = create<AudioTranscriberStore>()(
  persist(
    (set, get) => ({
      preferences: sanitizeAudioTranscriberPreferences(
        DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
      ),
      outputDirectoryAuthorization: null,
      selectedFile: null,
      fileAuthorizationPending: false,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      requestGeneration: 0,

      updatePreferences: (patch) =>
        set((state) => {
          return {
            preferences: sanitizeAudioTranscriberPreferences({
              ...state.preferences,
              ...patch,
            }),
            ...(Object.prototype.hasOwnProperty.call(patch, "outputDir") &&
            patch.outputDir !== state.preferences.outputDir
              ? { outputDirectoryAuthorization: null }
              : {}),
          };
        }),
      setOutputDirectoryAuthorization: (outputDirectoryAuthorization) =>
        set({ outputDirectoryAuthorization }),
      setSelectedFile: (file) =>
        set((state) => ({
          selectedFile: file,
          fileAuthorizationPending: false,
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          requestGeneration: state.requestGeneration + 1,
        })),
      setFileAuthorizationPending: (fileAuthorizationPending) =>
        set({ fileAuthorizationPending }),
      setResult: (result) => set({ result }),
      setStatus: (status) => set({ status }),
      setLastError: (error) => set({ lastError: error }),
      beginRequest: (requestId) => {
        let generation = 0;
        set((state) => {
          generation = state.requestGeneration + 1;
          return {
            requestGeneration: generation,
            activeRequestId: requestId,
            result: null,
            status: "running",
            lastError: null,
          };
        });
        return generation;
      },
      invalidateActiveRequest: (status = "cancelled") => {
        let invalidated: { requestId: string; generation: number } | null = null;
        set((state) => {
          const generation = state.requestGeneration + 1;
          if (state.activeRequestId) {
            invalidated = { requestId: state.activeRequestId, generation };
          }
          return {
            requestGeneration: generation,
            activeRequestId: null,
            ...(state.activeRequestId ? { status } : {}),
          };
        });
        return invalidated;
      },
      isRequestCurrent: (requestId, generation) => {
        const state = get();
        return (
          state.activeRequestId === requestId &&
          state.requestGeneration === generation
        );
      },
      resetTaskState: () =>
        set((state) => ({
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          requestGeneration: state.requestGeneration + 1,
          outputDirectoryAuthorization: null,
        })),
    }),
    {
      name: "fusionkit-audio-transcriber",
      storage: createJSONStorage(() => localStorage),
      version: AUDIO_TRANSCRIBER_STORE_VERSION,
      partialize: (state) => ({ preferences: state.preferences }),
      migrate: (persisted, version) =>
        migrateAudioTranscriberPersistedState(persisted, version),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          preferences: sanitizeAudioTranscriberPreferences(saved.preferences),
          outputDirectoryAuthorization: null,
          selectedFile: null,
          fileAuthorizationPending: false,
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          requestGeneration: 0,
        };
      },
    },
  ),
);

export function migrateAudioTranscriberPersistedState(
  persisted: unknown,
  _version: number,
): Record<string, unknown> {
  const saved = isRecord(persisted) ? persisted : {};
  return {
    preferences: sanitizeAudioTranscriberPreferences(saved.preferences),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useAudioTranscriberStore;
