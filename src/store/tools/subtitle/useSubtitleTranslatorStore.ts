import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  SubtitleSliceType,
  SubtitleTranslatorTask,
  type SubtitleTranslationRecovery,
  type TranslationRecoveryMode,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import i18n from "@/i18n";
import * as QueueService from "@/services/subtitle/translatorQueueService";
import type {
  StartSubtitleTasksReceipt,
  SubtitleTaskStartFailure,
  TranslatorQueueState,
  TranslatorQueueEffect,
} from "@/services/subtitle/translatorQueueService";
import {
  startSubtitleTranslation,
  cancelSubtitleTranslation,
  releaseSubtitleTranslationTaskAuthority,
} from "@/services/subtitle/translatorExecutionService";
import {
  bootstrapLegacySubtitleTranslatorConfig,
} from "./useSubtitleTranslatorConfigStore";
import {
  SubtitleTranslatorImportLedger,
  type AddGeneratedSubtitleTasksRequest,
  type GeneratedSubtitleQueueReceipt,
} from "@/services/subtitle/translatorImportLedger";

const MAX_CONCURRENCY = 5;
const importLedger = new SubtitleTranslatorImportLedger();

interface SubtitleTranslatorStore {
  sliceType: SubtitleSliceType;
  sliceLengthMap: Record<SubtitleSliceType, number>;
  outputURL: string;

  notStartedTaskQueue: SubtitleTranslatorTask[];
  waitingTaskQueue: SubtitleTranslatorTask[];
  pendingTaskQueue: SubtitleTranslatorTask[];
  resolvedTaskQueue: SubtitleTranslatorTask[];
  failedTaskQueue: SubtitleTranslatorTask[];

  setSliceType: (sliceType: SubtitleSliceType) => void;
  setCustomSliceLength: (length: number) => void;
  setOutputURL: (url: string) => void;
  initializeSubtitleTranslatorStore: () => void;
  addTask: (task: SubtitleTranslatorTask) => {
    added: boolean;
    taskId: string;
  };
  addRecoveredTask: (task: SubtitleTranslatorTask) => { added: boolean; reason?: string };
  addRecoveredTasks: (tasks: SubtitleTranslatorTask[]) => {
    addedCount: number;
    skippedCount: number;
    addedTaskIds: string[];
  };
  addImportedTasks: (
    request: AddGeneratedSubtitleTasksRequest,
  ) => GeneratedSubtitleQueueReceipt;
  releaseImportSnapshot: (ownerId: string, snapshotId: string) => void;
  startTask: (taskId: string) => SubtitleTaskStartFailure | undefined;
  startTasks: (taskIds: readonly string[]) => StartSubtitleTasksReceipt;
  retryTask: (taskId: string, mode?: TranslationRecoveryMode) => void;
  removeAllResolvedTask: () => void;
  clearAllTasks: () => void;
  startAllTasks: () => void;
  addFailedTask: (errorData: {
    taskId: string;
    fileName: string;
    error: string;
    message: string;
    errorLogs?: string[];
    timestamp?: string;
    stackTrace?: string;
    recovery?: SubtitleTranslationRecovery;
  }) => void;
  updateTaskCostEstimate: (
    taskId: string,
    costEstimate: SubtitleTranslatorTask["costEstimate"],
  ) => void;
  updateTask: (
    taskId: string,
    updates: Partial<Omit<SubtitleTranslatorTask, "taskId" | "taskReference">>,
  ) => void;
  cancelTask: (taskId: string) => void;
  deleteTask: (taskId: string) => void;
  updateProgress: (
    taskId: string,
    fileName: string,
    resolvedFragments: number,
    totalFragments: number,
    progress: number,
    recovery?: Pick<
      SubtitleTranslationRecovery,
      "checkpointPath" | "completedOutputPath" | "remainingOutputPath"
    >,
  ) => void;
  markTaskResolved: (
    taskId: string,
    fileName: string,
    outputFilePath: string,
  ) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getQueueState(state: SubtitleTranslatorStore): TranslatorQueueState {
  return {
    notStartedTaskQueue: state.notStartedTaskQueue,
    waitingTaskQueue: state.waitingTaskQueue,
    pendingTaskQueue: state.pendingTaskQueue,
    resolvedTaskQueue: state.resolvedTaskQueue,
    failedTaskQueue: state.failedTaskQueue,
  };
}

function allQueueTasks(state: TranslatorQueueState): SubtitleTranslatorTask[] {
  return [
    ...state.notStartedTaskQueue,
    ...state.waitingTaskQueue,
    ...state.pendingTaskQueue,
    ...state.resolvedTaskQueue,
    ...state.failedTaskQueue,
  ];
}

function executeEffects(effects: TranslatorQueueEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "start":
        startSubtitleTranslation(effect.task);
        break;
      case "cancel":
        cancelSubtitleTranslation(effect.taskId);
        break;
    }
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

const LEGACY_KEY = "subtitle-translator-output-url";

try {
  if (globalThis.localStorage) {
    bootstrapLegacySubtitleTranslatorConfig(globalThis.localStorage);
  }
} catch {
  // The source Store stays intact; the config coordinator will fail closed.
}

const useSubtitleTranslatorStore = create<SubtitleTranslatorStore>()(
  persist(
    (set, get) => ({
      sliceType: SubtitleSliceType.NORMAL,
      sliceLengthMap: DEFAULT_SLICE_LENGTH_MAP,
      outputURL: "",
      notStartedTaskQueue: [],
      waitingTaskQueue: [],
      pendingTaskQueue: [],
      resolvedTaskQueue: [],
      failedTaskQueue: [],

      setSliceType: (sliceType) => set({ sliceType }),

      setCustomSliceLength: (length) =>
        set((state) => ({
          sliceLengthMap: {
            ...state.sliceLengthMap,
            [SubtitleSliceType.CUSTOM]: length,
          },
        })),

      setOutputURL: (url) => set({ outputURL: url }),

      initializeSubtitleTranslatorStore: () =>
        set({
          sliceType: SubtitleSliceType.NORMAL,
          sliceLengthMap: DEFAULT_SLICE_LENGTH_MAP,
          notStartedTaskQueue: [],
          waitingTaskQueue: [],
          pendingTaskQueue: [],
          resolvedTaskQueue: [],
          failedTaskQueue: [],
        }),

      addTask: (task) => {
        const result = QueueService.addTask(getQueueState(get()), task);
        if (result.isDuplicate) {
          showToast(
            i18n
              .t("subtitle:translator.errors.duplicate_file")
              .replace("{file}", task.fileName),
            "error",
          );
          return { added: false, taskId: task.taskId };
        }
        set(result.state);
        return { added: true, taskId: task.taskId };
      },

      addRecoveredTask: (task) => {
        const result = QueueService.addRecoveredTask(getQueueState(get()), task);
        if (result.result.added) {
          set(result.state);
        }
        return result.result;
      },

      addRecoveredTasks: (tasks) => {
        const result = QueueService.addRecoveredTasks(getQueueState(get()), tasks);
        set(result.state);
        return {
          addedCount: result.addedCount,
          skippedCount: result.skippedCount,
          addedTaskIds: [...result.addedTaskIds],
        };
      },

      addImportedTasks: (request) => {
        const result = importLedger.addTasks(getQueueState(get()), request);
        if (!result.replayed) set(result.state);
        return result.receipt;
      },

      releaseImportSnapshot: (ownerId, snapshotId) => {
        importLedger.releaseSnapshot(ownerId, snapshotId);
      },

      updateTaskCostEstimate: (taskId, costEstimate) => {
        const result = QueueService.updateTaskCostEstimate(
          getQueueState(get()),
          taskId,
          costEstimate,
        );
        set(result.state);
      },

      startTask: (taskId) => {
        const result = QueueService.startTask(
          getQueueState(get()),
          taskId,
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
        return result.startFailures[0];
      },

      startTasks: (taskIds) => {
        const result = QueueService.startTasks(
          getQueueState(get()),
          taskIds,
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
        return result.receipt;
      },

      startAllTasks: () => {
        const result = QueueService.startAllTasks(
          getQueueState(get()),
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
      },

      retryTask: (taskId, mode = "resume") => {
        const result = QueueService.retryTask(
          getQueueState(get()),
          taskId,
          mode,
        );
        set(result.state);
      },

      updateTask: (taskId, updates) => {
        const result = QueueService.updateTask(
          getQueueState(get()),
          taskId,
          updates,
        );
        set(result.state);
      },

      removeAllResolvedTask: () => {
        const queueState = getQueueState(get());
        for (const task of queueState.resolvedTaskQueue) {
          if (task.taskReference) {
            releaseSubtitleTranslationTaskAuthority(task.taskId);
          }
        }
        const result = QueueService.removeAllResolvedTasks(queueState);
        set(result.state);
      },

      clearAllTasks: () => {
        const queueState = getQueueState(get());
        for (const task of allQueueTasks(queueState)) {
          if (task.taskReference) {
            releaseSubtitleTranslationTaskAuthority(task.taskId);
          }
        }
        const result = QueueService.clearTasks(queueState);
        set(result.state);
        executeEffects(result.effects);
        showToast(i18n.t("subtitle:translator.infos.all_tasks_cleared"), "success");
      },

      updateProgress: (
        taskId,
        fileName,
        resolvedFragments,
        totalFragments,
        progress,
        recovery,
      ) => {
        const result = QueueService.completeTaskProgress(
          getQueueState(get()),
          {
            taskId,
            fileName,
            resolvedFragments,
            totalFragments,
            progress,
            recovery,
          },
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
      },

      addFailedTask: (errorData) => {
        const queueState = getQueueState(get());
        const result = QueueService.failTask(
          queueState,
          errorData,
          MAX_CONCURRENCY,
        );
        if (result.state === queueState) return;

        set(result.state);
        executeEffects(result.effects);
        showToast(`${errorData.message}`, "error");
      },

      cancelTask: (taskId) => {
        const queueState = getQueueState(get());
        const result = QueueService.cancelTask(
          queueState,
          taskId,
          i18n.t("subtitle:translator.infos.task_canceled"),
          MAX_CONCURRENCY,
        );
        if (result.state === queueState) return;

        set(result.state);
        executeEffects(result.effects);
        showToast(
          i18n.t("subtitle:translator.infos.task_cancel_toast"),
          "success",
        );
      },

      deleteTask: (taskId) => {
        const queueState = getQueueState(get());
        const task = allQueueTasks(queueState)
          .find((candidate) => candidate.taskId === taskId);
        if (task?.taskReference) {
          releaseSubtitleTranslationTaskAuthority(taskId);
        }
        const result = QueueService.deleteTask(queueState, taskId);
        set(result.state);
        executeEffects(result.effects);
        showToast(i18n.t("subtitle:translator.infos.task_deleted"), "success");
      },

      markTaskResolved: (taskId, _fileName, outputFilePath) => {
        const result = QueueService.resolveTask(
          getQueueState(get()),
          taskId,
          outputFilePath,
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
      },
    }),
    {
      name: "fusionkit-subtitle-translator",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ outputURL: state.outputURL }),
      onRehydrateStorage: () => {
        if (
          localStorage.getItem(LEGACY_KEY) !== null &&
          localStorage.getItem("fusionkit-subtitle-translator") === null
        ) {
          const saved = localStorage.getItem(LEGACY_KEY) || "";
          localStorage.setItem(
            "fusionkit-subtitle-translator",
            JSON.stringify({ state: { outputURL: saved }, version: 0 }),
          );
          localStorage.removeItem(LEGACY_KEY);
        }
      },
    },
  ),
);

export default useSubtitleTranslatorStore;
