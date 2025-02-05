import { create } from "zustand";
import { cloneDeep } from "lodash";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  SubtitleFileType,
  SubtitleSliceType,
  SubtitleTranslatorTask,
  TaskStatus,
} from "@/type/subtitle";

interface SubtitleTranslatorStore {
  // fileType: SubtitleFileType;
  sliceType: SubtitleSliceType;
  sliceLengthMap: Record<SubtitleSliceType, number>;
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
  initializeSubtitleTranslatorStore: () => void;
  addTask: (task: SubtitleTranslatorTask) => void;
  startTask: (fileName: string) => void;
  retryTask: (fileName: string) => void;
  removeAllResolvedTask: () => void;
  startAllTasks: () => void;
}

const useSubtitleTranslatorStore = create<SubtitleTranslatorStore>((set) => ({
  // 初始状态
  fileType: SubtitleFileType.LRC,
  sliceType: SubtitleSliceType.NORMAL,
  sliceLengthMap: DEFAULT_SLICE_LENGTH_MAP,
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

  // 批量启动
  startAllTasks: () =>
    set((state) => {
      const activeUrls = new Set(
        [
          ...state.waitingTaskQueue,
          ...state.pendingTaskQueue,
          ...state.resolvedTaskQueue,
        ].map((t) => t.originFileURL)
      );

      const validTasks = state.notStartedTaskQueue
        .filter((t) => !activeUrls.has(t.originFileURL))
        .map((t) => ({ ...t, status: TaskStatus.WAITING }));

      return {
        notStartedTaskQueue: state.notStartedTaskQueue.filter(
          (t) => activeUrls.has(t.originFileURL) // ? 为什么这样写 ?
        ),
        waitingTaskQueue: [...state.waitingTaskQueue, ...validTasks],
      };
    }),

  removeAllResolvedTask: () => {
    set({
      resolvedTaskQueue: [],
    });
  },
}));

export default useSubtitleTranslatorStore;
