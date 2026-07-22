import { randomUUID } from "node:crypto";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_ERROR_MANIFEST,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_OPERATION_STAGES,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  createLocalSubtitleBatchConfigSnapshot,
  createLocalSubtitleError,
  deriveLocalSubtitleBatchStatus,
  isLocalSubtitleErrorCode,
  transitionLocalSubtitleTaskState,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleError,
  type LocalSubtitleErrorCode,
  type LocalSubtitleOperationStage,
  type LocalSubtitlePostActionState,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskProgress,
  type LocalSubtitleTaskStatus,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import {
  enqueueLocalSubtitleBatchRequestSchema,
  type EnqueueLocalSubtitleBatchRequest,
} from "@/type/localSubtitleIpc";
import {
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type LocalSubtitleOwnerKey,
  type ResolvedLocalSubtitleInput,
} from "./authorizations";
import type { LocalSubtitleMainRuntimeShutdownReason } from "./main-runtime";
import type { LocalSubtitleServerManagedResourceIdentity } from "./server-process-contract";
import {
  LocalSubtitleSessionRegistry,
  type LocalSubtitleTaskEventListener,
} from "./session-registry";

const WORKING_STATUSES = new Set<LocalSubtitleTaskStatus>([
  "preparing_media",
  "loading_model",
  "transcribing",
  "post_processing",
  "exporting",
]);
const TERMINAL_STATUSES = new Set<LocalSubtitleTaskStatus>([
  "completed",
  "cancelled",
  "failed",
]);
const MODEL_LOAD_ERROR_CODES = new Set<LocalSubtitleErrorCode>([
  "model_missing",
  "model_incompatible",
  "model_corrupt",
]);
const CLEANUP_FAILURE_CODES = new Set<LocalSubtitleErrorCode>([
  "cleanup_failed",
  "cancel_failed",
]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export type LocalSubtitleJobManagerErrorCode = Extract<
  LocalSubtitleErrorCode,
  | "invalid_ipc_request"
  | "owner_released"
  | "authorization_expired"
  | "resource_busy"
  | "runtime_missing"
  | "model_corrupt"
  | "invalid_content"
  | "cancel_failed"
>;

export class LocalSubtitleJobManagerError extends Error {
  readonly name = "LocalSubtitleJobManagerError";

  constructor(
    readonly localSubtitleCode: LocalSubtitleJobManagerErrorCode,
    message: string,
    readonly stage: LocalSubtitleOperationStage = "preflight",
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface LocalSubtitleJobModelResolver {
  resolveManagedModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerManagedResourceIdentity<"managed">>;
}

export interface LocalSubtitleJobArtifactRegistry {
  revokeTask(owner: LocalSubtitleOwnerKey, taskId: string): number;
}

export interface LocalSubtitleJobRuntimeVerifier {
  verifyRuntime(options: {
    readonly owner: LocalSubtitleOwnerKey;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly runtimeGeneration: string }>;
}

export interface LocalSubtitleJobTaskUpdate {
  readonly status: Extract<
    LocalSubtitleTaskStatus,
    | "preparing_media"
    | "loading_model"
    | "transcribing"
    | "post_processing"
    | "exporting"
  >;
  readonly progress: LocalSubtitleTaskProgress;
  readonly durationMs?: number;
}

declare const JOB_BATCH_RUNTIME_BRAND: unique symbol;

export interface LocalSubtitleJobBatchRuntime {
  readonly [JOB_BATCH_RUNTIME_BRAND]: true;
}

export interface LocalSubtitleJobBatchExecutionContext {
  readonly owner: LocalSubtitleOwnerKey;
  readonly batchId: string;
  readonly config: LocalSubtitleBatchConfigSnapshot;
  readonly managedModel: LocalSubtitleServerManagedResourceIdentity<"managed">;
  readonly admittedRuntimeGeneration: string;
  readonly signal: AbortSignal;
}

export interface LocalSubtitleJobTaskExecutionContext {
  readonly owner: LocalSubtitleOwnerKey;
  readonly batchId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly fileToken: string;
  readonly audioStreamId?: string;
  readonly config: LocalSubtitleBatchConfigSnapshot;
  readonly managedModel: LocalSubtitleServerManagedResourceIdentity<"managed">;
  readonly admittedRuntimeGeneration: string;
  readonly batchRuntime: LocalSubtitleJobBatchRuntime;
  readonly signal: AbortSignal;
  update(update: LocalSubtitleJobTaskUpdate): LocalSubtitleTaskSummary;
}

export type LocalSubtitleJobTaskExecutionResult =
  | {
      readonly status: "completed";
      readonly artifactResults: readonly LocalSubtitleArtifactResult[];
      readonly durationMs?: number;
      readonly postAction?: LocalSubtitlePostActionState;
    }
  | {
      readonly status: "failed";
      readonly error: LocalSubtitleError;
      readonly artifactResults?: readonly LocalSubtitleArtifactResult[];
      readonly durationMs?: number;
    }
  | {
      readonly status: "cancelled";
      readonly artifactResults?: readonly LocalSubtitleArtifactResult[];
      readonly durationMs?: number;
    };

export interface LocalSubtitleJobTaskExecutor {
  beginBatchSlice(
    context: LocalSubtitleJobBatchExecutionContext,
  ): LocalSubtitleJobBatchRuntime;
  execute(
    context: LocalSubtitleJobTaskExecutionContext,
  ): Promise<LocalSubtitleJobTaskExecutionResult>;
  endBatchSlice(runtime: LocalSubtitleJobBatchRuntime): void;
}

export interface LocalSubtitleJobManagerOptions {
  readonly registry: LocalSubtitleSessionRegistry;
  readonly inputs: LocalSubtitleInputAuthorizationRegistry;
  readonly outputs: LocalSubtitleOutputDirectoryAuthorizationRegistry;
  readonly leases: LocalSubtitleCapabilityLeaseCoordinator;
  readonly runtimeVerifier: LocalSubtitleJobRuntimeVerifier;
  readonly modelResolver: LocalSubtitleJobModelResolver;
  readonly executor: LocalSubtitleJobTaskExecutor;
  readonly artifacts?: LocalSubtitleJobArtifactRegistry;
  readonly now?: () => number;
  readonly batchIdFactory?: () => string;
  readonly taskIdFactory?: () => string;
  readonly snapshotIdFactory?: () => string;
  readonly schedule?: (operation: () => void) => void;
  readonly leaseRenewalIntervalMs?: number;
  readonly scheduleLeaseRenewal?: (
    operation: () => void,
    delayMs: number,
  ) => () => void;
}

type TaskRecordState =
  | "queued"
  | "running"
  | "terminal"
  | "removed"
  | "fenced";

interface BatchRecord {
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerKey: string;
  readonly batchId: string;
  readonly config: LocalSubtitleBatchConfigSnapshot;
  readonly managedModel: LocalSubtitleServerManagedResourceIdentity<"managed">;
  readonly runtimeGeneration: string;
  readonly outputDirToken?: string;
  readonly taskIds: Set<string>;
  outputLeaseReleased: boolean;
}

interface TaskRecord {
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerKey: string;
  readonly batch: BatchRecord;
  readonly taskId: string;
  readonly fileToken: string;
  readonly audioStreamId?: string;
  generation: number;
  state: TaskRecordState;
  cancelRequested: boolean;
  inputLeaseReleased: boolean;
  artifactsRevoked: boolean;
  leaseFailure?: unknown;
  run?: TaskRun;
}

interface TaskRun {
  readonly record: TaskRecord;
  readonly generation: number;
  readonly admissionSequence: number;
  readonly controller: AbortController;
}

interface ActiveBatchSlice {
  readonly batch: BatchRecord;
  readonly admissionSequence: number;
  readonly runtime: LocalSubtitleJobBatchRuntime;
  readonly controller: AbortController;
  closeRequested: boolean;
}

interface PendingEnqueue {
  readonly ownerKey: string;
  readonly controller: AbortController;
  readonly detach: () => void;
  readonly admission: QueueAdmission;
}

interface QueueAdmission {
  readonly sequence: number;
  readonly ownerKey: string;
  state: "pending" | "ready" | "skipped";
  runs?: readonly TaskRun[];
}

interface IdleWaiter {
  readonly ownerKey?: string;
  readonly resolve: () => void;
}

export class LocalSubtitleJobManager {
  readonly #registry: LocalSubtitleSessionRegistry;
  readonly #inputs: LocalSubtitleInputAuthorizationRegistry;
  readonly #outputs: LocalSubtitleOutputDirectoryAuthorizationRegistry;
  readonly #leases: LocalSubtitleCapabilityLeaseCoordinator;
  readonly #runtimeVerifier: LocalSubtitleJobRuntimeVerifier;
  readonly #modelResolver: LocalSubtitleJobModelResolver;
  readonly #executor: LocalSubtitleJobTaskExecutor;
  readonly #artifacts?: LocalSubtitleJobArtifactRegistry;
  readonly #now: () => number;
  readonly #batchIdFactory: () => string;
  readonly #taskIdFactory: () => string;
  readonly #snapshotIdFactory: () => string;
  readonly #schedule: (operation: () => void) => void;
  readonly #leaseRenewalIntervalMs: number;
  readonly #scheduleLeaseRenewal: (
    operation: () => void,
    delayMs: number,
  ) => () => void;
  readonly #batches = new Map<string, BatchRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #pendingBatchIds = new Set<string>();
  readonly #pendingTaskIds = new Set<string>();
  readonly #queue: TaskRun[] = [];
  readonly #admissions: QueueAdmission[] = [];
  readonly #releasedOwners = new Set<string>();
  readonly #pendingEnqueues = new Set<PendingEnqueue>();
  readonly #operations = new Map<Promise<void>, string>();
  readonly #idleWaiters = new Set<IdleWaiter>();
  #activeRun: TaskRun | undefined;
  #activeBatchSlice: ActiveBatchSlice | undefined;
  #drainScheduled = false;
  #nextAdmissionSequence = 1;
  readonly #cancelLeaseRenewals = new Map<string, () => void>();
  readonly #leaseOperationTails = new Map<string, Promise<void>>();
  readonly #leaseOperationCounts = new Map<string, number>();
  #shuttingDown = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(options: LocalSubtitleJobManagerOptions) {
    if (
      !options ||
      !(options.registry instanceof LocalSubtitleSessionRegistry) ||
      !(options.inputs instanceof LocalSubtitleInputAuthorizationRegistry) ||
      !(options.outputs instanceof LocalSubtitleOutputDirectoryAuthorizationRegistry) ||
      !(options.leases instanceof LocalSubtitleCapabilityLeaseCoordinator) ||
      typeof options.runtimeVerifier?.verifyRuntime !== "function" ||
      typeof options.modelResolver?.resolveManagedModel !== "function" ||
      typeof options.executor?.beginBatchSlice !== "function" ||
      typeof options.executor?.execute !== "function" ||
      typeof options.executor?.endBatchSlice !== "function" ||
      (options.scheduleLeaseRenewal !== undefined &&
        typeof options.scheduleLeaseRenewal !== "function")
    ) {
      throw new TypeError("The local subtitle job manager options are invalid.");
    }
    this.#registry = options.registry;
    this.#inputs = options.inputs;
    this.#outputs = options.outputs;
    this.#leases = options.leases;
    this.#runtimeVerifier = options.runtimeVerifier;
    this.#modelResolver = options.modelResolver;
    this.#executor = options.executor;
    this.#artifacts = options.artifacts;
    this.#now = options.now ?? Date.now;
    this.#batchIdFactory = options.batchIdFactory ??
      (() => `batch-${randomUUID()}`);
    this.#taskIdFactory = options.taskIdFactory ??
      (() => `task-${randomUUID()}`);
    this.#snapshotIdFactory = options.snapshotIdFactory ??
      (() => `snapshot-${randomUUID()}`);
    this.#schedule = options.schedule ?? ((operation) => setImmediate(operation));
    const maximumRenewalInterval = Math.min(
      options.inputs.leaseTtlMs,
      options.outputs.leaseTtlMs,
    );
    this.#leaseRenewalIntervalMs = leaseRenewalInterval(
      options.leaseRenewalIntervalMs,
      maximumRenewalInterval,
    );
    this.#scheduleLeaseRenewal = options.scheduleLeaseRenewal ??
      ((operation, delayMs) => {
        const timer = setTimeout(operation, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  async enqueue(
    owner: LocalSubtitleOwnerKey,
    request: EnqueueLocalSubtitleBatchRequest,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleBatchSummary> {
    this.#assertOwnerAvailable(owner);
    const parsed = parseEnqueueRequest(request);
    assertProductionBatchSliceRequest(parsed);
    const ownerKeyValue = ownerKey(owner);
    const pending = this.#beginPendingEnqueue(ownerKeyValue, signal);
    let transaction:
      | Awaited<ReturnType<LocalSubtitleCapabilityLeaseCoordinator["reserveBatch"]>>
      | undefined;
    let claimedBatchId: string | undefined;
    const claimedTaskIds: string[] = [];
    try {
      throwIfAborted(pending.controller.signal);
      const batchId = this.#claimId(
        this.#batchIdFactory,
        this.#batches,
        this.#pendingBatchIds,
        "batchId",
      );
      claimedBatchId = batchId;
      const taskIds = parsed.files.map(() => {
        const taskId = this.#claimId(
          this.#taskIdFactory,
          this.#tasks,
          this.#pendingTaskIds,
          "taskId",
        );
        claimedTaskIds.push(taskId);
        return taskId;
      });
      const createdAt = this.#timestamp();
      const [managedModel, inputs, runtimeAdmission] = await Promise.all([
        this.#modelResolver.resolveManagedModel(
          parsed.config.modelId,
          pending.controller.signal,
        ),
        Promise.all(
          parsed.files.map((file) =>
            this.#inputs.resolveDraft(owner, file.fileToken, "transcribe")
          ),
        ),
        this.#runtimeVerifier.verifyRuntime({
          owner,
          signal: pending.controller.signal,
        }),
      ]);
      throwIfAborted(pending.controller.signal);
      this.#assertOwnerAvailable(owner);
      assertManagedModel(managedModel, parsed.config.modelId);
      assertDistinctInputIdentities(inputs);
      const runtimeGeneration = assertRuntimeAdmission(runtimeAdmission);

      const config = createConfigSnapshot(
        parsed,
        managedModel,
        batchId,
        this.#mintSnapshotId(),
        createdAt,
      );
      const batchRecord: BatchRecord = {
        owner: Object.freeze({ ...owner }),
        ownerKey: ownerKeyValue,
        batchId,
        config,
        managedModel: freezeManagedModel(managedModel),
        runtimeGeneration,
        ...(parsed.config.output.mode === "custom"
          ? { outputDirToken: parsed.config.output.outputDirToken }
          : {}),
        taskIds: new Set(taskIds),
        outputLeaseReleased: false,
      };
      const records = parsed.files.map((file, index): TaskRecord => ({
        owner: batchRecord.owner,
        ownerKey: ownerKeyValue,
        batch: batchRecord,
        taskId: taskIds[index]!,
        fileToken: file.fileToken,
        ...(file.audioStreamId === undefined
          ? {}
          : { audioStreamId: file.audioStreamId }),
        generation: 1,
        state: "queued",
        cancelRequested: false,
        inputLeaseReleased: false,
        artifactsRevoked: false,
      }));
      const summaries = records.map((record, index) =>
        createQueuedTaskSummary(record, inputs[index]!.displayName, createdAt)
      );
      const batch = createBatchSummary(batchRecord, summaries, createdAt);

      transaction = await this.#leases.reserveBatch({
        owner,
        batchId,
        inputs: records.map((record) => ({
          fileToken: record.fileToken,
          taskId: record.taskId,
        })),
        ...(batchRecord.outputDirToken === undefined
          ? {}
          : { outputDirToken: batchRecord.outputDirToken }),
      });
      throwIfAborted(pending.controller.signal);
      this.#assertOwnerAvailable(owner);

      const publication = this.#registry.prepareBatchPublication(owner, batch);
      this.#batches.set(batchId, batchRecord);
      for (const record of records) this.#tasks.set(record.taskId, record);
      try {
        transaction.commitAndRun(() => publication.commit());
      } catch (error) {
        let rollbackFailure: unknown;
        try {
          publication.rollback();
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        } finally {
          for (const record of records) this.#tasks.delete(record.taskId);
          this.#batches.delete(batchId);
        }
        throw rollbackFailure ?? error;
      }
      transaction = undefined;
      const runs = records.map((record) =>
        this.#createRun(record, pending.admission.sequence)
      );
      publication.publish();

      const runnable = runs.filter((run) =>
        run.record.state === "queued" &&
        !run.record.cancelRequested &&
        !this.#releasedOwners.has(ownerKeyValue)
      );
      this.#settleAdmission(pending.admission, runnable);
      this.#ensureLeaseRenewalScheduled();
      return this.#registry.getBatch(owner, batchId) ?? batch;
    } finally {
      transaction?.rollback();
      this.#settleAdmission(pending.admission);
      pending.detach();
      this.#pendingEnqueues.delete(pending);
      if (claimedBatchId) this.#pendingBatchIds.delete(claimedBatchId);
      for (const taskId of claimedTaskIds) this.#pendingTaskIds.delete(taskId);
      this.#flushIdleWaiters();
    }
  }

  async retryTask(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
  ): Promise<LocalSubtitleTaskSummary> {
    this.#assertOwnerAvailable(owner);
    const record = this.#ownedTask(owner, taskId);
    const current = record ? this.#registry.getTask(owner, taskId) : undefined;
    if (!record || !current || current.status !== "failed" || record.state !== "terminal") {
      throw managerFailure(
        "invalid_ipc_request",
        "Only a failed local subtitle task can be retried.",
        "preflight",
        "taskId",
      );
    }
    if (
      current.error !== undefined &&
      CLEANUP_FAILURE_CODES.has(current.error.code)
    ) {
      throw managerFailure(
        "invalid_ipc_request",
        "Cleanup-failed tasks cannot be retried in the same owner session. " +
          "Start a new owner session and authorize the input and output paths again.",
        "preflight",
        "taskId",
      );
    }
    const admission = this.#beginAdmission(record.ownerKey);
    try {
      await this.#runLeaseOperation(
        record.ownerKey,
        () => this.#renewTaskCapabilities(record),
      );
      this.#assertOwnerAvailable(owner);
      const currentAfterRenewal = this.#registry.getTask(owner, taskId);
      if (
        this.#ownedTask(owner, taskId) !== record ||
        record.state !== "terminal" ||
        !currentAfterRenewal ||
        currentAfterRenewal.generation !== current.generation ||
        currentAfterRenewal.status !== "failed"
      ) {
        throw managerFailure(
          "invalid_ipc_request",
          "The local subtitle task changed while retry was being prepared.",
          "preflight",
          "taskId",
        );
      }

      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw managerFailure("invalid_content", "Task generation overflowed.");
      }
      const timestamp = this.#timestamp();
      const retried: LocalSubtitleTaskSummary = {
        ...current,
        generation,
        status: "queued",
        progress: queuedProgress(),
        artifactResults: [],
        postAction: initialPostAction(record.batch.config),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(current.durationMs === undefined ? {} : { durationMs: current.durationMs }),
        completion: undefined,
        error: undefined,
      };
      const canonical = stripUndefined(retried);
      const previousRecordState = {
        generation: record.generation,
        state: record.state,
        cancelRequested: record.cancelRequested,
        inputLeaseReleased: record.inputLeaseReleased,
        artifactsRevoked: record.artifactsRevoked,
        leaseFailure: record.leaseFailure,
        run: record.run,
      };
      record.generation = generation;
      record.state = "queued";
      record.cancelRequested = false;
      record.inputLeaseReleased = false;
      record.artifactsRevoked = false;
      record.leaseFailure = undefined;
      const run = this.#createRun(record, admission.sequence);
      let publishedTask!: LocalSubtitleTaskSummary;
      try {
        const envelope = this.#registry.upsertTask(owner, canonical);
        if (envelope.event.type !== "task-updated") {
          throw managerFailure("invalid_content", "Task retry publication failed.");
        }
        publishedTask = envelope.event.task;
      } catch (error) {
        if (record.run === run && record.generation === generation) {
          record.generation = previousRecordState.generation;
          record.state = previousRecordState.state;
          record.cancelRequested = previousRecordState.cancelRequested;
          record.inputLeaseReleased = previousRecordState.inputLeaseReleased;
          record.artifactsRevoked = previousRecordState.artifactsRevoked;
          record.leaseFailure = previousRecordState.leaseFailure;
          record.run = previousRecordState.run;
        }
        throw error;
      }
      this.#assertOwnerAvailable(owner);
      const latestAfterPublication = this.#registry.getTask(owner, taskId);
      const runnable =
        record.run === run &&
        record.state === "queued" &&
        !record.cancelRequested &&
        !this.#releasedOwners.has(record.ownerKey);
      this.#settleAdmission(admission, runnable ? [run] : []);
      this.#ensureLeaseRenewalScheduled();
      return latestAfterPublication ?? publishedTask;
    } finally {
      this.#settleAdmission(admission);
      this.#flushIdleWaiters();
    }
  }

  cancelBatch(
    owner: LocalSubtitleOwnerKey,
    batchId: string,
  ): Readonly<{ cancelledTaskIds: readonly string[] }> {
    this.#assertOwnerAvailable(owner);
    const batch = this.#batches.get(batchId);
    if (!batch || batch.ownerKey !== ownerKey(owner)) {
      return Object.freeze({ cancelledTaskIds: Object.freeze([]) });
    }
    const cancelledTaskIds: string[] = [];
    for (const taskId of batch.taskIds) {
      if (this.#cancelOwnedTask(owner, taskId)) cancelledTaskIds.push(taskId);
    }
    this.#closeActiveBatchSliceIfFinished();
    return Object.freeze({
      cancelledTaskIds: Object.freeze(cancelledTaskIds),
    });
  }

  cancelTask(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
  ): Readonly<{ cancelled: boolean }> {
    this.#assertOwnerAvailable(owner);
    return Object.freeze({ cancelled: this.#cancelOwnedTask(owner, taskId) });
  }

  removeTask(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
  ): Readonly<{ removed: boolean }> {
    this.#assertOwnerAvailable(owner);
    const record = this.#ownedTask(owner, taskId);
    const current = record ? this.#registry.getTask(owner, taskId) : undefined;
    if (!record || !current) return Object.freeze({ removed: false });
    if (!TERMINAL_STATUSES.has(current.status) || record.state !== "terminal") {
      throw managerFailure(
        "resource_busy",
        "A running local subtitle task must be cancelled before removal.",
        "cleanup",
        "taskId",
      );
    }

    this.#releaseInputLease(record);
    this.#revokeTaskArtifacts(record);
    record.state = "removed";
    record.batch.taskIds.delete(taskId);
    this.#tasks.delete(taskId);
    const removed = this.#registry.removeTask(owner, taskId, this.#timestamp());
    if (record.batch.taskIds.size === 0) {
      this.#releaseOutputLease(record.batch);
      this.#batches.delete(record.batch.batchId);
    } else {
      this.#releaseOutputIfUnmaintained(record.batch);
    }
    this.#stopLeaseRenewalIfIdle();
    this.#flushIdleWaiters();
    return Object.freeze({ removed: removed !== undefined });
  }

  getSessionSnapshot(owner: LocalSubtitleOwnerKey): LocalSubtitleSessionSnapshot {
    this.#assertOwnerAvailable(owner);
    return this.#registry.getSnapshot(owner);
  }

  onTaskEvent(
    owner: LocalSubtitleOwnerKey,
    listener: LocalSubtitleTaskEventListener,
  ): () => void {
    this.#assertOwnerAvailable(owner);
    return this.#registry.onTaskEvent(owner, listener);
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    const key = ownerKey(owner);
    if (this.#releasedOwners.has(key)) return;
    this.#releasedOwners.add(key);
    const failures: unknown[] = [];
    const records = [...this.#tasks.values()].filter(
      (record) => record.ownerKey === key && record.state !== "removed",
    );
    for (const record of records) {
      record.state = "fenced";
      record.cancelRequested = true;
    }
    for (const pending of this.#pendingEnqueues) {
      if (pending.ownerKey !== key) continue;
      captureFailure(failures, () => pending.controller.abort());
      captureFailure(failures, () => this.#settleAdmission(pending.admission));
    }
    for (const record of records) {
      captureFailure(failures, () => record.run?.controller.abort());
      captureFailure(failures, () => this.#releaseInputLease(record));
      captureFailure(failures, () => this.#revokeTaskArtifacts(record));
    }
    if (this.#activeBatchSlice?.batch.ownerKey === key) {
      const slice = this.#activeBatchSlice;
      captureFailure(failures, () => this.#requestBatchSliceClose(slice));
    }
    for (const batch of this.#batches.values()) {
      if (batch.ownerKey === key) {
        captureFailure(failures, () => this.#releaseOutputLease(batch));
      }
    }
    this.#removeQueuedRuns((run) => run.record.ownerKey === key);
    this.#discardAdmissions((admission) => admission.ownerKey === key);
    this.#stopLeaseRenewalIfIdle();
    this.#flushIdleWaiters();
    if (failures.length > 0) throw failures[0];
  }

  shutdown(_reason?: LocalSubtitleMainRuntimeShutdownReason): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#shutdownOperation = operation;
    this.#shuttingDown = true;
    const failures: unknown[] = [];
    const records = [...this.#tasks.values()].filter(
      (record) => record.state !== "removed",
    );
    for (const record of records) {
      record.state = "fenced";
      record.cancelRequested = true;
    }
    captureFailure(failures, () => this.#cancelLeaseRenewalTimers());
    for (const pending of this.#pendingEnqueues) {
      captureFailure(failures, () => pending.controller.abort());
    }
    for (const record of records) {
      captureFailure(failures, () => record.run?.controller.abort());
      captureFailure(failures, () => this.#releaseInputLease(record));
      captureFailure(failures, () => this.#revokeTaskArtifacts(record));
    }
    if (this.#activeBatchSlice) {
      const slice = this.#activeBatchSlice;
      captureFailure(failures, () => this.#requestBatchSliceClose(slice));
    }
    for (const batch of this.#batches.values()) {
      captureFailure(failures, () => this.#releaseOutputLease(batch));
    }
    this.#queue.splice(0);
    this.#discardAdmissions(() => true);
    void this.#waitForOperations()
      .then(() => {
        if (failures.length > 0) throw failures[0];
      })
      .then(resolveOperation, (error: unknown) => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
        }
        rejectOperation(error);
      })
      .finally(() => this.#flushIdleWaiters());
    return operation;
  }

  waitForOwnerIdle(owner: LocalSubtitleOwnerKey): Promise<void> {
    return this.#waitForIdle(ownerKey(owner));
  }

  waitForIdle(): Promise<void> {
    return this.#waitForIdle();
  }

  #beginPendingEnqueue(ownerKeyValue: string, signal?: AbortSignal): PendingEnqueue {
    const controller = new AbortController();
    const detach = forwardAbort(signal, controller);
    const pending = {
      ownerKey: ownerKeyValue,
      controller,
      detach,
      admission: this.#beginAdmission(ownerKeyValue),
    };
    this.#pendingEnqueues.add(pending);
    return pending;
  }

  #beginAdmission(ownerKeyValue: string): QueueAdmission {
    if (!Number.isSafeInteger(this.#nextAdmissionSequence)) {
      throw managerFailure("invalid_content", "Queue admission sequence overflowed.");
    }
    const admission: QueueAdmission = {
      sequence: this.#nextAdmissionSequence,
      ownerKey: ownerKeyValue,
      state: "pending",
    };
    this.#nextAdmissionSequence += 1;
    this.#admissions.push(admission);
    return admission;
  }

  #settleAdmission(
    admission: QueueAdmission,
    runs: readonly TaskRun[] = [],
  ): void {
    if (admission.state !== "pending") return;
    if (runs.length > 0) {
      admission.state = "ready";
      admission.runs = Object.freeze([...runs]);
    } else {
      admission.state = "skipped";
    }
    this.#flushAdmissions();
  }

  #flushAdmissions(): void {
    while (this.#admissions[0]?.state !== "pending") {
      const admission = this.#admissions.shift();
      if (!admission) break;
      if (admission.state === "ready" && admission.runs) {
        this.#queue.push(...admission.runs);
      }
    }
    this.#scheduleDrain();
  }

  #createRun(record: TaskRecord, admissionSequence: number): TaskRun {
    const run: TaskRun = {
      record,
      generation: record.generation,
      admissionSequence,
      controller: new AbortController(),
    };
    record.run = run;
    return run;
  }

  #beginBatchSlice(run: TaskRun): ActiveBatchSlice {
    const current = this.#activeBatchSlice;
    if (
      current &&
      !current.closeRequested &&
      current.batch === run.record.batch &&
      current.admissionSequence === run.admissionSequence
    ) {
      return current;
    }
    if (current) this.#closeActiveBatchSlice();

    const controller = new AbortController();
    const runtime = this.#executor.beginBatchSlice(Object.freeze({
      owner: run.record.owner,
      batchId: run.record.batch.batchId,
      config: run.record.batch.config,
      managedModel: run.record.batch.managedModel,
      admittedRuntimeGeneration: run.record.batch.runtimeGeneration,
      signal: controller.signal,
    }));
    if (typeof runtime !== "object" || runtime === null) {
      controller.abort();
      throw managerFailure(
        "invalid_content",
        "The local subtitle batch runtime is invalid.",
      );
    }
    const slice: ActiveBatchSlice = {
      batch: run.record.batch,
      admissionSequence: run.admissionSequence,
      runtime,
      controller,
      closeRequested: false,
    };
    this.#activeBatchSlice = slice;
    return slice;
  }

  #requestBatchSliceClose(slice: ActiveBatchSlice): void {
    if (this.#activeBatchSlice !== slice) return;
    slice.closeRequested = true;
    slice.controller.abort();
    const active = this.#activeRun;
    if (
      active &&
      active.record.batch === slice.batch &&
      active.admissionSequence === slice.admissionSequence
    ) {
      return;
    }
    this.#closeActiveBatchSlice();
  }

  #finishActiveBatchSlice(run: TaskRun): void {
    const slice = this.#activeBatchSlice;
    if (
      !slice ||
      slice.batch !== run.record.batch ||
      slice.admissionSequence !== run.admissionSequence
    ) {
      return;
    }
    if (
      slice.closeRequested ||
      !this.#hasQueuedRunForBatchSlice(slice, run)
    ) {
      this.#closeActiveBatchSlice();
    }
  }

  #closeActiveBatchSliceIfFinished(): void {
    const slice = this.#activeBatchSlice;
    if (!slice) return;
    const active = this.#activeRun;
    if (
      active &&
      active.record.batch === slice.batch &&
      active.admissionSequence === slice.admissionSequence
    ) {
      return;
    }
    if (!this.#hasQueuedRunForBatchSlice(slice)) this.#closeActiveBatchSlice();
  }

  #hasQueuedRunForBatchSlice(
    slice: ActiveBatchSlice,
    excluded?: TaskRun,
  ): boolean {
    for (const taskId of slice.batch.taskIds) {
      const record = this.#tasks.get(taskId);
      const run = record?.run;
      if (
        record &&
        run &&
        run !== excluded &&
        run.admissionSequence === slice.admissionSequence &&
        record.state === "queued" &&
        !record.cancelRequested &&
        this.#isCurrentRun(run)
      ) {
        return true;
      }
    }
    return false;
  }

  #closeActiveBatchSlice(): void {
    const slice = this.#activeBatchSlice;
    if (!slice) return;
    this.#activeBatchSlice = undefined;
    slice.closeRequested = true;
    slice.controller.abort();
    this.#executor.endBatchSlice(slice.runtime);
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#activeRun || this.#shuttingDown) return;
    this.#drainScheduled = true;
    this.#schedule(() => {
      this.#drainScheduled = false;
      this.#startNextRun();
    });
  }

  #startNextRun(): void {
    if (this.#activeRun || this.#shuttingDown) return;
    let run: TaskRun | undefined;
    while ((run = this.#queue.shift())) {
      if (this.#isCurrentRun(run) && run.record.state === "queued") break;
      run = undefined;
    }
    if (!run) {
      this.#flushIdleWaiters();
      return;
    }
    this.#activeRun = run;
    run.record.state = "running";

    let operation!: Promise<void>;
    operation = this.#executeRun(run)
      .catch(() => undefined)
      .finally(() => {
        this.#operations.delete(operation);
        if (this.#activeRun === run) this.#activeRun = undefined;
        if (run.record.run === run) run.record.run = undefined;
        this.#scheduleDrain();
        this.#flushIdleWaiters();
      });
    this.#operations.set(operation, run.record.ownerKey);
  }

  async #executeRun(run: TaskRun): Promise<void> {
    if (!this.#isPublishableRun(run)) return;
    try {
      await this.#runLeaseOperation(
        run.record.ownerKey,
        () => this.#renewTaskCapabilities(run.record),
      );
      if (!this.#isPublishableRun(run)) return;
      const managedModel = await this.#modelResolver.resolveManagedModel(
        run.record.batch.config.model.modelId,
        run.controller.signal,
      );
      assertManagedModel(managedModel, run.record.batch.config.model.modelId);
      assertManagedModelUnchanged(run.record.batch, managedModel);
      if (!this.#isPublishableRun(run)) return;
      if (run.record.leaseFailure !== undefined) throw run.record.leaseFailure;
      const batchSlice = this.#beginBatchSlice(run);
      this.#transition(run, {
        status: "preparing_media",
        progress: {
          stage: "preparing_media",
          stageProgress: 0,
          overallProgress: 0,
        },
      });
      const context: LocalSubtitleJobTaskExecutionContext = Object.freeze({
        owner: run.record.owner,
        batchId: run.record.batch.batchId,
        taskId: run.record.taskId,
        generation: run.generation,
        fileToken: run.record.fileToken,
        ...(run.record.audioStreamId === undefined
          ? {}
          : { audioStreamId: run.record.audioStreamId }),
        config: run.record.batch.config,
        managedModel: run.record.batch.managedModel,
        admittedRuntimeGeneration: run.record.batch.runtimeGeneration,
        batchRuntime: batchSlice.runtime,
        signal: run.controller.signal,
        update: (update: LocalSubtitleJobTaskUpdate) =>
          this.#transition(run, update),
      });
      const result = await this.#executor.execute(context);
      if (!this.#isPublishableRun(run)) return;
      if (result.status === "completed" && this.#settleCompleted(run, result)) {
        return;
      }
      if (
        result.status === "failed" &&
        CLEANUP_FAILURE_CODES.has(result.error.code)
      ) {
        this.#settleFailed(
          run,
          result.error,
          result.artifactResults ?? [],
          result.durationMs,
        );
        return;
      }
      if (run.record.cancelRequested) {
        this.#settleCancelled(run, result.artifactResults ?? [], result.durationMs);
        return;
      }
      if (run.record.leaseFailure !== undefined) {
        this.#settleExecutionFailure(
          run,
          executionError(run.record.leaseFailure, this.#currentStage(run.record)),
          result.artifactResults ?? [],
          result.durationMs,
        );
        return;
      }
      if (run.controller.signal.aborted) {
        this.#settleCancelled(run, result.artifactResults ?? [], result.durationMs);
        return;
      }
      await this.#runLeaseOperation(
        run.record.ownerKey,
        () => this.#renewTaskCapabilities(run.record),
      );
      if (!this.#isPublishableRun(run)) return;
      if (run.record.cancelRequested) {
        this.#settleCancelled(run, result.artifactResults ?? [], result.durationMs);
      } else if (result.status === "failed") {
        this.#settleExecutionFailure(
          run,
          result.error,
          result.artifactResults ?? [],
          result.durationMs,
        );
      } else {
        this.#settleFailed(
          run,
          createLocalSubtitleError(
            "invalid_content",
            result.status === "completed"
              ? "The local subtitle task executor returned invalid artifacts."
              : "The local subtitle task executor returned an invalid cancellation.",
            { stage: this.#currentStage(run.record) },
          ),
          result.artifactResults ?? [],
          result.durationMs,
        );
      }
    } catch (error) {
      if (!this.#isPublishableRun(run)) return;
      const code = errorCode(error);
      if (code !== undefined && CLEANUP_FAILURE_CODES.has(code)) {
        this.#settleFailed(
          run,
          executionError(error, this.#currentStage(run.record)),
        );
      } else if (run.record.cancelRequested) {
        this.#settleCancelled(run, []);
      } else if (run.record.leaseFailure !== undefined) {
        this.#settleExecutionFailure(
          run,
          executionError(run.record.leaseFailure, this.#currentStage(run.record)),
        );
      } else if (run.controller.signal.aborted) {
        this.#settleCancelled(run, []);
      } else {
        this.#settleExecutionFailure(
          run,
          executionError(error, this.#currentStage(run.record)),
        );
      }
    } finally {
      this.#finishActiveBatchSlice(run);
    }
  }

  #transition(
    run: TaskRun,
    update: LocalSubtitleJobTaskUpdate,
  ): LocalSubtitleTaskSummary {
    if (!this.#isPublishableRun(run) || run.record.cancelRequested) {
      throw managerFailure("owner_released", "The local subtitle task is fenced.");
    }
    if (
      !WORKING_STATUSES.has(update.status) ||
      update.progress.stage !== update.status
    ) {
      throw managerFailure(
        "invalid_content",
        "The local subtitle task executor reported an invalid stage.",
        "preflight",
        "progress",
      );
    }
    const current = this.#requireCurrentTask(run);
    let artifactResults = current.artifactResults;
    if (current.status !== update.status) {
      const transition = transitionLocalSubtitleTaskState(
        taskState(current),
        update.status,
        { requestedFormats: current.requestedFormats },
      );
      if (!transition.ok) {
        throw managerFailure(
          "invalid_content",
          "The local subtitle task executor skipped a required stage.",
          "preflight",
          "status",
        );
      }
      artifactResults = transition.state.artifactResults;
    } else if (
      update.progress.stageProgress < current.progress.stageProgress ||
      update.progress.overallProgress < current.progress.overallProgress
    ) {
      throw managerFailure(
        "invalid_content",
        "The local subtitle task progress moved backwards.",
        "preflight",
        "progress",
      );
    }
    const timestamp = this.#timestamp();
    const next: LocalSubtitleTaskSummary = stripUndefined({
      ...current,
      status: update.status,
      progress: { ...update.progress },
      artifactResults,
      ...(update.durationMs === undefined
        ? current.durationMs === undefined
          ? {}
          : { durationMs: current.durationMs }
        : { durationMs: update.durationMs }),
      updatedAt: timestamp,
      completion: undefined,
      error: undefined,
    });
    return this.#publishTask(run, next);
  }

  #settleCompleted(
    run: TaskRun,
    result: Extract<LocalSubtitleJobTaskExecutionResult, { status: "completed" }>,
  ): boolean {
    const current = this.#requireCurrentTask(run);
    const transition = transitionLocalSubtitleTaskState(
      taskState(current),
      "completed",
      {
        requestedFormats: current.requestedFormats,
        artifactResults: result.artifactResults,
      },
    );
    if (!transition.ok) {
      return false;
    }
    const next: LocalSubtitleTaskSummary = stripUndefined({
      ...current,
      ...transition.state,
      progress: {
        stage: "exporting",
        stageProgress: 100,
        overallProgress: 100,
      },
      ...(result.durationMs === undefined
        ? current.durationMs === undefined
          ? {}
          : { durationMs: current.durationMs }
        : { durationMs: result.durationMs }),
      postAction: result.postAction ?? current.postAction,
      updatedAt: this.#timestamp(),
      error: undefined,
    });
    this.#publishTerminalTask(run, next);
    this.#releaseInputLease(run.record);
    this.#releaseOutputIfUnmaintained(run.record.batch);
    this.#stopLeaseRenewalIfIdle();
    return true;
  }

  #settleFailed(
    run: TaskRun,
    error: LocalSubtitleError,
    artifactResults: readonly LocalSubtitleArtifactResult[] = [],
    durationMs?: number,
  ): void {
    const current = this.#requireCurrentTask(run);
    const transition = transitionLocalSubtitleTaskState(
      taskState(current),
      "failed",
      {
        requestedFormats: current.requestedFormats,
        artifactResults,
        error,
      },
    );
    const stableError = transition.ok || CLEANUP_FAILURE_CODES.has(error.code)
      ? error
      : createLocalSubtitleError(
          "invalid_content",
          "The local subtitle task failed with an invalid terminal result.",
          { stage: this.#currentStage(run.record), causeCode: error.code },
        );
    let terminalState;
    if (transition.ok) {
      terminalState = transition.state;
    } else {
      const fallback = transitionLocalSubtitleTaskState(
        taskState(current),
        "failed",
        {
          requestedFormats: current.requestedFormats,
          error: stableError,
        },
      );
      if (!fallback.ok) {
        throw managerFailure("invalid_content", "Task failure publication failed.");
      }
      terminalState = fallback.state;
    }
    const next: LocalSubtitleTaskSummary = stripUndefined({
      ...current,
      ...terminalState,
      ...(durationMs === undefined
        ? current.durationMs === undefined
          ? {}
          : { durationMs: current.durationMs }
        : { durationMs }),
      updatedAt: this.#timestamp(),
      completion: undefined,
    });
    this.#publishTerminalTask(run, next);
    if (!this.#isCurrentRun(run) || run.record.state !== "terminal") return;
    if (CLEANUP_FAILURE_CODES.has(stableError.code)) {
      this.#releaseInputLease(run.record);
      this.#releaseOutputIfUnmaintained(run.record.batch);
      this.#stopLeaseRenewalIfIdle();
    } else if (run.record.leaseFailure === undefined) {
      // Failed tasks retain renewable input/output leases for retry.
      this.#ensureLeaseRenewalScheduled();
    } else {
      this.#releaseInputLease(run.record);
      this.#releaseOutputIfUnmaintained(run.record.batch);
      this.#stopLeaseRenewalIfIdle();
    }
  }

  #settleCancelled(
    run: TaskRun,
    artifactResults: readonly LocalSubtitleArtifactResult[],
    durationMs?: number,
  ): void {
    let current = this.#requireCurrentTask(run);
    if (current.status !== "cancelling") {
      current = this.#publishCancelling(run, current);
    }
    const transition = transitionLocalSubtitleTaskState(
      taskState(current),
      "cancelled",
      { requestedFormats: current.requestedFormats, artifactResults },
    );
    if (!transition.ok) {
      this.#settleFailed(
        run,
        createLocalSubtitleError(
          "cancel_failed",
          "The local subtitle task could not settle cancellation safely.",
          { stage: "cancelling" },
        ),
        [{ format: "SRT", status: "failed", errorCode: "cancel_failed" }],
        durationMs,
      );
      return;
    }
    const next: LocalSubtitleTaskSummary = stripUndefined({
      ...current,
      ...transition.state,
      progress: {
        stage: "cancelling",
        stageProgress: 100,
        overallProgress: current.progress.overallProgress,
      },
      ...(durationMs === undefined
        ? current.durationMs === undefined
          ? {}
          : { durationMs: current.durationMs }
        : { durationMs }),
      updatedAt: this.#timestamp(),
      completion: undefined,
      error: undefined,
    });
    this.#publishTerminalTask(run, next);
    this.#releaseInputLease(run.record);
    this.#releaseOutputIfUnmaintained(run.record.batch);
    this.#stopLeaseRenewalIfIdle();
  }

  #publishCancelling(
    run: TaskRun,
    current: LocalSubtitleTaskSummary,
  ): LocalSubtitleTaskSummary {
    const transition = transitionLocalSubtitleTaskState(
      taskState(current),
      "cancelling",
      { requestedFormats: current.requestedFormats },
    );
    if (!transition.ok) {
      throw managerFailure("invalid_content", "Task cancellation transition failed.");
    }
    return this.#publishTask(run, {
      ...current,
      ...transition.state,
      progress: {
        stage: "cancelling",
        stageProgress: 0,
        overallProgress: current.progress.overallProgress,
      },
      updatedAt: this.#timestamp(),
    });
  }

  #cancelOwnedTask(owner: LocalSubtitleOwnerKey, taskId: string): boolean {
    const record = this.#ownedTask(owner, taskId);
    const current = record ? this.#registry.getTask(owner, taskId) : undefined;
    if (
      !record ||
      !current ||
      record.cancelRequested ||
      record.state === "terminal" ||
      record.state === "removed" ||
      record.state === "fenced" ||
      TERMINAL_STATUSES.has(current.status)
    ) {
      return false;
    }
    record.cancelRequested = true;
    const run = record.run;
    if (!run) return false;
    const cancelling = this.#publishCancelling(run, current);
    if (record.state === "queued") {
      this.#removeQueuedRuns((candidate) => candidate === run);
      const transition = transitionLocalSubtitleTaskState(
        taskState(cancelling),
        "cancelled",
        { requestedFormats: cancelling.requestedFormats },
      );
      if (!transition.ok) {
        throw managerFailure("invalid_content", "Queued cancellation failed.");
      }
      this.#publishTerminalTask(run, {
        ...cancelling,
        ...transition.state,
        progress: {
          stage: "cancelling",
          stageProgress: 100,
          overallProgress: cancelling.progress.overallProgress,
        },
        updatedAt: this.#timestamp(),
      });
      this.#releaseInputLease(record);
      this.#releaseOutputIfUnmaintained(record.batch);
      this.#stopLeaseRenewalIfIdle();
      this.#closeActiveBatchSliceIfFinished();
      this.#flushIdleWaiters();
      return true;
    }
    run.controller.abort();
    return true;
  }

  #publishTask(run: TaskRun, task: LocalSubtitleTaskSummary): LocalSubtitleTaskSummary {
    if (!this.#isPublishableRun(run)) {
      throw managerFailure("owner_released", "The local subtitle task is fenced.");
    }
    const envelope = this.#registry.upsertTask(run.record.owner, task);
    if (envelope.event.type !== "task-updated") {
      throw managerFailure("invalid_content", "Task publication failed.");
    }
    return envelope.event.task;
  }

  #publishTerminalTask(
    run: TaskRun,
    task: LocalSubtitleTaskSummary,
  ): LocalSubtitleTaskSummary {
    const previousState = run.record.state;
    run.record.state = "terminal";
    try {
      return this.#publishTask(run, task);
    } catch (error) {
      if (this.#isCurrentRun(run) && run.record.state === "terminal") {
        run.record.state = previousState;
      }
      throw error;
    }
  }

  #settleExecutionFailure(
    run: TaskRun,
    error: LocalSubtitleError,
    artifactResults: readonly LocalSubtitleArtifactResult[] = [],
    durationMs?: number,
  ): void {
    const stopsBatch = errorStopsBatch(error.code);
    const siblingRuns: TaskRun[] = [];
    if (stopsBatch) {
      for (const taskId of run.record.batch.taskIds) {
        const sibling = this.#tasks.get(taskId);
        const siblingRun = sibling?.run;
        if (
          !sibling ||
          !siblingRun ||
          sibling === run.record ||
          sibling.state !== "queued" ||
          sibling.cancelRequested ||
          !this.#isPublishableRun(siblingRun)
        ) {
          continue;
        }
        sibling.state = "terminal";
        siblingRuns.push(siblingRun);
      }
      this.#removeQueuedRuns((candidate) =>
        siblingRuns.includes(candidate)
      );
    }
    this.#settleFailed(run, error, artifactResults, durationMs);
    if (!stopsBatch) return;

    for (const siblingRun of siblingRuns) {
      if (
        siblingRun.record.state !== "terminal" ||
        !this.#isPublishableRun(siblingRun)
      ) {
        continue;
      }
      this.#settleFailed(siblingRun, error);
    }
  }

  #requireCurrentTask(run: TaskRun): LocalSubtitleTaskSummary {
    const task = this.#registry.getTask(run.record.owner, run.record.taskId);
    if (!task || task.generation !== run.generation) {
      throw managerFailure("invalid_content", "The local subtitle task generation is stale.");
    }
    return task;
  }

  #isCurrentRun(run: TaskRun): boolean {
    return (
      this.#tasks.get(run.record.taskId) === run.record &&
      run.record.run === run &&
      run.record.generation === run.generation
    );
  }

  #isPublishableRun(run: TaskRun): boolean {
    return (
      this.#isCurrentRun(run) &&
      run.record.state !== "fenced" &&
      run.record.state !== "removed" &&
      !this.#releasedOwners.has(run.record.ownerKey) &&
      !this.#shuttingDown
    );
  }

  #ownedTask(owner: LocalSubtitleOwnerKey, taskId: string): TaskRecord | undefined {
    const record = this.#tasks.get(taskId);
    return record?.ownerKey === ownerKey(owner) ? record : undefined;
  }

  async #renewTaskCapabilities(record: TaskRecord): Promise<void> {
    if (record.leaseFailure !== undefined) throw record.leaseFailure;
    try {
      await this.#inputs.resolveTaskLease(
        record.owner,
        record.taskId,
        "transcribe",
        record.fileToken,
      );
      await this.#inputs.renewTaskLease(record.owner, record.taskId);
      if (record.batch.outputDirToken !== undefined) {
        await this.#outputs.resolveBatchLease(
          record.owner,
          record.batch.batchId,
        );
        await this.#outputs.renewBatchLease(
          record.owner,
          record.batch.batchId,
        );
      }
    } catch (error) {
      this.#markLeaseFailure(record, error);
      throw error;
    }
  }

  #runLeaseOperation<T>(
    ownerKeyValue: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#leaseOperationCounts.set(
      ownerKeyValue,
      (this.#leaseOperationCounts.get(ownerKeyValue) ?? 0) + 1,
    );
    const tail = this.#leaseOperationTails.get(ownerKeyValue) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#leaseOperationTails.set(ownerKeyValue, nextTail);
    return result.finally(() => {
      const remaining = (this.#leaseOperationCounts.get(ownerKeyValue) ?? 1) - 1;
      if (remaining === 0) {
        this.#leaseOperationCounts.delete(ownerKeyValue);
        if (this.#leaseOperationTails.get(ownerKeyValue) === nextTail) {
          this.#leaseOperationTails.delete(ownerKeyValue);
        }
      } else {
        this.#leaseOperationCounts.set(ownerKeyValue, remaining);
      }
      this.#flushIdleWaiters();
    });
  }

  #ensureLeaseRenewalScheduled(): void {
    if (this.#shuttingDown) return;
    for (const ownerKeyValue of this.#maintainedLeaseOwnerKeys()) {
      this.#ensureOwnerLeaseRenewalScheduled(ownerKeyValue);
    }
  }

  #ensureOwnerLeaseRenewalScheduled(ownerKeyValue: string): void {
    if (
      this.#shuttingDown ||
      this.#cancelLeaseRenewals.has(ownerKeyValue) ||
      !this.#ownerHasMaintainedLeases(ownerKeyValue)
    ) {
      return;
    }
    try {
      let cancel!: () => void;
      cancel = this.#scheduleLeaseRenewal(() => {
        if (this.#cancelLeaseRenewals.get(ownerKeyValue) !== cancel) return;
        this.#cancelLeaseRenewals.delete(ownerKeyValue);
        if (
          this.#shuttingDown ||
          !this.#ownerHasMaintainedLeases(ownerKeyValue)
        ) {
          this.#flushIdleWaiters();
          return;
        }
        if (this.#leaseOperationCounts.has(ownerKeyValue)) {
          this.#ensureOwnerLeaseRenewalScheduled(ownerKeyValue);
          this.#flushIdleWaiters();
          return;
        }
        void this.#runLeaseOperation(
          ownerKeyValue,
          () => this.#renewMaintainedLeases(ownerKeyValue),
        )
          .catch(() => undefined)
          .finally(() => {
            this.#ensureOwnerLeaseRenewalScheduled(ownerKeyValue);
            this.#flushIdleWaiters();
          });
      }, this.#leaseRenewalIntervalMs);
      this.#cancelLeaseRenewals.set(ownerKeyValue, cancel);
    } catch (error) {
      for (const record of this.#tasks.values()) {
        if (
          record.ownerKey === ownerKeyValue &&
          this.#shouldMaintainTaskLease(record)
        ) {
          this.#markLeaseFailure(record, error);
        }
      }
      this.#scheduleDrain();
    }
  }

  async #renewMaintainedLeases(ownerKeyValue: string): Promise<void> {
    if (this.#shuttingDown) return;
    const records = [...this.#tasks.values()].filter((record) =>
      record.ownerKey === ownerKeyValue && this.#shouldMaintainTaskLease(record)
    );
    const batches = [...this.#batches.values()].filter((batch) =>
      batch.ownerKey === ownerKeyValue && this.#shouldMaintainOutputLease(batch)
    );
    const inputResults = await Promise.allSettled(
      records.map(async (record) => {
        await this.#inputs.resolveTaskLease(
          record.owner,
          record.taskId,
          "transcribe",
          record.fileToken,
        );
        await this.#inputs.renewTaskLease(record.owner, record.taskId);
      }),
    );
    inputResults.forEach((result, index) => {
      if (result.status === "rejected") {
        this.#markLeaseFailure(records[index]!, result.reason);
      }
    });
    const outputResults = await Promise.allSettled(
      batches.map(async (batch) => {
        await this.#outputs.resolveBatchLease(batch.owner, batch.batchId);
        await this.#outputs.renewBatchLease(batch.owner, batch.batchId);
      }),
    );
    outputResults.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const batch = batches[index]!;
      for (const taskId of batch.taskIds) {
        const record = this.#tasks.get(taskId);
        if (record && this.#shouldMaintainTaskLease(record)) {
          this.#markLeaseFailure(record, result.reason);
        }
      }
    });
  }

  #markLeaseFailure(record: TaskRecord, error: unknown): void {
    if (!this.#shouldMaintainTaskLease(record)) return;
    record.leaseFailure = error;
    record.run?.controller.abort();
    this.#releaseInputLease(record);
    this.#releaseOutputIfUnmaintained(record.batch);
    this.#stopLeaseRenewalIfIdle();
  }

  #shouldMaintainTaskLease(record: TaskRecord): boolean {
    return (
      !record.inputLeaseReleased &&
      record.leaseFailure === undefined &&
      record.state !== "removed" &&
      record.state !== "fenced"
    );
  }

  #shouldMaintainOutputLease(batch: BatchRecord): boolean {
    return (
      batch.outputDirToken !== undefined &&
      !batch.outputLeaseReleased &&
      [...batch.taskIds].some((taskId) => {
        const record = this.#tasks.get(taskId);
        return record !== undefined && this.#shouldMaintainTaskLease(record);
      })
    );
  }

  #maintainedLeaseOwnerKeys(): readonly string[] {
    return [...new Set(
      [...this.#tasks.values()]
        .filter((record) => this.#shouldMaintainTaskLease(record))
        .map((record) => record.ownerKey),
    )];
  }

  #ownerHasMaintainedLeases(ownerKeyValue: string): boolean {
    return [...this.#tasks.values()].some((record) =>
      record.ownerKey === ownerKeyValue && this.#shouldMaintainTaskLease(record)
    );
  }

  #stopLeaseRenewalIfIdle(): void {
    const maintainedOwners = new Set(this.#maintainedLeaseOwnerKeys());
    for (const [ownerKeyValue, cancel] of this.#cancelLeaseRenewals) {
      if (maintainedOwners.has(ownerKeyValue)) continue;
      cancel();
      if (this.#cancelLeaseRenewals.get(ownerKeyValue) === cancel) {
        this.#cancelLeaseRenewals.delete(ownerKeyValue);
      }
    }
  }

  #cancelLeaseRenewalTimers(): void {
    let firstFailure: unknown;
    let failed = false;
    for (const [ownerKeyValue, cancel] of this.#cancelLeaseRenewals) {
      try {
        cancel();
        if (this.#cancelLeaseRenewals.get(ownerKeyValue) === cancel) {
          this.#cancelLeaseRenewals.delete(ownerKeyValue);
        }
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
      }
    }
    if (failed) throw firstFailure;
  }

  #releaseInputLease(record: TaskRecord): void {
    if (record.inputLeaseReleased) return;
    this.#inputs.releaseTaskLease(record.owner, record.taskId);
    record.inputLeaseReleased = true;
  }

  #releaseOutputLease(batch: BatchRecord): void {
    if (batch.outputLeaseReleased || batch.outputDirToken === undefined) return;
    this.#outputs.releaseBatchLease(batch.owner, batch.batchId);
    batch.outputLeaseReleased = true;
  }

  #releaseOutputIfUnmaintained(batch: BatchRecord): void {
    if (!this.#shouldMaintainOutputLease(batch)) this.#releaseOutputLease(batch);
  }

  #revokeTaskArtifacts(record: TaskRecord): void {
    if (record.artifactsRevoked) return;
    this.#artifacts?.revokeTask(record.owner, record.taskId);
    record.artifactsRevoked = true;
  }

  #currentStage(record: TaskRecord): LocalSubtitleOperationStage {
    return this.#registry.getTask(record.owner, record.taskId)?.progress.stage ??
      "preflight";
  }

  #removeQueuedRuns(predicate: (run: TaskRun) => boolean): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      if (predicate(this.#queue[index]!)) this.#queue.splice(index, 1);
    }
    let admissionsChanged = false;
    for (const admission of this.#admissions) {
      if (admission.state !== "ready" || !admission.runs) continue;
      const runs = admission.runs.filter((run) => !predicate(run));
      if (runs.length === admission.runs.length) continue;
      admissionsChanged = true;
      if (runs.length === 0) {
        admission.state = "skipped";
        admission.runs = undefined;
      } else {
        admission.runs = Object.freeze(runs);
      }
    }
    if (admissionsChanged) this.#flushAdmissions();
  }

  #discardAdmissions(
    predicate: (admission: QueueAdmission) => boolean,
  ): void {
    for (const admission of this.#admissions) {
      if (admission.state === "skipped" || !predicate(admission)) continue;
      admission.state = "skipped";
      admission.runs = undefined;
    }
    this.#flushAdmissions();
  }

  #claimId(
    factory: () => string,
    records: ReadonlyMap<string, unknown>,
    pendingIds: Set<string>,
    field: string,
  ): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = factory();
      if (
        typeof id === "string" &&
        id.length <= 128 &&
        SAFE_ID_PATTERN.test(id) &&
        !records.has(id) &&
        !pendingIds.has(id)
      ) {
        pendingIds.add(id);
        return id;
      }
    }
    throw managerFailure(
      "invalid_content",
      "Could not allocate a unique local subtitle identity.",
      "preflight",
      field,
    );
  }

  #mintSnapshotId(): string {
    const id = this.#snapshotIdFactory();
    if (
      typeof id !== "string" ||
      id.length > 128 ||
      !SAFE_ID_PATTERN.test(id)
    ) {
      throw managerFailure(
        "invalid_content",
        "The local subtitle snapshot identity is invalid.",
        "preflight",
        "snapshotId",
      );
    }
    return id;
  }

  #timestamp(): string {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw managerFailure("invalid_content", "The local subtitle clock is invalid.");
    }
    return new Date(value).toISOString();
  }

  #assertOwnerAvailable(owner: LocalSubtitleOwnerKey): void {
    if (this.#shuttingDown) {
      throw managerFailure("owner_released", "The local subtitle job manager is shut down.");
    }
    if (this.#releasedOwners.has(ownerKey(owner))) {
      throw managerFailure("owner_released", "The local subtitle owner was released.");
    }
    this.#registry.assertOwnerActive(owner);
  }

  #waitForIdle(ownerKeyValue?: string): Promise<void> {
    if (this.#isIdle(ownerKeyValue)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.add({
        ...(ownerKeyValue === undefined ? {} : { ownerKey: ownerKeyValue }),
        resolve,
      });
    });
  }

  #isIdle(ownerKeyValue?: string): boolean {
    const matches = (value: string) =>
      ownerKeyValue === undefined || ownerKeyValue === value;
    return (
      ![...this.#pendingEnqueues].some((pending) => matches(pending.ownerKey)) &&
      !this.#admissions.some((admission) =>
        admission.state !== "skipped" && matches(admission.ownerKey)
      ) &&
      !this.#queue.some((run) => matches(run.record.ownerKey)) &&
      !(this.#activeRun && matches(this.#activeRun.record.ownerKey)) &&
      !(
        this.#activeBatchSlice &&
        matches(this.#activeBatchSlice.batch.ownerKey)
      ) &&
      ![...this.#operations.values()].some(matches) &&
      (ownerKeyValue === undefined
        ? this.#leaseOperationCounts.size === 0
        : !this.#leaseOperationCounts.has(ownerKeyValue))
    );
  }

  #flushIdleWaiters(): void {
    for (const waiter of [...this.#idleWaiters]) {
      if (!this.#isIdle(waiter.ownerKey)) continue;
      this.#idleWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  async #waitForOperations(): Promise<void> {
    while (
      this.#operations.size > 0 ||
      this.#pendingEnqueues.size > 0 ||
      this.#admissions.length > 0 ||
      this.#leaseOperationCounts.size > 0
    ) {
      await Promise.allSettled([
        ...this.#operations.keys(),
        this.#waitForIdle(),
      ]);
    }
  }
}

function parseEnqueueRequest(input: unknown): EnqueueLocalSubtitleBatchRequest {
  const result = enqueueLocalSubtitleBatchRequestSchema.safeParse(input);
  if (!result.success) {
    throw managerFailure(
      "invalid_ipc_request",
      "The local subtitle enqueue request is invalid.",
      "ipc",
    );
  }
  return result.data;
}

function assertDistinctInputIdentities(
  inputs: readonly ResolvedLocalSubtitleInput[],
): void {
  const identities = new Set<string>();
  for (const input of inputs) {
    const identity = input.identity;
    const key = JSON.stringify([
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeMs,
      identity.ctimeMs,
    ]);
    if (identities.has(key)) {
      throw managerFailure(
        "invalid_ipc_request",
        "A local subtitle batch cannot contain the same authorized file twice.",
        "preflight",
        "files",
      );
    }
    identities.add(key);
  }
}

function assertRuntimeAdmission(
  admission: Readonly<{ runtimeGeneration: string }>,
): string {
  if (!/^[a-f0-9]{64}$/u.test(admission.runtimeGeneration)) {
    throw managerFailure(
      "invalid_content",
      "The admitted local subtitle runtime generation is invalid.",
      "preflight",
      "runtimeGeneration",
    );
  }
  return admission.runtimeGeneration;
}

function assertProductionBatchSliceRequest(
  request: EnqueueLocalSubtitleBatchRequest,
): void {
  const config = request.config;
  const supported =
    config.devicePreference === "cpu" &&
    config.taskMode === "transcribe" &&
    config.vadEnabled === false &&
    config.output.mode === "custom" &&
    config.output.formats.length === 1 &&
    config.output.formats[0] === "SRT" &&
    config.postAction.mode === "export_only";
  if (!supported) {
    throw managerFailure(
      "invalid_ipc_request",
      "This local subtitle build currently supports CPU, no-VAD SRT batches with custom output.",
      "preflight",
      "config",
    );
  }
}

function createConfigSnapshot(
  request: EnqueueLocalSubtitleBatchRequest,
  model: LocalSubtitleServerManagedResourceIdentity<"managed">,
  batchId: string,
  snapshotId: string,
  createdAt: string,
): LocalSubtitleBatchConfigSnapshot {
  const output = request.config.output.mode === "source"
    ? {
        mode: "source" as const,
        formats: [...request.config.output.formats],
        conflictPolicy: request.config.output.conflictPolicy,
      }
    : {
        mode: "custom" as const,
        formats: [...request.config.output.formats],
        conflictPolicy: request.config.output.conflictPolicy,
        directoryLeaseRef: batchId,
        displayLabel: "Selected output directory",
      };
  return createLocalSubtitleBatchConfigSnapshot({
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    serverHttpContractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    snapshotId,
    createdAt,
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: model.id,
      modelHash: model.sha256,
    },
    devicePreference: "cpu",
    resolvedBackend: "cpu",
    language: request.config.language,
    taskMode: request.config.taskMode,
    inference: {
      qualityPreset: request.config.qualityPreset,
      advanced: { ...request.config.advanced },
      vad: {
        enabled: false,
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        tokenTimestamps: false,
        timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
      },
      rawQualityGate: {
        maxSegmentDurationMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
        repeatedCueThreshold:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
        repeatedCoverageMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
        maxRetryDepth:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
      },
    },
    output,
    postAction: { mode: "export_only" },
  });
}

function createQueuedTaskSummary(
  record: TaskRecord,
  displayName: string,
  createdAt: string,
): LocalSubtitleTaskSummary {
  return {
    taskId: record.taskId,
    batchId: record.batch.batchId,
    generation: record.generation,
    displayName,
    status: "queued",
    progress: queuedProgress(),
    model: record.batch.config.model,
    resolvedBackend: record.batch.config.resolvedBackend,
    requestedFormats: [...record.batch.config.output.formats],
    artifactResults: [],
    postAction: initialPostAction(record.batch.config),
    createdAt,
    updatedAt: createdAt,
  };
}

function createBatchSummary(
  record: BatchRecord,
  tasks: readonly LocalSubtitleTaskSummary[],
  createdAt: string,
): LocalSubtitleBatchSummary {
  return {
    batchId: record.batchId,
    status: deriveLocalSubtitleBatchStatus(tasks),
    config: {
      modelId: record.config.model.modelId,
      devicePreference: record.config.devicePreference,
      resolvedBackend: record.config.resolvedBackend,
      language: record.config.language,
      taskMode: record.config.taskMode,
      qualityPreset: record.config.inference.qualityPreset,
      vadEnabled: record.config.inference.vad.enabled,
      outputFormats: [...record.config.output.formats],
      outputMode: record.config.output.mode,
      conflictPolicy: record.config.output.conflictPolicy,
      postActionMode: record.config.postAction.mode,
    },
    tasks: [...tasks],
    createdAt,
    updatedAt: createdAt,
  };
}

function initialPostAction(
  config: LocalSubtitleBatchConfigSnapshot,
): LocalSubtitlePostActionState {
  if (config.postAction.mode !== "export_only") {
    throw managerFailure("invalid_content", "Unsupported local subtitle post action.");
  }
  return Object.freeze({
    mode: "export_only",
    importStatus: "not_requested",
    startStatus: "not_requested",
  });
}

function queuedProgress(): LocalSubtitleTaskProgress {
  return Object.freeze({
    stage: "queued",
    stageProgress: 0,
    overallProgress: 0,
  });
}

function taskState(task: LocalSubtitleTaskSummary) {
  return {
    status: task.status,
    artifactResults: task.artifactResults,
    ...(task.completion === undefined ? {} : { completion: task.completion }),
    ...(task.error === undefined ? {} : { error: task.error }),
  };
}

function assertManagedModel(
  model: LocalSubtitleServerManagedResourceIdentity<"managed">,
  expectedId: string,
): void {
  if (
    !model ||
    model.storage !== "managed" ||
    model.id !== expectedId ||
    !Number.isSafeInteger(model.byteSize) ||
    model.byteSize <= 0 ||
    !/^[a-f0-9]{64}$/u.test(model.sha256) ||
    typeof model.absolutePath !== "string" ||
    model.absolutePath.length === 0
  ) {
    throw managerFailure(
      "invalid_content",
      "The managed local subtitle model identity is invalid.",
      "loading_model",
      "modelId",
    );
  }
}

function freezeManagedModel(
  model: LocalSubtitleServerManagedResourceIdentity<"managed">,
): LocalSubtitleServerManagedResourceIdentity<"managed"> {
  return Object.freeze({ ...model });
}

function assertManagedModelUnchanged(
  batch: BatchRecord,
  model: LocalSubtitleServerManagedResourceIdentity<"managed">,
): void {
  const frozen = batch.managedModel;
  if (
    model.storage !== frozen.storage ||
    model.id !== frozen.id ||
    model.absolutePath !== frozen.absolutePath ||
    model.byteSize !== frozen.byteSize ||
    model.sha256 !== frozen.sha256 ||
    batch.config.model.modelId !== frozen.id ||
    batch.config.model.modelHash !== frozen.sha256
  ) {
    throw managerFailure(
      "model_corrupt",
      "The managed local subtitle model changed after the batch was frozen.",
      "loading_model",
      "modelId",
    );
  }
}

function executionError(
  error: unknown,
  stage: LocalSubtitleOperationStage,
): LocalSubtitleError {
  const candidate = errorCode(error);
  const code = candidate ?? "transcription_failed";
  const reportedStage = operationStage(error) ??
    (MODEL_LOAD_ERROR_CODES.has(code) ? "loading_model" : stage);
  return createLocalSubtitleError(
    code,
    "The local subtitle task execution failed.",
    { stage: reportedStage },
  );
}

function errorCode(error: unknown): LocalSubtitleErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const localSubtitleCode = Reflect.get(error, "localSubtitleCode");
  if (isLocalSubtitleErrorCode(localSubtitleCode)) return localSubtitleCode;
  const code = Reflect.get(error, "code");
  return isLocalSubtitleErrorCode(code) ? code : undefined;
}

function errorStopsBatch(code: LocalSubtitleErrorCode): boolean {
  const scope = LOCAL_SUBTITLE_ERROR_MANIFEST[code].scope;
  return scope === "batch" || scope === "session";
}

function operationStage(error: unknown): LocalSubtitleOperationStage | undefined {
  if (!error || typeof error !== "object") return undefined;
  const stage = Reflect.get(error, "stage");
  return typeof stage === "string" &&
      (LOCAL_SUBTITLE_OPERATION_STAGES as readonly string[]).includes(stage)
    ? stage as LocalSubtitleOperationStage
    : undefined;
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function leaseRenewalInterval(
  requested: number | undefined,
  leaseTtlMs: number,
): number {
  const interval = requested ?? Math.max(1, Math.floor(leaseTtlMs / 3));
  if (
    !Number.isSafeInteger(interval) ||
    interval <= 0 ||
    interval >= leaseTtlMs
  ) {
    throw new TypeError("The local subtitle lease renewal interval is invalid.");
  }
  return interval;
}

function captureFailure(failures: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw managerFailure(
      "owner_released",
      "The local subtitle enqueue operation was aborted.",
      "cleanup",
    );
  }
}

function managerFailure(
  code: LocalSubtitleJobManagerErrorCode,
  message: string,
  stage: LocalSubtitleOperationStage = "preflight",
  field?: string,
): LocalSubtitleJobManagerError {
  return new LocalSubtitleJobManagerError(code, message, stage, field);
}

function ownerKey(owner: LocalSubtitleOwnerKey): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}
