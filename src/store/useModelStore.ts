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
  bootstrapLegacyAudioSettingsFromGlobalStorage,
} from "@/lib/audio-api-migration";
import {
  DEFAULT_AUDIO_MODEL_ASSIGNMENT,
  migrateAudioModelProfiles,
  normalizeAudioModelAssignment,
} from "@/lib/audio-profile";
import type { AudioModelAssignment, AudioModelProfile } from "@/type/audio";
import type { Model, ModelProfile, ModelAssignment } from "@/type/model";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Model Store — Profile-based model configuration
// ---------------------------------------------------------------------------

interface ModelStore {
  profiles: ModelProfile[];
  assignment: ModelAssignment;
  /** @deprecated Read-only migration backup; remove after the compatibility window. */
  readonly audioProfiles: AudioModelProfile[];
  /** @deprecated Read-only migration backup; remove after the compatibility window. */
  readonly audioAssignment: AudioModelAssignment;

  addProfile: (profile: ModelProfileInput) => string;
  updateProfile: (id: string, updates: Partial<ModelProfileInput>) => void;
  removeProfile: (id: string) => boolean;
  getProfileById: (id: string) => ModelProfile | undefined;

  setAssignment: (module: keyof ModelAssignment, profileId: string | null) => void;

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
  const audioProfiles = migrateAudioModelProfiles(persisted.audioProfiles);
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
const MODEL_STORAGE_KEY = "fusionkit-model";

export interface LegacyModelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function migrateLegacyModelStorage(
  storage: LegacyModelStorage,
): boolean {
  try {
    const legacyRaw = storage.getItem(LEGACY_KEY);
    if (!legacyRaw || storage.getItem(MODEL_STORAGE_KEY) !== null) {
      return false;
    }

    const raw: unknown = JSON.parse(legacyRaw);
    if (!isRecord(raw)) return false;

    let migrated;
    if (raw.version === 2 && Array.isArray(raw.profiles)) {
      migrated = migrateModelConfigToV4(raw);
    } else if (raw.model || raw.apiKeyMap) {
      migrated = migrateModelConfigToV4(migrateFromV1(raw));
    } else {
      return false;
    }

    const serialized = JSON.stringify({ state: migrated, version: 5 });
    storage.setItem(MODEL_STORAGE_KEY, serialized);
    if (storage.getItem(MODEL_STORAGE_KEY) !== serialized) return false;
    storage.removeItem(LEGACY_KEY);
    return true;
  } catch {
    return false;
  }
}

// Must run before Zustand hydration so cross-key migration never depends on
// whether the source or target Store module was imported first.
const legacyAudioBootstrapResult =
  bootstrapLegacyAudioSettingsFromGlobalStorage();

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
        const state = get();
        if (!state.profiles.some((profile) => profile.id === id)) return false;
        if (
          hasLegacyAudioConnectionReference(state.audioProfiles, id) &&
          !isLegacyAudioSourceSafeToDelete()
        ) {
          return false;
        }

        const newAssignment = { ...state.assignment };
        if (newAssignment.agent === id) newAssignment.agent = null;
        if (newAssignment.taskExecution === id) newAssignment.taskExecution = null;
        set({
          profiles: state.profiles.filter((profile) => profile.id !== id),
          assignment: newAssignment,
        });
        return true;
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
      name: MODEL_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 5,
      partialize: (state) => ({
        profiles: state.profiles,
        assignment: state.assignment,
        // Keep one read-compatible backup version; new code must not use it.
        audioProfiles: state.audioProfiles,
        audioAssignment: state.audioAssignment,
      }),
      migrate: (persisted: any, version: number) => {
        // v1 (flat model/apiKeyMap) -> v5 (profiles + normalized audio config)
        if (version < 2) {
          if (persisted && (persisted.model || persisted.apiKeyMap)) {
            return migrateModelConfigToV4(migrateFromV1(persisted));
          }
        }
        return migrateModelConfigToV4(persisted);
      },
      onRehydrateStorage: () => {
        try {
          migrateLegacyModelStorage(globalThis.localStorage);
        } catch {
          // Storage access can be disabled by browser policy.
        }
      },
    }
  )
);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasLegacyAudioConnectionReference(
  audioProfiles: readonly AudioModelProfile[],
  connectionProfileId: string,
): boolean {
  return audioProfiles.some(
    (profile) => profile.connectionProfileId === connectionProfileId,
  );
}

function isLegacyAudioSourceSafeToDelete(): boolean {
  return (
    legacyAudioBootstrapResult.status === "migrated" ||
    legacyAudioBootstrapResult.status === "already_complete"
  );
}

export default useModelStore;
