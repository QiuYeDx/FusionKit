import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, CircleAlert, CircleMinus, FileAudio, FilePlay, FileX2, FolderOpen, LoaderCircle, Play, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AUDIO_FORMATS,
  type AudioFormat,
  type CompressCodec,
  type ConversionSettings,
  type ConversionTask,
  type ItemFailureCode,
  type ItemOutput,
  type ItemProgress,
  type ItemSummary,
  type MediaConverterErrorCode,
  type MediaInfo,
  type PlanNotApplicableCode,
  type PlanSkipCode,
  type PlanSummary,
  type PreviewPlanResult,
} from "@/media-converter/contract";
import { mediaErrorCodeOf, settingsSignature, type MediaConverterController } from "@/services/media-converter/controller";
import { useMediaConverterPreferences } from "@/store/tools/media/useMediaConverterPreferences";
import { showToast } from "@/utils/toast";
import { StudioDisclosure } from "../../Subtitle/SubtitleStudio/StudioDisclosure";
import { StudioFileName, StudioIconButton } from "../../Subtitle/SubtitleStudio/StudioControls";
import { StudioTaskQueueRow } from "../../Subtitle/SubtitleStudio/StudioTaskQueue";
import {
  formatBitRate,
  formatBytes,
  formatDurationMs,
  formatDurationUs,
  formatFrameRate,
  formatPercent,
  formatResolution,
  formatSampleRate,
  formatSizeChange,
  formatSpeed,
  UNKNOWN_VALUE,
} from "./format";
import {
  CODEC_LABELS,
  ENGINE_ADVICE_LABELS,
  ENGINE_UNAVAILABLE_LABELS,
  HDR_LABELS,
  ITEM_PHASE_LABELS,
  ITEM_STATUS_LABELS,
  NOT_APPLICABLE_LABELS,
  OUTPUT_CONTAINER_NAMES,
  PLAN_ERROR_LABELS,
  TASK_LABELS,
  channelsLabel,
  codecDisplayName,
  encoderLabel,
  notApplicableReason,
  planErrorLabel,
  probeFailureLabels,
  requestErrorLabel,
  type NotApplicableReason,
} from "./labels";
import { FORMAT_NAMES } from "./MediaConverterSettings";
import { PlanSummaryView, lossWarnings, planWarningText } from "./PlanSummaryView";

/**
 * One file of the queue (module-workbench design 队列行): the shared queue row of the transcription
 * queue and the translation tasks (`StudioTaskQueueRow`), with what the media converter knows of the
 * file. Before the start: analyzing, why it cannot be processed, why the task does not apply (with a
 * switch to one that does), its media information, a one-line loss warning and its plan. After it
 * (R-WORKBENCH-04): the phase, a progress bar (indeterminate when the duration is unknown) and the
 * numbers of the run, then the result of every end state, and the actions each state allows.
 */

const NOT_APPLICABLE_CODES: ReadonlySet<string> = new Set<PlanNotApplicableCode>(["task_not_applicable", "no_audio_stream", "no_video_stream"]);
const isAudioFormat = (value: string): value is AudioFormat => (AUDIO_FORMATS as readonly string[]).includes(value);
/** Where an audio file goes when the user switches from a video task: the format every device plays. */
const DEFAULT_AUDIO_TARGET: AudioFormat = "mp3";
const CODEC_NAMES = { av1: "AV1", hevc: "HEVC", h264: "H.264" } as const satisfies Record<CompressCodec, string>;

/** The states a run ends in; each is announced once (AC-WORKBENCH-04-3). */
export const ENDED_STATUSES: ReadonlySet<ItemSummary["state"]["status"]> = new Set(["succeeded", "skipped", "failed", "cancelled", "interrupted", "input_changed"]);
/** What "retry" starts again (the queue's own list, less `unsupported` and `skipped`, which has "convert anyway"). */
const RETRYABLE: ReadonlySet<ItemSummary["state"]["status"]> = new Set(["failed", "cancelled", "interrupted", "input_changed"]);

// ── Why a run failed (AC-WORKBENCH-04-3) ──────────────────────────────────────────────────────────

/** Failures with words of their own; the file's own and the engine's reuse the probe and engine texts. */
type OwnFailureCode = "session_limit" | "params_rejected" | "encoder_stalled" | "output_open_failed" | "disk_full" | "disk_space_low"
  | "input_missing" | "encode_failed" | "output_cap_exceeded" | "file_too_large_for_volume" | "output_is_input" | "output_dir_unwritable"
  | "output_path_too_long" | "overwrite_trash_failed" | "output_publish_failed" | "confirmation_required" | "no_encoder_available" | "busy"
  | "not_applicable" | "unknown";

/** The short reason on the row, as `media:failure.<code>`. */
export const FAILURE_LABELS = {
  session_limit: "failure.session_limit",
  params_rejected: "failure.params_rejected",
  encoder_stalled: "failure.encoder_stalled",
  output_open_failed: "failure.output_open_failed",
  disk_full: "failure.disk_full",
  disk_space_low: "failure.disk_space_low",
  input_missing: "failure.input_missing",
  encode_failed: "failure.encode_failed",
  output_cap_exceeded: "failure.output_cap_exceeded",
  file_too_large_for_volume: "failure.file_too_large_for_volume",
  output_is_input: "failure.output_is_input",
  output_dir_unwritable: "failure.output_dir_unwritable",
  output_path_too_long: "failure.output_path_too_long",
  overwrite_trash_failed: "failure.overwrite_trash_failed",
  output_publish_failed: "failure.output_publish_failed",
  confirmation_required: "failure.confirmation_required",
  no_encoder_available: "failure.no_encoder_available",
  busy: "failure.busy",
  not_applicable: "failure.not_applicable",
  unknown: "failure.unknown",
} as const satisfies Record<OwnFailureCode, string>;

/** What the code means and what to do, in the details (`media:failure_advice.<code>`). */
export const FAILURE_ADVICE_LABELS = {
  session_limit: "failure_advice.session_limit",
  params_rejected: "failure_advice.params_rejected",
  encoder_stalled: "failure_advice.encoder_stalled",
  output_open_failed: "failure_advice.output_open_failed",
  disk_full: "failure_advice.disk_full",
  disk_space_low: "failure_advice.disk_space_low",
  input_missing: "failure_advice.input_missing",
  encode_failed: "failure_advice.encode_failed",
  output_cap_exceeded: "failure_advice.output_cap_exceeded",
  file_too_large_for_volume: "failure_advice.file_too_large_for_volume",
  output_is_input: "failure_advice.output_is_input",
  output_dir_unwritable: "failure_advice.output_dir_unwritable",
  output_path_too_long: "failure_advice.output_path_too_long",
  overwrite_trash_failed: "failure_advice.overwrite_trash_failed",
  output_publish_failed: "failure_advice.output_publish_failed",
  confirmation_required: "failure_advice.confirmation_required",
  no_encoder_available: "failure_advice.no_encoder_available",
  busy: "failure_advice.busy",
  not_applicable: "failure_advice.not_applicable",
  unknown: "failure_advice.unknown",
} as const satisfies Record<OwnFailureCode, string>;

const PROBE_CODES: ReadonlySet<string> = new Set(["probe_failed", "no_media_streams", "container_not_allowed", "wechat_silk_unsupported", "file_unavailable", "not_a_regular_file",
  "platform_unsupported", "runtime_missing", "runtime_invalid", "runtime_version_mismatch", "runtime_spawn_failed"]);

/**
 * The reason and advice keys of a failure code. A retry probes the file again, so a probe failure can
 * end a run too; driver and device codes are the engine badge's; anything without words reads `unknown`.
 */
export function failureLabels(code: ItemFailureCode) {
  if (PROBE_CODES.has(code)) return probeFailureLabels(code as Parameters<typeof probeFailureLabels>[0]);
  if (code === "driver_too_old" || code === "no_device") return { reason: ENGINE_UNAVAILABLE_LABELS[code], advice: ENGINE_ADVICE_LABELS[code] };
  if (code === "dolby_vision_p5_unsupported") return { reason: PLAN_ERROR_LABELS.dolby_vision_p5_unsupported, advice: FAILURE_ADVICE_LABELS.not_applicable };
  const own: OwnFailureCode = NOT_APPLICABLE_CODES.has(code) ? "not_applicable" : Object.hasOwn(FAILURE_LABELS, code) ? (code as OwnFailureCode) : "unknown";
  return { reason: FAILURE_LABELS[own], advice: FAILURE_ADVICE_LABELS[own] };
}

/** Why an item was skipped (`media:skip.<reason>`). */
export const SKIP_LABELS = {
  not_smaller: "skip.not_smaller",
  already_target: "skip.already_target",
} as const satisfies Record<PlanSkipCode, string>;

/** What a cancelled, interrupted or changed item says beside its status. */
const ENDED_NOTE_LABELS = {
  cancelled: "queue.result.cancelled",
  interrupted: "queue.result.interrupted",
  input_changed: "queue.result.input_changed",
} as const;

/** The sentence the live region reads when an item ends (design 播报: "vacation.mp4 已完成，节省 63%"). */
export function endAnnouncement(t: TFunction<"media">, item: ItemSummary, language: string): string | null {
  const name = item.displayName;
  const state = item.state;
  switch (state.status) {
    case "succeeded": {
      const result = item.result;
      if (!result || !result.sourceBytes) return t("queue.announce.succeeded_plain", { name });
      return result.outputBytes < result.sourceBytes
        ? t("queue.announce.succeeded_saved", { name, percent: formatPercent(1 - result.outputBytes / result.sourceBytes, language) })
        : t("queue.announce.succeeded_larger", { name, change: formatSizeChange(result.sourceBytes, result.outputBytes, language) });
    }
    case "failed":
      if (state.partial && item.result) return t("queue.announce.partial", { name, done: item.result.outputs.length, total: item.result.outputCount });
      return t("queue.announce.failed", { name, reason: t(failureLabels(state.code).reason) });
    case "skipped": return t("queue.announce.skipped", { name, reason: t(SKIP_LABELS[state.reason]) });
    case "cancelled": return t("queue.announce.cancelled", { name });
    case "interrupted": return t("queue.announce.interrupted", { name });
    case "input_changed": return t("queue.announce.input_changed", { name });
    default: return null;
  }
}

// ── Plans (T-WORKBENCH-03) ─────────────────────────────────────────────────────────────────────────

/** What `preview-plan` said for the settings the row asked with, or why it could not say. */
export type PlanAnswer =
  | { kind: "plan"; result: PreviewPlanResult }
  | { kind: "not_applicable"; code: PlanNotApplicableCode }
  | { kind: "error"; code: MediaConverterErrorCode };

interface PlanEntry {
  /** The item object and the settings it was asked for: a newer one of either makes it stale. */
  item: ItemSummary;
  signature: string;
  answer: PlanAnswer;
}

/** The task a not-applicable file fits, and the convert target it needs ("convert to MP3" for an audio file). */
export interface TaskSwitch {
  task: ConversionTask;
  target?: AudioFormat;
}

export function suggestedSwitch(reason: NotApplicableReason, convertTarget: string): TaskSwitch {
  // A silent video still compresses; an audio file converts to an audio format.
  if (reason === "no_audio") return { task: "compress" };
  return { task: "convert", target: isAudioFormat(convertTarget) ? convertTarget : DEFAULT_AUDIO_TARGET };
}

/**
 * The plan of an idle file for `settings` while the row is in view or open (design 处理计划); the
 * controller caches it by item and settings until the item or the engine changes. The last answer
 * stays while a newer one is on its way.
 */
function usePlan(controller: MediaConverterController, item: ItemSummary, settings: ConversionSettings, engine: unknown, active: boolean) {
  const [entry, setEntry] = useState<PlanEntry | null>(null);
  const plannable = item.state.status === "idle" && item.media !== null;
  const signature = settingsSignature(settings);
  useEffect(() => {
    if (!plannable || !active) return;
    let live = true;
    controller.previewPlan(item.id, settings).then(
      result => { if (live) setEntry({ item, signature, answer: { kind: "plan", result } }); },
      error => {
        if (!live) return;
        const code = mediaErrorCodeOf(error);
        setEntry({ item, signature, answer: NOT_APPLICABLE_CODES.has(code) ? { kind: "not_applicable", code: code as PlanNotApplicableCode } : { kind: "error", code } });
      },
    );
    return () => { live = false; };
    // `engine`: a detection may change every plan (the controller drops its cache then).
  }, [controller, item, settings, signature, engine, plannable, active]);
  if (!plannable || !entry || entry.item.id !== item.id) return { entry: null, stale: false };
  return { entry, stale: entry.item !== item || entry.signature !== signature };
}

/** Whether the row is in the window: only rows in view (or open) ask for their plan (design 风险: 预览请求过多). */
export type RowVisibility = (element: Element, onChange: (visible: boolean) => void) => () => void;

function useVisible(ref: RefObject<HTMLElement | null>, observe: RowVisibility) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observe(element, setVisible);
  }, [ref, observe]);
  return visible;
}

/** The main video stream and the main audio stream (the default one, else the first). */
function mainStreams(media: MediaInfo) {
  const video = media.primaryVideoIndex === null ? undefined : media.video.find(stream => stream.index === media.primaryVideoIndex);
  const audio = media.audio.find(stream => stream.default) ?? media.audio[0];
  return { video, audio };
}

/** Values of one group, "·" between them; a group never breaks inside, the groups wrap. */
function MetaGroup({ testId, values, children }: { testId: string; values: (string | null | undefined | false)[]; children?: ReactNode }) {
  const shown = values.filter((value): value is string => !!value);
  if (!shown.length && !children) return null;
  return <span data-testid={testId} className="inline-flex items-center gap-1.5 whitespace-nowrap">
    {shown.map((value, index) => <span key={index} className="contents">
      {index ? <span aria-hidden="true" className="opacity-50">·</span> : null}
      <span>{value}</span>
    </span>)}
    {children}
  </span>;
}

/** The media information of a probed file (AC-WORKBENCH-02-2), in groups that wrap on a narrow window. */
export function MediaMeta({ media }: { media: MediaInfo }) {
  const { t, i18n } = useTranslation("media");
  const language = i18n.language;
  const { video, audio } = mainStreams(media);
  const hdr = video && video.hdr.format !== "none" ? video.hdr.format : null;
  const tracks = [
    media.kind === "video" || media.audio.length > 1 ? (media.audio.length ? t("queue.meta.audio_tracks", { count: media.audio.length }) : t("queue.meta.no_audio")) : null,
    media.subtitles.length ? t("queue.meta.subtitles", { count: media.subtitles.length }) : null,
    media.kind === "audio" && media.covers.length ? t("queue.meta.cover") : null,
  ];
  return <span data-testid="media-meta" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
    <MetaGroup testId="media-meta-file" values={[
      media.durationUs === null ? t("queue.meta.unknown_duration") : formatDurationUs(media.durationUs, language),
      formatBytes(media.sizeBytes, language),
    ]} />
    {video ? <MetaGroup testId="media-meta-video" values={[
      formatResolution(video.width, video.height, video.rotation),
      video.fps === null ? null : t(video.isVfr ? "queue.meta.vfr" : "queue.meta.fps", { fps: formatFrameRate(video.fps, language, video.isVfr) }),
      `${codecDisplayName(video.codec)}${video.bitDepth && video.bitDepth > 8 ? ` ${video.bitDepth}-bit` : ""}`,
    ]}>
      {hdr ? <span data-testid="media-meta-hdr" className="rounded-[4px] border border-foreground/15 bg-foreground/[0.04] px-1 text-[10px] font-semibold leading-[14px] text-foreground/80">{t(HDR_LABELS[hdr])}</span> : null}
    </MetaGroup> : null}
    {audio ? <MetaGroup testId="media-meta-audio" values={[
      codecDisplayName(audio.codec),
      audio.channels ? t(channelsLabel(audio.channels), { count: audio.channels }) : null,
      audio.sampleRate ? formatSampleRate(audio.sampleRate, language) : null,
      audio.bitRate ? formatBitRate(audio.bitRate, language) : null,
    ]} /> : null}
    <MetaGroup testId="media-meta-tracks" values={tracks} />
  </span>;
}

// ── The run and its result (T-WORKBENCH-04) ──────────────────────────────────────────────────────

/** A partly done item: a failure after some outputs were published ("partly done m/n", AC-WORKBENCH-04-3). */
const isPartial = (item: ItemSummary) => item.state.status === "failed" && item.state.partial && !!item.result?.outputs.length;

function rowIcon(item: ItemSummary, notApplicable: boolean) {
  const status = item.state.status;
  if (status === "analyzing") return <LoaderCircle className="animate-spin text-muted-foreground motion-reduce:animate-none" />;
  if (status === "unsupported") return <FileX2 className="text-destructive" />;
  if (status === "running") return <LoaderCircle className="animate-spin text-foreground/70 motion-reduce:animate-none" />;
  if (status === "succeeded") return <Check className="text-emerald-600 dark:text-emerald-400" />;
  if (isPartial(item)) return <TriangleAlert className="text-amber-600 dark:text-amber-400" />;
  if (status === "failed") return <CircleAlert className="text-destructive" />;
  if (status === "skipped" || status === "cancelled" || status === "interrupted" || status === "input_changed") return <CircleMinus className="text-muted-foreground" />;
  const Icon = item.media?.kind === "audio" ? FileAudio : FilePlay;
  return <Icon className={notApplicable ? "text-muted-foreground/60" : "text-muted-foreground"} />;
}

/** A line under the media information, aligned with the file name (the icon is 15px, then 8px). */
const ROW_LINE = "mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-[23px] text-[11px] leading-[18px]";
/** The tone of each status word on the row. */
const STATUS_TONES: Partial<Record<ItemSummary["state"]["status"], string>> = {
  succeeded: "text-emerald-700 dark:text-emerald-400",
  failed: "text-destructive",
  running: "text-foreground/90",
};
/** One number of a running item: tabular figures in a cell that keeps its width as the value changes (AC-WORKBENCH-04-2). */
const STAT_CELL = "inline-block text-right tabular-nums";

/**
 * The numbers of a run: share done, speed, encoding fps (when a picture is encoded or copied), size
 * written and time left. Every cell is right-aligned in a reserved width, so the line does not move as
 * the values change four times a second; a value not known yet reads "—" in the same cell. Gaps, not
 * dots, separate them: a dot would show how much of each reserved width is empty.
 */
function RunStats({ progress, picture }: { progress: ItemProgress | null; picture: boolean }) {
  const { t, i18n } = useTranslation("media");
  const language = i18n.language;
  const fraction = progress?.fraction ?? null;
  const known = (value: number | null | undefined, format: (value: number) => string) => value === null || value === undefined ? UNKNOWN_VALUE : format(value);
  return <span data-testid="media-row-stats" className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
    {fraction !== null ? <span data-testid="media-stat-percent" className={cn(STAT_CELL, "min-w-[4ch] font-medium text-foreground/85")}>{formatPercent(fraction, language)}</span> : null}
    <span data-testid="media-stat-speed" className={cn(STAT_CELL, "min-w-[5ch]")}>{known(progress?.speed, value => formatSpeed(value, language))}</span>
    {picture ? <span data-testid="media-stat-fps" className={cn(STAT_CELL, "min-w-[7ch]")}>
      {known(progress?.fps, value => t("queue.meta.fps", { fps: formatFrameRate(Math.round(value), language) }))}
    </span> : null}
    <span className="inline-flex items-center gap-1">
      <span>{t("queue.progress.written")}</span>
      <span data-testid="media-stat-written" className={cn(STAT_CELL, "min-w-[7ch]")}>{known(progress?.writtenBytes, value => formatBytes(value, language))}</span>
    </span>
    <span className="inline-flex items-center gap-1">
      <span>{t("queue.progress.eta")}</span>
      <span data-testid="media-stat-eta" className={cn(STAT_CELL, "min-w-[5ch]")}>{known(fraction === null ? null : progress?.etaMs, value => formatDurationMs(value, language))}</span>
    </span>
  </span>;
}

/** The bar of a run whose length is unknown: a native `<progress>` without a value (design 进度), a light sweeping across it. */
function IndeterminateProgress({ label }: { label: string }) {
  return <progress
    data-testid="media-row-progress-indeterminate"
    aria-label={label}
    className="mt-2 block h-1 w-full appearance-none overflow-hidden rounded-[4px] border-0 animate-[gradient-shift_1.6s_ease-in-out_infinite] motion-reduce:animate-none [&::-webkit-progress-bar]:bg-transparent"
    style={{
      backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--foreground) 18%, var(--card)) 30%, var(--primary) 50%, color-mix(in srgb, var(--foreground) 18%, var(--card)) 70%)",
      backgroundSize: "300% 100%",
    }}
  />;
}

/**
 * A file name that takes the room it is given: `StudioFileName` caps its end at half its own width, so one
 * sized to its content would cut a short name's extension (as in the queue and result rows, it stretches).
 */
export const STRETCHED_NAME = "[&>.studio-file-name]:flex-1";

/** Whether the job writes a picture: its fps means something then. */
const writesPicture = (plan: PlanSummary | undefined) => !!plan?.outputs.some(output => output.streams.some(stream => stream.kind === "video" && stream.action !== "drop"));

/** One saved output with "show in folder", for an item with several outputs or a partial one. */
function OutputLine({ output, onReveal }: { output: ItemOutput; onReveal: (output: ItemOutput) => void }) {
  const { t, i18n } = useTranslation("media");
  return <li data-testid="media-row-output" className="flex min-w-0 items-center gap-2">
    <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", STRETCHED_NAME)}>
      <span aria-hidden="true" className="shrink-0 opacity-60">→</span>
      <StudioFileName name={output.fileName} />
    </span>
    <span className="shrink-0 tabular-nums">{formatBytes(output.sizeBytes, i18n.language)}</span>
    <StudioIconButton data-testid="media-row-output-reveal" className="size-6" label={`${t("queue.reveal")} · ${output.fileName}`} onClick={() => onReveal(output)}><FolderOpen className="size-3.5" /></StudioIconButton>
  </li>;
}

export interface MediaQueueRowProps {
  item: ItemSummary;
  controller: MediaConverterController;
  /** The panel's settings, 300 ms after their last change: what plans are asked with. */
  planSettings: ConversionSettings;
  /** The engine status object: a new one (a detection) asks for plans again. */
  engine: unknown;
  observe: RowVisibility;
  /** Starts items through the page's confirmation (losses, lossless targets, replaced files). */
  onStart: (itemIds: string[]) => void;
  /** Another start is being checked or confirmed, or the engine cannot start anything yet: the row's own start waits. */
  startDisabled: boolean;
  /** Opens the failure details. */
  onDetails: (itemId: string) => void;
}

type PendingAction = "cancel" | "retry" | "remove";

export const MediaQueueRow = memo(function MediaQueueRow({ item, controller, planSettings, engine, observe, onStart, startDisabled, onDetails }: MediaQueueRowProps) {
  const { t, i18n } = useTranslation("media");
  const language = i18n.language;
  // The row's own element is the shared row's; its metadata line stands for it.
  const ref = useRef<HTMLSpanElement>(null);
  const visible = useVisible(ref, observe);
  const [expanded, setExpanded] = useState(false);
  const { entry, stale } = usePlan(controller, item, planSettings, engine, visible || expanded);
  // The action on its way, with the state it was sent from: a newer state of the item ends it (progress keeps the state object).
  const [pending, setPending] = useState<{ action: PendingAction; from: ItemSummary["state"] } | null>(null);
  const busy = pending?.from === item.state ? pending.action : null;
  const status = item.state.status;
  const answer = entry?.answer;
  const plan = answer?.kind === "plan" && answer.result.status !== "error" ? answer.result.plan : null;
  const noEncoder = answer?.kind === "plan" && answer.result.status === "error" ? answer.result : null;
  const notApplicable = answer?.kind === "not_applicable" ? notApplicableReason(answer.code, planSettings.task) : null;
  const active = status === "queued" || status === "running";
  const ended = ENDED_STATUSES.has(status);
  // After the start the item keeps the plan it was started with; queued and running rows still show it.
  const frozenPlan = active && item.job ? item.job.plan : null;
  const shownPlan = frozenPlan ?? (status === "idle" ? plan : null);
  // A file being analyzed already has its plan line, and an idle one keeps it while the plan is on its way, so rows
  // do not move when analyses end (a hundred files at once) or plans arrive (as they scroll into view, or after a
  // settings change); a not-applicable line of the same height takes its place. Opened early, it fills in by itself.
  const pendingPlan = (status === "analyzing" && !item.job) || (status === "idle" && item.media !== null && !answer);
  const losses = status === "idle" && plan ? lossWarnings(plan) : [];
  const partial = isPartial(item);
  const rowState = notApplicable ? "not_applicable" : partial ? "partial" : status;
  const startable = status === "idle" && item.media !== null && !notApplicable && !noEncoder && answer?.kind !== "error";

  const act = async (action: PendingAction, send: () => Promise<{ affected: number }>) => {
    if (busy) return;
    const from = item.state;
    setPending({ action, from });
    try {
      // Nothing affected (it moved on meanwhile): the row stays, and so does a usable button.
      const { affected } = await send();
      if (!affected) setPending(current => (current?.from === from ? null : current));
    } catch (error) {
      showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error");
      setPending(current => (current?.from === from ? null : current));
    }
  };
  const reveal = (output: ItemOutput) => {
    controller.reveal(item.id, output.index).catch(error => {
      const code = mediaErrorCodeOf(error);
      showToast(code === "file_unavailable" ? t("queue.reveal_missing", { name: output.fileName }) : t(requestErrorLabel(code)), "error");
    });
  };

  const switchTask = (reason: NotApplicableReason, byKeyboard: boolean) => {
    const preferences = useMediaConverterPreferences.getState();
    const next = suggestedSwitch(reason, preferences.convert.target);
    if (next.target) preferences.setConvert({ target: next.target });
    preferences.setTask(next.task);
    // The line and its button go once the new plans arrive: a keyboard user stays on this file, not on the page.
    if (byKeyboard) requestAnimationFrame(() => ref.current?.closest("li")?.querySelector<HTMLElement>(".studio-file-name")?.focus());
  };

  const unsupported = item.state.status === "unsupported" ? probeFailureLabels(item.state.code) : null;
  const failure = item.state.status === "failed" ? item.state : null;
  const result = item.result;
  const outputs = result?.outputs ?? [];
  const name = item.displayName;

  const statusLabel = item.state.status === "running" ? `${t(ITEM_STATUS_LABELS.running)} · ${t(ITEM_PHASE_LABELS[item.state.phase])}`
    : partial && result ? t("queue.result.partial", { done: outputs.length, total: result.outputCount })
      : t(ITEM_STATUS_LABELS[status]);
  const statusWord = <span data-testid="media-row-status" className={cn("shrink-0 font-medium", partial ? "text-amber-700 dark:text-amber-400" : STATUS_TONES[status] ?? "text-foreground/80")}>{statusLabel}</span>;
  const lineButton = (testId: string, label: string, onClick: () => void, disabled = false) => <Button
    type="button" variant="outline" size="xs" data-testid={testId} className="shrink-0" disabled={disabled} onClick={onClick}
  >{label}</Button>;

  /** What an ended item says next to its status: the output and its size change, the reason, or what happened. */
  const endedFacts = (): ReactNode => {
    if (status === "succeeded" && result) {
      const change = formatSizeChange(result.sourceBytes, result.outputBytes, language);
      const smaller = result.outputBytes < result.sourceBytes;
      return <>
        {outputs.length === 1
          ? <span data-testid="media-row-output-name" className={cn("flex min-w-0 flex-1 items-center gap-1.5", STRETCHED_NAME)}><span aria-hidden="true" className="shrink-0 opacity-60">→</span><StudioFileName name={outputs[0].fileName} /></span>
          : <span data-testid="media-row-output-name" className="min-w-0 flex-1">{t("queue.result.outputs", { count: outputs.length })}</span>}
        <span data-testid="media-row-sizes" className="shrink-0 whitespace-nowrap tabular-nums">{t("queue.result.sizes", { source: formatBytes(result.sourceBytes, language), output: formatBytes(result.outputBytes, language) })}</span>
        <span data-testid="media-row-change" data-direction={smaller ? "smaller" : "larger"} className={cn("shrink-0 font-medium tabular-nums", smaller ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>{change}</span>
      </>;
    }
    if (failure) {
      const reason = failure.space
        ? <span data-testid="media-row-disk-space" className="min-w-0 flex-1 text-foreground/80">{t("queue.disk_space", { required: formatBytes(failure.space.requiredBytes, language), available: formatBytes(failure.space.availableBytes, language) })}</span>
        // The status word and the icon are red already; the reason reads in the body colour.
        : <span data-testid="media-row-reason" className={cn("min-w-0 flex-1", partial ? "text-muted-foreground" : "text-foreground/80")}>{t(failureLabels(failure.code).reason)}</span>;
      return <>{reason}{lineButton("media-row-details", t("queue.details"), () => onDetails(item.id))}</>;
    }
    if (item.state.status === "skipped") {
      return <>
        <span data-testid="media-row-reason" className="min-w-0 flex-1">{t(SKIP_LABELS[item.state.reason])}</span>
        {lineButton("media-row-convert-anyway", t("queue.convert_anyway"), () => {
          const reason = item.state.status === "skipped" ? item.state.reason : undefined;
          void act("retry", () => controller.retry([item.id], reason));
        }, busy !== null)}
      </>;
    }
    if (status === "cancelled" || status === "interrupted" || status === "input_changed") {
      return outputs.length && result
        ? <span data-testid="media-row-published" className="min-w-0 flex-1">{t("queue.published", { done: outputs.length, total: result.outputCount })}</span>
        : <span data-testid="media-row-reason" className="min-w-0 flex-1">{t(ENDED_NOTE_LABELS[status])}</span>;
    }
    return null;
  };

  const metadata = <span ref={ref} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
    {status === "analyzing" ? <span data-testid="media-row-analyzing">{t("queue.analyzing")}</span>
      : unsupported ? <span data-testid="media-row-reason" className="font-medium text-destructive">{t(unsupported.reason)}</span>
        : status === "running" ? <span className="flex min-w-0 flex-1 flex-nowrap items-center gap-3">
          {statusWord}
          <RunStats progress={item.progress} picture={writesPicture(item.job?.plan)} />
        </span>
          // 24px, the height of the line's own button ("details", "convert anyway"): every ended row is one height.
          : ended ? <span data-testid="media-row-result" className="flex min-h-6 min-w-0 flex-1 flex-nowrap items-center gap-2">
            {statusWord}
            {endedFacts()}
          </span>
            : <>
              {status !== "idle" ? statusWord : null}
              {item.media ? <MediaMeta media={item.media} /> : null}
            </>}
  </span>;

  const fraction = item.state.status === "running" ? item.progress?.fraction ?? null : null;
  const progressLabel = `${t(ITEM_STATUS_LABELS.running)} · ${name}`;
  const progress = fraction !== null ? { max: 100, value: Math.round(fraction * 1000) / 10, label: progressLabel } : undefined;

  const actions: ReactNode[] = [];
  if (startable) {
    actions.push(<StudioIconButton key="start" data-testid="media-row-start" label={`${t("queue.start")} · ${name}`} disabled={startDisabled} onClick={() => onStart([item.id])}><Play /></StudioIconButton>);
  }
  if (active) {
    actions.push(<StudioIconButton key="cancel" data-testid="media-row-cancel" label={`${t("queue.cancel")} · ${name}`} disabled={busy !== null}
      onClick={() => void act("cancel", () => controller.cancel([item.id]))}>{busy === "cancel" ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Square />}</StudioIconButton>);
  }
  if (RETRYABLE.has(status)) {
    actions.push(<StudioIconButton key="retry" data-testid="media-row-retry" label={`${t("queue.retry")} · ${name}`} disabled={busy !== null}
      onClick={() => void act("retry", () => controller.retry([item.id]))}>{busy === "retry" ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <RotateCcw />}</StudioIconButton>);
  }
  if (status === "succeeded" && outputs.length) {
    actions.push(<StudioIconButton key="reveal" data-testid="media-row-reveal" label={`${t("queue.reveal")} · ${outputs[0].fileName}`} onClick={() => reveal(outputs[0])}><FolderOpen /></StudioIconButton>);
  }
  if (!active) {
    actions.push(<StudioIconButton key="remove" data-testid="media-row-remove" label={`${t("queue.remove")} · ${name}`} disabled={busy !== null}
      onClick={() => void act("remove", () => controller.remove([item.id]))}><X /></StudioIconButton>);
  }

  // Several outputs, or the ones a failure or a cancel left: each can be shown in its folder.
  const outputList = outputs.length > 1 || (outputs.length > 0 && status !== "succeeded");

  return <StudioTaskQueueRow
    data-testid="media-queue-row"
    data-item-id={item.id}
    data-state={rowState}
    data-plan={answer ? (answer.kind === "plan" ? answer.result.status : answer.kind) : undefined}
    // The shared row keeps metadata on one line; media information wraps here instead (AC-WORKBENCH-02-2).
    className="[&_.studio-task-meta>*]:min-w-0 [&_.studio-task-meta>*]:shrink [&_.studio-task-meta>*]:whitespace-normal"
    name={name}
    icon={rowIcon(item, notApplicable !== null)}
    actions={actions.length ? actions : null}
    metadata={metadata}
    progress={progress}
  >
    {status === "running" && fraction === null ? <IndeterminateProgress label={progressLabel} /> : null}

    {unsupported ? <p data-testid="media-row-advice" className={cn(ROW_LINE, "text-muted-foreground")}>{t(unsupported.advice)}</p> : null}

    {notApplicable ? <div data-testid="media-row-not-applicable" className={ROW_LINE}>
      <span className="font-medium text-foreground/80">{t("queue.not_applicable_title")}</span>
      <span className="text-muted-foreground">{t(NOT_APPLICABLE_LABELS[notApplicable])}</span>
      <SwitchButton reason={notApplicable} onSwitch={switchTask} />
    </div> : null}

    {noEncoder ? <div data-testid="media-row-no-encoder" className={cn(ROW_LINE, "text-amber-700 dark:text-amber-400")}>
      <span>{t("queue.no_encoder", { codec: planSettings.task === "compress" ? CODEC_NAMES[planSettings.codec] : t(TASK_LABELS[planSettings.task]) })}</span>
      {planSettings.task === "compress" && noEncoder.alternatives.length ? noEncoder.alternatives.map(codec => <Button
        key={codec}
        type="button"
        variant="outline"
        size="xs"
        data-testid={`media-row-use-${codec}`}
        onClick={() => useMediaConverterPreferences.getState().setCompress({ codec })}
      >{t("queue.use_codec", { codec: t(CODEC_LABELS[codec]) })}</Button>) : <span className="text-muted-foreground">{t("queue.no_encoder_none")}</span>}
    </div> : null}

    {answer?.kind === "error" ? <p data-testid="media-row-plan-error" className={cn(ROW_LINE, "text-muted-foreground")}>{t(planErrorLabel(answer.code))}</p> : null}

    {losses.length ? <p data-testid="media-row-loss" className={cn(ROW_LINE, "flex-nowrap items-start gap-1.5 text-amber-700 dark:text-amber-400")}>
      <TriangleAlert aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
      <span className="min-w-0">{losses.map(warning => planWarningText(t, warning, item.media)).join(t("queue.list_separator"))}</span>
    </p> : null}

    {answer?.kind === "plan" && answer.result.status === "skipped" && status === "idle" ? <p data-testid="media-row-already-target" className={cn(ROW_LINE, "text-muted-foreground")}>{t("queue.already_target")}</p> : null}

    {outputList ? <ul data-testid="media-row-outputs" className="mt-1 flex min-w-0 flex-col gap-0.5 pl-[23px] text-[11px] leading-[18px] text-muted-foreground">
      {outputs.map(output => <OutputLine key={output.index} output={output} onReveal={reveal} />)}
    </ul> : null}

    {shownPlan || pendingPlan ? <div className="mt-1 pl-[19px]">
      <StudioDisclosure
        open={expanded}
        onOpenChange={setExpanded}
        lazyMount
        triggerTestId="media-row-plan-toggle"
        title={<span className="flex min-w-0 items-center gap-1.5">
          <span>{t("plan.title")}</span>
          <span aria-hidden="true" className="opacity-50">·</span>
          {shownPlan
            ? <span className="min-w-0 truncate">{planHeadline(t, shownPlan)}</span>
            : <span data-testid="media-row-plan-pending" className="min-w-0 truncate opacity-70">{t("plan.pending")}</span>}
        </span>}
        // 24px, the height of the not-applicable line's button: a row keeps its height whichever line it shows.
        triggerClassName="min-h-6 flex-none justify-start gap-1 rounded-[6px] px-1 py-0 text-[11px] font-normal leading-[18px] text-muted-foreground hover:bg-transparent hover:text-foreground [&>svg]:size-3.5"
        contentClassName="pt-1 pl-1 pb-0.5"
      >
        {shownPlan
          ? <PlanSummaryView plan={shownPlan} media={item.media} frozen={frozenPlan !== null} stale={!frozenPlan && stale} />
          : <p className="text-[11px] leading-[18px] text-muted-foreground">{t("plan.loading")}</p>}
      </StudioDisclosure>
    </div> : null}
  </StudioTaskQueueRow>;
});

/** The encoders and the output format in one phrase: "OpenH264 (CPU), AAC → MP4". */
function planHeadline(t: TFunction<"media">, plan: PlanSummary): string {
  const encoders = plan.remuxOnly || !plan.encoders.length ? t("plan.remux_short") : plan.encoders.map(entry => t(encoderLabel(entry.encoder, entry.variant))).join(t("queue.list_separator"));
  const formats = [...new Set(plan.outputs.map(output => OUTPUT_CONTAINER_NAMES[output.container]))].join(t("queue.list_separator"));
  return `${encoders} → ${formats}`;
}

function SwitchButton({ reason, onSwitch }: { reason: NotApplicableReason; onSwitch: (reason: NotApplicableReason, byKeyboard: boolean) => void }) {
  const { t } = useTranslation("media");
  const convertTarget = useMediaConverterPreferences(state => state.convert.target);
  const next = suggestedSwitch(reason, convertTarget);
  return <Button type="button" variant="outline" size="xs" data-testid="media-row-switch-task" onClick={event => onSwitch(reason, event.detail === 0)}>
    {next.target ? t("queue.switch_to_audio", { format: FORMAT_NAMES[next.target] }) : t("queue.switch_task", { task: t(TASK_LABELS[next.task]) })}
  </Button>;
}
