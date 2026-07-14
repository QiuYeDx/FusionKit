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
  migrateModelConfigToV4,
  migrateModelProfilesToV3,
  normalizeModelProfileForRuntime,
  type LegacyModelStorage,
} from "./useModelStore";
import useModelStore from "./useModelStore";
import { DEFAULT_AUDIO_MODEL_ASSIGNMENT } from "@/type/audio";
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

  it("adds empty audio config when migrating text-only v3 state to v4", () => {
    const migrated = migrateModelConfigToV4({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1",
          modelKey: "gpt-5",
          tokenPricing: {
            inputTokensPerMillion: 1,
            outputTokensPerMillion: 2,
          },
          apiFormat: "responses",
        },
      ],
      assignment: {
        agent: "profile_openai",
        taskExecution: "profile_openai",
      },
    });

    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.audioProfiles).toEqual([]);
    expect(migrated.audioAssignment).toEqual(DEFAULT_AUDIO_MODEL_ASSIGNMENT);
  });

  it("keeps legacy audio backups when their text connection is missing", () => {
    const migrated = migrateModelConfigToV4({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1",
          modelKey: "gpt-5",
          tokenPricing: {
            inputTokensPerMillion: 1,
            outputTokensPerMillion: 2,
          },
          apiFormat: "responses",
        },
      ],
      audioProfiles: [
        {
          id: "audio_openai",
          name: "OpenAI Audio",
          connectionProfileId: "profile_openai",
          audioDialect: "openai_audio",
          capabilities: [],
          models: {
            transcription: "gpt-4o-transcribe",
            speechSynthesis: "gpt-4o-mini-tts",
          },
          defaults: {},
        },
        {
          id: "audio_stale",
          name: "Stale Audio",
          connectionProfileId: "profile_deleted",
          audioDialect: "openai_audio",
          capabilities: [],
          models: {
            speechSynthesis: "gpt-4o-mini-tts",
          },
          defaults: {},
        },
      ],
      audioAssignment: {
        transcription: "audio_openai",
        speechSynthesis: "audio_stale",
        realtimeCaptions: "audio_missing",
        realtimeVoice: null,
      },
    });

    expect(migrated.audioProfiles.map((profile) => profile.id)).toEqual([
      "audio_openai",
      "audio_stale",
    ]);
    expect(migrated.audioAssignment).toEqual({
      transcription: "audio_openai",
      speechSynthesis: "audio_stale",
      realtimeCaptions: null,
      realtimeVoice: null,
    });
  });

  it("does not expose the legacy audio facade through the model store", () => {
    useModelStore.setState({
      audioProfiles: [
        {
          id: "audio_speech",
          name: "Speech",
          connectionProfileId: "profile_missing",
          audioDialect: "openai_audio",
          capabilities: ["speech_synthesis"],
          models: {
            speechSynthesis: "gpt-4o-mini-tts",
          },
          defaults: {},
        },
      ],
      audioAssignment: {
        ...DEFAULT_AUDIO_MODEL_ASSIGNMENT,
        speechSynthesis: "audio_speech",
      },
    });

    const state = useModelStore.getState() as unknown as Record<string, unknown>;
    for (const key of [
      "addAudioProfile",
      "updateAudioProfile",
      "removeAudioProfile",
      "getAudioProfileById",
      "setAudioAssignment",
      "getAudioProfileForAssignment",
      "getAudioRuntimeConfigForAssignment",
      "isConnectionProfileReferencedByAudioProfile",
    ]) {
      expect(state).not.toHaveProperty(key);
    }
  });

  it("keeps text CRUD isolated from standalone audio settings", () => {
    const legacyAudioProfile = {
      id: "audio_backup",
      name: "Legacy audio backup",
      connectionProfileId: "profile_connection",
      audioDialect: "openai_audio" as const,
      capabilities: ["speech_synthesis" as const],
      models: { speechSynthesis: "gpt-4o-mini-tts" },
      defaults: {},
    };
    useModelStore.setState({
      profiles: [
        {
          id: "profile_connection",
          name: "Connection",
          provider: Model.OpenAI,
          apiKey: "connection-key",
          baseUrl: "https://api.openai.com/v1",
          modelKey: "gpt-5",
          tokenPricing: {
            inputTokensPerMillion: 1,
            outputTokensPerMillion: 2,
          },
          apiFormat: "responses",
        },
      ],
      assignment: { agent: null, taskExecution: null },
      audioProfiles: [legacyAudioProfile],
      audioAssignment: {
        ...DEFAULT_AUDIO_MODEL_ASSIGNMENT,
        speechSynthesis: legacyAudioProfile.id,
      },
    });
    const standaloneAudioRaw = JSON.stringify({
      version: 1,
      state: {
        profiles: [],
        assignment: {
          transcription: null,
          speechSynthesis: null,
          realtimeCaptions: null,
          realtimeVoice: null,
        },
        migration: {
          legacyModelStore: { status: "completed", sourceVersion: 5 },
        },
      },
    });
    localStorage.setItem("fusionkit-audio-settings", standaloneAudioRaw);

    const profileId = useModelStore.getState().addProfile({
      name: "Temporary text model",
      provider: Model.OpenAI,
      apiKey: "text-key",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5-mini",
      tokenPricing: {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
    });
    useModelStore.getState().updateProfile(profileId, { name: "Updated" });
    useModelStore.getState().setAssignment("agent", profileId);
    expect(useModelStore.getState().removeProfile(profileId)).toBe(true);

    expect(useModelStore.getState().profiles).toHaveLength(1);
    expect(useModelStore.getState().profiles[0].id).toBe("profile_connection");
    expect(useModelStore.getState().assignment).toEqual({
      agent: null,
      taskExecution: null,
    });
    expect(useModelStore.getState().audioProfiles).toEqual([legacyAudioProfile]);
    expect(useModelStore.getState().audioAssignment.speechSynthesis).toBe(
      legacyAudioProfile.id,
    );

    expect(localStorage.getItem("fusionkit-audio-settings")).toBe(
      standaloneAudioRaw,
    );
    const modelEnvelope = JSON.parse(
      localStorage.getItem("fusionkit-model")!,
    ) as {
      state: {
        audioProfiles: unknown[];
        audioAssignment: Record<string, string | null>;
      };
    };
    expect(modelEnvelope.state.audioProfiles).toEqual([legacyAudioProfile]);
    expect(modelEnvelope.state.audioAssignment.speechSynthesis).toBe(
      legacyAudioProfile.id,
    );
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
      version: 5,
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
