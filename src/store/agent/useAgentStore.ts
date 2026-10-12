import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  AgentMessage,
  AgentPlan,
  AgentTaskReference,
  AgentSession,
  AgentSessionMeta,
  AgentSessionStatus,
  AgentTitleSource,
  AgentToolCall,
  AgentLogEntry,
  AgentLogEntryType,
  ExecutionMode,
  PendingNameTranslationPlan,
  PendingExecution,
  SessionExportData,
  TaskStoreType,
  TokenStats,
} from "@/agent/types";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import {
  applyAgentNamePlan,
  getAgentNamePlan,
  type NameTranslationApplyResult,
} from "@/services/name-translation/agentPlan";
import { createAgentPlan, type AgentPlanInput } from "@/agent/plan";
import { excerptTitle, normalizeManualTitle } from "@/agent/session-title";

// ---------------------------------------------------------------------------
// Agent Store — 多会话：每个会话一个槽，界面读取当前会话的投影
// ---------------------------------------------------------------------------

/** Everything one conversation owns while the app runs. */
export interface SessionSlot {
  session: AgentSession;
  isStreaming: boolean;
  streamingText: string;
  activeToolCalls: AgentToolCall[];
  tokenStats: TokenStats;
  sessionLog: AgentLogEntry[];
  pendingExecution: PendingExecution | null;
  pendingNameTranslationPlan: PendingNameTranslationPlan | null;
  /** A reply arrived while the user looked at another session. */
  unread: boolean;
}

/** The current session's slot, under the field names the interface has always read. */
type ActiveProjection = Omit<SessionSlot, "unread">;
const PROJECTED = ["session", "isStreaming", "streamingText", "activeToolCalls", "tokenStats", "sessionLog", "pendingExecution", "pendingNameTranslationPlan"] as const;

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  stepCount: number;
  lastPromptTokens: number;
}

/** Actions on one session. Writing to a session that no longer exists does nothing. */
export interface SessionActions {
  addMessage: (message: AgentMessage) => void;
  addMessages: (messages: AgentMessage[]) => void;
  setStatus: (status: AgentSessionStatus) => void;
  updatePlan: (input: AgentPlanInput) => AgentPlan;
  interruptPlan: (reason?: string) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamingText: (delta: string) => void;
  clearStreamingText: () => void;
  commitStreamingAsAssistant: (text: string, toolCalls?: AgentToolCall[]) => void;
  commitStepBatch: (
    assistantText: string,
    toolCalls: AgentToolCall[],
    toolMessages: AgentMessage[],
  ) => void;
  setPendingExecution: (pe: PendingExecution | null) => void;
  confirmExecution: () => void;
  dismissExecution: () => void;
  setPendingNameTranslationPlan: (plan: PendingNameTranslationPlan | null) => void;
  confirmNameTranslationPlan: (planId: string, signal?: AbortSignal) => Promise<NameTranslationApplyResult | undefined>;
  dismissNameTranslationPlan: (planId: string) => void;
  setActiveToolCalls: (calls: AgentToolCall[]) => void;
  clearActiveToolCalls: () => void;
  /** keepContext: a side request (the title) that must not move the context meter. */
  recordUsage: (data: UsageRecord, options?: { keepContext?: boolean }) => void;
  appendLog: (type: AgentLogEntryType, summary: string, data?: Record<string, unknown>) => void;
  setTitle: (title: string, source: AgentTitleSource) => void;
  getSessionExportData: () => SessionExportData;
}

interface AgentStore extends ActiveProjection, SessionActions {
  activeSessionId: string;
  slots: Record<string, SessionSlot>;
  /** Every saved session, loaded or not, plus the loaded ones that have messages. */
  catalog: Record<string, AgentSessionMeta>;
  executionMode: ExecutionMode;

  forSession: (id: string) => SessionActions;
  hasSession: (id: string) => boolean;
  /** A new empty session, made current; the current one is reused when it is still blank. */
  createSession: () => string;
  /** Starts over with a fresh session; the previous one stays in the list when it has messages. */
  resetSession: () => void;
  /** Shows a loaded session. Returns false when it is not loaded. */
  activateSession: (id: string) => boolean;
  /** Adds a loaded session (from disk or an import) and optionally shows it. */
  adoptSession: (slot: SessionSlot, options?: { activate?: boolean }) => void;
  removeSession: (id: string) => void;
  removeAllSessions: () => void;
  renameSession: (id: string, title: string) => boolean;
  setPinned: (id: string, pinned: boolean) => void;
  setCatalog: (metas: AgentSessionMeta[]) => void;
  markUnreadable: (id: string) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  /** Imports an exported session as a new session and shows it. */
  restoreSession: (data: SessionExportData) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : generateId();
}

function createNewSession(): AgentSession {
  return {
    id: createSessionId(),
    messages: [],
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createEmptyTokenStats(): TokenStats {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    stepCount: 0,
    lastPromptTokens: 0,
    interactions: [],
  };
}

export function createSessionSlot(session: AgentSession = createNewSession(), parts: Partial<Omit<SessionSlot, "session">> = {}): SessionSlot {
  return {
    session,
    isStreaming: false,
    streamingText: "",
    activeToolCalls: [],
    tokenStats: createEmptyTokenStats(),
    sessionLog: [],
    pendingExecution: null,
    pendingNameTranslationPlan: null,
    unread: false,
    ...parts,
  };
}

/** Nothing worth keeping: no messages, no reply running, no confirmation, no plan. */
export function isBlankSlot(slot: SessionSlot): boolean {
  return slot.session.messages.length === 0 && !slot.isStreaming && !slot.pendingExecution
    && !slot.pendingNameTranslationPlan && !slot.session.plan;
}

function project(slot: SessionSlot): ActiveProjection {
  return Object.fromEntries(PROJECTED.map((key) => [key, slot[key]])) as unknown as ActiveProjection;
}

/** The latest words of the conversation, for search and the list tooltip. */
function previewOf(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if ((message.role === "assistant" || (message.role === "user" && !message.event)) && message.content.trim()) {
      return message.content.replace(/\s+/g, " ").trim().slice(0, 120);
    }
  }
  return "";
}

export function sessionMeta(session: AgentSession): AgentSessionMeta {
  return {
    id: session.id,
    title: session.title ?? "",
    titleSource: session.titleSource ?? "auto",
    pinned: !!session.pinned,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: previewOf(session.messages),
  };
}

/** A session read back from disk or a file: idle, nothing in progress, no confirmation authority. */
export function settledSession(session: AgentSession, id = session.id): AgentSession {
  return {
    ...session,
    id,
    status: "idle",
    ...(session.plan ? { plan: { ...session.plan, steps: session.plan.steps.map((step) => step.status === "in_progress" ? { ...step, status: "pending" as const } : step) } } : {}),
  };
}

function titledByFirstMessage(session: AgentSession, added: readonly AgentMessage[]): AgentSession {
  if (session.title) return session;
  const first = added.find((message) => message.role === "user" && !message.event && message.content.trim());
  if (!first) return session;
  return { ...session, title: excerptTitle(first.content), titleSource: "auto" };
}

const legacyExecutionLanes: Record<"convert" | "extract", { ids: string[]; pumping: boolean; unsubscribe?: () => void }> = {
  convert: { ids: [], pumping: false }, extract: { ids: [], pumping: false },
};

function enqueueScopedLegacyTasks(kind: "convert" | "extract", ids: string[]) {
  const queue = kind === "convert" ? useSubtitleConverterStore : useSubtitleExtractorStore;
  const lane = legacyExecutionLanes[kind];
  const admitted = ids.filter((id) => !lane.ids.includes(id) && queue.getState().notStartedTasks.some((task) => "agentTaskId" in task && task.agentTaskId === id));
  lane.ids.push(...admitted);
  const pump = () => {
    if (lane.pumping) return;
    lane.pumping = true;
    try {
      while (lane.ids.length && queue.getState().pendingTasks.length === 0) {
        const id = lane.ids.shift()!;
        const task = queue.getState().notStartedTasks.find((candidate) => "agentTaskId" in candidate && candidate.agentTaskId === id);
        if (task) queue.getState().startTask(task.fileName);
      }
      if (!lane.ids.length) { lane.unsubscribe?.(); lane.unsubscribe = undefined; }
    } finally { lane.pumping = false; }
  };
  if (lane.ids.length && !lane.unsubscribe) lane.unsubscribe = queue.subscribe(pump);
  pump();
  return { startedCount: admitted.length, skippedCount: ids.length - admitted.length };
}

export function executeTasksInStores(stores: TaskStoreType[], taskRefs: AgentTaskReference[] = []) {
  let startedCount = 0;
  let skippedCount = 0;
  for (const storeType of stores) {
    const ids = [...new Set(taskRefs.filter((ref) => ref.store === storeType).map((ref) => ref.taskId))];
    switch (storeType) {
      case "translate": {
        if (ids.length === 0) break;
        const receipt = useSubtitleTranslatorStore.getState().startTasks(ids);
        startedCount += receipt.startedTaskIds.length + receipt.waitingTaskIds.length;
        skippedCount += receipt.notStartedTaskIds.length;
        break;
      }
      case "convert":
      case "extract": {
        const receipt = enqueueScopedLegacyTasks(storeType, ids);
        startedCount += receipt.startedCount;
        skippedCount += receipt.skippedCount;
        break;
      }
    }
  }
  return { startedCount, skippedCount };
}

const LEGACY_KEY = "agent-execution-mode";
/** Apply failures raised before any rename happened. */
const DEFINITE_RENAME_FAILURES = new Set(["rename_plan_expired", "rename_plan_empty", "rename_plan_changed", "task_model_not_configured"]);

const initialSlot = createSessionSlot();

const useAgentStore = create<AgentStore>()(
  persist(
    (set, get) => {
      type State = AgentStore;
      /**
       * The one way to change a session: the slot is replaced, the catalog follows its messages and
       * title, and the projection follows when the slot is the current session.
       */
      const patch = (id: string, recipe: (slot: SessionSlot, state: State) => Partial<SessionSlot> | null) => set((state) => {
        const slot = state.slots[id];
        if (!slot) return state;
        const changes = recipe(slot, state);
        if (!changes) return state;
        const next = { ...slot, ...changes };
        const update: Partial<State> = { slots: { ...state.slots, [id]: next } };
        if (next.session !== slot.session && next.session.messages.length > 0) {
          update.catalog = { ...state.catalog, [id]: sessionMeta(next.session) };
        }
        if (id === state.activeSessionId) Object.assign(update, project(next));
        return update;
      });
      const touch = (session: AgentSession, changes: Partial<AgentSession>): AgentSession => ({ ...session, ...changes, updatedAt: Date.now() });
      /** A reply landing in a session the user is not looking at. */
      const unreadIf = (id: string, state: State, text: string) => id !== state.activeSessionId && !!text.trim() ? { unread: true } : {};

      const bound = new Map<string, SessionActions>();
      const actionsFor = (id: string): SessionActions => {
        const cached = bound.get(id);
        if (cached) return cached;
        const slot = () => get().slots[id];
        const appendLog: SessionActions["appendLog"] = (type, summary, data) => patch(id, (current) => ({
          sessionLog: [
            ...current.sessionLog.slice(-1999),
            { id: generateId(), timestamp: Date.now(), type, summary, ...(data ? { data } : {}) },
          ],
        }));
        const actions: SessionActions = {
          addMessage: (message) => actions.addMessages([message]),
          addMessages: (messages) => patch(id, (current, state) => ({
            session: touch(titledByFirstMessage(current.session, messages), { messages: [...current.session.messages, ...messages] }),
            ...unreadIf(id, state, messages.filter((message) => message.role === "assistant").map((message) => message.content).join("")),
          })),
          setStatus: (status) => patch(id, (current) => current.session.status === status ? null : { session: { ...current.session, status } }),
          updatePlan: (input) => {
            const plan = createAgentPlan(input, slot()?.session.plan);
            patch(id, (current) => ({ session: touch(current.session, { plan }) }));
            return plan;
          },
          interruptPlan: (reason) => patch(id, (current) => {
            const plan = current.session.plan;
            if (!plan?.steps.some((step) => step.status === "in_progress")) return null;
            return { session: { ...current.session, plan: { ...plan, updatedAt: Date.now(), steps: plan.steps.map((step) => step.status === "in_progress" ? { ...step, status: "blocked" as const, detail: reason ?? step.detail } : step) } } };
          }),
          setStreaming: (streaming) => patch(id, (current) => current.isStreaming === streaming ? null : { isStreaming: streaming }),
          appendStreamingText: (delta) => patch(id, (current) => ({ streamingText: current.streamingText + delta })),
          clearStreamingText: () => patch(id, (current) => current.streamingText ? { streamingText: "" } : null),
          commitStreamingAsAssistant: (text, toolCalls) => patch(id, (current, state) => {
            if (!text && (!toolCalls || toolCalls.length === 0)) return { streamingText: "" };
            const message: AgentMessage = {
              id: generateId(), role: "assistant", content: text, timestamp: Date.now(),
              ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
            };
            return { streamingText: "", session: touch(current.session, { messages: [...current.session.messages, message] }), ...unreadIf(id, state, text) };
          }),
          commitStepBatch: (assistantText, toolCalls, toolMessages) => patch(id, (current, state) => {
            const now = Date.now();
            const messages = [...current.session.messages];
            if (assistantText || toolCalls.length > 0) {
              messages.push({
                id: generateId(), role: "assistant", content: assistantText, timestamp: now,
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
              });
            }
            messages.push(...toolMessages);
            return { streamingText: "", activeToolCalls: [], session: touch(current.session, { messages }), ...unreadIf(id, state, assistantText) };
          }),
          setPendingExecution: (pe) => patch(id, () => ({ pendingExecution: pe })),
          confirmExecution: () => {
            const pendingExecution = slot()?.pendingExecution;
            if (!pendingExecution || pendingExecution.resolvedAction) return;
            patch(id, () => ({ pendingExecution: { ...pendingExecution, resolvedAction: "confirm" } }));
            const receipt = executeTasksInStores(pendingExecution.stores, pendingExecution.taskRefs);
            appendLog("tool_result", "Confirmed scoped task execution", receipt);
          },
          dismissExecution: () => {
            const pendingExecution = slot()?.pendingExecution;
            if (!pendingExecution || pendingExecution.resolvedAction) return;
            patch(id, () => ({ pendingExecution: { ...pendingExecution, resolvedAction: "dismiss" } }));
          },
          setPendingNameTranslationPlan: (plan) => patch(id, () => ({ pendingNameTranslationPlan: plan })),
          confirmNameTranslationPlan: async (planId, signal) => {
            const pending = slot()?.pendingNameTranslationPlan;
            if (!pending || pending.planId !== planId || pending.resolvedAction || pending.isApplying || signal?.aborted) return;

            const claimed = { ...pending, isApplying: true, error: undefined };
            patch(id, () => ({ pendingNameTranslationPlan: claimed }));
            // The receipt belongs to this session's card, even if the user moved to another session meanwhile.
            const isCurrent = () => slot()?.pendingNameTranslationPlan === claimed;
            let submitted = false;
            try {
              const plan = getAgentNamePlan(planId);
              if (!plan) throw new Error("rename_plan_expired");
              if (!plan.summary.applyable) throw new Error("rename_plan_empty");
              signal?.throwIfAborted();
              if (!isCurrent()) return;

              submitted = true;
              const result = await applyAgentNamePlan(planId);
              if (!isCurrent()) return result;
              patch(id, () => ({ pendingNameTranslationPlan: { ...pending, isApplying: false, resolvedAction: "confirm", applyResult: result, error: undefined } }));
              appendLog("name_translation_apply", `Applied rename plan ${planId}`, { planId, result });
              return result;
            } catch (error) {
              if (!isCurrent()) return;
              const detail = error instanceof Error ? error.message : String(error);
              // A submitted apply may have renamed files; never invite a blind retry unless
              // the failure proves nothing was renamed.
              const ambiguous = submitted && !DEFINITE_RENAME_FAILURES.has(detail);
              const message = ambiguous ? "rename_apply_outcome_unknown" : detail;
              patch(id, () => ({ pendingNameTranslationPlan: {
                ...pending, isApplying: false, error: message,
                ...(ambiguous ? { errorDetail: detail.slice(0, 600), resolvedAction: "confirm" as const } : {}),
              } }));
              appendLog("error", ambiguous ? `${message}: ${detail}` : message, { planId, source: "confirm_name_translation_plan" });
            }
          },
          dismissNameTranslationPlan: (planId) => {
            const pending = slot()?.pendingNameTranslationPlan;
            if (!pending || pending.planId !== planId || pending.resolvedAction || pending.isApplying) return;
            patch(id, () => ({ pendingNameTranslationPlan: { ...pending, resolvedAction: "dismiss" } }));
            appendLog("name_translation_plan", `Dismissed rename plan ${planId}`, { planId, action: "dismiss" });
          },
          setActiveToolCalls: (calls) => patch(id, () => ({ activeToolCalls: calls })),
          clearActiveToolCalls: () => patch(id, (current) => current.activeToolCalls.length ? { activeToolCalls: [] } : null),
          recordUsage: ({ promptTokens, completionTokens, totalTokens, cost, stepCount, lastPromptTokens }, options) => patch(id, (current) => ({
            tokenStats: {
              totalPromptTokens: current.tokenStats.totalPromptTokens + promptTokens,
              totalCompletionTokens: current.tokenStats.totalCompletionTokens + completionTokens,
              totalTokens: current.tokenStats.totalTokens + totalTokens,
              totalCost: current.tokenStats.totalCost + cost,
              stepCount: current.tokenStats.stepCount + stepCount,
              lastPromptTokens: options?.keepContext ? current.tokenStats.lastPromptTokens : lastPromptTokens,
              interactions: [
                ...current.tokenStats.interactions.slice(-499),
                { timestamp: Date.now(), promptTokens, completionTokens, totalTokens, cost, stepCount },
              ],
            },
          })),
          appendLog,
          setTitle: (title, source) => patch(id, (current) => {
            if (!title || (current.session.title === title && current.session.titleSource === source)) return null;
            // Naming a session does not move it in the list; only the conversation does.
            return { session: { ...current.session, title, titleSource: source } };
          }),
          getSessionExportData: (): SessionExportData => {
            const current = slot();
            if (!current) throw new Error("agent_session_missing");
            return {
              version: 1,
              exportedAt: Date.now(),
              session: current.session,
              tokenStats: current.tokenStats,
              sessionLog: current.sessionLog,
              executionMode: get().executionMode,
            };
          },
        };
        bound.set(id, actions);
        return actions;
      };
      const active = () => actionsFor(get().activeSessionId);

      /** Shows another slot; a blank session left behind is dropped. */
      const show = (state: State, id: string, slots = state.slots): Partial<State> => {
        const previous = slots[state.activeSessionId];
        const nextSlots = { ...slots };
        if (previous && state.activeSessionId !== id && isBlankSlot(previous)) {
          delete nextSlots[state.activeSessionId];
          bound.delete(state.activeSessionId);
        }
        const target = nextSlots[id].unread ? { ...nextSlots[id], unread: false } : nextSlots[id];
        nextSlots[id] = target;
        return { slots: nextSlots, activeSessionId: id, ...project(target) };
      };
      const fresh = (state: State): Partial<State> => {
        const slot = createSessionSlot();
        return show(state, slot.session.id, { ...state.slots, [slot.session.id]: slot });
      };

      return {
        ...project(initialSlot),
        activeSessionId: initialSlot.session.id,
        slots: { [initialSlot.session.id]: initialSlot },
        catalog: {},
        executionMode: "queue_only" as ExecutionMode,

        forSession: actionsFor,
        hasSession: (id) => !!get().slots[id],

        addMessage: (message) => active().addMessage(message),
        addMessages: (messages) => active().addMessages(messages),
        setStatus: (status) => active().setStatus(status),
        updatePlan: (input) => active().updatePlan(input),
        interruptPlan: (reason) => active().interruptPlan(reason),
        setStreaming: (streaming) => active().setStreaming(streaming),
        appendStreamingText: (delta) => active().appendStreamingText(delta),
        clearStreamingText: () => active().clearStreamingText(),
        commitStreamingAsAssistant: (text, toolCalls) => active().commitStreamingAsAssistant(text, toolCalls),
        commitStepBatch: (text, calls, messages) => active().commitStepBatch(text, calls, messages),
        setPendingExecution: (pe) => active().setPendingExecution(pe),
        confirmExecution: () => active().confirmExecution(),
        dismissExecution: () => active().dismissExecution(),
        setPendingNameTranslationPlan: (plan) => active().setPendingNameTranslationPlan(plan),
        confirmNameTranslationPlan: (planId, signal) => active().confirmNameTranslationPlan(planId, signal),
        dismissNameTranslationPlan: (planId) => active().dismissNameTranslationPlan(planId),
        setActiveToolCalls: (calls) => active().setActiveToolCalls(calls),
        clearActiveToolCalls: () => active().clearActiveToolCalls(),
        recordUsage: (data, options) => active().recordUsage(data, options),
        appendLog: (type, summary, data) => active().appendLog(type, summary, data),
        setTitle: (title, source) => active().setTitle(title, source),
        getSessionExportData: () => active().getSessionExportData(),

        createSession: () => {
          const state = get();
          const current = state.slots[state.activeSessionId];
          if (current && isBlankSlot(current)) return current.session.id;
          set(fresh(state));
          return get().activeSessionId;
        },
        resetSession: () => set((state) => fresh(state)),
        activateSession: (id) => {
          const state = get();
          if (!state.slots[id]) return false;
          if (id !== state.activeSessionId || state.slots[id].unread) set(show(state, id));
          return true;
        },
        adoptSession: (slot, options) => set((state) => {
          const id = slot.session.id;
          const slots = { ...state.slots, [id]: slot };
          const catalog = slot.session.messages.length ? { ...state.catalog, [id]: sessionMeta(slot.session) } : state.catalog;
          if (options?.activate) return { ...show({ ...state, slots }, id, slots), catalog };
          if (id === state.activeSessionId) return { slots, catalog, ...project(slot) };
          return { slots, catalog };
        }),
        removeSession: (id) => set((state) => {
          const slots = { ...state.slots };
          delete slots[id];
          bound.delete(id);
          const catalog = { ...state.catalog };
          delete catalog[id];
          if (id !== state.activeSessionId) return { slots, catalog };
          return { ...fresh({ ...state, slots, activeSessionId: "" }), catalog };
        }),
        removeAllSessions: () => set((state) => {
          bound.clear();
          return { ...fresh({ ...state, slots: {}, activeSessionId: "" }), catalog: {} };
        }),
        renameSession: (id, title) => {
          const normalized = normalizeManualTitle(title);
          if (!normalized) return false;
          if (get().slots[id]) {
            actionsFor(id).setTitle(normalized, "manual");
          } else {
            const meta = get().catalog[id];
            if (!meta || meta.unreadable) return false;
            set((state) => ({ catalog: { ...state.catalog, [id]: { ...meta, title: normalized, titleSource: "manual" } } }));
          }
          return true;
        },
        setPinned: (id, pinned) => {
          if (get().slots[id]) {
            patch(id, (current) => !!current.session.pinned === pinned ? null : { session: { ...current.session, pinned } });
            return;
          }
          const meta = get().catalog[id];
          if (meta && meta.pinned !== pinned) set((state) => ({ catalog: { ...state.catalog, [id]: { ...meta, pinned } } }));
        },
        setCatalog: (metas) => set((state) => {
          const catalog: Record<string, AgentSessionMeta> = Object.fromEntries(metas.map((meta) => [meta.id, meta]));
          // A loaded session knows better than the saved list.
          for (const [id, slot] of Object.entries(state.slots)) {
            if (slot.session.messages.length) catalog[id] = sessionMeta(slot.session);
          }
          return { catalog };
        }),
        markUnreadable: (id) => set((state) => state.catalog[id] ? { catalog: { ...state.catalog, [id]: { ...state.catalog[id], unreadable: true } } } : state),

        setExecutionMode: (mode) => set({ executionMode: mode }),

        restoreSession: (data) => {
          const session = settledSession(data.session, createSessionId());
          // A title that came with the file is kept; without one, the first message names it.
          const titled = session.title ? { ...session, titleSource: session.titleSource ?? "generated" }
            : titledByFirstMessage({ ...session, titleSource: undefined }, session.messages);
          get().adoptSession(createSessionSlot(titled, { tokenStats: data.tokenStats, sessionLog: data.sessionLog }), { activate: true });
          // Imported history is display data, never an automatic execution grant.
          set({ executionMode: "queue_only" });
        },
      };
    },
    {
      name: "fusionkit-agent",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ executionMode: state.executionMode }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧 key → 新 key
        if (
          localStorage.getItem(LEGACY_KEY) !== null &&
          localStorage.getItem("fusionkit-agent") === null
        ) {
          const saved = localStorage.getItem(LEGACY_KEY);
          if (saved === "queue_only" || saved === "ask_before_execute" || saved === "auto_execute") {
            localStorage.setItem(
              "fusionkit-agent",
              JSON.stringify({ state: { executionMode: saved }, version: 0 })
            );
          }
          localStorage.removeItem(LEGACY_KEY);
        }
      },
    }
  )
);

export default useAgentStore;
