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
  GeneratedSubtitleImportCoordinator,
  GeneratedSubtitleImportSnapshotCoordinator,
  type GeneratedSubtitleImportHydrationSource,
  type GeneratedSubtitleImportQueue,
} from "./generatedSubtitleImportCoordinator";
import { subtitleTranslationIpcSuccess } from "@/type/subtitleTranslationIpc";

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

describe("GeneratedSubtitleImportCoordinator", () => {
  it("commits one candidate and starts only the receipt task IDs", async () => {
    const snapshots = createCoordinator(
      hydrationSource(preferences({ outputMode: "source" }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
    );
    const prepared = await snapshots.prepareBatch(
      "enqueue_and_start_translation",
    );
    if (!prepared.ok) throw new Error("Expected a snapshot.");
    const addImportedTasks = vi.fn((
      request: Parameters<GeneratedSubtitleImportQueue["addImportedTasks"]>[0],
    ) => ({
      receiptId: request.receiptId,
      snapshotId: request.snapshotId,
      addedTaskIds: [request.candidates[0].task.taskId],
      notStartedTaskIds: [request.candidates[0].task.taskId],
      skipped: [],
    }));
    const startTasks = vi.fn((taskIds: readonly string[]) => ({
      requestedTaskIds: taskIds,
      startedTaskIds: taskIds,
      waitingTaskIds: [],
      notStartedTaskIds: [],
      startFailures: [],
    }));
    const commitGeneratedImportCandidate = vi.fn(async () =>
      subtitleTranslationIpcSuccess({ committed: true }));
    const releaseGeneratedImportCandidate = vi.fn(async () =>
      subtitleTranslationIpcSuccess({ released: true }));
    const releaseImportSnapshot = vi.fn();
    const coordinator = new GeneratedSubtitleImportCoordinator({
      snapshots,
      mainApi: {
        createGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess(candidate())),
        commitGeneratedImportCandidate,
        releaseGeneratedImportCandidate,
      },
      queue: queue({
        addImportedTasks,
        startTasks,
        releaseImportSnapshot,
        hasTask: (taskId) => taskId === "subtitle-task-imported",
      }),
      receiptIdFactory: () => "one",
    });

    const receipt = await coordinator.importArtifact({
      translationImportToken: "ls-import-one",
      snapshotId: prepared.snapshot.snapshotId,
    });
    const importedTask = addImportedTasks.mock.calls[0][0].candidates[0].task;
    expect(importedTask).toMatchObject({
      taskId: "subtitle-task-imported",
      fileName: "generated.srt",
      recoveryInputMode: "manifest_fragments",
      taskReference: { kind: "generated_task_v1" },
      executionBinding: {
        status: "ready",
        profileId: "profile-1",
        apiKey: "private-api-key",
      },
    });
    expect(importedTask).not.toHaveProperty("originFileURL");
    expect(importedTask).not.toHaveProperty("targetFileURL");
    expect(startTasks).toHaveBeenCalledOnce();
    expect(startTasks).toHaveBeenCalledWith([
      "subtitle-task-imported",
    ]);
    expect(commitGeneratedImportCandidate).toHaveBeenCalledOnce();
    expect(receipt).toEqual({
      receiptId: "subtitle-import-receipt-one",
      snapshotId: prepared.snapshot.snapshotId,
      addedTaskIds: ["subtitle-task-imported"],
      startedTaskIds: ["subtitle-task-imported"],
      waitingTaskIds: [],
      notStartedTaskIds: [],
      startFailures: [],
      skipped: [],
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(coordinator.hasTask("subtitle-task-imported")).toBe(true);
    expect(coordinator.hasTask("missing-task")).toBe(false);
    expect(coordinator.hasTask("invalid task id")).toBe(false);
    await coordinator.releaseBatch(prepared.snapshot.snapshotId);
    expect(releaseImportSnapshot).toHaveBeenCalledOnce();
    expect(releaseGeneratedImportCandidate).not.toHaveBeenCalled();
  });

  it("keeps enqueue-only tasks not started and releases duplicate candidates", async () => {
    const snapshots = createCoordinator(
      hydrationSource(preferences({ outputMode: "source" }), true),
      hydrationSource<ModelProfile | null>(null, true),
    );
    const prepared = await snapshots.prepareBatch("enqueue_translation");
    if (!prepared.ok) throw new Error("Expected a snapshot.");
    const releaseGeneratedImportCandidate = vi.fn(async () =>
      subtitleTranslationIpcSuccess({ released: true }));
    const startTasks = vi.fn();
    const coordinator = new GeneratedSubtitleImportCoordinator({
      snapshots,
      mainApi: {
        createGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess(candidate())),
        commitGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ committed: true })),
        releaseGeneratedImportCandidate,
      },
      queue: queue({
        addImportedTasks: vi.fn((
          request: Parameters<GeneratedSubtitleImportQueue["addImportedTasks"]>[0],
        ) => ({
          receiptId: request.receiptId,
          snapshotId: request.snapshotId,
          addedTaskIds: [],
          notStartedTaskIds: [],
          skipped: [{
            handoffKey: request.candidates[0].handoffKey,
            taskId: request.candidates[0].task.taskId,
            displayName: request.candidates[0].task.fileName,
            reason: "task_id_conflict" as const,
          }],
        })),
        startTasks,
      }),
      receiptIdFactory: () => "duplicate",
    });

    const receipt = await coordinator.importArtifact({
      translationImportToken: "ls-import-duplicate",
      snapshotId: prepared.snapshot.snapshotId,
    });
    expect(receipt).toMatchObject({
      addedTaskIds: [],
      notStartedTaskIds: [],
      skipped: [{ displayName: "generated.srt", reason: "duplicate" }],
    });
    expect(releaseGeneratedImportCandidate).toHaveBeenCalledOnce();
    expect(startTasks).not.toHaveBeenCalled();
  });

  it("preserves an added task when estimation prevents auto-start", async () => {
    const snapshots = createCoordinator(
      hydrationSource(preferences({ outputMode: "source" }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
    );
    const prepared = await snapshots.prepareBatch(
      "enqueue_and_start_translation",
    );
    if (!prepared.ok) throw new Error("Expected a snapshot.");
    const startTasks = vi.fn();
    const coordinator = new GeneratedSubtitleImportCoordinator({
      snapshots,
      mainApi: {
        createGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess(candidate())),
        commitGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ committed: true })),
        releaseGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ released: true })),
      },
      queue: queue({ startTasks }),
      estimate: () => {
        throw new Error("estimate failed");
      },
      receiptIdFactory: () => "estimate-failed",
    });

    const receipt = await coordinator.importArtifact({
      translationImportToken: "ls-import-estimate",
      snapshotId: prepared.snapshot.snapshotId,
    });
    expect(receipt).toMatchObject({
      addedTaskIds: ["subtitle-task-imported"],
      notStartedTaskIds: ["subtitle-task-imported"],
      startFailures: [{
        taskId: "subtitle-task-imported",
        reason: "estimate_failed",
      }],
    });
    expect(startTasks).not.toHaveBeenCalled();
  });

  it("releases a main candidate when queue insertion throws", async () => {
    const snapshots = createCoordinator(
      hydrationSource(preferences({ outputMode: "source" }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
    );
    const prepared = await snapshots.prepareBatch("enqueue_translation");
    if (!prepared.ok) throw new Error("Expected a snapshot.");
    const releaseGeneratedImportCandidate = vi.fn(async () =>
      subtitleTranslationIpcSuccess({ released: true }));
    const coordinator = new GeneratedSubtitleImportCoordinator({
      snapshots,
      mainApi: {
        createGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess(candidate())),
        commitGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ committed: true })),
        releaseGeneratedImportCandidate,
      },
      queue: queue({
        addImportedTasks: () => {
          throw new Error("queue failed");
        },
      }),
      receiptIdFactory: () => "queue-failed",
    });

    await expect(coordinator.importArtifact({
      translationImportToken: "ls-import-queue-failed",
      snapshotId: prepared.snapshot.snapshotId,
    })).rejects.toThrow("queue failed");
    expect(releaseGeneratedImportCandidate).toHaveBeenCalledOnce();
  });

  it("returns the original immutable receipt without starting twice", async () => {
    const snapshots = createCoordinator(
      hydrationSource(preferences({ outputMode: "source" }), true),
      hydrationSource<ModelProfile | null>(PROFILE, true),
    );
    const prepared = await snapshots.prepareBatch(
      "enqueue_and_start_translation",
    );
    if (!prepared.ok) throw new Error("Expected a snapshot.");
    const mainCandidate = vi.fn(async () =>
      subtitleTranslationIpcSuccess(candidate()));
    const startTasks = vi.fn((taskIds: readonly string[]) => ({
      requestedTaskIds: taskIds,
      startedTaskIds: taskIds,
      waitingTaskIds: [],
      notStartedTaskIds: [],
      startFailures: [],
    }));
    const addImportedTasks = vi.fn((
      request: Parameters<GeneratedSubtitleImportQueue["addImportedTasks"]>[0],
    ) => ({
      receiptId: request.receiptId,
      snapshotId: request.snapshotId,
      addedTaskIds: [request.candidates[0].task.taskId],
      notStartedTaskIds: [request.candidates[0].task.taskId],
      skipped: [],
    }));
    const coordinator = new GeneratedSubtitleImportCoordinator({
      snapshots,
      mainApi: {
        createGeneratedImportCandidate: mainCandidate,
        commitGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ committed: true })),
        releaseGeneratedImportCandidate: vi.fn(async () =>
          subtitleTranslationIpcSuccess({ released: true })),
      },
      queue: queue({ addImportedTasks, startTasks }),
      receiptIdFactory: () => "replay",
    });
    const first = await coordinator.importArtifact({
      translationImportToken: "ls-import-first",
      snapshotId: prepared.snapshot.snapshotId,
    });
    const second = await coordinator.importArtifact({
      translationImportToken: "ls-import-second",
      snapshotId: prepared.snapshot.snapshotId,
    });
    expect(second).toBe(first);
    expect(mainCandidate).toHaveBeenCalledTimes(2);
    expect(addImportedTasks).toHaveBeenCalledOnce();
    expect(startTasks).toHaveBeenCalledOnce();
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

function candidate() {
  return Object.freeze({
    taskId: "subtitle-task-imported",
    handoffKey: "subtitle-handoff-imported",
    candidateBinding: "subtitle-candidate-imported",
    displayName: "generated.srt",
    format: "SRT" as const,
    content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    reference: Object.freeze({
      kind: "generated_task_v1" as const,
      source: Object.freeze({
        kind: "generated_content" as const,
        displayName: "generated.srt",
      }),
      target: Object.freeze({
        kind: "authorized_directory" as const,
        token: "subtitle-translation-target-imported",
        displayLabel: "Source directory",
      }),
    }),
  });
}

function queue(overrides: Partial<GeneratedSubtitleImportQueue> = {}):
  GeneratedSubtitleImportQueue {
  return {
    addImportedTasks: (request) => ({
      receiptId: request.receiptId,
      snapshotId: request.snapshotId,
      addedTaskIds: [request.candidates[0].task.taskId],
      notStartedTaskIds: [request.candidates[0].task.taskId],
      skipped: [],
    }),
    startTasks: (taskIds) => ({
      requestedTaskIds: taskIds,
      startedTaskIds: taskIds,
      waitingTaskIds: [],
      notStartedTaskIds: [],
      startFailures: [],
    }),
    releaseImportSnapshot: () => undefined,
    ...overrides,
  };
}
