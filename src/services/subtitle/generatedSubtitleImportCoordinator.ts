import {
  createSubtitleTaskModelFields,
  type SubtitleTaskModelFields,
} from "@/agent/task-model-config";
import useSubtitleTranslatorConfigStore, {
  sanitizeSubtitleTranslatorConfigPreferences,
  type SubtitleTranslatorConfigPreferences,
} from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useModelStore from "@/store/useModelStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import type {
  AutomaticSubtitleTranslationHandoffMode,
  PrepareGeneratedSubtitleImportResult,
  SubtitleTranslationImportConfigSummary,
  SubtitleTranslationImportReceipt,
  SubtitleTranslationImportSkipReason,
} from "@/type/generatedSubtitleImport";
import type { ModelProfile, TokenPricing } from "@/type/model";
import {
  TaskStatus,
  type SubtitleTaskExecutionBinding,
  type SubtitleTranslatorTask,
} from "@/type/subtitle";
import type {
  SubtitleTranslationGeneratedImportCandidate,
  SubtitleTranslationGeneratedImportCandidateControl,
  SubtitleTranslationRendererApi,
} from "@/type/subtitleTranslationIpc";
import { estimateSubtitleTokensFast } from "@/utils/tokenEstimate";
import type {
  AddGeneratedSubtitleTasksRequest,
  GeneratedSubtitleQueueReceipt,
} from "./translatorImportLedger";
import type { StartSubtitleTasksReceipt } from "./translatorQueueService";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HYDRATION_TIMEOUT_MS = 10_000;

export interface GeneratedSubtitleImportHydrationSource<T> {
  isHydrated(): boolean;
  onHydrated(listener: () => void): () => void;
  read(): T;
}

export interface GeneratedSubtitleImportCustomDirectoryLease {
  readonly displayLabel: string;
  readonly privateLease: unknown;
  release(): void | Promise<void>;
}

export interface GeneratedSubtitleImportPrivateSnapshot {
  readonly summary: SubtitleTranslationImportConfigSummary;
  readonly expiresAt: number;
  readonly modelFields?: SubtitleTaskModelFields;
  readonly tokenPricing?: TokenPricing;
  readonly customDirectoryLease?: unknown;
}

export interface GeneratedSubtitleImportSnapshotCoordinatorOptions {
  readonly configSource: GeneratedSubtitleImportHydrationSource<
    SubtitleTranslatorConfigPreferences
  >;
  readonly modelSource: GeneratedSubtitleImportHydrationSource<
    ModelProfile | null
  >;
  readonly acquireCustomDirectoryLease?: (options: {
    readonly snapshotId: string;
    readonly expiresAt: number;
    readonly displayLabel: string | null;
  }) => Promise<GeneratedSubtitleImportCustomDirectoryLease | undefined>;
  readonly hydrationTimeoutMs?: number;
  readonly snapshotTtlMs?: number;
  readonly now?: () => number;
  readonly snapshotIdFactory?: () => string;
}

interface StoredGeneratedSubtitleImportSnapshot {
  readonly privateSnapshot: GeneratedSubtitleImportPrivateSnapshot;
  readonly customDirectoryLease?: GeneratedSubtitleImportCustomDirectoryLease;
}

export class GeneratedSubtitleImportCoordinatorError extends Error {
  readonly name = "GeneratedSubtitleImportCoordinatorError";

  constructor(
    readonly code: "invalid_snapshot" | "snapshot_expired",
    message: string,
  ) {
    super(message);
  }
}

export class GeneratedSubtitleImportSnapshotCoordinator {
  readonly #options: GeneratedSubtitleImportSnapshotCoordinatorOptions;
  readonly #snapshots = new Map<string, StoredGeneratedSubtitleImportSnapshot>();
  readonly #pendingSnapshotIds = new Set<string>();
  readonly #releaseOperations = new Map<string, Promise<void>>();

  constructor(options: GeneratedSubtitleImportSnapshotCoordinatorOptions) {
    if (
      !options ||
      !isHydrationSource(options.configSource) ||
      !isHydrationSource(options.modelSource)
    ) {
      throw new TypeError("Generated subtitle import config sources are invalid.");
    }
    this.#options = options;
  }

  async prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult> {
    if (
      mode !== "enqueue_translation" &&
      mode !== "enqueue_and_start_translation"
    ) {
      throw new TypeError("Generated subtitle import mode is invalid.");
    }
    const hydrated = await waitForHydration(
      [this.#options.configSource, this.#options.modelSource],
      this.#options.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS,
    );
    if (!hydrated) return prepareFailure("configuration_not_ready");

    const preferences = sanitizeSubtitleTranslatorConfigPreferences(
      this.#options.configSource.read(),
    );
    const profile = validTaskProfile(this.#options.modelSource.read());
    if (mode === "enqueue_and_start_translation" && !profile) {
      return prepareFailure("profile_required");
    }

    const now = this.#options.now ?? Date.now;
    const createdAt = now();
    const expiresAt = createdAt + positiveSafeInteger(
      this.#options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
      "snapshotTtlMs",
    );
    const snapshotId = mintSnapshotId(
      this.#options.snapshotIdFactory ?? defaultSnapshotId,
      this.#snapshots,
      this.#pendingSnapshotIds,
      this.#releaseOperations,
    );
    this.#pendingSnapshotIds.add(snapshotId);
    let directoryLease: GeneratedSubtitleImportCustomDirectoryLease | undefined;
    try {
      if (preferences.outputMode === "custom") {
        const acquire = this.#options.acquireCustomDirectoryLease;
        if (!acquire) return prepareFailure("directory_authorization_required");
        directoryLease = await acquire({
          snapshotId,
          expiresAt,
          displayLabel: preferences.outputDirectoryDisplayLabel,
        });
        if (!validDirectoryLease(directoryLease)) {
          await releaseLease(directoryLease);
          return prepareFailure("directory_authorization_required");
        }
      }

      const executionBinding = profile
        ? Object.freeze({
            status: "ready" as const,
            taskProfileId: profile.id,
            taskProfileLabel: profile.name,
          })
        : Object.freeze({ status: "needs_configuration" as const });
      const summary = Object.freeze({
        snapshotId,
        createdAt,
        handoffMode: mode,
        executionBinding,
        sourceLang: preferences.sourceLang,
        targetLang: preferences.targetLang,
        translationOutputMode: preferences.translationOutputMode,
        sliceType: preferences.sliceType,
        ...(preferences.sliceType === "CUSTOM"
          ? { customSliceLength: preferences.customSliceLength }
          : {}),
        outputMode: preferences.outputMode,
        ...(directoryLease
          ? { outputDirectoryLabel: directoryLease.displayLabel }
          : {}),
        conflictPolicy: preferences.conflictPolicy,
        concurrentSlices: preferences.concurrentSlices,
      }) satisfies SubtitleTranslationImportConfigSummary;
      const privateSnapshot = Object.freeze({
        summary,
        expiresAt,
        ...(profile
          ? { modelFields: Object.freeze(createSubtitleTaskModelFields(profile)) }
          : {}),
        ...(profile?.tokenPricing
          ? { tokenPricing: Object.freeze({ ...profile.tokenPricing }) }
          : {}),
        ...(directoryLease
          ? { customDirectoryLease: directoryLease.privateLease }
          : {}),
      }) satisfies GeneratedSubtitleImportPrivateSnapshot;
      this.#snapshots.set(snapshotId, {
        privateSnapshot,
        ...(directoryLease ? { customDirectoryLease: directoryLease } : {}),
      });
      return Object.freeze({
        ok: true,
        snapshot: summary,
        canAutoStart: profile !== null,
        warnings: Object.freeze(
          profile ? [] : ["configuration_required"],
        ),
      });
    } finally {
      this.#pendingSnapshotIds.delete(snapshotId);
    }
  }

  async withSnapshot<T>(
    snapshotId: string,
    consumer: (snapshot: GeneratedSubtitleImportPrivateSnapshot) => T | Promise<T>,
  ): Promise<T> {
    if (typeof consumer !== "function") {
      throw new TypeError("Generated subtitle import snapshot consumer is invalid.");
    }
    const stored = this.#snapshots.get(snapshotId);
    if (!stored) throw invalidSnapshot();
    if (stored.privateSnapshot.expiresAt <= (this.#options.now ?? Date.now)()) {
      await this.releaseBatch(snapshotId);
      throw new GeneratedSubtitleImportCoordinatorError(
        "snapshot_expired",
        "Generated subtitle import snapshot expired.",
      );
    }
    return consumer(stored.privateSnapshot);
  }

  async releaseBatch(snapshotId: string): Promise<void> {
    const pending = this.#releaseOperations.get(snapshotId);
    if (pending) return pending;
    const stored = this.#snapshots.get(snapshotId);
    if (!stored) return;
    this.#snapshots.delete(snapshotId);
    const operation = releaseLease(stored.customDirectoryLease)
      .catch((error: unknown) => {
        if (!this.#snapshots.has(snapshotId)) {
          this.#snapshots.set(snapshotId, stored);
        }
        throw error;
      })
      .finally(() => {
        if (this.#releaseOperations.get(snapshotId) === operation) {
          this.#releaseOperations.delete(snapshotId);
        }
      });
    this.#releaseOperations.set(snapshotId, operation);
    return operation;
  }
}

export interface GeneratedSubtitleImportQueue {
  addImportedTasks(
    request: AddGeneratedSubtitleTasksRequest,
  ): GeneratedSubtitleQueueReceipt;
  startTasks(taskIds: readonly string[]): StartSubtitleTasksReceipt;
  releaseImportSnapshot(ownerId: string, snapshotId: string): void;
  hasTask?(taskId: string): boolean;
}

export interface GeneratedSubtitleImportCoordinatorOptions {
  readonly snapshots: GeneratedSubtitleImportSnapshotCoordinator;
  readonly mainApi: Pick<
    SubtitleTranslationRendererApi,
    | "createGeneratedImportCandidate"
    | "commitGeneratedImportCandidate"
    | "releaseGeneratedImportCandidate"
  >;
  readonly queue: GeneratedSubtitleImportQueue;
  readonly ownerId?: string;
  readonly receiptIdFactory?: () => string;
  readonly estimate?: typeof estimateSubtitleTokensFast;
}

export class GeneratedSubtitleImportCoordinator {
  readonly #options: GeneratedSubtitleImportCoordinatorOptions;
  readonly #receiptsByHandoff = new Map<string, SubtitleTranslationImportReceipt>();
  readonly #receiptHandoffsBySnapshot = new Map<string, Set<string>>();
  readonly #activeImports = new Map<string, number>();
  readonly #importWaiters = new Map<string, Set<() => void>>();
  readonly #releaseOperations = new Map<string, Promise<void>>();
  readonly #releasingSnapshots = new Set<string>();

  constructor(options: GeneratedSubtitleImportCoordinatorOptions) {
    if (
      !options ||
      !(options.snapshots instanceof GeneratedSubtitleImportSnapshotCoordinator) ||
      !validMainImportApi(options.mainApi) ||
      !validImportQueue(options.queue)
    ) {
      throw new TypeError("Generated subtitle import coordinator options are invalid.");
    }
    this.#options = options;
  }

  prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult> {
    return this.#options.snapshots.prepareBatch(mode);
  }

  hasTask(taskId: string): boolean {
    if (!safeId(taskId)) return false;
    return this.#options.queue.hasTask?.(taskId) ?? false;
  }

  async importArtifact(request: {
    readonly translationImportToken: string;
    readonly snapshotId: string;
  }): Promise<SubtitleTranslationImportReceipt> {
    if (
      !safeId(request?.translationImportToken) ||
      !safeId(request?.snapshotId) ||
      this.#releasingSnapshots.has(request.snapshotId)
    ) {
      throw invalidSnapshot();
    }
    this.#beginImport(request.snapshotId);
    try {
      return await this.#options.snapshots.withSnapshot(
        request.snapshotId,
        async (snapshot) => this.#importWithSnapshot(request, snapshot),
      );
    } finally {
      this.#endImport(request.snapshotId);
    }
  }

  async releaseBatch(snapshotId: string): Promise<void> {
    const pending = this.#releaseOperations.get(snapshotId);
    if (pending) return pending;
    this.#releasingSnapshots.add(snapshotId);
    const operation = (async () => {
      await this.#waitForImports(snapshotId);
      await this.#options.snapshots.releaseBatch(snapshotId);
      this.#options.queue.releaseImportSnapshot(this.ownerId, snapshotId);
      const handoffs = this.#receiptHandoffsBySnapshot.get(snapshotId);
      if (handoffs) {
        for (const handoffKey of handoffs) {
          this.#receiptsByHandoff.delete(handoffKey);
        }
        this.#receiptHandoffsBySnapshot.delete(snapshotId);
      }
    })().finally(() => {
      this.#releasingSnapshots.delete(snapshotId);
      if (this.#releaseOperations.get(snapshotId) === operation) {
        this.#releaseOperations.delete(snapshotId);
      }
    });
    this.#releaseOperations.set(snapshotId, operation);
    return operation;
  }

  private get ownerId(): string {
    return this.#options.ownerId ?? "subtitle-translation-renderer";
  }

  async #importWithSnapshot(
    request: {
      readonly translationImportToken: string;
      readonly snapshotId: string;
    },
    snapshot: GeneratedSubtitleImportPrivateSnapshot,
  ): Promise<SubtitleTranslationImportReceipt> {
    const receiptId = mintReceiptId(
      this.#options.receiptIdFactory ?? defaultSnapshotId,
    );
    const candidateResult = await this.#options.mainApi
      .createGeneratedImportCandidate({
        translationImportToken: request.translationImportToken,
        snapshotId: request.snapshotId,
        outputMode: snapshot.summary.outputMode,
        ...(typeof snapshot.customDirectoryLease === "string"
          ? { directoryLeaseToken: snapshot.customDirectoryLease }
          : {}),
      });
    if (!candidateResult.ok) {
      return emptyImportReceipt(
        receiptId,
        request.snapshotId,
        mapCandidateFailure(candidateResult.error.code),
      );
    }
    const candidate = candidateResult.data;
    const replay = this.#receiptsByHandoff.get(candidate.handoffKey);
    if (replay) return replay;

    const control = candidateControl(candidate);
    let taskAdded = false;
    try {
      const taskResult = createImportedTask(
        candidate,
        snapshot,
        this.#options.estimate ?? estimateSubtitleTokensFast,
      );
      const queueReceipt = this.#options.queue.addImportedTasks({
        receiptId,
        ownerId: this.ownerId,
        snapshotId: request.snapshotId,
        candidates: [{
          handoffKey: candidate.handoffKey,
          candidateBinding: candidate.candidateBinding,
          task: taskResult.task,
        }],
      });
      taskAdded = queueReceipt.addedTaskIds.includes(candidate.taskId);
      if (!taskAdded) {
        await requireCandidateRelease(this.#options.mainApi, control);
        return freezeImportReceipt({
          receiptId: queueReceipt.receiptId,
          snapshotId: queueReceipt.snapshotId,
          addedTaskIds: [],
          startedTaskIds: [],
          waitingTaskIds: [],
          notStartedTaskIds: [],
          startFailures: [],
          skipped: queueReceipt.skipped.map((item) => ({
            displayName: item.displayName,
            reason: "duplicate" as const,
          })),
        });
      }

      const committed = await this.#options.mainApi
        .commitGeneratedImportCandidate(control);
      const commitFailure = !committed.ok || !committed.data.committed;
      const shouldStart =
        snapshot.summary.handoffMode === "enqueue_and_start_translation" &&
        !taskResult.estimateFailed &&
        !commitFailure;
      const start = shouldStart
        ? this.#options.queue.startTasks(queueReceipt.addedTaskIds)
        : undefined;
      const receipt = freezeImportReceipt({
        receiptId: queueReceipt.receiptId,
        snapshotId: queueReceipt.snapshotId,
        addedTaskIds: queueReceipt.addedTaskIds,
        startedTaskIds: start?.startedTaskIds ?? [],
        waitingTaskIds: start?.waitingTaskIds ?? [],
        notStartedTaskIds: start?.notStartedTaskIds ?? queueReceipt.addedTaskIds,
        startFailures: start?.startFailures ?? (
          snapshot.summary.handoffMode === "enqueue_and_start_translation"
            ? [{
                taskId: candidate.taskId,
                reason: taskResult.estimateFailed
                  ? "estimate_failed" as const
                  : commitFailure && !committed.ok &&
                      committed.error.code === "authorization_expired"
                    ? "authorization_expired" as const
                    : "start_rejected" as const,
              }]
            : []
        ),
        skipped: queueReceipt.skipped.map((item) => ({
          displayName: item.displayName,
          reason: "duplicate" as const,
        })),
      });
      this.#receiptsByHandoff.set(candidate.handoffKey, receipt);
      const snapshotHandoffs =
        this.#receiptHandoffsBySnapshot.get(request.snapshotId) ?? new Set();
      snapshotHandoffs.add(candidate.handoffKey);
      this.#receiptHandoffsBySnapshot.set(request.snapshotId, snapshotHandoffs);
      return receipt;
    } catch (error) {
      if (!taskAdded) {
        await this.#options.mainApi.releaseGeneratedImportCandidate(control)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  #beginImport(snapshotId: string): void {
    this.#activeImports.set(snapshotId, (this.#activeImports.get(snapshotId) ?? 0) + 1);
  }

  #endImport(snapshotId: string): void {
    const next = (this.#activeImports.get(snapshotId) ?? 1) - 1;
    if (next > 0) {
      this.#activeImports.set(snapshotId, next);
      return;
    }
    this.#activeImports.delete(snapshotId);
    const waiters = this.#importWaiters.get(snapshotId);
    this.#importWaiters.delete(snapshotId);
    for (const resolve of waiters ?? []) resolve();
  }

  #waitForImports(snapshotId: string): Promise<void> {
    if (!this.#activeImports.has(snapshotId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.#importWaiters.get(snapshotId) ?? new Set();
      waiters.add(resolve);
      this.#importWaiters.set(snapshotId, waiters);
    });
  }
}

function createImportedTask(
  candidate: SubtitleTranslationGeneratedImportCandidate,
  snapshot: GeneratedSubtitleImportPrivateSnapshot,
  estimate: typeof estimateSubtitleTokensFast,
): Readonly<{ task: SubtitleTranslatorTask; estimateFailed: boolean }> {
  const executionBinding: SubtitleTaskExecutionBinding =
    snapshot.summary.executionBinding.status === "ready" && snapshot.modelFields
      ? Object.freeze({
          status: "ready" as const,
          profileId: snapshot.summary.executionBinding.taskProfileId,
          profileLabel: snapshot.summary.executionBinding.taskProfileLabel,
          ...snapshot.modelFields,
        })
      : Object.freeze({ status: "needs_configuration" as const });
  let estimateFailed = false;
  let costEstimate: SubtitleTranslatorTask["costEstimate"];
  try {
    costEstimate = estimate(
      candidate.content,
      snapshot.summary.sliceType,
      snapshot.summary.customSliceLength,
      undefined,
      snapshot.tokenPricing,
      {
        fileName: candidate.displayName,
        sourceLang: snapshot.summary.sourceLang,
        targetLang: snapshot.summary.targetLang,
        translationOutputMode: snapshot.summary.translationOutputMode,
      },
    );
  } catch {
    estimateFailed = true;
    costEstimate = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      fragmentCount: 0,
      loading: false,
    };
  }
  return Object.freeze({
    task: Object.freeze({
      taskId: candidate.taskId,
      fileName: candidate.displayName,
      fileContent: candidate.content,
      sliceType: snapshot.summary.sliceType,
      ...(snapshot.summary.customSliceLength !== undefined
        ? { customSliceLength: snapshot.summary.customSliceLength }
        : {}),
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      costEstimate,
      executionBinding,
      sourceLang: snapshot.summary.sourceLang,
      targetLang: snapshot.summary.targetLang,
      translationOutputMode: snapshot.summary.translationOutputMode,
      conflictPolicy: snapshot.summary.conflictPolicy,
      concurrentSlices: snapshot.summary.concurrentSlices,
      recoveryInputMode: "manifest_fragments",
      taskReference: candidate.reference,
    }),
    estimateFailed,
  });
}

function candidateControl(
  candidate: SubtitleTranslationGeneratedImportCandidate,
): SubtitleTranslationGeneratedImportCandidateControl {
  return Object.freeze({
    taskId: candidate.taskId,
    handoffKey: candidate.handoffKey,
    candidateBinding: candidate.candidateBinding,
  });
}

async function requireCandidateRelease(
  api: GeneratedSubtitleImportCoordinatorOptions["mainApi"],
  control: SubtitleTranslationGeneratedImportCandidateControl,
): Promise<void> {
  const released = await api.releaseGeneratedImportCandidate(control);
  if (!released.ok) {
    throw new Error("subtitle_import_candidate_release_failed");
  }
}

function emptyImportReceipt(
  receiptId: string,
  snapshotId: string,
  reason: SubtitleTranslationImportSkipReason,
): SubtitleTranslationImportReceipt {
  return freezeImportReceipt({
    receiptId,
    snapshotId,
    addedTaskIds: [],
    startedTaskIds: [],
    waitingTaskIds: [],
    notStartedTaskIds: [],
    startFailures: [],
    skipped: [{ displayName: "Generated subtitle", reason }],
  });
}

function freezeImportReceipt(
  receipt: SubtitleTranslationImportReceipt,
): SubtitleTranslationImportReceipt {
  const added = new Set(receipt.addedTaskIds);
  const partitions = [
    receipt.startedTaskIds,
    receipt.waitingTaskIds,
    receipt.notStartedTaskIds,
  ];
  const union = new Set<string>();
  for (const partition of partitions) {
    for (const taskId of partition) {
      if (union.has(taskId)) {
        throw new TypeError("Generated subtitle import receipt partitions overlap.");
      }
      union.add(taskId);
    }
  }
  if (
    union.size !== added.size ||
    [...union].some((taskId) => !added.has(taskId)) ||
    receipt.startFailures.some(
      (failure) => !receipt.notStartedTaskIds.includes(failure.taskId),
    )
  ) {
    throw new TypeError("Generated subtitle import receipt is inconsistent.");
  }
  return Object.freeze({
    receiptId: receipt.receiptId,
    snapshotId: receipt.snapshotId,
    addedTaskIds: Object.freeze([...receipt.addedTaskIds]),
    startedTaskIds: Object.freeze([...receipt.startedTaskIds]),
    waitingTaskIds: Object.freeze([...receipt.waitingTaskIds]),
    notStartedTaskIds: Object.freeze([...receipt.notStartedTaskIds]),
    startFailures: Object.freeze(
      receipt.startFailures.map((failure) => Object.freeze({ ...failure })),
    ),
    skipped: Object.freeze(
      receipt.skipped.map((skipped) => Object.freeze({ ...skipped })),
    ),
  });
}

function mapCandidateFailure(code: string): SubtitleTranslationImportSkipReason {
  if (code === "artifact_expired" || code === "authorization_expired") {
    return "artifact_expired";
  }
  if (code === "content_too_large") return "content_too_large";
  if (code === "task_reference_conflict") return "duplicate";
  return "invalid_content";
}

function mintReceiptId(factory: () => string): string {
  const receiptId = `subtitle-import-receipt-${factory()}`;
  if (!safeId(receiptId)) {
    throw new TypeError("Generated subtitle import receipt ID source is invalid.");
  }
  return receiptId;
}

function validMainImportApi(
  value: GeneratedSubtitleImportCoordinatorOptions["mainApi"] | undefined,
): value is GeneratedSubtitleImportCoordinatorOptions["mainApi"] {
  return Boolean(
    value &&
    typeof value.createGeneratedImportCandidate === "function" &&
    typeof value.commitGeneratedImportCandidate === "function" &&
    typeof value.releaseGeneratedImportCandidate === "function",
  );
}

function validImportQueue(
  value: GeneratedSubtitleImportQueue | undefined,
): value is GeneratedSubtitleImportQueue {
  return Boolean(
    value &&
    typeof value.addImportedTasks === "function" &&
    typeof value.startTasks === "function" &&
    typeof value.releaseImportSnapshot === "function",
  );
}

let sharedCoordinator: GeneratedSubtitleImportSnapshotCoordinator | undefined;
let sharedImportCoordinator: GeneratedSubtitleImportCoordinator | undefined;
let currentCustomDirectoryAuthorization:
  | Readonly<{
      directoryToken: string;
      displayLabel: string;
      expiresAt: number;
    }>
  | undefined;
const pendingCustomDirectoryRevocations = new Set<string>();
let pendingCustomDirectorySelection:
  | Promise<Readonly<{ cancelled: boolean; displayLabel?: string }>>
  | undefined;

export function getCurrentSubtitleTranslatorCustomDirectoryAuthorization():
  | Readonly<{
      directoryToken: string;
      displayLabel: string;
      expiresAt: number;
    }>
  | undefined {
  const current = currentCustomDirectoryAuthorization;
  return current && current.expiresAt > Date.now() ? current : undefined;
}

export function getGeneratedSubtitleImportSnapshotCoordinator():
  GeneratedSubtitleImportSnapshotCoordinator {
  sharedCoordinator ??= new GeneratedSubtitleImportSnapshotCoordinator({
    configSource: persistedStoreSource(
      useSubtitleTranslatorConfigStore,
      () => useSubtitleTranslatorConfigStore.getState().preferences,
      () =>
        useSubtitleTranslatorConfigStore.getState().migrationStatus === "ready",
    ),
    modelSource: persistedStoreSource(
      useModelStore,
      () => useModelStore.getState().getTaskProfile(),
    ),
    acquireCustomDirectoryLease: acquireGeneratedSubtitleImportCustomDirectoryLease,
  });
  return sharedCoordinator;
}

export function getGeneratedSubtitleImportCoordinator():
  GeneratedSubtitleImportCoordinator {
  sharedImportCoordinator ??= new GeneratedSubtitleImportCoordinator({
    snapshots: getGeneratedSubtitleImportSnapshotCoordinator(),
    mainApi: window.subtitleTranslationApi,
    queue: {
      addImportedTasks: (request) =>
        useSubtitleTranslatorStore.getState().addImportedTasks(request),
      startTasks: (taskIds) =>
        useSubtitleTranslatorStore.getState().startTasks(taskIds),
      releaseImportSnapshot: (ownerId, snapshotId) =>
        useSubtitleTranslatorStore.getState()
          .releaseImportSnapshot(ownerId, snapshotId),
      hasTask: (taskId) => {
        const state = useSubtitleTranslatorStore.getState();
        return [
          ...state.notStartedTaskQueue,
          ...state.waitingTaskQueue,
          ...state.pendingTaskQueue,
          ...state.resolvedTaskQueue,
          ...state.failedTaskQueue,
        ].some((task) => task.taskId === taskId);
      },
    },
  });
  return sharedImportCoordinator;
}

export async function selectGeneratedSubtitleImportCustomDirectory(): Promise<
  Readonly<{ cancelled: boolean; displayLabel?: string }>
> {
  await flushPendingCustomDirectoryRevocations();
  const result = await window.subtitleTranslationApi.selectOutputDirectory();
  if (!result.ok || result.data.cancelled) {
    return Object.freeze({ cancelled: true });
  }
  const previous = currentCustomDirectoryAuthorization;
  currentCustomDirectoryAuthorization = Object.freeze({
    directoryToken: result.data.directoryToken!,
    displayLabel: result.data.displayLabel!,
    expiresAt: result.data.expiresAt!,
  });
  if (previous) {
    const revoked = await window.subtitleTranslationApi
      .revokeOutputDirectory(previous.directoryToken);
    if (!revoked.ok) {
      pendingCustomDirectoryRevocations.add(previous.directoryToken);
    }
  }
  return Object.freeze({
    cancelled: false,
    displayLabel: currentCustomDirectoryAuthorization.displayLabel,
  });
}

export async function clearGeneratedSubtitleImportCustomDirectory():
  Promise<void> {
  await flushPendingCustomDirectoryRevocations();
  const current = getCurrentSubtitleTranslatorCustomDirectoryAuthorization();
  currentCustomDirectoryAuthorization = undefined;
  if (!current) return;
  const result = await window.subtitleTranslationApi
    .revokeOutputDirectory(current.directoryToken);
  if (!result.ok) {
    currentCustomDirectoryAuthorization = current;
    throw new Error("subtitle_import_directory_revoke_failed");
  }
}

async function flushPendingCustomDirectoryRevocations(): Promise<void> {
  for (const directoryToken of [...pendingCustomDirectoryRevocations]) {
    const result = await window.subtitleTranslationApi
      .revokeOutputDirectory(directoryToken);
    if (result.ok) pendingCustomDirectoryRevocations.delete(directoryToken);
  }
}

export async function acquireGeneratedSubtitleImportCustomDirectoryLease(options: {
  readonly snapshotId: string;
  readonly expiresAt: number;
  readonly displayLabel: string | null;
}): Promise<GeneratedSubtitleImportCustomDirectoryLease | undefined> {
  const current = await ensureGeneratedSubtitleImportCustomDirectoryAuthorization();
  if (!current) return undefined;
  const result = await window.subtitleTranslationApi.acquireImportDirectoryLease({
    directoryToken: current.directoryToken,
    snapshotId: options.snapshotId,
    expiresAt: options.expiresAt,
  });
  if (!result.ok) return undefined;
  return {
    displayLabel: result.data.displayLabel,
    privateLease: result.data.directoryLeaseToken,
    release: async () => {
      const released = await window.subtitleTranslationApi
        .releaseImportDirectoryLease(result.data.directoryLeaseToken);
      if (!released.ok) {
        throw new Error("subtitle_import_directory_lease_release_failed");
      }
    },
  };
}

export async function ensureGeneratedSubtitleImportCustomDirectoryAuthorization():
  Promise<ReturnType<
    typeof getCurrentSubtitleTranslatorCustomDirectoryAuthorization
  >> {
  const current = getCurrentSubtitleTranslatorCustomDirectoryAuthorization();
  if (current) return current;

  const selection = pendingCustomDirectorySelection ??
    selectGeneratedSubtitleImportCustomDirectory();
  pendingCustomDirectorySelection = selection;
  try {
    await selection;
  } finally {
    if (pendingCustomDirectorySelection === selection) {
      pendingCustomDirectorySelection = undefined;
    }
  }
  return getCurrentSubtitleTranslatorCustomDirectoryAuthorization();
}

export function resetGeneratedSubtitleImportCoordinatorForTests(): void {
  sharedCoordinator = undefined;
  sharedImportCoordinator = undefined;
  currentCustomDirectoryAuthorization = undefined;
  pendingCustomDirectorySelection = undefined;
  pendingCustomDirectoryRevocations.clear();
}

function persistedStoreSource<T>(
  store: {
    readonly persist: {
      hasHydrated(): boolean;
      onFinishHydration(listener: () => void): () => void;
    };
  },
  read: () => T,
  isReady: () => boolean = () => true,
): GeneratedSubtitleImportHydrationSource<T> {
  return {
    isHydrated: () => store.persist.hasHydrated() && isReady(),
    onHydrated: (listener) => store.persist.onFinishHydration(listener),
    read,
  };
}

async function waitForHydration(
  sources: readonly GeneratedSubtitleImportHydrationSource<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  positiveSafeInteger(timeoutMs, "hydrationTimeoutMs");
  if (sources.every((source) => source.isHydrated())) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribers: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve(result);
    };
    unsubscribers = sources.map((source) =>
      source.onHydrated(() => {
        queueMicrotask(() => {
          if (sources.every((candidate) => candidate.isHydrated())) finish(true);
        });
      }),
    );
    timer = setTimeout(() => finish(false), timeoutMs);
    if (sources.every((source) => source.isHydrated())) finish(true);
  });
}

function prepareFailure(
  code:
    | "configuration_not_ready"
    | "directory_authorization_required"
    | "profile_required",
): PrepareGeneratedSubtitleImportResult {
  return Object.freeze({
    ok: false,
    code,
    warnings: Object.freeze([]),
  });
}

function validTaskProfile(profile: ModelProfile | null): ModelProfile | null {
  return profile &&
    safeId(profile.id) &&
    safeSummaryLabel(profile.name) &&
    nonBlank(profile.apiKey) &&
    nonBlank(profile.modelKey) &&
    nonBlank(profile.baseUrl)
    ? Object.freeze({ ...profile })
    : null;
}

function mintSnapshotId(
  factory: () => string,
  snapshots: ReadonlyMap<string, unknown>,
  pendingSnapshotIds: ReadonlySet<string>,
  releaseOperations: ReadonlyMap<string, unknown>,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `subtitle-import-snapshot-${factory()}`;
    if (
      safeId(candidate) &&
      !snapshots.has(candidate) &&
      !pendingSnapshotIds.has(candidate) &&
      !releaseOperations.has(candidate)
    ) {
      return candidate;
    }
  }
  throw new TypeError("Generated subtitle import snapshot ID source is invalid.");
}

function validDirectoryLease(
  lease: GeneratedSubtitleImportCustomDirectoryLease | undefined,
): lease is GeneratedSubtitleImportCustomDirectoryLease {
  return Boolean(
    lease &&
    safeDisplayLabel(lease.displayLabel) &&
    lease.privateLease !== undefined &&
    lease.privateLease !== null &&
    typeof lease.release === "function",
  );
}

function defaultSnapshotId(): string {
  return globalThis.crypto.randomUUID();
}

async function releaseLease(
  lease: GeneratedSubtitleImportCustomDirectoryLease | undefined,
): Promise<void> {
  if (lease) await lease.release();
}

function invalidSnapshot(): GeneratedSubtitleImportCoordinatorError {
  return new GeneratedSubtitleImportCoordinatorError(
    "invalid_snapshot",
    "Generated subtitle import snapshot is invalid.",
  );
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Generated subtitle import ${field} is invalid.`);
  }
  return value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value);
}

function safeDisplayLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim().length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function safeSummaryLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHydrationSource(
  source: GeneratedSubtitleImportHydrationSource<unknown> | undefined,
): source is GeneratedSubtitleImportHydrationSource<unknown> {
  return Boolean(
    source &&
    typeof source.isHydrated === "function" &&
    typeof source.onHydrated === "function" &&
    typeof source.read === "function",
  );
}
