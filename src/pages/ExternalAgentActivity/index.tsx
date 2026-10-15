import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, PlugZap, Trash2 } from "lucide-react";
import { toast } from "sonner";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui/ToolDetailLayout";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ConfirmDialog from "@/components/ConfirmDialog";
import { matchesFilter, type ActivityFilter, type ActivityRecord, type ActivitySessionSummary } from "@/agent/external/activity";
import { ALL_SESSIONS, setActivityViewing, useExternalActivityStore } from "@/agent/external/activity-store";
import { useExternalAgentStore } from "@/agent/external/store";
import { readActivitySession } from "./route";
import { ActivityTimeline } from "./ActivityTimeline";
import { SessionList, sessionTime } from "./SessionList";

const PAGE_SIZE = 100;
const HEADER_META = { icon: Bot, toneVar: "--tool-converter" } as const;

/** The records of one connection (or all), newest first, loaded a page at a time and kept live. */
function useRecords(sessionId: string | undefined, filter: ActivityFilter) {
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [next, setNext] = useState<{ at: number; id: string } | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const api = typeof window === "undefined" ? undefined : window.externalAgent;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState("loading");
    try {
      const result = await api!.activityList({ filter, limit: PAGE_SIZE, ...(sessionId ? { sessionId } : {}) });
      if (current !== generation.current) return;
      if (!result.ok) throw new Error(result.error);
      setRecords(result.value.records); setNext(result.value.next); setState("ready");
    } catch {
      if (current === generation.current) setState("error");
    }
  }, [api, filter, sessionId]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const result = await api!.activityList({ filter, limit: PAGE_SIZE, before: next, ...(sessionId ? { sessionId } : {}) });
      if (current !== generation.current || !result.ok) return;
      setRecords(items => [...items, ...result.value.records.filter(record => !items.some(item => item.id === record.id))]);
      setNext(result.value.next);
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }, [api, filter, next, loadingMore, sessionId]);

  useEffect(() => { if (api) void load(); }, [api, load]);
  useEffect(() => api?.onActivity(event => {
    if (event.type === "cleared") { void load(); return; }
    const record = event.record;
    if (sessionId && record.sessionId !== sessionId) return;
    setRecords(items => {
      const index = items.findIndex(item => item.id === record.id);
      if (index >= 0) return items.map(item => item.id === record.id ? record : item).filter(item => matchesFilter(item, filter));
      return matchesFilter(record, filter) ? [record, ...items] : items;
    });
  }), [api, filter, load, sessionId]);

  const replace = useCallback((record: ActivityRecord) => setRecords(items => items.map(item => item.id === record.id ? record : item)), []);
  return { records, state, hasMore: !!next, loadingMore, load, loadMore, replace };
}

export default function ExternalAgentActivity() {
  const { t } = useTranslation("setting");
  const [searchParams, setSearchParams] = useSearchParams();
  const status = useExternalAgentStore(state => state.status);
  const revision = useExternalActivityStore(state => state.revision);
  const api = typeof window === "undefined" ? undefined : window.externalAgent;
  const [sessions, setSessions] = useState<ActivitySessionSummary[] | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("changes");
  const [clearing, setClearing] = useState(false);
  const requested = readActivitySession(searchParams.toString());
  const liveIds = useMemo(() => new Set(status?.sessions.map(session => session.id) ?? []), [status]);

  // Counts and connections follow every recorded call and connection change.
  useEffect(() => {
    if (!api) return;
    let current = true;
    void api.activitySessions().then(result => { if (current && result.ok) setSessions(result.value); }).catch(() => undefined);
    return () => { current = false; };
  }, [api, revision, liveIds]);

  // Without a choice: the live connection if there is one, otherwise all of them.
  const selected = requested ?? (sessions?.find(session => session.live)?.id ?? ALL_SESSIONS);
  const select = (id: string) => setSearchParams(id === ALL_SESSIONS ? {} : { session: id }, { replace: true });
  useEffect(() => { setActivityViewing(selected); return () => setActivityViewing(null); }, [selected]);

  const sessionId = selected === ALL_SESSIONS ? undefined : selected;
  const { records, state, hasMore, loadingMore, load, loadMore, replace } = useRecords(sessionId, filter);
  const session = sessions?.find(item => item.id === sessionId);
  const live = !!session && liveIds.has(session.id);
  const counts = session ?? (sessions ? { changes: sessions.reduce((sum, item) => sum + item.changes, 0), problems: sessions.reduce((sum, item) => sum + item.problems, 0) } : undefined);

  const clear = async () => {
    const result = await api?.activityClear();
    if (result?.ok) { toast.success(t("external_agent.activity.cleared")); select(ALL_SESSIONS); }
  };

  const enabled = !!status?.enabled;
  const nothingYet = state === "ready" && sessions !== null && sessions.length === 0 && records.length === 0;
  const header = <ToolPageHeader meta={HEADER_META} title={t("external_agent.activity.title")} description={t("external_agent.activity.description")} />;
  const aside = (
    <ToolPanel title={t("external_agent.activity.connections")} icon={PlugZap} bodyClassName="flex flex-col"
      footer={<div className="flex items-center justify-between gap-2 py-1">
        <span className="text-[11px] text-muted-foreground">{t("external_agent.activity.retention")}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" disabled={!sessions?.length && !records.length}
          onClick={() => setClearing(true)} data-testid="external-activity-clear"><Trash2 className="size-3.5" />{t("external_agent.activity.clear")}</Button>
      </div>}>
      <SessionList sessions={sessions} liveIds={liveIds} selected={selected} onSelect={select} />
    </ToolPanel>
  );

  const filterControl = (
    <SegmentedControl size="sm" variant="contained" value={filter} onValueChange={value => setFilter(value as ActivityFilter)} aria-label={t("external_agent.activity.filter.label")} data-testid="external-activity-filter"
      items={[
        { value: "changes", label: <>{t("external_agent.activity.filter.changes")}{counts ? <span className="ml-1 tabular-nums text-muted-foreground">{counts.changes}</span> : null}</>, ariaLabel: t("external_agent.activity.filter.changes"), testId: "external-activity-filter-changes" },
        { value: "all", label: t("external_agent.activity.filter.all"), testId: "external-activity-filter-all" },
        { value: "problems", label: <>{t("external_agent.activity.filter.problems")}{counts?.problems ? <span className="ml-1 tabular-nums text-destructive">{counts.problems}</span> : null}</>, ariaLabel: t("external_agent.activity.filter.problems"), testId: "external-activity-filter-problems" },
      ]} />
  );

  const title = session ? (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate" title={session.client.name}>{session.client.name}</span>
      {session.client.version && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{t("external_agent.activity.version", { version: session.client.version })}</span>}
    </span>
  ) : t("external_agent.activity.all_connections");

  return (
    <ToolDetailLayout header={header} aside={aside} className="external-activity md:[&>div.grid]:grid-cols-[240px_minmax(0,1fr)] lg:[&>div.grid]:grid-cols-[280px_minmax(0,1fr)]"
      asideClassName="hidden md:block md:sticky md:top-10 lg:w-full">
      {/* Narrow windows choose the connection here; the list column is hidden. */}
      {sessions && sessions.length > 0 && (
        <div className="md:hidden">
          <Select value={selected} onValueChange={select}>
            <SelectTrigger className="w-full" aria-label={t("external_agent.activity.connections")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SESSIONS}>{t("external_agent.activity.all_connections")}</SelectItem>
              {sessions.map(item => <SelectItem key={item.id} value={item.id}>{item.client.name} · {sessionTime(t, item, liveIds.has(item.id))}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <ToolPanel id="external-activity-panel" title={title} actions={filterControl} bodyClassName="min-h-48">
        {session && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground" data-testid="external-activity-session-summary">
            <span className="flex items-center gap-1.5">
              <span className={live ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-muted-foreground/40"} aria-hidden />
              {live ? t("external_agent.activity.live") : t("external_agent.activity.ended")} · {sessionTime(t, session, live)}
            </span>
            {live && status && <span>{t("external_agent.activity.trust_now", { trust: t(`external_agent.trust.${status.trust}.name`) })}</span>}
            {live && <Button variant="outline" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => void api?.closeSession(session.id)}>{t("external_agent.activity.disconnect")}</Button>}
          </div>
        )}
        {!enabled && nothingYet ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="external-activity-disabled">
            <div className="text-sm font-medium">{t("external_agent.activity.empty.disabled_title")}</div>
            <p className="max-w-md text-xs text-muted-foreground">{t("external_agent.activity.empty.disabled_body")}</p>
            <Button asChild size="sm" variant="outline"><Link to="/setting?tab=external">{t("external_agent.activity.empty.go_settings")}</Link></Button>
          </div>
        ) : (
          <ActivityTimeline records={records} state={state} filter={filter} empty={nothingYet ? "none" : filter} showClient={!sessionId}
            hasMore={hasMore} loadingMore={loadingMore} onRetry={() => void load()} onMore={() => void loadMore()} onChange={replace} />
        )}
      </ToolPanel>
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title={t("external_agent.activity.clear_title")} description={t("external_agent.activity.clear_body")}
        confirmText={t("external_agent.activity.clear_action")} variant="destructive" onConfirm={() => { setClearing(false); void clear(); }} />
    </ToolDetailLayout>
  );
}
