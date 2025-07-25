import { create } from "zustand";
import { cloneDeep } from "lodash";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  SubtitleFileType,
  SubtitleSliceType,
  SubtitleTranslatorTask,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";

// 最大并发数
const MAX_CONCURRENCY = 5;

interface SubtitleTranslatorStore {
  // fileType: SubtitleFileType;
  sliceType: SubtitleSliceType;
  sliceLengthMap: Record<SubtitleSliceType, number>;
  outputURL: string; // 添加输出路径状态
  // 任务队列
  notStartedTaskQueue: SubtitleTranslatorTask[];
  waitingTaskQueue: SubtitleTranslatorTask[];
  pendingTaskQueue: SubtitleTranslatorTask[];
  resolvedTaskQueue: SubtitleTranslatorTask[];
  failedTaskQueue: SubtitleTranslatorTask[];

  // 方法
  // setFileType: (fileType: SubtitleFileType) => void;
  setSliceType: (sliceType: SubtitleSliceType) => void;
  setCustomSliceLength: (length: number) => void;
  setOutputURL: (url: string) => void; // 添加设置输出路径的方法
  initializeSubtitleTranslatorStore: () => void;
  addTask: (task: SubtitleTranslatorTask) => void;
  startTask: (fileName: string) => void;
  retryTask: (fileName: string) => void;
  removeAllResolvedTask: () => void;
  startAllTasks: () => void;
  addFailedTask: (errorData: {
    fileName: string;
    error: string;
    message: string;
    errorLogs?: string[];
    timestamp?: string;
    stackTrace?: string;
  }) => void;

  // 任务取消和删除
  cancelTask: (fileName: string) => void;
  deleteTask: (fileName: string) => void;
  updateProgress: (
    fileName: string,
    resolvedFragments: number,
    totalFragments: number,
    progress: number
  ) => void;
}

// 从 localStorage 读取保存的输出路径
const getSavedOutputURL = (): string => {
  try {
    return localStorage.getItem("subtitle-translator-output-url") || "";
  } catch {
    return "";
  }
};

// 保存输出路径到 localStorage
const saveOutputURL = (url: string): void => {
  try {
    localStorage.setItem("subtitle-translator-output-url", url);
  } catch {
    // 静默处理存储失败
  }
};

const useSubtitleTranslatorStore = create<SubtitleTranslatorStore>((set) => ({
  // 初始状态
  // fileType: SubtitleFileType.LRC,
  sliceType: SubtitleSliceType.NORMAL,
  sliceLengthMap: DEFAULT_SLICE_LENGTH_MAP,
  outputURL: getSavedOutputURL(), // 从本地存储读取输出路径
  notStartedTaskQueue: [],
  waitingTaskQueue: [],
  pendingTaskQueue: [],
  resolvedTaskQueue: [],
  failedTaskQueue: [],

  // 基本信息设置
  // setFileType: (fileType) => set({ fileType }),
  setSliceType: (sliceType) => set({ sliceType }),
  setCustomSliceLength: (length) =>
    set((state) => ({
      sliceLengthMap: {
        ...state.sliceLengthMap,
        [SubtitleSliceType.CUSTOM]: length,
      },
    })),

  // 设置输出路径并持久化
  setOutputURL: (url) => {
    saveOutputURL(url);
    set({ outputURL: url });
  },

  // 初始化（重置）
  initializeSubtitleTranslatorStore: () =>
    set({
      // fileType: SubtitleFileType.LRC,
      sliceType: SubtitleSliceType.NORMAL,
      sliceLengthMap: DEFAULT_SLICE_LENGTH_MAP,
      notStartedTaskQueue: [],
      waitingTaskQueue: [],
      pendingTaskQueue: [],
      resolvedTaskQueue: [],
      failedTaskQueue: [],
    }),

  // 添加新任务（防止重复）
  addTask: (task) =>
    set((state) => {
      const allTasks = [
        ...state.notStartedTaskQueue,
        ...state.waitingTaskQueue,
        ...state.pendingTaskQueue,
        ...state.resolvedTaskQueue,
        ...state.failedTaskQueue,
      ];

      return allTasks.some((t) => t.originFileURL === task.originFileURL)
        ? state // 已存在相同URL的任务
        : { notStartedTaskQueue: [...state.notStartedTaskQueue, task] };
    }),

  // 启动单个任务
  startTask: (fileName) =>
    set((state) => {
      const task = state.notStartedTaskQueue.find(
        (t) => t.fileName === fileName
      );
      if (!task) return state;

      // 如果并发数未满
      if (state.pendingTaskQueue.length < MAX_CONCURRENCY) {
        const updatedTask = { ...task, status: TaskStatus.PENDING };

        // 任务启动
        window.ipcRenderer.invoke("translate-subtitle", updatedTask);

        return {
          notStartedTaskQueue: state.notStartedTaskQueue.filter(
            (t) => t.fileName !== fileName
          ),
          pendingTaskQueue: [...state.pendingTaskQueue, updatedTask],
        };
      }

      // 如果并发数已满
      const updatedQueue = state.notStartedTaskQueue.filter(
        (t) => t.fileName !== fileName
      );
      const updatedTask = { ...task, status: TaskStatus.WAITING };

      return {
        notStartedTaskQueue: updatedQueue,
        waitingTaskQueue: [...state.waitingTaskQueue, updatedTask],
      };
    }),

  // 重试任务
  retryTask: (fileName) =>
    set((state) => {
      const task = state.failedTaskQueue.find((t) => t.fileName === fileName);
      if (!task) return state;

      const clonedTask = cloneDeep({
        ...task,
        status: TaskStatus.NOT_STARTED,
        progress: 0,
      });

      return {
        failedTaskQueue: state.failedTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        notStartedTaskQueue: [...state.notStartedTaskQueue, clonedTask],
      };
    }),

  // 批量启动任务(超出并发数的任务会被加入等待队列)
  startAllTasks: () => {
    set((state) => {
      const pendingTasks = state.pendingTaskQueue.length;
      const waitingTasks = state.waitingTaskQueue.length;

      const tasksToStart = state.notStartedTaskQueue.slice(
        0,
        MAX_CONCURRENCY - pendingTasks
      );

      const tasksToWait = state.notStartedTaskQueue.slice(
        MAX_CONCURRENCY - pendingTasks
      );

      const updatedTasks = tasksToStart.map((task) => ({
        ...task,
        status: TaskStatus.PENDING,
      }));

      const updatedWaitingTasks = tasksToWait.map((task) => ({
        ...task,
        status: TaskStatus.WAITING,
      }));

      // 任务启动
      updatedTasks.forEach((task) => {
        window.ipcRenderer.invoke("translate-subtitle", task);
      });

      return {
        notStartedTaskQueue: [],
        waitingTaskQueue: [...state.waitingTaskQueue, ...updatedWaitingTasks],
        pendingTaskQueue: [...state.pendingTaskQueue, ...updatedTasks],
      };
    });
  },

  removeAllResolvedTask: () => {
    set({
      resolvedTaskQueue: [],
    });
  },

  updateProgress: (fileName, resolvedFragments, totalFragments, progress) => {
    set((state) => {
      console.info(
        ">>> 收到 updateProgress",
        fileName,
        resolvedFragments,
        totalFragments,
        progress
      );
      const task = state.pendingTaskQueue.find((t) => t.fileName === fileName);
      if (!task) return state;

      // 如果任务完成
      if (resolvedFragments === totalFragments) {
        const updatedTask = {
          ...task,
          resolvedFragments,
          totalFragments,
          progress: 100,
          status: TaskStatus.RESOLVED,
        };

        // 如果等待队列中有任务且并发数未满
        if (
          state.waitingTaskQueue.length > 0 &&
          state.pendingTaskQueue.length < MAX_CONCURRENCY
        ) {
          const waitingTask = state.waitingTaskQueue[0];
          const updatedWaitingTask = {
            ...waitingTask,
            status: TaskStatus.PENDING,
          };

          // 任务启动
          window.ipcRenderer.invoke("translate-subtitle", updatedWaitingTask);

          return {
            waitingTaskQueue: state.waitingTaskQueue.slice(1),
            pendingTaskQueue: [...state.pendingTaskQueue, updatedWaitingTask],
            resolvedTaskQueue: [...state.resolvedTaskQueue, updatedTask],
          };
        }

        return {
          pendingTaskQueue: state.pendingTaskQueue.filter(
            (t) => t.fileName !== fileName
          ),
          resolvedTaskQueue: [...state.resolvedTaskQueue, updatedTask],
        };
      }

      // 任务未完成
      const updatedTask = {
        ...task,
        resolvedFragments,
        totalFragments,
        progress,
      };

      return {
        pendingTaskQueue: state.pendingTaskQueue.map((t) =>
          t.fileName === fileName ? updatedTask : t
        ),
      };
    });
  },

  addFailedTask: (errorData: {
    fileName: string;
    error: string;
    message: string;
    errorLogs?: string[];
    timestamp?: string;
    stackTrace?: string;
  }) => {
    set((state) => {
      const task = state.pendingTaskQueue.find(
        (t) => t.fileName === errorData.fileName
      );
      if (!task) return state;

      const updatedTask = {
        ...task,
        status: TaskStatus.FAILED,
        errorLog: errorData.errorLogs || [],
        extraInfo: {
          error: errorData.error,
          message: errorData.message,
          timestamp: errorData.timestamp,
          stackTrace: errorData.stackTrace,
          errorLogs: errorData.errorLogs || [],
        },
      };

      // 显示简短的错误Toast
      showToast(`${errorData.message}`, "error");

      // 如果等待队列中有任务且并发数未满
      if (
        state.waitingTaskQueue.length > 0 &&
        state.pendingTaskQueue.length < MAX_CONCURRENCY
      ) {
        const waitingTask = state.waitingTaskQueue[0];
        const updatedWaitingTask = {
          ...waitingTask,
          status: TaskStatus.PENDING,
        };

        // 任务启动
        window.ipcRenderer.invoke("translate-subtitle", updatedWaitingTask);

        return {
          waitingTaskQueue: state.waitingTaskQueue.slice(1),
          pendingTaskQueue: [
            ...state.pendingTaskQueue.filter(
              (t) => t.fileName !== errorData.fileName
            ),
            updatedWaitingTask,
          ],
          failedTaskQueue: [...state.failedTaskQueue, updatedTask],
        };
      }

      return {
        pendingTaskQueue: state.pendingTaskQueue.filter(
          (t) => t.fileName !== errorData.fileName
        ),
        failedTaskQueue: [...state.failedTaskQueue, updatedTask],
      };
    });
  },

  // 取消任务
  cancelTask: (fileName) => {
    // 通过 IPC 通知主进程取消任务
    window.ipcRenderer.send("cancel-translation", fileName);

    set((state) => {
      // 从 pending 队列中找到任务
      const task = state.pendingTaskQueue.find((t) => t.fileName === fileName);
      if (!task) return state;

      const canceledTask = {
        ...task,
        status: TaskStatus.FAILED,
        extraInfo: {
          error: "CANCELED",
          message: "任务已被用户取消",
        },
      };

      showToast("任务已取消", "success");

      // 如果等待队列中有任务且并发数未满
      if (
        state.waitingTaskQueue.length > 0 &&
        state.pendingTaskQueue.length <= MAX_CONCURRENCY
      ) {
        const waitingTask = state.waitingTaskQueue[0];
        const updatedWaitingTask = {
          ...waitingTask,
          status: TaskStatus.PENDING,
        };

        // 启动等待队列中的下一个任务
        window.ipcRenderer.invoke("translate-subtitle", updatedWaitingTask);

        return {
          waitingTaskQueue: state.waitingTaskQueue.slice(1),
          pendingTaskQueue: [
            ...state.pendingTaskQueue.filter((t) => t.fileName !== fileName),
            updatedWaitingTask,
          ],
          failedTaskQueue: [...state.failedTaskQueue, canceledTask],
        };
      }

      return {
        pendingTaskQueue: state.pendingTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        failedTaskQueue: [...state.failedTaskQueue, canceledTask],
      };
    });
  },

  // 删除任务
  deleteTask: (fileName) => {
    set((state) => {
      return {
        notStartedTaskQueue: state.notStartedTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        waitingTaskQueue: state.waitingTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        pendingTaskQueue: state.pendingTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        resolvedTaskQueue: state.resolvedTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
        failedTaskQueue: state.failedTaskQueue.filter(
          (t) => t.fileName !== fileName
        ),
      };
    });

    showToast("任务已删除", "success");
  },
}));

export default useSubtitleTranslatorStore;
