import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AudioLines, BookOpenText, ChevronRight, Eye, FileInput, FileOutput, Files, FolderOpen, Languages, Loader2, PencilLine, Scissors, Undo2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import ConfirmDialog from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import type { ActivityAction, ActivityFilter, ActivityRecord } from "@/agent/external/activity";
import { activityBadges, activityDuration, activityError, activityResults, activitySentence, toolLabel, type ActivityTone } from "@/agent/external/activity-text";
import { studioDocumentPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";

const ICONS: Record<ActivityAction, LucideIcon> = {
  import: FileInput, translation: Languages, structure: Scissors, export: FileOutput,
  transcription: AudioLines, knowledge: BookOpenText, files: Files, rename: PencilLine,
};
/** Changes recorded without a summary (refused before the window saw them) still show what kind they were. */
const TOOL_ACTIONS: Partial<Record<string, ActivityAction>> = {
  import_studio_subtitles: "import", create_studio_translation_track: "translation", write_studio_translations: "translation",
  split_studio_cue: "structure", insert_studio_cue: "structure", export_studio_document: "export", start_studio_transcription: "transcription",
  prepare_knowledge_changes: "knowledge", convert_subtitle_files: "files", extract_subtitle_language: "files", rename_paths: "rename", undo_name_changes: "rename",
};
const TONES: Record<ActivityTone, string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

const dayKey = (at: number) => new Date(at).toDateString();
function dayLabel(t: (key: string) => string, at: number): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(at) === today.toDateString()) return t("external_agent.activity.today");
  if (dayKey(at) === yesterday.toDateString()) return t("external_agent.activity.yesterday");
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function Row({ record, showClient, onChange }: { record: ActivityRecord; showClient: boolean; onChange: (record: ActivityRecord) => void }) {
  const { t } = useTranslation("setting");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState<"ask" | "running" | null>(null);
  const detailsId = useId();
  const summary = record.note?.summary;
  const action = summary?.action ?? TOOL_ACTIONS[record.tool];
  const Icon = action ? ICONS[action] : Eye;
  const sentence = activitySentence(t, record);
  const tool = toolLabel(t, record.tool);
  const badges = activityBadges(t, record);
  const results = activityResults(t, record);
  const error = activityError(t, record);
  const duration = activityDuration(t, record);
  const items = summary?.items ?? [];
  const outputs = record.note?.outputs ?? [];
  const document = record.note?.target;
  const canUndo = record.note?.undo?.kind === "rename" && record.status === "ok" && !record.undone;
  const settled = record.status === "ok";

  const undo = async () => {
    const journalId = record.note?.undo?.journalId;
    if (!journalId || !window.nameTranslation) return;
    setUndoing("running");
    try {
      const result = await window.nameTranslation.undo({ journalId });
      if (!result.ok) throw new Error(result.error.message || result.error.code);
      const marked = await window.externalAgent?.activityUndone(record.id);
      if (marked?.ok && marked.value) onChange(marked.value);
      toast.success(t("external_agent.activity.undone_toast", { count: result.data.restoredCount }));
    } catch (failure) {
      toast.error(t("external_agent.activity.undo_failed", { reason: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      setUndoing(null);
    }
  };

  return (
    <li className="grid grid-cols-[2.75rem_1rem_minmax(0,1fr)_auto] gap-x-2.5" data-testid="external-activity-record" data-status={record.status} data-tool={record.tool}>
      <button type="button" aria-expanded={open} aria-controls={detailsId} title={t("external_agent.activity.expand")}
        onClick={() => setOpen(value => !value)}
        className="col-span-4 grid grid-cols-subgrid items-start rounded-smooth-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
        <span className="pt-px text-xs tabular-nums text-muted-foreground">{new Date(record.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
        <Icon aria-hidden className="mt-[3px] size-3.5 text-muted-foreground" />
        <span className="min-w-0">
          <span className={cn("block text-[13px] leading-5 break-words", !open && "line-clamp-2", !settled && "text-muted-foreground")} data-testid="external-activity-sentence">{sentence}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <span className="truncate">{[showClient ? record.client.name : null, sentence === tool ? null : tool, duration].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
        <span className="flex max-w-56 flex-wrap justify-end gap-1 pt-px">
          {badges.map(badge => <span key={badge.label} className={cn("inline-flex h-5 items-center rounded-full border px-2 text-[11px] whitespace-nowrap", TONES[badge.tone])} data-testid="external-activity-badge">{badge.label}</span>)}
        </span>
      </button>
      {open && (
        <div id={detailsId} className="col-span-2 col-start-3 flex flex-col gap-2 pb-3 pr-2 text-[13px]" data-testid="external-activity-details">
          {items.length > 0 && (
            <ul className="divide-y rounded-smooth-md border bg-muted/30">
              {items.map((item, index) => (
                <li key={index} className="px-3 py-1.5">
                  <div className="break-words">{item.from && <span className="text-muted-foreground">{item.from} → </span>}{item.text}</div>
                  {item.detail && <div className="mt-0.5 text-xs break-all text-muted-foreground">{item.detail}</div>}
                </li>
              ))}
              {summary?.more ? <li className="px-3 py-1.5 text-muted-foreground">{t("external_agent.activity.more", { count: summary.more })}</li> : null}
            </ul>
          )}
          {results.length > 0 && <div className="text-xs text-muted-foreground" data-testid="external-activity-results">{results.join(" · ")}</div>}
          {error && <div className="text-xs text-destructive" data-testid="external-activity-error">{error}</div>}
          {record.note?.reason && <div className="text-xs break-words text-muted-foreground">{t("external_agent.activity.reason", { reason: record.note.reason })}</div>}
          {(document || canUndo || outputs.length > 0) && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {document && <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => navigate(studioDocumentPath(document.documentId))} data-testid="external-activity-open-document">
                <FileOutput className="size-3.5" />{t("external_agent.activity.open_document")}</Button>}
              {canUndo && <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={undoing !== null} onClick={() => setUndoing("ask")} data-testid="external-activity-undo">
                {undoing === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}{t("external_agent.activity.undo_rename")}</Button>}
              {outputs.length > 0 && <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => void window.ipcRenderer.invoke("show-item-in-folder", outputs[0])} data-testid="external-activity-reveal">
                <FolderOpen className="size-3.5" />{t("external_agent.activity.reveal")}</Button>}
            </div>
          )}
        </div>
      )}
      <ConfirmDialog open={undoing === "ask"} onOpenChange={value => { if (!value && undoing === "ask") setUndoing(null); }} title={t("external_agent.activity.undo_title")}
        description={t("external_agent.activity.undo_body")} confirmText={t("external_agent.activity.undo_action")} onConfirm={() => void undo()} />
    </li>
  );
}

export function ActivityTimeline({ records, state, filter, empty, showClient, hasMore, loadingMore, onRetry, onMore, onChange }: {
  records: ActivityRecord[];
  state: "loading" | "ready" | "error";
  filter: ActivityFilter;
  empty: ActivityFilter | "none";
  showClient: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onMore: () => void;
  onChange: (record: ActivityRecord) => void;
}) {
  const { t } = useTranslation("setting");
  const sentinel = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const result: { key: string; at: number; records: ActivityRecord[] }[] = [];
    for (const record of records) {
      const key = dayKey(record.startedAt);
      const last = result.at(-1);
      if (last?.key === key) last.records.push(record);
      else result.push({ key, at: record.startedAt, records: [record] });
    }
    return result;
  }, [records]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onMore(); }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onMore]);

  if (state === "loading" && !records.length) {
    return <div className="flex flex-col gap-3 p-4" aria-busy="true">{[0, 1, 2].map(index => <div key={index} className="h-9 animate-pulse rounded-smooth-md bg-muted/60 motion-reduce:animate-none" />)}</div>;
  }
  if (state === "error") {
    return <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground" data-testid="external-activity-load-failed">
      {t("external_agent.activity.load_failed")}<Button size="sm" variant="outline" onClick={onRetry}>{t("external_agent.activity.retry")}</Button>
    </div>;
  }
  if (!records.length) {
    const key = empty === "none" ? "none" : empty;
    return <p className="px-6 py-12 text-center text-sm text-muted-foreground" data-testid="external-activity-empty" data-filter={filter}>{t(`external_agent.activity.empty.${key}`)}</p>;
  }
  return (
    <div className="flex flex-col pb-1.5" data-testid="external-activity-timeline">
      {groups.map(group => (
        <section key={group.key} aria-label={dayLabel(t, group.at)}>
          <h3 className="sticky top-10 z-10 border-b bg-card/95 px-3 py-1.5 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">{dayLabel(t, group.at)}</h3>
          <ol className="flex flex-col p-1.5">{group.records.map(record => <Row key={record.id} record={record} showClient={showClient} onChange={onChange} />)}</ol>
        </section>
      ))}
      {hasMore && <div ref={sentinel} className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
        {loadingMore && <Loader2 className="size-3.5 animate-spin" />}{t("external_agent.activity.loading_more")}
      </div>}
    </div>
  );
}
