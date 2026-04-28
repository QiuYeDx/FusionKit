import { create } from "zustand";
import { persist as persistMiddleware, createJSONStorage } from "zustand/middleware";
import {
  ExtractKeepLanguage,
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleExtractorTask,
  SubtitleFileType,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import { showSystemNotification } from "@/utils/notification";
import i18n from "@/i18n";

const LEGACY_KEYS = {
  outputURL: "subtitle-extractor-output-url",
  outputMode: "subtitle-extractor-output-mode",
  conflictPolicy: "subtitle-extractor-conflict-policy",
};

// ---------------------------------------------------------------------------
// Store 类型
// ---------------------------------------------------------------------------

interface SubtitleExtractorStore {
  // 配置
  keep: ExtractKeepLanguage;
  outputURL: string;
  outputMode: OutputPathMode;
  conflictPolicy: OutputConflictPolicy;

  // 任务队列
  notStartedTasks: SubtitleExtractorTask[];
  pendingTasks: SubtitleExtractorTask[];
  resolvedTasks: SubtitleExtractorTask[];
  failedTasks: SubtitleExtractorTask[];

  // 配置方法
  setKeep: (keep: ExtractKeepLanguage) => void;
  setOutputURL: (url: string) => void;
  setOutputMode: (mode: OutputPathMode) => void;
  setConflictPolicy: (policy: OutputConflictPolicy) => void;

  // 任务方法
  addTask: (task: SubtitleExtractorTask) => void;
  startTask: (fileName: string) => void;
  startAllTasks: () => void;
  retryTask: (fileName: string) => void;
  deleteTask: (fileName: string) => void;
  updateTask: (fileName: string, updates: Partial<SubtitleExtractorTask>) => void;
  removeAllResolvedTasks: () => void;
  clearAllTasks: () => void;
  initializeStore: () => void;
}

// ---------------------------------------------------------------------------
// Store 实现
// ---------------------------------------------------------------------------

const useSubtitleExtractorStore = create<SubtitleExtractorStore>()(
  persistMiddleware(
    (set, get) => ({
    keep: "ZH",
    outputURL: "",
    outputMode: "custom" as OutputPathMode,
    conflictPolicy: "index" as OutputConflictPolicy,

    // 任务队列
    notStartedTasks: [],
    pendingTasks: [],
    resolvedTasks: [],
    failedTasks: [],

    // ---- 配置 setter ----

    setKeep: (keep) => set({ keep }),

    setOutputURL: (url) => {
      set({ outputURL: url });
    },

    setOutputMode: (mode) => {
      set({ outputMode: mode });
    },

    setConflictPolicy: (policy) => {
      set({ conflictPolicy: policy });
    },

    // ---- 任务操作 ----

    addTask: (task) =>
      set((state) => {
        const allTasks = [
          ...state.notStartedTasks,
          ...state.pendingTasks,
          ...state.resolvedTasks,
          ...state.failedTasks,
        ];
        if (allTasks.some((t) => t.fileName === task.fileName)) {
          showToast(
            i18n.t("subtitle:extractor:errors.duplicate_file").replace("{file}", task.fileName),
            "error"
          );
          return state;
        }
        return { notStartedTasks: [...state.notStartedTasks, task] };
      }),

    startTask: (fileName) => {
      const state = get();
      const task = state.notStartedTasks.find((t) => t.fileName === fileName);
      if (!task) return;

      set({
        notStartedTasks: state.notStartedTasks.filter(
          (t) => t.fileName !== fileName
        ),
        pendingTasks: [
          ...state.pendingTasks,
          { ...task, status: TaskStatus.PENDING, progress: 10 },
        ],
      });

      const { conflictPolicy } = get();

      window.ipcRenderer
        .invoke("extract-subtitle-language", {
          fileName: task.fileName,
          fileContent: task.fileContent,
          fileType: task.fileType,
          keep: task.keep,
          outputDir: task.targetFileURL,
          conflictPolicy: task.conflictPolicy ?? conflictPolicy,
        })
        .then((res: any) => {
          set((s) => {
            if (!s.pendingTasks.some((t) => t.fileName === fileName)) return s;
            return {
              pendingTasks: s.pendingTasks.filter(
                (t) => t.fileName !== fileName
              ),
              resolvedTasks: [
                ...s.resolvedTasks,
                {
                  ...task,
                  status: TaskStatus.RESOLVED,
                  progress: 100,
                  outputFilePath: res?.outputFilePath,
                },
              ],
            };
          });
          showToast(
            i18n
              .t("subtitle:extractor:infos.task_extract_done")
              .replace("{file}", fileName),
            "success"
          );
          showSystemNotification(
            "FusionKit",
            i18n.t("setting:fields.notification.task_resolved", {
              file: fileName,
            })
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          set((s) => {
            if (!s.pendingTasks.some((t) => t.fileName === fileName)) return s;
            return {
              pendingTasks: s.pendingTasks.filter(
                (t) => t.fileName !== fileName
              ),
              failedTasks: [
                ...s.failedTasks,
                {
                  ...task,
                  status: TaskStatus.FAILED,
                  progress: 0,
                  extraInfo: { message, error },
                },
              ],
            };
          });
          showToast(
            i18n
              .t("subtitle:extractor:errors.task_extract_failed")
              .replace("{file}", fileName),
            "error"
          );
          showSystemNotification(
            "FusionKit",
            i18n.t("setting:fields.notification.task_failed", {
              file: fileName,
            })
          );
        });
    },

    startAllTasks: () => {
      const { notStartedTasks, startTask } = get();
      const fileNames = notStartedTasks.map((t) => t.fileName);

      async function runSequentially() {
        for (const fn of fileNames) {
          await new Promise<void>((resolve) => {
            const unsub = useSubtitleExtractorStore.subscribe((state) => {
              const stillPending = state.pendingTasks.some(
                (t) => t.fileName === fn
              );
              if (!stillPending) {
                unsub();
                resolve();
              }
            });
            startTask(fn);
          });
        }
      }

      runSequentially();
    },

    retryTask: (fileName) =>
      set((state) => {
        const task = state.failedTasks.find((t) => t.fileName === fileName);
        if (!task) return state;
        return {
          failedTasks: state.failedTasks.filter(
            (t) => t.fileName !== fileName
          ),
          notStartedTasks: [
            ...state.notStartedTasks,
            {
              ...task,
              status: TaskStatus.NOT_STARTED,
              progress: 0,
              extraInfo: undefined,
            },
          ],
        };
      }),

    deleteTask: (fileName) => {
      set((state) => ({
        notStartedTasks: state.notStartedTasks.filter(
          (t) => t.fileName !== fileName
        ),
        pendingTasks: state.pendingTasks.filter(
          (t) => t.fileName !== fileName
        ),
        resolvedTasks: state.resolvedTasks.filter(
          (t) => t.fileName !== fileName
        ),
        failedTasks: state.failedTasks.filter(
          (t) => t.fileName !== fileName
        ),
      }));
      showToast(i18n.t("subtitle:extractor:infos.task_deleted"), "success");
    },

    updateTask: (fileName, updates) =>
      set((state) => ({
        notStartedTasks: state.notStartedTasks.map((t) =>
          t.fileName === fileName ? { ...t, ...updates } : t
        ),
        failedTasks: state.failedTasks.map((t) =>
          t.fileName === fileName ? { ...t, ...updates } : t
        ),
      })),

    removeAllResolvedTasks: () => set({ resolvedTasks: [] }),

    clearAllTasks: () => {
      set({
        notStartedTasks: [],
        pendingTasks: [],
        resolvedTasks: [],
        failedTasks: [],
      });
      showToast(i18n.t("subtitle:extractor:infos.all_tasks_cleared"), "success");
    },

    initializeStore: () =>
      set({
        notStartedTasks: [],
        pendingTasks: [],
        resolvedTasks: [],
        failedTasks: [],
      }),
    }),
    {
      name: "fusionkit-subtitle-extractor",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        keep: state.keep,
        outputURL: state.outputURL,
        outputMode: state.outputMode,
        conflictPolicy: state.conflictPolicy,
      }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧的分散 key → 新的统一 key
        if (localStorage.getItem("fusionkit-subtitle-extractor") === null) {
          const hasLegacy = Object.values(LEGACY_KEYS).some(
            (k) => localStorage.getItem(k) !== null
          );
          if (hasLegacy) {
            const outputURL = localStorage.getItem(LEGACY_KEYS.outputURL) ?? "";
            const outputMode = localStorage.getItem(LEGACY_KEYS.outputMode) ?? "custom";
            const conflictPolicy = localStorage.getItem(LEGACY_KEYS.conflictPolicy) ?? "index";
            localStorage.setItem(
              "fusionkit-subtitle-extractor",
              JSON.stringify({
                state: { outputURL, outputMode, conflictPolicy },
                version: 0,
              })
            );
            Object.values(LEGACY_KEYS).forEach((k) => localStorage.removeItem(k));
          }
        }
      },
    }
  )
);

export default useSubtitleExtractorStore;
