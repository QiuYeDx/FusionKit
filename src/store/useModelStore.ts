import {
  DEFAULT_APIKEY_MAP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_MODEL_URL_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import type { Model, ModelProfile, ModelAssignment } from "@/type/model";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Model Store — Profile-based model configuration
// ---------------------------------------------------------------------------

interface ModelStore {
  profiles: ModelProfile[];
  assignment: ModelAssignment;

  addProfile: (profile: Omit<ModelProfile, "id">) => string;
  updateProfile: (id: string, updates: Partial<Omit<ModelProfile, "id">>) => void;
  removeProfile: (id: string) => void;
  getProfileById: (id: string) => ModelProfile | undefined;

  setAssignment: (module: keyof ModelAssignment, profileId: string | null) => void;

  getAgentProfile: () => ModelProfile | null;
  getTaskProfile: () => ModelProfile | null;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Migrate from v1 (flat model/apiKeyMap/...) to v2 (profiles + assignment).
 * Creates one profile per provider that has a non-empty apiKey.
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

      addProfile: (profile) => {
        const id = generateId();
        const newProfile: ModelProfile = { ...profile, id };
        set((s) => ({
          profiles: [...s.profiles, newProfile],
        }));
        return id;
      },

      updateProfile: (id, updates) => {
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        }));
      },

      removeProfile: (id) => {
        set((s) => {
          const newAssignment = { ...s.assignment };
          if (newAssignment.agent === id) newAssignment.agent = null;
          if (newAssignment.taskExecution === id) newAssignment.taskExecution = null;
          return {
            profiles: s.profiles.filter((p) => p.id !== id),
            assignment: newAssignment,
          };
        });
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
      version: 2,
      partialize: (state) => ({
        profiles: state.profiles,
        assignment: state.assignment,
      }),
      migrate: (persisted: any, version: number) => {
        // v1 (flat model/apiKeyMap) → v2 (profiles + assignment)
        if (version < 2) {
          if (persisted && (persisted.model || persisted.apiKeyMap)) {
            return migrateFromV1(persisted);
          }
        }
        return persisted;
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
              // 已经是 v2 格式，直接迁移
              localStorage.setItem(
                "fusionkit-model",
                JSON.stringify({
                  state: { profiles: raw.profiles, assignment: raw.assignment || { agent: null, taskExecution: null } },
                  version: 2,
                })
              );
            } else if (raw.model || raw.apiKeyMap) {
              // v1 格式，需要 migrate
              const migrated = migrateFromV1(raw);
              localStorage.setItem(
                "fusionkit-model",
                JSON.stringify({ state: migrated, version: 2 })
              );
            }
          } catch { /* silent */ }
          localStorage.removeItem(LEGACY_KEY);
        }
      },
    }
  )
);

export default useModelStore;
