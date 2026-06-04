import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleFileType,
  SubtitleSliceType,
  TaskStatus,
  SUPPORTED_LANGUAGES,
  type SubtitleTranslatorTask,
  type TranslationLanguage,
  type TranslationOutputMode,
} from "@/type/subtitle";
import { useTranslation } from "react-i18next";
import { useState, useMemo, useEffect, useRef } from "react";
import {
  RotateCw,
  Folder,
  FolderOpen,
  PlayCircle,
  X,
  Trash2,
  AlertTriangle,
  Cpu,
  ChevronDown,
  Info,
  Pencil,
  CircleHelp,
  ArrowRight,
  Upload,
  Clock,
  Settings,
  History,
} from "lucide-react";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { Badge } from "@/components/ui/badge";
import { showToast } from "@/utils/toast";
import { getSourceDirFromFile, getFilePathFromFile } from "@/utils/filePath";
import useModelStore from "@/store/useModelStore";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatTokens,
  formatCost,
} from "@/utils/tokenEstimate";
import {
  getEstimateWorkerClient,
  buildEstimateKey,
} from "@/services/subtitle/subtitleTokenEstimateWorkerClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Tour, type TourStep } from "@/components/qiuye-ui/tour";
import RecoveryDialog from "./components/RecoveryDialog";

function CostEstimateHelp({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={content}
          className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          type="button"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] leading-relaxed" side="top">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function SubtitleTranslator() {
  const { t } = useTranslation();
  const {
    // fileType,
    sliceType,
    sliceLengthMap,
    outputURL,
    notStartedTaskQueue,
    waitingTaskQueue,
    pendingTaskQueue,
    resolvedTaskQueue,
    failedTaskQueue,
    // setFileType,
    setSliceType,
    setCustomSliceLength,
    setOutputURL,
    addTask,
    startTask,
    retryTask,
    startAllTasks,
    removeAllResolvedTask,
    clearAllTasks,
    cancelTask,
    deleteTask,
    updateTask,
    updateTaskCostEstimate,
  } = useSubtitleTranslatorStore();
  const taskProfile = useModelStore((s) => s.getTaskProfile());

  const [customLengthInput, setCustomLengthInput] = useState(
    sliceLengthMap?.[SubtitleSliceType.CUSTOM]?.toString() || "500"
  );
  const [outputMode, setOutputMode] = useState<OutputPathMode>(() => {
    const raw = localStorage.getItem("subtitle-translator-output-mode");
    return raw === "source" ? "source" : "custom";
  });
  const [conflictPolicy, setConflictPolicy] =
    useState<OutputConflictPolicy>(() => {
      const raw = localStorage.getItem("subtitle-translator-conflict-policy");
      return raw === "overwrite" ? "overwrite" : "index";
    });

  const [concurrentSlices, setConcurrentSlices] = useState<boolean>(() => {
    const raw = localStorage.getItem("subtitle-translator-concurrent-slices");
    return raw === null ? true : raw === "true";
  });

  const [sourceLang, setSourceLang] = useState<TranslationLanguage>(() => {
    const raw = localStorage.getItem("subtitle-translator-source-lang");
    return (raw as TranslationLanguage) || "JA";
  });

  const [targetLang, setTargetLang] = useState<TranslationLanguage>(() => {
    const raw = localStorage.getItem("subtitle-translator-target-lang");
    return (raw as TranslationLanguage) || "ZH";
  });

  const [translationOutputMode, setTranslationOutputMode] =
    useState<TranslationOutputMode>(() => {
      const raw = localStorage.getItem("subtitle-translator-translation-output-mode");
      return raw === "target_only" ? "target_only" : "bilingual";
    });

  const [isDragging, setIsDragging] = useState(false);

  // 错误详情模态框状态
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] =
    useState<SubtitleTranslatorTask | null>(null);

  // 定时开始相关状态
  const [scheduleTime, setScheduleTime] = useState<string>(""); // 本地时间，格式 YYYY-MM-DDTHH:mm
  const [scheduleDate, setScheduleDate] = useState<Date | undefined>(undefined);
  const [scheduleTimeValue, setScheduleTimeValue] = useState<string>("10:00");
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(false);
  const [preventSleep, setPreventSleep] = useState<boolean>(false);
  const [blockerId, setBlockerId] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const hasTriggeredRef = useRef<boolean>(false);
  const intervalRef = useRef<number | null>(null);
  const [isScheduleOpen, setIsScheduleOpen] = useState<boolean>(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // 删除确认弹窗
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // 恢复历史任务弹窗
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);

  // Tour 引导状态（延迟到入场动画结束后再自动打开）
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("subtitle-translator-tour-done")) return;
    const timer = setTimeout(() => setTourOpen(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        target: "#tour-config-panel",
        title: t("subtitle:translator.tour.config_title", "翻译配置面板"),
        content: t(
          "subtitle:translator.tour.config_content",
          "在左侧面板中配置翻译参数，包括语言、输出格式、分片模式和输出路径等。所有配置会自动保存，下次打开时保留。"
        ),
        placement: "right",
      },
      {
        target: "#tour-lang-pair",
        title: t("subtitle:translator.tour.lang_title", "选择翻译语言"),
        content: t(
          "subtitle:translator.tour.lang_content",
          "设置字幕的源语言和目标语言。系统支持日语、英语、中文等多种语言互译。"
        ),
        placement: "right",
      },
      {
        target: "#tour-output-mode",
        title: t("subtitle:translator.tour.output_mode_title", "翻译输出模式"),
        content: t(
          "subtitle:translator.tour.output_mode_content",
          "「双语」模式保留原文并附加译文，「仅译文」模式只输出翻译结果。"
        ),
        placement: "right",
      },
      {
        target: "#tour-slice-mode",
        title: t("subtitle:translator.tour.slice_title", "字幕分片策略"),
        content: t(
          "subtitle:translator.tour.slice_content",
          "字幕会按分片策略拆分后逐片发送给 AI 翻译。可选标准、精细或自定义字数分片。"
        ),
        placement: "right",
      },
      {
        target: "#tour-output-path",
        title: t("subtitle:translator.tour.output_path_title", "输出路径"),
        content: t(
          "subtitle:translator.tour.output_path_content",
          "选择翻译结果的保存位置：指定自定义文件夹，或保存到字幕源文件所在目录。"
        ),
        placement: "right",
      },
      {
        target: "#tour-schedule",
        title: t("subtitle:translator.tour.schedule_title", "定时翻译"),
        content: t(
          "subtitle:translator.tour.schedule_content",
          "可设置定时自动开始翻译，适合在深夜或空闲时段批量处理任务。"
        ),
        placement: "right",
      },
      {
        target: "#tour-upload-zone",
        title: t("subtitle:translator.tour.upload_title", "添加字幕文件"),
        content: t(
          "subtitle:translator.tour.upload_content",
          "将 .lrc 或 .srt 字幕文件拖拽到此处，或点击选择文件。支持同时添加多个文件。"
        ),
        placement: "bottom",
      },
      {
        target: "#tour-task-queue",
        title: t("subtitle:translator.tour.queue_title", "任务队列"),
        content: t(
          "subtitle:translator.tour.queue_content",
          "所有添加的翻译任务会在这里展示。可以查看进度、编辑配置、重试失败任务或删除任务。"
        ),
        placement: "top",
      },
      {
        target: "#tour-start-all-btn",
        title: t("subtitle:translator.tour.start_title", "开始翻译"),
        content: t(
          "subtitle:translator.tour.start_content",
          "点击即可一键启动所有待翻译任务。翻译完成后可在输出路径找到结果文件。"
        ),
        placement: "bottom",
      },
    ],
    [t]
  );

  // 编辑任务配置弹窗
  const [editTaskOpen, setEditTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<SubtitleTranslatorTask | null>(null);
  const [editSourceLang, setEditSourceLang] = useState<TranslationLanguage>("JA");
  const [editTargetLang, setEditTargetLang] = useState<TranslationLanguage>("ZH");
  const [editOutputMode, setEditOutputMode] = useState<TranslationOutputMode>("bilingual");
  const [editSliceType, setEditSliceType] = useState<SubtitleSliceType>(SubtitleSliceType.NORMAL);
  const [editConflictPolicy, setEditConflictPolicy] = useState<OutputConflictPolicy>("index");
  const [editConcurrentSlices, setEditConcurrentSlices] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-translator-output-mode", outputMode);
    } catch {}
  }, [outputMode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "subtitle-translator-conflict-policy",
        conflictPolicy
      );
    } catch {}
  }, [conflictPolicy]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "subtitle-translator-concurrent-slices",
        String(concurrentSlices)
      );
    } catch {}
  }, [concurrentSlices]);

  useEffect(() => {
    if (sourceLang === targetLang) {
      const fallback = SUPPORTED_LANGUAGES.find((l) => l.code !== sourceLang);
      if (fallback) setTargetLang(fallback.code);
    }
  }, [sourceLang, targetLang]);

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-translator-source-lang", sourceLang);
    } catch {}
  }, [sourceLang]);

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-translator-target-lang", targetLang);
    } catch {}
  }, [targetLang]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "subtitle-translator-translation-output-mode",
        translationOutputMode
      );
    } catch {}
  }, [translationOutputMode]);

  const targetEpochMs = useMemo(() => {
    if (!scheduleTime) return NaN;
    const ms = new Date(scheduleTime).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }, [scheduleTime]);

  // 同步日期和时间到 scheduleTime
  useEffect(() => {
    if (scheduleDate && scheduleTimeValue) {
      const year = scheduleDate.getFullYear();
      const month = String(scheduleDate.getMonth() + 1).padStart(2, "0");
      const day = String(scheduleDate.getDate()).padStart(2, "0");
      const dateTimeString = `${year}-${month}-${day}T${scheduleTimeValue}`;
      setScheduleTime(dateTimeString);
    } else {
      setScheduleTime("");
    }
  }, [scheduleDate, scheduleTimeValue]);

  const stopPowerBlocker = async () => {
    try {
      if (blockerId != null) {
        await window.ipcRenderer.invoke("power-blocker-stop", blockerId);
      }
    } catch {}
    setBlockerId(null);
  };

  const startPowerBlockerUntil = async (untilEpochMs: number) => {
    try {
      const res = await window.ipcRenderer.invoke("power-blocker-start", {
        type: "prevent-app-suspension",
        untilEpochMs,
      });
      if (res?.id != null) setBlockerId(res.id as number);
    } catch (e) {
      // 即便失败，不阻塞后续定时
    }
  };

  const resetInterval = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const cancelSchedule = async (showMsg = true) => {
    setScheduleEnabled(false);
    hasTriggeredRef.current = false;
    resetInterval();
    await stopPowerBlocker();
    if (showMsg) showToast(t("subtitle:translator.schedule.schedule_canceled"), "success");
  };

  const tryTriggerStart = async () => {
    if (!scheduleEnabled) return;
    if (!Number.isFinite(targetEpochMs)) return;
    if (hasTriggeredRef.current) return;
    if (Date.now() >= targetEpochMs) {
      hasTriggeredRef.current = true;
      await stopPowerBlocker();
      if (notStartedTaskQueue.length > 0) {
        startAllTasks();
        showToast(t("subtitle:translator.schedule.time_reached_start"), "success");
      } else {
        showToast(t("subtitle:translator.schedule.time_reached_no_tasks"), "default");
      }
      // 结束计划
      setScheduleEnabled(false);
      resetInterval();
    }
  };

  // 定时/倒计时与系统恢复补偿
  useEffect(() => {
    // 清理历史 interval
    resetInterval();

    if (!scheduleEnabled || !Number.isFinite(targetEpochMs)) {
      setRemainingMs(0);
      return;
    }

    // 初始剩余时间
    setRemainingMs(Math.max(0, targetEpochMs - Date.now()));

    // 每秒更新一次并尝试触发
    intervalRef.current = window.setInterval(() => {
      setRemainingMs(Math.max(0, targetEpochMs - Date.now()));
      tryTriggerStart();
    }, 1000);

    // 监听系统恢复事件，补偿睡眠期间错过的触发
    const resumeHandler = () => {
      tryTriggerStart();
    };
    window.ipcRenderer.on("system-resumed", resumeHandler);

    return () => {
      resetInterval();
      window.ipcRenderer.off("system-resumed", resumeHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleEnabled, targetEpochMs]);

  const formatRemaining = (ms: number) => {
    if (!scheduleEnabled || !Number.isFinite(targetEpochMs)) return "--";
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  // 组件卸载清理防睡眠
  useEffect(() => {
    return () => {
      stopPowerBlocker();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计算总的token统计
  const tokenStats = useMemo(() => {
    const allTasks = [
      ...notStartedTaskQueue,
      ...waitingTaskQueue,
      ...pendingTaskQueue,
      ...resolvedTaskQueue,
      ...failedTaskQueue,
    ];

    let totalTokens = 0;
    let totalCost = 0;
    let pendingTokens = 0;
    let pendingCost = 0;

    allTasks.forEach((task) => {
      if (task.costEstimate) {
        totalTokens += task.costEstimate.totalTokens || 0;
        totalCost += task.costEstimate.estimatedCost || 0;

        if (
          task.status === TaskStatus.NOT_STARTED ||
          task.status === TaskStatus.WAITING ||
          task.status === TaskStatus.PENDING
        ) {
          pendingTokens += task.costEstimate.totalTokens || 0;
          pendingCost += task.costEstimate.estimatedCost || 0;
        }
      }
    });

    const hasLoading = allTasks.some((task) => task.costEstimate?.loading);

    return {
      totalTokens,
      totalCost,
      pendingTokens,
      pendingCost,
      taskCount: allTasks.length,
      hasLoading,
    };
  }, [
    notStartedTaskQueue,
    waitingTaskQueue,
    pendingTaskQueue,
    resolvedTaskQueue,
    failedTaskQueue,
  ]);

  const hasRunningTasks =
    pendingTaskQueue.length > 0 || waitingTaskQueue.length > 0;

  const handleDeleteTask = (task: SubtitleTranslatorTask) => {
    getEstimateWorkerClient().cancelByFileName(task.fileName);
    if (
      task.status === TaskStatus.PENDING ||
      task.status === TaskStatus.WAITING
    ) {
      setTaskToDelete(task.fileName);
      setConfirmDeleteOpen(true);
    } else {
      deleteTask(task.fileName);
    }
  };

  const handleClearAllTasks = () => {
    if (hasRunningTasks) {
      setConfirmClearOpen(true);
    } else {
      clearAllTasks();
    }
  };

  const handleOpenFileLocation = (task: SubtitleTranslatorTask) => {
    const filePath =
      task.status === TaskStatus.RESOLVED && task.extraInfo?.outputFilePath
        ? task.extraInfo.outputFilePath
        : task.originFileURL;
    window.ipcRenderer.invoke("show-item-in-folder", filePath);
  };

  const handleOpenEditTask = (task: SubtitleTranslatorTask) => {
    setEditingTask(task);
    setEditSourceLang(task.sourceLang || "JA");
    setEditTargetLang(task.targetLang || "ZH");
    setEditOutputMode(task.translationOutputMode || "bilingual");
    setEditSliceType(task.sliceType);
    setEditConflictPolicy(task.conflictPolicy || "index");
    setEditConcurrentSlices(task.concurrentSlices ?? true);
    setEditTaskOpen(true);
  };

  const handleSaveEditTask = () => {
    if (!editingTask) return;
    const customLen =
      editSliceType === SubtitleSliceType.CUSTOM
        ? sliceLengthMap[SubtitleSliceType.CUSTOM]
        : undefined;

    const loadingCostEstimate = taskProfile
      ? {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          fragmentCount: 0,
          loading: true,
        }
      : editingTask.costEstimate;

    updateTask(editingTask.fileName, {
      sourceLang: editSourceLang,
      targetLang: editTargetLang,
      translationOutputMode: editOutputMode,
      sliceType: editSliceType,
      customSliceLength: customLen,
      conflictPolicy: editConflictPolicy,
      concurrentSlices: editConcurrentSlices,
      costEstimate: loadingCostEstimate,
    });

    if (taskProfile) {
      const fileName = editingTask.fileName;
      const estimateKey = buildEstimateKey(
        fileName,
        editSliceType,
        customLen,
        editSourceLang,
        editTargetLang,
        editOutputMode,
      );

      getEstimateWorkerClient().cancelByFileName(fileName);
      getEstimateWorkerClient().enqueue({
        fileName,
        content: editingTask.fileContent,
        sliceType: editSliceType,
        customSliceLength: customLen,
        tokenPricing: taskProfile.tokenPricing,
        sourceLang: editSourceLang,
        targetLang: editTargetLang,
        translationOutputMode: editOutputMode,
        onResult: (estimate) => {
          const currentKey = buildEstimateKey(
            fileName,
            editSliceType,
            customLen,
            editSourceLang,
            editTargetLang,
            editOutputMode,
          );
          if (currentKey === estimateKey) {
            updateTaskCostEstimate(fileName, estimate);
          }
        },
        onError: (error) => {
          console.error(`[TokenEstimate] edit failed for ${fileName}:`, error);
          updateTaskCostEstimate(fileName, {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            fragmentCount: 0,
            loading: false,
          });
        },
      });
    }

    showToast(t("subtitle:translator.edit_task.saved"), "success");
    setEditTaskOpen(false);
    setEditingTask(null);
  };

  // 打开错误详情模态框
  const openErrorModal = (task: SubtitleTranslatorTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };

  // 关闭错误详情模态框
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  // 选择输出路径
  const handleSelectOutputPath = async () => {
    try {
      // 通过 IPC 调用主进程的目录选择对话框
      const result = await window.ipcRenderer.invoke(
        "select-output-directory",
        {
          title: t("subtitle:translator.dialog.select_output_title"),
          buttonLabel: t("subtitle:translator.dialog.select_output_confirm"),
        }
      );

      if (result && !result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        setOutputURL(selectedPath);
        showToast(
          t("subtitle:translator.infos.output_path_selected"),
          "success"
        );
      }
    } catch (error) {
      showToast(t("subtitle:translator.errors.path_selection_failed"), "error");
    }
  };

  // 处理文件拖入区域的拖拽事件
  const handleDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault(); // 必须阻止默认行为以允许拖放
  };

  // 处理文件拖放事件
  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);

    // 获取拖放的文件
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // 调用文件上传处理函数
      handleFileUpload({
        target: { files },
      } as React.ChangeEvent<HTMLInputElement>);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (outputMode === "custom" && !outputURL) {
      showToast(
        t("subtitle:translator.errors.please_select_output_url"),
        "error"
      );
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // 获取已有的任务文件路径列表
    const existingFileNames = [
      ...notStartedTaskQueue,
      ...waitingTaskQueue,
      ...pendingTaskQueue,
      ...resolvedTaskQueue,
      ...failedTaskQueue,
    ].map((task) => task.fileName);

    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      // 每处理一个文件后让步给事件循环，避免阻塞 UI 更新
      if (i > 0) await new Promise((r) => setTimeout(r, 0));

      const extension = file.name.split(".").pop()?.toUpperCase();

      if (
        !Object.values(SubtitleFileType).includes(extension as SubtitleFileType)
      ) {
        showToast(
          t("subtitle:translator.errors.invalid_file_type").replace(
            "{types}",
            extension || " - "
          ),
          "error"
        );
        continue;
      }

      if (existingFileNames.includes(file.name)) {
        showToast(
          t("subtitle:translator.errors.duplicate_file").replace(
            "{file}",
            file.name
          ),
          "error"
        );
        continue;
      }

      const outputDir =
        outputMode === "source" ? getSourceDirFromFile(file) : outputURL;
      if (!outputDir) {
        showToast(
          t("subtitle:translator.errors.source_path_missing"),
          "error"
        );
        continue;
      }

      try {
        const fileContent = await file.text();

        const customLen =
          sliceType === SubtitleSliceType.CUSTOM
            ? sliceLengthMap[SubtitleSliceType.CUSTOM]
            : undefined;

        const loadingCostEstimate = taskProfile
          ? {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0,
              fragmentCount: 0,
              loading: true,
            }
          : undefined;

        const newTask: SubtitleTranslatorTask = {
          fileName: file.name,
          fileContent,
          sliceType,
          originFileURL: getFilePathFromFile(file) ?? file.name,
          targetFileURL: outputDir,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
          costEstimate: loadingCostEstimate,
          customSliceLength: customLen,

          apiKey: taskProfile?.apiKey ?? "",
          apiModel: taskProfile?.modelKey ?? "",
          endPoint: taskProfile?.baseUrl ?? "",
          sourceLang,
          targetLang,
          translationOutputMode,
          conflictPolicy,
          concurrentSlices,
        };
        addTask(newTask);

        if (taskProfile) {
          const fileName = file.name;
          const estimateKey = buildEstimateKey(
            fileName,
            sliceType,
            customLen,
            sourceLang,
            targetLang,
            translationOutputMode,
          );
          getEstimateWorkerClient().enqueue({
            fileName,
            content: fileContent,
            sliceType,
            customSliceLength: customLen,
            tokenPricing: taskProfile.tokenPricing,
            sourceLang,
            targetLang,
            translationOutputMode,
            onResult: (estimate) => {
              const currentKey = buildEstimateKey(
                fileName,
                sliceType,
                customLen,
                sourceLang,
                targetLang,
                translationOutputMode,
              );
              if (currentKey === estimateKey) {
                updateTaskCostEstimate(fileName, estimate);
              }
            },
            onError: (error) => {
              console.error(
                `[TokenEstimate] failed for ${fileName}:`,
                error,
              );
              updateTaskCostEstimate(fileName, {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                estimatedCost: 0,
                fragmentCount: 0,
                loading: false,
              });
            },
          });
        }
      } catch (error) {
        console.error(t("subtitle:translator.errors.read_file_failed"), error);
        showToast(
          t("subtitle:translator.errors.read_file_failed").replace(
            "{file}",
            file.name
          ),
          "error"
        );
      }
    }

    // 重置 input value，确保同一文件可以再次选择触发 onChange
    if (e.target) e.target.value = "";
  };

  const getTaskStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.NOT_STARTED:
        return "bg-gray-500";
      case TaskStatus.WAITING:
        return "bg-blue-500";
      case TaskStatus.PENDING:
        return "bg-yellow-500";
      case TaskStatus.RESOLVED:
        return "bg-green-500";
      case TaskStatus.FAILED:
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  const formatTaskSliceMode = (task: SubtitleTranslatorTask) => {
    const sliceModeLabel = t(
      `subtitle:translator.slice_types.${task.sliceType.toLowerCase()}`
    );

    if (
      task.sliceType !== SubtitleSliceType.CUSTOM ||
      typeof task.customSliceLength !== "number" ||
      !Number.isFinite(task.customSliceLength)
    ) {
      return sliceModeLabel;
    }

    return `${sliceModeLabel} (${task.customSliceLength}${t(
      "subtitle:translator.new_task_config.chars_suffix"
    )})`;
  };


  const modelDisplay =
    taskProfile?.modelKey ||
    t("subtitle:translator.fields.no_model_selected", "未选择模型");

  const allTasks = [
    ...notStartedTaskQueue,
    ...waitingTaskQueue,
    ...pendingTaskQueue,
    ...resolvedTaskQueue,
    ...failedTaskQueue,
  ];

  return (
    <div className="px-4 sm:px-8 pt-6 pb-[100px] max-w-7xl mx-auto">
      <ToolPageHeader
        meta={TOOL_META.translator}
        title={t("subtitle:translator.title")}
        description={t("subtitle:translator.description")}
        right={
          <>
            <Badge variant="secondary" className="gap-1.5 font-normal">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
              <span className="font-mono text-[11px]">{modelDisplay}</span>
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => setTourOpen(true)}
              title={t("subtitle:translator.tour.trigger", "使用引导")}
            >
              <CircleHelp className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {/* ── Two-column layout ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4 items-start">
        {/* ── Left: sticky config rail ───────────────────── */}
        <aside id="tour-config-panel" className="lg:sticky lg:top-10">
          <Card className="overflow-hidden p-0 gap-0">
            <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border-b">
              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
                {t("subtitle:translator.config_title")}
              </span>
            </div>

            <div className="p-4 space-y-5">
              {/* Language pair */}
              <div id="tour-lang-pair" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:translator.fields.source_language")} →{" "}
                  {t("subtitle:translator.fields.target_language")}
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                  <Select
                    value={sourceLang}
                    onValueChange={(v) =>
                      setSourceLang(v as TranslationLanguage)
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {t(lang.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <Select
                    value={targetLang}
                    onValueChange={(v) =>
                      setTargetLang(v as TranslationLanguage)
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_LANGUAGES.filter(
                        (lang) => lang.code !== sourceLang
                      ).map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {t(lang.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Output mode */}
              <div id="tour-output-mode" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:translator.fields.translation_output_mode")}
                </div>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={
                      translationOutputMode === "bilingual"
                        ? "default"
                        : "outline"
                    }
                    onClick={() => setTranslationOutputMode("bilingual")}
                  >
                    {t("subtitle:translator.fields.output_bilingual")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={
                      translationOutputMode === "target_only"
                        ? "default"
                        : "outline"
                    }
                    onClick={() => setTranslationOutputMode("target_only")}
                  >
                    {t("subtitle:translator.fields.output_target_only")}
                  </Button>
                </ButtonGroup>
              </div>

              {/* Slice */}
              <div id="tour-slice-mode" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:translator.fields.subtitle_slice_mode")}
                </div>
                <ButtonGroup className="w-full">
                  {Object.values(SubtitleSliceType).map((type) => (
                    <Button
                      key={type}
                      size="sm"
                      className="flex-1"
                      variant={sliceType === type ? "default" : "outline"}
                      onClick={() => setSliceType(type as SubtitleSliceType)}
                    >
                      {t(
                        `subtitle:translator.slice_types.${type.toLowerCase()}`
                      )}
                    </Button>
                  ))}
                </ButtonGroup>
                {sliceType === SubtitleSliceType.CUSTOM && (
                  <div className="flex items-center gap-2 pt-1">
                    <Input
                      type="number"
                      className="w-24 h-8 font-mono text-xs"
                      value={customLengthInput}
                      min="100"
                      max="2000"
                      onChange={(e) => {
                        setCustomLengthInput(e.target.value);
                        setCustomSliceLength(Number(e.target.value));
                      }}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {t("subtitle:translator.new_task_config.chars_suffix")} /{" "}
                      {t("subtitle:translator.slice_types.custom")}
                    </span>
                  </div>
                )}
              </div>

              <div className="h-px bg-border -mx-4" />

              {/* Output path */}
              <div id="tour-output-path" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:translator.fields.output_mode")}
                </div>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={outputMode === "custom" ? "default" : "outline"}
                    onClick={() => setOutputMode("custom")}
                  >
                    {t("subtitle:translator.fields.output_mode_custom")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={outputMode === "source" ? "default" : "outline"}
                    onClick={() => setOutputMode("source")}
                  >
                    {t("subtitle:translator.fields.output_mode_source")}
                  </Button>
                </ButtonGroup>
                {outputMode === "custom" ? (
                  <div
                    className="mt-1.5 flex items-center gap-2 p-2 pl-2.5 rounded-md border bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors"
                    onClick={handleSelectOutputPath}
                    title={outputURL || t("subtitle:translator.fields.no_output_path_selected")}
                  >
                    <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-foreground/80">
                      {outputURL ||
                        t(
                          "subtitle:translator.fields.no_output_path_selected"
                        )}
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-primary font-medium hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectOutputPath();
                      }}
                    >
                      {t("subtitle:translator.fields.select_output_path")}
                    </button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t("subtitle:translator.fields.output_mode_source_hint")}
                  </p>
                )}
              </div>

              {/* Conflict policy */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:translator.fields.conflict_policy")}
                </div>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={conflictPolicy === "index" ? "default" : "outline"}
                    onClick={() => setConflictPolicy("index")}
                  >
                    {t("subtitle:translator.fields.conflict_policy_index")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={
                      conflictPolicy === "overwrite" ? "default" : "outline"
                    }
                    onClick={() => setConflictPolicy("overwrite")}
                  >
                    {t("subtitle:translator.fields.conflict_policy_overwrite")}
                  </Button>
                </ButtonGroup>
              </div>

              <div className="h-px bg-border -mx-4" />

              {/* Concurrent slices */}
              <label
                htmlFor="concurrent-slices"
                className={cn(
                  "flex items-start justify-between gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                  concurrentSlices
                    ? "border-primary/40 bg-primary/5"
                    : "hover:bg-accent/40"
                )}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[12.5px] font-medium leading-tight">
                    {t("subtitle:translator.fields.concurrent_slices")}
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    {t("subtitle:translator.fields.concurrent_slices_hint")}
                  </span>
                </div>
                <Checkbox
                  id="concurrent-slices"
                  checked={concurrentSlices}
                  onCheckedChange={(checked) =>
                    setConcurrentSlices(checked as boolean)
                  }
                  className="mt-0.5"
                />
              </label>

              {/* Schedule (collapsible) */}
              <button
                id="tour-schedule"
                type="button"
                onClick={() => setIsScheduleOpen((v) => !v)}
                className="flex items-center justify-between gap-3 w-full rounded-lg border border-dashed p-3 cursor-pointer hover:bg-accent/40 transition-colors text-left"
              >
                <span className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[12.5px] font-medium">
                    {t("subtitle:translator.schedule.title")}
                  </span>
                  {scheduleEnabled && (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                      {formatRemaining(remainingMs)}
                    </Badge>
                  )}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform",
                    isScheduleOpen && "rotate-180"
                  )}
                />
              </button>

              {isScheduleOpen && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">
                        {t("subtitle:translator.schedule.date")}
                      </Label>
                      <Popover
                        open={datePopoverOpen}
                        onOpenChange={setDatePopoverOpen}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-between font-normal text-xs px-2"
                          >
                            <span className="truncate">
                              {scheduleDate
                                ? scheduleDate.toLocaleDateString()
                                : t(
                                    "subtitle:translator.schedule.select_date"
                                  )}
                            </span>
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-auto overflow-hidden p-0"
                          align="start"
                        >
                          <Calendar
                            mode="single"
                            selected={scheduleDate}
                            captionLayout="dropdown"
                            onSelect={(date) => {
                              setScheduleDate(date);
                              setDatePopoverOpen(false);
                            }}
                            disabled={(date) =>
                              date < new Date(new Date().setHours(0, 0, 0, 0))
                            }
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">
                        {t("subtitle:translator.schedule.time")}
                      </Label>
                      <Input
                        type="time"
                        value={scheduleTimeValue}
                        onChange={(e) => setScheduleTimeValue(e.target.value)}
                        className="h-8 text-xs bg-background [&::-webkit-calendar-picker-indicator]:hidden"
                      />
                    </div>
                  </div>

                  <label
                    htmlFor="prevent-sleep"
                    className={cn(
                      "flex items-start gap-2 rounded-md border p-2 cursor-pointer transition-colors",
                      preventSleep
                        ? "border-primary/40 bg-primary/5"
                        : "hover:bg-accent/40"
                    )}
                  >
                    <Checkbox
                      id="prevent-sleep"
                      checked={preventSleep}
                      onCheckedChange={(checked) =>
                        setPreventSleep(checked as boolean)
                      }
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[11.5px] font-medium leading-tight">
                        {t(
                          "subtitle:translator.schedule.prevent_sleep_until_start"
                        )}
                      </span>
                      <span className="text-[10.5px] text-muted-foreground leading-snug">
                        {t("subtitle:translator.schedule.prevent_sleep_note")}
                      </span>
                    </div>
                  </label>

                  <div className="flex items-center gap-2">
                    {!scheduleEnabled ? (
                      <Button
                        size="sm"
                        className="flex-1"
                        variant={
                          !scheduleTime || !Number.isFinite(targetEpochMs)
                            ? "outline"
                            : "default"
                        }
                        disabled={
                          !scheduleTime || !Number.isFinite(targetEpochMs)
                        }
                        onClick={async () => {
                          if (!scheduleTime || !Number.isFinite(targetEpochMs))
                            return;
                          if (targetEpochMs <= Date.now()) {
                            showToast(
                              t(
                                "subtitle:translator.schedule.choose_future_time"
                              ),
                              "default"
                            );
                            return;
                          }
                          hasTriggeredRef.current = false;
                          setScheduleEnabled(true);
                          if (preventSleep)
                            await startPowerBlockerUntil(targetEpochMs);
                          showToast(
                            t("subtitle:translator.schedule.scheduled_set"),
                            "success"
                          );
                        }}
                      >
                        {t("subtitle:translator.schedule.enable")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => cancelSchedule()}
                      >
                        {t("subtitle:translator.schedule.cancel")}
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/40 text-[11px]">
                    <span className="font-medium text-muted-foreground">
                      {t("subtitle:translator.schedule.status")}
                    </span>
                    {scheduleEnabled ? (
                      <>
                        <span className="font-mono text-foreground">
                          {formatRemaining(remainingMs)}
                        </span>
                        {blockerId != null && (
                          <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            {t("subtitle:translator.schedule.sleep_blocker_on")}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("subtitle:translator.schedule.disabled")}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </aside>

        {/* ── Right: main column ─────────────────────────── */}
        <main className="flex flex-col gap-3 min-w-0">
          {/* Drop zone */}
          <label
            id="tour-upload-zone"
            className={cn(
              "relative flex items-center gap-4 rounded-xl border-2 border-dashed px-5 py-5 cursor-pointer transition-colors",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40"
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              type="file"
              multiple
              className="hidden"
              accept=".lrc,.srt"
              onChange={handleFileUpload}
            />
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70">
              {isDragging ? (
                <FolderOpen className="h-5 w-5" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">
                {isDragging
                  ? t("subtitle:translator.fields.upload_tips_dragging", "释放以添加字幕文件")
                  : t("subtitle:translator.fields.upload_tips")}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t("subtitle:translator.fields.files_only").replace(
                  "{formats}",
                  ".lrc, .srt"
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                (e.currentTarget.parentElement?.querySelector(
                  "input[type=file]"
                ) as HTMLInputElement | null)?.click();
              }}
            >
              <Folder className="h-3.5 w-3.5" />
              {t("subtitle:translator.fields.select_file")}
            </Button>
          </label>

          {/* Current task pricing chip line */}
          {taskProfile && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground px-1">
              <span className="font-mono">
                {t(`subtitle:translator.languages.${sourceLang}`)} →{" "}
                {t(`subtitle:translator.languages.${targetLang}`)}
              </span>
              <span className="opacity-50">·</span>
              <span>
                {translationOutputMode === "bilingual"
                  ? t("subtitle:translator.fields.output_bilingual")
                  : t("subtitle:translator.fields.output_target_only")}
              </span>
              <span className="opacity-50">·</span>
              <span>
                {t(`subtitle:translator.slice_types.${sliceType.toLowerCase()}`)}
                {sliceType === SubtitleSliceType.CUSTOM &&
                  ` (${sliceLengthMap[SubtitleSliceType.CUSTOM]}${t(
                    "subtitle:translator.new_task_config.chars_suffix"
                  )})`}
              </span>
              <span className="opacity-50">·</span>
              <span className="font-mono">
                $
                {(taskProfile.tokenPricing.inputTokensPerMillion ?? 0).toFixed(
                  2
                )}{" "}
                / $
                {(taskProfile.tokenPricing.outputTokensPerMillion ?? 0).toFixed(
                  2
                )}{" "}
                {t("subtitle:translator.new_task_config.rate_suffix")}
              </span>
            </div>
          )}

          {/* Task queue */}
          <Card id="tour-task-queue" className="overflow-hidden p-0 gap-0">
            <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 space-y-0 border-b">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[13.5px] font-semibold">
                  {t("subtitle:translator.task_management")}
                </CardTitle>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {allTasks.length}
                </Badge>
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRecoveryDialogOpen(true)}
                >
                  <History className="h-3.5 w-3.5" />
                  {t("subtitle:translator.recovery.title")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => removeAllResolvedTask()}
                  disabled={resolvedTaskQueue.length === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("subtitle:translator.fields.remove_all_resolved_task")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearAllTasks}
                  disabled={allTasks.length === 0}
                >
                  {t("subtitle:translator.fields.clear_all_tasks")}
                </Button>
                <Button
                  id="tour-start-all-btn"
                  size="sm"
                  onClick={() => startAllTasks()}
                  disabled={notStartedTaskQueue.length === 0}
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  {t("subtitle:translator.fields.start_all")}
                </Button>
              </div>
            </CardHeader>

            <div className="divide-y">
              {allTasks.length === 0 ? (
                <div className="text-center py-10 text-sm text-muted-foreground">
                  {t("subtitle:translator.fields.no_tasks")}
                </div>
              ) : (
                allTasks.map((task) => (
                  <div key={task.fileName} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          "mt-1 w-2.5 h-2.5 rounded-full shrink-0",
                          getTaskStatusColor(task.status)
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[13px] font-medium truncate">
                            {task.fileName}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] h-4 px-1.5 font-normal shrink-0"
                          >
                            {t(
                              `subtitle:translator.task_status.${task.status.toLowerCase()}`
                            )}
                            {task.status === TaskStatus.PENDING &&
                              ` · ${task.totalFragments ? `${task.resolvedFragments ?? 0}/${task.totalFragments} · ` : ""}${Math.round(task.progress || 0)}%`}
                          </Badge>
                        </div>
                        <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            {t(
                              `subtitle:translator.languages.${task.sourceLang || "JA"}`
                            )}{" "}
                            →{" "}
                            {t(
                              `subtitle:translator.languages.${task.targetLang || "ZH"}`
                            )}
                          </span>
                          <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                          <span>
                            {task.translationOutputMode === "target_only"
                              ? t(
                                  "subtitle:translator.fields.output_target_only"
                                )
                              : t(
                                  "subtitle:translator.fields.output_bilingual"
                                )}
                          </span>
                          <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                          <span>{formatTaskSliceMode(task)}</span>
                          {task.costEstimate && (
                            <>
                              <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                              <span className="font-mono inline-flex items-center gap-1">
                                {task.costEstimate.loading && (
                                  <RotateCw className="h-3 w-3 animate-spin text-muted-foreground/60" />
                                )}
                                {formatTokens(task.costEstimate.totalTokens)}
                              </span>
                              <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                              <span className="font-mono inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                                ~{formatCost(task.costEstimate.estimatedCost)}
                                <CostEstimateHelp
                                  content={t(
                                    "subtitle:translator.token_stats.cost_tooltip"
                                  )}
                                />
                              </span>
                            </>
                          )}
                          {task.status === TaskStatus.RESOLVED &&
                            task.extraInfo?.outputFilePath && (
                              <>
                                <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                                <span className="font-mono text-emerald-600 dark:text-emerald-400 truncate max-w-[220px]">
                                  → {task.extraInfo.outputFilePath}
                                </span>
                              </>
                            )}
                        </div>
                      </div>

                      <ButtonGroup className="shrink-0">
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            setExpandedTasks((prev) => {
                              const next = new Set(prev);
                              if (next.has(task.fileName))
                                next.delete(task.fileName);
                              else next.add(task.fileName);
                              return next;
                            });
                          }}
                          title={t("common:action.info", "详情")}
                        >
                          <Info className="h-3.5 w-3.5" />
                        </Button>
                        {task.status === TaskStatus.FAILED && (
                          <Button
                            variant="outline"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => openErrorModal(task)}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {task.status === TaskStatus.FAILED && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => retryTask(task.fileName)}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {task.status === TaskStatus.NOT_STARTED && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => startTask(task.fileName)}
                          >
                            <PlayCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {(task.status === TaskStatus.PENDING ||
                          task.status === TaskStatus.WAITING) && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => cancelTask(task.fileName)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => handleOpenFileLocation(task)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                        {(task.status === TaskStatus.NOT_STARTED ||
                          task.status === TaskStatus.FAILED) && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => handleOpenEditTask(task)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => handleDeleteTask(task)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </ButtonGroup>
                    </div>

                    {task.status === TaskStatus.PENDING && (
                      <div className="mt-2 flex items-center gap-2">
                        <Progress value={task.progress} className="flex-1 h-1" />
                        <span className="font-mono text-[10.5px] text-muted-foreground text-right whitespace-nowrap">
                          {task.totalFragments
                            ? `${task.resolvedFragments ?? 0}/${task.totalFragments} · `
                            : ""}
                          {Math.round(task.progress || 0)}%
                        </span>
                      </div>
                    )}

                    {expandedTasks.has(task.fileName) && (
                      <div className="mt-3 pt-3 border-t border-border/50">
                        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:translator.task_detail.language_pair"
                            )}
                          </span>
                          <span>
                            {t(
                              `subtitle:translator.languages.${task.sourceLang || "JA"}`
                            )}
                            {" → "}
                            {t(
                              `subtitle:translator.languages.${task.targetLang || "ZH"}`
                            )}
                            {" · "}
                            {task.translationOutputMode === "target_only"
                              ? t(
                                  "subtitle:translator.fields.output_target_only"
                                )
                              : t(
                                  "subtitle:translator.fields.output_bilingual"
                                )}
                          </span>
                          <span className="text-muted-foreground">
                            {t("subtitle:translator.task_detail.slice_mode")}
                          </span>
                          <span>{formatTaskSliceMode(task)}</span>
                          <span className="text-muted-foreground">
                            {t("subtitle:translator.task_detail.api_model")}
                          </span>
                          <span className="font-mono">{task.apiModel}</span>
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:translator.task_detail.api_endpoint"
                            )}
                          </span>
                          <span className="font-mono break-all">
                            {task.endPoint}
                          </span>
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:translator.task_detail.output_path"
                            )}
                          </span>
                          <span className="font-mono break-all">
                            {task.targetFileURL}
                          </span>
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:translator.task_detail.conflict_policy"
                            )}
                          </span>
                          <span>
                            {task.conflictPolicy === "overwrite"
                              ? t(
                                  "subtitle:translator.task_detail.overwrite"
                                )
                              : t(
                                  "subtitle:translator.task_detail.auto_index"
                                )}
                          </span>
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:translator.task_detail.concurrent_slices"
                            )}
                          </span>
                          <span>
                            {task.concurrentSlices
                              ? t(
                                  "subtitle:translator.task_detail.concurrent_on"
                                )
                              : t(
                                  "subtitle:translator.task_detail.concurrent_off"
                                )}
                          </span>
                          {task.costEstimate && (
                            <>
                              <span className="text-muted-foreground">
                                {t(
                                  "subtitle:translator.task_detail.fragment_count"
                                )}
                              </span>
                              <span>
                                {task.costEstimate.fragmentCount}{" "}
                                {t(
                                  "subtitle:translator.task_detail.fragment_suffix"
                                )}
                              </span>
                              <span className="text-muted-foreground">
                                {t(
                                  "subtitle:translator.task_detail.token_estimate"
                                )}
                              </span>
                              <span className="font-mono">
                                {t(
                                  "subtitle:translator.task_detail.input"
                                )}{" "}
                                {formatTokens(task.costEstimate.inputTokens)} /{" "}
                                {t(
                                  "subtitle:translator.task_detail.output"
                                )}{" "}
                                {formatTokens(task.costEstimate.outputTokens)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Summary stat bar */}
          {tokenStats.taskCount > 0 && (
            <Card className="p-0">
              <div className="flex items-center gap-2 px-4 py-3 border-b">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
                  {t("subtitle:translator.token_stats.title")}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-0 divide-x divide-y md:divide-y-0">
                <Stat
                  label={t("subtitle:translator.new_task_config.total_tasks")}
                  value={tokenStats.taskCount}
                />
                <Stat
                  label={t("subtitle:translator.token_stats.total_tokens")}
                  value={formatTokens(tokenStats.totalTokens)}
                  loading={tokenStats.hasLoading}
                />
                <Stat
                  label={t("subtitle:translator.token_stats.total_cost")}
                  value={formatCost(tokenStats.totalCost)}
                  accent
                  helpContent={t("subtitle:translator.token_stats.cost_tooltip")}
                />
                <Stat
                  label={t("subtitle:translator.token_stats.pending_cost")}
                  value={formatCost(tokenStats.pendingCost)}
                  tone="warn"
                  helpContent={t("subtitle:translator.token_stats.cost_tooltip")}
                />
              </div>
            </Card>
          )}
        </main>
      </div>

      {/* ── Dialogs ──────────────────────────────────────── */}
      <ErrorDetailModal
        isOpen={errorModalOpen}
        onClose={closeErrorModal}
        taskName={selectedErrorTask?.fileName || ""}
        errorMessage={
          selectedErrorTask?.extraInfo?.message ||
          t("subtitle:translator.error_fallback.unknown")
        }
        errorDetails={
          selectedErrorTask?.extraInfo?.error ||
          t("subtitle:translator.error_fallback.no_detail")
        }
        errorLogs={
          selectedErrorTask?.extraInfo?.errorLogs ||
          selectedErrorTask?.errorLog ||
          []
        }
        timestamp={selectedErrorTask?.extraInfo?.timestamp}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t("common:confirm.delete_running_task_title")}
        description={t("common:confirm.delete_running_task_desc")}
        confirmText={t("common:action.confirm")}
        cancelText={t("common:action.cancel")}
        onConfirm={() => {
          if (taskToDelete) {
            cancelTask(taskToDelete);
            deleteTask(taskToDelete);
            setTaskToDelete(null);
          }
        }}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title={t("common:confirm.clear_running_tasks_title")}
        description={t("common:confirm.clear_running_tasks_desc")}
        confirmText={t("common:action.confirm")}
        cancelText={t("common:action.cancel")}
        onConfirm={clearAllTasks}
      />

      <Dialog open={editTaskOpen} onOpenChange={setEditTaskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("subtitle:translator.edit_task.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>
                  {t("subtitle:translator.fields.source_language")}
                </Label>
                <Select
                  value={editSourceLang}
                  onValueChange={(v) =>
                    setEditSourceLang(v as TranslationLanguage)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {t(lang.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  {t("subtitle:translator.fields.target_language")}
                </Label>
                <Select
                  value={editTargetLang}
                  onValueChange={(v) =>
                    setEditTargetLang(v as TranslationLanguage)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {t(lang.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>
                {t("subtitle:translator.fields.translation_output_mode")}
              </Label>
              <Select
                value={editOutputMode}
                onValueChange={(v) =>
                  setEditOutputMode(v as TranslationOutputMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilingual">
                    {t("subtitle:translator.fields.output_bilingual")}
                  </SelectItem>
                  <SelectItem value="target_only">
                    {t("subtitle:translator.fields.output_target_only")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>
                {t("subtitle:translator.fields.subtitle_slice_mode")}
              </Label>
              <Select
                value={editSliceType}
                onValueChange={(v) =>
                  setEditSliceType(v as SubtitleSliceType)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SubtitleSliceType.NORMAL}>
                    {t("subtitle:translator.slice_types.normal")}
                  </SelectItem>
                  <SelectItem value={SubtitleSliceType.SENSITIVE}>
                    {t("subtitle:translator.slice_types.sensitive")}
                  </SelectItem>
                  <SelectItem value={SubtitleSliceType.CUSTOM}>
                    {t("subtitle:translator.slice_types.custom")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("subtitle:translator.fields.conflict_policy")}</Label>
              <Select
                value={editConflictPolicy}
                onValueChange={(v) =>
                  setEditConflictPolicy(v as OutputConflictPolicy)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="index">
                    {t("subtitle:translator.fields.conflict_policy_index")}
                  </SelectItem>
                  <SelectItem value="overwrite">
                    {t(
                      "subtitle:translator.fields.conflict_policy_overwrite"
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={editConcurrentSlices}
                onCheckedChange={(v) => setEditConcurrentSlices(!!v)}
              />
              <Label>
                {t("subtitle:translator.fields.concurrent_slices")}
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTaskOpen(false)}>
              {t("common:action.cancel")}
            </Button>
            <Button onClick={handleSaveEditTask}>
              {t("common:action.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RecoveryDialog
        open={recoveryDialogOpen}
        onOpenChange={setRecoveryDialogOpen}
      />

      <Tour
        steps={tourSteps}
        open={tourOpen}
        onOpenChange={setTourOpen}
        onFinish={() => {
          localStorage.setItem("subtitle-translator-tour-done", "1");
        }}
        onSkip={() => {
          localStorage.setItem("subtitle-translator-tour-done", "1");
        }}
        maskClosable
        scrollIntoView
      />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  tone,
  loading,
  helpContent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
  tone?: "warn";
  loading?: boolean;
  helpContent?: string;
}) {
  return (
    <div className="px-4 py-3 flex flex-col gap-1">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.05em] text-muted-foreground inline-flex items-center gap-1">
        <span>{label}</span>
        {helpContent && <CostEstimateHelp content={helpContent} />}
      </div>
      <div
        className={cn(
          "font-mono text-lg font-semibold tracking-tight inline-flex items-center gap-1.5",
          accent && "text-primary",
          tone === "warn" && "text-orange-600 dark:text-orange-400"
        )}
      >
        {loading && (
          <RotateCw className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
        )}
        {value}
      </div>
    </div>
  );
}

export default SubtitleTranslator;
