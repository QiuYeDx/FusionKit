import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LocalSubtitleBatchConfigSummary, LocalSubtitleTaskSummary } from "@/type/localSubtitle";
import { formatLocalSubtitleDuration } from "./localSubtitleTranscriberModel";

export function LocalSubtitleTaskInfo({ id, task, config, statusLabel }: {
  readonly id: string;
  readonly task: LocalSubtitleTaskSummary;
  readonly config?: LocalSubtitleBatchConfigSummary;
  readonly statusLabel: string;
}) {
  const { t, i18n } = useTranslation(["subtitle"]);
  const missing = t("subtitle:local_transcriber.task_details.unavailable");
  const language = config?.language;
  const languageLabels = {
    auto: t("subtitle:local_transcriber.config.language_option.auto"),
    zh: t("subtitle:local_transcriber.config.language_option.zh"),
    en: t("subtitle:local_transcriber.config.language_option.en"),
    ja: t("subtitle:local_transcriber.config.language_option.ja"),
    ko: t("subtitle:local_transcriber.config.language_option.ko"),
    es: t("subtitle:local_transcriber.config.language_option.es"),
    fr: t("subtitle:local_transcriber.config.language_option.fr"),
    de: t("subtitle:local_transcriber.config.language_option.de"),
  };
  const formatDate = (value: string) => new Date(value).toLocaleString(i18n.language);
  const rows: readonly [string, ReactNode][] = [
    [t("subtitle:local_transcriber.task_details.source"), task.sourcePathDisplay ?? missing],
    [t("subtitle:local_transcriber.task_details.status"), statusLabel],
    [t("subtitle:local_transcriber.config.model"), task.model.modelId],
    [t("subtitle:local_transcriber.config.device"), task.resolvedBackend.toUpperCase()],
    [t("subtitle:local_transcriber.config.language"), language ? languageLabels[language as keyof typeof languageLabels] ?? language : missing],
    [t("subtitle:local_transcriber.config.task_mode"), config ? t(config.taskMode === "transcribe" ? "subtitle:local_transcriber.config.task_transcribe" : "subtitle:local_transcriber.config.task_translate_english") : missing],
    [t("subtitle:local_transcriber.config.vad"), config ? t(config.vadEnabled ? "subtitle:local_transcriber.task_details.enabled" : "subtitle:local_transcriber.task_details.disabled") : missing],
    [t("subtitle:local_transcriber.config.window_strategy"), config ? t(config.windowStrategy === "acoustic_quiet_v1"
      ? "subtitle:local_transcriber.config.window_pause" : "subtitle:local_transcriber.config.window_fixed") : missing],
    [t("subtitle:local_transcriber.config.output_formats"), task.requestedFormats.join(" + ")],
    [t("subtitle:local_transcriber.config.conflict_policy"), config ? t(config.conflictPolicy === "index" ? "subtitle:local_transcriber.config.conflict_index" : "subtitle:local_transcriber.config.conflict_overwrite") : missing],
    [t("subtitle:local_transcriber.task_details.outputs"), task.artifactResults.length ? (
      <ul className="space-y-1">
        {task.artifactResults.map(result => <li key={result.format}>
          <span className="mr-2 font-medium">{result.format}</span>
          {result.status === "committed" ? result.artifact.outputPathDisplay ?? result.artifact.displayName : t(`subtitle:local_transcriber.result.${result.status}`)}
          {result.status !== "committed" && result.errorCode ? ` (${result.errorCode})` : null}
        </li>)}
      </ul>
    ) : missing],
    [t("subtitle:local_transcriber.task_details.created"), formatDate(task.createdAt)],
    [t("subtitle:local_transcriber.task_details.updated"), formatDate(task.updatedAt)],
  ];
  return <section id={id} aria-label={t("subtitle:local_transcriber.task_details.title")}
    data-testid="local-subtitle-task-details" className="mt-3 min-w-0 border-t border-border/50 pt-3">
    <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
      {rows.map(([label, value]) => <Field key={label} label={label}>{value}</Field>)}
    </dl>
    {task.durationMs !== undefined ? <p className="mt-2 text-xs text-muted-foreground">{t("subtitle:local_transcriber.queue.duration", { duration: formatLocalSubtitleDuration(task.durationMs) })}</p> : null}
    {task.cueSummary ? <p className="mt-2 text-xs text-muted-foreground">{t("subtitle:local_transcriber.cue_summary.total", { count: task.cueSummary.cueCount })}</p> : null}
    {task.cueSummary && task.cueSummary.exceedsTargetCount > 0 ? <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted-foreground">
      {t("subtitle:local_transcriber.cue_summary.exceeds", { count: task.cueSummary.exceedsTargetCount })}{" · "}{t("subtitle:local_transcriber.cue_summary.explanation")}
    </p> : null}
  </section>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <><dt className="text-muted-foreground max-sm:mt-1">{label}</dt><dd className="min-w-0 select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</dd></>;
}
