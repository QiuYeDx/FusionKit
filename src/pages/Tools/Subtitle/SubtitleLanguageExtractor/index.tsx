import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  RotateCw,
  FolderOpen,
  PlayCircle,
  Trash2,
  AlertTriangle,
  Info,
  Pencil,
  Settings,
  CircleHelp,
} from "lucide-react";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import {
  ToolConfigDivider,
  ToolConfigPanel,
  ToolDetailLayout,
  ToolField,
  ToolFileDropZone,
  ToolOutputPathPicker,
  ToolPanel,
  ToolSummaryLine,
} from "@/pages/Tools/_shared/ui";
import { Badge } from "@/components/ui/badge";
import {
  EXTRACT_SUPPORTED_LANGUAGES,
  ExtractKeepLanguage,
  OutputConflictPolicy,
  SubtitleExtractorTask,
  SubtitleFileType,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import { getSourceDirFromFile, getFilePathFromFile } from "@/utils/filePath";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Tour, type TourStep } from "@/components/qiuye-ui/tour";

function SubtitleLanguageExtractor() {
  const { t } = useTranslation();

  const [isDragging, setIsDragging] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // 错误详情弹窗
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] =
    useState<SubtitleExtractorTask | null>(null);

  // ---- 从 Store 获取状态与方法 ----
  const {
    keep,
    outputURL,
    outputMode,
    conflictPolicy,
    notStartedTasks,
    pendingTasks,
    resolvedTasks,
    failedTasks,
    setKeep,
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
  } = useSubtitleExtractorStore();

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
  const [editingTask, setEditingTask] = useState<SubtitleExtractorTask | null>(null);
  const [editKeep, setEditKeep] = useState<ExtractKeepLanguage>("ZH");
  const [editConflictPolicy, setEditConflictPolicy] = useState<OutputConflictPolicy>("index");

  // Tour 引导状态（延迟到入场动画结束后再自动打开）
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("subtitle-extractor-tour-done")) return;
    const timer = setTimeout(() => setTourOpen(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        target: "#ext-tour-config",
        title: t("subtitle:extractor.tour.config_title", "提取配置"),
        content: t(
          "subtitle:extractor.tour.config_content",
          "在左侧面板设置提取参数：保留语言、输出路径和冲突策略。配置会自动保存。"
        ),
        placement: "right" as const,
      },
      {
        target: "#ext-tour-keep",
        title: t("subtitle:extractor.tour.keep_title", "保留语言"),
        content: t(
          "subtitle:extractor.tour.keep_content",
          "选择从双语字幕中需要保留的语言。工具将自动识别并提取对应语言的行。"
        ),
        placement: "right" as const,
      },
      {
        target: "#ext-tour-output",
        title: t("subtitle:extractor.tour.output_title", "输出路径"),
        content: t(
          "subtitle:extractor.tour.output_content",
          "选择提取结果的保存位置：指定自定义文件夹，或保存到源文件所在目录。"
        ),
        placement: "right" as const,
      },
      {
        target: "#ext-tour-upload",
        title: t("subtitle:extractor.tour.upload_title", "添加字幕文件"),
        content: t(
          "subtitle:extractor.tour.upload_content",
          "将 .lrc 或 .srt 双语字幕文件拖拽到此处，或点击选择文件。支持批量添加。"
        ),
        placement: "bottom" as const,
      },
      {
        target: "#ext-tour-queue",
        title: t("subtitle:extractor.tour.queue_title", "任务队列"),
        content: t(
          "subtitle:extractor.tour.queue_content",
          "添加的提取任务会在这里展示，可查看状态、编辑配置或删除任务。"
        ),
        placement: "top" as const,
      },
      {
        target: "#ext-tour-start",
        title: t("subtitle:extractor.tour.start_title", "开始提取"),
        content: t(
          "subtitle:extractor.tour.start_content",
          "点击即可一键启动所有待提取任务，完成后在输出路径找到单语结果文件。"
        ),
        placement: "bottom" as const,
      },
    ],
    [t]
  );

  const openErrorModal = (task: SubtitleExtractorTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  const handleDeleteTask = (task: SubtitleExtractorTask) => {
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

  const handleOpenFileLocation = (task: SubtitleExtractorTask) => {
    const filePath =
      task.status === TaskStatus.RESOLVED && task.outputFilePath
        ? task.outputFilePath
        : task.originFileURL;
    window.ipcRenderer.invoke("show-item-in-folder", filePath);
  };

  /** 获取语言的本地化名称 */
  const getLanguageLabel = (code: string): string => {
    const lang = EXTRACT_SUPPORTED_LANGUAGES.find((l) => l.code === code);
    return lang ? t(lang.labelKey) : code;
  };

  const handleOpenEditTask = (task: SubtitleExtractorTask) => {
    setEditingTask(task);
    setEditKeep(task.keep);
    setEditConflictPolicy(task.conflictPolicy || "index");
    setEditTaskOpen(true);
  };

  const handleSaveEditTask = () => {
    if (!editingTask) return;
    updateTask(editingTask.fileName, {
      keep: editKeep,
      conflictPolicy: editConflictPolicy,
    });
    showToast(t("subtitle:extractor.edit_task.saved"), "success");
    setEditTaskOpen(false);
    setEditingTask(null);
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.ipcRenderer.invoke(
        "select-output-directory",
        {
          title: t("subtitle:extractor.dialog.select_output_title"),
          buttonLabel: t("subtitle:extractor.dialog.select_output_confirm"),
        }
      );
      if (result && !result.canceled && result.filePaths.length > 0) {
        setOutputURL(result.filePaths[0]);
        showToast(
          t("subtitle:extractor.infos.output_path_selected"),
          "success"
        );
      }
    } catch {
      showToast(t("subtitle:extractor.errors.path_selection_failed"), "error");
    }
  };

  const handleFileUpload = async (files: FileList) => {
    if (outputMode === "custom" && !outputURL) {
      showToast(
        t("subtitle:extractor:errors.please_select_output_url"),
        "error"
      );
      return;
    }
    if (!files || files.length === 0) return;

    const existingNames = allTasks.map((t) => t.fileName);

    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      if (i > 0) await new Promise((r) => setTimeout(r, 0));

      const ext = file.name.split(".").pop()?.toUpperCase();
      if (
        !ext ||
        ![SubtitleFileType.LRC, SubtitleFileType.SRT].includes(ext as any)
      ) {
        showToast(
          t("subtitle:extractor:errors.invalid_file_type").replace(
            "{types}",
            ext || "-"
          ),
          "error"
        );
        continue;
      }
      if (existingNames.includes(file.name)) {
        showToast(
          t("subtitle:extractor:errors.duplicate_file").replace(
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
          t("subtitle:extractor:errors.source_path_missing"),
          "error"
        );
        continue;
      }

      try {
        const fileContent = await file.text();
        const fileType = ext as SubtitleFileType;
        const newTask: SubtitleExtractorTask = {
          fileName: file.name,
          fileContent,
          fileType,
          originFileURL: getFilePathFromFile(file) ?? file.name,
          targetFileURL: outputDir,
          keep,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
          conflictPolicy,
        };
        addTask(newTask);
      } catch {
        showToast(
          t("subtitle:extractor:errors.read_file_failed").replace(
            "{file}",
            file.name
          ),
          "error"
        );
      }
    }

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
    <ToolDetailLayout
      header={
        <ToolPageHeader
          meta={TOOL_META.extractor}
          title={t("subtitle:extractor:title")}
          description={t("subtitle:extractor:description")}
          right={
            <>
              <Badge variant="secondary" className="gap-1.5 font-normal">
                <span className="font-mono text-[11px]">
                  {t("subtitle:extractor:fields.keep_language")}:{" "}
                  {getLanguageLabel(keep)}
                </span>
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setTourOpen(true)}
                title={t("subtitle:extractor.tour.trigger", "使用引导")}
              >
                <CircleHelp className="h-4 w-4" />
              </Button>
            </>
          }
        />
      }
      aside={
        <div id="ext-tour-config">
          <ToolConfigPanel
            icon={Settings}
            title={t("subtitle:extractor:config_title")}
          >
            {/* Keep language */}
            <ToolField
              id="ext-tour-keep"
              label={t("subtitle:extractor:fields.keep_language")}
            >
              <Select
                value={keep}
                onValueChange={(v) => setKeep(v as ExtractKeepLanguage)}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXTRACT_SUPPORTED_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      {t(lang.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolField>

            <ToolConfigDivider />

            {/* Output mode */}
            <ToolField
              id="ext-tour-output"
              label={t("subtitle:extractor:fields.output_mode")}
            >
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={outputMode === "custom" ? "default" : "outline"}
                  onClick={() => setOutputMode("custom")}
                >
                  {t("subtitle:extractor:fields.output_mode_custom")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={outputMode === "source" ? "default" : "outline"}
                  onClick={() => setOutputMode("source")}
                >
                  {t("subtitle:extractor:fields.output_mode_source")}
                </Button>
              </ButtonGroup>
              {outputMode === "custom" ? (
                <ToolOutputPathPicker
                  className="mt-2"
                  value={outputURL}
                  placeholder={t(
                    "subtitle:extractor:fields.no_output_path_selected"
                  )}
                  selectLabel={t(
                    "subtitle:extractor:fields.select_output_path"
                  )}
                  onSelect={handleSelectOutputPath}
                />
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("subtitle:extractor:fields.output_mode_source_hint")}
                </p>
              )}
            </ToolField>

            {/* Conflict policy */}
            <ToolField label={t("subtitle:extractor:fields.conflict_policy")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={conflictPolicy === "index" ? "default" : "outline"}
                  onClick={() => setConflictPolicy("index")}
                >
                  {t("subtitle:extractor:fields.conflict_policy_index")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={
                    conflictPolicy === "overwrite" ? "default" : "outline"
                  }
                  onClick={() => setConflictPolicy("overwrite")}
                >
                  {t("subtitle:extractor:fields.conflict_policy_overwrite")}
                </Button>
              </ButtonGroup>
            </ToolField>
          </ToolConfigPanel>
        </div>
      }
    >
      <ToolFileDropZone
        id="ext-tour-upload"
        accept=".lrc,.srt"
        multiple
        dragging={isDragging}
        onDraggingChange={setIsDragging}
        onFiles={handleFileUpload}
        title={t("subtitle:extractor:fields.upload_tips")}
        description={t("subtitle:extractor:fields.files_only")}
        actionLabel={t("subtitle:extractor:fields.select_file")}
      />

      <ToolSummaryLine
        items={[
          <span>
            {t("subtitle:extractor:fields.keep_language")}:{" "}
            <span className="font-mono text-foreground/80">
              {getLanguageLabel(keep)}
            </span>
          </span>,
          <span>
            {t("subtitle:extractor:fields.conflict_policy")}:{" "}
            <span className="text-foreground/80">
              {conflictPolicy === "overwrite"
                ? t("subtitle:extractor:fields.conflict_policy_overwrite")
                : t("subtitle:extractor:fields.conflict_policy_index")}
            </span>
          </span>,
        ]}
      />

      <ToolPanel
        id="ext-tour-queue"
        title={t("subtitle:extractor:task_management")}
        badge={
          <Badge variant="secondary" className="font-mono text-[11px]">
            {allTasks.length}
          </Badge>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={removeAllResolvedTasks}
              disabled={resolvedTasks.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("subtitle:extractor:fields.remove_all_resolved_task")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAllTasks}
              disabled={allTasks.length === 0}
            >
              {t("subtitle:extractor:fields.clear_all_tasks")}
            </Button>
            <Button
              id="ext-tour-start"
              size="sm"
              onClick={startAllTasks}
              disabled={notStartedTasks.length === 0}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              {t("subtitle:extractor:fields.start_all")}
            </Button>
          </>
        }
        bodyClassName="divide-y"
      >
        {allTasks.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("subtitle:extractor:fields.no_tasks")}
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
                        t("subtitle:extractor:task_status.notstarted")}
                      {task.status === TaskStatus.PENDING &&
                        `${t("subtitle:extractor:task_status.pending")} · ${Math.round(
                          task.progress || 0
                        )}%`}
                      {task.status === TaskStatus.RESOLVED &&
                        t("subtitle:extractor:task_status.resolved")}
                      {task.status === TaskStatus.FAILED &&
                        t("subtitle:extractor:task_status.failed")}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{task.fileType}</span>
                    <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                    <span>{getLanguageLabel(task.keep)}</span>
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
                        if (next.has(task.fileName)) next.delete(task.fileName);
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
                      {t("subtitle:extractor.task_detail.file_format")}
                    </span>
                    <span>{task.fileType}</span>
                    <span className="text-muted-foreground">
                      {t("subtitle:extractor.task_detail.keep_language")}
                    </span>
                    <span>{getLanguageLabel(task.keep)}</span>
                    <span className="text-muted-foreground">
                      {t("subtitle:extractor.task_detail.source_file")}
                    </span>
                    <span className="font-mono break-all">
                      {task.originFileURL}
                    </span>
                    <span className="text-muted-foreground">
                      {t("subtitle:extractor.task_detail.output_path")}
                    </span>
                    <span className="font-mono break-all">
                      {task.targetFileURL}
                    </span>
                    <span className="text-muted-foreground">
                      {t("subtitle:extractor.task_detail.conflict_policy")}
                    </span>
                    <span>
                      {task.conflictPolicy === "overwrite"
                        ? t("subtitle:extractor.task_detail.overwrite")
                        : t("subtitle:extractor.task_detail.auto_index")}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </ToolPanel>

      {selectedErrorTask && (
        <ErrorDetailModal
          isOpen={errorModalOpen}
          onClose={closeErrorModal}
          taskName={selectedErrorTask.fileName}
          errorMessage={
            selectedErrorTask.extraInfo?.message ||
            t("subtitle:extractor.error_fallback.unknown")
          }
          errorDetails={
            selectedErrorTask.extraInfo?.error ||
            t("subtitle:extractor.error_fallback.no_detail")
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
              {t("subtitle:extractor.edit_task.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("subtitle:extractor.fields.keep_language")}</Label>
              <Select
                value={editKeep}
                onValueChange={(v) => setEditKeep(v as ExtractKeepLanguage)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXTRACT_SUPPORTED_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      {t(lang.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("subtitle:extractor.fields.conflict_policy")}</Label>
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
                    {t("subtitle:extractor.fields.conflict_policy_index")}
                  </SelectItem>
                  <SelectItem value="overwrite">
                    {t("subtitle:extractor.fields.conflict_policy_overwrite")}
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
          localStorage.setItem("subtitle-extractor-tour-done", "1");
        }}
        onSkip={() => {
          localStorage.setItem("subtitle-extractor-tour-done", "1");
        }}
        maskClosable
        scrollIntoView
      />
    </ToolDetailLayout>
  );
}

export default SubtitleLanguageExtractor;
