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
  assignNewProfile,
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

  it("gives a new profile the roles nobody has yet", () => {
    useModelStore.setState({ profiles: [], assignment: { agent: null, taskExecution: null } });
    const input = (name: string) => ({
      name,
      provider: Model.DeepSeek,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
      modelKey: "deepseek-v4-flash",
      tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
    });
    const first = useModelStore.getState().addProfile(input("first"));
    // The first profile works everywhere without a separate assignment.
    expect(useModelStore.getState().assignment).toEqual({ agent: first, taskExecution: first });
    const second = useModelStore.getState().addProfile(input("second"));
    expect(useModelStore.getState().assignment).toEqual({ agent: first, taskExecution: first });
    // A role left empty goes to the next new profile; the other keeps its choice.
    useModelStore.getState().setAssignment("taskExecution", null);
    const third = useModelStore.getState().addProfile(input("third"));
    expect(useModelStore.getState().assignment).toEqual({ agent: first, taskExecution: third });
    // A role pointing at a profile that no longer exists counts as empty.
    useModelStore.setState({ assignment: { agent: "deleted", taskExecution: third } });
    const fourth = useModelStore.getState().addProfile(input("fourth"));
    expect(useModelStore.getState().assignment).toEqual({ agent: fourth, taskExecution: third });
    // "all" makes the new profile the one for every role.
    const fifth = useModelStore.getState().addProfile(input("fifth"), { assignRoles: "all" });
    expect(useModelStore.getState().assignment).toEqual({ agent: fifth, taskExecution: fifth });
    expect(useModelStore.getState().profiles.map((profile) => profile.id)).toEqual([first, second, third, fourth, fifth]);
  });

  it("does not give the Agent a profile whose API format it cannot use", () => {
    const profile = {
      id: "unsupported",
      name: "Unsupported",
      provider: Model.Other,
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      modelKey: "m",
      tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
      apiFormat: "completions" as unknown as ModelProfile["apiFormat"],
    };
    expect(assignNewProfile({ agent: null, taskExecution: null }, profile, [])).toEqual({ agent: null, taskExecution: "unsupported" });
    expect(assignNewProfile({ agent: null, taskExecution: null }, { ...profile, apiFormat: "responses" }, [])).toEqual({ agent: "unsupported", taskExecution: "unsupported" });
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
