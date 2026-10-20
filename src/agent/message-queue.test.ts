import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeStreamPart } from "./runtime/types";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  return { chat: vi.fn() };
});
vi.mock("./session-title-generator", () => ({ generateSessionTitle: async () => {} }));
vi.mock("./runtime/chat-completions-agent-adapter", () => ({ ChatCompletionsAgentAdapter: class { streamTurn = mocks.chat; } }));
vi.mock("./runtime/responses-agent-adapter", () => ({ ResponsesAgentAdapter: class { streamTurn = vi.fn(); } }));
vi.mock("./tools", () => ({ agentTools: {} }));
vi.mock("./prepared-actions", () => ({ usePreparedActionsStore: { getState: () => ({ actions: [] }) } }));
vi.mock("@/store/useModelStore", () => ({ default: { getState: () => ({ getAgentProfile: () => ({
  id: "test", apiKey: "secret-test-key", apiFormat: "chat_completions", baseUrl: "https://example.test/v1", modelKey: "test-model", tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
}) }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import useAgentStore from "@/store/agent/useAgentStore";
import { abortCurrentStream, isSessionRunning, resumeMessageQueue, sendQueuedMessageNow, submitUserMessage } from "./orchestrator";

type Request = { messages: { role: string; content: unknown }[]; abortSignal: AbortSignal };

/** Replies that wait until released (or stopped), so the test decides when each turn ends. */
const pending: (() => void)[] = [];
function heldReply(request: Request, fail = false) {
  const signal = request.abortSignal;
  return {
    usage: Promise.resolve(undefined),
    fullStream: (async function* (): AsyncGenerator<AgentRuntimeStreamPart> {
      await new Promise<void>((resolve, reject) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => {
          pending.splice(pending.indexOf(resolve), 1);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      if (fail) throw new Error("server error");
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "completed" };
    })(),
  };
}
const lastUserText = (request: Request) => String([...request.messages].reverse().find((message) => message.role === "user")?.content);
const sent = () => mocks.chat.mock.calls.map(([request]) => lastUserText(request as Request));
const release = () => pending.shift()?.();
const queue = () => useAgentStore.getState().queuedMessages.map((message) => message.content);
const sessionId = () => useAgentStore.getState().activeSessionId;

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
  useAgentStore.getState().resetSession();
  mocks.chat.mockImplementation((request: Request) => heldReply(request));
});

describe("messages written while a reply runs", () => {
  it("wait in the session's queue and go out in order, each once the reply before it ends", async () => {
    expect(submitUserMessage("first")).toBe("sent");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    expect(submitUserMessage("second")).toBe("queued");
    expect(submitUserMessage("third")).toBe("queued");
    expect(queue()).toEqual(["second", "third"]);
    expect(useAgentStore.getState().session.messages.map((message) => message.content)).toEqual(["first"]);

    release();
    await vi.waitFor(() => expect(sent()).toEqual(["first", "second"]));
    expect(queue()).toEqual(["third"]);
    release();
    await vi.waitFor(() => expect(sent()).toEqual(["first", "second", "third"]));
    release();
    await vi.waitFor(() => expect(isSessionRunning(sessionId())).toBe(false));
    expect(queue()).toEqual([]);
  });

  it("wait for the user after they stopped the reply, and go on when asked", async () => {
    submitUserMessage("first");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    submitUserMessage("second");
    abortCurrentStream();
    await vi.waitFor(() => expect(useAgentStore.getState().queuePaused).toBe(true));
    expect(isSessionRunning(sessionId())).toBe(false);
    expect(mocks.chat).toHaveBeenCalledTimes(1);

    resumeMessageQueue();
    await vi.waitFor(() => expect(sent()).toEqual(["first", "second"]));
    expect(useAgentStore.getState()).toMatchObject({ queuePaused: false, queuedMessages: [] });
    release();
  });

  it("also wait after a failed reply", async () => {
    mocks.chat.mockImplementationOnce((request: Request) => heldReply(request, true));
    submitUserMessage("first");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    submitUserMessage("second");
    release();
    await vi.waitFor(() => expect(useAgentStore.getState().queuePaused).toBe(true));
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(queue()).toEqual(["second"]);
  });

  it("can be sent now: the reply stops and that message goes out before the others", async () => {
    submitUserMessage("first");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    submitUserMessage("second");
    submitUserMessage("urgent");
    const urgent = useAgentStore.getState().queuedMessages.find((message) => message.content === "urgent")!;
    sendQueuedMessageNow(urgent.id);
    await vi.waitFor(() => expect(sent()).toEqual(["first", "urgent"]));
    expect(mocks.chat.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(useAgentStore.getState()).toMatchObject({ queuePaused: false });
    expect(queue()).toEqual(["second"]);
    release();
    await vi.waitFor(() => expect(sent()).toEqual(["first", "urgent", "second"]));
    release();
  });

  it("go out at once with now from the composer, and straight away when the session is free", async () => {
    submitUserMessage("first");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    expect(submitUserMessage("instead", { now: true })).toBe("queued");
    await vi.waitFor(() => expect(sent()).toEqual(["first", "instead"]));
    release();
    await vi.waitFor(() => expect(isSessionRunning(sessionId())).toBe(false));
    expect(submitUserMessage("   ")).toBe("ignored");
  });

  it("are kept per session and leave a session non-blank", async () => {
    submitUserMessage("first");
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    const busy = sessionId();
    submitUserMessage("later");
    useAgentStore.getState().resetSession();
    expect(useAgentStore.getState().queuedMessages).toEqual([]);
    expect(useAgentStore.getState().slots[busy].queuedMessages.map((message) => message.content)).toEqual(["later"]);
    release();
    await vi.waitFor(() => expect(sent()).toEqual(["first", "later"]));
    release();
  });
});
