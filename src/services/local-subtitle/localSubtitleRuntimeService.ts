import {
  createLocalSubtitleError,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleError,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleOutputDirectorySelection,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleCapabilityCleanupService } from "./localSubtitleCapabilityCleanupService";
import {
  createLocalSubtitleSessionReducerState,
  localSubtitleTaskKey,
  mergeLocalSubtitleSessionSnapshot,
  reduceLocalSubtitleSessionEvent,
  type LocalSubtitleSessionEvent,
  type LocalSubtitleSessionReducerState,
} from "./localSubtitleSessionReducer";

const MAX_BUFFERED_EVENTS = 2_048;
const MAX_SNAPSHOT_ATTEMPTS = 3;

interface BufferedTaskObservation {
  readonly batchId: string;
  readonly taskId: string;
  readonly generation: number;
  firstRevision: number;
  removedRevision?: number;
}

interface BufferedResourceObservation {
  readonly jobId: string;
  firstRevision: number;
  removedRevision?: number;
}

type ActiveOutputDirectory = Extract<
  LocalSubtitleOutputDirectorySelection,
  { cancelled: false }
>;

export type LocalSubtitleRuntimeSyncStatus =
  | "idle"
  | "syncing"
  | "ready"
  | "error";

export interface LocalSubtitleRuntimeState {
  readonly syncStatus: LocalSubtitleRuntimeSyncStatus;
  readonly revision: number;
  readonly batches: readonly LocalSubtitleBatchSummary[];
  readonly resourceJobs: readonly LocalSubtitleResourceJobSummary[];
  readonly error: LocalSubtitleError | null;
}

export interface LocalSubtitleRuntimeServiceOptions {
  readonly getApi: () => LocalSubtitleRendererApi;
  readonly maxBufferedEvents?: number;
  readonly maxSnapshotAttempts?: number;
  readonly cleanupRetryDelaysMs?: readonly number[];
  readonly cleanupAttemptTimeoutMs?: number;
  readonly now?: () => number;
}

export class LocalSubtitleRuntimeService {
  private readonly getApi: () => LocalSubtitleRendererApi;
  private readonly maxBufferedEvents: number;
  private readonly maxSnapshotAttempts: number;
  private readonly cleanup: LocalSubtitleCapabilityCleanupService;
  private readonly subscribers = new Set<() => void>();
  private reducerState = createLocalSubtitleSessionReducerState();
  private state: LocalSubtitleRuntimeState = toRuntimeState(
    "idle",
    this.reducerState,
    null,
  );
  private bufferedEvents: LocalSubtitleSessionEvent[] = [];
  private readonly bufferedTaskObservations = new Map<
    string,
    BufferedTaskObservation
  >();
  private readonly bufferedResourceObservations = new Map<
    string,
    BufferedResourceObservation
  >();
  private minimumSnapshotRevision = 0;
  private snapshotRequired = false;
  private snapshotSyncPromise: Promise<boolean> | undefined;
  private removeTaskListener: (() => void) | undefined;
  private removeResourceListener: (() => void) | undefined;
  private started = false;
  private epoch = 0;

  constructor(options: LocalSubtitleRuntimeServiceOptions) {
    this.getApi = options.getApi;
    this.maxBufferedEvents = positiveIntegerOr(
      options.maxBufferedEvents,
      MAX_BUFFERED_EVENTS,
    );
    this.maxSnapshotAttempts = positiveIntegerOr(
      options.maxSnapshotAttempts,
      MAX_SNAPSHOT_ATTEMPTS,
    );
    this.cleanup = new LocalSubtitleCapabilityCleanupService({
      getApi: options.getApi,
      retryDelaysMs: options.cleanupRetryDelaysMs,
      attemptTimeoutMs: options.cleanupAttemptTimeoutMs,
      now: options.now,
    });
  }

  getState = (): LocalSubtitleRuntimeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    void this.start();
    return () => {
      this.subscribers.delete(listener);
    };
  };

  async start(): Promise<boolean> {
    if (!this.started) {
      let api: LocalSubtitleRendererApi;
      try {
        api = this.getApi();
        const listenerEpoch = this.epoch;
        this.removeTaskListener = api.onTaskEvent((envelope) => {
          if (listenerEpoch !== this.epoch || !this.started) return;
          this.receiveEvent({ kind: "task", envelope });
        });
        this.removeResourceListener = api.onResourceEvent((envelope) => {
          if (listenerEpoch !== this.epoch || !this.started) return;
          this.receiveEvent({ kind: "resource", envelope });
        });
        this.started = true;
      } catch (error) {
        this.removeTaskListener?.();
        this.removeResourceListener?.();
        this.removeTaskListener = undefined;
        this.removeResourceListener = undefined;
        this.publish(
          "error",
          transportError("Unable to register local subtitle event listeners.", error),
        );
        return false;
      }
    }
    void this.cleanup.flushPendingDraftRevocations();
    if (this.state.syncStatus === "ready" && !this.snapshotSyncPromise) {
      return true;
    }
    return this.requestSnapshot(this.reducerState.revision, true);
  }

  refresh(): Promise<boolean> {
    return this.started
      ? this.requestSnapshot(
          this.reducerState.revision,
          this.snapshotRequired,
        )
      : this.start();
  }

  private requestSnapshot(
    minimumRevision: number,
    required = false,
  ): Promise<boolean> {
    if (required) this.snapshotRequired = true;
    this.minimumSnapshotRevision = Math.max(
      this.minimumSnapshotRevision,
      minimumRevision,
    );
    if (this.snapshotSyncPromise) return this.snapshotSyncPromise;

    const epoch = this.epoch;
    const promise = Promise.resolve().then(() => this.runSnapshotSync(epoch));
    this.snapshotSyncPromise = promise;
    this.publish("syncing", null);
    void promise.then((succeeded) => {
      if (this.snapshotSyncPromise !== promise) return;
      this.snapshotSyncPromise = undefined;
      if (
        succeeded &&
        epoch === this.epoch &&
        this.bufferedEvents.length > 0
      ) {
        if (this.replayBufferedEvents()) {
          this.snapshotRequired = false;
          this.minimumSnapshotRevision = this.reducerState.revision;
          this.publish("ready", null);
        } else {
          void this.requestSnapshot(this.minimumSnapshotRevision, true);
        }
      }
    });
    return promise;
  }

  queueInputDraftRevocation(
    media: Pick<LocalSubtitleAuthorizedMedia, "fileToken" | "expiresAt">,
  ): void {
    this.cleanup.queueInputDraftRevocation(media);
  }

  queueOutputDraftRevocation(
    output: Pick<ActiveOutputDirectory, "outputDirToken" | "expiresAt">,
  ): void {
    this.cleanup.queueOutputDraftRevocation(output);
  }

  flushPendingDraftRevocations(): Promise<void> {
    return this.cleanup.flushPendingDraftRevocations();
  }

  get pendingDraftRevocationCount(): number {
    return this.cleanup.pendingCount;
  }

  disposeForTests(): void {
    this.epoch += 1;
    this.started = false;
    this.removeTaskListener?.();
    this.removeResourceListener?.();
    this.removeTaskListener = undefined;
    this.removeResourceListener = undefined;
    this.snapshotSyncPromise = undefined;
    this.bufferedEvents = [];
    this.bufferedTaskObservations.clear();
    this.bufferedResourceObservations.clear();
    this.minimumSnapshotRevision = 0;
    this.snapshotRequired = false;
    this.cleanup.reset();
    this.reducerState = createLocalSubtitleSessionReducerState();
    this.state = toRuntimeState("idle", this.reducerState, null);
    this.subscribers.clear();
  }

  private receiveEvent(event: LocalSubtitleSessionEvent): void {
    if (this.snapshotSyncPromise || this.snapshotRequired) {
      this.bufferEvent(event);
      if (!this.snapshotSyncPromise) {
        void this.requestSnapshot(this.minimumSnapshotRevision, true);
      }
      return;
    }
    this.applyEvent(event);
  }

  private applyEvent(event: LocalSubtitleSessionEvent): void {
    const result = reduceLocalSubtitleSessionEvent(this.reducerState, event);
    this.reducerState = result.state;
    if (result.needsSnapshot) {
      void this.requestSnapshot(eventRevision(event), true);
      return;
    }
    this.publish("ready", null);
  }

  private bufferEvent(event: LocalSubtitleSessionEvent): void {
    this.snapshotRequired = true;
    this.recordBufferedObservation(event);
    if (this.bufferedEvents.length >= this.maxBufferedEvents) {
      const highestDroppedRevision = this.bufferedEvents.reduce(
        (highest, buffered) => Math.max(highest, eventRevision(buffered)),
        eventRevision(event),
      );
      this.bufferedEvents = [];
      this.minimumSnapshotRevision = Math.max(
        this.minimumSnapshotRevision,
        highestDroppedRevision,
      );
    }
    this.bufferedEvents.push(event);
  }

  private replayBufferedEvents(): boolean {
    const events = this.bufferedEvents
      .splice(0)
      .sort((left, right) => eventRevision(left) - eventRevision(right));
    let needsSnapshot = false;
    for (const event of events) {
      const result = reduceLocalSubtitleSessionEvent(this.reducerState, event);
      this.reducerState = result.state;
      if (result.needsSnapshot) {
        needsSnapshot = true;
        this.minimumSnapshotRevision = Math.max(
          this.minimumSnapshotRevision,
          eventRevision(event),
        );
      }
    }
    this.bufferedTaskObservations.clear();
    this.bufferedResourceObservations.clear();
    if (needsSnapshot) this.snapshotRequired = true;
    return !needsSnapshot;
  }

  private recordBufferedObservation(event: LocalSubtitleSessionEvent): void {
    if (event.kind === "task") {
      const envelope = event.envelope;
      const observationKey = `${localSubtitleTaskKey(
        envelope.batchId,
        envelope.taskId,
      )}:${envelope.generation}`;
      const existing = this.bufferedTaskObservations.get(observationKey);
      const observation = existing ?? {
        batchId: envelope.batchId,
        taskId: envelope.taskId,
        generation: envelope.generation,
        firstRevision: envelope.revision,
      };
      observation.firstRevision = Math.min(
        observation.firstRevision,
        envelope.revision,
      );
      if (envelope.event.type === "task-removed") {
        observation.removedRevision = Math.min(
          observation.removedRevision ?? envelope.revision,
          envelope.revision,
        );
      }
      this.bufferedTaskObservations.set(observationKey, observation);
      return;
    }

    const envelope = event.envelope;
    const jobId =
      envelope.event.type === "resource-job-updated"
        ? envelope.event.job.jobId
        : envelope.event.jobId;
    const existing = this.bufferedResourceObservations.get(jobId);
    const observation = existing ?? {
      jobId,
      firstRevision: envelope.revision,
    };
    observation.firstRevision = Math.min(
      observation.firstRevision,
      envelope.revision,
    );
    if (envelope.event.type === "resource-job-removed") {
      observation.removedRevision = Math.min(
        observation.removedRevision ?? envelope.revision,
        envelope.revision,
      );
    }
    this.bufferedResourceObservations.set(jobId, observation);
  }

  private applyCoveredBufferedObservations(
    snapshot: LocalSubtitleSessionSnapshot,
  ): LocalSubtitleSessionReducerState {
    const incomingTasks = new Map<string, number>();
    for (const batch of snapshot.batches) {
      for (const task of batch.tasks) {
        incomingTasks.set(
          localSubtitleTaskKey(batch.batchId, task.taskId),
          task.generation,
        );
      }
    }
    const incomingResourceJobIds = new Set(
      snapshot.resourceJobs.map((job) => job.jobId),
    );
    const maxGenerationByTaskKey = new Map(
      this.reducerState.maxGenerationByTaskKey,
    );
    const taskTombstones = new Map(this.reducerState.taskTombstones);
    const resourceTombstones = new Map(
      this.reducerState.resourceTombstones,
    );

    for (const observation of this.bufferedTaskObservations.values()) {
      if (observation.firstRevision > snapshot.revision) continue;
      const key = localSubtitleTaskKey(
        observation.batchId,
        observation.taskId,
      );
      maxGenerationByTaskKey.set(
        key,
        Math.max(
          maxGenerationByTaskKey.get(key) ?? 0,
          observation.generation,
        ),
      );
      const snapshotGeneration = incomingTasks.get(key);
      const coveredRemoval =
        observation.removedRevision !== undefined &&
        observation.removedRevision <= snapshot.revision;
      if (snapshotGeneration === undefined || coveredRemoval) {
        taskTombstones.set(
          key,
          Math.max(
            taskTombstones.get(key) ?? 0,
            observation.generation,
          ),
        );
      }
    }

    for (const observation of this.bufferedResourceObservations.values()) {
      if (observation.firstRevision > snapshot.revision) continue;
      const coveredRemoval =
        observation.removedRevision !== undefined &&
        observation.removedRevision <= snapshot.revision;
      if (!incomingResourceJobIds.has(observation.jobId) || coveredRemoval) {
        resourceTombstones.set(observation.jobId, snapshot.revision);
      }
    }

    return {
      ...this.reducerState,
      maxGenerationByTaskKey,
      taskTombstones,
      resourceTombstones,
    };
  }

  private async runSnapshotSync(epoch: number): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxSnapshotAttempts; attempt += 1) {
      let response: Awaited<ReturnType<LocalSubtitleRendererApi["getSessionSnapshot"]>>;
      try {
        response = await this.getApi().getSessionSnapshot();
      } catch (error) {
        if (epoch !== this.epoch) return false;
        this.publish(
          "error",
          transportError("Unable to read the local subtitle session.", error),
        );
        return false;
      }
      if (epoch !== this.epoch) return false;
      if (!response.ok) {
        this.publish("error", response.error);
        return false;
      }
      if (response.data.revision < this.minimumSnapshotRevision) continue;

      const stateWithCoveredObservations =
        this.applyCoveredBufferedObservations(response.data);
      const merged = mergeLocalSubtitleSessionSnapshot(
        stateWithCoveredObservations,
        response.data,
      );
      if (!merged.accepted) {
        this.snapshotRequired = true;
        continue;
      }
      this.reducerState = merged.state;
      this.minimumSnapshotRevision = this.reducerState.revision;
      const replayedWithoutGap = this.replayBufferedEvents();
      if (replayedWithoutGap) {
        this.snapshotRequired = false;
        this.minimumSnapshotRevision = this.reducerState.revision;
        this.publish("ready", null);
        return true;
      }
    }

    if (epoch !== this.epoch) return false;
    this.publish(
      "error",
      createLocalSubtitleError(
        "runtime_unresponsive",
        "The local subtitle session could not reach a consistent revision.",
        { stage: "ipc" },
      ),
    );
    return false;
  }

  private publish(
    syncStatus: LocalSubtitleRuntimeSyncStatus,
    error: LocalSubtitleError | null,
  ): void {
    this.state = toRuntimeState(syncStatus, this.reducerState, error);
    for (const subscriber of this.subscribers) {
      try {
        subscriber();
      } catch {
        // An observer cannot own or interrupt the session-level IPC lifecycle.
      }
    }
  }
}

let runtimeService: LocalSubtitleRuntimeService | undefined;

export function getLocalSubtitleRuntimeService(): LocalSubtitleRuntimeService {
  runtimeService ??= new LocalSubtitleRuntimeService({
    getApi: getRendererApi,
  });
  return runtimeService;
}

export function resetLocalSubtitleRuntimeServiceForTests(): void {
  runtimeService?.disposeForTests();
  runtimeService = undefined;
}

function getRendererApi(): LocalSubtitleRendererApi {
  if (typeof window === "undefined" || !window.localSubtitleApi) {
    throw new Error(
      "Local subtitle IPC is only available in the Electron renderer.",
    );
  }
  return window.localSubtitleApi;
}

function toRuntimeState(
  syncStatus: LocalSubtitleRuntimeSyncStatus,
  state: LocalSubtitleSessionReducerState,
  error: LocalSubtitleError | null,
): LocalSubtitleRuntimeState {
  return {
    syncStatus,
    revision: state.revision,
    batches: state.batches,
    resourceJobs: state.resourceJobs,
    error,
  };
}

function eventRevision(event: LocalSubtitleSessionEvent): number {
  return event.envelope.revision;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function transportError(message: string, error: unknown): LocalSubtitleError {
  return createLocalSubtitleError("runtime_unresponsive", message, {
    stage: "ipc",
    details: {
      summary:
        error instanceof Error
          ? "The renderer transport rejected the request."
          : "The renderer transport failed without an Error object.",
      truncated: false,
    },
  });
}
