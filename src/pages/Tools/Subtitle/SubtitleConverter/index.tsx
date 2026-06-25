import { useTranslation } from "react-i18next";
import { useState, useMemo, useEffect } from "react";
import {
  RotateCw,
  Folder,
  FolderOpen,
  PlayCircle,
  Trash2,
  AlertTriangle,
  Info,
  Pencil,
  Upload,
  Settings,
  CircleHelp,
} from "lucide-react";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolOutputPathPicker } from "@/pages/Tools/_shared/ui";
import { Badge } from "@/components/ui/badge";
import {
  OutputConflictPolicy,
  SubtitleConverterTask,
  SubtitleFileType,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import { getSourceDirFromFile, getFilePathFromFile } from "@/utils/filePath";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Tour, type TourStep } from "@/components/qiuye-ui/tour";

function SubtitleConverter() {
  const { t } = useTranslation();

  const [isDragging, setIsDragging] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // 错误详情弹窗
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] =
    useState<SubtitleConverterTask | null>(null);

  // ---- 从 Store 获取状态与方法 ----
  const {
    toFormat,
    defaultDurationSec,
    stripMediaExt,
    outputURL,
    outputMode,
    conflictPolicy,
    notStartedTasks,
    pendingTasks,
    resolvedTasks,
    failedTasks,
    setToFormat,
    setDefaultDurationSec,
    setStripMediaExt,
    setOutputURL,
    setOutputMode,
    setConflictPolicy,
    addTask,
    startTask,
    startAllTasks,
    retryTask,
    deleteTask,
    updateTask,
    removeAllResolvedTasks,
    clearAllTasks,
  } = useSubtitleConverterStore();

  const allTasks = [
    ...notStartedTasks,
    ...pendingTasks,
    ...resolvedTasks,
    ...failedTasks,
  ];

  // 删除确认弹窗
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // 编辑任务配置弹窗
  const [editTaskOpen, setEditTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<SubtitleConverterTask | null>(null);
  const [editToFormat, setEditToFormat] = useState<SubtitleFileType>(SubtitleFileType.SRT);
  const [editConflictPolicy, setEditConflictPolicy] = useState<OutputConflictPolicy>("index");

  // Tour 引导状态（延迟到入场动画结束后再自动打开）
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("subtitle-converter-tour-done")) return;
    const timer = setTimeout(() => setTourOpen(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        target: "#cvt-tour-config",
        title: t("subtitle:converter.tour.config_title", "转换配置"),
        content: t(
          "subtitle:converter.tour.config_content",
          "在左侧面板设置转换参数：目标格式、默认时长、输出路径等。配置会自动保存。"
        ),
        placement: "right" as const,
      },
      {
        target: "#cvt-tour-format",
        title: t("subtitle:converter.tour.format_title", "目标格式"),
        content: t(
          "subtitle:converter.tour.format_content",
          "选择要转换的目标字幕格式：LRC（歌词）、SRT（通用字幕）或 VTT（Web 字幕）。"
        ),
        placement: "right" as const,
      },
      {
        target: "#cvt-tour-output",
        title: t("subtitle:converter.tour.output_title", "输出路径"),
        content: t(
          "subtitle:converter.tour.output_content",
          "选择转换结果的保存位置：指定自定义文件夹，或直接保存到源文件所在目录。"
        ),
        placement: "right" as const,
      },
      {
        target: "#cvt-tour-upload",
        title: t("subtitle:converter.tour.upload_title", "添加字幕文件"),
        content: t(
          "subtitle:converter.tour.upload_content",
          "将 .lrc、.srt 或 .vtt 字幕文件拖拽到此处，或点击选择文件。支持批量添加。"
        ),
        placement: "bottom" as const,
      },
      {
        target: "#cvt-tour-queue",
        title: t("subtitle:converter.tour.queue_title", "任务队列"),
        content: t(
          "subtitle:converter.tour.queue_content",
          "添加的转换任务会在这里展示，可查看状态、编辑配置或删除任务。"
        ),
        placement: "top" as const,
      },
      {
        target: "#cvt-tour-start",
        title: t("subtitle:converter.tour.start_title", "开始转换"),
        content: t(
          "subtitle:converter.tour.start_content",
          "点击即可一键启动所有待转换任务，完成后在输出路径找到结果文件。"
        ),
        placement: "bottom" as const,
      },
    ],
    [t]
  );

  const openErrorModal = (task: SubtitleConverterTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  const handleDeleteTask = (task: SubtitleConverterTask) => {
    if (task.status === TaskStatus.PENDING) {
      setTaskToDelete(task.fileName);
      setConfirmDeleteOpen(true);
    } else {
      deleteTask(task.fileName);
    }
  };

  const handleClearAllTasks = () => {
    if (pendingTasks.length > 0) {
      setConfirmClearOpen(true);
    } else {
      clearAllTasks();
    }
  };

  const handleOpenFileLocation = (task: SubtitleConverterTask) => {
    const filePath =
      task.status === TaskStatus.RESOLVED && task.outputFilePath
        ? task.outputFilePath
        : task.originFileURL;
    window.ipcRenderer.invoke("show-item-in-folder", filePath);
  };

  const handleOpenEditTask = (task: SubtitleConverterTask) => {
    setEditingTask(task);
    setEditToFormat(task.to);
    setEditConflictPolicy(task.conflictPolicy || "index");
    setEditTaskOpen(true);
  };

  const handleSaveEditTask = () => {
    if (!editingTask) return;
    updateTask(editingTask.fileName, {
      to: editToFormat,
      conflictPolicy: editConflictPolicy,
    });
    showToast(t("subtitle:converter.edit_task.saved"), "success");
    setEditTaskOpen(false);
    setEditingTask(null);
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.ipcRenderer.invoke(
        "select-output-directory",
        {
          title: t("subtitle:converter.dialog.select_output_title"),
          buttonLabel: t("subtitle:converter.dialog.select_output_confirm"),
        }
      );
      if (result && !result.canceled && result.filePaths.length > 0) {
        setOutputURL(result.filePaths[0]);
        showToast(
          t("subtitle:converter.infos.output_path_selected"),
          "success"
        );
      }
    } catch {
      showToast(t("subtitle:converter.errors.path_selection_failed"), "error");
    }
  };

  const handleDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload({
        target: { files },
      } as React.ChangeEvent<HTMLInputElement>);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (outputMode === "custom" && !outputURL) {
      showToast(
        t("subtitle:converter.errors.please_select_output_url"),
        "error"
      );
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const existingNames = allTasks.map((t) => t.fileName);

    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      if (i > 0) await new Promise((r) => setTimeout(r, 0));

      const ext = file.name.split(".").pop()?.toUpperCase();
      if (
        !ext ||
        ![
          SubtitleFileType.LRC,
          SubtitleFileType.SRT,
          SubtitleFileType.VTT,
        ].includes(ext as any)
      ) {
        showToast(
          t("subtitle:converter.errors.invalid_file_type").replace(
            "{types}",
            ext || "-"
          ),
          "error"
        );
        continue;
      }
      if (existingNames.includes(file.name)) {
        showToast(
          t("subtitle:converter.errors.duplicate_file").replace(
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
          t("subtitle:converter.errors.source_path_missing"),
          "error"
        );
        continue;
      }

      try {
        const fileContent = await file.text();
        const from = ext as SubtitleFileType;

        const newTask: SubtitleConverterTask = {
          fileName: file.name,
          fileContent,
          from,
          to: toFormat,
          originFileURL: getFilePathFromFile(file) ?? file.name,
          targetFileURL: outputDir,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
          conflictPolicy,
        };
        addTask(newTask);
      } catch {
        showToast(
          t("subtitle:converter.errors.read_file_failed").replace(
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


  return (
    <div className="px-4 sm:px-8 pt-6 pb-[100px] max-w-7xl mx-auto">
      <ToolPageHeader
        meta={TOOL_META.converter}
        title={t("subtitle:converter.title")}
        description={t("subtitle:converter.description")}
        right={
          <>
            <Badge variant="secondary" className="gap-1.5 font-normal">
              <span className="font-mono text-[11px]">
                {t("subtitle:converter.fields.target_format")}: {toFormat}
              </span>
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => setTourOpen(true)}
              title={t("subtitle:converter.tour.trigger", "使用引导")}
            >
              <CircleHelp className="h-4 w-4" />
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4 items-start">
        {/* ── Left: sticky config rail ───────────────────── */}
        <aside id="cvt-tour-config" className="lg:sticky lg:top-10">
          <Card className="overflow-hidden p-0 gap-0">
            <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border-b">
              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
                {t("subtitle:converter.config_title")}
              </span>
            </div>

            <div className="p-4 space-y-5">
              {/* Target format */}
              <div id="cvt-tour-format" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:converter.fields.target_format")}
                </div>
                <ButtonGroup className="w-full">
                  {[SubtitleFileType.LRC, SubtitleFileType.SRT, SubtitleFileType.VTT].map(
                    (fmt) => (
                      <Button
                        key={fmt}
                        size="sm"
                        className="flex-1"
                        variant={toFormat === fmt ? "default" : "outline"}
                        onClick={() => setToFormat(fmt)}
                      >
                        {fmt}
                      </Button>
                    )
                  )}
                </ButtonGroup>
              </div>

              {/* Default duration */}
              {toFormat !== SubtitleFileType.LRC && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    {t("subtitle:converter.fields.default_duration_label")}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24 h-8 font-mono text-xs"
                      value={defaultDurationSec}
                      min="1"
                      max="10"
                      onChange={(e) => setDefaultDurationSec(e.target.value)}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {t("subtitle:converter.fields.duration_hint")}
                    </span>
                  </div>
                </div>
              )}

              {/* Strip media ext */}
              <label
                htmlFor="stripMediaExt"
                className={cn(
                  "flex items-start justify-between gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                  stripMediaExt
                    ? "border-primary/40 bg-primary/5"
                    : "hover:bg-accent/40"
                )}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[12.5px] font-medium leading-tight">
                    {t("subtitle:converter.fields.strip_media_ext_label")}
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    {t("subtitle:converter.fields.strip_media_ext_hint")}
                  </span>
                </div>
                <Checkbox
                  id="stripMediaExt"
                  checked={stripMediaExt}
                  onCheckedChange={(v) => setStripMediaExt(Boolean(v))}
                  className="mt-0.5"
                />
              </label>

              <div className="h-px bg-border -mx-4" />

              {/* Output mode */}
              <div id="cvt-tour-output" className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:converter.fields.output_mode")}
                </div>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={outputMode === "custom" ? "default" : "outline"}
                    onClick={() => setOutputMode("custom")}
                  >
                    {t("subtitle:converter.fields.output_mode_custom")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={outputMode === "source" ? "default" : "outline"}
                    onClick={() => setOutputMode("source")}
                  >
                    {t("subtitle:converter.fields.output_mode_source")}
                  </Button>
                </ButtonGroup>
                {outputMode === "custom" ? (
                  <ToolOutputPathPicker
                    className="mt-2"
                    value={outputURL}
                    placeholder={t(
                      "subtitle:converter.fields.no_output_path_selected"
                    )}
                    selectLabel={t(
                      "subtitle:converter.fields.select_output_path"
                    )}
                    onSelect={handleSelectOutputPath}
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t("subtitle:converter.fields.output_mode_source_hint")}
                  </p>
                )}
              </div>

              {/* Conflict policy */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("subtitle:converter.fields.conflict_policy")}
                </div>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={conflictPolicy === "index" ? "default" : "outline"}
                    onClick={() => setConflictPolicy("index")}
                  >
                    {t("subtitle:converter.fields.conflict_policy_index")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={
                      conflictPolicy === "overwrite" ? "default" : "outline"
                    }
                    onClick={() => setConflictPolicy("overwrite")}
                  >
                    {t("subtitle:converter.fields.conflict_policy_overwrite")}
                  </Button>
                </ButtonGroup>
              </div>
            </div>
          </Card>
        </aside>

        {/* ── Right: main column ─────────────────────────── */}
        <main className="flex flex-col gap-3 min-w-0">
          {/* Drop zone */}
          <label
            id="cvt-tour-upload"
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
              accept=".lrc,.srt,.vtt"
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
                {t("subtitle:converter.fields.upload_tips")}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t("subtitle:converter.fields.files_only")}
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
              {t("subtitle:converter.fields.select_file")}
            </Button>
          </label>

          {/* Current target chip line */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground px-1">
            <span>
              {t("subtitle:converter.fields.target_format")}:{" "}
              <span className="font-mono text-foreground/80">{toFormat}</span>
            </span>
            {toFormat !== SubtitleFileType.LRC && (
              <>
                <span className="opacity-50">·</span>
                <span>
                  {t("subtitle:converter.summary.default_duration")}:{" "}
                  <span className="font-mono text-foreground/80">
                    {defaultDurationSec}s
                  </span>
                </span>
              </>
            )}
            <span className="opacity-50">·</span>
            <span>
              {t("subtitle:converter.fields.conflict_policy")}:{" "}
              <span className="text-foreground/80">
                {conflictPolicy === "overwrite"
                  ? t("subtitle:converter.fields.conflict_policy_overwrite")
                  : t("subtitle:converter.fields.conflict_policy_index")}
              </span>
            </span>
          </div>

          {/* Task queue */}
          <Card id="cvt-tour-queue" className="overflow-hidden p-0 gap-0">
            <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 space-y-0 border-b">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[13.5px] font-semibold">
                  {t("subtitle:converter.task_management")}
                </CardTitle>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {allTasks.length}
                </Badge>
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={removeAllResolvedTasks}
                  disabled={resolvedTasks.length === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("subtitle:converter.fields.remove_all_resolved_task")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearAllTasks}
                  disabled={allTasks.length === 0}
                >
                  {t("subtitle:converter.fields.clear_all_tasks")}
                </Button>
                <Button
                  id="cvt-tour-start"
                  size="sm"
                  onClick={startAllTasks}
                  disabled={notStartedTasks.length === 0}
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  {t("subtitle:converter.fields.start_all")}
                </Button>
              </div>
            </CardHeader>

            <div className="divide-y">
              {allTasks.length === 0 ? (
                <div className="text-center py-10 text-sm text-muted-foreground">
                  {t("subtitle:converter.fields.no_tasks")}
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
                            {task.status === TaskStatus.NOT_STARTED &&
                              t("subtitle:converter.task_status.notstarted")}
                            {task.status === TaskStatus.PENDING &&
                              `${t(
                                "subtitle:converter.task_status.pending"
                              )} · ${Math.round(task.progress || 0)}%`}
                            {task.status === TaskStatus.RESOLVED &&
                              t("subtitle:converter.task_status.resolved")}
                            {task.status === TaskStatus.FAILED &&
                              t("subtitle:converter.task_status.failed")}
                          </Badge>
                        </div>
                        <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="font-mono">
                            {task.from} → {task.to}
                          </span>
                          {task.outputFilePath && (
                            <>
                              <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                              <span className="font-mono text-emerald-600 dark:text-emerald-400 truncate max-w-[220px]">
                                → {task.outputFilePath}
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
                        <span className="font-mono text-[10.5px] text-muted-foreground w-8 text-right">
                          {Math.round(task.progress || 0)}%
                        </span>
                      </div>
                    )}

                    {expandedTasks.has(task.fileName) && (
                      <div className="mt-3 pt-3 border-t border-border/50">
                        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:converter.task_detail.conversion_format"
                            )}
                          </span>
                          <span>
                            {task.from} → {task.to}
                          </span>
                          <span className="text-muted-foreground">
                            {t("subtitle:converter.task_detail.source_file")}
                          </span>
                          <span className="font-mono break-all">
                            {task.originFileURL}
                          </span>
                          <span className="text-muted-foreground">
                            {t("subtitle:converter.task_detail.output_path")}
                          </span>
                          <span className="font-mono break-all">
                            {task.targetFileURL}
                          </span>
                          <span className="text-muted-foreground">
                            {t(
                              "subtitle:converter.task_detail.conflict_policy"
                            )}
                          </span>
                          <span>
                            {task.conflictPolicy === "overwrite"
                              ? t("subtitle:converter.task_detail.overwrite")
                              : t("subtitle:converter.task_detail.auto_index")}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>
        </main>
      </div>

      {selectedErrorTask && (
        <ErrorDetailModal
          isOpen={errorModalOpen}
          onClose={closeErrorModal}
          taskName={selectedErrorTask.fileName}
          errorMessage={
            selectedErrorTask.extraInfo?.message ||
            t("subtitle:converter.error_fallback.unknown")
          }
          errorDetails={
            selectedErrorTask.extraInfo?.error ||
            t("subtitle:converter.error_fallback.no_detail")
          }
          errorLogs={selectedErrorTask.errorLog || []}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t("common:confirm.delete_running_task_title")}
        description={t("common:confirm.delete_running_task_desc")}
        confirmText={t("common:action.confirm")}
        cancelText={t("common:action.cancel")}
        onConfirm={() => {
          if (taskToDelete) {
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
              {t("subtitle:converter.edit_task.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("subtitle:converter.fields.target_format")}</Label>
              <Select
                value={editToFormat}
                onValueChange={(v) => setEditToFormat(v as SubtitleFileType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SubtitleFileType.LRC}>LRC</SelectItem>
                  <SelectItem value={SubtitleFileType.SRT}>SRT</SelectItem>
                  <SelectItem value={SubtitleFileType.VTT}>VTT</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("subtitle:converter.fields.conflict_policy")}</Label>
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
                    {t("subtitle:converter.fields.conflict_policy_index")}
                  </SelectItem>
                  <SelectItem value="overwrite">
                    {t("subtitle:converter.fields.conflict_policy_overwrite")}
                  </SelectItem>
                </SelectContent>
              </Select>
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

      <Tour
        steps={tourSteps}
        open={tourOpen}
        onOpenChange={setTourOpen}
        onFinish={() => {
          localStorage.setItem("subtitle-converter-tour-done", "1");
        }}
        onSkip={() => {
          localStorage.setItem("subtitle-converter-tour-done", "1");
        }}
        maskClosable
        scrollIntoView
      />
    </div>
  );
}

export default SubtitleConverter;
