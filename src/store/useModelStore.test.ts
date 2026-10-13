import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localStorageItems = vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  return storage;
});

import {
  migrateLegacyModelStorage,
  migrateModelProfilesToV3,
  normalizeModelProfileForRuntime,
  type LegacyModelStorage,
} from "./useModelStore";
import useModelStore from "./useModelStore";
import { Model, type ModelProfile } from "@/type/model";

describe("model store profile migration", () => {
  beforeEach(() => {
    localStorageItems.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorageItems.clear();
  });

  it("keeps migrated profiles on legacy Chat Completions defaults", () => {
    const migrated = migrateModelProfilesToV3({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1/chat/completions",
          modelKey: "gpt-5",
          tokenPricing: {
            inputTokensPerMillion: 1,
            outputTokensPerMillion: 2,
          },
        },
      ],
      assignment: {
        agent: "profile_openai",
        taskExecution: "profile_openai",
      },
    });

    expect(migrated.profiles[0]).toMatchObject({
      apiFormat: "chat_completions",
      outputTokenParameter: "max_completion_tokens",
    });
    expect(migrated.assignment).toEqual({
      agent: "profile_openai",
      taskExecution: "profile_openai",
    });
  });

  it("uses provider defaults for new runtime profiles", () => {
    const normalized = normalizeModelProfileForRuntime({
      id: "profile_new_openai",
      name: "OpenAI",
      provider: Model.OpenAI,
      apiKey: "sk-new",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5",
      tokenPricing: {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
    } satisfies Omit<
      ModelProfile,
      "apiFormat" | "outputTokenParameter"
    >);

    expect(normalized).toMatchObject({
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
    });
  });

  it("drops the old audio settings backup when migrating v5 state", () => {
    const migrated = useModelStore.persist.getOptions().migrate!({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1",
          modelKey: "gpt-5",
          tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
          apiFormat: "responses",
        },
      ],
      assignment: { agent: "profile_openai", taskExecution: null },
      audioProfiles: [{ id: "audio_openai", connectionProfileId: "profile_openai" }],
      audioAssignment: { transcription: "audio_openai" },
    }, 5) as Record<string, unknown>;

    expect(Object.keys(migrated).sort()).toEqual(["assignment", "profiles"]);
    expect(migrated.assignment).toEqual({ agent: "profile_openai", taskExecution: null });
  });

  it("removes a text model connection and clears its assignments", () => {
    const profileId = useModelStore.getState().addProfile({
      name: "Temporary text model",
      provider: Model.OpenAI,
      apiKey: "text-key",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5-mini",
      tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
    });
    useModelStore.getState().setAssignment("agent", profileId);
    expect(useModelStore.getState().removeProfile(profileId)).toBe(true);
    expect(useModelStore.getState().profiles.some((profile) => profile.id === profileId)).toBe(false);
    expect(useModelStore.getState().assignment.agent).toBeNull();
    expect(useModelStore.getState().removeProfile(profileId)).toBe(false);
  });

  it("removes legacy model storage only after an exact verified write", () => {
    const storage = new LegacyModelStorageHarness({
      modelConfig: legacyV2ModelConfig(),
    });

    expect(migrateLegacyModelStorage(storage)).toBe(true);
    expect(storage.getItem("modelConfig")).toBeNull();
    const target = storage.getItem("fusionkit-model");
    expect(target).not.toBeNull();
    expect(JSON.parse(target!)).toMatchObject({
      version: 6,
      state: { profiles: [{ id: "profile_legacy" }] },
    });
  });

  it("retains legacy model storage when target persistence fails", () => {
    const legacy = legacyV2ModelConfig();
    const storage = new LegacyModelStorageHarness(
      { modelConfig: legacy },
      true,
    );

    expect(migrateLegacyModelStorage(storage)).toBe(false);
    expect(storage.getItem("modelConfig")).toBe(legacy);
    expect(storage.getItem("fusionkit-model")).toBeNull();
  });

  it("retains legacy model storage when target readback differs", () => {
    const legacy = legacyV2ModelConfig();
    const storage = new LegacyModelStorageHarness(
      { modelConfig: legacy },
      false,
      true,
    );

    expect(migrateLegacyModelStorage(storage)).toBe(false);
    expect(storage.getItem("modelConfig")).toBe(legacy);
    expect(storage.getItem("fusionkit-model")).toBe("corrupt-target");
  });
});

function legacyV2ModelConfig(): string {
  return JSON.stringify({
    version: 2,
    profiles: [
      {
        id: "profile_legacy",
        name: "Legacy",
        provider: Model.OpenAI,
        apiKey: "legacy-key",
        baseUrl: "https://api.openai.com/v1",
        modelKey: "gpt-4o",
        tokenPricing: {
          inputTokensPerMillion: 1,
          outputTokensPerMillion: 2,
        },
      },
    ],
    assignment: { agent: "profile_legacy", taskExecution: null },
  });
}

class LegacyModelStorageHarness implements LegacyModelStorage {
  private readonly values = new Map<string, string>();

  constructor(
    initial: Record<string, string>,
    private readonly failTargetWrites = false,
    private readonly corruptTargetWrites = false,
  ) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failTargetWrites && key === "fusionkit-model") {
      throw new Error("simulated target write failure");
    }
    this.values.set(
      key,
      this.corruptTargetWrites && key === "fusionkit-model"
        ? "corrupt-target"
        : value,
    );
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
