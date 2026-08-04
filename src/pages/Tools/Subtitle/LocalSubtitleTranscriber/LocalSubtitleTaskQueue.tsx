import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Cpu,
  FolderOpen,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  LocalSubtitleBatchStatus,
  LocalSubtitleBatchSummary,
  LocalSubtitleTaskStage,
  LocalSubtitleTaskStatus,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import {
  getCommittedSrtArtifact,
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
  | "reveal";

export function localSubtitleTaskActionKey(
  action: LocalSubtitleTaskAction,
  taskId: string,
): string {
  return `${action}:${taskId}`;
}

interface LocalSubtitleTaskQueueProps {
  readonly batches: readonly LocalSubtitleBatchSummary[];
  readonly pendingActionKeys: ReadonlySet<string>;
  readonly onCancel: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetry: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetryOnCpu: (task: LocalSubtitleTaskSummary) => void;
  readonly onRemove: (task: LocalSubtitleTaskSummary) => void;
  readonly onReveal: (task: LocalSubtitleTaskSummary) => void;
}

export function LocalSubtitleTaskQueue({
  batches,
  pendingActionKeys,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onReveal,
}: LocalSubtitleTaskQueueProps) {
  const { t } = useTranslation(["subtitle"]);

  if (batches.length === 0) {
    return (
      <div
        data-testid="local-subtitle-task-queue"
        className="flex min-h-48 items-center justify-center border-t px-4 py-8 text-center"
      >
        <div className="max-w-sm space-y-2">
          <CheckCircle2 className="mx-auto h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium">
            {t("subtitle:local_transcriber.queue.empty_title")}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t("subtitle:local_transcriber.queue.empty_description")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="local-subtitle-task-queue" className="border-t">
      <div className="flex items-center justify-between gap-3 py-3">
        <h3 className="text-sm font-semibold">
          {t("subtitle:local_transcriber.queue.title")}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {t("subtitle:local_transcriber.queue.batch_count", {
            count: batches.length,
          })}
        </span>
      </div>

      <div className="divide-y border-y">
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
                    onCancel={onCancel}
                    onRetry={onRetry}
                    onRetryOnCpu={onRetryOnCpu}
                    onRemove={onRemove}
                    onReveal={onReveal}
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
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onReveal,
}: Omit<LocalSubtitleTaskQueueProps, "batches"> & {
  readonly task: LocalSubtitleTaskSummary;
}) {
  const { t } = useTranslation(["subtitle"]);
  const artifact = getCommittedSrtArtifact(task);
  const active = isLocalSubtitleTaskActive(task);
  const pending = (action: LocalSubtitleTaskAction) =>
    pendingActionKeys.has(localSubtitleTaskActionKey(action, task.taskId));
  const anyActionPending = ([
    "cancel",
    "retry",
    "cpu-retry",
    "remove",
    "reveal",
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
          artifactAvailable={Boolean(artifact)}
          anyActionPending={anyActionPending}
          pending={pending}
          onCancel={onCancel}
          onRetry={onRetry}
          onRetryOnCpu={onRetryOnCpu}
          onRemove={onRemove}
          onReveal={onReveal}
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

      {task.status === "completed" && artifact ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{artifact.displayName}</span>
        </div>
      ) : null}

      {task.error ? <LocalSubtitleErrorNotice error={task.error} /> : null}
    </div>
  );
}

function TaskActions({
  task,
  artifactAvailable,
  anyActionPending,
  pending,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onReveal,
}: {
  readonly task: LocalSubtitleTaskSummary;
  readonly artifactAvailable: boolean;
  readonly anyActionPending: boolean;
  readonly pending: (action: LocalSubtitleTaskAction) => boolean;
  readonly onCancel: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetry: (task: LocalSubtitleTaskSummary) => void;
  readonly onRetryOnCpu: (task: LocalSubtitleTaskSummary) => void;
  readonly onRemove: (task: LocalSubtitleTaskSummary) => void;
  readonly onReveal: (task: LocalSubtitleTaskSummary) => void;
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
      {artifactAvailable ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.reveal_task", {
            name: task.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("reveal")}
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={() => onReveal(task)}
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
