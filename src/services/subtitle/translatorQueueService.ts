import { cloneDeep } from "lodash";
import {
  SubtitleTranslatorTask,
  TaskStatus,
  type SubtitleTranslationRecovery,
  type TranslationRecoveryMode,
} from "@/type/subtitle";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TranslatorQueueState {
  notStartedTaskQueue: SubtitleTranslatorTask[];
  waitingTaskQueue: SubtitleTranslatorTask[];
  pendingTaskQueue: SubtitleTranslatorTask[];
  resolvedTaskQueue: SubtitleTranslatorTask[];
  failedTaskQueue: SubtitleTranslatorTask[];
}

export type TranslatorQueueEffect =
  | { type: "start"; task: SubtitleTranslatorTask }
  | { type: "cancel"; fileName: string };

export interface TranslatorQueueResult {
  state: TranslatorQueueState;
  effects: TranslatorQueueEffect[];
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function promoteWaitingTaskIfSlotAvailable(
  state: TranslatorQueueState,
  maxConcurrency: number,
): TranslatorQueueResult {
  if (
    state.waitingTaskQueue.length > 0 &&
    state.pendingTaskQueue.length < maxConcurrency
  ) {
    const waitingTask = state.waitingTaskQueue[0];
    const promoted = { ...waitingTask, status: TaskStatus.PENDING };
    return {
      state: {
        ...state,
        waitingTaskQueue: state.waitingTaskQueue.slice(1),
        pendingTaskQueue: [...state.pendingTaskQueue, promoted],
      },
      effects: [{ type: "start", task: promoted }],
    };
  }
  return { state, effects: [] };
}

function mergeIntoResolved(
  resolvedQueue: SubtitleTranslatorTask[],
  task: SubtitleTranslatorTask,
): SubtitleTranslatorTask[] {
  const existing = resolvedQueue.find((t) => t.fileName === task.fileName);
  if (existing) {
    return resolvedQueue.map((t) =>
      t.fileName === task.fileName
        ? {
            ...t,
            ...task,
            extraInfo: { ...(t.extraInfo || {}), ...(task.extraInfo || {}) },
          }
        : t,
    );
  }
  return [...resolvedQueue, task];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function addTask(
  state: TranslatorQueueState,
  task: SubtitleTranslatorTask,
): TranslatorQueueResult & { isDuplicate: boolean } {
  const allTasks = [
    ...state.notStartedTaskQueue,
    ...state.waitingTaskQueue,
    ...state.pendingTaskQueue,
    ...state.resolvedTaskQueue,
    ...state.failedTaskQueue,
  ];

  if (allTasks.some((t) => t.fileName === task.fileName)) {
    return { state, effects: [], isDuplicate: true };
  }

  return {
    state: {
      ...state,
      notStartedTaskQueue: [...state.notStartedTaskQueue, task],
    },
    effects: [],
    isDuplicate: false,
  };
}

export function updateTaskCostEstimate(
  state: TranslatorQueueState,
  fileName: string,
  costEstimate: SubtitleTranslatorTask["costEstimate"],
): TranslatorQueueResult {
  const patch = (queue: SubtitleTranslatorTask[]) =>
    queue.map((t) => (t.fileName === fileName ? { ...t, costEstimate } : t));

  return {
    state: {
      notStartedTaskQueue: patch(state.notStartedTaskQueue),
      waitingTaskQueue: patch(state.waitingTaskQueue),
      pendingTaskQueue: patch(state.pendingTaskQueue),
      resolvedTaskQueue: patch(state.resolvedTaskQueue),
      failedTaskQueue: patch(state.failedTaskQueue),
    },
    effects: [],
  };
}

export function startTask(
  state: TranslatorQueueState,
  fileName: string,
  maxConcurrency: number,
): TranslatorQueueResult {
  const task = state.notStartedTaskQueue.find((t) => t.fileName === fileName);
  if (!task) return { state, effects: [] };

  const remaining = state.notStartedTaskQueue.filter(
    (t) => t.fileName !== fileName,
  );

  if (state.pendingTaskQueue.length < maxConcurrency) {
    const started = { ...task, status: TaskStatus.PENDING };
    return {
      state: {
        ...state,
        notStartedTaskQueue: remaining,
        pendingTaskQueue: [...state.pendingTaskQueue, started],
      },
      effects: [{ type: "start", task: started }],
    };
  }

  const waiting = { ...task, status: TaskStatus.WAITING };
  return {
    state: {
      ...state,
      notStartedTaskQueue: remaining,
      waitingTaskQueue: [...state.waitingTaskQueue, waiting],
    },
    effects: [],
  };
}

export function startAllTasks(
  state: TranslatorQueueState,
  maxConcurrency: number,
): TranslatorQueueResult {
  const slotsAvailable = Math.max(
    0,
    maxConcurrency - state.pendingTaskQueue.length,
  );

  const tasksToStart = state.notStartedTaskQueue.slice(0, slotsAvailable);
  const tasksToWait = state.notStartedTaskQueue.slice(slotsAvailable);

  const started = tasksToStart.map((t) => ({
    ...t,
    status: TaskStatus.PENDING,
  }));
  const waiting = tasksToWait.map((t) => ({
    ...t,
    status: TaskStatus.WAITING,
  }));

  return {
    state: {
      ...state,
      notStartedTaskQueue: [],
      waitingTaskQueue: [...state.waitingTaskQueue, ...waiting],
      pendingTaskQueue: [...state.pendingTaskQueue, ...started],
    },
    effects: started.map((task) => ({ type: "start" as const, task })),
  };
}

/**
 * 重试失败任务。
 *   - mode "resume"（默认）: 保留 recovery 信息，续跑时只翻译未完成分片
 *   - mode "restart": 清空 recovery，进度归零，完全重新翻译
 */
export function retryTask(
  state: TranslatorQueueState,
  fileName: string,
  mode: TranslationRecoveryMode = "resume",
): TranslatorQueueResult {
  const task = state.failedTaskQueue.find((t) => t.fileName === fileName);
  if (!task) return { state, effects: [] };

  const isResume = mode !== "restart";

  const reset = cloneDeep({
    ...task,
    status: TaskStatus.NOT_STARTED,
    progress: isResume ? task.progress : 0,
    resolvedFragments: isResume ? task.resolvedFragments : 0,
    totalFragments: isResume ? task.totalFragments : undefined,
    recovery: isResume ? task.recovery : undefined,
    recoveryMode: mode,
    checkpointPath: isResume ? task.recovery?.checkpointPath : undefined,
  });

  return {
    state: {
      ...state,
      failedTaskQueue: state.failedTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
      notStartedTaskQueue: [...state.notStartedTaskQueue, reset],
    },
    effects: [],
  };
}

export function updateTask(
  state: TranslatorQueueState,
  fileName: string,
  updates: Partial<SubtitleTranslatorTask>,
): TranslatorQueueResult {
  return {
    state: {
      ...state,
      notStartedTaskQueue: state.notStartedTaskQueue.map((t) =>
        t.fileName === fileName ? { ...t, ...updates } : t,
      ),
      failedTaskQueue: state.failedTaskQueue.map((t) =>
        t.fileName === fileName ? { ...t, ...updates } : t,
      ),
    },
    effects: [],
  };
}

/**
 * Handle progress updates from the main process.
 * When resolvedFragments === totalFragments the task is moved to resolved and
 * a waiting task is promoted if a slot opens up.
 *
 * payload.recovery 携带 checkpoint 路径，patch 到任务上以供续跑使用。
 */
export function completeTaskProgress(
  state: TranslatorQueueState,
  payload: {
    fileName: string;
    resolvedFragments: number;
    totalFragments: number;
    progress: number;
    recovery?: Pick<
      SubtitleTranslationRecovery,
      "checkpointPath" | "completedOutputPath" | "remainingOutputPath"
    >;
  },
  maxConcurrency: number,
): TranslatorQueueResult {
  const { fileName, resolvedFragments, totalFragments, progress, recovery } =
    payload;
  const task = state.pendingTaskQueue.find((t) => t.fileName === fileName);
  if (!task) return { state, effects: [] };

  if (resolvedFragments === totalFragments) {
    const completed: SubtitleTranslatorTask = {
      ...task,
      costEstimate: task.costEstimate
        ? { ...task.costEstimate, fragmentCount: totalFragments }
        : task.costEstimate,
      resolvedFragments,
      totalFragments,
      progress: 100,
      status: TaskStatus.RESOLVED,
    };

    const remainingPending = state.pendingTaskQueue.filter(
      (t) => t.fileName !== fileName,
    );
    const nextResolved = mergeIntoResolved(state.resolvedTaskQueue, completed);

    return promoteWaitingTaskIfSlotAvailable(
      {
        ...state,
        pendingTaskQueue: remainingPending,
        resolvedTaskQueue: nextResolved,
      },
      maxConcurrency,
    );
  }

  const recoveryPatch: Partial<SubtitleTranslatorTask> = recovery
    ? {
        recovery: {
          ...(task.recovery || {}),
          ...recovery,
        },
      }
    : {};

  return {
    state: {
      ...state,
      pendingTaskQueue: state.pendingTaskQueue.map((t) =>
        t.fileName === fileName
          ? {
              ...t,
              costEstimate: t.costEstimate
                ? { ...t.costEstimate, fragmentCount: totalFragments }
                : t.costEstimate,
              resolvedFragments,
              totalFragments,
              progress,
              ...recoveryPatch,
            }
          : t,
      ),
    },
    effects: [],
  };
}

/**
 * Mark a task as resolved (triggered by `task-resolved` IPC event).
 * If the task is still in pending it gets moved; if it's already in resolved
 * only the outputFilePath is patched.
 */
export function resolveTask(
  state: TranslatorQueueState,
  fileName: string,
  outputFilePath: string,
  maxConcurrency: number,
): TranslatorQueueResult {
  const pendingTask = state.pendingTaskQueue.find(
    (t) => t.fileName === fileName,
  );

  if (pendingTask) {
    const resolved: SubtitleTranslatorTask = {
      ...pendingTask,
      status: TaskStatus.RESOLVED,
      progress: 100,
      extraInfo: { ...(pendingTask.extraInfo || {}), outputFilePath },
    };

    const remainingPending = state.pendingTaskQueue.filter(
      (t) => t.fileName !== fileName,
    );
    const nextResolved = mergeIntoResolved(state.resolvedTaskQueue, resolved);

    return promoteWaitingTaskIfSlotAvailable(
      { ...state, pendingTaskQueue: remainingPending, resolvedTaskQueue: nextResolved },
      maxConcurrency,
    );
  }

  const existingResolved = state.resolvedTaskQueue.find(
    (t) => t.fileName === fileName,
  );
  if (existingResolved) {
    return {
      state: {
        ...state,
        resolvedTaskQueue: state.resolvedTaskQueue.map((t) =>
          t.fileName === fileName
            ? { ...t, extraInfo: { ...(t.extraInfo || {}), outputFilePath } }
            : t,
        ),
      },
      effects: [],
    };
  }

  return { state, effects: [] };
}

/**
 * Move a task from pending to failed. After removal the waiting queue is
 * checked — this fixes the original bug where a full-capacity failure didn't
 * promote a waiting task because the length check happened before removal.
 *
 * errorData.recovery 来自主进程 task-failed 事件，保存到任务上供续跑使用。
 */
export function failTask(
  state: TranslatorQueueState,
  errorData: {
    fileName: string;
    error: string;
    message: string;
    errorLogs?: string[];
    timestamp?: string;
    stackTrace?: string;
    recovery?: SubtitleTranslationRecovery;
  },
  maxConcurrency: number,
): TranslatorQueueResult {
  const task = state.pendingTaskQueue.find(
    (t) => t.fileName === errorData.fileName,
  );
  if (!task) return { state, effects: [] };

  const failed: SubtitleTranslatorTask = {
    ...task,
    status: TaskStatus.FAILED,
    errorLog: errorData.errorLogs || [],
    recovery: errorData.recovery,
    resolvedFragments: errorData.recovery?.resolvedFragments ?? task.resolvedFragments,
    totalFragments: errorData.recovery?.totalFragments ?? task.totalFragments,
    extraInfo: {
      error: errorData.error,
      message: errorData.message,
      timestamp: errorData.timestamp,
      stackTrace: errorData.stackTrace,
      errorLogs: errorData.errorLogs || [],
    },
  };

  const remainingPending = state.pendingTaskQueue.filter(
    (t) => t.fileName !== errorData.fileName,
  );

  return promoteWaitingTaskIfSlotAvailable(
    {
      ...state,
      pendingTaskQueue: remainingPending,
      failedTaskQueue: [...state.failedTaskQueue, failed],
    },
    maxConcurrency,
  );
}

export function cancelTask(
  state: TranslatorQueueState,
  fileName: string,
  cancelMessage: string,
  maxConcurrency: number,
): TranslatorQueueResult {
  const task = state.pendingTaskQueue.find((t) => t.fileName === fileName);
  if (!task) {
    const waitingTask = state.waitingTaskQueue.find(
      (t) => t.fileName === fileName,
    );
    if (!waitingTask) return { state, effects: [] };

    return {
      state: {
        ...state,
        waitingTaskQueue: state.waitingTaskQueue.filter(
          (t) => t.fileName !== fileName,
        ),
        failedTaskQueue: [
          ...state.failedTaskQueue,
          {
            ...waitingTask,
            status: TaskStatus.FAILED,
            extraInfo: { error: "CANCELED", message: cancelMessage },
          },
        ],
      },
      effects: [],
    };
  }

  const canceled: SubtitleTranslatorTask = {
    ...task,
    status: TaskStatus.FAILED,
    extraInfo: { error: "CANCELED", message: cancelMessage },
  };

  const remainingPending = state.pendingTaskQueue.filter(
    (t) => t.fileName !== fileName,
  );

  const promotion = promoteWaitingTaskIfSlotAvailable(
    {
      ...state,
      pendingTaskQueue: remainingPending,
      failedTaskQueue: [...state.failedTaskQueue, canceled],
    },
    maxConcurrency,
  );

  return {
    ...promotion,
    effects: [{ type: "cancel", fileName }, ...promotion.effects],
  };
}

export function deleteTask(
  state: TranslatorQueueState,
  fileName: string,
): TranslatorQueueResult {
  return {
    state: {
      notStartedTaskQueue: state.notStartedTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
      waitingTaskQueue: state.waitingTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
      pendingTaskQueue: state.pendingTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
      resolvedTaskQueue: state.resolvedTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
      failedTaskQueue: state.failedTaskQueue.filter(
        (t) => t.fileName !== fileName,
      ),
    },
    effects: [],
  };
}

export function clearTasks(
  state: TranslatorQueueState,
): TranslatorQueueResult {
  const effects: TranslatorQueueEffect[] = state.pendingTaskQueue.map(
    (task) => ({ type: "cancel" as const, fileName: task.fileName }),
  );

  return {
    state: {
      notStartedTaskQueue: [],
      waitingTaskQueue: [],
      pendingTaskQueue: [],
      resolvedTaskQueue: [],
      failedTaskQueue: [],
    },
    effects,
  };
}

export function removeAllResolvedTasks(
  state: TranslatorQueueState,
): TranslatorQueueResult {
  return {
    state: { ...state, resolvedTaskQueue: [] },
    effects: [],
  };
}
