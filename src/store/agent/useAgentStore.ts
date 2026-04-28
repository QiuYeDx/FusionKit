import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionStatus,
  AgentToolCall,
  AgentLogEntry,
  AgentLogEntryType,
  ExecutionMode,
  PendingExecution,
  SessionExportData,
  TaskStoreType,
  TokenStats,
} from "@/agent/types";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";

// ---------------------------------------------------------------------------
// Agent Store — 会话、消息、流式状态、执行模式
// ---------------------------------------------------------------------------

interface AgentStore {
  session: AgentSession;
  isStreaming: boolean;
  streamingText: string;
  executionMode: ExecutionMode;
  pendingExecution: PendingExecution | null;
  tokenStats: TokenStats;
  activeToolCalls: AgentToolCall[];
  sessionLog: AgentLogEntry[];

  addMessage: (message: AgentMessage) => void;
  setStatus: (status: AgentSessionStatus) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamingText: (delta: string) => void;
  clearStreamingText: () => void;
  commitStreamingAsAssistant: (text: string, toolCalls?: AgentToolCall[]) => void;
  resetSession: () => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  setPendingExecution: (pe: PendingExecution | null) => void;
  confirmExecution: () => void;
  dismissExecution: () => void;
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

export function executeTasksInStores(stores: TaskStoreType[]): void {
  for (const storeType of stores) {
    switch (storeType) {
      case "translate":
        useSubtitleTranslatorStore.getState().startAllTasks();
        break;
      case "convert":
        useSubtitleConverterStore.getState().startAllTasks();
        break;
      case "extract":
        useSubtitleExtractorStore.getState().startAllTasks();
        break;
    }
  }
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

      setStatus: (status) =>
        set((state) => ({
          session: { ...state.session, status, updatedAt: Date.now() },
        })),

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

      resetSession: () => {
        get().appendLog("session_reset", "Session reset");
        set({
          session: createNewSession(),
          isStreaming: false,
          streamingText: "",
          pendingExecution: null,
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
        if (!pendingExecution) return;
        executeTasksInStores(pendingExecution.stores);
        set({ pendingExecution: null });
      },

      dismissExecution: () => set({ pendingExecution: null }),

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
              ...state.tokenStats.interactions,
              { timestamp: Date.now(), promptTokens, completionTokens, totalTokens, cost, stepCount },
            ],
          },
        })),

      appendLog: (type, summary, data) =>
        set((state) => ({
          sessionLog: [
            ...state.sessionLog,
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
          session: data.session,
          tokenStats: data.tokenStats,
          sessionLog: data.sessionLog,
          executionMode: data.executionMode,
          isStreaming: false,
          streamingText: "",
          pendingExecution: null,
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
