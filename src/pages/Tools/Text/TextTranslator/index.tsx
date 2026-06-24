import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDashed,
  Cpu,
  FileText,
  Files,
  Folder,
  FolderOpen,
  History,
  Languages,
  Layers3,
  PlayCircle,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import useModelStore from "@/store/useModelStore";
import useTextTranslatorStore from "@/store/tools/text/useTextTranslatorStore";
import {
  DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
  DEFAULT_TEXT_TRANSLATION_OPTIONS,
  TEXT_TRANSLATION_TOKEN_LIMITS,
  createTextTranslationOptions,
  estimateTextTranslationRequiredContextTokens,
  resolveTextTranslationOutputTokenReserve,
  type TextTranslationBilingualLabelMode,
  type TextTranslationConflictPolicy,
  type TextTranslationExecutionMode,
  type TextTranslationGlossaryEntry,
  type TextTranslationOutputMode,
  type TextTranslationOutputPathMode,
  type TextTranslationProjectMode,
  type TextTranslationPhase,
  type TextTranslationRecoverySummary,
  type TextTranslationRuntimeModelConfig,
  type TextTranslationTask,
  type TextTranslationTaskStatus,
} from "@/type/textTranslation";
import {
  SUPPORTED_LANGUAGES,
  type TranslationLanguage,
} from "@/type/subtitle";
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
import { formatCost, formatTokens } from "@/utils/tokenEstimate";
import { showToast } from "@/utils/toast";

type SelectedTextFile = {
  fileName: string;
  sourcePath: string;
  sizeBytes: number;
  modifiedAt: number;
  order: number;
  relativePath?: string;
};

const STATUS_KEYS: Record<TextTranslationTaskStatus, string> = {
  not_started: "translator.status.not_started",
  preparing: "translator.status.preparing",
  waiting: "translator.status.waiting",
  running: "translator.status.running",
  paused: "translator.status.paused",
  completed: "translator.status.completed",
  partially_completed: "translator.status.partially_completed",
  failed: "translator.status.failed",
  cancelled: "translator.status.cancelled",
};

const PHASE_KEYS: Record<TextTranslationPhase, string> = {
  idle: "translator.phase.idle",
  inspecting_files: "translator.phase.inspecting_files",
  detecting_encoding: "translator.phase.detecting_encoding",
  parsing: "translator.phase.parsing",
  planning_segments: "translator.phase.planning_segments",
  estimating: "translator.phase.estimating",
  translating: "translator.phase.translating",
  assembling_outputs: "translator.phase.assembling_outputs",
  completed: "translator.phase.completed",
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
  const isSequential = preferences.executionMode === "sequential_context";

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
    return subscribeTextTranslationEvents({
      taskUpdated: (event) => {
        upsertQueuedTask(event.task);
        if (activeTaskId && event.taskId !== activeTaskId) return;
        setTask(event.task);
      },
      progress: (event) => {
        const queuedTask = queuedTasks.find(
          (item) => item.taskId === event.taskId,
        );
        if (queuedTask) {
          upsertQueuedTask({
            ...queuedTask,
            phase: event.progress.phase,
            progress: event.progress,
            updatedAt: event.occurredAt,
          });
        }
        if (!task || event.taskId !== task.taskId) return;
        setTask({
          ...task,
          phase: event.progress.phase,
          progress: event.progress,
          updatedAt: event.occurredAt,
        });
      },
      taskCompleted: (event) => {
        upsertQueuedTask(event.task);
        if (activeTaskId && event.taskId !== activeTaskId) return;
        setTask(event.task);
        setOutputPaths(event.outputPaths);
        showToast(t("translator.messages.completed"), "success");
      },
      taskFailed: (event) => {
        if (activeTaskId && event.taskId !== activeTaskId) return;
        setLastError(toUiError(event.error, task?.phase));
        showToast(event.error.message, "error");
      },
      fileCompleted: (event) => {
        if (activeTaskId && event.taskId !== activeTaskId) return;
        setOutputPaths([event.outputPath]);
      },
    });
  }, [
    activeTaskId,
    queuedTasks,
    setLastError,
    setOutputPaths,
    setTask,
    t,
    task,
    upsertQueuedTask,
  ]);

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
        if (!file.name.toLowerCase().endsWith(".txt")) {
          const message = t("translator.errors.only_txt");
          setLastError({ code: "renderer_error", message, field: "sourcePath" });
          showToast(message, "error");
          return;
        }
        nextFiles.push({
          fileName: file.name,
          sourcePath,
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
          handleIpcError(started.error, queuedTask.phase);
          return;
        }
        upsertQueuedTask(started.data);
        if (!task || started.data.taskId === task.taskId) {
          setTask(started.data);
        }
        if (started.data.status === "completed") {
          const revealed = await revealTextTranslationOutput({
            taskId: started.data.taskId,
          });
          if (
            revealed.ok &&
            revealed.data.path &&
            (!task || started.data.taskId === task.taskId)
          ) {
            setOutputPaths([revealed.data.path]);
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
    <div className="px-4 sm:px-8 pt-6 pb-[100px] max-w-6xl mx-auto">
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

      <div className="grid grid-cols-1 xl:grid-cols-[330px_minmax(0,1fr)_320px] gap-4">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{t("translator.config.title")}</CardTitle>
            <CardDescription>{t("translator.config.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label>{t("translator.config.source_lang")}</Label>
                <Select
                  value={preferences.sourceLang}
                  onValueChange={(value) =>
                    updatePreferences({
                      sourceLang: value as TranslationLanguage | "AUTO",
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceLanguages.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>{t("translator.config.target_lang")}</Label>
                <Select
                  value={preferences.targetLang}
                  onValueChange={(value) =>
                    updatePreferences({
                      targetLang: value as TranslationLanguage,
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targetLanguages.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <Label>{t("translator.config.output_content")}</Label>
              <Select
                value={preferences.outputMode}
                onValueChange={(value) =>
                  updatePreferences({
                    outputMode: value as TextTranslationOutputMode,
                  })
                }
                disabled={isBusy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="target_only">
                    {t("translator.output.target_only")}
                  </SelectItem>
                  <SelectItem value="bilingual">
                    {t("translator.output.bilingual")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {preferences.outputMode === "bilingual" ? (
              <Field>
                <Label>{t("translator.config.bilingual_label_mode")}</Label>
                <Select
                  value={preferences.bilingualLabelMode}
                  onValueChange={(value) =>
                    updatePreferences({
                      bilingualLabelMode:
                        value as TextTranslationBilingualLabelMode,
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("translator.output.bilingual_simple")}
                    </SelectItem>
                    <SelectItem value="labels">
                      {t("translator.output.bilingual_labels")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label>{t("translator.config.execution_mode")}</Label>
                <Select
                  value={preferences.executionMode}
                  onValueChange={(value) =>
                    updatePreferences({
                      executionMode: value as TextTranslationExecutionMode,
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">
                      {t("translator.execution.parallel")}
                    </SelectItem>
                    <SelectItem value="sequential_context">
                      {t("translator.execution.sequential_context")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>{t("translator.config.project_mode")}</Label>
                <Select
                  value={preferences.projectMode}
                  onValueChange={(value) =>
                    updatePreferences({
                      projectMode: value as TextTranslationProjectMode,
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="independent_files">
                      {t("translator.project.independent")}
                    </SelectItem>
                    <SelectItem value="ordered_project">
                      {t("translator.project.ordered")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Alert className="rounded-lg">
              <Languages className="h-4 w-4" />
              <AlertTitle>
                {isSequential
                  ? t("translator.execution.sequential_context")
                  : t("translator.execution.parallel")}
              </AlertTitle>
              <AlertDescription>
                {isSequential
                  ? t("translator.execution.sequential_desc")
                  : t("translator.execution.parallel_desc")}
              </AlertDescription>
            </Alert>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label>{t("translator.config.slice_tokens")}</Label>
                <Input
                  type="number"
                  min={TEXT_TRANSLATION_TOKEN_LIMITS.minSliceTokenLimit}
                  max={TEXT_TRANSLATION_TOKEN_LIMITS.maxSliceTokenLimit}
                  value={preferences.sliceTokenLimit}
                  disabled={isBusy}
                  onChange={(event) =>
                    updatePreferences({
                      sliceTokenLimit: clampInteger(
                        Number(event.target.value),
                        TEXT_TRANSLATION_TOKEN_LIMITS.minSliceTokenLimit,
                        TEXT_TRANSLATION_TOKEN_LIMITS.maxSliceTokenLimit,
                      ),
                    })
                  }
                />
              </Field>
              <Field>
                <Label>{t("translator.config.concurrency")}</Label>
                <Select
                  value={String(preferences.parallelSliceConcurrency)}
                  onValueChange={(value) =>
                    updatePreferences({
                      parallelSliceConcurrency: Number(value),
                    })
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Alert
              className={cn(
                "rounded-lg",
                isBudgetExceeded && "border-destructive/50 text-destructive",
              )}
            >
              <Cpu className="h-4 w-4" />
              <AlertTitle>{t("translator.budget.title")}</AlertTitle>
              <AlertDescription>
                <div className="space-y-3">
                  <p>
                    {isBudgetExceeded
                      ? t("translator.budget.exceeded")
                      : t("translator.budget.within")}
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    <FileDetail
                      label={t("translator.budget.model_context")}
                      value={formatTokens(
                        DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
                      )}
                    />
                    <FileDetail
                      label={t("translator.budget.required")}
                      value={formatTokens(requiredContextTokens)}
                    />
                    <FileDetail
                      label={t("translator.budget.output_reserve")}
                      value={formatTokens(outputTokenReserve)}
                    />
                  </div>
                </div>
              </AlertDescription>
            </Alert>

            {isSequential ? (
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <Label>{t("translator.config.memory_tokens")}</Label>
                  <Input
                    type="number"
                    min={TEXT_TRANSLATION_TOKEN_LIMITS.minSemanticMemoryTokenLimit}
                    value={preferences.semanticMemoryTokenLimit}
                    disabled={isBusy}
                    onChange={(event) =>
                      updatePreferences({
                        semanticMemoryTokenLimit: clampInteger(
                          Number(event.target.value),
                          TEXT_TRANSLATION_TOKEN_LIMITS.minSemanticMemoryTokenLimit,
                          DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
                        ),
                      })
                    }
                  />
                </Field>
                <Field>
                  <Label>{t("translator.config.reset_orders")}</Label>
                  <Input
                    value={preferences.memoryResetFileOrdersText}
                    disabled={isBusy}
                    placeholder={t("translator.project.reset_placeholder")}
                    onChange={(event) =>
                      updatePreferences({
                        memoryResetFileOrdersText: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
            ) : null}

            {isSequential ? (
              <div className="space-y-3">
                <Field>
                  <Label>{t("translator.config.document_background")}</Label>
                  <Textarea
                    value={preferences.documentBackground}
                    disabled={isBusy}
                    rows={3}
                    onChange={(event) =>
                      updatePreferences({ documentBackground: event.target.value })
                    }
                  />
                </Field>
                <Field>
                  <Label>{t("translator.config.translation_instructions")}</Label>
                  <Textarea
                    value={preferences.translationInstructions}
                    disabled={isBusy}
                    rows={3}
                    onChange={(event) =>
                      updatePreferences({
                        translationInstructions: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <Label>{t("translator.config.style_instructions")}</Label>
                  <Textarea
                    value={preferences.styleInstructions}
                    disabled={isBusy}
                    rows={3}
                    onChange={(event) =>
                      updatePreferences({ styleInstructions: event.target.value })
                    }
                  />
                </Field>
                <Field>
                  <Label>{t("translator.config.glossary")}</Label>
                  <Textarea
                    value={preferences.glossaryText}
                    disabled={isBusy}
                    rows={4}
                    placeholder={t("translator.project.glossary_placeholder")}
                    onChange={(event) =>
                      updatePreferences({ glossaryText: event.target.value })
                    }
                  />
                </Field>
              </div>
            ) : null}

            <Field>
              <Label>{t("translator.config.output_mode")}</Label>
              <Select
                value={preferences.outputPathMode}
                onValueChange={(value) =>
                  updatePreferences({
                    outputPathMode: value as TextTranslationOutputPathMode,
                  })
                }
                disabled={isBusy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">
                    {t("translator.output.source")}
                  </SelectItem>
                  <SelectItem value="custom">
                    {t("translator.output.custom")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {preferences.outputPathMode === "custom" ? (
              <Field>
                <Label>{t("translator.config.output_dir")}</Label>
                <div className="flex gap-2">
                  <Input
                    value={preferences.outputDir}
                    readOnly
                    placeholder={t("translator.output.not_selected")}
                    className="min-w-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleSelectOutputPath}
                    disabled={isBusy}
                    aria-label={t("translator.actions.select_output")}
                  >
                    <Folder className="h-4 w-4" />
                  </Button>
                </div>
              </Field>
            ) : null}

            <Field>
              <Label>{t("translator.config.conflict_policy")}</Label>
              <Select
                value={preferences.conflictPolicy}
                onValueChange={(value) =>
                  updatePreferences({
                    conflictPolicy: value as TextTranslationConflictPolicy,
                  })
                }
                disabled={isBusy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="index">
                    {t("translator.output.index")}
                  </SelectItem>
                  <SelectItem value="overwrite">
                    {t("translator.output.overwrite")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{t("translator.queue.title")}</CardTitle>
                <CardDescription className="mt-1">
                  {sourceFile
                    ? t("translator.queue.ready_desc")
                    : t("translator.queue.desc")}
                </CardDescription>
              </div>
              <Badge variant="outline">{t("translator.badges.beta")}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) handleFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setIsDragging(false);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                handleFiles(event.dataTransfer.files);
              }}
              className={cn(
                "flex min-h-[146px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center transition-colors",
                isDragging && "border-primary bg-primary/5",
              )}
            >
              <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                {sourceFile ? (
                  <FileText className="h-6 w-6" />
                ) : (
                  <Upload className="h-6 w-6" />
                )}
              </div>
              {sourceFile ? (
                <>
                  <div className="max-w-full truncate text-sm font-semibold">
                    {sourceFiles.length === 1
                      ? sourceFile.fileName
                      : t("translator.file.selected_count", {
                          count: sourceFiles.length,
                        })}
                  </div>
                  <div className="mt-1 max-w-full truncate text-xs text-muted-foreground">
                    {sourceFiles.length === 1
                      ? sourceFile.sourcePath
                      : t("translator.file.order_hint")}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm font-semibold">
                    {t("translator.file.drop_title")}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("translator.file.drop_desc")}
                  </div>
                </>
              )}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy}
                >
                  <Upload className="h-4 w-4" />
                  {t("translator.actions.select_file")}
                </Button>
                {sourceFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedFiles([]);
                      clearTask();
                      setOutputPaths([]);
                    }}
                    disabled={isBusy}
                  >
                    <X className="h-4 w-4" />
                    {t("translator.actions.remove_file")}
                  </Button>
                ) : null}
              </div>
            </div>

            {sourceFiles.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("translator.project.file_order")}</Label>
                  <Badge variant="outline">
                    {isOrderedProject || sourceFiles.length > 1
                      ? t("translator.project.ordered")
                      : t("translator.project.independent")}
                  </Badge>
                </div>
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
                  {sourceFiles.map((file, index) => (
                    <div
                      key={`${file.sourcePath}-${index}`}
                      className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-2"
                    >
                      <span className="w-6 shrink-0 text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {file.relativePath ?? file.fileName}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {formatBytes(file.sizeBytes, locale)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={index === 0 || isBusy}
                        onClick={() => setSelectedFiles(moveFile(sourceFiles, index, -1))}
                        aria-label={t("translator.project.move_up")}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={index === sourceFiles.length - 1 || isBusy}
                        onClick={() => setSelectedFiles(moveFile(sourceFiles, index, 1))}
                        aria-label={t("translator.project.move_down")}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {queuedTasks.length > 1 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("translator.queue.batch_title")}</Label>
                  <Badge variant="outline">
                    {t("translator.queue.waiting_tasks", {
                      count: queuedWaitingTasks.length,
                    })}
                  </Badge>
                </div>
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
                  {queuedTasks.map((queuedTask) => (
                    <button
                      key={queuedTask.taskId}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors",
                        queuedTask.taskId === task?.taskId
                          ? "bg-primary/10"
                          : "bg-muted/30 hover:bg-muted/50",
                      )}
                      onClick={() => {
                        setTask(queuedTask);
                        setActiveTaskId(queuedTask.taskId);
                      }}
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {queuedTask.files[0]?.relativePath ??
                            queuedTask.files[0]?.fileName ??
                            queuedTask.taskId}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {t("translator.progress.segments", {
                            completed: queuedTask.progress.completedSegments,
                            total: queuedTask.progress.totalSegments,
                          })}
                        </div>
                      </div>
                      <Badge variant="outline">
                        {t(STATUS_KEYS[queuedTask.status])}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric
                icon={<ShieldIcon status={currentStatus} />}
                label={t("translator.queue.status_label")}
                value={t(STATUS_KEYS[currentStatus])}
              />
              <Metric
                icon={<Cpu className="h-4 w-4" />}
                label={t("translator.queue.phase_label")}
                value={t(PHASE_KEYS[currentPhase])}
              />
              <Metric
                icon={<Files className="h-4 w-4" />}
                label={t("translator.queue.files_label")}
                value={String(sourceFiles.length)}
              />
              <Metric
                icon={<Layers3 className="h-4 w-4" />}
                label={t("translator.queue.segments_label")}
                value={String(progress?.totalSegments ?? 0)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("translator.progress.label")}</span>
                <span>{progress?.percentage ?? 0}%</span>
              </div>
              <Progress value={progress?.percentage ?? 0} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("translator.progress.segments", {
                    completed: progress?.completedSegments ?? 0,
                    total: progress?.totalSegments ?? 0,
                  })}
                </span>
                <span>
                  {t("translator.progress.tokens", {
                    tokens: progress?.estimatedInputTokens
                      ? formatTokens(progress.estimatedInputTokens)
                      : t("translator.common.empty_value"),
                  })}
                </span>
                <span>
                  {t("translator.progress.cost", {
                    cost:
                      estimatedCost === null
                        ? t("translator.common.empty_value")
                        : formatCost(estimatedCost),
                  })}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <FileDetail
                label={t("translator.file.size")}
                value={
                  sourceFile
                    ? formatBytes(sourceFile.sizeBytes, locale)
                    : t("translator.common.empty_value")
                }
              />
              <FileDetail
                label={t("translator.file.encoding")}
                value={task?.files[0]?.detectedEncoding ?? t("translator.common.empty_value")}
              />
              <FileDetail
                label={t("translator.file.confidence")}
                value={
                  typeof task?.files[0]?.encodingConfidence === "number"
                    ? `${Math.round(task.files[0].encodingConfidence * 100)}%`
                    : t("translator.common.empty_value")
                }
              />
            </div>

            {lastError ? (
              <Alert variant="destructive" className="rounded-lg">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("translator.errors.title")}</AlertTitle>
                <AlertDescription>
                  <div>{lastError.message}</div>
                  {lastError.phase ? (
                    <div className="text-xs">
                      {t("translator.errors.phase", {
                        phase: t(PHASE_KEYS[lastError.phase]),
                      })}
                    </div>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            {!hasUsableTaskModel ? (
              <Alert className="rounded-lg">
                <Settings className="h-4 w-4" />
                <AlertTitle>{t("translator.model.missing_title")}</AlertTitle>
                <AlertDescription>
                  <p>{t("translator.model.missing_desc")}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => navigate("/setting")}
                  >
                    <Settings className="h-4 w-4" />
                    {t("translator.model.configure")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={handlePrepare}
                disabled={!canPrepare}
              >
                <RefreshCw className="h-4 w-4" />
                {isPreparing
                  ? t("translator.actions.preparing")
                  : t("translator.actions.prepare")}
              </Button>
              <Button
                type="button"
                onClick={handleStart}
                disabled={!canStart}
              >
                <PlayCircle className="h-4 w-4" />
                {isStarting
                  ? t("translator.actions.running")
                  : t("translator.actions.start")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                disabled={!canCancel}
              >
                <X className="h-4 w-4" />
                {t("translator.actions.cancel")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleRevealOutput}
                disabled={!canRevealOutput}
              >
                <FolderOpen className="h-4 w-4" />
                {t("translator.actions.open_output")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleOpenRecovery}
              >
                <History className="h-4 w-4" />
                {t("translator.actions.recovery")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleRevealWorkspace}
                disabled={!task?.taskId}
              >
                <Folder className="h-4 w-4" />
                {t("translator.actions.open_workspace")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleClear}
                disabled={isRunning}
              >
                <Trash2 className="h-4 w-4" />
                {t("translator.actions.clear")}
              </Button>
            </div>

            {!isPrepared && sourceFile ? (
              <p className="text-xs text-muted-foreground">
                {t("translator.queue.prepare_hint")}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>{t("translator.model.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-muted/30">
                  {hasUsableTaskModel ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Settings className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {hasUsableTaskModel
                      ? t("translator.model.ready", {
                          name: taskProfile?.name ?? "",
                        })
                      : t("translator.model.missing_title")}
                  </div>
                  {hasUsableTaskModel ? (
                    <p className="mt-1 truncate text-xs font-mono text-muted-foreground">
                      {taskProfile?.modelKey}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {t("translator.model.missing_desc")}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Alert className="rounded-lg">
            <Sparkles className="h-4 w-4" />
            <AlertTitle>{t("translator.scope.title")}</AlertTitle>
            <AlertDescription>
              {t("translator.scope.coming_next")}
            </AlertDescription>
          </Alert>

          {isSequential ? (
            <Alert className="rounded-lg">
              <Languages className="h-4 w-4" />
              <AlertTitle>{t("translator.project.serial_cost_title")}</AlertTitle>
              <AlertDescription>
                {t("translator.project.serial_cost_desc", {
                  tokens: formatTokens(preferences.semanticMemoryTokenLimit),
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>{t("translator.scope.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                {[
                  t("translator.scope.single_txt"),
                  t("translator.scope.parallel"),
                  t("translator.scope.target_only"),
                ].map((item, index) => (
                  <div key={item}>
                    {index > 0 ? <Separator className="mb-3" /> : null}
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>{item}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
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
    </div>
  );
}

function Field({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border px-3 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function FileDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("translator.recovery.title")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[58vh] overflow-y-auto pr-1">
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
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
            {t("translator.recovery.refresh")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShieldIcon({ status }: { status: TextTranslationTaskStatus }) {
  if (status === "failed") return <AlertTriangle className="h-4 w-4" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  return <CircleDashed className="h-4 w-4" />;
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
) {
  return {
    code: error.code,
    message: error.message,
    phase,
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
