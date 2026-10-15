import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ActivitySessionSummary } from "@/agent/external/activity";
import { ALL_SESSIONS, useExternalActivityStore } from "@/agent/external/activity-store";

type T = (key: string, options?: Record<string, unknown>) => string;

export function clockTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${time}`;
}

/** “Connected 12 min” for a live connection, “Ended 10-14 10:05” otherwise. */
export function sessionTime(t: T, session: ActivitySessionSummary, live: boolean): string {
  if (live) {
    const minutes = Math.floor((Date.now() - session.connectedAt) / 60_000);
    return minutes > 0 ? t("external_agent.activity.connected_minutes", { count: minutes }) : t("external_agent.activity.connected_now");
  }
  return session.endedAt ? t("external_agent.activity.ended_at", { time: clockTime(session.endedAt) }) : t("external_agent.activity.connected_at", { time: clockTime(session.connectedAt) });
}

function Row({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-current={active ? "true" : undefined} onClick={onClick} data-testid={testId}
      className={cn(
        "flex min-h-9 w-full min-w-0 items-start gap-2.5 rounded-smooth-lg px-2.5 py-2 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
        active && "bg-muted font-medium text-foreground hover:bg-muted",
      )}>
      {children}
    </button>
  );
}

export function SessionList({ sessions, liveIds, selected, onSelect }: {
  sessions: ActivitySessionSummary[] | null;
  liveIds: ReadonlySet<string>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("setting");
  const unseen = useExternalActivityStore(state => state.unseen);
  const total = sessions?.reduce((sum, item) => sum + item.changes, 0) ?? 0;
  return (
    <ScrollArea className="max-h-[min(60vh,560px)]" data-testid="external-activity-sessions">
      <nav className="flex flex-col gap-1 p-1.5" aria-label={t("external_agent.activity.connections")}>
        <Row active={selected === ALL_SESSIONS} onClick={() => onSelect(ALL_SESSIONS)} testId="external-activity-session-all">
          <Layers aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("external_agent.activity.all_connections")}</span>
          <span className="min-w-5 shrink-0 rounded px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground" title={t("external_agent.activity.changes_count", { count: total })}>{total}</span>
        </Row>
        {sessions?.map(session => {
          const live = liveIds.has(session.id);
          const fresh = unseen[session.id] ?? 0;
          return (
            <Row key={session.id} active={selected === session.id} onClick={() => onSelect(session.id)} testId="external-activity-session">
              <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={session.client.name}>{session.client.name}</span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">{sessionTime(t, session, live)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 pt-px">
                {session.problems > 0 && <span className="size-1.5 rounded-full bg-destructive" role="img" aria-label={t("external_agent.activity.problems_count", { count: session.problems })} title={t("external_agent.activity.problems_count", { count: session.problems })} />}
                <span className={cn("min-w-5 rounded px-1 text-center text-[11px] font-medium tabular-nums", fresh ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
                  title={t("external_agent.activity.changes_count", { count: session.changes })}>{session.changes}</span>
              </span>
            </Row>
          );
        })}
      </nav>
    </ScrollArea>
  );
}
