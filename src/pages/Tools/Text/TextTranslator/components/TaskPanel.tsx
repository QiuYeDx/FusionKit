import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleDashed,
  FileText,
  Folder,
  FolderOpen,
  History,
  PlayCircle,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  ToolFileDropZone,
  ToolPanel,
  ToolSummaryLine,
  ToolStatBar,
  type ToolStatBarItem,
} from "@/pages/Tools/_shared/ui";
import {
  TEXT_TRANSLATION_RESOURCE_LIMITS,
  type TextFileFormat,
  type TextTranslationPhase,
  type TextTranslationTask,
  type TextTranslationTaskStatus,
} from "@/type/textTranslation";
import { formatCost, formatTokens } from "@/utils/tokenEstimate";

type SelectedTextFile = {
  fileName: string;
  sourcePath: string;
  format: TextFileFormat;
  sizeBytes: number;
  modifiedAt: number;
  order: number;
  relativePath?: string;
};

type UiError = {
  code: string;
  message: string;
  taskId?: string;
  phase?: TextTranslationPhase;
  field?: string;
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

type TaskPanelProps = {
  sourceFiles: SelectedTextFile[];
  sourceFile: SelectedTextFile | null;
  isDragging: boolean;
  setIsDragging: (v: boolean) => void;
  task: TextTranslationTask | null;
  queuedTasks: TextTranslationTask[];
  queuedWaitingTasks: TextTranslationTask[];
  currentStatus: TextTranslationTaskStatus;
  currentPhase: TextTranslationPhase;
  isPrepared: boolean;
  isRunning: boolean;
  isBusy: boolean;
  isPreparing: boolean;
  isStarting: boolean;
  hasUsableTaskModel: boolean;
  hasMarkdownFiles: boolean;
  isOrderedProject: boolean;
  canPrepare: boolean;
  canStart: boolean;
  canCancel: boolean;
  canRevealOutput: boolean;
  visibleLastError: UiError | null;
  estimatedCost: number | null;
  summaryItems: ReactNode[];
  locale: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | File[]) => void;
  onClearFiles: () => void;
  onMoveFile: (
    files: SelectedTextFile[],
    index: number,
    direction: -1 | 1,
  ) => SelectedTextFile[];
  onSetSelectedFiles: (files: SelectedTextFile[]) => void;
  onSetTask: (task: TextTranslationTask) => void;
  onSetActiveTaskId: (id: string) => void;
  onPrepare: () => void;
  onStart: () => void;
  onCancel: () => void;
  onRevealOutput: () => void;
  onOpenRecovery: () => void;
  onRevealWorkspace: () => void;
  onClear: () => void;
  onNavigateSettings: () => void;
};

export default function TaskPanel({
  sourceFiles,
  sourceFile,
  isDragging,
  setIsDragging,
  task,
  queuedTasks,
  queuedWaitingTasks,
  currentStatus,
  currentPhase,
  isPrepared,
  isRunning,
  isBusy,
  isPreparing,
  isStarting,
  hasUsableTaskModel,
  hasMarkdownFiles,
  isOrderedProject,
  canPrepare,
  canStart,
  canCancel,
  canRevealOutput,
  visibleLastError,
  estimatedCost,
  summaryItems,
  locale,
  fileInputRef,
  onFiles,
  onClearFiles,
  onMoveFile,
  onSetSelectedFiles,
  onSetTask,
  onSetActiveTaskId,
  onPrepare,
  onStart,
  onCancel,
  onRevealOutput,
  onOpenRecovery,
  onRevealWorkspace,
  onClear,
  onNavigateSettings,
}: TaskPanelProps) {
  const { t } = useTranslation("text");
  const progress = task?.progress;
  const activeTaskFile =
    task?.files.find((file) => file.fileId === progress?.currentFileId) ??
    task?.files[0] ??
    sourceFile;
  const activeTaskTitle =
    activeTaskFile?.relativePath ??
    activeTaskFile?.fileName ??
    (sourceFiles.length > 1
      ? t("translator.file.selected_count", { count: sourceFiles.length })
      : sourceFile?.fileName) ??
    t("translator.queue.empty_title");
  const progressPercentage = progress?.percentage ?? 0;
  const progressText = `${t("translator.progress.segments", {
    completed: progress?.completedSegments ?? 0,
    total: progress?.totalSegments ?? 0,
  })} · ${progressPercentage}%`;
  const estimatedTokensLabel =
    typeof progress?.estimatedInputTokens === "number"
      ? formatTokens(progress.estimatedInputTokens)
      : t("translator.common.empty_value");
  const estimatedCostLabel =
    estimatedCost === null
      ? t("translator.common.empty_value")
      : formatCost(estimatedCost);
  const statusTone: ToolStatBarItem["tone"] =
    currentStatus === "failed" || currentStatus === "cancelled"
      ? "danger"
      : currentStatus === "completed"
        ? "success"
        : currentStatus === "running" || currentStatus === "preparing"
          ? "warning"
          : "default";
  const primaryStatItems: ToolStatBarItem[] = [
    {
      label: t("translator.queue.status_label"),
      value: t(STATUS_KEYS[currentStatus]),
      tone: statusTone,
    },
    {
      label: t("translator.queue.phase_label"),
      value: t(PHASE_KEYS[currentPhase]),
    },
    {
      label: t("translator.queue.files_label"),
      value: String(sourceFiles.length || task?.files.length || 0),
    },
    {
      label: t("translator.queue.segments_label"),
      value: `${progress?.completedSegments ?? 0}/${progress?.totalSegments ?? 0}`,
    },
  ];
  const detailStatItems: ToolStatBarItem[] = [
    {
      label: t("translator.progress.tokens", { tokens: "" }).trim(),
      value: estimatedTokensLabel,
      tone: "muted",
    },
    {
      label: t("translator.progress.cost", { cost: "" }).trim(),
      value: estimatedCostLabel,
      tone: estimatedCost === null ? "muted" : "success",
    },
    {
      label: t("translator.file.size"),
      value: sourceFile
        ? formatBytes(sourceFile.sizeBytes, locale)
        : t("translator.common.empty_value"),
      tone: "muted",
    },
    {
      label: t("translator.file.encoding"),
      value:
        task?.files[0]?.detectedEncoding ?? t("translator.common.empty_value"),
      tone: "muted",
    },
    {
      label: t("translator.file.confidence"),
      value:
        typeof task?.files[0]?.encodingConfidence === "number"
          ? `${Math.round(task.files[0].encodingConfidence * 100)}%`
          : t("translator.common.empty_value"),
      tone: "muted",
    },
  ];

  return (
    <>
      <ToolFileDropZone
        id="text-translator-upload-zone"
        inputRef={fileInputRef}
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        multiple
        dragging={isDragging}
        disabled={isBusy}
        onDraggingChange={setIsDragging}
        onFiles={(files) => onFiles(files)}
        icon={
          sourceFile ? (
            <FileText className="h-5 w-5" />
          ) : (
            <Upload className="h-5 w-5" />
          )
        }
        title={
          sourceFile
            ? sourceFiles.length === 1
              ? sourceFile.fileName
              : t("translator.file.selected_count", {
                  count: sourceFiles.length,
                })
            : t("translator.file.drop_title")
        }
        description={
          sourceFile
            ? sourceFiles.length === 1
              ? sourceFile.sourcePath
              : t("translator.file.order_hint")
            : t("translator.file.drop_desc")
        }
        actionLabel={t("translator.actions.select_file")}
        secondaryAction={
          sourceFile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClearFiles();
              }}
              disabled={isBusy}
            >
              <X className="h-3.5 w-3.5" />
              {t("translator.actions.remove_file")}
            </Button>
          ) : null
        }
      />

      <ToolSummaryLine items={summaryItems} />

      <ToolPanel
        id="text-translator-task-panel"
        title={t("translator.queue.title")}
        badge={
          <Badge variant="secondary" className="font-mono text-[11px]">
            {queuedTasks.length > 0 ? queuedTasks.length : sourceFiles.length}
          </Badge>
        }
        actions={
          <>
            <Button
              type="button"
              size="sm"
              onClick={onPrepare}
              disabled={!canPrepare}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {isPreparing
                ? t("translator.actions.preparing")
                : t("translator.actions.prepare")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onStart}
              disabled={!canStart}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              {isStarting
                ? t("translator.actions.running")
                : t("translator.actions.start")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={!canCancel}
            >
              <X className="h-3.5 w-3.5" />
              {t("translator.actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRevealOutput}
              disabled={!canRevealOutput}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("translator.actions.open_output")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenRecovery}
            >
              <History className="h-3.5 w-3.5" />
              {t("translator.actions.recovery")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onRevealWorkspace}
              disabled={!task?.taskId}
              aria-label={t("translator.actions.open_workspace")}
              title={t("translator.actions.open_workspace")}
            >
              <Folder className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClear}
              disabled={isRunning}
              aria-label={t("translator.actions.clear")}
              title={t("translator.actions.clear")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        }
        bodyClassName="space-y-4 p-4"
      >
        <p className="text-sm text-muted-foreground">
          {sourceFile
            ? t("translator.queue.ready_desc")
            : t("translator.queue.desc")}
        </p>

        {visibleLastError ? (
          <Alert variant="destructive" className="rounded-lg">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("translator.errors.title")}</AlertTitle>
            <AlertDescription>
              <div>{visibleLastError.message}</div>
              {visibleLastError.phase ? (
                <div className="text-xs">
                  {t("translator.errors.phase", {
                    phase: t(PHASE_KEYS[visibleLastError.phase]),
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
                onClick={onNavigateSettings}
              >
                <Settings className="h-4 w-4" />
                {t("translator.model.configure")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {hasMarkdownFiles ? (
          <Alert className="rounded-lg">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("translator.scope.markdown_title")}</AlertTitle>
            <AlertDescription>
              {t("translator.scope.markdown_desc", {
                softLimit: formatBytes(
                  TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileSoftWarningBytes,
                  locale,
                ),
                hardLimit: formatBytes(
                  TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileHardLimitBytes,
                  locale,
                ),
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        {!isPrepared && sourceFile ? (
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            {t("translator.queue.prepare_hint")}
          </div>
        ) : null}

        {sourceFiles.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-foreground/90">
                {t("translator.project.file_order")}
              </span>
              <Badge
                variant="outline"
                className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
              >
                {isOrderedProject
                  ? t("translator.project.ordered")
                  : t("translator.project.independent")}
              </Badge>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-lg border">
              {sourceFiles.map((file, index) => (
                <div
                  key={`${file.sourcePath}-${index}`}
                  className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
                >
                  <span className="w-5 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px] font-medium">
                      {file.relativePath ?? file.fileName}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{formatBytes(file.sizeBytes, locale)}</span>
                      <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
                      >
                        {file.format === "markdown"
                          ? t("translator.file.markdown")
                          : t("translator.file.txt")}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === 0 || isBusy}
                      onClick={() =>
                        onSetSelectedFiles(onMoveFile(sourceFiles, index, -1))
                      }
                      aria-label={t("translator.project.move_up")}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === sourceFiles.length - 1 || isBusy}
                      onClick={() =>
                        onSetSelectedFiles(onMoveFile(sourceFiles, index, 1))
                      }
                      aria-label={t("translator.project.move_down")}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {queuedTasks.length > 1 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-foreground/90">
                {t("translator.queue.batch_title")}
              </span>
              <Badge
                variant="outline"
                className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
              >
                {t("translator.queue.waiting_tasks", {
                  count: queuedWaitingTasks.length,
                })}
              </Badge>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              {queuedTasks.map((qt) => {
                const taskProgressText = `${t("translator.progress.segments", {
                  completed: qt.progress.completedSegments,
                  total: qt.progress.totalSegments,
                })} · ${qt.progress.percentage}%`;
                return (
                  <CompactTaskRow
                    key={qt.taskId}
                    embedded
                    active={qt.taskId === task?.taskId}
                    status={qt.status}
                    title={
                      qt.files[0]?.relativePath ??
                      qt.files[0]?.fileName ??
                      qt.taskId
                    }
                    statusLabel={t(STATUS_KEYS[qt.status])}
                    meta={[
                      t(PHASE_KEYS[qt.phase]),
                      t("translator.progress.segments", {
                        completed: qt.progress.completedSegments,
                        total: qt.progress.totalSegments,
                      }),
                      t("translator.progress.tokens", {
                        tokens:
                          typeof qt.progress.estimatedInputTokens === "number"
                            ? formatTokens(qt.progress.estimatedInputTokens)
                            : t("translator.common.empty_value"),
                      }),
                    ]}
                    progressValue={
                      qt.progress.totalSegments > 0
                        ? qt.progress.percentage
                        : undefined
                    }
                    progressText={taskProgressText}
                    onClick={() => {
                      onSetTask(qt);
                      onSetActiveTaskId(qt.taskId);
                    }}
                  />
                );
              })}
            </div>
          </div>
        ) : sourceFiles.length > 0 || task ? (
          <CompactTaskRow
            active
            status={currentStatus}
            title={activeTaskTitle}
            statusLabel={t(STATUS_KEYS[currentStatus])}
            meta={[
              t(PHASE_KEYS[currentPhase]),
              t("translator.queue.files_label") + ` ${sourceFiles.length}`,
              t("translator.progress.segments", {
                completed: progress?.completedSegments ?? 0,
                total: progress?.totalSegments ?? 0,
              }),
              t("translator.progress.tokens", { tokens: estimatedTokensLabel }),
              t("translator.progress.cost", { cost: estimatedCostLabel }),
            ]}
            progressValue={task ? progressPercentage : undefined}
            progressText={progressText}
            actions={
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onRevealWorkspace}
                  disabled={!task?.taskId}
                  aria-label={t("translator.actions.open_workspace")}
                  title={t("translator.actions.open_workspace")}
                >
                  <Folder className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onRevealOutput}
                  disabled={!canRevealOutput}
                  aria-label={t("translator.actions.open_output")}
                  title={t("translator.actions.open_output")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </>
            }
          />
        ) : (
          <div className="rounded-lg border border-dashed px-4 py-10 text-center">
            <CircleDashed className="mx-auto h-5 w-5 text-muted-foreground/70" />
            <div className="mt-2 text-[13px] font-medium">
              {t("translator.queue.empty_title")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("translator.queue.empty_desc")}
            </p>
          </div>
        )}

        <ToolStatBar items={primaryStatItems} />

        {sourceFile || task ? (
          <ToolStatBar columns={5} items={detailStatItems} />
        ) : null}
      </ToolPanel>
    </>
  );
}

type CompactTaskRowProps = {
  active?: boolean;
  embedded?: boolean;
  status: TextTranslationTaskStatus;
  title: ReactNode;
  statusLabel: ReactNode;
  meta: Array<ReactNode | null | false | undefined>;
  progressValue?: number;
  progressText?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
};

function CompactTaskRow({
  active,
  embedded,
  status,
  title,
  statusLabel,
  meta,
  progressValue,
  progressText,
  actions,
  onClick,
}: CompactTaskRowProps) {
  const visibleMeta = meta.filter(Boolean);
  const showProgress = typeof progressValue === "number";
  const content = (
    <>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            getTaskStatusDotClass(status),
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] font-medium">
              {title}
            </span>
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
            >
              {statusLabel}
            </Badge>
          </div>
          {visibleMeta.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {visibleMeta.map((item, index) => (
                <span key={index} className="inline-flex min-w-0 items-center gap-2">
                  {index > 0 ? (
                    <span className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  ) : null}
                  <span className="min-w-0 truncate">{item}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
      {showProgress ? (
        <div className="mt-2 flex items-center gap-2">
          <Progress value={progressValue} className="h-1 flex-1" />
          {progressText ? (
            <span className="whitespace-nowrap text-right font-mono text-[10.5px] text-muted-foreground">
              {progressText}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const rowClassName = cn(
    "w-full px-4 py-3 text-left transition-colors",
    embedded ? "border-b last:border-b-0" : "rounded-lg border",
    active ? "bg-primary/5" : "bg-background",
    onClick ? "hover:bg-muted/40" : null,
  );

  if (onClick) {
    return (
      <button type="button" className={rowClassName} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={rowClassName}>{content}</div>;
}

function getTaskStatusDotClass(status: TextTranslationTaskStatus) {
  switch (status) {
    case "completed":
      return "bg-emerald-500";
    case "partially_completed":
      return "bg-amber-500";
    case "failed":
    case "cancelled":
      return "bg-destructive";
    case "running":
    case "preparing":
      return "animate-pulse bg-amber-500";
    case "waiting":
      return "bg-sky-500";
    case "paused":
      return "bg-muted-foreground";
    case "not_started":
    default:
      return "bg-muted-foreground/45";
  }
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
