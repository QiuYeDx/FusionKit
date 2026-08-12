import {
  classifyLocalSubtitleTaskEvent,
  deriveLocalSubtitleBatchStatus,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
} from "@/type/localSubtitle";

export type LocalSubtitleSessionEvent =
  | {
      readonly kind: "task";
      readonly envelope: LocalSubtitleTaskEventEnvelope;
    }
  | {
      readonly kind: "resource";
      readonly envelope: LocalSubtitleResourceEventEnvelope;
    };

export interface LocalSubtitleSessionReducerState {
  readonly revision: number;
  readonly batches: readonly LocalSubtitleBatchSummary[];
  readonly resourceJobs: readonly LocalSubtitleResourceJobSummary[];
  readonly maxGenerationByTaskKey: ReadonlyMap<string, number>;
  readonly taskTombstones: ReadonlyMap<string, number>;
  readonly resourceTombstones: ReadonlyMap<string, number>;
}

export interface LocalSubtitleSessionReduceResult {
  readonly state: LocalSubtitleSessionReducerState;
  readonly applied: boolean;
  readonly needsSnapshot: boolean;
  readonly reason?:
    | "duplicate_revision"
    | "stale_revision"
    | "stale_generation"
    | "revision_gap"
    | "unknown_batch"
    | "task_tombstone"
    | "resource_tombstone";
}

export type LocalSubtitleSnapshotMergeResult =
  | {
      readonly accepted: true;
      readonly state: LocalSubtitleSessionReducerState;
    }
  | {
      readonly accepted: false;
      readonly state: LocalSubtitleSessionReducerState;
      readonly reason:
        | "stale_snapshot"
        | "generation_regression"
        | "resource_resurrection";
    };

export function createLocalSubtitleSessionReducerState(): LocalSubtitleSessionReducerState {
  return {
    revision: 0,
    batches: [],
    resourceJobs: [],
    maxGenerationByTaskKey: new Map(),
    taskTombstones: new Map(),
    resourceTombstones: new Map(),
  };
}

export function mergeLocalSubtitleSessionSnapshot(
  current: LocalSubtitleSessionReducerState,
  snapshot: LocalSubtitleSessionSnapshot,
): LocalSubtitleSnapshotMergeResult {
  if (snapshot.revision < current.revision) {
    return { accepted: false, state: current, reason: "stale_snapshot" };
  }

  for (const batch of snapshot.batches) {
    for (const task of batch.tasks) {
      const key = localSubtitleTaskKey(batch.batchId, task.taskId);
      const maxGeneration = current.maxGenerationByTaskKey.get(key) ?? 0;
      const tombstoneGeneration = current.taskTombstones.get(key) ?? 0;
      if (task.generation < maxGeneration || task.generation <= tombstoneGeneration) {
        return {
          accepted: false,
          state: current,
          reason: "generation_regression",
        };
      }
    }
  }
  if (
    snapshot.resourceJobs.some((job) =>
      current.resourceTombstones.has(job.jobId),
    )
  ) {
    return { accepted: false, state: current, reason: "resource_resurrection" };
  }

  const maxGenerationByTaskKey = new Map(current.maxGenerationByTaskKey);
  const taskTombstones = new Map(current.taskTombstones);
  const resourceTombstones = new Map(current.resourceTombstones);
  const incomingTaskKeys = new Set<string>();
  const incomingResourceJobIds = new Set(
    snapshot.resourceJobs.map((job) => job.jobId),
  );

  for (const batch of snapshot.batches) {
    for (const task of batch.tasks) {
      const key = localSubtitleTaskKey(batch.batchId, task.taskId);
      incomingTaskKeys.add(key);
      maxGenerationByTaskKey.set(
        key,
        Math.max(maxGenerationByTaskKey.get(key) ?? 0, task.generation),
      );
      if ((taskTombstones.get(key) ?? 0) < task.generation) {
        taskTombstones.delete(key);
      }
    }
  }

  for (const batch of current.batches) {
    for (const task of batch.tasks) {
      const key = localSubtitleTaskKey(batch.batchId, task.taskId);
      if (incomingTaskKeys.has(key)) continue;
      const generation = Math.max(
        task.generation,
        maxGenerationByTaskKey.get(key) ?? 0,
      );
      maxGenerationByTaskKey.set(key, generation);
      taskTombstones.set(
        key,
        Math.max(taskTombstones.get(key) ?? 0, generation),
      );
    }
  }
  for (const [key, generation] of maxGenerationByTaskKey) {
    if (incomingTaskKeys.has(key)) continue;
    taskTombstones.set(
      key,
      Math.max(taskTombstones.get(key) ?? 0, generation),
    );
  }
  for (const job of current.resourceJobs) {
    if (!incomingResourceJobIds.has(job.jobId)) {
      resourceTombstones.set(job.jobId, snapshot.revision);
    }
  }

  return {
    accepted: true,
    state: {
      revision: snapshot.revision,
      batches: snapshot.batches.map((batch) => ({
        ...batch,
        tasks: [...batch.tasks],
      })),
      resourceJobs: [...snapshot.resourceJobs],
      maxGenerationByTaskKey,
      taskTombstones,
      resourceTombstones,
    },
  };
}

export function reduceLocalSubtitleSessionEvent(
  current: LocalSubtitleSessionReducerState,
  event: LocalSubtitleSessionEvent,
): LocalSubtitleSessionReduceResult {
  return event.kind === "task"
    ? reduceTaskEvent(current, event.envelope)
    : reduceResourceEvent(current, event.envelope);
}

export function localSubtitleTaskKey(batchId: string, taskId: string): string {
  return `${batchId}:${taskId}`;
}

function reduceTaskEvent(
  current: LocalSubtitleSessionReducerState,
  envelope: LocalSubtitleTaskEventEnvelope,
): LocalSubtitleSessionReduceResult {
  const key = localSubtitleTaskKey(envelope.batchId, envelope.taskId);
  const maxGeneration = current.maxGenerationByTaskKey.get(key);
  const tombstoneGeneration = current.taskTombstones.get(key);
  const revisionGap = envelope.revision > current.revision + 1;

  if (
    tombstoneGeneration !== undefined &&
    envelope.generation <= tombstoneGeneration &&
    envelope.revision > current.revision
  ) {
    if (revisionGap) {
      return unchanged(current, true, "task_tombstone");
    }
    return advancedOnly(current, envelope.revision, "task_tombstone");
  }

  const decision = classifyLocalSubtitleTaskEvent(
    { revision: current.revision, generation: maxGeneration },
    envelope,
  );
  if (decision.action === "ignore") {
    if (decision.advanceRevision) {
      return advancedOnly(current, envelope.revision, decision.reason);
    }
    return unchanged(current, decision.needsSnapshot, decision.reason);
  }

  const maxGenerationByTaskKey = new Map(current.maxGenerationByTaskKey);
  maxGenerationByTaskKey.set(
    key,
    Math.max(maxGenerationByTaskKey.get(key) ?? 0, envelope.generation),
  );
  const taskTombstones = new Map(current.taskTombstones);

  if (envelope.event.type === "task-removed") {
    const removedAt = envelope.event.removedAt;
    taskTombstones.set(
      key,
      Math.max(taskTombstones.get(key) ?? 0, envelope.generation),
    );
    const batches = current.batches.flatMap((batch) => {
      if (batch.batchId !== envelope.batchId) return [batch];
      const tasks = batch.tasks.filter((task) => task.taskId !== envelope.taskId);
      if (tasks.length === 0) return [];
      return [
        {
          ...batch,
          status: deriveLocalSubtitleBatchStatus(tasks),
          tasks,
          updatedAt: removedAt,
        },
      ];
    });
    return {
      state: {
        ...current,
        revision: envelope.revision,
        batches,
        maxGenerationByTaskKey,
        taskTombstones,
      },
      applied: true,
      needsSnapshot: decision.needsSnapshot,
      ...(decision.needsSnapshot ? { reason: "revision_gap" as const } : {}),
    };
  }

  const batchIndex = current.batches.findIndex(
    (batch) => batch.batchId === envelope.batchId,
  );
  if (batchIndex < 0) {
    return {
      state: {
        ...current,
        revision: envelope.revision,
        maxGenerationByTaskKey,
      },
      applied: false,
      needsSnapshot: true,
      reason: "unknown_batch",
    };
  }

  if ((taskTombstones.get(key) ?? 0) < envelope.generation) {
    taskTombstones.delete(key);
  }
  const batches = [...current.batches];
  const batch = batches[batchIndex]!;
  const taskIndex = batch.tasks.findIndex(
    (task) => task.taskId === envelope.taskId,
  );
  const tasks = [...batch.tasks];
  if (taskIndex < 0) tasks.push(envelope.event.task);
  else tasks[taskIndex] = envelope.event.task;
  batches[batchIndex] = {
    ...batch,
    status: deriveLocalSubtitleBatchStatus(tasks),
    tasks,
    updatedAt: envelope.event.task.updatedAt,
  };
  return {
    state: {
      ...current,
      revision: envelope.revision,
      batches,
      maxGenerationByTaskKey,
      taskTombstones,
    },
    applied: true,
    needsSnapshot: decision.needsSnapshot,
    ...(decision.needsSnapshot ? { reason: "revision_gap" as const } : {}),
  };
}

function reduceResourceEvent(
  current: LocalSubtitleSessionReducerState,
  envelope: LocalSubtitleResourceEventEnvelope,
): LocalSubtitleSessionReduceResult {
  if (envelope.revision === current.revision) {
    return unchanged(current, false, "duplicate_revision");
  }
  if (envelope.revision < current.revision) {
    return unchanged(current, false, "stale_revision");
  }
  const revisionGap = envelope.revision > current.revision + 1;
  const jobId =
    envelope.event.type === "resource-job-updated"
      ? envelope.event.job.jobId
      : envelope.event.jobId;
  if (
    envelope.event.type === "resource-job-updated" &&
    current.resourceTombstones.has(jobId)
  ) {
    if (revisionGap) {
      return unchanged(current, true, "resource_tombstone");
    }
    return advancedOnly(current, envelope.revision, "resource_tombstone");
  }

  const resourceTombstones = new Map(current.resourceTombstones);
  let resourceJobs: readonly LocalSubtitleResourceJobSummary[];
  if (envelope.event.type === "resource-job-removed") {
    resourceTombstones.set(jobId, envelope.revision);
    resourceJobs = current.resourceJobs.filter((job) => job.jobId !== jobId);
  } else {
    const jobIndex = current.resourceJobs.findIndex((job) => job.jobId === jobId);
    const nextJobs = [...current.resourceJobs];
    if (jobIndex < 0) nextJobs.push(envelope.event.job);
    else nextJobs[jobIndex] = envelope.event.job;
    resourceJobs = nextJobs;
  }
  return {
    state: {
      ...current,
      revision: envelope.revision,
      resourceJobs,
      resourceTombstones,
    },
    applied: true,
    needsSnapshot: revisionGap,
    ...(revisionGap ? { reason: "revision_gap" as const } : {}),
  };
}

function advancedOnly(
  current: LocalSubtitleSessionReducerState,
  revision: number,
  reason: NonNullable<LocalSubtitleSessionReduceResult["reason"]>,
): LocalSubtitleSessionReduceResult {
  return {
    state: { ...current, revision },
    applied: false,
    needsSnapshot: false,
    reason,
  };
}

function unchanged(
  current: LocalSubtitleSessionReducerState,
  needsSnapshot: boolean,
  reason: NonNullable<LocalSubtitleSessionReduceResult["reason"]>,
): LocalSubtitleSessionReduceResult {
  return { state: current, applied: false, needsSnapshot, reason };
}
