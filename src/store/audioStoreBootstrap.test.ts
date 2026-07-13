import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_AUDIO_MIGRATION_FIXTURES } from "../../test/audio/fixtures/legacyAudioSettings";

const LEGACY_MODEL_STORAGE_KEY = "fusionkit-model";
const AUDIO_API_STORAGE_KEY = "fusionkit-audio-settings";

interface MissingConnectionStateShape {
  profiles: Array<{
    id: string;
    apiKey?: string;
    baseUrl?: string;
    migration?: { needsAttention?: boolean };
  }>;
  assignment: { speechSynthesis?: string | null };
}

const storageHarness = vi.hoisted(() => {
  const values = new Map<string, string>();
  let failAudioSettingsWrites = false;
  let audioSettingsWriteCount = 0;

  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === "fusionkit-audio-settings") {
        audioSettingsWriteCount += 1;
        if (failAudioSettingsWrites) {
          throw new Error("simulated audio settings persistence failure");
        }
      }
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  return {
    values,
    reset() {
      values.clear();
      failAudioSettingsWrites = false;
      audioSettingsWriteCount = 0;
    },
    failAudioSettingsWrites(value: boolean) {
      failAudioSettingsWrites = value;
    },
    getAudioSettingsWriteCount() {
      return audioSettingsWriteCount;
    },
  };
});

describe("audio settings bootstrap import ordering", () => {
  beforeEach(() => {
    storageHarness.reset();
    vi.resetModules();
  });

  it("migrates before the legacy model store hydrates", async () => {
    seedMissingConnectionFixture();

    await import("./useModelStore");

    expectPersistedMissingConnectionProfile();

    const { default: useAudioApiStore } = await import("./useAudioApiStore");
    expectMissingConnectionProfile(useAudioApiStore.getState());
  });

  it("hydrates the migrated state when the audio store loads first", async () => {
    seedMissingConnectionFixture();

    const { default: useAudioApiStore } = await import("./useAudioApiStore");
    expectMissingConnectionProfile(useAudioApiStore.getState());

    await import("./useModelStore");
    expectPersistedMissingConnectionProfile();
  });

  it("does not rewrite a completed migration on later module loads", async () => {
    seedMissingConnectionFixture();

    await import("./useModelStore");
    const targetAfterFirstBootstrap = storageHarness.values.get(
      AUDIO_API_STORAGE_KEY,
    );
    expect(targetAfterFirstBootstrap).toBeDefined();
    expect(storageHarness.getAudioSettingsWriteCount()).toBe(1);

    vi.resetModules();
    await import("./useAudioApiStore");
    vi.resetModules();
    await import("./useModelStore");

    expect(storageHarness.values.get(AUDIO_API_STORAGE_KEY)).toBe(
      targetAfterFirstBootstrap,
    );
    expect(storageHarness.getAudioSettingsWriteCount()).toBe(1);
  });

  it("does not report completion after a failed target write and remains retryable", async () => {
    seedMissingConnectionFixture();
    storageHarness.failAudioSettingsWrites(true);

    const { default: failedStore } = await import("./useAudioApiStore");

    expect(storageHarness.values.has(AUDIO_API_STORAGE_KEY)).toBe(false);
    expect(failedStore.getState().migration.legacyModelStore.status).toBe(
      "not_needed",
    );

    storageHarness.failAudioSettingsWrites(false);
    vi.resetModules();
    const { default: retriedStore } = await import("./useAudioApiStore");

    expectMissingConnectionProfile(retriedStore.getState());
    expect(
      retriedStore.getState().migration.legacyModelStore.status,
    ).toBe("completed");
  });
});

function seedMissingConnectionFixture(): void {
  const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES
    .missingConnectionAndRealtimeFallback;
  storageHarness.values.set(
    LEGACY_MODEL_STORAGE_KEY,
    JSON.stringify(fixture.source),
  );
}

function expectPersistedMissingConnectionProfile(): void {
  const raw = storageHarness.values.get(AUDIO_API_STORAGE_KEY);
  expect(raw).toBeDefined();
  const envelope = JSON.parse(raw!) as {
    state: MissingConnectionStateShape & {
      migration: { legacyModelStore: { status: string } };
    };
  };

  expectMissingConnectionProfile(envelope.state);
  expect(envelope.state.migration.legacyModelStore.status).toBe("completed");
}

function expectMissingConnectionProfile(
  state: MissingConnectionStateShape,
): void {
  expect(
    state.profiles.find((profile) => profile.id === "audio_missing_connection"),
  ).toMatchObject({
    id: "audio_missing_connection",
    apiKey: "",
    baseUrl: "",
    migration: { needsAttention: true },
  });
  expect(state.assignment.speechSynthesis).toBe("audio_missing_connection");
}
