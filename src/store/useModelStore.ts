import {
  DEFAULT_APIKEY_MAP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_MODEL_URL_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import {
  DEFAULT_AUDIO_MODEL_ASSIGNMENT,
  canAssignAudioProfileToTask,
  clearAudioProfileFromAssignment,
  filterAudioProfilesByConnectionIds,
  isConnectionProfileReferencedByAudioProfile,
  migrateAudioModelProfiles,
  normalizeAudioModelAssignment,
  normalizeAudioModelProfileForRuntime,
  type AudioModelProfileInput,
} from "@/lib/audio-profile";
import {
  resolveAudioRuntimeModelConfig,
  type AudioAssignmentKey,
  type AudioModelAssignment,
  type AudioModelProfile,
  type AudioRuntimeModelConfigResult,
} from "@/type/audio";
import type { Model, ModelProfile, ModelAssignment } from "@/type/model";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Model Store — Profile-based model configuration
// ---------------------------------------------------------------------------

interface ModelStore {
  profiles: ModelProfile[];
  assignment: ModelAssignment;
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;

  addProfile: (profile: ModelProfileInput) => string;
  updateProfile: (id: string, updates: Partial<ModelProfileInput>) => void;
  removeProfile: (id: string) => void;
  getProfileById: (id: string) => ModelProfile | undefined;

  setAssignment: (module: keyof ModelAssignment, profileId: string | null) => void;

  addAudioProfile: (profile: AudioModelProfileInput) => string;
  updateAudioProfile: (
    id: string,
    updates: Partial<AudioModelProfileInput>,
  ) => void;
  removeAudioProfile: (id: string) => void;
  getAudioProfileById: (id: string) => AudioModelProfile | undefined;
  setAudioAssignment: (
    module: AudioAssignmentKey,
    audioProfileId: string | null,
  ) => void;
  getAudioProfileForAssignment: (
    module: AudioAssignmentKey,
  ) => AudioModelProfile | null;
  getAudioRuntimeConfigForAssignment: (
    module: AudioAssignmentKey,
  ) => AudioRuntimeModelConfigResult;
  isConnectionProfileReferencedByAudioProfile: (
    profileId: string,
  ) => boolean;

  getAgentProfile: () => ModelProfile | null;
  getTaskProfile: () => ModelProfile | null;
}

type ModelProfileInput = Omit<
  ModelProfile,
  "id" | "apiFormat" | "outputTokenParameter"
> &
  Partial<Pick<ModelProfile, "apiFormat" | "outputTokenParameter">>;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeModelProfileForRuntime(
  profile: ModelProfile | ModelProfileInput,
  options: { legacyDefault?: boolean } = {},
): ModelProfile | ModelProfileInput {
  const provider = profile.provider;
  const apiFormat =
    profile.apiFormat ??
    (options.legacyDefault
      ? "chat_completions"
      : DEFAULT_MODEL_API_FORMAT_MAP[provider]);

  return {
    ...profile,
    apiFormat,
    outputTokenParameter:
      profile.outputTokenParameter ?? DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[provider],
  };
}

export function migrateModelProfilesToV3(raw: unknown): {
  profiles: ModelProfile[];
  assignment: ModelAssignment;
} {
  const persisted = isRecord(raw) ? raw : {};
  const profiles = Array.isArray(persisted.profiles)
    ? persisted.profiles
        .filter(isRecord)
        .map((profile) =>
          normalizeModelProfileForRuntime(
            profile as unknown as ModelProfile,
            { legacyDefault: true },
          ) as ModelProfile,
        )
    : [];

  const assignment = isRecord(persisted.assignment)
    ? {
        agent:
          typeof persisted.assignment.agent === "string"
            ? persisted.assignment.agent
            : null,
        taskExecution:
          typeof persisted.assignment.taskExecution === "string"
            ? persisted.assignment.taskExecution
            : null,
      }
    : { agent: null, taskExecution: null };

  return { profiles, assignment };
}

export function migrateModelConfigToV4(raw: unknown): {
  profiles: ModelProfile[];
  assignment: ModelAssignment;
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;
} {
  const persisted = isRecord(raw) ? raw : {};
  const textConfig = migrateModelProfilesToV3(persisted);
  const connectionProfileIds = new Set(
    textConfig.profiles.map((profile) => profile.id),
  );
  const audioProfiles = filterAudioProfilesByConnectionIds(
    migrateAudioModelProfiles(persisted.audioProfiles),
    connectionProfileIds,
  );
  const audioProfileIds = new Set(audioProfiles.map((profile) => profile.id));

  return {
    ...textConfig,
    audioProfiles,
    audioAssignment: normalizeAudioModelAssignment(
      persisted.audioAssignment,
      audioProfileIds,
    ),
  };
}

/**
 * Migrate from v1 (flat model/apiKeyMap/...) to v3 (profiles + assignment +
 * API format metadata). Creates one profile per provider that has a non-empty
 * apiKey.
 */
function migrateFromV1(raw: Record<string, any>): {
  profiles: ModelProfile[];
  assignment: ModelAssignment;
} {
  const oldModel: Model = raw.model || DEFAULT_MODEL;
  const oldApiKeyMap = raw.apiKeyMap || DEFAULT_APIKEY_MAP;
  const oldUrlMap = raw.modelUrlMap || DEFAULT_MODEL_URL_MAP;
  const oldKeyMap = raw.modelKeyMap || DEFAULT_MODEL_KEY_MAP;
  const oldPricingMap = raw.tokenPricingMap || DEFAULT_TOKEN_PRICING_MAP;

  const profiles: ModelProfile[] = [];
  let agentProfileId: string | null = null;

  for (const provider of Object.values({ DeepSeek: "DeepSeek", OpenAI: "OpenAI", Other: "Other" }) as Model[]) {
    const apiKey = oldApiKeyMap[provider] || "";
    if (!apiKey) continue;

    const id = generateId() + `-${provider.toLowerCase()}`;
    profiles.push({
      id,
      name: provider === ("Other" as Model) ? "自定义" : provider,
      provider: provider as Model,
      apiKey,
      baseUrl: oldUrlMap[provider] || DEFAULT_MODEL_URL_MAP[provider as Model] || "",
      modelKey: oldKeyMap[provider] || DEFAULT_MODEL_KEY_MAP[provider as Model] || "",
      tokenPricing: oldPricingMap[provider] || { ...DEFAULT_TOKEN_PRICING_MAP[provider as Model] },
      apiFormat: "chat_completions",
      outputTokenParameter: DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[provider as Model],
    });

    if (provider === oldModel) {
      agentProfileId = id;
    }
  }

  return {
    profiles,
    assignment: {
      agent: agentProfileId,
      taskExecution: agentProfileId,
    },
  };
}

const LEGACY_KEY = "modelConfig";

const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      profiles: [],
      assignment: { agent: null, taskExecution: null },
      audioProfiles: [],
      audioAssignment: { ...DEFAULT_AUDIO_MODEL_ASSIGNMENT },

      addProfile: (profile) => {
        const id = generateId();
        const newProfile = normalizeModelProfileForRuntime({
          ...profile,
          id,
        }) as ModelProfile;
        set((s) => ({
          profiles: [...s.profiles, newProfile],
        }));
        return id;
      },

      updateProfile: (id, updates) => {
        set((s) => ({
          profiles: s.profiles.map((p) => {
            if (p.id !== id) return p;
            const providerChanged =
              updates.provider !== undefined && updates.provider !== p.provider;
            const next = { ...p, ...updates };
            return normalizeModelProfileForRuntime(
              {
                ...next,
                apiFormat:
                  providerChanged && updates.apiFormat === undefined
                    ? undefined
                    : next.apiFormat,
                outputTokenParameter:
                  providerChanged && updates.outputTokenParameter === undefined
                    ? undefined
                    : next.outputTokenParameter,
              },
              { legacyDefault: false },
            ) as ModelProfile;
          }),
        }));
      },

      removeProfile: (id) => {
        set((s) => {
          if (
            isConnectionProfileReferencedByAudioProfile(
              s.audioProfiles,
              id,
            )
          ) {
            return s;
          }

          const newAssignment = { ...s.assignment };
          if (newAssignment.agent === id) newAssignment.agent = null;
          if (newAssignment.taskExecution === id) newAssignment.taskExecution = null;
          return {
            profiles: s.profiles.filter((p) => p.id !== id),
            assignment: newAssignment,
          };
        });
      },

      addAudioProfile: (profile) => {
        const id = generateId();
        const newProfile = normalizeAudioModelProfileForRuntime(profile, id);
        set((s) => ({
          audioProfiles: [...s.audioProfiles, newProfile],
        }));
        return id;
      },

      updateAudioProfile: (id, updates) => {
        set((s) => ({
          audioProfiles: s.audioProfiles.map((profile) => {
            if (profile.id !== id) return profile;
            const dialectChanged =
              updates.audioDialect !== undefined &&
              updates.audioDialect !== profile.audioDialect;

            return normalizeAudioModelProfileForRuntime({
              ...profile,
              ...updates,
              capabilities:
                updates.capabilities ??
                (dialectChanged ? [] : profile.capabilities),
              models: {
                ...profile.models,
                ...updates.models,
              },
              defaults: {
                ...profile.defaults,
                ...updates.defaults,
              },
              verification:
                updates.verification === undefined
                  ? profile.verification
                  : updates.verification,
            });
          }),
        }));
      },

      removeAudioProfile: (id) => {
        set((s) => ({
          audioProfiles: s.audioProfiles.filter((profile) => profile.id !== id),
          audioAssignment: clearAudioProfileFromAssignment(
            s.audioAssignment,
            id,
          ),
        }));
      },

      getAudioProfileById: (id) => {
        return get().audioProfiles.find((profile) => profile.id === id);
      },

      setAudioAssignment: (module, audioProfileId) => {
        set((s) => {
          if (audioProfileId === null) {
            return {
              audioAssignment: {
                ...s.audioAssignment,
                [module]: null,
              },
            };
          }

          const audioProfile = s.audioProfiles.find(
            (profile) => profile.id === audioProfileId,
          );
          if (!canAssignAudioProfileToTask(audioProfile, module)) {
            return s;
          }

          return {
            audioAssignment: {
              ...s.audioAssignment,
              [module]: audioProfileId,
            },
          };
        });
      },

      getAudioProfileForAssignment: (module) => {
        const { audioProfiles, audioAssignment } = get();
        const profileId = audioAssignment[module];
        if (!profileId) return null;
        return audioProfiles.find((profile) => profile.id === profileId) ?? null;
      },

      getAudioRuntimeConfigForAssignment: (module) => {
        const { audioProfiles, audioAssignment, profiles } = get();
        const audioProfileId = audioAssignment[module];
        const audioProfile = audioProfileId
          ? audioProfiles.find((profile) => profile.id === audioProfileId)
          : null;
        const connectionProfile = audioProfile
          ? profiles.find(
              (profile) => profile.id === audioProfile.connectionProfileId,
            )
          : null;

        return resolveAudioRuntimeModelConfig({
          audioProfile,
          connectionProfile,
          assignmentKey: module,
        });
      },

      isConnectionProfileReferencedByAudioProfile: (profileId) => {
        return isConnectionProfileReferencedByAudioProfile(
          get().audioProfiles,
          profileId,
        );
      },

      getProfileById: (id) => {
        return get().profiles.find((p) => p.id === id);
      },

      setAssignment: (module, profileId) => {
        set((s) => ({
          assignment: { ...s.assignment, [module]: profileId },
        }));
      },

      getAgentProfile: () => {
        const { profiles, assignment } = get();
        if (!assignment.agent) return null;
        return profiles.find((p) => p.id === assignment.agent) ?? null;
      },

      getTaskProfile: () => {
        const { profiles, assignment } = get();
        if (!assignment.taskExecution) return null;
        return profiles.find((p) => p.id === assignment.taskExecution) ?? null;
      },
    }),
    {
      name: "fusionkit-model",
      storage: createJSONStorage(() => localStorage),
      version: 4,
      partialize: (state) => ({
        profiles: state.profiles,
        assignment: state.assignment,
        audioProfiles: state.audioProfiles,
        audioAssignment: state.audioAssignment,
      }),
      migrate: (persisted: any, version: number) => {
        // v1 (flat model/apiKeyMap) -> v4 (profiles + assignment + audio config)
        if (version < 2) {
          if (persisted && (persisted.model || persisted.apiKeyMap)) {
            return migrateModelConfigToV4(migrateFromV1(persisted));
          }
        }
        return migrateModelConfigToV4(persisted);
      },
      onRehydrateStorage: () => {
        // 一次性迁移：旧 key → 新 key
        if (
          localStorage.getItem(LEGACY_KEY) !== null &&
          localStorage.getItem("fusionkit-model") === null
        ) {
          try {
            const raw = JSON.parse(localStorage.getItem(LEGACY_KEY)!);

            if (raw.version === 2 && Array.isArray(raw.profiles)) {
              // 已经是 v2 格式，补齐 v4 字段后迁移
              const migrated = migrateModelConfigToV4(raw);
              localStorage.setItem(
                "fusionkit-model",
                JSON.stringify({
                  state: migrated,
                  version: 4,
                })
              );
            } else if (raw.model || raw.apiKeyMap) {
              // v1 格式，需要 migrate 并补齐 v4 字段
              const migrated = migrateModelConfigToV4(migrateFromV1(raw));
              localStorage.setItem(
                "fusionkit-model",
                JSON.stringify({ state: migrated, version: 4 })
              );
            }
          } catch { /* silent */ }
          localStorage.removeItem(LEGACY_KEY);
        }
      },
    }
  )
);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useModelStore;
