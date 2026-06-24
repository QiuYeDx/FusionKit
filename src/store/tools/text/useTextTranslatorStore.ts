import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createTextTranslationOptions,
  type TextTranslationBilingualLabelMode,
  type TextTranslationConflictPolicy,
  type TextTranslationExecutionMode,
  type TextTranslationOutputMode,
  type TextTranslationOutputPathMode,
  type TextTranslationProjectMode,
  type TextTranslationTask,
} from "@/type/textTranslation";
import type { TranslationLanguage } from "@/type/subtitle";
import type { TextTranslationIpcError } from "@/type/textTranslationIpc";

export interface TextTranslatorPreferences {
  sourceLang: TranslationLanguage | "AUTO";
  targetLang: TranslationLanguage;
  executionMode: TextTranslationExecutionMode;
  projectMode: TextTranslationProjectMode;
  outputMode: TextTranslationOutputMode;
  bilingualLabelMode: TextTranslationBilingualLabelMode;
  sliceTokenLimit: number;
  semanticMemoryTokenLimit: number;
  parallelSliceConcurrency: number;
  documentBackground: string;
  translationInstructions: string;
  styleInstructions: string;
  glossaryText: string;
  memoryResetFileOrdersText: string;
  outputPathMode: TextTranslationOutputPathMode;
  outputDir: string;
  conflictPolicy: TextTranslationConflictPolicy;
}

export interface TextTranslatorUiError {
  code: TextTranslationIpcError["code"] | "renderer_error";
  message: string;
  phase?: TextTranslationTask["phase"];
  field?: string;
}

interface TextTranslatorStore {
  preferences: TextTranslatorPreferences;
  activeTaskId: string | null;
  task: TextTranslationTask | null;
  queuedTasks: TextTranslationTask[];
  outputPaths: string[];
  lastError: TextTranslatorUiError | null;

  updatePreferences: (patch: Partial<TextTranslatorPreferences>) => void;
  setActiveTaskId: (taskId: string | null) => void;
  setTask: (task: TextTranslationTask | null) => void;
  setQueuedTasks: (tasks: TextTranslationTask[]) => void;
  upsertQueuedTask: (task: TextTranslationTask) => void;
  setOutputPaths: (paths: string[]) => void;
  setLastError: (error: TextTranslatorUiError | null) => void;
  clearTask: () => void;
}

const defaultOptions = createTextTranslationOptions();

export const DEFAULT_TEXT_TRANSLATOR_PREFERENCES: TextTranslatorPreferences = {
  sourceLang: defaultOptions.sourceLang,
  targetLang: defaultOptions.targetLang,
  executionMode: defaultOptions.executionMode,
  projectMode: defaultOptions.projectMode,
  outputMode: defaultOptions.outputMode,
  bilingualLabelMode: defaultOptions.bilingualLabelMode ?? "none",
  sliceTokenLimit: defaultOptions.sliceTokenLimit,
  semanticMemoryTokenLimit: defaultOptions.semanticMemoryTokenLimit,
  parallelSliceConcurrency: defaultOptions.parallelSliceConcurrency,
  documentBackground: "",
  translationInstructions: "",
  styleInstructions: "",
  glossaryText: "",
  memoryResetFileOrdersText: "",
  outputPathMode: defaultOptions.outputPathMode,
  outputDir: "",
  conflictPolicy: defaultOptions.conflictPolicy,
};

const useTextTranslatorStore = create<TextTranslatorStore>()(
  persist(
    (set) => ({
      preferences: DEFAULT_TEXT_TRANSLATOR_PREFERENCES,
      activeTaskId: null,
      task: null,
      queuedTasks: [],
      outputPaths: [],
      lastError: null,

      updatePreferences: (patch) => {
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...patch,
          },
        }));
      },
      setActiveTaskId: (taskId) => set({ activeTaskId: taskId }),
      setTask: (task) =>
        set({
          task,
          activeTaskId: task?.taskId ?? null,
        }),
      setQueuedTasks: (tasks) => set({ queuedTasks: tasks }),
      upsertQueuedTask: (task) =>
        set((state) => {
          const existingIndex = state.queuedTasks.findIndex(
            (item) => item.taskId === task.taskId,
          );
          if (existingIndex === -1) {
            return { queuedTasks: [...state.queuedTasks, task] };
          }
          const queuedTasks = [...state.queuedTasks];
          queuedTasks[existingIndex] = task;
          return { queuedTasks };
        }),
      setOutputPaths: (paths) => set({ outputPaths: paths }),
      setLastError: (error) => set({ lastError: error }),
      clearTask: () =>
        set({
          activeTaskId: null,
          task: null,
          queuedTasks: [],
          outputPaths: [],
          lastError: null,
        }),
    }),
    {
      name: "fusionkit-text-translator",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        preferences: state.preferences,
        activeTaskId: state.activeTaskId,
      }),
    },
  ),
);

export default useTextTranslatorStore;
