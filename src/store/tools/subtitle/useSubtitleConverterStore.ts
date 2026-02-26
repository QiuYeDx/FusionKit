import { create } from "zustand";
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

// ---------------------------------------------------------------------------
// localStorage 持久化工具
// ---------------------------------------------------------------------------

function loadString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* silent */
  }
}

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
  removeAllResolvedTasks: () => void;
  initializeStore: () => void;
}

// ---------------------------------------------------------------------------
// Store 实现
// ---------------------------------------------------------------------------

const useSubtitleConverterStore = create<SubtitleConverterStore>((set, get) => ({
  // 初始配置（从 localStorage 恢复）
  toFormat: SubtitleFileType.SRT,
  defaultDurationSec: "2",
  stripMediaExt: loadBoolean("subtitle-converter-strip-media-ext", true),
  outputURL: loadString("subtitle-converter-output-url", ""),
  outputMode: loadString("subtitle-converter-output-mode", "custom") as OutputPathMode,
  conflictPolicy: loadString("subtitle-converter-conflict-policy", "index") as OutputConflictPolicy,

  // 任务队列
  notStartedTasks: [],
  pendingTasks: [],
  resolvedTasks: [],
  failedTasks: [],

  // ---- 配置 setter（同步持久化） ----

  setToFormat: (format) => set({ toFormat: format }),

  setDefaultDurationSec: (sec) => set({ defaultDurationSec: sec }),

  setStripMediaExt: (val) => {
    persist("subtitle-converter-strip-media-ext", String(val));
    set({ stripMediaExt: val });
  },

  setOutputURL: (url) => {
    persist("subtitle-converter-output-url", url);
    set({ outputURL: url });
  },

  setOutputMode: (mode) => {
    persist("subtitle-converter-output-mode", mode);
    set({ outputMode: mode });
  },

  setConflictPolicy: (policy) => {
    persist("subtitle-converter-conflict-policy", policy);
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
      if (allTasks.some((t) => t.originFileURL === task.originFileURL)) {
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
        set((s) => ({
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
        }));
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
        set((s) => ({
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
        }));
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

  removeAllResolvedTasks: () => set({ resolvedTasks: [] }),

  initializeStore: () =>
    set({
      notStartedTasks: [],
      pendingTasks: [],
      resolvedTasks: [],
      failedTasks: [],
    }),
}));

export default useSubtitleConverterStore;
