import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowRight, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PLAN_LOSS_CODES,
  type MediaInfo,
  type PlanOutputSummary,
  type PlanStreamSummary,
  type PlanSummary,
  type PlanWarning,
  type SubtitleKind,
} from "@/media-converter/contract";
import {
  OUTPUT_CONTAINER_NAMES,
  PLAN_CONFIRMATION_LABELS,
  PLAN_WARNING_LABELS,
  STREAM_DROP_LABELS,
  STREAM_KIND_LABELS,
  SUBTITLE_DROPPED_LABELS,
  codecDisplayName,
  encoderLabel,
} from "./labels";

/**
 * What the main process plans for one file (AC-WORKBENCH-03-5): the encoders by their friendly names,
 * what happens to every stream, what is lost and why, and the warnings. It shows the plan exactly as
 * `preview-plan` (or the job frozen at the start) gave it; nothing here plans anything itself.
 */

const LOSS_CODES: ReadonlySet<string> = new Set(PLAN_LOSS_CODES);

/** Warnings that mean content is lost or changed for the worse: the row shows them without opening the plan (AC-WORKBENCH-03-6). */
export const lossWarnings = (plan: PlanSummary): PlanWarning[] => plan.warnings.filter(warning => LOSS_CODES.has(warning.code));

/** What the dropped subtitles are, from the probe: all image ones read "image subtitles", all text ones "text subtitles". */
function droppedSubtitleKind(warning: PlanWarning, media: MediaInfo | null): SubtitleKind {
  const kinds = new Set(warning.streams.map(index => media?.subtitles.find(stream => stream.index === index)?.kind ?? "other"));
  return kinds.size === 1 ? [...kinds][0] : "other";
}

/** One warning as a sentence ("2 image subtitles will be dropped", "HDR will be converted to SDR"). */
export function planWarningText(t: TFunction<"media">, warning: PlanWarning, media: MediaInfo | null): string {
  if (warning.code === "subtitle_dropped") return t(SUBTITLE_DROPPED_LABELS[droppedSubtitleKind(warning, media)], { count: Math.max(1, warning.count) });
  if (warning.code === "encoder_fallback") {
    return t(PLAN_WARNING_LABELS.encoder_fallback, {
      from: warning.from ? t(encoderLabel(warning.from)) : "—",
      to: warning.to ? t(encoderLabel(warning.to)) : "—",
    });
  }
  return t(PLAN_WARNING_LABELS[warning.code], { count: Math.max(1, warning.count) });
}

/** A language tag of the source ("jpn", "chi") in the interface's language; `und` and unknown tags say nothing. */
export function languageName(code: string | null, uiLanguage: string): string | null {
  if (!code || code === "und") return null;
  try {
    const name = new Intl.DisplayNames([uiLanguage || "en"], { type: "language", fallback: "none" }).of(code);
    return name || code;
  } catch {
    return code;
  }
}

/** The output's encoder for a stream, in its friendly name with the bit depth when it is 10-bit. */
function encoderName(t: TFunction<"media">, stream: Pick<PlanStreamSummary, "encoder" | "variant">): string {
  if (!stream.encoder) return "—";
  const name = t(encoderLabel(stream.encoder, stream.variant));
  return stream.variant?.startsWith("10bit") ? `${name} · 10-bit` : name;
}

function StreamLine({ stream, output }: { stream: PlanStreamSummary; output: PlanOutputSummary }) {
  const { t, i18n } = useTranslation("media");
  const language = languageName(stream.language, i18n.language);
  const source = [`${t(STREAM_KIND_LABELS[stream.kind])} ${stream.typeIndex + 1}`, codecDisplayName(stream.codec), language, stream.title].filter(Boolean).join(" · ");
  const action = stream.action === "copy" ? t("plan.action.copy")
    : stream.action === "encode" ? t(stream.kind === "subtitle" ? "plan.action.convert" : "plan.action.encode", { encoder: encoderName(t, stream) })
      : t(STREAM_DROP_LABELS[stream.reason ?? "not_selected"], { format: OUTPUT_CONTAINER_NAMES[output.container] });
  // A stream the subtitle or cover rules drop is a loss; one the task leaves out on purpose is not.
  const dropped = stream.action === "drop" && stream.reason !== "not_selected";
  return <li data-testid="media-plan-stream" data-kind={stream.kind} data-action={stream.action} className="flex min-w-0 flex-wrap items-center gap-x-1.5">
    <span className="min-w-0 text-foreground/85 [overflow-wrap:anywhere]">{source}</span>
    <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/70" />
    <span className={cn("min-w-0 [overflow-wrap:anywhere]", dropped ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{action}</span>
  </li>;
}

function OutputBlock({ output, index, count }: { output: PlanOutputSummary; index: number; count: number }) {
  const { t, i18n } = useTranslation("media");
  const format = t("plan.output_value", { format: OUTPUT_CONTAINER_NAMES[output.container], extension: output.extension });
  const track = output.track
    ? [t("plan.output_track", { number: output.track.number }), languageName(output.track.language, i18n.language)].filter(Boolean).join(" · ")
    : null;
  const extras: ReactNode[] = [];
  if (output.attachments.count > 0) extras.push(t(output.attachments.kept ? "plan.attachments_kept" : "plan.attachments_dropped", { count: output.attachments.count }));
  if (output.chapters.count > 0) extras.push(t(output.chapters.kept ? "plan.chapters_kept" : "plan.chapters_dropped", { count: output.chapters.count }));
  if (output.dataStreamsDropped > 0) extras.push(t("plan.data_dropped", { count: output.dataStreamsDropped }));
  return <section data-testid="media-plan-output" className="min-w-0 space-y-1">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium text-foreground/90">{count > 1 ? t("plan.output_numbered", { number: index + 1 }) : t("plan.output")}</span>
      <span className="min-w-0 text-foreground/85 [overflow-wrap:anywhere]">{track ? `${track} → ${format}` : format}</span>
    </div>
    {output.streams.length ? <ul className="min-w-0 space-y-0.5 pl-2">
      {output.streams.map(stream => <StreamLine key={`${stream.kind}-${stream.index}`} stream={stream} output={output} />)}
    </ul> : null}
    {extras.length ? <p className="pl-2 text-muted-foreground">{extras.map((extra, position) => <span key={position}>{position ? t("queue.separator") : null}{extra}</span>)}</p> : null}
  </section>;
}

export interface PlanSummaryViewProps {
  plan: PlanSummary;
  media: MediaInfo | null;
  /** The plan an item was started with: later changes of the panel do not apply to it. */
  frozen?: boolean;
  /** Settings changed and the new plan is on its way: this one is shown dimmed until then. */
  stale?: boolean;
}

export function PlanSummaryView({ plan, media, frozen = false, stale = false }: PlanSummaryViewProps) {
  const { t } = useTranslation("media");
  const encoders = plan.encoders.map(entry => encoderName(t, entry));
  return <div
    data-testid="media-plan"
    data-stale={stale || undefined}
    aria-busy={stale || undefined}
    className={cn("min-w-0 space-y-2 rounded-[8px] border border-border/70 bg-background/60 px-2.5 py-2 text-[11px] leading-[18px] transition-opacity duration-150 motion-reduce:transition-none", stale && "opacity-60")}
  >
    {frozen ? <p data-testid="media-plan-frozen" className="text-muted-foreground">{t("plan.frozen")}</p> : null}
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium text-foreground/90">{t("plan.encoders")}</span>
      <span data-testid="media-plan-encoders" className="min-w-0 text-foreground/85 [overflow-wrap:anywhere]">
        {plan.remuxOnly || !encoders.length ? t("plan.remux_only") : encoders.join(t("queue.list_separator"))}
      </span>
    </div>
    {plan.outputs.map((output, index) => <OutputBlock key={index} output={output} index={index} count={plan.outputs.length} />)}
    {plan.warnings.length || plan.confirmations.length ? <ul data-testid="media-plan-warnings" className="min-w-0 space-y-0.5">
      {plan.warnings.map((warning, index) => {
        const loss = LOSS_CODES.has(warning.code);
        const Icon = loss ? TriangleAlert : Info;
        return <li key={`${warning.code}-${index}`} data-code={warning.code} className={cn("flex min-w-0 items-start gap-1.5", loss ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
          <Icon aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{planWarningText(t, warning, media)}</span>
        </li>;
      })}
      {plan.confirmations.map(code => <li key={code} data-code={code} className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
        <Info aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{t(PLAN_CONFIRMATION_LABELS[code])}</span>
      </li>)}
    </ul> : null}
  </div>;
}
