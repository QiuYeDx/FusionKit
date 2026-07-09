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
  migrateModelConfigToV4,
  migrateModelProfilesToV3,
  normalizeModelProfileForRuntime,
} from "./useModelStore";
import useModelStore from "./useModelStore";
import { DEFAULT_AUDIO_MODEL_ASSIGNMENT } from "@/type/audio";
import { Model, type ModelProfile } from "@/type/model";

describe("model store profile migration", () => {
  beforeEach(() => {
    localStorageItems.clear();
  });

  afterEach(() => {
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

  it("migrates audio profiles and drops references to deleted connection profiles", () => {
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
    ]);
    expect(migrated.audioAssignment).toEqual({
      transcription: "audio_openai",
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: null,
    });
  });

  it("guards audio profile assignments and connection profile removal", () => {
    useModelStore.setState({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-runtime",
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
      audioProfiles: [
        {
          id: "audio_speech",
          name: "Speech",
          connectionProfileId: "profile_openai",
          audioDialect: "openai_audio",
          capabilities: ["speech_synthesis"],
          models: {
            speechSynthesis: "gpt-4o-mini-tts",
          },
          defaults: {},
        },
      ],
      audioAssignment: { ...DEFAULT_AUDIO_MODEL_ASSIGNMENT },
    });

    useModelStore.getState().setAudioAssignment("transcription", "audio_speech");
    expect(useModelStore.getState().audioAssignment.transcription).toBeNull();

    useModelStore.getState().setAudioAssignment("speechSynthesis", "audio_speech");
    expect(useModelStore.getState().audioAssignment.speechSynthesis).toBe(
      "audio_speech",
    );

    const runtime =
      useModelStore.getState().getAudioRuntimeConfigForAssignment(
        "speechSynthesis",
      );
    expect(runtime.ok).toBe(true);
    if (runtime.ok) {
      expect(runtime.config).toMatchObject({
        audioProfileId: "audio_speech",
        connectionProfileId: "profile_openai",
        modelKey: "gpt-4o-mini-tts",
      });
      expect(runtime.config.apiKey).toBe("sk-runtime");
    }

    useModelStore.getState().removeProfile("profile_openai");
    expect(useModelStore.getState().profiles).toHaveLength(1);
    expect(
      useModelStore
        .getState()
        .isConnectionProfileReferencedByAudioProfile("profile_openai"),
    ).toBe(true);

    useModelStore.getState().removeAudioProfile("audio_speech");
    expect(useModelStore.getState().audioProfiles).toEqual([]);
    expect(useModelStore.getState().audioAssignment.speechSynthesis).toBeNull();

    useModelStore.getState().removeProfile("profile_openai");
    expect(useModelStore.getState().profiles).toEqual([]);
    expect(useModelStore.getState().assignment).toEqual({
      agent: null,
      taskExecution: null,
    });
  });
});
