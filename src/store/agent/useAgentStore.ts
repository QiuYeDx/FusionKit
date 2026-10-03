import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  AgentMessage,
  AgentPlan,
  AgentTaskReference,
  AgentSession,
  AgentSessionStatus,
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
import { getNameTranslationPlan } from "@/services/rename/namePlanStore";
import {
  applyNameTranslationPlan,
  validateNameTranslationPlan,
} from "@/services/rename/nameApplyService";
import type { NameTranslationApplyResult } from "@/services/rename/nameTypes";
import { createAgentPlan, type AgentPlanInput } from "@/agent/plan";

// ---------------------------------------------------------------------------
// Agent Store — 会话、消息、流式状态、执行模式
// ---------------------------------------------------------------------------

interface AgentStore {
  session: AgentSession;
  isStreaming: boolean;
  streamingText: string;
  executionMode: ExecutionMode;
  pendingExecution: PendingExecution | null;
  pendingNameTranslationPlan: PendingNameTranslationPlan | null;
  tokenStats: TokenStats;
  activeToolCalls: AgentToolCall[];
  sessionLog: AgentLogEntry[];

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
  resetSession: () => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  setPendingExecution: (pe: PendingExecution | null) => void;
  confirmExecution: () => void;
  dismissExecution: () => void;
  setPendingNameTranslationPlan: (plan: PendingNameTranslationPlan | null) => void;
  confirmNameTranslationPlan: (planId: string, signal?: AbortSignal) => Promise<NameTranslationApplyResult | undefined>;
  dismissNameTranslationPlan: (planId: string) => void;
  setActiveToolCalls: (calls: AgentToolCall[]) => void;
  clearActiveToolCalls: () => void;
  recordUsage: (data: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    stepCount: number;
    lastPromptTokens: number;
  }) => void;
  appendLog: (type: AgentLogEntryType, summary: string, data?: Record<string, unknown>) => void;
  getSessionExportData: () => SessionExportData;
  restoreSession: (data: SessionExportData) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createNewSession(): AgentSession {
  return {
    id: generateId(),
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

const useAgentStore = create<AgentStore>()(
  persist(
    (set, get) => ({
      session: createNewSession(),
      isStreaming: false,
      streamingText: "",
      executionMode: "queue_only" as ExecutionMode,
      pendingExecution: null,
      pendingNameTranslationPlan: null,
      tokenStats: createEmptyTokenStats(),
      activeToolCalls: [],
      sessionLog: [],

      addMessage: (message) =>
        set((state) => ({
          session: {
            ...state.session,
            messages: [...state.session.messages, message],
            updatedAt: Date.now(),
          },
        })),

      addMessages: (messages) =>
        set((state) => ({
          session: {
            ...state.session,
            messages: [...state.session.messages, ...messages],
            updatedAt: Date.now(),
          },
        })),

      setStatus: (status) =>
        set((state) => ({
          session: { ...state.session, status, updatedAt: Date.now() },
        })),

      updatePlan: (input) => {
        const plan = createAgentPlan(input, get().session.plan);
        set((state) => ({ session: { ...state.session, plan, updatedAt: Date.now() } }));
        return plan;
      },

      interruptPlan: (reason) => set((state) => {
        const plan = state.session.plan;
        if (!plan?.steps.some((step) => step.status === "in_progress")) return state;
        return { session: { ...state.session, plan: { ...plan, updatedAt: Date.now(), steps: plan.steps.map((step) => step.status === "in_progress" ? { ...step, status: "blocked" as const, detail: reason ?? step.detail } : step) } } };
      }),

      setStreaming: (streaming) => set({ isStreaming: streaming }),

      appendStreamingText: (delta) =>
        set((state) => ({ streamingText: state.streamingText + delta })),

      clearStreamingText: () => set({ streamingText: "" }),

      commitStreamingAsAssistant: (text, toolCalls) => {
        if (!text && (!toolCalls || toolCalls.length === 0)) {
          set({ streamingText: "" });
          return;
        }
        const msg: AgentMessage = {
          id: generateId(),
          role: "assistant",
          content: text,
          timestamp: Date.now(),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        };
        set((state) => ({
          streamingText: "",
          session: {
            ...state.session,
            messages: [...state.session.messages, msg],
            updatedAt: Date.now(),
          },
        }));
      },

      commitStepBatch: (assistantText, toolCalls, toolMessages) => {
        set((state) => {
          const now = Date.now();
          const newMessages = [...state.session.messages];

          if (assistantText || toolCalls.length > 0) {
            newMessages.push({
              id: generateId(),
              role: "assistant",
              content: assistantText,
              timestamp: now,
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            });
          }

          newMessages.push(...toolMessages);

          return {
            streamingText: "",
            activeToolCalls: [],
            session: {
              ...state.session,
              messages: newMessages,
              updatedAt: now,
            },
          };
        });
      },

      resetSession: () => {
        get().appendLog("session_reset", "Session reset");
        set({
          session: createNewSession(),
          isStreaming: false,
          streamingText: "",
          pendingExecution: null,
          pendingNameTranslationPlan: null,
          tokenStats: createEmptyTokenStats(),
          activeToolCalls: [],
          sessionLog: [],
        });
      },

      setExecutionMode: (mode) => {
        set({ executionMode: mode });
      },

      setPendingExecution: (pe) => set({ pendingExecution: pe }),

      confirmExecution: () => {
        const { pendingExecution } = get();
        if (!pendingExecution || pendingExecution.resolvedAction) return;
        set({
          pendingExecution: { ...pendingExecution, resolvedAction: "confirm" },
        });
        const receipt = executeTasksInStores(pendingExecution.stores, pendingExecution.taskRefs);
        get().appendLog("tool_result", "Confirmed scoped task execution", receipt);
      },

      dismissExecution: () => {
        const { pendingExecution } = get();
        if (!pendingExecution || pendingExecution.resolvedAction) return;
        set({
          pendingExecution: { ...pendingExecution, resolvedAction: "dismiss" },
        });
      },

      setPendingNameTranslationPlan: (plan) =>
        set({ pendingNameTranslationPlan: plan }),

      confirmNameTranslationPlan: async (planId, signal) => {
        const { pendingNameTranslationPlan, session } = get();
        if (
          !pendingNameTranslationPlan ||
          pendingNameTranslationPlan.planId !== planId ||
          pendingNameTranslationPlan.resolvedAction || pendingNameTranslationPlan.isApplying || signal?.aborted
        ) {
          return;
        }

        const claimed = { ...pendingNameTranslationPlan, isApplying: true, error: undefined };
        set({ pendingNameTranslationPlan: claimed });
        const isCurrent = () => get().session.id === session.id && get().pendingNameTranslationPlan === claimed;
        let submitted = false;
        try {
          const plan = getNameTranslationPlan(planId);
          if (!plan) {
            throw new Error("重命名计划已过期或不存在，请重新生成预览。");
          }
          if (!plan.applyable || plan.blockedCount > 0) {
            throw new Error("当前重命名计划不可应用，请先处理冲突或重新生成预览。");
          }
          const validation = await validateNameTranslationPlan(planId);
          signal?.throwIfAborted();
          if (!isCurrent()) return;
          if (!validation.valid) {
            throw new Error(
              validation.errors[0]?.message ?? "重命名计划校验失败。"
            );
          }

          submitted = true;
          const result = await applyNameTranslationPlan(planId);
          if (!isCurrent()) return result;
          set({
            pendingNameTranslationPlan: {
              ...pendingNameTranslationPlan,
              isApplying: false,
              resolvedAction: "confirm",
              applyResult: result,
              error: undefined,
            },
          });
          get().appendLog(
            "name_translation_apply",
            `Applied rename plan ${planId}`,
            { planId, result }
          );
          return result;
        } catch (error) {
          if (!isCurrent()) return;
          const detail = error instanceof Error ? error.message : String(error);
          const message = submitted ? `执行结果未确认，请先在重命名工具核对结果，不要重复应用。${detail}` : detail;
          set({
            pendingNameTranslationPlan: {
              ...pendingNameTranslationPlan,
              isApplying: false,
              error: message,
              ...(submitted ? { resolvedAction: "confirm" as const } : {}),
            },
          });
          get().appendLog("error", message, {
            planId,
            source: "confirm_name_translation_plan",
          });
        }
      },

      dismissNameTranslationPlan: (planId) => {
        const { pendingNameTranslationPlan } = get();
        if (
          !pendingNameTranslationPlan ||
          pendingNameTranslationPlan.planId !== planId ||
          pendingNameTranslationPlan.resolvedAction || pendingNameTranslationPlan.isApplying
        ) {
          return;
        }
        set({
          pendingNameTranslationPlan: {
            ...pendingNameTranslationPlan,
            resolvedAction: "dismiss",
          },
        });
        get().appendLog(
          "name_translation_plan",
          `Dismissed rename plan ${planId}`,
          { planId, action: "dismiss" }
        );
      },

      setActiveToolCalls: (calls) => set({ activeToolCalls: calls }),
      clearActiveToolCalls: () => set({ activeToolCalls: [] }),

      recordUsage: ({ promptTokens, completionTokens, totalTokens, cost, stepCount, lastPromptTokens }) =>
        set((state) => ({
          tokenStats: {
            totalPromptTokens: state.tokenStats.totalPromptTokens + promptTokens,
            totalCompletionTokens: state.tokenStats.totalCompletionTokens + completionTokens,
            totalTokens: state.tokenStats.totalTokens + totalTokens,
            totalCost: state.tokenStats.totalCost + cost,
            stepCount: state.tokenStats.stepCount + stepCount,
            lastPromptTokens,
            interactions: [
              ...state.tokenStats.interactions.slice(-499),
              { timestamp: Date.now(), promptTokens, completionTokens, totalTokens, cost, stepCount },
            ],
          },
        })),

      appendLog: (type, summary, data) =>
        set((state) => ({
          sessionLog: [
            ...state.sessionLog.slice(-1999),
            {
              id: generateId(),
              timestamp: Date.now(),
              type,
              summary,
              ...(data ? { data } : {}),
            },
          ],
        })),

      getSessionExportData: (): SessionExportData => {
        const { session, tokenStats, sessionLog, executionMode } = get();
        return {
          version: 1,
          exportedAt: Date.now(),
          session,
          tokenStats,
          sessionLog,
          executionMode,
        };
      },

      restoreSession: (data) => {
        set({
          session: {
            ...data.session,
            id: generateId(),
            status: "idle",
            ...(data.session.plan ? { plan: { ...data.session.plan, steps: data.session.plan.steps.map((step) => step.status === "in_progress" ? { ...step, status: "pending" as const } : step) } } : {}),
          },
          tokenStats: data.tokenStats,
          sessionLog: data.sessionLog,
          // Imported history is display data, never an automatic execution grant.
          executionMode: "queue_only",
          isStreaming: false,
          streamingText: "",
          pendingExecution: null,
          pendingNameTranslationPlan: null,
          activeToolCalls: [],
        });
      },
    }),
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
