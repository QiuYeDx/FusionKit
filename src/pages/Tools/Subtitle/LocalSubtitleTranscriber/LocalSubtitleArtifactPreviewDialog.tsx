import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Code2, Copy, FileText, Loader2, LockKeyhole, RefreshCw, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DialogDescription, DialogTitle, ScrollableDialog, ScrollableDialogContent, ScrollableDialogFooter, ScrollableDialogHeader } from "@/components/qiuye-ui/scrollable-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GeneratedSubtitleArtifactSummary } from "@/type/localSubtitle";
import type { LocalSubtitleArtifactTextResult } from "@/type/localSubtitleIpc";
import { showToast } from "@/utils/toast";
import { LocalSubtitleErrorNotice, type LocalSubtitleDisplayError } from "./LocalSubtitleErrorNotice";
import { createLocalSubtitleArtifactPreviewPage, filterLocalSubtitlePreview, LOCAL_SUBTITLE_PREVIEW_CUES_PER_PAGE, parseLocalSubtitlePreview } from "./localSubtitlePreviewModel";

export interface LocalSubtitleArtifactPreviewSelection {
  readonly taskName: string;
  readonly artifact: GeneratedSubtitleArtifactSummary;
}
type PreviewState = { ref?: string } & (
  | { status: "loading" }
  | { status: "ready"; data: LocalSubtitleArtifactTextResult }
  | { status: "error"; error: LocalSubtitleDisplayError }
);

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase(), parts = [];
  let cursor = 0, at = lower.indexOf(needle);
  while (at !== -1) {
    parts.push(text.slice(cursor, at), <mark key={at} className="rounded-sm bg-primary/15 text-foreground">{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length; at = lower.indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function LocalSubtitleArtifactPreviewDialog({ selection, onOpenChange }: {
  readonly selection: LocalSubtitleArtifactPreviewSelection | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["subtitle", "common"]);
  const generation = useRef(0), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const readingTab = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null), opener = useRef<HTMLElement | null>(null);
  const [retry, setRetry] = useState(0), [pageIndex, setPageIndex] = useState(0);
  const [mode, setMode] = useState("reading"), [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false), [copying, setCopying] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const artifactRef = selection?.artifact.artifactRef;
  useEffect(() => {
    const current = ++generation.current;
    setPageIndex(0); setMode("reading"); setQuery(""); setCopied(false); setCopying(false);
    clearTimeout(copyTimer.current);
    if (!artifactRef) return;
    setState({ status: "loading", ref: artifactRef });
    void window.localSubtitleApi.readArtifactText(artifactRef).then(result => {
      if (current !== generation.current) return;
      setState(result.ok ? { status: "ready", ref: artifactRef, data: result.data } : { status: "error", ref: artifactRef, error: result.error });
    }).catch((error: unknown) => {
      if (current === generation.current) setState({ status: "error", ref: artifactRef, error: {
        message: error instanceof Error ? error.message : t("subtitle:local_transcriber.preview.read_failed"),
      } });
    });
    return () => { generation.current++; clearTimeout(copyTimer.current); };
  }, [artifactRef, retry, t]);

  const data = state.ref === artifactRef && state.status === "ready" ? state.data : null;
  const error = state.ref === artifactRef && state.status === "error" ? state.error : null;
  const cues = useMemo(() => data ? parseLocalSubtitlePreview(data.rawText, data.format) : null, [data]);
  const effectiveMode = data && cues === null ? "raw" : mode;
  const filtered = useMemo(() => filterLocalSubtitlePreview(cues ?? [], query), [cues, query]);
  const rawPage = useMemo(() => createLocalSubtitleArtifactPreviewPage(data?.rawText ?? "", pageIndex), [data, pageIndex]);
  const pageCount = effectiveMode === "raw" ? rawPage.pageCount : Math.max(1, Math.ceil(filtered.length / LOCAL_SUBTITLE_PREVIEW_CUES_PER_PAGE));
  const currentPage = Math.min(pageIndex, pageCount - 1), start = currentPage * LOCAL_SUBTITLE_PREVIEW_CUES_PER_PAGE;
  const visible = filtered.slice(start, start + LOCAL_SUBTITLE_PREVIEW_CUES_PER_PAGE);
  const changeMode = (value: string) => { setMode(value); setPageIndex(0); setCopied(false); };
  const copy = async () => {
    if (!data || copying) return;
    const current = generation.current;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(effectiveMode === "raw" ? data.rawText : data.plainText);
      if (current !== generation.current) return;
      setCopied(true); clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { if (current === generation.current) showToast(t("subtitle:local_transcriber.preview.copy_failed"), "error"); }
    finally { if (current === generation.current) setCopying(false); }
  };

  return <ScrollableDialog open={selection !== null} onOpenChange={onOpenChange} maxWidth="sm:max-w-[920px]"
    contentClassName="h-[min(780px,85dvh)] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[20px] shadow-2xl"
    onOpenAutoFocus={event => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      event.preventDefault(); readingTab.current?.focus();
    }}
    onCloseAutoFocus={event => {
      if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); }
    }}>
    <Tabs value={effectiveMode} onValueChange={changeMode} className="contents">
      <ScrollableDialogHeader className="min-w-0 px-5 pb-4 pt-5 sm:px-7 sm:pt-6 [&_[data-slot=dialog-header]]:gap-0 [&_[data-slot=dialog-header]]:text-left">
        <div className="flex min-w-0 items-start gap-3 pr-6">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary"><FileText className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("subtitle:local_transcriber.preview.title")}</span>
              <span className="rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide">{selection?.artifact.format}</span>
            </div>
            <DialogTitle className="truncate text-lg leading-7 font-semibold tracking-tight sm:text-xl" title={selection?.artifact.displayName}>{selection?.artifact.displayName}</DialogTitle>
            <DialogDescription className="mt-1 truncate text-xs" title={selection?.taskName}>{selection?.taskName}</DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label={t("subtitle:local_transcriber.preview.view_label")} className="h-9 shrink-0">
            <TabsTrigger ref={readingTab} value="reading" disabled={!!data && cues === null} className="px-3 text-xs"><BookOpen />{t("subtitle:local_transcriber.preview.reading")}</TabsTrigger>
            <TabsTrigger value="raw" className="px-3 text-xs"><Code2 />{t("subtitle:local_transcriber.preview.raw")}</TabsTrigger>
          </TabsList>
          {effectiveMode === "reading" ? <div className="relative min-w-0 flex-1 basis-48 sm:max-w-72">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input ref={searchInput} aria-label={t("subtitle:local_transcriber.preview.search")} placeholder={t("subtitle:local_transcriber.preview.search")}
              value={query} maxLength={120} disabled={!data} onChange={e => { setQuery(e.target.value); setPageIndex(0); }} className="h-9 rounded-lg pr-9 pl-9 text-sm shadow-none" />
            {query && <Button variant="ghost" size="icon-sm" className="absolute top-0.5 right-0.5 size-8" aria-label={t("subtitle:local_transcriber.preview.clear_search")} onClick={() => { setQuery(""); setPageIndex(0); searchInput.current?.focus(); }}><X className="size-3.5" /></Button>}
          </div> : <span className="text-xs text-muted-foreground">{t("subtitle:local_transcriber.preview.raw_hint")}</span>}
        </div>
      </ScrollableDialogHeader>

      <ScrollableDialogContent key={`${artifactRef}-${effectiveMode}-${currentPage}-${query}`} fadeMasks fadeMaskHeight={18}
        className="min-h-0 min-w-0 bg-muted/10 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full [&_[data-slot=scroll-area-viewport]>div]:!min-w-0 [&_[data-slot=scroll-area-viewport]>div>div]:!p-0">
        {!data && !error ? <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><Loader2 className="size-6 animate-spin motion-reduce:animate-none text-primary" />{t("subtitle:local_transcriber.preview.loading")}</div> : null}
        {error ? <div className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-14"><LocalSubtitleErrorNotice error={error} /><Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}><RefreshCw className="size-4" />{t("subtitle:local_transcriber.preview.retry")}</Button></div> : null}
        {data ? <>
          <TabsContent value="reading" className="m-0" data-testid="local-subtitle-artifact-preview">
            {visible.length ? <ol className="divide-y divide-border/50" start={start + 1}>
              {visible.map(cue => <li key={cue.number} data-testid="local-subtitle-preview-cue" className="group grid grid-cols-[minmax(0,1fr)] gap-0.5 px-5 py-1.5 transition-colors hover:bg-muted/35 sm:grid-cols-[152px_minmax(0,1fr)] sm:items-center sm:gap-5 sm:px-7">
                <div className="flex items-center gap-3 text-xs sm:items-start sm:gap-2.5">
                  <span className="w-5 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">{String(cue.number).padStart(2, "0")}</span>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] leading-4 tabular-nums sm:block">
                    <div className="font-medium text-primary [overflow-wrap:anywhere]"><Highlight text={cue.start} query={query} /></div>
                    {cue.end && <div className="text-muted-foreground [overflow-wrap:anywhere]"><span aria-hidden="true" className="mr-1 opacity-50">→</span><Highlight text={cue.end} query={query} /></div>}
                  </div>
                </div>
                <p dir="auto" style={{ fontFamily: '"Yu Gothic UI", "Microsoft YaHei UI", system-ui, sans-serif' }} className="min-w-0 whitespace-pre-wrap text-[15px] leading-6 text-foreground/90 [overflow-wrap:anywhere] selection:bg-primary/20 sm:text-base"><Highlight text={cue.text} query={query} /></p>
              </li>)}
            </ol> : <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-6 text-center"><Search className="mb-2 size-7 text-muted-foreground/50" /><p className="text-sm font-medium">{t("subtitle:local_transcriber.preview.no_matches")}</p><p className="text-xs text-muted-foreground">{t("subtitle:local_transcriber.preview.search_hint")}</p></div>}
          </TabsContent>
          <TabsContent value="raw" className="m-0">
            {cues === null && <p className="border-b px-6 py-3 text-xs text-muted-foreground">{t("subtitle:local_transcriber.preview.raw_fallback")}</p>}
            <pre data-testid="local-subtitle-preview-raw" className="min-w-0 whitespace-pre-wrap px-5 py-5 font-mono text-[13px] leading-6 [overflow-wrap:anywhere] selection:bg-primary/20 sm:px-7">{rawPage.text}</pre>
          </TabsContent>
        </> : null}
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-3 sm:px-7">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><LockKeyhole className="size-3" />{t("subtitle:local_transcriber.preview.read_only")}</span>
          {data && <span role="status" className="tabular-nums">{effectiveMode === "reading" && query.trim() ? t("subtitle:local_transcriber.preview.matches", { count: filtered.length }) : t("subtitle:local_transcriber.preview.cue_count", { count: data.cueCount })}</span>}
          {data && pageCount > 1 && <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t("subtitle:local_transcriber.preview.previous_page")} disabled={currentPage === 0} onClick={() => setPageIndex(currentPage - 1)}><ChevronLeft className="size-4" /></Button>
            <span className="whitespace-nowrap tabular-nums">{t("subtitle:local_transcriber.preview.page", { current: currentPage + 1, total: pageCount })}</span>
            <Button variant="ghost" size="icon-sm" aria-label={t("subtitle:local_transcriber.preview.next_page")} disabled={currentPage === pageCount - 1} onClick={() => setPageIndex(currentPage + 1)}><ChevronRight className="size-4" /></Button>
          </div>}
        </div>
        <Button variant="outline" size="sm" disabled={!data || copying} className="ml-auto h-9 rounded-lg" onClick={() => void copy()}>
          {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
          <span aria-live="polite">{copied ? t("subtitle:local_transcriber.preview.copy_done") : effectiveMode === "raw" ? t("subtitle:local_transcriber.preview.copy_raw") : t("subtitle:local_transcriber.preview.copy_all")}</span>
        </Button>
      </ScrollableDialogFooter>
    </Tabs>
  </ScrollableDialog>;
}
