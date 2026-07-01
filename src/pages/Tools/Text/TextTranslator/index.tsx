import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  CircleDashed,
  Folder,
  PlayCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
  DialogTitle,
} from "@/components/qiuye-ui/scrollable-dialog";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui";
import useModelStore from "@/store/useModelStore";
import useTextTranslatorStore from "@/store/tools/text/useTextTranslatorStore";
import {
  DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
  createTextTranslationOptions,
  estimateTextTranslationRequiredContextTokens,
  resolveTextTranslationOutputTokenReserve,
  type TextFileFormat,
  type TextTranslationGlossaryEntry,
  type TextTranslationPhase,
  type TextTranslationProjectMode,
  type TextTranslationRecoverySummary,
  type TextTranslationRuntimeModelConfig,
  type TextTranslationTask,
} from "@/type/textTranslation";
import { SUPPORTED_LANGUAGES } from "@/type/subtitle";
import type { TextTranslationIpcError } from "@/type/textTranslationIpc";
import {
  cancelTextTranslationTask,
  createTextTranslationTask,
  deleteTextTranslationTask,
  getTextTranslationTaskDetail,
  listRecoverableTextTranslationTasks,
  prepareTextTranslationTask,
  revealTextTranslationOutput,
  revealTextTranslationWorkspace,
  restartTextTranslationTask,
  resumeTextTranslationTask,
  startTextTranslationTask,
  subscribeTextTranslationEvents,
} from "@/services/text/textTranslatorExecutionService";
import { getFilePathFromFile } from "@/utils/filePath";
import { showToast } from "@/utils/toast";
import ConfigPanel from "./components/ConfigPanel";
import TaskPanel from "./components/TaskPanel";

type SelectedTextFile = {
  fileName: string;
  sourcePath: string;
  format: TextFileFormat;
  sizeBytes: number;
  modifiedAt: number;
  order: number;
  relativePath?: string;
};

function TextTranslator() {
  const { t, i18n } = useTranslation(["text", "subtitle"]);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const taskProfile = useModelStore((state) => state.getTaskProfile());
  const {
    preferences,
    activeTaskId,
    task,
    queuedTasks,
    outputPaths,
    lastError,
    updatePreferences,
    setActiveTaskId,
    setTask,
    setQueuedTasks,
    upsertQueuedTask,
    setOutputPaths,
    setLastError,
    clearTask,
  } = useTextTranslatorStore();

  const [selectedFiles, setSelectedFiles] = useState<SelectedTextFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveries, setRecoveries] = useState<TextTranslationRecoverySummary[]>([]);
  const [isLoadingRecoveries, setIsLoadingRecoveries] = useState(false);
  const [recoveryActionTaskId, setRecoveryActionTaskId] = useState<string | null>(null);

  const meta = TOOL_META.textTranslator;
  const hasUsableTaskModel = Boolean(
    taskProfile?.apiKey && taskProfile.modelKey && taskProfile.baseUrl,
  );
  const sourceFiles = selectedFiles.length > 0 ? selectedFiles : taskFilesToSelectedFiles(task);
  const sourceFile = sourceFiles[0] ?? null;
  const progress = task?.progress;
  const currentStatus = task?.status ?? "not_started";
  const currentPhase = task?.phase ?? "idle";
  const visibleLastError =
    lastError && (!lastError.taskId || lastError.taskId === task?.taskId)
      ? lastError
      : null;
  const queuedWaitingTasks = queuedTasks.filter(
    (queuedTask) => queuedTask.status === "waiting",
  );
  const hasQueuedRunningTask = queuedTasks.some(
    (queuedTask) => queuedTask.status === "running",
  );
  const isRunning = currentStatus === "running" || hasQueuedRunningTask || isStarting;
  const isBusy = isPreparing || isStarting || isCancelling;
  const isPrepared = Boolean(task && task.progress.totalSegments > 0);
  const outputTokenReserve = resolveTextTranslationOutputTokenReserve(
    preferences.sliceTokenLimit,
  );
  const budgetOptions = useMemo(
    () =>
      createTextTranslationOptions({
        sourceLang: preferences.sourceLang,
        targetLang: preferences.targetLang,
        executionMode: preferences.executionMode,
        outputMode: preferences.outputMode,
        bilingualLabelMode: preferences.bilingualLabelMode,
        projectMode: preferences.projectMode,
        sliceTokenLimit: preferences.sliceTokenLimit,
        semanticMemoryTokenLimit: preferences.semanticMemoryTokenLimit,
        modelContextTokenLimit: DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
        outputTokenReserve,
        parallelSliceConcurrency: preferences.parallelSliceConcurrency,
        outputPathMode: preferences.outputPathMode,
        outputDir: preferences.outputDir,
        conflictPolicy: preferences.conflictPolicy,
      }),
    [outputTokenReserve, preferences],
  );
  const requiredContextTokens =
    estimateTextTranslationRequiredContextTokens(budgetOptions);
  const isBudgetExceeded =
    requiredContextTokens > DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT;
  const budgetUsagePercent = Math.round(
    (requiredContextTokens / DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT) *
      100,
  );
  const canPrepare =
    sourceFiles.length > 0 &&
    hasUsableTaskModel &&
    !isBusy &&
    currentStatus !== "running" &&
    hasValidOutputPreference(preferences) &&
    !isBudgetExceeded;
  const canStart =
    (queuedWaitingTasks.length > 0 ||
      (Boolean(task?.taskId) && currentStatus === "waiting")) &&
    hasUsableTaskModel &&
    !isBusy;
  const canCancel = Boolean(task?.taskId) && isRunning && !isCancelling;
  const canRevealOutput = outputPaths.length > 0 || task?.status === "completed";
  const locale = i18n.resolvedLanguage || i18n.language || "en-US";
  const isOrderedProject = preferences.projectMode === "ordered_project";
  const isIndependentBatch =
    sourceFiles.length > 1 && preferences.projectMode === "independent_files";
  const hasMarkdownFiles = sourceFiles.some(
    (file) => file.format === "markdown",
  );

  const sourceLanguages = useMemo(
    () => [
      { code: "AUTO" as const, label: t("translator.languages.AUTO") },
      ...SUPPORTED_LANGUAGES.map((language) => ({
        code: language.code,
        label: t(language.labelKey),
      })),
    ],
    [t],
  );

  const targetLanguages = useMemo(
    () =>
      SUPPORTED_LANGUAGES.map((language) => ({
        code: language.code,
        label: t(language.labelKey),
      })),
    [t],
  );

  const runtimeModel = useMemo<TextTranslationRuntimeModelConfig | null>(() => {
    if (!hasUsableTaskModel || !taskProfile) return null;
    return {
      profileId: taskProfile.id,
      apiKey: taskProfile.apiKey,
      modelKey: taskProfile.modelKey,
      endpoint: taskProfile.baseUrl,
    };
  }, [hasUsableTaskModel, taskProfile]);

  const estimatedCost = useMemo(() => {
    const estimatedInputTokens = progress?.estimatedInputTokens;
    if (!estimatedInputTokens || !taskProfile?.tokenPricing) return null;
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 1.15);
    const inputCost =
      (estimatedInputTokens / 1_000_000) *
      taskProfile.tokenPricing.inputTokensPerMillion;
    const outputCost =
      (estimatedOutputTokens / 1_000_000) *
      taskProfile.tokenPricing.outputTokensPerMillion;
    return inputCost + outputCost;
  }, [progress?.estimatedInputTokens, taskProfile?.tokenPricing]);

  const refreshActiveTask = useCallback(
    async (taskId = activeTaskId) => {
      if (!taskId) return;
      const detail = await getTextTranslationTaskDetail({ taskId });
      if (!detail.ok || !detail.data) {
        clearTask();
        return;
      }
      setTask(detail.data);
      if (detail.data.status === "completed") {
        const revealed = await revealTextTranslationOutput({ taskId });
        if (revealed.ok && revealed.data.path) {
          setOutputPaths([revealed.data.path]);
        }
      }
    },
    [activeTaskId, clearTask, setOutputPaths, setTask],
  );

  useEffect(() => {
    void refreshActiveTask();
  }, [refreshActiveTask]);

  useEffect(() => {
    const getStore = () => useTextTranslatorStore.getState();
    return subscribeTextTranslationEvents({
      taskUpdated: (event) => {
        const { activeTaskId: currentActiveId } = getStore();
        upsertQueuedTask(event.task);
        if (currentActiveId && event.taskId !== currentActiveId) return;
        setTask(event.task);
      },
      progress: (event) => {
        const { task: currentTask, queuedTasks: currentQueue } = getStore();
        const matched = currentQueue.find(
          (item) => item.taskId === event.taskId,
        );
        if (matched) {
          upsertQueuedTask({
            ...matched,
            phase: event.progress.phase,
            progress: event.progress,
            updatedAt: event.occurredAt,
          });
        }
        if (!currentTask || event.taskId !== currentTask.taskId) return;
        setTask({
          ...currentTask,
          phase: event.progress.phase,
          progress: event.progress,
          updatedAt: event.occurredAt,
        });
      },
      taskCompleted: (event) => {
        const { activeTaskId: currentActiveId } = getStore();
        upsertQueuedTask(event.task);
        if (currentActiveId && event.taskId !== currentActiveId) return;
        setTask(event.task);
        setOutputPaths(event.outputPaths);
        showToast(t("translator.messages.completed"), "success");
      },
      taskFailed: (event) => {
        const {
          activeTaskId: currentActiveId,
          task: currentTask,
          queuedTasks: currentQueue,
        } = getStore();
        const matched = currentQueue.find(
          (item) => item.taskId === event.taskId,
        );
        const failedTask =
          event.task ??
          (matched
            ? {
                ...matched,
                status: "failed" as const,
                phase: event.error.phase ?? matched.phase,
              }
            : null);
        if (failedTask) {
          upsertQueuedTask(failedTask);
        }
        if (currentActiveId && event.taskId !== currentActiveId) return;
        if (failedTask) {
          setTask(failedTask);
        }
        setLastError(
          toUiError(
            event.error,
            failedTask?.phase ?? currentTask?.phase,
            event.taskId,
          ),
        );
        showToast(event.error.message || "Translation task failed.", "error");
      },
      fileCompleted: (event) => {
        const { activeTaskId: currentActiveId } = getStore();
        if (currentActiveId && event.taskId !== currentActiveId) return;
        setOutputPaths([event.outputPath]);
      },
      warning: (event) => {
        const { activeTaskId: currentActiveId } = getStore();
        if (currentActiveId && event.taskId !== currentActiveId) return;
        showToast(event.warning.message, "warning");
      },
    });
  }, [setLastError, setOutputPaths, setTask, t, upsertQueuedTask]);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const selected = Array.from(files);
      if (selected.length === 0) return;
      const nextFiles: SelectedTextFile[] = [];
      for (const file of selected) {
        const sourcePath = getFilePathFromFile(file);
        if (!sourcePath) {
          const message = t("translator.errors.file_path_unavailable");
          setLastError({ code: "renderer_error", message, field: "sourcePath" });
          showToast(message, "error");
          return;
        }
        const format = detectSelectedTextFileFormat(file.name);
        if (!format) {
          const message = t("translator.errors.unsupported_file");
          setLastError({ code: "renderer_error", message, field: "sourcePath" });
          showToast(message, "error");
          return;
        }
        nextFiles.push({
          fileName: file.name,
          sourcePath,
          format,
          sizeBytes: file.size,
          modifiedAt: file.lastModified,
          order: 0,
          relativePath: file.webkitRelativePath || file.name,
        });
      }
      setSelectedFiles(
        nextFiles
          .sort((left, right) =>
            naturalCompare(left.relativePath ?? left.fileName, right.relativePath ?? right.fileName),
          )
          .map((file, order) => ({ ...file, order })),
      );
      setLastError(null);
      setOutputPaths([]);
      clearTask();
    },
    [clearTask, setLastError, setOutputPaths, t],
  );

  const handlePrepare = async () => {
    if (sourceFiles.length === 0 || !runtimeModel) return;
    if (!hasValidOutputPreference(preferences)) {
      const message = t("translator.errors.output_dir_required");
      setLastError({ code: "renderer_error", message, field: "outputDir" });
      showToast(message, "error");
      return;
    }
    if (isBudgetExceeded) {
      const message = t("translator.errors.budget_exceeded");
      setLastError({
        code: "renderer_error",
        message,
        field: "modelContextTokenLimit",
      });
      showToast(message, "error");
      return;
    }

    setIsPreparing(true);
    setLastError(null);
    setOutputPaths([]);
    try {
      const glossary = parseGlossaryText(preferences.glossaryText);
      const memoryResetFileOrders = parseIntegerList(
        preferences.memoryResetFileOrdersText,
      );
      const buildOptions = (projectMode: TextTranslationProjectMode) =>
        createTextTranslationOptions({
          sourceLang: preferences.sourceLang,
          targetLang: preferences.targetLang,
          executionMode: preferences.executionMode,
          outputMode: preferences.outputMode,
          bilingualLabelMode:
            preferences.outputMode === "bilingual"
              ? preferences.bilingualLabelMode
              : "none",
          projectMode,
          sliceTokenLimit: preferences.sliceTokenLimit,
          semanticMemoryTokenLimit: preferences.semanticMemoryTokenLimit,
          modelContextTokenLimit:
            DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
          outputTokenReserve,
          parallelSliceConcurrency: preferences.parallelSliceConcurrency,
          documentBackground: emptyToUndefined(preferences.documentBackground),
          translationInstructions: emptyToUndefined(
            preferences.translationInstructions,
          ),
          styleInstructions: emptyToUndefined(preferences.styleInstructions),
          glossary: glossary.length > 0 ? glossary : undefined,
          memoryResetFileOrders:
            memoryResetFileOrders.length > 0
              ? memoryResetFileOrders
              : undefined,
          outputPathMode: preferences.outputPathMode,
          outputDir:
            preferences.outputPathMode === "custom"
              ? preferences.outputDir
              : undefined,
          conflictPolicy: preferences.conflictPolicy,
        });

      if (isIndependentBatch) {
        const preparedTasks: TextTranslationTask[] = [];
        for (const file of sourceFiles) {
          const options = buildOptions("independent_files");
          const created = await createTextTranslationTask({
            files: [
              {
                sourcePath: file.sourcePath,
                relativePath: file.relativePath,
                order: 0,
              },
            ],
            options,
            model: runtimeModel,
          });
          if (!created.ok) {
            handleIpcError(created.error, task?.phase);
            return;
          }

          const prepared = await prepareTextTranslationTask({
            taskId: created.data.taskId,
          });
          if (!prepared.ok) {
            handleIpcError(prepared.error, created.data.phase);
            return;
          }
          preparedTasks.push(prepared.data);
        }

        setQueuedTasks(preparedTasks);
        setTask(preparedTasks[0] ?? null);
        setActiveTaskId(preparedTasks[0]?.taskId ?? null);
        showToast(t("translator.messages.prepared_batch", {
          count: preparedTasks.length,
        }), "success");
        return;
      }

      const options = buildOptions(
        sourceFiles.length > 1 ? "ordered_project" : preferences.projectMode,
      );
      const created = await createTextTranslationTask({
        files: sourceFiles.map((file, order) => ({
          sourcePath: file.sourcePath,
          relativePath: file.relativePath,
          order,
        })),
        options,
        model: runtimeModel,
      });
      if (!created.ok) {
        handleIpcError(created.error, task?.phase);
        return;
      }
      setTask(created.data);
      setActiveTaskId(created.data.taskId);

      const prepared = await prepareTextTranslationTask({
        taskId: created.data.taskId,
      });
      if (!prepared.ok) {
        handleIpcError(prepared.error, created.data.phase);
        return;
      }
      setTask(prepared.data);
      showToast(t("translator.messages.prepared"), "success");
    } finally {
      setIsPreparing(false);
    }
  };

  const handleStart = async () => {
    const tasksToStart =
      queuedWaitingTasks.length > 0
        ? queuedWaitingTasks
        : task?.taskId && task.status === "waiting"
          ? [task]
          : [];
    if (tasksToStart.length === 0) return;
    setIsStarting(true);
    setLastError(null);
    try {
      for (const queuedTask of tasksToStart) {
        const started = await startTextTranslationTask({
          taskId: queuedTask.taskId,
        });
        if (!started.ok) {
          const latest = await getTextTranslationTaskDetail({
            taskId: queuedTask.taskId,
          });
          const failedTask = latest.ok && latest.data ? latest.data : null;
          if (failedTask) {
            upsertQueuedTask(failedTask);
          }
          setLastError(
            toUiError(
              started.error,
              failedTask?.phase ?? started.error.phase ?? "translating",
              queuedTask.taskId,
            ),
          );
          showToast(started.error.message, "error");
          continue;
        }
        upsertQueuedTask(started.data);
        const current = useTextTranslatorStore.getState();
        if (
          !current.task ||
          started.data.taskId === current.task.taskId ||
          current.task.status === "failed"
        ) {
          setTask(started.data);
        }
        if (started.data.status === "completed") {
          const revealed = await revealTextTranslationOutput({
            taskId: started.data.taskId,
          });
          if (
            revealed.ok &&
            revealed.data.path &&
            (!current.task || started.data.taskId === current.task.taskId)
          ) {
            setOutputPaths([revealed.data.path]);
          }
        }
        if (
          started.data.status === "partially_completed" ||
          started.data.status === "failed"
        ) {
          const latest = await getTextTranslationTaskDetail({
            taskId: started.data.taskId,
          });
          if (latest.ok && latest.data) {
            upsertQueuedTask(latest.data);
            const latestCurrent = useTextTranslatorStore.getState();
            if (
              !latestCurrent.task ||
              latest.data.taskId === latestCurrent.task.taskId
            ) {
              setTask(latest.data);
            }
          }
        }
      }
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!task?.taskId) return;
    setIsCancelling(true);
    try {
      const result = await cancelTextTranslationTask({ taskId: task.taskId });
      if (!result.ok) {
        handleIpcError(result.error, task.phase);
        return;
      }
      setTask(result.data);
      showToast(t("translator.messages.cancelled"), "success");
    } finally {
      setIsCancelling(false);
    }
  };

  const handleClear = async () => {
    const taskIds = new Set<string>();
    if (task?.taskId && currentStatus !== "running") {
      taskIds.add(task.taskId);
    }
    for (const queuedTask of queuedTasks) {
      if (queuedTask.status !== "running") {
        taskIds.add(queuedTask.taskId);
      }
    }
    for (const taskId of taskIds) {
      await deleteTextTranslationTask({ taskId });
    }
    setSelectedFiles([]);
    setOutputPaths([]);
    clearTask();
    setLastError(null);
  };

  const loadRecoverableTasks = async () => {
    setIsLoadingRecoveries(true);
    try {
      const result = await listRecoverableTextTranslationTasks();
      if (!result.ok) {
        handleIpcError(result.error, task?.phase);
        return;
      }
      setRecoveries(result.data);
    } finally {
      setIsLoadingRecoveries(false);
    }
  };

  const handleOpenRecovery = async () => {
    setRecoveryOpen(true);
    await loadRecoverableTasks();
  };

  const handleResumeRecovery = async (summary: TextTranslationRecoverySummary) => {
    if (!runtimeModel) {
      const message = t("translator.model.missing_desc");
      setLastError({ code: "renderer_error", message, field: "model" });
      showToast(message, "error");
      return;
    }
    setRecoveryActionTaskId(summary.taskId);
    setActiveTaskId(summary.taskId);
    try {
      const result = await resumeTextTranslationTask({
        taskId: summary.taskId,
        model: runtimeModel,
      });
      if (!result.ok) {
        handleIpcError(result.error);
        return;
      }
      setTask(result.data);
      if (result.data.status === "completed") {
        const revealed = await revealTextTranslationOutput({
          taskId: result.data.taskId,
        });
        if (revealed.ok && revealed.data.path) {
          setOutputPaths([revealed.data.path]);
        }
      }
      await loadRecoverableTasks();
    } finally {
      setRecoveryActionTaskId(null);
    }
  };

  const handleRestartRecovery = async (summary: TextTranslationRecoverySummary) => {
    if (!runtimeModel) {
      const message = t("translator.model.missing_desc");
      setLastError({ code: "renderer_error", message, field: "model" });
      showToast(message, "error");
      return;
    }
    setRecoveryActionTaskId(summary.taskId);
    try {
      const result = await restartTextTranslationTask({
        taskId: summary.taskId,
        model: runtimeModel,
      });
      if (!result.ok) {
        handleIpcError(result.error);
        return;
      }
      setTask(result.data);
      setActiveTaskId(result.data.taskId);
      setSelectedFiles(taskFilesToSelectedFiles(result.data));
      setOutputPaths([]);
      await loadRecoverableTasks();
    } finally {
      setRecoveryActionTaskId(null);
    }
  };

  const handleDeleteRecovery = async (summary: TextTranslationRecoverySummary) => {
    setRecoveryActionTaskId(summary.taskId);
    try {
      const result = await deleteTextTranslationTask({
        taskId: summary.taskId,
        deleteWorkspace: true,
      });
      if (!result.ok) {
        handleIpcError(result.error);
        return;
      }
      if (summary.taskId === activeTaskId) {
        clearTask();
        setSelectedFiles([]);
        setOutputPaths([]);
      }
      await loadRecoverableTasks();
    } finally {
      setRecoveryActionTaskId(null);
    }
  };

  const handleRevealRecoveryWorkspace = async (
    summary: TextTranslationRecoverySummary,
  ) => {
    const result = await revealTextTranslationWorkspace({
      taskId: summary.taskId,
    });
    if (result.ok && result.data.path) {
      window.ipcRenderer.invoke("show-item-in-folder", result.data.path);
    }
  };

  const handleRevealOutput = async () => {
    if (!task?.taskId) return;
    const result = await revealTextTranslationOutput({ taskId: task.taskId });
    if (result.ok && result.data.path) {
      window.ipcRenderer.invoke("show-item-in-folder", result.data.path);
      setOutputPaths([result.data.path]);
      return;
    }
    showToast(t("translator.errors.output_not_ready"), "error");
  };

  const handleRevealWorkspace = async () => {
    if (!task?.taskId) return;
    const result = await revealTextTranslationWorkspace({ taskId: task.taskId });
    if (result.ok && result.data.path) {
      window.ipcRenderer.invoke("show-item-in-folder", result.data.path);
    }
  };

  const handleSelectOutputPath = async () => {
    const result = await window.ipcRenderer.invoke("select-output-directory", {
      title: t("translator.dialog.select_output_title"),
      buttonLabel: t("translator.dialog.select_output_confirm"),
    });
    if (result && !result.canceled && result.filePaths.length > 0) {
      updatePreferences({ outputDir: result.filePaths[0] });
      showToast(t("translator.messages.output_path_selected"), "success");
    }
  };

  const handleIpcError = (
    error: TextTranslationIpcError,
    phase?: TextTranslationPhase,
  ) => {
    setLastError(toUiError(error, phase));
    showToast(error.message, "error");
  };

  return (
    <ToolDetailLayout
      header={
        <ToolPageHeader
          meta={meta}
          title={t("translator.title")}
          description={t("translator.description")}
          right={
            <Badge
              variant={hasUsableTaskModel ? "secondary" : "outline"}
              className="h-7 whitespace-nowrap"
            >
              {hasUsableTaskModel
                ? t("translator.badges.ready")
                : t("translator.badges.no_model")}
            </Badge>
          }
        />
      }
      aside={
        <ConfigPanel
          preferences={preferences}
          updatePreferences={updatePreferences}
          disabled={isBusy}
          sourceLanguages={sourceLanguages}
          targetLanguages={targetLanguages}
          budgetUsagePercent={budgetUsagePercent}
          isBudgetExceeded={isBudgetExceeded}
          requiredContextTokens={requiredContextTokens}
          outputTokenReserve={outputTokenReserve}
          onSelectOutputPath={handleSelectOutputPath}
        />
      }
    >
      <TaskPanel
        sourceFiles={sourceFiles}
        sourceFile={sourceFile}
        isDragging={isDragging}
        setIsDragging={setIsDragging}
        task={task}
        queuedTasks={queuedTasks}
        queuedWaitingTasks={queuedWaitingTasks}
        currentStatus={currentStatus}
        currentPhase={currentPhase}
        isPrepared={isPrepared}
        isRunning={isRunning}
        isBusy={isBusy}
        isPreparing={isPreparing}
        isStarting={isStarting}
        hasUsableTaskModel={hasUsableTaskModel}
        hasMarkdownFiles={hasMarkdownFiles}
        isOrderedProject={isOrderedProject}
        canPrepare={canPrepare}
        canStart={canStart}
        canCancel={canCancel}
        canRevealOutput={canRevealOutput}
        visibleLastError={visibleLastError}
        estimatedCost={estimatedCost}
        summaryItems={[
          <span>
            {sourceFiles.length > 0
              ? t("translator.file.selected_count", {
                  count: sourceFiles.length,
                })
              : `${t("translator.queue.files_label")} 0`}
          </span>,
          <span>
            {preferences.projectMode === "ordered_project"
              ? t("translator.project.ordered")
              : t("translator.project.independent")}
          </span>,
          <span>
            {preferences.executionMode === "sequential_context"
              ? t("translator.execution.sequential_context")
              : t("translator.execution.parallel")}
          </span>,
          <span>
            {preferences.outputPathMode === "source"
              ? t("translator.output.source")
              : t("translator.output.custom")}
          </span>,
          <span className="font-mono">
            {hasUsableTaskModel && taskProfile
              ? taskProfile.name || taskProfile.modelKey
              : t("translator.badges.no_model")}
          </span>,
        ]}
        locale={locale}
        fileInputRef={fileInputRef}
        onFiles={handleFiles}
        onClearFiles={() => {
          setSelectedFiles([]);
          clearTask();
          setOutputPaths([]);
        }}
        onMoveFile={moveFile}
        onSetSelectedFiles={setSelectedFiles}
        onSetTask={setTask}
        onSetActiveTaskId={setActiveTaskId}
        onPrepare={handlePrepare}
        onStart={handleStart}
        onCancel={handleCancel}
        onRevealOutput={handleRevealOutput}
        onOpenRecovery={handleOpenRecovery}
        onRevealWorkspace={handleRevealWorkspace}
        onClear={handleClear}
        onNavigateSettings={() => navigate("/setting")}
      />
      <RecoveryDialog
        open={recoveryOpen}
        onOpenChange={setRecoveryOpen}
        recoveries={recoveries}
        loading={isLoadingRecoveries}
        actionTaskId={recoveryActionTaskId}
        onRefresh={loadRecoverableTasks}
        onResume={handleResumeRecovery}
        onRestart={handleRestartRecovery}
        onDelete={handleDeleteRecovery}
        onRevealWorkspace={handleRevealRecoveryWorkspace}
      />
    </ToolDetailLayout>
  );
}

function RecoveryDialog({
  open,
  onOpenChange,
  recoveries,
  loading,
  actionTaskId,
  onRefresh,
  onResume,
  onRestart,
  onDelete,
  onRevealWorkspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recoveries: TextTranslationRecoverySummary[];
  loading: boolean;
  actionTaskId: string | null;
  onRefresh: () => Promise<void>;
  onResume: (summary: TextTranslationRecoverySummary) => Promise<void>;
  onRestart: (summary: TextTranslationRecoverySummary) => Promise<void>;
  onDelete: (summary: TextTranslationRecoverySummary) => Promise<void>;
  onRevealWorkspace: (summary: TextTranslationRecoverySummary) => Promise<void>;
}) {
  const { t } = useTranslation("text");

  return (
    <ScrollableDialog open={open} onOpenChange={onOpenChange} maxWidth="sm:max-w-3xl">
      <ScrollableDialogHeader>
        <DialogTitle>{t("translator.recovery.title")}</DialogTitle>
      </ScrollableDialogHeader>
      <ScrollableDialogContent fadeMasks>
        {loading ? (
          <div className="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground">
            {t("translator.recovery.loading")}
          </div>
        ) : recoveries.length === 0 ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
            <CircleDashed className="mb-3 h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">
              {t("translator.recovery.empty_title")}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t("translator.recovery.empty_desc")}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {recoveries.map((summary) => {
              const isActing = actionTaskId === summary.taskId;
              return (
                <div
                  key={summary.taskId}
                  className="rounded-lg border p-3"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {summary.taskId}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Badge variant="outline">
                          {t(`translator.status.${summary.status}`)}
                        </Badge>
                        <Badge variant={summary.resumable ? "secondary" : "outline"}>
                          {summary.resumable
                            ? t("translator.recovery.resumable")
                            : t("translator.recovery.blocked")}
                        </Badge>
                        <Badge variant="outline">
                          {t(
                            `translator.recovery.source.${summary.sourceStatus ?? "unchecked"}`,
                          )}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {t("translator.recovery.segment_summary", {
                          completed: summary.completedSegmentCount,
                          total: summary.totalSegmentCount,
                          failed: summary.failedSegmentIds.length,
                        })}
                      </div>
                      {summary.blockingReason ? (
                        <div className="mt-1 text-xs text-destructive">
                          {t("translator.recovery.blocking_reason", {
                            reason: summary.blockingReason,
                          })}
                        </div>
                      ) : null}
                      {summary.staleFromSegmentId ? (
                        <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                          {t("translator.recovery.stale_from", {
                            segmentId: summary.staleFromSegmentId,
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onResume(summary)}
                        disabled={!summary.resumable || isActing}
                      >
                        <PlayCircle className="h-4 w-4" />
                        {t("translator.recovery.resume")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onRestart(summary)}
                        disabled={isActing}
                      >
                        <RefreshCw className="h-4 w-4" />
                        {t("translator.recovery.restart")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onRevealWorkspace(summary)}
                        disabled={isActing}
                      >
                        <Folder className="h-4 w-4" />
                        {t("translator.recovery.workspace")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onDelete(summary)}
                        disabled={isActing}
                      >
                        <Trash2 className="h-4 w-4" />
                        {t("translator.recovery.delete")}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollableDialogContent>
      <ScrollableDialogFooter>
        <Button type="button" variant="outline" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
          {t("translator.recovery.refresh")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function hasValidOutputPreference(
  preferences: ReturnType<typeof useTextTranslatorStore.getState>["preferences"],
): boolean {
  return (
    preferences.outputPathMode === "source" ||
    preferences.outputDir.trim().length > 0
  );
}

function taskFilesToSelectedFiles(task: TextTranslationTask | null): SelectedTextFile[] {
  return (task?.files ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((file) => ({
      fileName: file.fileName,
      sourcePath: file.sourcePath,
      format: file.format,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      order: file.order,
      relativePath: file.relativePath,
    }));
}

function moveFile(
  files: SelectedTextFile[],
  index: number,
  direction: -1 | 1,
): SelectedTextFile[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= files.length) return files;
  const next = [...files];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next.map((file, order) => ({ ...file, order }));
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function detectSelectedTextFileFormat(
  fileName: string,
): TextFileFormat | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".txt")) return "txt";
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }
  return null;
}

function parseGlossaryText(text: string): TextTranslationGlossaryEntry[] {
  const entries: TextTranslationGlossaryEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [pair, note] = line.split("#", 2);
    const separator = pair.includes("=>") ? "=>" : ",";
    const [source, target] = pair.split(separator, 2).map((item) => item.trim());
    if (!source || !target) continue;
    entries.push({
      source,
      target,
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
  }
  return entries;
}

function parseIntegerList(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toUiError(
  error: TextTranslationIpcError,
  phase?: TextTranslationPhase,
  taskId?: string,
) {
  return {
    code: error.code,
    message: error.message,
    taskId,
    phase: error.phase ?? phase,
    field: error.field,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value)} ${units[unitIndex]}`;
}

export default TextTranslator;
