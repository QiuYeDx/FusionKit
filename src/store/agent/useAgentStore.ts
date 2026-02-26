import { create } from "zustand";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionStatus,
  ExecutionMode,
  PendingExecution,
  TaskStoreType,
} from "@/agent/types";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";

// ---------------------------------------------------------------------------
// Agent Store — 会话、消息、执行模式状态管理
// ---------------------------------------------------------------------------

interface AgentStore {
  session: AgentSession;
  isStreaming: boolean;
  executionMode: ExecutionMode;
  pendingExecution: PendingExecution | null;

  addMessage: (message: AgentMessage) => void;
  setStatus: (status: AgentSessionStatus) => void;
  setStreaming: (streaming: boolean) => void;
  resetSession: () => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  setPendingExecution: (pe: PendingExecution | null) => void;
  confirmExecution: () => void;
  dismissExecution: () => void;
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

function loadExecutionMode(): ExecutionMode {
  try {
    const saved = localStorage.getItem("agent-execution-mode");
    if (saved === "queue_only" || saved === "ask_before_execute" || saved === "auto_execute") {
      return saved;
    }
  } catch { /* silent */ }
  return "queue_only";
}

function persistExecutionMode(mode: ExecutionMode): void {
  try {
    localStorage.setItem("agent-execution-mode", mode);
  } catch { /* silent */ }
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

const useAgentStore = create<AgentStore>((set, get) => ({
  session: createNewSession(),
  isStreaming: false,
  executionMode: loadExecutionMode(),
  pendingExecution: null,

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

  resetSession: () =>
    set({
      session: createNewSession(),
      isStreaming: false,
      pendingExecution: null,
    }),

  setExecutionMode: (mode) => {
    persistExecutionMode(mode);
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
}));

export default useAgentStore;
