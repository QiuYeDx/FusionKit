import { create } from "zustand";
import { externalToolDefinition, type ExternalApprovalGroup, type ExternalToolName } from "./catalog";
import type { ExternalToolOutcome } from "./contract";
import { approvalNeed } from "./approval";
import { ExternalToolError, type ExternalToolContext } from "./errors";
import { useExternalAgentStore } from "./store";

/** How long a tool call waits for the user before answering confirmation_pending. */
export const CONFIRMATION_WAIT_MS = 45_000;
/** An undecided request is dropped after this. */
export const CONFIRMATION_EXPIRY_MS = 10 * 60_000;
/** Decided requests kept for get_confirmation_result. */
const DECIDED_KEPT = 20;
export const CONFIRMATION_ITEMS_SHOWN = 8;

export type ConfirmationAction = "import" | "translation" | "structure" | "export" | "transcription" | "knowledge" | "files" | "rename";
/** One row of the dialog: a name, the full path or collection under it, and what kind of record it is. */
export interface ConfirmationItem { text: string; detail?: string; tag?: "collection" | "term" | "rule" | "context";
  /** A rename's old name, shown muted before the new one in `text`. */
  from?: string }
/** A path as a row: its last part first, the whole path under it. */
export function pathItem(value: string): ConfirmationItem {
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/);
  return { text: parts.at(-1) || value, detail: value };
}
export type ConfirmationSummary = "import" | "create_track" | "write_translations" | "split_cue" | "insert_cue_before" | "insert_cue_after" | "convert_source" | "convert_directory" | "extract_source" | "extract_directory" | "rename_paths" | "undo_rename" | "export_source" | "export_choose" | "transcription" | "knowledge";

/** What the dialog shows; FusionKit writes it from the call's arguments, never the agent's own words. */
export interface ConfirmationDisplay {
  action: ConfirmationAction;
  /** Key under setting:external_agent.confirm.summary. */
  summary: ConfirmationSummary;
  values: Record<string, string | number>;
  /** What an export writes, named in the user's language. */
  content?: "source" | "target" | "bilingual";
  /** Objects of the action: document names, paths, entries. */
  items: ConfirmationItem[];
  warning?: "overwrite";
}

export type ConfirmationStatus = "pending" | "running" | "completed" | "failed" | "declined" | "expired";

export interface ConfirmationRequest extends ConfirmationDisplay {
  id: string;
  sessionId: string;
  client: string;
  tool: ExternalToolName;
  group?: ExternalApprovalGroup;
  sessionGrant: boolean;
  destructive: boolean;
  status: ConfirmationStatus;
  createdAt: number;
  outcome?: ExternalToolOutcome;
}

interface ConfirmationsState {
  requests: ConfirmationRequest[];
  /** Write groups each connection's user allowed for the rest of the connection. */
  grants: Record<string, ExternalApprovalGroup[]>;
  decide: (id: string, approved: boolean, options?: { allowSession?: boolean }) => void;
}

const actions = new Map<string, () => Promise<unknown>>();
const waiters = new Map<string, Set<() => void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let sequence = 0;

const terminal = (status: ConfirmationStatus) => status !== "pending" && status !== "running";

function notify(id: string) {
  for (const wake of waiters.get(id) ?? []) wake();
}

function update(id: string, change: Partial<ConfirmationRequest>) {
  useExternalConfirmationsStore.setState(state => {
    const requests = state.requests.map(item => item.id === id ? { ...item, ...change } : item);
    // Keep every open request and only the latest decided ones.
    const decided = requests.filter(item => terminal(item.status));
    const dropped = new Set(decided.slice(0, Math.max(0, decided.length - DECIDED_KEPT)).map(item => item.id));
    return { requests: requests.filter(item => !dropped.has(item.id)) };
  });
  if (change.status && terminal(change.status)) {
    clearTimeout(timers.get(id)); timers.delete(id); actions.delete(id);
  }
  notify(id);
}

function outcomeOf(error: unknown): ExternalToolOutcome {
  if (error instanceof ExternalToolError) return { ok: false, error: error.code, ...(error.detail ? { detail: error.detail } : {}) };
  return { ok: false, error: "tool_failed", detail: { reason: (error instanceof Error ? error.message : String(error)).slice(0, 600) } };
}

/** No persistence: a confirmation lives only while FusionKit and the connection do. */
export const useExternalConfirmationsStore = create<ConfirmationsState>((set, get) => ({
  requests: [],
  grants: {},
  decide: (id, approved, options = {}) => {
    const request = get().requests.find(item => item.id === id);
    if (!request || request.status !== "pending") return;
    if (!approved) { update(id, { status: "declined" }); return; }
    if (options.allowSession && request.sessionGrant && request.group) {
      const group = request.group;
      set(state => ({ grants: { ...state.grants, [request.sessionId]: [...new Set([...(state.grants[request.sessionId] ?? []), group])] } }));
    }
    const execute = actions.get(id);
    update(id, { status: "running" });
    void (async () => {
      try {
        if (!execute) throw new ExternalToolError("confirmation_expired");
        const data = await execute();
        update(id, { status: "completed", outcome: { ok: true, data } });
      } catch (error) {
        update(id, { status: "failed", outcome: outcomeOf(error) });
      }
    })();
  },
}));

/** Waits until the request is decided and done, or the time is up (false). */
function settle(id: string, ms: number, signal?: AbortSignal): Promise<ConfirmationRequest | null> {
  const current = () => useExternalConfirmationsStore.getState().requests.find(item => item.id === id) ?? null;
  const now = current();
  if (!now || terminal(now.status)) return Promise.resolve(now);
  return new Promise(resolve => {
    let done = false;
    const finish = (value: ConfirmationRequest | null) => {
      if (done) return;
      done = true; clearTimeout(timer); waiters.get(id)?.delete(wake); signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const wake = () => { const value = current(); if (!value || terminal(value.status)) finish(value); };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish(null), ms);
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id)!.add(wake);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function resultOf(request: ConfirmationRequest): unknown {
  if (request.status === "declined") throw new ExternalToolError("declined_by_user");
  if (request.status === "expired") throw new ExternalToolError("confirmation_expired");
  const outcome = request.outcome ?? { ok: false, error: "tool_failed" };
  if (!outcome.ok) throw new ExternalToolError(outcome.error, outcome.detail);
  return outcome.data;
}

/**
 * Runs `execute` once the call is allowed: at once when no confirmation is needed,
 * otherwise after the user says yes in FusionKit. When the user has not decided
 * within the wait, the call answers confirmation_pending and the work runs if
 * the user allows it later; get_confirmation_result returns its result.
 */
export async function confirmed<T>(ctx: ExternalToolContext, tool: ExternalToolName, display: ConfirmationDisplay,
  execute: () => Promise<T>, options: { destructive?: boolean; waitMs?: number } = {}): Promise<T> {
  const definition = externalToolDefinition(tool);
  const trust = useExternalAgentStore.getState().status?.trust ?? "confirm_writes";
  const granted = !!definition.group && (useExternalConfirmationsStore.getState().grants[ctx.sessionId] ?? []).includes(definition.group);
  const need = approvalNeed(trust, definition, { destructive: options.destructive, granted });
  if (need.kind === "refuse") throw new ExternalToolError(need.error);
  if (need.kind === "none") return execute();
  if (ctx.signal.aborted) throw new ExternalToolError("cancelled");

  const id = `confirm-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const request: ConfirmationRequest = {
    ...display, items: display.items.map(item => ({ ...item, text: item.text.slice(0, 600), ...(item.detail ? { detail: item.detail.slice(0, 600) } : {}), ...(item.from ? { from: item.from.slice(0, 600) } : {}) })),
    id, sessionId: ctx.sessionId, client: ctx.client.name.slice(0, 100), tool, ...(definition.group ? { group: definition.group } : {}),
    sessionGrant: need.sessionGrant, destructive: !!options.destructive || definition.access === "destructive",
    status: "pending", createdAt: Date.now(),
  };
  actions.set(id, execute);
  timers.set(id, setTimeout(() => {
    if (useExternalConfirmationsStore.getState().requests.find(item => item.id === id)?.status === "pending") update(id, { status: "expired" });
  }, CONFIRMATION_EXPIRY_MS));
  useExternalConfirmationsStore.setState(state => ({ requests: [...state.requests, request] }));
  try { window.externalAgent?.requestAttention(); } catch { /* attention is a courtesy */ }

  const settled = await settle(id, options.waitMs ?? CONFIRMATION_WAIT_MS, ctx.signal);
  if (!settled) {
    // The agent cancelled: nobody waits for this request any more.
    if (ctx.signal.aborted) {
      if (useExternalConfirmationsStore.getState().requests.find(item => item.id === id)?.status === "pending") update(id, { status: "expired" });
      throw new ExternalToolError("cancelled");
    }
    throw new ExternalToolError("confirmation_pending", {
      confirmationId: id,
      hint: "The user has not decided in FusionKit yet. Tell them to look at the FusionKit window, then call get_confirmation_result with this confirmationId.",
    });
  }
  return resultOf(settled) as T;
}

/** get_confirmation_result: the outcome of a request this connection made. */
export async function awaitConfirmation(ctx: ExternalToolContext, confirmationId: string, waitMs = CONFIRMATION_WAIT_MS) {
  const request = useExternalConfirmationsStore.getState().requests.find(item => item.id === confirmationId);
  if (!request || request.sessionId !== ctx.sessionId) throw new ExternalToolError("confirmation_not_found");
  const settled = await settle(confirmationId, waitMs, ctx.signal);
  if (!settled) {
    if (ctx.signal.aborted) throw new ExternalToolError("cancelled");
    throw new ExternalToolError("confirmation_pending", { confirmationId });
  }
  return { confirmationId, tool: settled.tool, status: settled.status, result: resultOf(settled) };
}

/** A connection that ended takes its open requests and its allowances with it. */
export function forgetEndedSessions(liveSessionIds: ReadonlySet<string>): void {
  const state = useExternalConfirmationsStore.getState();
  for (const request of state.requests) {
    if (request.status === "pending" && !liveSessionIds.has(request.sessionId)) update(request.id, { status: "expired" });
  }
  const grants = Object.fromEntries(Object.entries(state.grants).filter(([id]) => liveSessionIds.has(id)));
  if (Object.keys(grants).length !== Object.keys(state.grants).length) useExternalConfirmationsStore.setState({ grants });
}

/** Test reset. */
export function resetExternalConfirmations(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear(); actions.clear(); waiters.clear();
  useExternalConfirmationsStore.setState({ requests: [], grants: {} });
}
