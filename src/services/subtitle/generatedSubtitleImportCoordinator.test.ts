import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
});

import {
  DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
  sanitizeSubtitleTranslatorConfigPreferences,
  type SubtitleTranslatorConfigPreferences,
} from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import { Model, type ModelProfile } from "@/type/model";
import {
  GeneratedSubtitleImportSnapshotCoordinator,
  type GeneratedSubtitleImportHydrationSource,
} from "./generatedSubtitleImportCoordinator";

const PROFILE = Object.freeze({
  id: "profile-1",
  name: "Translation profile",
  provider: Model.OpenAI,
  apiKey: "private-api-key",
  baseUrl: "https://private.example/v1",
  modelKey: "translation-model",
  tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
  apiFormat: "chat_completions",
  outputTokenParameter: "max_tokens",
} satisfies ModelProfile);

let idIndex = 0;

beforeEach(() => {
  idIndex = 0;
});

describe("GeneratedSubtitleImportSnapshotCoordinator", () => {
  it("waits for hydration and freezes public and private config separately", async () => {
    const config = hydrationSource(preferences({
      outputMode: "source",
      sourceLang: "EN",
      targetLang: "JA",
    }), false);
    const model = hydrationSource<ModelProfile | null>(PROFILE, true);
    const coordinator = createCoordinator(config, model);
    let settled = false;
    const preparing = coordinator.prepareBatch(
      "enqueue_and_start_translation",
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    config.hydrate();
    const result = await preparing;
    expect(result).toMatchObject({
      ok: true,
      canAutoStart: true,
      snapshot: {
        handoffMode: "enqueue_and_start_translation",
        sourceLang: "EN",
        targetLang: "JA",
        outputMode: "source",
        executionBinding: {
          status: "ready",
          taskProfileId: "profile-1",
          taskProfileLabel: "Translation profile",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-api-key|private\.example|translation-model/u,
    );
    if (!result.ok) throw new Error("Expected a config snapshot.");

    config.set(preferences({
      outputMode: "source",
      sourceLang: "ZH",
      targetLang: "KO",
    }));
    await expect(
      coordinator.withSnapshot(result.snapshot.snapshotId, (snapshot) => ({
        sourceLang: snapshot.summary.sourceLang,
        targetLang: snapshot.summary.targetLang,
        modelFields: snapshot.modelFields,
      })),
    ).resolves.toEqual({
      sourceLang: "EN",
      targetLang: "JA",
      modelFields: expect.objectContaining({
        apiKey: "private-api-key",
        apiModel: "translation-model",
        endPoint: "https://private.example/v1",
      }),
    });
  });

  it("allows enqueue-only without a profile and rejects auto-start", async () => {
    const config = hydrationSource(preferences({ outputMode: "source" }), true);
    const model = hydrationSource<ModelProfile | null>(null, true);
    const coordinator = createCoordinator(config, model);

    await expect(
      coordinator.prepareBatch("enqueue_translation"),
    ).resolves.toMatchObject({
      ok: true,
      canAutoStart: false,
      warnings: ["configuration_required"],
      snapshot: { executionBinding: { status: "needs_configuration" } },
    });
    await expect(
      coordinator.prepareBatch("enqueue_and_start_translation"),
    ).resolves.toEqual({
      ok: false,
      code: "profile_required",
      warnings: [],
    });
  });

  it("fails closed on hydration timeout and missing custom authority", async () => {
    const config = hydrationSource(preferences({ outputMode: "source" }), false);
    const model = hydrationSource<ModelProfile | null>(PROFILE, true);
    const coordinator = createCoordinator(config, model, {
      hydrationTimeoutMs: 5,
    });
    await expect(
      coordinator.prepareBatch("enqueue_translation"),
    ).resolves.toEqual({
      ok: false,
      code: "configuration_not_ready",
      warnings: [],
    });

    config.set(preferences({
      outputMode: "custom",
      outputDirectoryDisplayLabel: "Exports",
    }));
    config.hydrate();
    await expect(
      coordinator.prepareBatch("enqueue_translation"),
    ).resolves.toEqual({
      ok: false,
      code: "directory_authorization_required",
      warnings: [],
    });

    const releaseInvalidLease = vi.fn();
    const invalidLeaseCoordinator = createCoordinator(config, model, {
      acquireCustomDirectoryLease: async () => ({
        displayLabel: "Exports",
        privateLease: undefined,
        release: releaseInvalidLease,
      }),
    });
    await expect(
      invalidLeaseCoordinator.prepareBatch("enqueue_translation"),
    ).resolves.toEqual({
      ok: false,
      code: "directory_authorization_required",
      warnings: [],
    });
    expect(releaseInvalidLease).toHaveBeenCalledOnce();
  });

  it("binds and retries release of a custom snapshot lease", async () => {
    const config = hydrationSource(preferences({
      outputMode: "custom",
      outputDirectoryDisplayLabel: "Legacy Label",
    }), true);
    const model = hydrationSource<ModelProfile | null>(PROFILE, true);
    const privateLease = Object.freeze({ leaseId: "private-target-lease" });
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const coordinator = createCoordinator(config, model, {
      acquireCustomDirectoryLease: async () => ({
        displayLabel: "Authorized Exports",
        privateLease,
        release,
      }),
    });
    const result = await coordinator.prepareBatch("enqueue_translation");
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        outputMode: "custom",
        outputDirectoryLabel: "Authorized Exports",
      },
    });
    if (!result.ok) throw new Error("Expected a custom snapshot.");
    await expect(
      coordinator.withSnapshot(
        result.snapshot.snapshotId,
        (snapshot) => snapshot.customDirectoryLease,
      ),
    ).resolves.toBe(privateLease);

    await expect(
      coordinator.releaseBatch(result.snapshot.snapshotId),
    ).rejects.toThrow("release failed");
    await expect(
      coordinator.withSnapshot(
        result.snapshot.snapshotId,
        (snapshot) => snapshot.summary.snapshotId,
      ),
    ).resolves.toBe(result.snapshot.snapshotId);
    await expect(
      coordinator.releaseBatch(result.snapshot.snapshotId),
    ).resolves.toBeUndefined();
    await expect(
      coordinator.withSnapshot(
        result.snapshot.snapshotId,
        (snapshot) => snapshot,
      ),
    ).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("expires snapshots and releases their private lease", async () => {
    let now = 100;
    const release = vi.fn();
    const coordinator = createCoordinator(
      hydrationSource(preferences({
        outputMode: "custom",
        outputDirectoryDisplayLabel: "Exports",
      }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
      {
        now: () => now,
        snapshotTtlMs: 10,
        acquireCustomDirectoryLease: async () => ({
          displayLabel: "Exports",
          privateLease: Object.freeze({ leaseId: "lease-1" }),
          release,
        }),
      },
    );
    const result = await coordinator.prepareBatch("enqueue_translation");
    if (!result.ok) throw new Error("Expected a custom snapshot.");
    now = 110;

    await expect(
      coordinator.withSnapshot(
        result.snapshot.snapshotId,
        (snapshot) => snapshot,
      ),
    ).rejects.toMatchObject({ code: "snapshot_expired" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("fences a snapshot while coalescing concurrent release", async () => {
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(() => releaseGate);
    const coordinator = createCoordinator(
      hydrationSource(preferences({
        outputMode: "custom",
        outputDirectoryDisplayLabel: "Exports",
      }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
      {
        acquireCustomDirectoryLease: async () => ({
          displayLabel: "Exports",
          privateLease: Object.freeze({ leaseId: "lease-fenced" }),
          release,
        }),
      },
    );
    const result = await coordinator.prepareBatch("enqueue_translation");
    if (!result.ok) throw new Error("Expected a custom snapshot.");

    const first = coordinator.releaseBatch(result.snapshot.snapshotId);
    const second = coordinator.releaseBatch(result.snapshot.snapshotId);
    expect(release).toHaveBeenCalledOnce();
    await expect(
      coordinator.withSnapshot(
        result.snapshot.snapshotId,
        (snapshot) => snapshot,
      ),
    ).rejects.toMatchObject({ code: "invalid_snapshot" });
    finishRelease();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not reuse a snapshot ID while its release is pending", async () => {
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const source = hydrationSource(preferences({ outputMode: "custom" }), true);
    const coordinator = new GeneratedSubtitleImportSnapshotCoordinator({
      configSource: source,
      modelSource: hydrationSource<ModelProfile | null>(PROFILE, true),
      snapshotIdFactory: () => "fixed-id",
      acquireCustomDirectoryLease: async () => ({
        displayLabel: "Exports",
        privateLease: Object.freeze({ leaseId: "lease-fixed" }),
        release: () => releaseGate,
      }),
    });
    const result = await coordinator.prepareBatch("enqueue_translation");
    if (!result.ok) throw new Error("Expected a custom snapshot.");

    const releasing = coordinator.releaseBatch(result.snapshot.snapshotId);
    await expect(
      coordinator.prepareBatch("enqueue_translation"),
    ).rejects.toThrow("snapshot ID source is invalid");
    finishRelease();
    await releasing;
  });
});

function preferences(
  patch: Partial<SubtitleTranslatorConfigPreferences> = {},
): SubtitleTranslatorConfigPreferences {
  return sanitizeSubtitleTranslatorConfigPreferences({
    ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
    ...patch,
  });
}

function hydrationSource<T>(initial: T, hydrated: boolean) {
  let value = initial;
  let ready = hydrated;
  const listeners = new Set<() => void>();
  return {
    isHydrated: () => ready,
    onHydrated: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => value,
    set: (next: T) => {
      value = next;
    },
    hydrate: () => {
      ready = true;
      for (const listener of [...listeners]) listener();
    },
  } satisfies GeneratedSubtitleImportHydrationSource<T> & {
    set(next: T): void;
    hydrate(): void;
  };
}

function createCoordinator(
  configSource: ReturnType<typeof hydrationSource<SubtitleTranslatorConfigPreferences>>,
  modelSource: ReturnType<typeof hydrationSource<ModelProfile | null>>,
  overrides: Partial<
    ConstructorParameters<typeof GeneratedSubtitleImportSnapshotCoordinator>[0]
  > = {},
) {
  return new GeneratedSubtitleImportSnapshotCoordinator({
    configSource,
    modelSource,
    snapshotIdFactory: () => `snapshot-${++idIndex}`,
    ...overrides,
  });
}
