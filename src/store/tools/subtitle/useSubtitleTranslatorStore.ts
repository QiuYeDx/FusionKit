import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  SubtitleSliceType,
  SubtitleTranslatorTask,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import i18n from "@/i18n";
import * as QueueService from "@/services/subtitle/translatorQueueService";
import type {
  TranslatorQueueState,
  TranslatorQueueEffect,
} from "@/services/subtitle/translatorQueueService";
import {
  startSubtitleTranslation,
  cancelSubtitleTranslation,
} from "@/services/subtitle/translatorExecutionService";

const MAX_CONCURRENCY = 5;

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
  addTask: (task: SubtitleTranslatorTask) => void;
  startTask: (fileName: string) => void;
  retryTask: (fileName: string) => void;
  removeAllResolvedTask: () => void;
  clearAllTasks: () => void;
  startAllTasks: () => void;
  addFailedTask: (errorData: {
    fileName: string;
    error: string;
    message: string;
    errorLogs?: string[];
    timestamp?: string;
    stackTrace?: string;
  }) => void;
  updateTaskCostEstimate: (
    fileName: string,
    costEstimate: SubtitleTranslatorTask["costEstimate"],
  ) => void;
  updateTask: (fileName: string, updates: Partial<SubtitleTranslatorTask>) => void;
  cancelTask: (fileName: string) => void;
  deleteTask: (fileName: string) => void;
  updateProgress: (
    fileName: string,
    resolvedFragments: number,
    totalFragments: number,
    progress: number,
  ) => void;
  markTaskResolved: (fileName: string, outputFilePath: string) => void;
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

function executeEffects(effects: TranslatorQueueEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "start":
        startSubtitleTranslation(effect.task);
        break;
      case "cancel":
        cancelSubtitleTranslation(effect.fileName);
        break;
    }
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

const LEGACY_KEY = "subtitle-translator-output-url";

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
          return;
        }
        set(result.state);
      },

      updateTaskCostEstimate: (fileName, costEstimate) => {
        const result = QueueService.updateTaskCostEstimate(
          getQueueState(get()),
          fileName,
          costEstimate,
        );
        set(result.state);
      },

      startTask: (fileName) => {
        const result = QueueService.startTask(
          getQueueState(get()),
          fileName,
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
      },

      startAllTasks: () => {
        const result = QueueService.startAllTasks(
          getQueueState(get()),
          MAX_CONCURRENCY,
        );
        set(result.state);
        executeEffects(result.effects);
      },

      retryTask: (fileName) => {
        const result = QueueService.retryTask(getQueueState(get()), fileName);
        set(result.state);
      },

      updateTask: (fileName, updates) => {
        const result = QueueService.updateTask(
          getQueueState(get()),
          fileName,
          updates,
        );
        set(result.state);
      },

      removeAllResolvedTask: () => {
        const result = QueueService.removeAllResolvedTasks(getQueueState(get()));
        set(result.state);
      },

      clearAllTasks: () => {
        const result = QueueService.clearTasks(getQueueState(get()));
        set(result.state);
        executeEffects(result.effects);
        showToast(i18n.t("subtitle:translator.infos.all_tasks_cleared"), "success");
      },

      updateProgress: (fileName, resolvedFragments, totalFragments, progress) => {
        console.info(
          ">>> 收到 updateProgress",
          fileName,
          resolvedFragments,
          totalFragments,
          progress,
        );
        const result = QueueService.completeTaskProgress(
          getQueueState(get()),
          { fileName, resolvedFragments, totalFragments, progress },
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

      cancelTask: (fileName) => {
        const queueState = getQueueState(get());
        const result = QueueService.cancelTask(
          queueState,
          fileName,
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

      deleteTask: (fileName) => {
        const result = QueueService.deleteTask(getQueueState(get()), fileName);
        set(result.state);
        showToast(i18n.t("subtitle:translator.infos.task_deleted"), "success");
      },

      markTaskResolved: (fileName, outputFilePath) => {
        const result = QueueService.resolveTask(
          getQueueState(get()),
          fileName,
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
