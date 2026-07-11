import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AudioTranscriptionResult } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  createAudioTranscriberProfileSeedKey,
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  seedAudioTranscriberPreferencesFromProfile,
  type AudioTranscriberProfileDefaultOverrides,
  type AudioTranscriberPreferences,
  type SelectedAudioInput,
} from "./audioTranscriberConfig";
import type { AudioModelProfile } from "@/type/audio";

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
  requestGeneration: number;
  profileSeedKey: string | null;
  profileDefaultOverrides: AudioTranscriberProfileDefaultOverrides;

  updatePreferences: (patch: Partial<AudioTranscriberPreferences>) => void;
  seedProfileDefaults: (
    profileId: string,
    defaults: AudioModelProfile["defaults"],
  ) => void;
  setSelectedFile: (file: SelectedAudioInput | null) => void;
  setResult: (result: AudioTranscriptionResult | null) => void;
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
      preferences: DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
      selectedFile: null,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      requestGeneration: 0,
      profileSeedKey: null,
      profileDefaultOverrides: {},

      updatePreferences: (patch) =>
        set((state) => {
          const profileDefaultOverrides = {
            ...state.profileDefaultOverrides,
            ...(Object.prototype.hasOwnProperty.call(patch, "language")
              ? { language: true as const }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "responseFormat")
              ? { responseFormat: true as const }
              : {}),
          };
          return {
            preferences: {
              ...state.preferences,
              ...patch,
            },
            profileDefaultOverrides,
          };
        }),
      seedProfileDefaults: (profileId, defaults) =>
        set((state) => {
          const profileSeedKey = createAudioTranscriberProfileSeedKey(
            profileId,
            defaults,
          );
          if (state.profileSeedKey === profileSeedKey) return state;
          return {
            profileSeedKey,
            preferences: seedAudioTranscriberPreferencesFromProfile(
              state.preferences,
              defaults,
              state.profileDefaultOverrides,
            ),
          };
        }),
      setSelectedFile: (file) =>
        set((state) => ({
          selectedFile: file,
          result: null,
          status: "idle",
          lastError: null,
          activeRequestId: null,
          requestGeneration: state.requestGeneration + 1,
        })),
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
        })),
    }),
    {
      name: "fusionkit-audio-transcriber",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      partialize: (state) => ({
        preferences: state.preferences,
        profileSeedKey: state.profileSeedKey,
        profileDefaultOverrides: state.profileDefaultOverrides,
      }),
      migrate: (persisted, version) =>
        migrateAudioTranscriberPersistedState(persisted, version),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        const savedPreferences = isRecord(saved.preferences)
          ? saved.preferences
          : {};
        return {
          ...current,
          ...saved,
          preferences: {
            ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
            ...savedPreferences,
          },
          profileDefaultOverrides: isRecord(saved.profileDefaultOverrides)
            ? saved.profileDefaultOverrides
            : {},
        } as AudioTranscriberStore;
      },
    },
  ),
);

export function migrateAudioTranscriberPersistedState(
  persisted: unknown,
  version: number,
): Record<string, unknown> {
  const saved = isRecord(persisted) ? persisted : {};
  if (version >= 2) return saved;

  const preferences = isRecord(saved.preferences) ? saved.preferences : {};
  return {
    ...saved,
    profileSeedKey: null,
    profileDefaultOverrides: {
      ...(Object.prototype.hasOwnProperty.call(preferences, "language")
        ? { language: true }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(preferences, "responseFormat")
        ? { responseFormat: true }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useAudioTranscriberStore;
