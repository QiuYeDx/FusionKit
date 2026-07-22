import { randomUUID } from "node:crypto";
import {
  createLocalSubtitleError,
  type LocalSubtitleError,
  type LocalSubtitleResourceJobStatus,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleResourceType,
} from "@/type/localSubtitle";
import type { LocalSubtitleOwnerKey } from "./authorizations";
import {
  LocalSubtitleSessionRegistry,
  LocalSubtitleSessionRegistryError,
} from "./session-registry";

type ResourceJobWorkingStatus = Extract<
  LocalSubtitleResourceJobStatus,
  "acquiring" | "verifying" | "load_smoke" | "signature_check" | "committing"
>;

export interface LocalSubtitleResourceJobUpdate {
  readonly status: ResourceJobWorkingStatus;
  readonly progress: number;
  readonly bytesCompleted?: number;
  readonly bytesTotal?: number;
}

export interface LocalSubtitleResourceJobContext {
  readonly signal: AbortSignal;
  isCancellationRequested(): boolean;
  update(update: LocalSubtitleResourceJobUpdate): LocalSubtitleResourceJobSummary;
}

export type LocalSubtitleResourceJobExecutionResult =
  | { readonly status: "completed" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: LocalSubtitleError };

export interface StartLocalSubtitleResourceJobOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly resourceId: string;
  readonly resourceType: LocalSubtitleResourceType;
  readonly execute: (
    context: LocalSubtitleResourceJobContext,
  ) =>
    | void
    | LocalSubtitleResourceJobExecutionResult
    | Promise<void | LocalSubtitleResourceJobExecutionResult>;
}

export type LocalSubtitleSessionRegistryOwnership = "owned" | "shared";

export interface LocalSubtitleResourceJobManagerOptions {
  readonly now?: () => number;
  readonly jobIdFactory?: () => string;
  readonly sessionRegistryOwnership?: LocalSubtitleSessionRegistryOwnership;
}

export class LocalSubtitleResourceJobExecutionError extends Error {
  readonly name = "LocalSubtitleResourceJobExecutionError";

  constructor(readonly error: LocalSubtitleError) {
    super("The local subtitle resource job failed.");
  }
}

interface ActiveJobRecord {
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerKey: string;
  readonly jobId: string;
  readonly controller: AbortController;
  cancelRequested: boolean;
  commitStarted: boolean;
}

const RESOURCE_JOB_TRANSITIONS = {
  queued: ["acquiring", "cancelling", "failed"],
  acquiring: ["acquiring", "verifying", "cancelling", "failed"],
  verifying: [
    "verifying",
    "load_smoke",
    "signature_check",
    "committing",
    "cancelling",
    "failed",
  ],
  load_smoke: ["load_smoke", "committing", "cancelling", "failed"],
  signature_check: ["signature_check", "committing", "cancelling", "failed"],
  committing: ["committing", "completed", "cancelling", "failed"],
  cancelling: ["cancelled", "completed", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<
  LocalSubtitleResourceJobStatus,
  readonly LocalSubtitleResourceJobStatus[]
>;

export class LocalSubtitleResourceJobManager {
  readonly #registry: LocalSubtitleSessionRegistry;
  readonly #now: () => number;
  readonly #jobIdFactory: () => string;
  readonly #sessionRegistryOwnership: LocalSubtitleSessionRegistryOwnership;
  readonly #activeJobs = new Map<string, ActiveJobRecord>();
  readonly #releasedOwners = new Set<string>();
  readonly #operations = new Map<Promise<void>, string>();
  #shuttingDown = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(
    registry: LocalSubtitleSessionRegistry,
    options: LocalSubtitleResourceJobManagerOptions = {},
  ) {
    if (!(registry instanceof LocalSubtitleSessionRegistry)) {
      throw new TypeError("The local subtitle session registry is invalid.");
    }
    this.#registry = registry;
    this.#now = options.now ?? Date.now;
    this.#jobIdFactory = options.jobIdFactory ??
      (() => `resource-job-${randomUUID()}`);
    this.#sessionRegistryOwnership = validateSessionRegistryOwnership(
      options.sessionRegistryOwnership ?? "owned",
    );
  }

  start(
    options: StartLocalSubtitleResourceJobOptions,
  ): LocalSubtitleResourceJobSummary {
    if (!options || typeof options.execute !== "function") {
      throw new TypeError("The local subtitle resource job executor is invalid.");
    }
    this.#assertOwnerAvailable(options.owner);
    const jobId = this.#jobIdFactory();
    if (this.#activeJobs.has(jobId)) {
      throw new TypeError("The local subtitle resource job id is not unique.");
    }
    const timestamp = this.#timestamp();
    const record: ActiveJobRecord = {
      owner: Object.freeze({ ...options.owner }),
      ownerKey: ownerKey(options.owner),
      jobId,
      controller: new AbortController(),
      cancelRequested: false,
      commitStarted: false,
    };
    this.#activeJobs.set(jobId, record);

    let initial: LocalSubtitleResourceJobSummary;
    try {
      const envelope = this.#registry.upsertResourceJob(record.owner, {
        jobId,
        resourceId: options.resourceId,
        resourceType: options.resourceType,
        status: "queued",
        progress: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (envelope.event.type !== "resource-job-updated") {
        throw new TypeError("The resource job registry returned an invalid event.");
      }
      initial = envelope.event.job;
    } catch (error) {
      this.#activeJobs.delete(jobId);
      throw error;
    }

    if (this.#activeJobs.get(jobId) === record) {
      this.#startOperation(record, options.execute);
    }
    return initial;
  }

  cancel(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
  ): Readonly<{ cancelled: boolean }> {
    this.#assertOwnerAvailable(owner);
    const record = this.#activeJobs.get(jobId);
    if (!record || record.ownerKey !== ownerKey(owner)) {
      return Object.freeze({ cancelled: false });
    }
    const current = this.#registry.getResourceJob(record.owner, jobId);
    if (
      !current ||
      record.cancelRequested ||
      isTerminalStatus(current.status)
    ) {
      return Object.freeze({ cancelled: false });
    }

    record.cancelRequested = true;
    try {
      this.#publish(record, current, {
        status: "cancelling",
        progress: current.progress,
      });
    } catch (error) {
      record.cancelRequested = false;
      throw error;
    }
    record.controller.abort(
      new Error("The local subtitle resource job was cancelled."),
    );
    return Object.freeze({ cancelled: true });
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    const key = ownerKey(owner);
    if (this.#releasedOwners.has(key)) return;
    this.#registry.assertOwnerActive(owner);
    this.#releasedOwners.add(key);
    for (const [jobId, record] of this.#activeJobs) {
      if (record.ownerKey !== key) continue;
      this.#activeJobs.delete(jobId);
      record.cancelRequested = true;
      record.controller.abort(
        new Error("The local subtitle resource job owner was released."),
      );
    }
    if (this.#sessionRegistryOwnership === "owned") {
      this.#registry.releaseOwner(owner);
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#shuttingDown = true;
    const shutdownOperation = Promise.resolve().then(() => this.waitForIdle());
    this.#shutdownOperation = shutdownOperation;
    const owners = new Map<string, LocalSubtitleOwnerKey>();
    for (const [jobId, record] of this.#activeJobs) {
      owners.set(record.ownerKey, record.owner);
      this.#releasedOwners.add(record.ownerKey);
      this.#activeJobs.delete(jobId);
      record.cancelRequested = true;
      record.controller.abort(
        new Error("The local subtitle resource job manager is shutting down."),
      );
    }
    if (this.#sessionRegistryOwnership === "owned") {
      for (const owner of owners.values()) {
        this.#registry.releaseOwner(owner);
      }
    }
    return shutdownOperation;
  }

  async waitForOwnerIdle(owner: LocalSubtitleOwnerKey): Promise<void> {
    const key = ownerKey(owner);
    await this.#waitForOperations((ownerKeyValue) => ownerKeyValue === key);
  }

  async waitForIdle(): Promise<void> {
    await this.#waitForOperations(() => true);
  }

  #startOperation(
    record: ActiveJobRecord,
    execute: StartLocalSubtitleResourceJobOptions["execute"],
  ): void {
    const context: LocalSubtitleResourceJobContext = Object.freeze({
      signal: record.controller.signal,
      isCancellationRequested: () => record.cancelRequested,
      update: (update: LocalSubtitleResourceJobUpdate) =>
        this.#update(record, update),
    });
    let operation!: Promise<void>;
    operation = Promise.resolve()
      .then(async () => {
        if (this.#activeJobs.get(record.jobId) !== record) return;
        const result = await execute(context);
        if (this.#activeJobs.get(record.jobId) !== record) return;
        this.#settle(record, result ?? { status: "completed" });
      })
      .catch((error: unknown) => {
        this.#settleFailure(record, error);
      })
      .finally(() => {
        if (this.#activeJobs.get(record.jobId) === record) {
          this.#activeJobs.delete(record.jobId);
        }
        this.#operations.delete(operation);
      });
    this.#operations.set(operation, record.ownerKey);
  }

  #update(
    record: ActiveJobRecord,
    update: LocalSubtitleResourceJobUpdate,
  ): LocalSubtitleResourceJobSummary {
    this.#assertRecordCurrent(record);
    if (record.cancelRequested) {
      throw new TypeError("A cancelling resource job cannot publish progress.");
    }
    const current = this.#registry.getResourceJob(record.owner, record.jobId);
    if (!current) throw new TypeError("The resource job is unavailable.");

    const previousCommitStarted = record.commitStarted;
    if (update.status === "committing") record.commitStarted = true;
    try {
      return this.#publish(record, current, update);
    } catch (error) {
      record.commitStarted = previousCommitStarted;
      throw error;
    }
  }

  #publish(
    record: ActiveJobRecord,
    current: LocalSubtitleResourceJobSummary,
    update: {
      readonly status: LocalSubtitleResourceJobStatus;
      readonly progress: number;
      readonly bytesCompleted?: number;
      readonly bytesTotal?: number;
      readonly error?: LocalSubtitleError;
    },
  ): LocalSubtitleResourceJobSummary {
    if (!canTransition(current.status, update.status)) {
      throw new TypeError(
        `Invalid resource job transition: ${current.status} -> ${update.status}.`,
      );
    }
    if (update.progress < current.progress) {
      throw new TypeError("Resource job progress cannot move backwards.");
    }
    const bytesCompleted = update.bytesCompleted ?? current.bytesCompleted;
    const bytesTotal = update.bytesTotal ?? current.bytesTotal;
    if (
      bytesCompleted !== undefined &&
      current.bytesCompleted !== undefined &&
      bytesCompleted < current.bytesCompleted
    ) {
      throw new TypeError("Resource job byte progress cannot move backwards.");
    }
    if (
      update.bytesTotal !== undefined &&
      current.bytesTotal !== undefined &&
      update.bytesTotal !== current.bytesTotal
    ) {
      throw new TypeError("Resource job total bytes cannot change.");
    }

    const envelope = this.#registry.upsertResourceJob(record.owner, {
      jobId: current.jobId,
      resourceId: current.resourceId,
      resourceType: current.resourceType,
      status: update.status,
      progress: update.progress,
      ...(bytesCompleted === undefined ? {} : { bytesCompleted }),
      ...(bytesTotal === undefined ? {} : { bytesTotal }),
      ...(update.error === undefined ? {} : { error: update.error }),
      createdAt: current.createdAt,
      updatedAt: this.#timestamp(),
    });
    if (envelope.event.type !== "resource-job-updated") {
      throw new TypeError("The resource job registry returned an invalid event.");
    }
    return envelope.event.job;
  }

  #settle(
    record: ActiveJobRecord,
    result: LocalSubtitleResourceJobExecutionResult,
  ): void {
    this.#assertRecordCurrent(record);
    const current = this.#registry.getResourceJob(record.owner, record.jobId);
    if (!current) throw new TypeError("The resource job is unavailable.");

    if (result.status === "failed") {
      this.#publish(record, current, {
        status: "failed",
        progress: current.progress,
        error: result.error,
      });
      return;
    }
    if (result.status === "cancelled") {
      if (!record.cancelRequested || current.status !== "cancelling") {
        throw new TypeError("Only a requested cancellation may settle as cancelled.");
      }
      this.#publish(record, current, {
        status: "cancelled",
        progress: current.progress,
      });
      return;
    }

    if (record.cancelRequested && !record.commitStarted) {
      this.#publish(record, current, {
        status: "cancelled",
        progress: current.progress,
      });
      return;
    }
    if (!record.commitStarted) {
      throw new TypeError("A resource job cannot complete before commit begins.");
    }
    this.#publish(record, current, { status: "completed", progress: 100 });
  }

  #settleFailure(record: ActiveJobRecord, error: unknown): void {
    if (this.#activeJobs.get(record.jobId) !== record) return;
    try {
      const current = this.#registry.getResourceJob(record.owner, record.jobId);
      if (!current || isTerminalStatus(current.status)) return;
      if (
        record.cancelRequested &&
        !record.commitStarted &&
        !(error instanceof LocalSubtitleResourceJobExecutionError)
      ) {
        this.#publish(record, current, {
          status: "cancelled",
          progress: current.progress,
        });
        return;
      }
      this.#publish(record, current, {
        status: "failed",
        progress: current.progress,
        error: executionError(error),
      });
    } catch (settlementError) {
      if (
        settlementError instanceof LocalSubtitleSessionRegistryError &&
        settlementError.code === "owner_released"
      ) {
        return;
      }
      // The operation is terminal in the manager even if its owner session vanished.
    }
  }

  #assertRecordCurrent(record: ActiveJobRecord): void {
    if (
      this.#activeJobs.get(record.jobId) !== record ||
      this.#releasedOwners.has(record.ownerKey)
    ) {
      throw new TypeError("The resource job owner is no longer active.");
    }
  }

  #assertOwnerAvailable(owner: LocalSubtitleOwnerKey): void {
    const key = ownerKey(owner);
    if (this.#shuttingDown || this.#releasedOwners.has(key)) {
      throw new LocalSubtitleSessionRegistryError(
        "owner_released",
        "The local subtitle resource job owner is unavailable.",
        "owner",
      );
    }
    this.#registry.assertOwnerActive(owner);
  }

  async #waitForOperations(
    predicate: (ownerKey: string) => boolean,
  ): Promise<void> {
    while (true) {
      const pending = [...this.#operations]
        .filter(([, key]) => predicate(key))
        .map(([operation]) => operation);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  #timestamp(): string {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new TypeError("The local subtitle resource job clock is invalid.");
    }
    return new Date(value).toISOString();
  }
}

function canTransition(
  from: LocalSubtitleResourceJobStatus,
  to: LocalSubtitleResourceJobStatus,
): boolean {
  return (RESOURCE_JOB_TRANSITIONS[from] as readonly string[]).includes(to);
}

function isTerminalStatus(status: LocalSubtitleResourceJobStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function executionError(error: unknown): LocalSubtitleError {
  if (error instanceof LocalSubtitleResourceJobExecutionError) {
    return error.error;
  }
  return createLocalSubtitleError(
    "resource_not_allowed",
    "The local subtitle resource job could not be completed.",
    {
      details: {
        summary: "The background resource operation rejected unexpectedly.",
        truncated: false,
      },
    },
  );
}

function ownerKey(owner: LocalSubtitleOwnerKey): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
}

function validateSessionRegistryOwnership(
  value: unknown,
): LocalSubtitleSessionRegistryOwnership {
  if (value !== "owned" && value !== "shared") {
    throw new TypeError(
      "The local subtitle session registry ownership is invalid.",
    );
  }
  return value;
}
