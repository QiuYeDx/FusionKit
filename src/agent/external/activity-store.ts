import { create } from "zustand";
import { toast } from "sonner";
import i18n from "@/i18n";
import { ranUnasked, type ActivityRecord } from "./activity";
import { activitySentence } from "./activity-text";
import type { ExternalActivityEvent, ExternalAgentApi } from "./contract";

const SEEN_KEY = "fusionkit-external-activity-seen";
/** Changes from one connection within this time share one notice. */
export const NOTICE_MERGE_MS = 5000;
export const ALL_SESSIONS = "all";

interface ExternalActivityState {
  /** Changes that ran without asking after this time are unseen. */
  lastSeenAt: number;
  /** Unseen unasked changes per connection. */
  unseen: Record<string, number>;
  /** The connection (or ALL_SESSIONS) the activity page shows, while it is open. */
  viewing: string | null;
  notices: boolean;
  /** Bumps on every recorded call, so open views refresh their counts. */
  revision: number;
}

function readSeen(): number {
  try { const value = Number(globalThis.localStorage?.getItem(SEEN_KEY)); return Number.isFinite(value) ? value : 0; }
  catch { return 0; }
}

export const useExternalActivityStore = create<ExternalActivityState>(() => ({
  lastSeenAt: 0, unseen: {}, viewing: null, notices: true, revision: 0,
}));

export const unseenTotal = (state: Pick<ExternalActivityState, "unseen">) => Object.values(state.unseen).reduce((sum, value) => sum + value, 0);

/** The activity page is on screen: everything up to now counts as seen. */
export function markActivitySeen(now = Date.now()): void {
  try { globalThis.localStorage?.setItem(SEEN_KEY, String(now)); } catch { /* a convenience only */ }
  useExternalActivityStore.setState({ lastSeenAt: now, unseen: {} });
}

export function setActivityViewing(viewing: string | null): void {
  useExternalActivityStore.setState({ viewing });
  if (!viewing) return;
  markActivitySeen();
  // What the notices pointed at is on screen now.
  for (const sessionId of [...groups.keys()]) {
    if (viewing !== ALL_SESSIONS && viewing !== sessionId) continue;
    toast.dismiss(`external-activity-${sessionId}`);
    groups.delete(sessionId);
  }
}

export function setActivityNotices(notices: boolean): void {
  useExternalActivityStore.setState({ notices });
}

const counted = new Set<string>();
const groups = new Map<string, { count: number; until: number }>();

/** What one recorded call means for the indicator and the notices. */
export function noteActivityEvent(event: ExternalActivityEvent, options: { now?: number; open?: (sessionId: string) => void } = {}): void {
  const state = useExternalActivityStore.getState();
  if (event.type === "cleared") {
    counted.clear(); groups.clear();
    useExternalActivityStore.setState({ unseen: {}, revision: state.revision + 1 });
    return;
  }
  useExternalActivityStore.setState({ revision: state.revision + 1 });
  const record = event.record;
  if (!ranUnasked(record) || record.startedAt <= state.lastSeenAt || counted.has(record.id)) return;
  counted.add(record.id);
  if (state.viewing === ALL_SESSIONS || state.viewing === record.sessionId) { markActivitySeen(options.now); return; }
  useExternalActivityStore.setState(current => ({ unseen: { ...current.unseen, [record.sessionId]: (current.unseen[record.sessionId] ?? 0) + 1 } }));
  if (state.notices) notify(record, options);
}

function notify(record: ActivityRecord, options: { now?: number; open?: (sessionId: string) => void }) {
  const now = options.now ?? Date.now();
  const group = groups.get(record.sessionId);
  const count = group && now < group.until ? group.count + 1 : 1;
  groups.set(record.sessionId, { count, until: now + NOTICE_MERGE_MS });
  const t = i18n.getFixedT(null, "setting");
  const message = count === 1
    ? t("setting:external_agent.activity.notice.one", { client: record.client.name, action: activitySentence(t, record) })
    : t("setting:external_agent.activity.notice.many", { client: record.client.name, count });
  toast(message, {
    id: `external-activity-${record.sessionId}`,
    duration: 6000,
    ...(options.open ? { action: { label: t("setting:external_agent.activity.notice.view"), onClick: () => options.open?.(record.sessionId) } } : {}),
  });
}

/** Follows the activity record: counts unseen changes since the page was last open and shows notices. */
export function installExternalActivity(api: ExternalAgentApi | null | undefined, open?: (sessionId: string) => void): () => void {
  if (!api) return () => {};
  useExternalActivityStore.setState({ lastSeenAt: readSeen() });
  const stop = api.onActivity(event => noteActivityEvent(event, { open }));
  void api.getSettings().then(result => { if (result.ok) setActivityNotices(result.value.notices); }).catch(() => undefined);
  // Unseen changes from before this window started.
  void api.activityList({ filter: "changes", limit: 200 }).then(result => {
    if (!result.ok) return;
    const { lastSeenAt } = useExternalActivityStore.getState();
    const unseen: Record<string, number> = {};
    for (const record of result.value.records) {
      if (!ranUnasked(record) || record.startedAt <= lastSeenAt || counted.has(record.id)) continue;
      counted.add(record.id);
      unseen[record.sessionId] = (unseen[record.sessionId] ?? 0) + 1;
    }
    useExternalActivityStore.setState(current => {
      const merged = { ...current.unseen };
      for (const [id, value] of Object.entries(unseen)) merged[id] = (merged[id] ?? 0) + value;
      return { unseen: merged };
    });
  }).catch(() => undefined);
  return stop;
}

/** Test reset. */
export function resetExternalActivity(): void {
  counted.clear(); groups.clear();
  useExternalActivityStore.setState({ lastSeenAt: 0, unseen: {}, viewing: null, notices: true, revision: 0 });
}
