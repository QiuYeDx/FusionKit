import { AlertTriangle, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type {
  LocalSubtitleRecoveredBatchStatus,
  LocalSubtitleRecoveredSessionSummary,
  LocalSubtitleRecoveredTaskStatus,
  LocalSubtitleTaskStage,
} from "@/type/localSubtitle";

const RECOVERED_TASK_STATUS_KEYS = {
  completed: "subtitle:local_transcriber.status.completed",
  cancelled: "subtitle:local_transcriber.status.cancelled",
  failed: "subtitle:local_transcriber.status.failed",
  interrupted: "subtitle:local_transcriber.status.interrupted",
} as const satisfies Record<LocalSubtitleRecoveredTaskStatus, string>;

const RECOVERED_BATCH_STATUS_KEYS = {
  completed: "subtitle:local_transcriber.batch_status.completed",
  cancelled: "subtitle:local_transcriber.batch_status.cancelled",
  failed: "subtitle:local_transcriber.batch_status.failed",
  interrupted: "subtitle:local_transcriber.batch_status.interrupted",
} as const satisfies Record<LocalSubtitleRecoveredBatchStatus, string>;

const RECOVERED_STAGE_KEYS = {
  queued: "subtitle:local_transcriber.stage.queued",
  preparing_media: "subtitle:local_transcriber.stage.preparing_media",
  loading_model: "subtitle:local_transcriber.stage.loading_model",
  transcribing: "subtitle:local_transcriber.stage.transcribing",
  post_processing: "subtitle:local_transcriber.stage.post_processing",
  exporting: "subtitle:local_transcriber.stage.exporting",
  cancelling: "subtitle:local_transcriber.stage.cancelling",
} as const satisfies Record<LocalSubtitleTaskStage, string>;

export function LocalSubtitleRecoveredSession({
  summary,
}: {
  readonly summary?: LocalSubtitleRecoveredSessionSummary;
}) {
  const { t } = useTranslation(["subtitle"]);
  if (!summary || summary.batches.length === 0) return null;

  const taskCount = summary.batches.reduce(
    (total, batch) => total + batch.tasks.length,
    0,
  );
  return (
    <section
      data-testid="local-subtitle-recovered-session"
      className="border-y"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {t("subtitle:local_transcriber.recovered.title")}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {t("subtitle:local_transcriber.recovered.summary", {
                count: taskCount,
                version: summary.build.version,
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="divide-y">
        {summary.batches.map((batch) => (
          <div key={batch.batchId} className="min-w-0">
            <div className="flex min-w-0 items-center justify-between gap-2 bg-muted/10 px-3 py-2">
              <span className="text-xs font-medium">
                {t("subtitle:local_transcriber.recovered.batch", {
                  count: batch.tasks.length,
                })}
              </span>
              <Badge variant="outline">
                {t(RECOVERED_BATCH_STATUS_KEYS[batch.status])}
              </Badge>
            </div>
            <div className="divide-y">
              {batch.tasks.map((task) => (
                <div
                  key={task.taskId}
                  data-recovered-task-id={task.taskId}
                  className="min-w-0 space-y-1.5 px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {task.displayName}
                    </span>
                    <Badge variant="secondary">
                      {t(RECOVERED_TASK_STATUS_KEYS[task.status])}
                    </Badge>
                  </div>
                  <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{task.backend.toUpperCase()}</span>
                    <span>{task.formats.join(" + ")}</span>
                    <span>{t(RECOVERED_STAGE_KEYS[task.stage])}</span>
                  </div>
                  {task.errorCode ? (
                    <div className="flex min-w-0 items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-words font-mono text-[11px] [overflow-wrap:anywhere]">
                        {task.errorCode}
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
