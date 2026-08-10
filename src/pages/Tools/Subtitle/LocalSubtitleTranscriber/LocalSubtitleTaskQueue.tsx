import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
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
import { ButtonGroup } from "@/components/ui/button-group";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ToolPanel } from "@/pages/Tools/_shared/ui";
import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleBatchSummary,
  LocalSubtitleTaskStatus,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleManualHandoffResult } from "@/services/local-subtitle/localSubtitlePostActionService";
import {
  canManuallyHandoffLocalSubtitleArtifact,
  createLocalSubtitleBatchNumberMap,
  isLocalSubtitleTaskActive,
} from "./localSubtitleTranscriberModel";

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

const TASK_STATUS_DOT_CLASS = {
  queued: "bg-gray-500",
  preparing_media: "bg-yellow-500",
  loading_model: "bg-yellow-500",
  transcribing: "bg-yellow-500",
  post_processing: "bg-yellow-500",
  exporting: "bg-yellow-500",
  completed: "bg-green-500",
  cancelling: "bg-yellow-500",
  cancelled: "bg-gray-500",
  failed: "bg-red-500",
} as const satisfies Record<LocalSubtitleTaskStatus, string>;

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
  const taskCount = batches.reduce(
    (total, batch) => total + batch.tasks.length,
    0,
  );
  const batchNumbers = createLocalSubtitleBatchNumberMap(batches);

  return (
    <div data-testid="local-subtitle-task-queue">
      <ToolPanel
        title={t("subtitle:local_transcriber.queue.title")}
        badge={
          <Badge variant="secondary" className="font-mono text-[11px]">
            {taskCount}
          </Badge>
        }
        bodyClassName="divide-y"
      >
        {batches.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <div className="font-medium text-foreground">
              {t("subtitle:local_transcriber.queue.empty_title")}
            </div>
            <div className="mx-auto mt-1 max-w-lg text-xs leading-relaxed">
              {t("subtitle:local_transcriber.queue.empty_description")}
            </div>
          </div>
        ) : (
          batches.map((batch) => {
            const completedTasks = batch.tasks.filter(
              (task) => task.status === "completed",
            ).length;
            const batchProgress = getBatchOverallProgress(batch);

            return (
              <section key={batch.batchId} data-batch-id={batch.batchId}>
                <div className="flex min-w-0 flex-col gap-2 bg-muted/20 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h3 className="shrink-0 text-sm font-semibold">
                      {t("subtitle:local_transcriber.queue.batch")}{" "}
                      {batchNumbers.get(batch.batchId) ?? "--"}
                    </h3>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t("subtitle:local_transcriber.queue.batch_progress", {
                        completed: completedTasks,
                        total: batch.tasks.length,
                      })}
                    </span>
                  </div>
                  <div className="flex w-full min-w-0 items-center gap-2 sm:max-w-[280px]">
                    <Progress
                      value={batchProgress}
                      className="h-1 min-w-0 flex-1"
                    />
                    <span className="w-8 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">
                      {Math.round(batchProgress)}%
                    </span>
                  </div>
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
          })
        )}
      </ToolPanel>
    </div>
  );
}

function getBatchOverallProgress(batch: LocalSubtitleBatchSummary): number {
  if (batch.tasks.length === 0) return 0;
  const total = batch.tasks.reduce((sum, task) => {
    if (task.status === "completed") return sum + 100;
    const progress = Number.isFinite(task.progress.overallProgress)
      ? task.progress.overallProgress
      : 0;
    return sum + Math.min(100, Math.max(0, progress));
  }, 0);
  return total / batch.tasks.length;
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
  const translationTaskMissing = Boolean(
    task.postAction.translationTaskId &&
      missingTranslationTaskIds.has(task.postAction.translationTaskId),
  );
  const automaticPostActionPending =
    task.status === "completed" &&
    task.postAction.mode !== "export_only" &&
    (task.postAction.importStatus === "pending" ||
      task.postAction.importStatus === "importing");
  const anyActionPending =
    automaticPostActionPending ||
    ([
      "cancel",
      "retry",
      "cpu-retry",
      "remove",
      "reveal",
      "handoff",
    ] as const).some(pending);
  const completion = task.completion;
  const committedResults =
    completion?.artifacts.flatMap((result) =>
      result.status === "committed" ? [result] : [],
    ) ?? [];
  const preferredFormat = task.postAction.preferredFormat ?? "SRT";
  const primaryResult =
    committedResults.find((result) => result.format === preferredFormat) ??
    committedResults.find((result) => result.format === "SRT") ??
    committedResults[0];
  const handoffResult = committedResults.find((result) =>
    canManuallyHandoffLocalSubtitleArtifact(
      task,
      result.format,
      translationTaskMissing,
    ),
  );
  const manualResult = manualHandoffResults.get(task.taskId);
  const automaticStatus = summarizeAutomaticPostAction(
    task,
    translationTaskMissing,
    t,
  );
  const manualStatus = manualResult
    ? summarizeManualHandoffResult(manualResult, t)
    : null;
  const translationTaskId =
    automaticStatus?.taskId ?? manualStatus?.taskId;
  const postActionSummary = [
    automaticStatus?.label,
    automaticStatus?.detail,
    manualStatus?.label,
    manualStatus?.detail,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const artifactSummary = completion
    ? completion.artifacts.map((result) =>
        result.status === "committed"
          ? `${result.format} → ${result.artifact.displayName}`
          : `${result.format} · ${t(
              `subtitle:local_transcriber.result.${result.status}`,
            )}${result.errorCode ? ` (${result.errorCode})` : ""}`,
      ).join(" / ")
    : "";
  const statusLabel =
    completion?.outcome === "partial"
      ? t("subtitle:local_transcriber.result.partial")
      : t(TASK_STATUS_KEYS[task.status]);
  const metaItems: ReactNode[] = [
    <span className="shrink-0 uppercase">{task.resolvedBackend}</span>,
    <span className="shrink-0">{task.requestedFormats.join(" + ")}</span>,
    task.durationMs !== undefined ? (
      <span className="shrink-0">
        {t("subtitle:local_transcriber.queue.duration", {
          duration: formatDuration(task.durationMs),
        })}
      </span>
    ) : null,
    artifactSummary ? (
      <span
        className={cn(
          "min-w-0 max-w-full truncate font-mono",
          completion?.outcome === "partial"
            ? "text-amber-700 dark:text-amber-300"
            : "text-emerald-700 dark:text-emerald-300",
        )}
        title={artifactSummary}
      >
        {artifactSummary}
      </span>
    ) : null,
    postActionSummary ? (
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1 truncate"
        title={postActionSummary}
      >
        <Languages className="h-3 w-3 shrink-0" />
        {t("subtitle:local_transcriber.post_action.receipt")} ·{" "}
        {postActionSummary}
      </span>
    ) : null,
    task.error ? (
      <span className="min-w-0 truncate font-mono text-destructive">
        {task.error.code}
      </span>
    ) : null,
  ];

  return (
    <div
      data-testid="local-subtitle-task"
      data-task-id={task.taskId}
      className="min-w-0 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
            TASK_STATUS_DOT_CLASS[task.status],
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[13px] font-medium">
              {task.displayName}
            </span>
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
            >
              {statusLabel}
            </Badge>
          </div>
          <TaskMeta items={metaItems} />
        </div>

        <TaskActions
          task={task}
          anyActionPending={anyActionPending}
          pending={pending}
          primaryArtifact={primaryResult?.artifact}
          handoffArtifact={handoffResult?.artifact}
          translationTaskId={translationTaskId}
          onCancel={onCancel}
          onRetry={onRetry}
          onRetryOnCpu={onRetryOnCpu}
          onRemove={onRemove}
          onPreview={onPreview}
          onReveal={onReveal}
          onHandoff={onHandoff}
          onShowError={onShowError}
        />
      </div>

      {active ? (
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <Progress
            value={task.progress.overallProgress}
            className="h-1 min-w-0 flex-1"
          />
          <span className="shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] text-muted-foreground">
            {task.progress.totalWindows
              ? `${task.progress.completedWindows ?? 0}/${task.progress.totalWindows} · `
              : ""}
            {Math.round(task.progress.overallProgress)}%
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TaskMeta({
  items,
}: {
  readonly items: readonly ReactNode[];
}) {
  const visibleItems = items.filter(
    (item) => item !== null && item !== undefined && item !== false,
  );
  if (visibleItems.length === 0) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden text-[11px] text-muted-foreground">
      {visibleItems.map((item, index) => (
        <span key={index} className="contents">
          {index > 0 ? (
            <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-muted-foreground/40" />
          ) : null}
          {item}
        </span>
      ))}
    </div>
  );
}

function TaskActions({
  task,
  anyActionPending,
  pending,
  primaryArtifact,
  handoffArtifact,
  translationTaskId,
  onCancel,
  onRetry,
  onRetryOnCpu,
  onRemove,
  onPreview,
  onReveal,
  onHandoff,
  onShowError,
}: {
  readonly task: LocalSubtitleTaskSummary;
  readonly anyActionPending: boolean;
  readonly pending: (action: LocalSubtitleTaskAction) => boolean;
  readonly primaryArtifact?: GeneratedSubtitleArtifactSummary;
  readonly handoffArtifact?: GeneratedSubtitleArtifactSummary;
  readonly translationTaskId?: string;
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
}) {
  const { t } = useTranslation(["subtitle"]);
  const active = isLocalSubtitleTaskActive(task);
  const hasAction =
    Boolean(primaryArtifact) ||
    Boolean(handoffArtifact) ||
    Boolean(translationTaskId) ||
    Boolean(task.error) ||
    task.status === "failed" ||
    task.cpuRetryAvailable === true ||
    (active && task.status !== "cancelling") ||
    !active;

  if (!hasAction) return null;

  return (
    <ButtonGroup className="shrink-0">
      {primaryArtifact ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.preview_artifact", {
            name: primaryArtifact.displayName,
          })}
          disabled={anyActionPending}
          loading={false}
          icon={<Eye className="h-3.5 w-3.5" />}
          onClick={() => onPreview(task, primaryArtifact)}
        />
      ) : null}
      {primaryArtifact ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.reveal_task", {
            name: primaryArtifact.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("reveal")}
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={() => onReveal(task, primaryArtifact)}
        />
      ) : null}
      {translationTaskId ? (
        <Button
          asChild
          type="button"
          variant="outline"
          size="icon"
          title={t("subtitle:local_transcriber.post_action.view_translation")}
        >
          <Link
            to="/tools/subtitle/translator"
            aria-label={t(
              "subtitle:local_transcriber.post_action.view_translation",
            )}
          >
            <Languages className="h-3.5 w-3.5" />
          </Link>
        </Button>
      ) : handoffArtifact ? (
        <TaskIconButton
          label={t("subtitle:local_transcriber.actions.handoff_artifact", {
            name: handoffArtifact.displayName,
          })}
          disabled={anyActionPending}
          loading={pending("handoff")}
          icon={<Languages className="h-3.5 w-3.5" />}
          onClick={() => onHandoff(task, handoffArtifact)}
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
    </ButtonGroup>
  );
}

function summarizeAutomaticPostAction(
  task: LocalSubtitleTaskSummary,
  translationTaskMissing: boolean,
  t: (key: string) => string,
): { readonly label: string; readonly detail?: string; readonly taskId?: string } | null {
  if (
    task.postAction.mode === "export_only" ||
    task.postAction.importStatus === "not_requested"
  ) {
    return null;
  }

  return {
    label: translationTaskMissing
      ? t(
          "subtitle:local_transcriber.post_action.status.translation_task_missing",
        )
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
      variant="outline"
      size="icon"
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
