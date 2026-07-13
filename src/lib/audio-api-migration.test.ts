import { describe, expect, it } from "vitest";
import {
  LEGACY_AUDIO_MIGRATION_FIXTURES,
  type LegacyAudioMigrationFixture,
} from "../../test/audio/fixtures/legacyAudioSettings";
import {
  AUDIO_API_STORAGE_KEY,
  DEFAULT_AUDIO_API_MIGRATION_STATE,
  LEGACY_MODEL_STORAGE_KEY,
  bootstrapLegacyAudioSettings,
  migrateLegacyAudioSettings,
  parseAudioApiStoreEnvelope,
  parseLegacyModelStoreEnvelope,
  type AudioApiPersistedState,
  type AudioSettingsStorage,
} from "./audio-api-migration";

describe("legacy audio API migration", () => {
  const fixtures: Record<string, LegacyAudioMigrationFixture> =
    LEGACY_AUDIO_MIGRATION_FIXTURES;

  for (const [name, fixture] of Object.entries(fixtures)) {
    it(`migrates the frozen ${name} fixture`, () => {
      const sourceSnapshot = structuredClone(fixture.source);
      const source = parseLegacyModelStoreEnvelope(fixture.source);
      expect(source).not.toBeNull();

      const existing = fixture.existingTarget
        ? persistedState(fixture.existingTarget)
        : undefined;
      const migrated = migrateLegacyAudioSettings(source!, existing);

      expect(migrated.profiles).toEqual(fixture.expected.profiles);
      expect(migrated.assignment).toEqual(fixture.expected.assignment);
      expect(migrated.migration).toEqual({
        legacyModelStore: {
          status: "completed",
          sourceVersion: fixture.source.version,
        },
      });
      expect(fixture.source).toEqual(sourceSnapshot);
    });
  }

  it("preserves a manual ID collision and rewrites legacy assignments", () => {
    const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio;
    const source = parseLegacyModelStoreEnvelope(fixture.source)!;
    const manualProfile = {
      id: "audio_openai",
      name: "Manual API",
      providerPreset: "custom_openai_compatible" as const,
      baseUrl: "https://manual.example/v1",
      apiKey: "manual-key",
      routes: { speechSynthesis: {} },
    };
    const migrated = migrateLegacyAudioSettings(
      source,
      persistedState({
        profiles: [manualProfile],
        assignment: {
          transcription: null,
          speechSynthesis: null,
          realtimeCaptions: null,
          realtimeVoice: null,
        },
      }),
    );

    expect(migrated.profiles[0]).toEqual(manualProfile);
    expect(migrated.profiles[1]).toMatchObject({
      id: "legacy-audio_openai",
      migration: { sourceId: "audio_openai" },
    });
    expect(migrated.assignment).toMatchObject({
      transcription: "legacy-audio_openai",
      speechSynthesis: "legacy-audio_openai",
    });
  });

  it("keeps every profile when duplicate source IDs collide with real IDs", () => {
    const collidingId = "audio#legacy-duplicate-2";
    const source = parseLegacyModelStoreEnvelope({
      version: 5,
      state: {
        profiles: [
          {
            id: "connection",
            provider: "OpenAI",
            apiKey: "fixture-key",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        assignment: { agent: null, taskExecution: null },
        audioProfiles: [
          legacySpeechProfile("audio", "First", "connection"),
          legacySpeechProfile("audio", "Duplicate", "connection"),
          legacySpeechProfile(collidingId, "Real collision", "connection"),
        ],
        audioAssignment: emptyAssignment({ speechSynthesis: "audio" }),
      },
    })!;

    const migrated = migrateLegacyAudioSettings(source);

    expect(migrated.profiles).toHaveLength(3);
    expect(
      migrated.profiles.map((profile) => profile.migration?.sourceId),
    ).toEqual([
      "audio",
      "audio#legacy-duplicate-2-2",
      collidingId,
    ]);
    expect(new Set(migrated.profiles.map((profile) => profile.id)).size).toBe(3);
    expect(migrated.assignment.speechSynthesis).toBe("audio");
  });

  it("marks legacy connections with missing credentials for repair", () => {
    const source = parseLegacyModelStoreEnvelope({
      version: 5,
      state: {
        profiles: [
          {
            id: "connection",
            provider: "OpenAI",
            apiKey: "   ",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        assignment: { agent: null, taskExecution: null },
        audioProfiles: [
          legacySpeechProfile("audio", "Incomplete", "connection"),
        ],
        audioAssignment: emptyAssignment(),
      },
    })!;

    expect(migrateLegacyAudioSettings(source).profiles[0].migration).toEqual({
      source: "legacy_audio_profile",
      sourceId: "audio",
      needsAttention: true,
    });
  });

  it("rejects malformed source envelopes without inventing state", () => {
    expect(parseLegacyModelStoreEnvelope("not-json")).toBeNull();
    expect(
      parseLegacyModelStoreEnvelope({ version: 3, state: {} }),
    ).toBeNull();
    expect(
      parseLegacyModelStoreEnvelope({
        version: 5,
        state: {
          profiles: [],
          assignment: {},
          audioProfiles: "corrupt",
          audioAssignment: emptyAssignment(),
        },
      }),
    ).toBeNull();
    expect(
      parseLegacyModelStoreEnvelope({
        version: 5,
        state: {
          profiles: [],
          assignment: {},
          audioProfiles: [null],
          audioAssignment: emptyAssignment(),
        },
      }),
    ).toBeNull();
    expect(parseAudioApiStoreEnvelope({ version: 99, state: {} })).toBeNull();
  });
});

describe("legacy audio API storage bootstrap", () => {
  it("writes and verifies the target before reporting completion", () => {
    const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES
      .missingConnectionAndRealtimeFallback;
    const storage = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify(fixture.source),
    });
    const sourceBefore = storage.getItem(LEGACY_MODEL_STORAGE_KEY);

    const first = bootstrapLegacyAudioSettings(storage);
    expect(first.status).toBe("migrated");
    const targetAfterFirst = storage.getItem(AUDIO_API_STORAGE_KEY);
    const parsed = parseAudioApiStoreEnvelope(targetAfterFirst);
    expect(parsed?.state.profiles).toEqual(fixture.expected.profiles);
    expect(parsed?.state.assignment).toEqual(fixture.expected.assignment);
    expect(storage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe(sourceBefore);

    const second = bootstrapLegacyAudioSettings(storage);
    expect(second.status).toBe("already_complete");
    expect(storage.getItem(AUDIO_API_STORAGE_KEY)).toBe(targetAfterFirst);
  });

  it("preserves valid manual target data while filling null assignments", () => {
    const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio;
    const manualTarget = persistedState({
      profiles: [
        {
          id: "manual",
          name: "Manual",
          providerPreset: "custom_openai_compatible",
          baseUrl: "https://manual.example/v1",
          apiKey: "manual-key",
          routes: { speechSynthesis: {} },
        },
      ],
      assignment: {
        transcription: null,
        speechSynthesis: null,
        realtimeCaptions: null,
        realtimeVoice: null,
      },
    });
    const storage = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify(fixture.source),
      [AUDIO_API_STORAGE_KEY]: JSON.stringify({
        version: 1,
        state: manualTarget,
      }),
    });

    expect(bootstrapLegacyAudioSettings(storage).status).toBe("migrated");
    const state = parseAudioApiStoreEnvelope(
      storage.getItem(AUDIO_API_STORAGE_KEY),
    )!.state;
    expect(state.profiles[0].id).toBe("manual");
    expect(state.profiles.some((profile) => profile.id === "audio_openai"))
      .toBe(true);
    expect(state.assignment.transcription).toBe("audio_openai");
  });

  it("does not overwrite malformed targets or sources", () => {
    const invalidTarget = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify(
        LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
      ),
      [AUDIO_API_STORAGE_KEY]: "invalid-target",
    });
    expect(bootstrapLegacyAudioSettings(invalidTarget)).toEqual({
      status: "failed",
      reason: "invalid_target",
    });
    expect(invalidTarget.getItem(AUDIO_API_STORAGE_KEY)).toBe("invalid-target");

    const invalidSource = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: "invalid-source",
    });
    expect(bootstrapLegacyAudioSettings(invalidSource)).toEqual({
      status: "failed",
      reason: "invalid_source",
    });
    expect(invalidSource.getItem(AUDIO_API_STORAGE_KEY)).toBeNull();
  });

  it("preserves structurally invalid target envelopes without normalizing data away", () => {
    const rawTarget = JSON.stringify({
      version: 1,
      state: {
        profiles: [
          {
            id: "manual",
            name: "Manual",
            providerPreset: "misspelled-provider",
            baseUrl: "https://manual.example/v1",
            apiKey: "manual-key",
            routes: { speechSynthesis: {} },
          },
        ],
        assignment: emptyAssignment(),
        migration: { legacyModelStore: { status: "not_needed" } },
      },
    });
    const storage = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify(
        LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
      ),
      [AUDIO_API_STORAGE_KEY]: rawTarget,
    });

    expect(bootstrapLegacyAudioSettings(storage)).toEqual({
      status: "failed",
      reason: "invalid_target",
    });
    expect(storage.getItem(AUDIO_API_STORAGE_KEY)).toBe(rawTarget);

    const collidingTarget = JSON.stringify({
      version: 1,
      state: {
        profiles: [
          standaloneProfile("manual"),
          standaloneProfile(" manual "),
        ],
        assignment: emptyAssignment(),
        migration: { legacyModelStore: { status: "not_needed" } },
      },
    });
    const collisionStorage = new MemoryStorage({
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify(
        LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
      ),
      [AUDIO_API_STORAGE_KEY]: collidingTarget,
    });

    expect(bootstrapLegacyAudioSettings(collisionStorage)).toEqual({
      status: "failed",
      reason: "invalid_target",
    });
    expect(collisionStorage.getItem(AUDIO_API_STORAGE_KEY)).toBe(
      collidingTarget,
    );
  });

  it("keeps migration retryable when target persistence fails", () => {
    const source = JSON.stringify(
      LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
    );
    const storage = new MemoryStorage(
      { [LEGACY_MODEL_STORAGE_KEY]: source },
      true,
    );

    expect(bootstrapLegacyAudioSettings(storage)).toEqual({
      status: "failed",
      reason: "write_failed",
    });
    expect(storage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe(source);
    expect(storage.getItem(AUDIO_API_STORAGE_KEY)).toBeNull();
  });

  it("contains target and source storage read failures", () => {
    const targetReadFailure = new ThrowingReadStorage(
      AUDIO_API_STORAGE_KEY,
    );
    expect(bootstrapLegacyAudioSettings(targetReadFailure)).toEqual({
      status: "failed",
      reason: "read_failed",
    });
    expect(targetReadFailure.writeCount).toBe(0);

    const sourceReadFailure = new ThrowingReadStorage(
      LEGACY_MODEL_STORAGE_KEY,
    );
    expect(bootstrapLegacyAudioSettings(sourceReadFailure)).toEqual({
      status: "failed",
      reason: "read_failed",
    });
    expect(sourceReadFailure.writeCount).toBe(0);
  });

  it("does not report completion when target verification cannot be read", () => {
    const source = JSON.stringify(
      LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
    );
    const storage = new VerificationReadFailureStorage(source);

    expect(bootstrapLegacyAudioSettings(storage)).toEqual({
      status: "failed",
      reason: "verification_failed",
    });
    expect(storage.writeCount).toBe(1);
  });

  it("rejects readback data that keeps the marker but loses migrated state", () => {
    const source = JSON.stringify(
      LEGACY_AUDIO_MIGRATION_FIXTURES.openAiFileAudio.source,
    );
    const storage = new MarkerOnlyReadbackStorage(source);

    expect(bootstrapLegacyAudioSettings(storage)).toEqual({
      status: "failed",
      reason: "verification_failed",
    });
  });

  it("does nothing when there is no legacy source", () => {
    const storage = new MemoryStorage();
    expect(bootstrapLegacyAudioSettings(storage)).toEqual({
      status: "no_source",
    });
    expect(storage.getItem(AUDIO_API_STORAGE_KEY)).toBeNull();
  });
});

function persistedState(input: {
  profiles: AudioApiPersistedState["profiles"];
  assignment: AudioApiPersistedState["assignment"];
}): AudioApiPersistedState {
  return {
    ...input,
    migration: structuredClone(DEFAULT_AUDIO_API_MIGRATION_STATE),
  };
}

function emptyAssignment(
  overrides: Partial<AudioApiPersistedState["assignment"]> = {},
): AudioApiPersistedState["assignment"] {
  return {
    transcription: null,
    speechSynthesis: null,
    realtimeCaptions: null,
    realtimeVoice: null,
    ...overrides,
  };
}

function legacySpeechProfile(
  id: string,
  name: string,
  connectionProfileId: string,
): Record<string, unknown> {
  return {
    id,
    name,
    connectionProfileId,
    audioDialect: "openai_audio",
    capabilities: ["speech_synthesis"],
    models: { speechSynthesis: "gpt-4o-mini-tts" },
    defaults: {},
  };
}

function standaloneProfile(id: string): AudioApiPersistedState["profiles"][number] {
  return {
    id,
    name: `Profile ${id}`,
    providerPreset: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "manual-key",
    routes: { speechSynthesis: {} },
  };
}

class MemoryStorage implements AudioSettingsStorage {
  private readonly values = new Map<string, string>();

  constructor(
    initial: Record<string, string> = {},
    private readonly failTargetWrites = false,
  ) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failTargetWrites && key === AUDIO_API_STORAGE_KEY) {
      throw new Error("simulated quota failure");
    }
    this.values.set(key, value);
  }
}

class ThrowingReadStorage implements AudioSettingsStorage {
  writeCount = 0;

  constructor(private readonly failingKey: string) {}

  getItem(key: string): string | null {
    if (key === this.failingKey) throw new Error("simulated read failure");
    return null;
  }

  setItem(): void {
    this.writeCount += 1;
  }
}

class VerificationReadFailureStorage implements AudioSettingsStorage {
  writeCount = 0;
  private target: string | null = null;

  constructor(private readonly source: string) {}

  getItem(key: string): string | null {
    if (key === LEGACY_MODEL_STORAGE_KEY) return this.source;
    if (key === AUDIO_API_STORAGE_KEY) {
      if (this.target !== null) throw new Error("simulated readback failure");
      return null;
    }
    return null;
  }

  setItem(key: string, value: string): void {
    if (key === AUDIO_API_STORAGE_KEY) {
      this.writeCount += 1;
      this.target = value;
    }
  }
}

class MarkerOnlyReadbackStorage implements AudioSettingsStorage {
  private written = false;

  constructor(private readonly source: string) {}

  getItem(key: string): string | null {
    if (key === LEGACY_MODEL_STORAGE_KEY) return this.source;
    if (key !== AUDIO_API_STORAGE_KEY || !this.written) return null;
    return JSON.stringify({
      version: 1,
      state: {
        profiles: [],
        assignment: emptyAssignment(),
        migration: {
          legacyModelStore: { status: "completed", sourceVersion: 5 },
        },
      },
    });
  }

  setItem(key: string): void {
    if (key === AUDIO_API_STORAGE_KEY) this.written = true;
  }
}
