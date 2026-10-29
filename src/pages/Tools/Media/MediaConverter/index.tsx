import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FileAudio, FilePlay, Files, Info, ListFilter, MonitorX, TriangleAlert, X } from "lucide-react";
import { DialogMotionRegion } from "@/components/qiuye-ui/dialog-motion";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PICK_FILE_FILTERS, QUEUE_LIMITS, type AddFilesResult, type ItemSummary, type PickFileFilter } from "@/media-converter/contract";
import {
  getMediaConverterController,
  mediaErrorCodeOf,
  useMediaConverterState,
  type MediaConverterController,
} from "@/services/media-converter/controller";
import { showToast } from "@/utils/toast";
import ToolPageHeader from "../../_shared/ToolPageHeader";
import { TOOL_META, isMediaConverterSupported } from "../../_shared/toolMeta";
import { ToolDetailLayout } from "../../_shared/ui/ToolDetailLayout";
import { useToolFileDropTarget } from "../../_shared/ui/ToolFileDropScope";
import { ToolFilePickerSurface } from "../../_shared/ui/ToolFilePickerSurface";
import { StudioIconButton, StudioNotice } from "../../Subtitle/SubtitleStudio/StudioControls";
import { EngineStatusBadge, engineView } from "./EngineStatusBadge";
import {
  ADD_REJECTION_LABELS,
  ADD_REJECTION_MANY_LABELS,
  ENGINE_ADVICE_LABELS,
  ENGINE_UNAVAILABLE_LABELS,
  PICK_FILTER_LABELS,
  requestErrorLabel,
  type EngineUnavailableCode,
} from "./labels";
import { MediaConverterSettings } from "./MediaConverterSettings";
import { MediaQueue } from "./MediaQueue";

/**
 * 音视频转换 (media converter): compress videos, convert formats and extract audio with the bundled
 * ffmpeg, in the main process (module-workbench design). The route exists on every platform; where the
 * engine does not run (macOS until I4) the page keeps its header and explains, without a redirect, so
 * Escape and Back work as on any tool page.
 */
export default function MediaConverter() {
  const { t } = useTranslation("media");
  const supported = isMediaConverterSupported();
  if (!supported) return <UnsupportedPlatform header={<ToolPageHeader meta={TOOL_META.mediaConverter} title={t("title")} description={t("description")} />} />;
  return <MediaConverterWorkbench title={t("title")} description={t("description")} />;
}

type AddRejection = AddFilesResult["rejected"][number];

/** What one add did, when it did more than add files: shown under the upload area until dismissed or the next add. */
interface AddOutcome {
  /** Tells notices of two adds apart, so a repeated outcome is announced again. */
  id: number;
  added: number;
  /** Names of the items the files already were. */
  duplicates: string[];
  /** Files past the 100 one add takes. */
  truncated: number;
  /** Files the queue had no room for: it keeps 500 items, and only finished ones make room. */
  queueFull: number;
  rejected: AddRejection[];
}

/**
 * The engine counts both kinds of files left out as `truncated`; what the add was offered tells them apart:
 * every file of it is added, a duplicate, refused or left out, so all beyond the 100 of one add were left
 * out for that limit and the rest for the queue's.
 */
function splitTruncated(result: AddFilesResult): { truncated: number; queueFull: number } {
  const offered = result.added.length + result.duplicates.length + result.rejected.length + result.truncated;
  const truncated = Math.min(result.truncated, Math.max(0, offered - QUEUE_LIMITS.filesPerAdd));
  return { truncated, queueFull: result.truncated - truncated };
}

let outcomeIds = 0;

const runs = (item: ItemSummary) => item.state.status === "queued" || item.state.status === "running";

/**
 * The queue lives in the main process, so a run goes on when the page closes: leaving while one is
 * queued or running says so once (AC-WORKBENCH-04-4), as the long-text translator does.
 */
function useBackgroundNotice(items: readonly ItemSummary[]) {
  const { t } = useTranslation("media");
  const notice = t("queue.background");
  const latest = useRef({ items, notice });
  latest.current = { items, notice };
  useEffect(() => () => {
    if (latest.current.items.some(runs)) showToast(latest.current.notice);
  }, []);
}

/**
 * Adding files by the main-process dialog or by a drop (AC-WORKBENCH-02-1). An add that only added
 * says so in a toast; one with duplicates, files past the 100 of one add or refused files explains
 * them in a notice (AC-WORKBENCH-02-1, AC-WORKBENCH-02-3, AC-WORKBENCH-02-4).
 */
function useAddFiles(controller: MediaConverterController) {
  const { t } = useTranslation("media");
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  // One dialog at a time; a ref, as nothing on the page shows it.
  const picking = useRef(false);
  const settle = async (pending: Promise<AddFilesResult>) => {
    try {
      const result = await pending;
      if (!result.added.length && !result.duplicates.length && !result.rejected.length && !result.truncated) return; // A cancelled dialog.
      const names = new Map(controller.getState().items.map(item => [item.id, item.displayName]));
      const next: AddOutcome = {
        id: ++outcomeIds,
        added: result.added.length,
        duplicates: result.duplicates.map(id => names.get(id) ?? id),
        ...splitTruncated(result),
        rejected: result.rejected,
      };
      if (next.duplicates.length || next.truncated || next.queueFull || next.rejected.length) {
        setOutcome(next);
      } else {
        setOutcome(null);
        showToast(t("upload.added", { count: next.added }), "success");
      }
    } catch (error) {
      showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error");
    }
  };
  const pick = async (filter: PickFileFilter) => {
    if (picking.current) return;
    picking.current = true;
    try {
      await settle(controller.pickFiles(filter));
    } finally {
      picking.current = false;
    }
  };
  // Called in the drop event itself: the preload reads the dropped files' paths before anything awaits (FK-PIT-0148).
  const drop = (files: File[]) => { void settle(controller.addDroppedFiles(files)); };
  return { outcome, pick, drop, dismiss: () => setOutcome(null) };
}

/**
 * The tool where the engine runs: its status in the header, the settings in the aside
 * (T-WORKBENCH-02), the files and the queue in the main column. On a narrow window the main column
 * comes first, so progress and results stay on top, as on the other queue pages. Files dropped
 * anywhere on the page are added (design 上传: 页面级拖放).
 */
function MediaConverterWorkbench({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation("media");
  const controller = getMediaConverterController();
  const state = useMediaConverterState(controller);
  // A panel taller than the window even with "output and performance" folded is not held in place
  // (`lg:sticky`), so its end can still be scrolled to.
  const [tall, setTall] = useState(false);
  const adding = useAddFiles(controller);
  useBackgroundNotice(state.items);
  const view = engineView(state);
  const unavailable = view.kind === "unavailable" ? view.code : null;
  // A detection in progress still lets files in; it only holds back the start (module-engine R-ENGINE-03).
  const disabled = unavailable !== null || state.phase !== "ready";
  const { dragging, dropProps } = useToolFileDropTarget({
    label: t("upload.drop_label"),
    pageWide: true,
    disabled,
    onDrop: event => adding.drop(Array.from(event.dataTransfer.files)),
  });
  const header = <ToolPageHeader meta={TOOL_META.mediaConverter} title={title} description={description} right={<EngineStatusBadge state={state} controller={controller} />} />;
  return <div data-testid="media-converter" data-platform="supported" {...dropProps}>
    <ToolDetailLayout
      header={header}
      aside={<MediaConverterSettings state={state} controller={controller} onTallChange={setTall} />}
      asideClassName={cn("order-2 lg:order-1", tall && "lg:static")}
      mainClassName="order-1 lg:order-2"
    >
      <MediaUploadSurface
        unavailable={unavailable}
        disabled={disabled}
        compact={state.items.length > 0}
        dragging={dragging}
        onPick={filter => void adding.pick(filter)}
      />
      {adding.outcome ? <AddNotice outcome={adding.outcome} onDismiss={adding.dismiss} /> : null}
      <MediaQueue state={state} controller={controller} />
    </ToolDetailLayout>
  </div>;
}

const FILTER_ICONS = { video: FilePlay, audio: FileAudio, all: Files } as const satisfies Record<PickFileFilter, unknown>;

/**
 * Adding files through the main-process dialog, every media type at once or, from the menu, only
 * videos or only audio (AC-WORKBENCH-02-1). Tall and centred while the queue is empty, a compact bar
 * once it has files, with its height moving between the two. While the engine cannot be used it is
 * disabled and says why, as the header does (AC-WORKBENCH-05-1).
 */
function MediaUploadSurface({ unavailable, disabled, compact, dragging, onPick }: {
  unavailable: EngineUnavailableCode | null;
  disabled: boolean;
  compact: boolean;
  dragging: boolean;
  onPick: (filter: PickFileFilter) => void;
}) {
  const { t } = useTranslation("media");
  const layout = compact ? "horizontal" : "stacked";
  const description: ReactNode = unavailable
    // The whole surface is dimmed while disabled; the reason keeps the body colour so it still reads clearly.
    ? <span data-testid="media-upload-reason" className="text-foreground">{t("upload.unavailable", { reason: t(ENGINE_UNAVAILABLE_LABELS[unavailable]), advice: t(ENGINE_ADVICE_LABELS[unavailable]) })}</span>
    : dragging ? t("upload.drop_hint") : t(compact ? "upload.hint_more" : "upload.hint");
  return <DialogMotionRegion transitionKey={layout}>
    <ToolFilePickerSurface
      data-testid="media-upload"
      data-state={unavailable ? "unavailable" : "ready"}
      data-layout={layout}
      layout={layout}
      title={t("upload.title")}
      description={description}
      actionLabel={t("upload.choose")}
      dragging={dragging}
      // The dialog is modal and a second pick is ignored: not disabled while it is open, so the surface
      // does not dim behind it and the button keeps the keyboard focus.
      disabled={disabled}
      onSelect={() => onPick("all")}
      secondaryAction={<FilterMenu disabled={disabled} onPick={onPick} />}
    />
  </DialogMotionRegion>;
}

/** Only videos, only audio, or every media file: the main-process dialog's filter. */
function FilterMenu({ disabled, onPick }: { disabled: boolean; onPick: (filter: PickFileFilter) => void }) {
  const { t } = useTranslation("media");
  // The surface opens the dialog on any click inside it: the menu's own clicks stop here (also those of its
  // portalled content, which React still bubbles through this tree).
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return <span className="contents" onClick={stop}>
    <DropdownMenu>
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button data-testid="media-upload-filter" type="button" variant="outline" size="icon-sm" aria-label={t("upload.filter_menu")} disabled={disabled}>
              <ListFilter className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t("upload.filter_menu")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" data-testid="media-upload-filter-menu">
        {PICK_FILE_FILTERS.map(filter => {
          const Icon = FILTER_ICONS[filter];
          return <DropdownMenuItem key={filter} data-testid={`media-upload-filter-${filter}`} onSelect={() => onPick(filter)}>
            <Icon />{t(PICK_FILTER_LABELS[filter])}
          </DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  </span>;
}

/** Up to this many names in a line; the rest are counted. */
const NAMES_SHOWN = 3;

/**
 * What an add did besides adding: files already in the list (by identity, AC-WORKBENCH-02-4), files past
 * the 100 of one add (AC-WORKBENCH-02-1), and every refused file with its reason and what to do: a folder,
 * a temporary copy whose original cannot be found, a file that is gone (AC-WORKBENCH-02-3).
 */
function AddNotice({ outcome, onDismiss }: { outcome: AddOutcome; onDismiss: () => void }) {
  const { t } = useTranslation("media");
  const separator = t("queue.list_separator");
  const listed = (names: string[]) => {
    const shown = names.slice(0, NAMES_SHOWN).join(separator);
    return names.length > NAMES_SHOWN ? t("add.names_more", { names: shown, count: names.length - NAMES_SHOWN }) : shown;
  };
  const byCode = new Map<AddRejection["code"], string[]>();
  for (const entry of outcome.rejected) byCode.set(entry.code, [...(byCode.get(entry.code) ?? []), entry.displayName]);
  const lines: { key: string; text: string }[] = [];
  if (outcome.added) lines.push({ key: "added", text: t("add.added", { count: outcome.added }) });
  if (outcome.duplicates.length === 1) lines.push({ key: "duplicate", text: t("add.duplicate", { name: outcome.duplicates[0] }) });
  else if (outcome.duplicates.length) lines.push({ key: "duplicate", text: t("add.duplicates", { count: outcome.duplicates.length, names: listed(outcome.duplicates) }) });
  if (outcome.truncated) lines.push({ key: "truncated", text: t("add.truncated", { count: outcome.truncated }) });
  if (outcome.queueFull) lines.push({ key: "queue_full", text: t("add.queue_full", { count: outcome.queueFull }) });
  for (const [code, names] of byCode) {
    lines.push({
      key: code,
      text: names.length === 1 ? t(ADD_REJECTION_LABELS[code], { name: names[0] }) : t(ADD_REJECTION_MANY_LABELS[code], { count: names.length, names: listed(names) }),
    });
  }
  const problem = outcome.truncated > 0 || outcome.queueFull > 0 || outcome.rejected.length > 0;
  // Files left out are announced at once, as the long-text notices do; "already in the list" only politely.
  return <StudioNotice key={outcome.id} role={problem ? "alert" : "status"} data-testid="media-add-notice" data-problem={problem || undefined} className="bg-card">
    {problem ? <TriangleAlert className="text-amber-600 dark:text-amber-400" /> : <Info className="text-muted-foreground" />}
    <span className="leading-5">
      {lines.map(line => <span key={line.key} data-testid={`media-add-notice-${line.key}`} className="block">{line.text}</span>)}
    </span>
    <StudioIconButton data-testid="media-add-notice-dismiss" label={t("add.dismiss")} onClick={onDismiss}><X /></StudioIconButton>
  </StudioNotice>;
}

/** No settings and no upload: the header, then why the tool is missing here (AC-WORKBENCH-01-2). */
function UnsupportedPlatform({ header }: { header: ReactNode }) {
  const { t } = useTranslation("media");
  return <div data-testid="media-converter" data-platform="unsupported">
    <ToolDetailLayout header={header} aside={null} asideClassName="hidden" className="lg:[&>div.grid]:grid-cols-1">
      <SmoothCorners
        radius={16}
        smoothing={0.72}
        data-testid="media-converter-unsupported"
        aria-labelledby="media-converter-unsupported-title"
        className="flex flex-col items-center gap-3 border bg-card px-6 py-10 text-center text-card-foreground"
        asChild
      >
        <section>
          <div className="flex size-10 items-center justify-center rounded-smooth-lg border bg-muted/40 text-foreground/70">
            <MonitorX aria-hidden className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 id="media-converter-unsupported-title" className="text-sm font-semibold">{t("unsupported.title")}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("unsupported.body")}</p>
          </div>
        </section>
      </SmoothCorners>
    </ToolDetailLayout>
  </div>;
}
