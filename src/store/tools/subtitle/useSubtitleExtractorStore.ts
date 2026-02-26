import { create } from "zustand";
import {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleExtractorTask,
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

interface SubtitleExtractorStore {
  // 配置
  keep: "ZH" | "JA";
  outputURL: string;
  outputMode: OutputPathMode;
  conflictPolicy: OutputConflictPolicy;

  // 任务队列
  notStartedTasks: SubtitleExtractorTask[];
  pendingTasks: SubtitleExtractorTask[];
  resolvedTasks: SubtitleExtractorTask[];
  failedTasks: SubtitleExtractorTask[];

  // 配置方法
  setKeep: (keep: "ZH" | "JA") => void;
  setOutputURL: (url: string) => void;
  setOutputMode: (mode: OutputPathMode) => void;
  setConflictPolicy: (policy: OutputConflictPolicy) => void;

  // 任务方法
  addTask: (task: SubtitleExtractorTask) => void;
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

const useSubtitleExtractorStore = create<SubtitleExtractorStore>(
  (set, get) => ({
    // 初始配置
    keep: "ZH",
    outputURL: loadString("subtitle-extractor-output-url", ""),
    outputMode: loadString(
      "subtitle-extractor-output-mode",
      "custom"
    ) as OutputPathMode,
    conflictPolicy: loadString(
      "subtitle-extractor-conflict-policy",
      "index"
    ) as OutputConflictPolicy,

    // 任务队列
    notStartedTasks: [],
    pendingTasks: [],
    resolvedTasks: [],
    failedTasks: [],

    // ---- 配置 setter ----

    setKeep: (keep) => set({ keep }),

    setOutputURL: (url) => {
      persist("subtitle-extractor-output-url", url);
      set({ outputURL: url });
    },

    setOutputMode: (mode) => {
      persist("subtitle-extractor-output-mode", mode);
      set({ outputMode: mode });
    },

    setConflictPolicy: (policy) => {
      persist("subtitle-extractor-conflict-policy", policy);
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
          set((s) => ({
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
          }));
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
          set((s) => ({
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
          }));
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

    removeAllResolvedTasks: () => set({ resolvedTasks: [] }),

    initializeStore: () =>
      set({
        notStartedTasks: [],
        pendingTasks: [],
        resolvedTasks: [],
        failedTasks: [],
      }),
  })
);

export default useSubtitleExtractorStore;
