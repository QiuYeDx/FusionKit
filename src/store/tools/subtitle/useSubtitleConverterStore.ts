import { create } from "zustand";
import { persist as persistMiddleware, createJSONStorage } from "zustand/middleware";
import {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleConverterTask,
  SubtitleFileType,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import { showSystemNotification } from "@/utils/notification";
import i18n from "@/i18n";

const LEGACY_KEYS = {
  outputURL: "subtitle-converter-output-url",
  outputMode: "subtitle-converter-output-mode",
  conflictPolicy: "subtitle-converter-conflict-policy",
  stripMediaExt: "subtitle-converter-strip-media-ext",
};

// ---------------------------------------------------------------------------
// Store 类型
// ---------------------------------------------------------------------------

interface SubtitleConverterStore {
  // 配置
  toFormat: SubtitleFileType;
  defaultDurationSec: string;
  stripMediaExt: boolean;
  outputURL: string;
  outputMode: OutputPathMode;
  conflictPolicy: OutputConflictPolicy;

  // 任务队列（与 TranslatorStore 对齐，按状态分桶）
  notStartedTasks: SubtitleConverterTask[];
  pendingTasks: SubtitleConverterTask[];
  resolvedTasks: SubtitleConverterTask[];
  failedTasks: SubtitleConverterTask[];

  // 配置方法
  setToFormat: (format: SubtitleFileType) => void;
  setDefaultDurationSec: (sec: string) => void;
  setStripMediaExt: (val: boolean) => void;
  setOutputURL: (url: string) => void;
  setOutputMode: (mode: OutputPathMode) => void;
  setConflictPolicy: (policy: OutputConflictPolicy) => void;

  // 任务方法
  addTask: (task: SubtitleConverterTask) => void;
  startTask: (fileName: string) => void;
  startAllTasks: () => void;
  retryTask: (fileName: string) => void;
  deleteTask: (fileName: string) => void;
  updateTask: (fileName: string, updates: Partial<SubtitleConverterTask>) => void;
  removeAllResolvedTasks: () => void;
  clearAllTasks: () => void;
  initializeStore: () => void;
}

// ---------------------------------------------------------------------------
// Store 实现
// ---------------------------------------------------------------------------

const useSubtitleConverterStore = create<SubtitleConverterStore>()(
  persistMiddleware(
    (set, get) => ({
  toFormat: SubtitleFileType.SRT,
  defaultDurationSec: "2",
  stripMediaExt: true,
  outputURL: "",
  outputMode: "custom" as OutputPathMode,
  conflictPolicy: "index" as OutputConflictPolicy,

  // 任务队列
  notStartedTasks: [],
  pendingTasks: [],
  resolvedTasks: [],
  failedTasks: [],

  // ---- 配置 setter（同步持久化） ----

  setToFormat: (format) => set({ toFormat: format }),

  setDefaultDurationSec: (sec) => set({ defaultDurationSec: sec }),

  setStripMediaExt: (val) => {
    set({ stripMediaExt: val });
  },

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
          i18n.t("subtitle:converter.errors.duplicate_file").replace("{file}", task.fileName),
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

    const { defaultDurationSec, stripMediaExt, conflictPolicy } = get();
    const defaultDurationMs =
      Math.max(0, Math.floor(Number(defaultDurationSec) * 1000)) || 2000;

    window.ipcRenderer
      .invoke("convert-subtitle", {
        fileName: task.fileName,
        fileContent: task.fileContent,
        from: task.from,
        to: task.to,
        outputDir: task.targetFileURL,
        defaultDurationMs,
        stripMediaExt,
        conflictPolicy: task.conflictPolicy ?? conflictPolicy,
      })
      .then((res: any) => {
        set((s) => {
          if (!s.pendingTasks.some((t) => t.fileName === fileName)) return s;
          return {
            pendingTasks: s.pendingTasks.filter((t) => t.fileName !== fileName),
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
            .t("subtitle:converter.infos.task_convert_done")
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
            pendingTasks: s.pendingTasks.filter((t) => t.fileName !== fileName),
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
            .t("subtitle:converter.errors.task_convert_failed")
            .replace("{file}", fileName),
          "error"
        );
        showSystemNotification(
          "FusionKit",
          i18n.t("setting:fields.notification.task_failed", { file: fileName })
        );
      });
  },

  startAllTasks: () => {
    const { notStartedTasks, startTask } = get();
    const fileNames = notStartedTasks.map((t) => t.fileName);

    async function runSequentially() {
      for (const fn of fileNames) {
        await new Promise<void>((resolve) => {
          const unsub = useSubtitleConverterStore.subscribe((state) => {
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
        failedTasks: state.failedTasks.filter((t) => t.fileName !== fileName),
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
      pendingTasks: state.pendingTasks.filter((t) => t.fileName !== fileName),
      resolvedTasks: state.resolvedTasks.filter(
        (t) => t.fileName !== fileName
      ),
      failedTasks: state.failedTasks.filter((t) => t.fileName !== fileName),
    }));
    showToast(i18n.t("subtitle:converter.infos.task_deleted"), "success");
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
    showToast(i18n.t("subtitle:converter.infos.all_tasks_cleared"), "success");
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
      name: "fusionkit-subtitle-converter",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        outputURL: state.outputURL,
        outputMode: state.outputMode,
        conflictPolicy: state.conflictPolicy,
        stripMediaExt: state.stripMediaExt,
      }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧的分散 key → 新的统一 key
        if (localStorage.getItem("fusionkit-subtitle-converter") === null) {
          const hasLegacy = Object.values(LEGACY_KEYS).some(
            (k) => localStorage.getItem(k) !== null
          );
          if (hasLegacy) {
            const outputURL = localStorage.getItem(LEGACY_KEYS.outputURL) ?? "";
            const outputMode = localStorage.getItem(LEGACY_KEYS.outputMode) ?? "custom";
            const conflictPolicy = localStorage.getItem(LEGACY_KEYS.conflictPolicy) ?? "index";
            const stripRaw = localStorage.getItem(LEGACY_KEYS.stripMediaExt);
            const stripMediaExt = stripRaw === null ? true : stripRaw === "true";
            localStorage.setItem(
              "fusionkit-subtitle-converter",
              JSON.stringify({
                state: { outputURL, outputMode, conflictPolicy, stripMediaExt },
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

export default useSubtitleConverterStore;
