import { create } from "zustand";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionStatus,
} from "@/agent/types";

// ---------------------------------------------------------------------------
// Agent Store — 会话与消息状态管理
// ---------------------------------------------------------------------------

interface AgentStore {
  session: AgentSession;
  isStreaming: boolean;

  addMessage: (message: AgentMessage) => void;
  setStatus: (status: AgentSessionStatus) => void;
  setStreaming: (streaming: boolean) => void;
  resetSession: () => void;
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

const useAgentStore = create<AgentStore>((set) => ({
  session: createNewSession(),
  isStreaming: false,

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
    }),
}));

export default useAgentStore;
