import {
  DEFAULT_APIKEY_MAP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_MODEL_URL_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import type { Model, ModelProfile, ModelAssignment } from "@/type/model";
import { create } from "zustand";

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

  initializeModel: () => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const STORAGE_KEY = "modelConfig";

function persist(state: { profiles: ModelProfile[]; assignment: ModelAssignment }) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, profiles: state.profiles, assignment: state.assignment })
    );
  } catch { /* silent */ }
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

const useModelStore = create<ModelStore>((set, get) => ({
  profiles: [],
  assignment: { agent: null, taskExecution: null },

  addProfile: (profile) => {
    const id = generateId();
    const newProfile: ModelProfile = { ...profile, id };
    set((s) => {
      const next = { profiles: [...s.profiles, newProfile], assignment: s.assignment };
      persist(next);
      return next;
    });
    return id;
  },

  updateProfile: (id, updates) => {
    set((s) => {
      const next = {
        profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        assignment: s.assignment,
      };
      persist(next);
      return next;
    });
  },

  removeProfile: (id) => {
    set((s) => {
      const newAssignment = { ...s.assignment };
      if (newAssignment.agent === id) newAssignment.agent = null;
      if (newAssignment.taskExecution === id) newAssignment.taskExecution = null;
      const next = {
        profiles: s.profiles.filter((p) => p.id !== id),
        assignment: newAssignment,
      };
      persist(next);
      return next;
    });
  },

  getProfileById: (id) => {
    return get().profiles.find((p) => p.id === id);
  },

  setAssignment: (module, profileId) => {
    set((s) => {
      const next = {
        profiles: s.profiles,
        assignment: { ...s.assignment, [module]: profileId },
      };
      persist(next);
      return next;
    });
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

  initializeModel: () => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");

      if (raw.version === 2 && Array.isArray(raw.profiles)) {
        set({ profiles: raw.profiles, assignment: raw.assignment || { agent: null, taskExecution: null } });
        return;
      }

      if (raw.model || raw.apiKeyMap) {
        const migrated = migrateFromV1(raw);
        set(migrated);
        persist(migrated);
        return;
      }
    } catch { /* silent */ }
  },
}));

export default useModelStore;
