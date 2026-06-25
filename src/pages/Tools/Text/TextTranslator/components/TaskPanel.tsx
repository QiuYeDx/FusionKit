import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
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
  Layers3,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  ToolActionBar,
  ToolStat,
  ToolStatGrid,
  TooltipIconButton,
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

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="text-base">
          {t("translator.queue.title")}
        </CardTitle>
        <CardDescription>
          {sourceFile
            ? t("translator.queue.ready_desc")
            : t("translator.queue.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,text/plain,text/markdown"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Drop zone */}
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            onFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex min-h-[130px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-5 text-center transition-colors",
            isDragging && "border-primary bg-primary/5",
          )}
        >
          <div className="mb-2.5 inline-flex h-10 w-10 items-center justify-center rounded-lg border bg-background text-muted-foreground">
            {sourceFile ? (
              <FileText className="h-5 w-5" />
            ) : (
              <Upload className="h-5 w-5" />
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
              <div className="mt-0.5 max-w-full truncate text-xs text-muted-foreground">
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
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("translator.file.drop_desc")}
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
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
                onClick={onClearFiles}
                disabled={isBusy}
              >
                <X className="h-4 w-4" />
                {t("translator.actions.remove_file")}
              </Button>
            ) : null}
          </div>
        </div>

        {/* File order list */}
        {sourceFiles.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-foreground/90">
                {t("translator.project.file_order")}
              </span>
              <Badge variant="outline">
                {isOrderedProject || sourceFiles.length > 1
                  ? t("translator.project.ordered")
                  : t("translator.project.independent")}
              </Badge>
            </div>
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border p-2">
              {sourceFiles.map((file, index) => (
                <div
                  key={`${file.sourcePath}-${index}`}
                  className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5"
                >
                  <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
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
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {file.format === "markdown"
                      ? t("translator.file.markdown")
                      : t("translator.file.txt")}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
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
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={index === sourceFiles.length - 1 || isBusy}
                    onClick={() =>
                      onSetSelectedFiles(onMoveFile(sourceFiles, index, 1))
                    }
                    aria-label={t("translator.project.move_down")}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Markdown warning */}
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

        {/* Batch task queue */}
        {queuedTasks.length > 1 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-foreground/90">
                {t("translator.queue.batch_title")}
              </span>
              <Badge variant="outline">
                {t("translator.queue.waiting_tasks", {
                  count: queuedWaitingTasks.length,
                })}
              </Badge>
            </div>
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border p-2">
              {queuedTasks.map((qt) => (
                <button
                  key={qt.taskId}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    qt.taskId === task?.taskId
                      ? "bg-primary/10"
                      : "bg-muted/30 hover:bg-muted/50",
                  )}
                  onClick={() => {
                    onSetTask(qt);
                    onSetActiveTaskId(qt.taskId);
                  }}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {qt.files[0]?.relativePath ??
                        qt.files[0]?.fileName ??
                        qt.taskId}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t("translator.progress.segments", {
                        completed: qt.progress.completedSegments,
                        total: qt.progress.totalSegments,
                      })}
                    </div>
                  </div>
                  <Badge variant="outline">
                    {t(STATUS_KEYS[qt.status])}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <Separator />

        {/* Status metrics */}
        <ToolStatGrid columns={4}>
          <ToolStat
            icon={<ShieldIcon status={currentStatus} />}
            label={t("translator.queue.status_label")}
            value={t(STATUS_KEYS[currentStatus])}
            tone={
              currentStatus === "failed"
                ? "danger"
                : currentStatus === "completed"
                  ? "success"
                  : currentStatus === "running"
                    ? "warning"
                    : "default"
            }
          />
          <ToolStat
            icon={<Cpu className="h-3.5 w-3.5" />}
            label={t("translator.queue.phase_label")}
            value={t(PHASE_KEYS[currentPhase])}
          />
          <ToolStat
            icon={<Files className="h-3.5 w-3.5" />}
            label={t("translator.queue.files_label")}
            value={String(sourceFiles.length)}
          />
          <ToolStat
            icon={<Layers3 className="h-3.5 w-3.5" />}
            label={t("translator.queue.segments_label")}
            value={String(progress?.totalSegments ?? 0)}
          />
        </ToolStatGrid>

        {/* Progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("translator.progress.label")}</span>
            <span className="tabular-nums">{progress?.percentage ?? 0}%</span>
          </div>
          <Progress value={progress?.percentage ?? 0} />
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
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

        {/* File details */}
        <ToolStatGrid columns={3}>
          <ToolStat
            label={t("translator.file.size")}
            value={
              sourceFile
                ? formatBytes(sourceFile.sizeBytes, locale)
                : t("translator.common.empty_value")
            }
            tone="muted"
          />
          <ToolStat
            label={t("translator.file.encoding")}
            value={
              task?.files[0]?.detectedEncoding ??
              t("translator.common.empty_value")
            }
            tone="muted"
          />
          <ToolStat
            label={t("translator.file.confidence")}
            value={
              typeof task?.files[0]?.encodingConfidence === "number"
                ? `${Math.round(task.files[0].encodingConfidence * 100)}%`
                : t("translator.common.empty_value")
            }
            tone="muted"
          />
        </ToolStatGrid>

        {/* Error alerts */}
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

        <Separator />

        {/* Action bar — primary + secondary tiers */}
        <ToolActionBar
          hint={
            !isPrepared && sourceFile
              ? t("translator.queue.prepare_hint")
              : undefined
          }
          secondary={
            <>
              <TooltipIconButton
                tooltip={t("translator.actions.recovery")}
                onClick={onOpenRecovery}
              >
                <History className="h-4 w-4" />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={t("translator.actions.open_workspace")}
                onClick={onRevealWorkspace}
                disabled={!task?.taskId}
              >
                <Folder className="h-4 w-4" />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={t("translator.actions.clear")}
                onClick={onClear}
                disabled={isRunning}
              >
                <Trash2 className="h-4 w-4" />
              </TooltipIconButton>
            </>
          }
        >
          <Button type="button" onClick={onPrepare} disabled={!canPrepare}>
            <RefreshCw className="h-4 w-4" />
            {isPreparing
              ? t("translator.actions.preparing")
              : t("translator.actions.prepare")}
          </Button>
          <Button type="button" onClick={onStart} disabled={!canStart}>
            <PlayCircle className="h-4 w-4" />
            {isStarting
              ? t("translator.actions.running")
              : t("translator.actions.start")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={!canCancel}
          >
            <X className="h-4 w-4" />
            {t("translator.actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onRevealOutput}
            disabled={!canRevealOutput}
          >
            <FolderOpen className="h-4 w-4" />
            {t("translator.actions.open_output")}
          </Button>
        </ToolActionBar>
      </CardContent>
    </Card>
  );
}

function ShieldIcon({ status }: { status: TextTranslationTaskStatus }) {
  if (status === "failed")
    return <AlertTriangle className="h-3.5 w-3.5" />;
  if (status === "completed")
    return <CheckCircle2 className="h-3.5 w-3.5" />;
  return <CircleDashed className="h-3.5 w-3.5" />;
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
