import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, Eraser, Info, ListVideo, LoaderCircle, Play, Square, TriangleAlert } from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ConversionSettings, ItemSummary, PlanWarning, StartResult } from "@/media-converter/contract";
import {
  mediaErrorCodeOf,
  settingsSignature,
  type MediaConverterController,
  type MediaConverterState,
} from "@/services/media-converter/controller";
import { toConversionSettings, toOutputSelection, useMediaConverterPreferences } from "@/store/tools/media/useMediaConverterPreferences";
import { showToast } from "@/utils/toast";
import { ToolPanel } from "../../_shared/ui/ToolPanel";
import { ToolSummaryLine } from "../../_shared/ui/ToolSummaryLine";
import { StudioFileName } from "../../Subtitle/SubtitleStudio/StudioControls";
import { StudioTaskQueue } from "../../Subtitle/SubtitleStudio/StudioTaskQueue";
import { engineView } from "./EngineStatusBadge";
import { formatBytes } from "./format";
import { ENGINE_ADVICE_LABELS, ENGINE_UNAVAILABLE_LABELS, requestErrorLabel } from "./labels";
import { ENDED_STATUSES, MediaQueueRow, STRETCHED_NAME, endAnnouncement, failureLabels, type RowVisibility } from "./MediaQueueRow";
import { lossWarnings, planWarningText } from "./PlanSummaryView";

/** Settings changes wait this long before the rows ask for their plans again (design 处理计划). */
export const PLAN_DEBOUNCE_MS = 300;

/** What the panel's settings depend on besides the preferences: the computer's default codec and its AV1 graphics encoder. */
function settingsContext(state: MediaConverterState) {
  return {
    defaultCodec: state.defaults?.compressCodec ?? "h264",
    av1HardwareAvailable: state.engine?.capabilities.state === "ready" && !!state.resolvedEncoders?.av1.gpuOn?.hardware,
  } as const;
}

/** The panel's settings as they are now, for a start: what the rows' plans were asked with, without their wait. */
const currentSettings = (controller: MediaConverterController): ConversionSettings =>
  toConversionSettings(useMediaConverterPreferences.getState(), settingsContext(controller.getState()));

/**
 * The panel's settings, the same object while they mean the same, and those plans are asked with: the
 * same once they have not changed for 300 ms, so a few quick clicks ask once (design 风险: 预览请求过多).
 */
function usePlanSettings(state: MediaConverterState): { current: ConversionSettings; debounced: ConversionSettings } {
  const preferences = useMediaConverterPreferences();
  const settings = toConversionSettings(preferences, settingsContext(state));
  const signature = settingsSignature(settings);
  // The same settings by value keep their object: keyed by the signature on purpose.
  const current = useMemo(() => settings, [signature]);
  const [debounced, setDebounced] = useState(current);
  useEffect(() => {
    if (current === debounced) return;
    const timer = setTimeout(() => setDebounced(current), PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [current, debounced]);
  return { current, debounced };
}

/** Rows this close to the scrolled area count as visible, so their plans are usually there when they scroll in. */
const VISIBILITY_MARGIN = "120px 0px";

/**
 * One observer for every row: whether a row is in view. Its root is the app's scroll area the rows
 * scroll in (the window itself never scrolls, FK-PIT-0009): with the implicit root, the margin would
 * apply to the window only and the scroll area would clip it away. Made with the first row, which tells
 * where that is. Without IntersectionObserver (a static render) every row counts as visible.
 */
function useRowVisibility(): RowVisibility {
  const [registry] = useState(() => ({
    listeners: new Map<Element, (visible: boolean) => void>(),
    observer: null as IntersectionObserver | null,
  }));
  useEffect(() => () => {
    registry.observer?.disconnect();
    registry.observer = null;
  }, [registry]);
  return useCallback<RowVisibility>((element, onChange) => {
    if (typeof IntersectionObserver === "undefined") {
      onChange(true);
      return () => undefined;
    }
    registry.observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) registry.listeners.get(entry.target)?.(entry.isIntersecting);
    }, { root: element.closest("[data-slot=scroll-area-viewport]"), rootMargin: VISIBILITY_MARGIN });
    const observer = registry.observer;
    registry.listeners.set(element, onChange);
    observer.observe(element);
    return () => {
      registry.listeners.delete(element);
      observer.unobserve(element);
    };
  }, [registry]);
}

// ── Announcements (AC-WORKBENCH-04-3) ─────────────────────────────────────────────────────────────

interface Announcement { id: number; text: string }
/** Kept in the live region; older ones were read already. */
const ANNOUNCEMENTS_KEPT = 6;
let announcementIds = 0;

/**
 * Every end of a run while the page is open, once: an item that enters an end state (or ends again
 * after a retry, with a new finish time). What had already ended when the page opened is not read out.
 * The first list that counts is the snapshot's: after a reload (or the first visit of a session) the
 * page renders an empty list until the snapshot arrives, and the files that ended before it are not news.
 */
function useEndAnnouncements(items: readonly ItemSummary[], ready: boolean): Announcement[] {
  const { t, i18n } = useTranslation("media");
  const seen = useRef<Map<string, string> | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  useEffect(() => {
    if (!ready) return;
    const previous = seen.current;
    const next = new Map<string, string>();
    const fresh: Announcement[] = [];
    for (const item of items) {
      if (!ENDED_STATUSES.has(item.state.status)) continue;
      const signature = `${item.state.status}:${item.finishedAt ?? ""}`;
      next.set(item.id, signature);
      if (!previous || previous.get(item.id) === signature) continue;
      const text = endAnnouncement(t, item, i18n.language);
      if (text) fresh.push({ id: ++announcementIds, text });
    }
    seen.current = next;
    if (fresh.length) setAnnouncements(list => [...list, ...fresh].slice(-ANNOUNCEMENTS_KEPT));
  }, [items, ready, t, i18n.language]);
  return announcements;
}

/** A polite log: each announcement is a new line, read once, however many end together. */
function LiveRegion({ announcements }: { announcements: Announcement[] }) {
  return <div data-testid="media-live" role="log" aria-live="polite" aria-relevant="additions" className="sr-only">
    {announcements.map(announcement => <p key={announcement.id}>{announcement.text}</p>)}
  </div>;
}

// ── The start and its confirmation (AC-WORKBENCH-03-6, AC-WORKBENCH-03-4) ─────────────────────────

/** What one start asks the user, per file: losses, a lossy-to-lossless conversion, files it would replace. */
interface Review {
  /** Every item the start covers, in list order. */
  ids: string[];
  /** Loss warnings per item with the settings as they are now. */
  losses: Record<string, PlanWarning[]>;
  /** Items whose losses MKV avoids. */
  mkv: string[];
  /** Items that lost something until "change to MKV". */
  resolved: string[];
  lossless: string[];
  /** Files the outputs would replace, by item, as the main process named them. */
  replace: Record<string, string[]>;
  /** The replaced files were listed: the next start may replace them. */
  replaceShown: boolean;
  /** Items left out of this start. */
  skipped: string[];
  phase: "ready" | "checking" | "starting";
  error: string | null;
}

/** The same settings with MKV as the output, when MKV is a choice for them; null when it is not. */
function withMkv(settings: ConversionSettings): ConversionSettings | null {
  if (settings.task === "compress") return settings.container === "mkv" ? null : { ...settings, container: "mkv" };
  if (settings.task === "convert") return settings.target === "mp4" || settings.target === "mov" || settings.target === "webm" ? { ...settings, target: "mkv" } : null;
  return null;
}

/**
 * The plans of the items with these settings (the controller's cache, the rows' own answers): which
 * lose content, which MKV would spare, and which convert lossy audio to a lossless format. An item that
 * cannot be planned is left to the main process, which says why it did not start.
 */
async function inspect(controller: MediaConverterController, ids: string[], settings: ConversionSettings) {
  const alternative = withMkv(settings);
  const losses: Record<string, PlanWarning[]> = {};
  const mkv = new Set<string>();
  const lossless = new Set<string>();
  await Promise.all(ids.map(async id => {
    const answer = await controller.previewPlan(id, settings).catch(() => null);
    if (!answer || answer.status !== "ready") return;
    if (answer.plan.confirmations.includes("lossy_to_lossless")) lossless.add(id);
    const lost = lossWarnings(answer.plan);
    if (!lost.length) return;
    losses[id] = lost;
    if (!alternative) return;
    const other = await controller.previewPlan(id, alternative).catch(() => null);
    if (other && other.status !== "error" && lossWarnings(other.plan).length < lost.length) mkv.add(id);
  }));
  return { losses, mkv: ids.filter(id => mkv.has(id)), lossless: ids.filter(id => lossless.has(id)) };
}

/** The items of `ids` that can start now: idle and probed. */
function startableIds(controller: MediaConverterController, ids: string[]): string[] {
  const items = new Map(controller.getState().items.map(item => [item.id, item]));
  return ids.filter(id => { const item = items.get(id); return !!item && item.state.status === "idle" && item.media !== null; });
}

/** One start request with the panel's output and these confirmations. */
const sendStart = (controller: MediaConverterController, ids: string[], settings: ConversionSettings, lossless: string[], replaceExisting: boolean) => controller.start({
  itemIds: ids, settings, output: toOutputSelection(useMediaConverterPreferences.getState()),
  confirmed: { lossyToLossless: lossless, replaceExisting },
});

function replacedByItem(needs: NonNullable<StartResult["needsConfirmation"]>): Record<string, string[]> {
  const replace: Record<string, string[]> = {};
  for (const { itemId, fileName } of needs.wouldReplace) (replace[itemId] ??= []).push(fileName);
  return replace;
}

/**
 * "Start" for a row or for every idle file (module-workbench design 开始流程): the current settings,
 * checked first against every item's plan. Nothing to confirm starts at once; otherwise one dialog lists
 * the losses (with "change to MKV" where MKV keeps everything), lossy-to-lossless conversions and, as the
 * main process names them, the files an overwrite replaces. Each can be skipped; confirming starts the rest.
 */
function useStartFlow(controller: MediaConverterController) {
  const { t } = useTranslation("media");
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<Review | null>(null);
  reviewRef.current = review;
  const busy = useRef(false);

  /** What did not start, and why: a toast per reason (files not for the task are skipped, AC-WORKBENCH-02-3). */
  const report = useCallback((result: StartResult) => {
    const byReason = new Map<string, number>();
    for (const { code } of result.rejected) {
      if (code === "confirmation_required") continue;
      const reason = t(failureLabels(code).reason);
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) showToast(t("queue.not_started", { count, reason }), "warning");
  }, [t]);

  const begin = useCallback(async (requested: string[]) => {
    if (busy.current) return;
    const ids = startableIds(controller, requested);
    if (!ids.length) return;
    busy.current = true;
    setChecking(true);
    try {
      const settings = currentSettings(controller);
      const found = await inspect(controller, ids, settings);
      const base: Review = { ids, ...found, resolved: [], replace: {}, replaceShown: false, skipped: [], phase: "ready", error: null };
      if (found.lossless.length && useMediaConverterPreferences.getState().conflict === "overwrite") {
        // The lossy-to-lossless items are not confirmed yet, so this start is refused whole: it only names the files
        // an overwrite would replace, which then join the same dialog.
        const named = await sendStart(controller, ids, settings, [], false);
        if (!named.needsConfirmation) {
          report(named);
          return;
        }
        setReview({ ...base, replace: replacedByItem(named.needsConfirmation), replaceShown: true });
        return;
      }
      if (Object.keys(found.losses).length || found.lossless.length) {
        setReview(base);
        return;
      }
      const result = await sendStart(controller, ids, settings, [], false);
      if (result.needsConfirmation) {
        setReview({ ...base, lossless: [...new Set([...found.lossless, ...result.needsConfirmation.lossyToLossless])], replace: replacedByItem(result.needsConfirmation), replaceShown: true });
      } else {
        report(result);
      }
    } catch (error) {
      showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error");
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [controller, report, t]);

  /** "Change to MKV": the panel's output becomes MKV (for every file: I1 has no per-file settings), then the plans are checked again. */
  const switchToMkv = useCallback(async () => {
    const current = reviewRef.current;
    if (!current || current.phase !== "ready") return;
    const preferences = useMediaConverterPreferences.getState();
    const before = currentSettings(controller);
    if (before.task === "compress") preferences.setCompress({ container: "mkv" });
    else if (before.task === "convert") preferences.setConvert({ target: "mkv" });
    else return;
    setReview({ ...current, phase: "checking" });
    const found = await inspect(controller, current.ids, currentSettings(controller));
    const losing = Object.keys(current.losses);
    const resolved = [...new Set([...current.resolved, ...losing.filter(id => !found.losses[id])])];
    // Other output names (another extension) may replace other files: the main process names them again at the start.
    setReview(latest => latest && { ...latest, ...found, resolved, replace: {}, replaceShown: false, phase: "ready" });
  }, [controller]);

  const toggleSkip = useCallback((id: string) => {
    setReview(latest => latest && { ...latest, skipped: latest.skipped.includes(id) ? latest.skipped.filter(entry => entry !== id) : [...latest.skipped, id] });
  }, []);

  const close = useCallback(() => {
    if (reviewRef.current?.phase === "starting") return;
    setReview(null);
  }, []);

  /** Starts what is left with the confirmations shown; files the main process names only now are listed and asked once more. */
  const confirm = useCallback(async () => {
    const current = reviewRef.current;
    if (!current || current.phase !== "ready") return;
    const ids = startableIds(controller, current.ids.filter(id => !current.skipped.includes(id)));
    if (!ids.length) {
      setReview(null);
      return;
    }
    setReview({ ...current, phase: "starting", error: null });
    try {
      const result = await sendStart(controller, ids, currentSettings(controller), current.lossless.filter(id => ids.includes(id)), current.replaceShown);
      if (result.needsConfirmation) {
        const needs = result.needsConfirmation;
        setReview(latest => latest && {
          ...latest, phase: "ready", replace: replacedByItem(needs), replaceShown: true,
          lossless: [...new Set([...latest.lossless, ...needs.lossyToLossless])],
        });
        return;
      }
      setReview(null);
      report(result);
    } catch (error) {
      setReview(latest => latest && { ...latest, phase: "ready", error: t(requestErrorLabel(mediaErrorCodeOf(error))) });
    }
  }, [controller, report, t]);

  return { checking, review, begin, switchToMkv, toggleSkip, close, confirm };
}

type StartFlow = ReturnType<typeof useStartFlow>;

/** The last non-null value, so a dialog keeps its content while it closes (FK-PIT-0150). */
function useRetained<T>(value: T | null): T | null {
  const [retained, setRetained] = useState(value);
  if (value !== null && value !== retained) setRetained(value);
  return value ?? retained;
}

const CONFIRM_LINE = "flex min-w-0 items-start gap-1.5 text-[11.5px] leading-[18px]";

/** One file of the confirmation: what happens to it, "change to MKV" where that helps, and "skip". */
function ReviewEntry({ item, review, settings, flow }: { item: ItemSummary; review: Review; settings: ConversionSettings; flow: StartFlow }) {
  const { t } = useTranslation("media");
  const losses = review.losses[item.id] ?? [];
  const resolved = review.resolved.includes(item.id) && !losses.length;
  const replaced = review.replace[item.id] ?? [];
  const skipped = review.skipped.includes(item.id);
  const mkv = review.mkv.includes(item.id) && withMkv(settings) !== null;
  const ready = review.phase === "ready";
  return <li data-testid="media-confirm-item" data-item-id={item.id} data-skipped={skipped || undefined} data-resolved={resolved || undefined}
    className="flex min-w-0 flex-col gap-1 rounded-[8px] border border-border/70 bg-background/60 px-2.5 py-2">
    <div className="flex min-w-0 items-center gap-2">
      <span className={cn("flex min-w-0 flex-1 text-[12px] font-medium leading-5", STRETCHED_NAME, skipped && "text-muted-foreground line-through decoration-muted-foreground/60")}><StudioFileName name={item.displayName} /></span>
      {mkv && !skipped ? <Button type="button" size="xs" variant="outline" data-testid="media-confirm-use-mkv" disabled={!ready} onClick={() => void flow.switchToMkv()}>{t("confirm.use_mkv")}</Button> : null}
      <Button type="button" size="xs" variant="ghost" data-testid="media-confirm-skip" aria-pressed={skipped} disabled={!ready} onClick={() => flow.toggleSkip(item.id)}>
        {t(skipped ? "confirm.include" : "confirm.skip")}
      </Button>
    </div>
    {skipped ? <p data-testid="media-confirm-skipped" className={cn(CONFIRM_LINE, "text-muted-foreground")}>{t("confirm.skipped")}</p> : <>
      {losses.length ? <p data-testid="media-confirm-loss" className={cn(CONFIRM_LINE, "text-amber-700 dark:text-amber-400")}>
        <TriangleAlert aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
        <span className="min-w-0">{losses.map(warning => planWarningText(t, warning, item.media)).join(t("queue.list_separator"))}</span>
      </p> : null}
      {resolved ? <p data-testid="media-confirm-resolved" className={cn(CONFIRM_LINE, "text-emerald-700 dark:text-emerald-400")}>
        <Check aria-hidden="true" className="mt-[3px] size-3 shrink-0" /><span className="min-w-0">{t("confirm.resolved")}</span>
      </p> : null}
      {review.lossless.includes(item.id) ? <p data-testid="media-confirm-lossless" className={cn(CONFIRM_LINE, "text-muted-foreground")}>
        <Info aria-hidden="true" className="mt-[3px] size-3 shrink-0" /><span className="min-w-0">{t("confirm.lossless")}</span>
      </p> : null}
      {replaced.length ? <p data-testid="media-confirm-replace" className={cn(CONFIRM_LINE, "text-muted-foreground")}>
        <Info aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{t("confirm.replace", { count: replaced.length, names: replaced.join(t("queue.list_separator")) })}</span>
      </p> : null}
    </>}
  </li>;
}

/** The one confirmation before a start (design 开始前确认): one entry per file with something to confirm. */
function StartConfirmDialog({ flow, items, settings }: { flow: StartFlow; items: readonly ItemSummary[]; settings: ConversionSettings }) {
  const { t } = useTranslation("media");
  const cancel = useRef<HTMLButtonElement>(null);
  const shown = useRetained(flow.review);
  if (!shown) return null;
  const byId = new Map(items.map(item => [item.id, item]));
  const listed = shown.ids.filter(id => shown.losses[id]?.length || shown.resolved.includes(id) || shown.lossless.includes(id) || shown.replace[id]?.length);
  const starting = shown.ids.filter(id => !shown.skipped.includes(id)).length;
  const anyMkv = shown.mkv.some(id => !shown.skipped.includes(id)) && withMkv(settings) !== null;
  return <ScrollableDialog
    animateSize
    open={flow.review !== null}
    onOpenChange={open => { if (!open) flow.close(); }}
    maxWidth="sm:max-w-[520px]"
    onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }}
  >
    <div className="contents" data-testid="media-confirm">
      <ScrollableDialogHeader className="min-w-0 p-3">
        <DialogTitle className="text-sm">{t("confirm.title")}</DialogTitle>
        <DialogDescription className="text-xs leading-5">{t("confirm.description", { count: listed.length, total: shown.ids.length })}</DialogDescription>
      </ScrollableDialogHeader>
      {/* 12px like the header and the footer, so the title, the entries and the buttons share their edges. */}
      <ScrollableDialogContent fadeMaskHeight={16} className="[&_[data-dialog-body-measure]]:p-3">
        <ul data-testid="media-confirm-list" className="flex min-w-0 flex-col gap-2" aria-busy={shown.phase !== "ready" || undefined}>
          {listed.map(id => {
            const item = byId.get(id);
            return item ? <ReviewEntry key={id} item={item} review={shown} settings={settings} flow={flow} /> : null;
          })}
        </ul>
        {anyMkv ? <p data-testid="media-confirm-mkv-note" className="mt-3 text-[11px] leading-[18px] text-muted-foreground">{t("confirm.mkv_note")}</p> : null}
        {shown.error ? <p role="alert" className="mt-3 text-[11.5px] leading-[18px] text-destructive">{shown.error}</p> : null}
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex min-w-0 flex-wrap items-center justify-end gap-2 p-3">
        <Button ref={cancel} type="button" variant="ghost" size="sm" data-testid="media-confirm-cancel" disabled={shown.phase === "starting"} onClick={flow.close}>{t("confirm.cancel")}</Button>
        <Button type="button" size="sm" data-testid="media-confirm-start" disabled={shown.phase !== "ready" || starting === 0} onClick={() => void flow.confirm()}>
          {shown.phase === "ready" ? <Play /> : <LoaderCircle className="animate-spin motion-reduce:animate-none" />}
          {starting ? t("confirm.start", { count: starting }) : t("confirm.start_none")}
        </Button>
      </ScrollableDialogFooter>
    </div>
  </ScrollableDialog>;
}

// ── Failure details (AC-WORKBENCH-04-3) ───────────────────────────────────────────────────────────

/** The error code with what it means, and the end of the redacted ffmpeg log (paths read `<input>`, `<output>`, `[path]`). */
function FailureDetails({ item, onClose }: { item: ItemSummary | null; onClose: () => void }) {
  const { t, i18n } = useTranslation("media");
  const shown = useRetained(item);
  if (!shown || shown.state.status !== "failed") return null;
  const state = shown.state;
  const labels = failureLabels(state.code);
  const message = state.space
    ? t("queue.disk_space", { required: formatBytes(state.space.requiredBytes, i18n.language), available: formatBytes(state.space.availableBytes, i18n.language) })
    : t(labels.reason);
  const lines = (shown.log ?? "").split(/\r?\n/).filter(line => line.trim().length > 0);
  return <ErrorDetailModal
    isOpen={item !== null}
    onClose={onClose}
    taskName={shown.displayName}
    errorMessage={message}
    errorDetails={t("failure.code", { code: state.code })}
    errorLogs={lines.length ? lines : [t("failure.no_log")]}
    timestamp={shown.finishedAt ? new Date(shown.finishedAt).toLocaleString(i18n.language) : undefined}
    guide={<p data-testid="media-failure-advice" className="text-sm leading-6 text-foreground/85">{t(labels.advice)}</p>}
  />;
}

// ── The panel ─────────────────────────────────────────────────────────────────────────────────────

/** Files, their sources' size, how many are done and what compression saved (AC-WORKBENCH-04-4). */
function MediaSummary({ items }: { items: readonly ItemSummary[] }) {
  const { t, i18n } = useTranslation("media");
  let sourceBytes = 0;
  let done = 0;
  let saved = 0;
  for (const item of items) {
    if (item.media) sourceBytes += item.media.sizeBytes;
    if (item.state.status !== "succeeded") continue;
    done++;
    // As the batch notification counts it: what compressing saved; converting and extracting audio are not savings.
    if (item.job?.settings.task === "compress" && item.result) saved += Math.max(0, item.result.sourceBytes - item.result.outputBytes);
  }
  return <div data-testid="media-summary">
    <ToolSummaryLine items={[
      <span data-testid="media-summary-files" className="tabular-nums">{t("queue.summary.files", { count: items.length })}</span>,
      <span data-testid="media-summary-size" className="tabular-nums">{formatBytes(sourceBytes, i18n.language)}</span>,
      <span data-testid="media-summary-done" className="tabular-nums">{t("queue.summary.done", { count: done })}</span>,
      saved > 0 ? <span data-testid="media-summary-saved" className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{t("queue.summary.saved", { size: formatBytes(saved, i18n.language) })}</span> : null,
    ]} />
  </div>;
}

/** Why "start all" cannot run now, or null: the engine is detecting or unavailable, or nothing is waiting (AC-WORKBENCH-04-1). */
function startBlocker(t: TFunction<"media">, state: MediaConverterState, idle: number): string | null {
  const view = engineView(state);
  if (view.kind === "unavailable") return t("queue.start_unavailable", { reason: t(ENGINE_UNAVAILABLE_LABELS[view.code]), advice: t(ENGINE_ADVICE_LABELS[view.code]) });
  if (view.kind === "detecting" || state.phase !== "ready") return t("engine.detecting_detail");
  return idle ? null : t("queue.start_none");
}

/** "Start all", with the reason it is unavailable in a tooltip on a focusable wrapper (a disabled button takes no hover or focus). */
function StartAllButton({ blocker, checking, onStart }: { blocker: string | null; checking: boolean; onStart: () => void }) {
  const { t } = useTranslation("media");
  const reasonId = useId();
  const button = <Button type="button" size="sm" data-testid="media-start-all" disabled={blocker !== null || checking} onClick={onStart}>
    {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Play />}
    {t(checking ? "queue.checking" : "queue.start_all")}
  </Button>;
  if (blocker === null) return button;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span data-testid="media-start-all-reason-trigger" tabIndex={0} role="group" aria-label={t("queue.start_all")} aria-describedby={reasonId}
        className="inline-flex rounded-smooth-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {button}
        <span id={reasonId} className="sr-only">{blocker}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent side="bottom" align="end" data-testid="media-start-all-reason" className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal text-balance">{blocker}</TooltipContent>
  </Tooltip>;
}

/**
 * The queue panel (module-workbench design 布局与空间): the summary above it; in its header "clear
 * done", "cancel all" (while something runs, after a confirmation) and "start all"; every file in the
 * order it was added, in the rows the transcription queue uses, scrolling with the page (no inner scroll
 * bar). Rows re-render only when their item changes; progress replaces one item at a time (R-WORKBENCH-04).
 * Ends of runs are announced politely (AC-WORKBENCH-04-3).
 */
export function MediaQueue({ state, controller }: { state: MediaConverterState; controller: MediaConverterController }) {
  const { t } = useTranslation("media");
  const { current: settings, debounced: planSettings } = usePlanSettings(state);
  const observe = useRowVisibility();
  const announcements = useEndAnnouncements(state.items, state.phase === "ready");
  const flow = useStartFlow(controller);
  const { begin } = flow;
  const [cancelAll, setCancelAll] = useState<string[] | null>(null);
  // The count stays while the dialog closes, not "0 files" (FK-PIT-0150).
  const cancelShown = useRetained(cancelAll);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const onStart = useCallback((itemIds: string[]) => { void begin(itemIds); }, [begin]);
  const onDetails = useCallback((itemId: string) => setDetailsId(itemId), []);

  const items = state.items;
  const idle = items.filter(item => item.state.status === "idle" && item.media !== null);
  const active = items.filter(item => item.state.status === "queued" || item.state.status === "running");
  const done = items.filter(item => item.state.status === "succeeded");
  const blocker = startBlocker(t, state, idle.length);
  // A row's own start waits for another start's check or confirmation, and for the engine as "start all" does.
  const view = engineView(state);
  const startDisabled = flow.checking || flow.review !== null || state.phase !== "ready" || view.kind !== "ready";
  const detailsItem = detailsId ? items.find(item => item.id === detailsId && item.state.status === "failed") ?? null : null;
  // Always the first child, so the live region stays the same element when the list empties or fills again: a
  // region inserted together with its text is not read out.
  const live = <LiveRegion announcements={announcements} />;
  if (!items.length) return <>{live}</>;

  const clearDone = async () => {
    if (clearing || !done.length) return;
    setClearing(true);
    try { await controller.remove(done.map(item => item.id)); }
    catch (error) { showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error"); }
    finally { setClearing(false); }
  };
  const confirmCancelAll = (ids: string[]) => {
    controller.cancel(ids).catch(error => showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error"));
  };

  const actions = <>
    <Button type="button" variant="ghost" size="sm" data-testid="media-clear-done" title={t("queue.clear_done_hint")} disabled={!done.length || clearing} onClick={() => void clearDone()}>
      {clearing ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Eraser />}{t("queue.clear_done")}
    </Button>
    {active.length ? <Button type="button" variant="ghost" size="sm" data-testid="media-cancel-all" onClick={() => setCancelAll(active.map(item => item.id))}>
      <Square />{t("queue.cancel_all")}
    </Button> : null}
    <StartAllButton blocker={blocker} checking={flow.checking} onStart={() => onStart(idle.map(item => item.id))} />
  </>;

  return <>
    {live}
    <MediaSummary items={items} />
    <ToolPanel
      title={t("queue.title")}
      icon={ListVideo}
      badge={<Badge variant="secondary" data-testid="media-queue-count" className="font-mono text-[11px]">{items.length}</Badge>}
      actions={actions}
      className="media-queue"
    >
      <StudioTaskQueue data-testid="media-queue" aria-label={t("queue.title")}>
        {items.map(item => <MediaQueueRow
          key={item.id}
          item={item}
          controller={controller}
          planSettings={planSettings}
          engine={state.engine}
          observe={observe}
          onStart={onStart}
          startDisabled={startDisabled}
          onDetails={onDetails}
        />)}
      </StudioTaskQueue>
    </ToolPanel>
    <StartConfirmDialog flow={flow} items={items} settings={settings} />
    <ConfirmDialog
      open={cancelAll !== null}
      onOpenChange={open => { if (!open) setCancelAll(null); }}
      title={t("queue.cancel_all_title")}
      description={t("queue.cancel_all_body", { count: cancelShown?.length ?? 0 })}
      confirmText={t("queue.cancel_all_confirm")}
      cancelText={t("queue.cancel_all_keep")}
      onConfirm={() => { if (cancelAll) confirmCancelAll(cancelAll); }}
    />
    <FailureDetails item={detailsItem} onClose={() => setDetailsId(null)} />
  </>;
}
