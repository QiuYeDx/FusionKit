import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Cpu,
  Eye,
  FolderOpen,
  Info,
  Languages,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  LocalSubtitleBatchStatus,
  LocalSubtitleBatchSummary,
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleTaskStage,
  LocalSubtitleTaskStatus,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleManualHandoffResult } from "@/services/local-subtitle/localSubtitlePostActionService";
import {
  canManuallyHandoffLocalSubtitleArtifact,
  isLocalSubtitleTaskActive,
} from "./localSubtitleTranscriberModel";
import { LocalSubtitleErrorNotice } from "./LocalSubtitleErrorNotice";

const TASK_STAGE_KEYS = {
  queued: "subtitle:local_transcriber.stage.queued",
  preparing_media: "subtitle:local_transcriber.stage.preparing_media",
  loading_model: "subtitle:local_transcriber.stage.loading_model",
  transcribing: "subtitle:local_transcriber.stage.transcribing",
  post_processing: "subtitle:local_transcriber.stage.post_processing",
  exporting: "subtitle:local_transcriber.stage.exporting",
  cancelling: "subtitle:local_transcriber.stage.cancelling",
} as const satisfies Record<LocalSubtitleTaskStage, string>;

const TASK_STATUS_KEYS = {
  queued: "subtitle:local_transcriber.status.queued",
  preparing_media: "subtitle:local_transcriber.status.preparing_media",
  loading_model: "subtitle:local_transcriber.status.loading_model",
  transcribing: "subtitle:local_transcriber.status.transcribing",
  post_processing: "subtitle:local_transcriber.status.post_processing",
  exporting: "subtitle:local_transcriber.status.exporting",
  completed: "subtitle:local_transcriber.status.completed",
  cancelling: "subtitle:local_transcriber.status.cancelling",
  cancelled: "subtitle:local_transcriber.status.cancelled",
  failed: "subtitle:local_transcriber.status.failed",
} as const satisfies Record<LocalSubtitleTaskStatus, string>;

const BATCH_STATUS_KEYS = {
  queued: "subtitle:local_transcriber.batch_status.queued",
  running: "subtitle:local_transcriber.batch_status.running",
  cancelling: "subtitle:local_transcriber.batch_status.cancelling",
  completed: "subtitle:local_transcriber.batch_status.completed",
  cancelled: "subtitle:local_transcriber.batch_status.cancelled",
  failed: "subtitle:local_transcriber.batch_status.failed",
} as const satisfies Record<LocalSubtitleBatchStatus, string>;

export type LocalSubtitleTaskAction =
  | "cancel"
  | "retry"
  | "cpu-retry"
  | "remove"
  | "reveal"
  | "handoff";

export function localSubtitleTaskActionKey(
  action: LocalSubtitleTaskAction,
  taskId: string,
): string {
  return `${action}:${taskId}`;
}

interface LocalSubtitleTaskQueueProps {
  readonly batches: readonly LocalSubtitleBatchSummary[];
  readonly pendingActionKeys: ReadonlySet<string>;
  readonly manualHandoffResults: ReadonlyMap<
    string,
    LocalSubtitleManualHandoffResult
  >;
  readonly missingTranslationTaskIds: ReadonlySet<string>;
  readonly onCancel: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetry: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetryOnCpu: (task: LocalSubtitleTaskSummary) => void;
  readonly onRemove: (task: LocalSubtitleTaskSummary) => void;
  readonly onPreview: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
  readonly onReveal: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
  readonly onHandoff: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
  readonly onShowError: (task: LocalSubtitleTaskSummary) => void;
}

export function LocalSubtitleTaskQueue({
  batches,
  pendingActionKeys,
  manualHandoffResults,
  missingTranslationTaskIds,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onPreview,
  onReveal,
  onHandoff,
  onShowError,
}: LocalSubtitleTaskQueueProps) {
  const { t } = useTranslation(["subtitle"]);

  if (batches.length === 0) {
    return (
      <div
        data-testid="local-subtitle-task-queue"
        className="flex min-w-0 items-center gap-3 rounded-md border bg-muted/20 px-3 py-3 text-left"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs">
          <CheckCircle2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium">
            {t("subtitle:local_transcriber.queue.empty_title")}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("subtitle:local_transcriber.queue.empty_description")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="local-subtitle-task-queue" className="border-t pt-4">
      <div className="flex items-center justify-between gap-3 pb-3">
        <h3 className="text-sm font-semibold">
          {t("subtitle:local_transcriber.queue.title")}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {t("subtitle:local_transcriber.queue.batch_count", {
            count: batches.length,
          })}
        </span>
      </div>

      <div className="divide-y overflow-hidden rounded-md border">
        {batches.map((batch) => {
          const completedTasks = batch.tasks.filter(
            (task) => task.status === "completed",
          ).length;
          return (
            <section key={batch.batchId} data-batch-id={batch.batchId}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 bg-muted/25 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-xs font-medium">
                    {t("subtitle:local_transcriber.queue.batch")}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {t("subtitle:local_transcriber.queue.batch_progress", {
                      completed: completedTasks,
                      total: batch.tasks.length,
                    })}
                  </div>
                </div>
                <Badge variant="outline">
                  {t(BATCH_STATUS_KEYS[batch.status])}
                </Badge>
              </div>

              <div className="divide-y">
                {batch.tasks.map((task) => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    pendingActionKeys={pendingActionKeys}
                    manualHandoffResults={manualHandoffResults}
                    missingTranslationTaskIds={missingTranslationTaskIds}
                    onCancel={onCancel}
                    onRetry={onRetry}
                    onRetryOnCpu={onRetryOnCpu}
                    onRemove={onRemove}
                    onPreview={onPreview}
                    onReveal={onReveal}
                    onHandoff={onHandoff}
                    onShowError={onShowError}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  pendingActionKeys,
  manualHandoffResults,
  missingTranslationTaskIds,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onPreview,
  onReveal,
  onHandoff,
  onShowError,
}: Omit<LocalSubtitleTaskQueueProps, "batches"> & {
  readonly task: LocalSubtitleTaskSummary;
}) {
  const { t } = useTranslation(["subtitle"]);
  const active = isLocalSubtitleTaskActive(task);
  const pending = (action: LocalSubtitleTaskAction) =>
    pendingActionKeys.has(localSubtitleTaskActionKey(action, task.taskId));
  const automaticPostActionPending = task.status === "completed" &&
    task.postAction.mode !== "export_only" &&
    (task.postAction.importStatus === "pending" ||
      task.postAction.importStatus === "importing");
  const anyActionPending = automaticPostActionPending ||
    ([
      "cancel",
      "retry",
      "cpu-retry",
      "remove",
      "reveal",
      "handoff",
    ] as const).some(pending);

  return (
    <div
      data-testid="local-subtitle-task"
      data-task-id={task.taskId}
      className="min-w-0 space-y-3 px-3 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{task.displayName}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t(TASK_STATUS_KEYS[task.status])}</span>
            <span>{task.resolvedBackend.toUpperCase()}</span>
            <span>{task.requestedFormats.join(" + ")}</span>
            {task.durationMs !== undefined ? (
              <span>
                {t("subtitle:local_transcriber.queue.duration", {
                  duration: formatDuration(task.durationMs),
                })}
              </span>
            ) : null}
          </div>
        </div>

        <TaskActions
          task={task}
          anyActionPending={anyActionPending}
          pending={pending}
          onCancel={onCancel}
          onRetry={onRetry}
          onRetryOnCpu={onRetryOnCpu}
          onRemove={onRemove}
          onShowError={onShowError}
        />
      </div>

      {active ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>
              {t(TASK_STAGE_KEYS[task.progress.stage])} · {Math.round(task.progress.stageProgress)}%
            </span>
            <span>
              {t("subtitle:local_transcriber.queue.overall_progress", {
                progress: Math.round(task.progress.overallProgress),
              })}
            </span>
          </div>
          <Progress value={task.progress.overallProgress} />
        </div>
      ) : null}

      {task.status === "completed" && task.completion ? (
        <TaskArtifactResults
          task={task}
          anyActionPending={anyActionPending}
          revealPending={pending("reveal")}
          handoffPending={pending("handoff")}
          onPreview={onPreview}
          onReveal={onReveal}
          onHandoff={onHandoff}
          translationTaskMissing={Boolean(
            task.postAction.translationTaskId &&
              missingTranslationTaskIds.has(task.postAction.translationTaskId),
          )}
        />
      ) : null}

      {task.status === "completed" ? (
        <TaskPostActionResult
          task={task}
          manualResult={manualHandoffResults.get(task.taskId)}
          translationTaskMissing={Boolean(
            task.postAction.translationTaskId &&
              missingTranslationTaskIds.has(task.postAction.translationTaskId),
          )}
        />
      ) : null}

      {task.error ? <LocalSubtitleErrorNotice error={task.error} /> : null}
    </div>
  );
}

function TaskActions({
  task,
  anyActionPending,
  pending,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onShowError,
}: {
  readonly task: LocalSubtitleTaskSummary;
  readonly anyActionPending: boolean;
  readonly pending: (action: LocalSubtitleTaskAction) => boolean;
  readonly onCancel: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetry: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetryOnCpu: (task: LocalSubtitleTaskSummary) => void;
  readonly onRemove: (task: LocalSubtitleTaskSummary) => void;
  readonly onShowError: (task: LocalSubtitleTaskSummary) => void;
}) {
  const { t } = useTranslation(["subtitle"]);
  const active = isLocalSubtitleTaskActive(task);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {active && task.status !== "cancelling" ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.cancel_task", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("cancel")}
          icon={<XCircle className="h-3.5 w-3.5" />}
          onClick={() => onCancel(task)}
        />
      ) : null}
      {task.status === "failed" ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.retry_task", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("retry")}
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={() => onRetry(task)}
        />
      ) : null}
      {task.cpuRetryAvailable === true ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.retry_task_on_cpu", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("cpu-retry")}
          icon={<Cpu className="h-3.5 w-3.5" />}
          onClick={() => onRetryOnCpu(task)}
        />
      ) : null}
      {task.error ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.show_error_details", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={false}
          icon={<Info className="h-3.5 w-3.5" />}
          onClick={() => onShowError(task)}
        />
      ) : null}
      {!active ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.remove_task", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("remove")}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => onRemove(task)}
        />
      ) : null}
    </div>
  );
}

function TaskArtifactResults({
  task,
  anyActionPending,
  revealPending,
  handoffPending,
  translationTaskMissing,
  onPreview,
  onReveal,
  onHandoff,
}: {
  readonly task: LocalSubtitleTaskSummary;
  readonly anyActionPending: boolean;
  readonly revealPending: boolean;
  readonly handoffPending: boolean;
  readonly translationTaskMissing: boolean;
  readonly onPreview: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
  readonly onReveal: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
  readonly onHandoff: (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => void;
}) {
  const { t } = useTranslation(["subtitle"]);
  const completion = task.completion!;
  return (
    <div className="min-w-0 border-y">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b px-2 py-2 text-xs">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
        <span className="font-medium">
          {t(completion.outcome === "full"
            ? "subtitle:local_transcriber.result.full"
            : "subtitle:local_transcriber.result.partial")}
        </span>
        {completion.warnings.map((warning) => (
          <span
            key={warning}
            className="min-w-0 break-words text-amber-700 dark:text-amber-300 [overflow-wrap:anywhere]"
          >
            {t("subtitle:local_transcriber.result.cancelled_after_partial_commit")}
          </span>
        ))}
      </div>
      <div className="divide-y">
        {completion.artifacts.map((result) => (
          <div
            key={result.format}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-2 py-2 text-xs"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Badge variant="outline" className="shrink-0">
                {result.format}
              </Badge>
              <span className={result.status === "committed"
                ? "text-emerald-700 dark:text-emerald-300"
                : result.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"}
              >
                {t(`subtitle:local_transcriber.result.${result.status}`)}
              </span>
              {result.status === "committed" ? (
                <span className="min-w-0 truncate text-muted-foreground">
                  {result.artifact.displayName}
                </span>
              ) : result.errorCode ? (
                <span className="min-w-0 break-words font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {result.errorCode}
                </span>
              ) : null}
            </div>
            {result.status === "committed" ? (
              <div className="flex shrink-0 items-center gap-1">
                <TaskIconButton
                  label={t("subtitle:local_transcriber.actions.preview_artifact", {
                    name: result.artifact.displayName,
                  })}
                  disabled={anyActionPending}
                  loading={false}
                  icon={<Eye className="h-3.5 w-3.5" />}
                  onClick={() => onPreview(task, result.artifact)}
                />
                <TaskIconButton
                  label={t("subtitle:local_transcriber.actions.reveal_task", {
                    name: result.artifact.displayName,
                  })}
                  disabled={anyActionPending}
                  loading={revealPending}
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  onClick={() => onReveal(task, result.artifact)}
                />
                {canManuallyHandoffLocalSubtitleArtifact(
                  task,
                  result.format,
                  translationTaskMissing,
                ) ? (
                  <TaskIconButton
                    label={t("subtitle:local_transcriber.actions.handoff_artifact", {
                      name: result.artifact.displayName,
                    })}
                    disabled={anyActionPending}
                    loading={handoffPending}
                    icon={<Languages className="h-3.5 w-3.5" />}
                    onClick={() => onHandoff(task, result.artifact)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const IMPORT_STATUS_KEYS = {
  pending: "subtitle:local_transcriber.post_action.status.pending",
  importing: "subtitle:local_transcriber.post_action.status.importing",
  queued: "subtitle:local_transcriber.post_action.status.queued",
  skipped: "subtitle:local_transcriber.post_action.status.skipped",
  failed: "subtitle:local_transcriber.post_action.status.failed",
} as const;

const START_STATUS_KEYS = {
  started: "subtitle:local_transcriber.post_action.start.started",
  waiting: "subtitle:local_transcriber.post_action.start.waiting",
  failed: "subtitle:local_transcriber.post_action.start.failed",
} as const;

function TaskPostActionResult({
  task,
  manualResult,
  translationTaskMissing,
}: {
  readonly task: LocalSubtitleTaskSummary;
  readonly manualResult?: LocalSubtitleManualHandoffResult;
  readonly translationTaskMissing: boolean;
}) {
  const { t } = useTranslation(["subtitle"]);
  if (task.postAction.mode === "export_only" && !manualResult) return null;

  const automaticStatus = task.postAction.mode === "export_only"
    ? null
    : task.postAction.importStatus === "not_requested"
      ? null
      : {
          label: translationTaskMissing
            ? t("subtitle:local_transcriber.post_action.status.translation_task_missing")
            : t(IMPORT_STATUS_KEYS[task.postAction.importStatus]),
          detail: translationTaskMissing
            ? undefined
            : task.postAction.importErrorCode ??
              task.postAction.startFailureReason ??
              (task.postAction.startStatus === "not_requested" ||
                  task.postAction.startStatus === "requesting"
                ? undefined
                : t(START_STATUS_KEYS[task.postAction.startStatus])),
          taskId: translationTaskMissing
            ? undefined
            : task.postAction.translationTaskId,
        };
  const manualStatus = manualResult
    ? summarizeManualHandoffResult(manualResult, t)
    : null;

  return (
    <div className="min-w-0 border-l-2 border-primary/40 bg-primary/5 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Languages className="h-4 w-4 shrink-0 text-primary" />
        <span className="font-medium">
          {t("subtitle:local_transcriber.post_action.receipt")}
        </span>
        {automaticStatus ? <span>{automaticStatus.label}</span> : null}
        {automaticStatus?.detail ? (
          <span className="break-words font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {automaticStatus.detail}
          </span>
        ) : null}
        {manualStatus ? (
          <span className="break-words text-muted-foreground [overflow-wrap:anywhere]">
            {manualStatus.label}
            {manualStatus.detail ? ` · ${manualStatus.detail}` : ""}
          </span>
        ) : null}
        {automaticStatus?.taskId || manualStatus?.taskId ? (
          <Button asChild type="button" variant="link" size="sm" className="h-6 px-1 text-xs">
            <Link to="/tools/subtitle/translator">
              {t("subtitle:local_transcriber.post_action.view_translation")}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function summarizeManualHandoffResult(
  result: LocalSubtitleManualHandoffResult,
  t: (key: string) => string,
): { readonly label: string; readonly detail?: string; readonly taskId?: string } {
  if (!result.ok) {
    return {
      label: t("subtitle:local_transcriber.post_action.manual_failed"),
      detail: result.code,
    };
  }
  const taskId = result.receipt.addedTaskIds[0];
  if (!taskId) {
    return {
      label: t("subtitle:local_transcriber.post_action.status.skipped"),
      detail: result.receipt.skipped[0]?.reason ?? "invalid_content",
    };
  }
  if (result.receipt.startedTaskIds.includes(taskId)) {
    return {
      label: t("subtitle:local_transcriber.post_action.start.started"),
      taskId,
    };
  }
  if (result.receipt.waitingTaskIds.includes(taskId)) {
    return {
      label: t("subtitle:local_transcriber.post_action.start.waiting"),
      taskId,
    };
  }
  const failure = result.receipt.startFailures.find(
    (candidate) => candidate.taskId === taskId,
  );
  return {
    label: t("subtitle:local_transcriber.post_action.status.queued"),
    ...(failure ? { detail: failure.reason } : {}),
    taskId,
  };
}

function TaskIconButton({
  label,
  disabled,
  loading,
  icon,
  onClick,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
    </Button>
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours === 0) return `${minutes}:${paddedSeconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
}
