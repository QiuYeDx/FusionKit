import {
  AUDIO_API_STORAGE_KEY,
  AUDIO_API_STORE_VERSION,
  DEFAULT_AUDIO_API_MIGRATION_STATE,
  bootstrapLegacyAudioSettingsFromGlobalStorage,
  normalizeAudioApiPersistedState,
  normalizeAudioApiProfile,
  type AudioApiPersistedState,
  type AudioApiStoreMigrationState,
} from "@/lib/audio-api-migration";
import {
  canAudioApiHandleTask,
} from "@/lib/audio-provider-registry";
import {
  AUDIO_ASSIGNMENT_KEYS,
  DEFAULT_AUDIO_TASK_ASSIGNMENT,
  type AudioApiProfile,
  type AudioApiRoutes,
  type AudioAssignmentKey,
  type AudioProviderPreset,
  type AudioRouteVerification,
  type AudioTaskAssignment,
} from "@/type/audio";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface AudioApiProfileDraft {
  name: string;
  providerPreset: AudioProviderPreset;
  baseUrl: string;
  apiKey: string;
  routes: AudioApiRoutes;
}

export interface AddAudioApiProfileResult {
  profileId: string;
  autoAssignedTasks: AudioAssignmentKey[];
}

export interface UpdateAudioApiProfileResult {
  updated: boolean;
  clearedAssignmentKeys: AudioAssignmentKey[];
}

export type AudioProfileAssignmentReplacements = Partial<AudioTaskAssignment>;

export type RemoveAudioApiProfileResult =
  | {
      removed: true;
      affectedAssignmentKeys: AudioAssignmentKey[];
    }
  | {
      removed: false;
      reason:
        | "profile_not_found"
        | "assignment_replacements_required"
        | "self_replacement"
        | "replacement_profile_not_found"
        | "incompatible_replacement";
      affectedAssignmentKeys: AudioAssignmentKey[];
      invalidReplacementKeys: AudioAssignmentKey[];
    };

export interface AudioApiStore {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
  migration: AudioApiStoreMigrationState;

  addProfile: (draft: AudioApiProfileDraft) => AddAudioApiProfileResult;
  updateProfile: (id: string, draft: AudioApiProfileDraft) => boolean;
  updateProfileWithResult: (
    id: string,
    draft: AudioApiProfileDraft,
  ) => UpdateAudioApiProfileResult;
  removeProfile: (id: string) => boolean;
  removeProfileWithAssignments: (
    id: string,
    replacements: AudioProfileAssignmentReplacements,
  ) => RemoveAudioApiProfileResult;
  getProfileById: (id: string) => AudioApiProfile | undefined;
  getProfileForAssignment: (
    key: AudioAssignmentKey,
  ) => AudioApiProfile | null;
  getAssignmentKeysForProfile: (id: string) => AudioAssignmentKey[];
  setAssignment: (
    key: AudioAssignmentKey,
    profileId: string | null,
  ) => boolean;
  undoAutoAssignments: (
    profileId: string,
    assignmentKeys: readonly AudioAssignmentKey[],
  ) => AudioAssignmentKey[];
  replaceProfileAssignments: (
    fromProfileId: string,
    replacementProfileId: string | null,
  ) => boolean;
  setRouteVerification: (
    profileId: string,
    routeKey: string,
    verification: AudioRouteVerification | null,
  ) => boolean;
}

bootstrapLegacyAudioSettingsFromGlobalStorage();

const useAudioApiStore = create<AudioApiStore>()(
  persist(
    (set, get) => ({
      profiles: [],
      assignment: { ...DEFAULT_AUDIO_TASK_ASSIGNMENT },
      migration: cloneMigrationState(DEFAULT_AUDIO_API_MIGRATION_STATE),

      addProfile: (draft) => {
        const profileId = generateAudioApiProfileId(
          new Set(get().profiles.map((profile) => profile.id)),
        );
        const profile = normalizeDraft(draft, profileId);
        const isFirstProfile = get().profiles.length === 0;
        const autoAssignedTasks: AudioAssignmentKey[] = [];

        set((state) => {
          const assignment = { ...state.assignment };
          if (isFirstProfile) {
            for (const key of AUDIO_ASSIGNMENT_KEYS) {
              if (
                assignment[key] === null &&
                canAudioApiHandleTask(profile, key)
              ) {
                assignment[key] = profileId;
                autoAssignedTasks.push(key);
              }
            }
          }
          return {
            profiles: [...state.profiles, profile],
            assignment,
          };
        });

        return { profileId, autoAssignedTasks };
      },

      updateProfile: (id, draft) =>
        get().updateProfileWithResult(id, draft).updated,

      updateProfileWithResult: (id, draft) => {
        const currentProfile = get().profiles.find(
          (profile) => profile.id === id,
        );
        if (!currentProfile) {
          return { updated: false, clearedAssignmentKeys: [] };
        }

        const normalized = normalizeDraft(draft, id);
        const nextProfile: AudioApiProfile = {
          ...normalized,
          ...(currentProfile.migration
            ? {
                migration: {
                  source: currentProfile.migration.source,
                  sourceId: currentProfile.migration.sourceId,
                },
              }
            : {}),
        };
        const clearedAssignmentKeys: AudioAssignmentKey[] = [];

        set((state) => {
          const assignment = { ...state.assignment };
          for (const key of AUDIO_ASSIGNMENT_KEYS) {
            if (
              assignment[key] === id &&
              !canAudioApiHandleTask(nextProfile, key)
            ) {
              assignment[key] = null;
              clearedAssignmentKeys.push(key);
            }
          }

          return {
            profiles: state.profiles.map((profile) =>
              profile.id === id ? nextProfile : profile,
            ),
            assignment,
          };
        });

        return { updated: true, clearedAssignmentKeys };
      },

      removeProfile: (id) => {
        return get().removeProfileWithAssignments(id, {}).removed;
      },

      removeProfileWithAssignments: (id, replacements) => {
        let result: RemoveAudioApiProfileResult = {
          removed: false,
          reason: "profile_not_found",
          affectedAssignmentKeys: [],
          invalidReplacementKeys: [],
        };

        set((state) => {
          if (!state.profiles.some((profile) => profile.id === id)) {
            return state;
          }

          const affectedAssignmentKeys = getAssignmentKeys(
            state.assignment,
            id,
          );
          const missingReplacementKeys = affectedAssignmentKeys.filter(
            (key) =>
              !Object.prototype.hasOwnProperty.call(replacements, key) ||
              replacements[key] === undefined,
          );
          if (missingReplacementKeys.length > 0) {
            result = {
              removed: false,
              reason: "assignment_replacements_required",
              affectedAssignmentKeys,
              invalidReplacementKeys: missingReplacementKeys,
            };
            return state;
          }

          const selfReplacementKeys = affectedAssignmentKeys.filter(
            (key) => replacements[key] === id,
          );
          if (selfReplacementKeys.length > 0) {
            result = {
              removed: false,
              reason: "self_replacement",
              affectedAssignmentKeys,
              invalidReplacementKeys: selfReplacementKeys,
            };
            return state;
          }

          const missingProfileKeys = affectedAssignmentKeys.filter((key) => {
            const replacementId = replacements[key];
            return (
              replacementId !== null &&
              !state.profiles.some((profile) => profile.id === replacementId)
            );
          });
          if (missingProfileKeys.length > 0) {
            result = {
              removed: false,
              reason: "replacement_profile_not_found",
              affectedAssignmentKeys,
              invalidReplacementKeys: missingProfileKeys,
            };
            return state;
          }

          const incompatibleReplacementKeys = affectedAssignmentKeys.filter(
            (key) => {
              const replacementId = replacements[key];
              if (replacementId === null) return false;
              const replacement = state.profiles.find(
                (profile) => profile.id === replacementId,
              );
              return !canAudioApiHandleTask(replacement, key);
            },
          );
          if (incompatibleReplacementKeys.length > 0) {
            result = {
              removed: false,
              reason: "incompatible_replacement",
              affectedAssignmentKeys,
              invalidReplacementKeys: incompatibleReplacementKeys,
            };
            return state;
          }

          const assignment = { ...state.assignment };
          for (const key of affectedAssignmentKeys) {
            assignment[key] = replacements[key] ?? null;
          }
          result = { removed: true, affectedAssignmentKeys };
          return {
            profiles: state.profiles.filter((profile) => profile.id !== id),
            assignment,
          };
        });

        return result;
      },

      getProfileById: (id) =>
        get().profiles.find((profile) => profile.id === id),

      getProfileForAssignment: (key) => {
        const state = get();
        const profileId = state.assignment[key];
        if (!profileId) return null;
        return state.profiles.find((profile) => profile.id === profileId) ?? null;
      },

      getAssignmentKeysForProfile: (id) =>
        getAssignmentKeys(get().assignment, id),

      setAssignment: (key, profileId) => {
        if (profileId !== null) {
          const profile = get().profiles.find((item) => item.id === profileId);
          if (!canAudioApiHandleTask(profile, key)) return false;
        }
        set((state) => ({
          assignment: { ...state.assignment, [key]: profileId },
        }));
        return true;
      },

      undoAutoAssignments: (profileId, assignmentKeys) => {
        const requestedKeys = new Set(assignmentKeys);
        const clearedAssignmentKeys: AudioAssignmentKey[] = [];
        set((state) => {
          const assignment = { ...state.assignment };
          for (const key of AUDIO_ASSIGNMENT_KEYS) {
            if (
              requestedKeys.has(key) &&
              assignment[key] === profileId
            ) {
              assignment[key] = null;
              clearedAssignmentKeys.push(key);
            }
          }
          return clearedAssignmentKeys.length > 0
            ? { assignment }
            : state;
        });
        return clearedAssignmentKeys;
      },

      replaceProfileAssignments: (fromProfileId, replacementProfileId) => {
        const state = get();
        const affected = getAssignmentKeys(state.assignment, fromProfileId);
        if (affected.length === 0) return true;
        if (replacementProfileId === fromProfileId) return false;

        if (replacementProfileId !== null) {
          const replacement = state.profiles.find(
            (profile) => profile.id === replacementProfileId,
          );
          if (
            !replacement ||
            affected.some((key) => !canAudioApiHandleTask(replacement, key))
          ) {
            return false;
          }
        }

        set((current) => ({
          assignment: Object.fromEntries(
            AUDIO_ASSIGNMENT_KEYS.map((key) => [
              key,
              current.assignment[key] === fromProfileId
                ? replacementProfileId
                : current.assignment[key],
            ]),
          ) as AudioTaskAssignment,
        }));
        return true;
      },

      setRouteVerification: (profileId, routeKey, verification) => {
        const profile = get().profiles.find((item) => item.id === profileId);
        if (!profile || !routeKey.trim()) return false;
        set((state) => ({
          profiles: state.profiles.map((item) => {
            if (item.id !== profileId) return item;
            const nextVerification = { ...(item.verification ?? {}) };
            if (verification) {
              nextVerification[routeKey] = { ...verification };
            } else {
              delete nextVerification[routeKey];
            }
            return {
              ...item,
              ...(Object.keys(nextVerification).length
                ? { verification: nextVerification }
                : { verification: undefined }),
            };
          }),
        }));
        return true;
      },
    }),
    {
      name: AUDIO_API_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: AUDIO_API_STORE_VERSION,
      partialize: (state) => ({
        profiles: state.profiles,
        assignment: state.assignment,
        migration: state.migration,
      }),
      migrate: (persistedState) =>
        normalizeAudioApiPersistedState(persistedState),
      merge: (persistedState, currentState) => {
        const persisted = normalizeAudioApiPersistedState(persistedState);
        return {
          ...currentState,
          profiles: persisted.profiles,
          assignment: persisted.assignment,
          migration: persisted.migration,
        };
      },
    },
  ),
);

function normalizeDraft(
  draft: AudioApiProfileDraft,
  id: string,
): AudioApiProfile {
  const profile = normalizeAudioApiProfile({ ...draft, id });
  if (!profile) {
    throw new Error("Audio API profile draft is invalid.");
  }
  return profile;
}

function getAssignmentKeys(
  assignment: AudioTaskAssignment,
  profileId: string,
): AudioAssignmentKey[] {
  return AUDIO_ASSIGNMENT_KEYS.filter((key) => assignment[key] === profileId);
}

function generateAudioApiProfileId(usedIds: ReadonlySet<string>): string {
  const base = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (!usedIds.has(base)) return base;
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function cloneMigrationState(
  state: AudioApiStoreMigrationState,
): AudioApiStoreMigrationState {
  return {
    legacyModelStore: { ...state.legacyModelStore },
  };
}

export type { AudioApiPersistedState };
export default useAudioApiStore;
