import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  createLocalSubtitleError,
  deriveLocalSubtitleBatchStatus,
  hasLocalSubtitleArtifactCancellationEvidence,
  isLocalSubtitleCpuRetryAvailable,
  transitionLocalSubtitleTaskState,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleErrorCode,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import {
  localSubtitleBatchSummarySchema,
  localSubtitleResourceEventEnvelopeSchema,
  localSubtitleResourceJobSummarySchema,
  localSubtitleSessionSnapshotSchema,
  localSubtitleTaskEventEnvelopeSchema,
  localSubtitleTaskSummarySchema,
} from "@/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "./authorizations";

export type LocalSubtitleSessionRegistryErrorCode = Extract<
  LocalSubtitleErrorCode,
  "invalid_ipc_request" | "owner_released" | "limit_exceeded" | "invalid_content"
>;

export class LocalSubtitleSessionRegistryError extends Error {
  readonly name = "LocalSubtitleSessionRegistryError";
  readonly localSubtitleCode: LocalSubtitleSessionRegistryErrorCode;

  constructor(
    readonly code: LocalSubtitleSessionRegistryErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.localSubtitleCode = code;
  }
}

export type LocalSubtitleResourceEventListener = (
  envelope: LocalSubtitleResourceEventEnvelope,
) => void;

export type LocalSubtitleTaskEventListener = (
  envelope: LocalSubtitleTaskEventEnvelope,
) => void;

type OwnerSessionDelivery =
  | {
      readonly kind: "task";
      readonly envelope: LocalSubtitleTaskEventEnvelope;
    }
  | {
      readonly kind: "resource";
      readonly envelope: LocalSubtitleResourceEventEnvelope;
    };

interface OwnerSessionState {
  readonly key: string;
  revision: number;
  readonly batches: Map<string, LocalSubtitleBatchSummary>;
  readonly taskGenerations: Map<string, number>;
  readonly resourceJobs: Map<string, LocalSubtitleResourceJobSummary>;
  readonly taskListeners: Set<LocalSubtitleTaskEventListener>;
  readonly resourceListeners: Set<LocalSubtitleResourceEventListener>;
  readonly deliveryQueue: OwnerSessionDelivery[];
  delivering: boolean;
}

export class LocalSubtitleSessionRegistry {
  readonly #sessions = new Map<string, OwnerSessionState>();
  readonly #releasedOwners = new Set<string>();
  #shutDown = false;
  #shutdownOperation: Promise<void> | undefined;

  assertOwnerActive(owner: LocalSubtitleOwnerKey): void {
    assertOwner(owner);
    if (this.#shutDown || this.#releasedOwners.has(ownerKey(owner))) {
      throw ownerReleased();
    }
  }

  getSnapshot(owner: LocalSubtitleOwnerKey): LocalSubtitleSessionSnapshot {
    const session = this.#requireSession(owner);
    return freezeDto(parseSnapshot({
      schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
      revision: session.revision,
      batches: [...session.batches.values()],
      resourceJobs: [...session.resourceJobs.values()],
    }));
  }

  getResourceJob(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
  ): LocalSubtitleResourceJobSummary | undefined {
    this.assertOwnerActive(owner);
    assertId(jobId, "jobId");
    return this.#sessions.get(ownerKey(owner))?.resourceJobs.get(jobId);
  }

  getBatch(
    owner: LocalSubtitleOwnerKey,
    batchId: string,
  ): LocalSubtitleBatchSummary | undefined {
    this.assertOwnerActive(owner);
    assertId(batchId, "batchId");
    return this.#sessions.get(ownerKey(owner))?.batches.get(batchId);
  }

  getTask(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
  ): LocalSubtitleTaskSummary | undefined {
    this.assertOwnerActive(owner);
    assertId(taskId, "taskId");
    const session = this.#sessions.get(ownerKey(owner));
    if (!session) return undefined;
    for (const batch of session.batches.values()) {
      const task = batch.tasks.find((candidate) => candidate.taskId === taskId);
      if (task) return task;
    }
    return undefined;
  }

  onTaskEvent(
    owner: LocalSubtitleOwnerKey,
    listener: LocalSubtitleTaskEventListener,
  ): () => void {
    if (typeof listener !== "function") throw invalid("listener");
    const session = this.#requireSession(owner);
    session.taskListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      session.taskListeners.delete(listener);
    };
  }

  onResourceEvent(
    owner: LocalSubtitleOwnerKey,
    listener: LocalSubtitleResourceEventListener,
  ): () => void {
    if (typeof listener !== "function") throw invalid("listener");
    const session = this.#requireSession(owner);
    session.resourceListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      session.resourceListeners.delete(listener);
    };
  }

  addBatch(
    owner: LocalSubtitleOwnerKey,
    batch: LocalSubtitleBatchSummary,
  ): readonly LocalSubtitleTaskEventEnvelope[] {
    const publication = this.prepareBatchPublication(owner, batch);
    const envelopes = publication.commit();
    publication.publish();
    return envelopes;
  }

  prepareBatchPublication(
    owner: LocalSubtitleOwnerKey,
    batch: LocalSubtitleBatchSummary,
  ): Readonly<{
    readonly envelopes: readonly LocalSubtitleTaskEventEnvelope[];
    commit(): readonly LocalSubtitleTaskEventEnvelope[];
    rollback(): void;
    publish(): void;
  }> {
    this.assertOwnerActive(owner);
    const parsedBatch = freezeDto(parseBatch(batch));
    if (parsedBatch.tasks.length === 0) throw invalidContent("batch.tasks");
    const session = this.#requireSession(owner);
    const key = ownerKey(owner);
    const baseRevision = session.revision;
    if (session.batches.has(parsedBatch.batchId)) {
      throw invalidContent("batch.batchId");
    }
    if (session.batches.size >= LOCAL_SUBTITLE_LIMITS.maxSessionBatches) {
      throw failure("limit_exceeded", "batches");
    }

    const taskIds = new Set<string>();
    for (const existingBatch of session.batches.values()) {
      for (const task of existingBatch.tasks) taskIds.add(task.taskId);
    }
    for (const task of parsedBatch.tasks) {
      assertInitialTask(task);
      if (
        taskIds.has(task.taskId) ||
        (session.taskGenerations.get(task.taskId) ?? 0) >= task.generation
      ) {
        throw invalidContent("batch.tasks.taskId");
      }
      taskIds.add(task.taskId);
    }
    assertRevisionCapacity(session.revision, parsedBatch.tasks.length);

    const envelopes = parsedBatch.tasks.map((task, index) =>
      freezeDto(parseTaskEvent({
        batchId: parsedBatch.batchId,
        taskId: task.taskId,
        generation: task.generation,
        revision: baseRevision + index + 1,
        event: { type: "task-updated", task },
      })),
    );
    const frozenEnvelopes = Object.freeze(envelopes);
    const previousGenerations = new Map(
      parsedBatch.tasks.map((task) => [
        task.taskId,
        session.taskGenerations.get(task.taskId),
      ] as const),
    );
    let state: "prepared" | "committed" | "published" | "rolled_back" =
      "prepared";
    const assertPreparedSession = () => {
      this.assertOwnerActive(owner);
      if (
        this.#sessions.get(key) !== session ||
        session.revision !== baseRevision ||
        session.batches.has(parsedBatch.batchId)
      ) {
        throw invalidContent("batch.publication");
      }
      for (const task of parsedBatch.tasks) {
        if (session.taskGenerations.get(task.taskId) !== previousGenerations.get(task.taskId)) {
          throw invalidContent("batch.publication");
        }
      }
    };
    return Object.freeze({
      envelopes: frozenEnvelopes,
      commit: () => {
        if (state !== "prepared") throw invalid("publication");
        assertPreparedSession();
        session.batches.set(parsedBatch.batchId, parsedBatch);
        for (const task of parsedBatch.tasks) {
          session.taskGenerations.set(task.taskId, task.generation);
        }
        session.revision = baseRevision + frozenEnvelopes.length;
        state = "committed";
        return frozenEnvelopes;
      },
      rollback: () => {
        if (state === "rolled_back") return;
        if (state === "published") throw invalid("publication");
        if (state === "committed") {
          if (
            this.#sessions.get(key) !== session ||
            session.revision !== baseRevision + frozenEnvelopes.length ||
            session.batches.get(parsedBatch.batchId) !== parsedBatch
          ) {
            throw invalidContent("batch.publication");
          }
          session.batches.delete(parsedBatch.batchId);
          for (const [taskId, generation] of previousGenerations) {
            if (generation === undefined) session.taskGenerations.delete(taskId);
            else session.taskGenerations.set(taskId, generation);
          }
          session.revision = baseRevision;
        }
        state = "rolled_back";
      },
      publish: () => {
        if (state !== "committed") throw invalid("publication");
        state = "published";
        this.#enqueueDeliveries(
          session,
          frozenEnvelopes.map((envelope) => ({ kind: "task", envelope })),
        );
      },
    });
  }

  upsertTask(
    owner: LocalSubtitleOwnerKey,
    task: LocalSubtitleTaskSummary,
  ): LocalSubtitleTaskEventEnvelope {
    this.assertOwnerActive(owner);
    const parsedTask = freezeDto(parseTask(task));
    const session = this.#requireSession(owner);
    const batch = session.batches.get(parsedTask.batchId);
    if (!batch) throw invalidContent("task.batchId");
    const index = batch.tasks.findIndex(
      (candidate) => candidate.taskId === parsedTask.taskId,
    );
    if (index < 0) throw invalidContent("task.taskId");
    const current = batch.tasks[index]!;
    assertTaskMutation(
      current,
      parsedTask,
      session.taskGenerations.get(parsedTask.taskId),
    );

    const tasks = [...batch.tasks];
    tasks[index] = parsedTask;
    const updatedBatch = freezeDto(parseBatch({
      ...batch,
      status: deriveLocalSubtitleBatchStatus(tasks),
      tasks,
      updatedAt: parsedTask.updatedAt,
    }));
    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseTaskEvent({
      batchId: parsedTask.batchId,
      taskId: parsedTask.taskId,
      generation: parsedTask.generation,
      revision,
      event: { type: "task-updated", task: parsedTask },
    }));
    session.batches.set(updatedBatch.batchId, updatedBatch);
    session.taskGenerations.set(parsedTask.taskId, parsedTask.generation);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "task", envelope }]);
    return envelope;
  }

  removeTask(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
    removedAt: string,
  ): LocalSubtitleTaskEventEnvelope | undefined {
    this.assertOwnerActive(owner);
    assertId(taskId, "taskId");
    const session = this.#sessions.get(ownerKey(owner));
    if (!session) return undefined;
    const batch = [...session.batches.values()].find((candidate) =>
      candidate.tasks.some((task) => task.taskId === taskId),
    );
    if (!batch) return undefined;
    const task = batch.tasks.find((candidate) => candidate.taskId === taskId)!;
    const validated = parseTaskEvent({
      batchId: batch.batchId,
      taskId,
      generation: task.generation,
      revision: 1,
      event: { type: "task-removed", removedAt },
    });
    const tasks = batch.tasks.filter((candidate) => candidate.taskId !== taskId);
    const updatedBatch = tasks.length === 0
      ? undefined
      : freezeDto(parseBatch({
          ...batch,
          status: deriveLocalSubtitleBatchStatus(tasks),
          tasks,
          updatedAt: validated.event.type === "task-removed"
            ? validated.event.removedAt
            : removedAt,
        }));
    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseTaskEvent({
      ...validated,
      revision,
    }));
    if (updatedBatch) session.batches.set(batch.batchId, updatedBatch);
    else session.batches.delete(batch.batchId);
    session.taskGenerations.set(taskId, task.generation);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "task", envelope }]);
    return envelope;
  }

  upsertResourceJob(
    owner: LocalSubtitleOwnerKey,
    job: LocalSubtitleResourceJobSummary,
  ): LocalSubtitleResourceEventEnvelope {
    this.assertOwnerActive(owner);
    const parsedJob = freezeDto(parseResourceJob(job));
    const session = this.#requireSession(owner);
    const exists = session.resourceJobs.has(parsedJob.jobId);
    if (
      !exists &&
      session.resourceJobs.size >= LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs
    ) {
      throw failure("limit_exceeded", "resourceJobs");
    }
    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseResourceEvent({
      revision,
      event: { type: "resource-job-updated", job: parsedJob },
    }));
    session.resourceJobs.set(parsedJob.jobId, parsedJob);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "resource", envelope }]);
    return envelope;
  }

  removeResourceJob(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
    removedAt: string,
  ): LocalSubtitleResourceEventEnvelope | undefined {
    this.assertOwnerActive(owner);
    const validated = parseResourceEvent({
      revision: 1,
      event: { type: "resource-job-removed", jobId, removedAt },
    });
    if (validated.event.type !== "resource-job-removed") {
      throw invalidContent("resourceEvent");
    }
    const session = this.#sessions.get(ownerKey(owner));
    if (!session?.resourceJobs.has(validated.event.jobId)) return undefined;

    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseResourceEvent({
      revision,
      event: validated.event,
    }));
    session.resourceJobs.delete(validated.event.jobId);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "resource", envelope }]);
    return envelope;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): boolean {
    assertOwner(owner);
    const key = ownerKey(owner);
    if (this.#releasedOwners.has(key)) return false;
    this.#releasedOwners.add(key);
    const session = this.#sessions.get(key);
    session?.taskListeners.clear();
    session?.resourceListeners.clear();
    session?.deliveryQueue.splice(0);
    this.#sessions.delete(key);
    return true;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    const operation = Promise.resolve();
    this.#shutdownOperation = operation;
    this.#shutDown = true;
    for (const [key, session] of this.#sessions) {
      this.#releasedOwners.add(key);
      session.taskListeners.clear();
      session.resourceListeners.clear();
      session.deliveryQueue.splice(0);
    }
    this.#sessions.clear();
    return operation;
  }

  #requireSession(owner: LocalSubtitleOwnerKey): OwnerSessionState {
    this.assertOwnerActive(owner);
    const key = ownerKey(owner);
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const created: OwnerSessionState = {
      key,
      revision: 0,
      batches: new Map(),
      taskGenerations: new Map(),
      resourceJobs: new Map(),
      taskListeners: new Set(),
      resourceListeners: new Set(),
      deliveryQueue: [],
      delivering: false,
    };
    this.#sessions.set(key, created);
    return created;
  }

  #enqueueDeliveries(
    session: OwnerSessionState,
    deliveries: readonly OwnerSessionDelivery[],
  ): void {
    if (this.#sessions.get(session.key) !== session) return;
    session.deliveryQueue.push(...deliveries);
    this.#drainDeliveries(session);
  }

  #drainDeliveries(session: OwnerSessionState): void {
    if (session.delivering) return;
    session.delivering = true;
    try {
      while (
        session.deliveryQueue.length > 0 &&
        this.#sessions.get(session.key) === session
      ) {
        const delivery = session.deliveryQueue.shift()!;
        if (delivery.kind === "task") {
          this.#deliverToListeners(
            session,
            session.taskListeners,
            delivery.envelope,
          );
        } else {
          this.#deliverToListeners(
            session,
            session.resourceListeners,
            delivery.envelope,
          );
        }
      }
    } finally {
      if (this.#sessions.get(session.key) !== session) {
        session.deliveryQueue.splice(0);
      }
      session.delivering = false;
    }
  }

  #deliverToListeners<T>(
    session: OwnerSessionState,
    listeners: Set<(envelope: T) => void>,
    envelope: T,
  ): void {
    for (const listener of [...listeners]) {
      if (this.#sessions.get(session.key) !== session) break;
      if (!listeners.has(listener)) continue;
      try {
        const result: unknown = listener(envelope);
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // A delivery failure cannot roll back authoritative session state.
      }
    }
  }
}

function parseBatch(value: unknown): LocalSubtitleBatchSummary {
  const result = localSubtitleBatchSummarySchema.safeParse(value);
  if (!result.success) throw invalidContent("batch");
  return {
    ...result.data,
    tasks: result.data.tasks.map(sanitizeTask),
  };
}

function parseTask(value: unknown): LocalSubtitleTaskSummary {
  const result = localSubtitleTaskSummarySchema.safeParse(value);
  if (!result.success) throw invalidContent("task");
  return sanitizeTask(result.data);
}

function sanitizeTask(task: LocalSubtitleTaskSummary): LocalSubtitleTaskSummary {
  if (task.error === undefined) return task;
  return {
    ...task,
    error: createLocalSubtitleError(
      task.error.code,
      "The local subtitle task failed.",
      {
        stage: task.error.stage,
        ...(task.error.causeCode === undefined
          ? {}
          : { causeCode: task.error.causeCode }),
      },
    ),
  };
}

function assertInitialTask(task: LocalSubtitleTaskSummary): void {
  if (task.generation !== 1) throw invalidContent("batch.tasks.generation");
  if (task.status !== "queued") throw invalidContent("batch.tasks.status");
}

function assertTaskMutation(
  current: LocalSubtitleTaskSummary,
  next: LocalSubtitleTaskSummary,
  observedGeneration: number | undefined,
): void {
  if (observedGeneration !== current.generation) {
    throw invalidContent("task.generation");
  }
  const cpuRetryGeneration =
    next.generation === current.generation + 1 &&
    current.cpuRetryAvailable === true &&
    isLocalSubtitleCpuRetryAvailable(current) &&
    next.status === "queued" &&
    next.resolvedBackend === "cpu";
  assertImmutableTaskFields(current, next, cpuRetryGeneration);

  if (next.generation === current.generation) {
    if (next.createdAt !== current.createdAt) {
      throw invalidContent("task.immutable");
    }
    if (
      current.durationMs !== undefined &&
      next.durationMs !== current.durationMs
    ) {
      throw invalidContent("task.immutable");
    }
    assertSameGenerationTransition(current, next);
    assertMonotonicProgress(current, next);
    return;
  }

  if (
    current.generation >= Number.MAX_SAFE_INTEGER ||
    next.generation !== current.generation + 1
  ) {
    throw invalidContent("task.generation");
  }
  if (current.status !== "failed" || next.status !== "queued") {
    throw invalidContent("task.status");
  }
  if (
    next.durationMs !== current.durationMs ||
    next.progress.completedWindows !== undefined ||
    next.progress.totalWindows !== undefined
  ) {
    throw invalidContent("task.retry");
  }
}

function assertImmutableTaskFields(
  current: LocalSubtitleTaskSummary,
  next: LocalSubtitleTaskSummary,
  allowCpuRetryBackendChange = false,
): void {
  if (
    next.taskId !== current.taskId ||
    next.batchId !== current.batchId ||
    next.displayName !== current.displayName ||
    (!allowCpuRetryBackendChange &&
      next.resolvedBackend !== current.resolvedBackend) ||
    !sameModel(next.model, current.model) ||
    !sameStringList(next.requestedFormats, current.requestedFormats) ||
    next.postAction.mode !== current.postAction.mode ||
    next.postAction.preferredFormat !== current.postAction.preferredFormat
  ) {
    throw invalidContent("task.immutable");
  }
}

function assertSameGenerationTransition(
  current: LocalSubtitleTaskSummary,
  next: LocalSubtitleTaskSummary,
): void {
  if (next.status === current.status) return;
  const transition = transitionLocalSubtitleTaskState(
    {
      status: current.status,
      artifactResults: current.artifactResults,
      ...(current.completion === undefined
        ? {}
        : { completion: current.completion }),
      ...(current.error === undefined ? {} : { error: current.error }),
    },
    next.status,
    {
      requestedFormats: current.requestedFormats,
      artifactResults: next.artifactResults,
      cancellationRequested: hasLocalSubtitleArtifactCancellationEvidence(
        next.artifactResults,
      ),
      ...(next.error === undefined ? {} : { error: next.error }),
    },
  );
  if (!transition.ok) throw invalidContent("task.status");
}

function assertMonotonicProgress(
  current: LocalSubtitleTaskSummary,
  next: LocalSubtitleTaskSummary,
): void {
  if (next.progress.overallProgress < current.progress.overallProgress) {
    throw invalidContent("task.progress");
  }
  if (next.status !== current.status) return;
  if (
    next.progress.stage !== current.progress.stage ||
    next.progress.stageProgress < current.progress.stageProgress ||
    (current.progress.completedWindows !== undefined &&
      (next.progress.completedWindows === undefined ||
        next.progress.completedWindows < current.progress.completedWindows)) ||
    (current.progress.totalWindows !== undefined &&
      next.progress.totalWindows !== current.progress.totalWindows)
  ) {
    throw invalidContent("task.progress");
  }
}

function sameModel(
  left: LocalSubtitleTaskSummary["model"],
  right: LocalSubtitleTaskSummary["model"],
): boolean {
  return (
    left.engine === right.engine &&
    left.engineVersion === right.engineVersion &&
    left.engineCommit === right.engineCommit &&
    left.modelManifestVersion === right.modelManifestVersion &&
    left.modelId === right.modelId &&
    left.modelHash === right.modelHash
  );
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseTaskEvent(value: unknown): LocalSubtitleTaskEventEnvelope {
  const result = localSubtitleTaskEventEnvelopeSchema.safeParse(value);
  if (!result.success) throw invalidContent("taskEvent");
  return result.data;
}

function parseResourceJob(value: unknown): LocalSubtitleResourceJobSummary {
  const result = localSubtitleResourceJobSummarySchema.safeParse(value);
  if (!result.success) throw invalidContent("resourceJob");
  if (result.data.error === undefined) return result.data;
  return {
    ...result.data,
    error: createLocalSubtitleError(
      result.data.error.code,
      "The local subtitle resource operation failed.",
      {
        stage: result.data.error.stage,
        ...(result.data.error.causeCode === undefined
          ? {}
          : { causeCode: result.data.error.causeCode }),
      },
    ),
  };
}

function parseResourceEvent(value: unknown): LocalSubtitleResourceEventEnvelope {
  const result = localSubtitleResourceEventEnvelopeSchema.safeParse(value);
  if (!result.success) throw invalidContent("resourceEvent");
  return result.data;
}

function parseSnapshot(value: unknown): LocalSubtitleSessionSnapshot {
  const result = localSubtitleSessionSnapshotSchema.safeParse(value);
  if (!result.success) throw invalidContent("snapshot");
  return result.data;
}

function nextRevision(current: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw failure("limit_exceeded", "revision");
  }
  return current + 1;
}

function assertRevisionCapacity(current: number, increment: number): void {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(increment) ||
    increment <= 0 ||
    current > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw failure("limit_exceeded", "revision");
  }
}

function assertOwner(owner: LocalSubtitleOwnerKey): void {
  if (
    !owner ||
    !Number.isSafeInteger(owner.webContentsId) ||
    owner.webContentsId < 0 ||
    !owner.ownerSessionId ||
    owner.ownerSessionId.length > 128 ||
    owner.ownerSessionId.trim() !== owner.ownerSessionId ||
    /[\u0000-\u001f\u007f]/u.test(owner.ownerSessionId)
  ) {
    throw invalid("owner");
  }
}

function assertId(value: string, field: string): void {
  if (
    !value ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(field);
  }
}

function ownerKey(owner: LocalSubtitleOwnerKey): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
}

function invalid(field: string): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "invalid_ipc_request",
    "The local subtitle session registry input is invalid.",
    field,
  );
}

function invalidContent(field: string): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "invalid_content",
    "The local subtitle session state is invalid.",
    field,
  );
}

function failure(
  code: Extract<LocalSubtitleSessionRegistryErrorCode, "limit_exceeded">,
  field: string,
): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    code,
    "The local subtitle session registry limit was reached.",
    field,
  );
}

function ownerReleased(): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "owner_released",
    "The local subtitle session owner has been released.",
    "owner",
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof Reflect.get(value, "then") === "function",
  );
}

function freezeDto<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDto(nested);
  }
  return Object.freeze(value);
}
