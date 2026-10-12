import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeStreamPart } from "./runtime/types";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
  return { chat: vi.fn(), responses: vi.fn(), format: "chat_completions" as "chat_completions" | "responses" };
});
vi.mock("./runtime/chat-completions-agent-adapter", () => ({ ChatCompletionsAgentAdapter: class { streamTurn = mocks.chat; } }));
vi.mock("./runtime/responses-agent-adapter", () => ({ ResponsesAgentAdapter: class { streamTurn = mocks.responses; } }));
vi.mock("@/store/useModelStore", () => ({ default: { getState: () => ({ getAgentProfile: () => ({
  id: "test", apiKey: "secret-key", apiFormat: mocks.format, baseUrl: "https://example.test/v1", modelKey: "m", tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
}) }) } }));

import useAgentStore from "@/store/agent/useAgentStore";
import { generateSessionTitle, resetSessionTitleAttempts, TITLE_INSTRUCTIONS_PREFIX } from "./session-title-generator";

const state = () => useAgentStore.getState();
const stream = (...parts: AgentRuntimeStreamPart[]) => ({ fullStream: (async function* () { yield* parts; })(), usage: Promise.resolve(undefined) });
const answer = (text: string) => stream({ type: "text-delta", text }, { type: "finish-step", usage: { inputTokens: 40, outputTokens: 6, totalTokens: 46 } }, { type: "finish", reason: "completed" });
function converse() {
  state().addMessage({ id: "u", role: "user", content: "把工作台里还没翻译的日语字幕翻成中文", timestamp: 1 });
  state().addMessage({ id: "a", role: "assistant", content: "已准备好翻译，请确认。", timestamp: 2 });
  state().recordUsage({ promptTokens: 900, completionTokens: 10, totalTokens: 910, cost: 0, stepCount: 1, lastPromptTokens: 900 });
  return state().activeSessionId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.format = "chat_completions";
  resetSessionTitleAttempts();
  state().removeAllSessions();
});

describe("generated session titles", () => {
  it("asks once without tools and replaces the excerpt, counting the cost but not the context", async () => {
    const id = converse();
    mocks.chat.mockReturnValue(answer("“日语字幕翻译成中文。”"));
    await generateSessionTitle(id);
    const request = mocks.chat.mock.calls[0][0];
    expect(request.tools).toEqual({});
    expect(request.maxSteps).toBe(1);
    expect(request.system.startsWith(TITLE_INSTRUCTIONS_PREFIX)).toBe(true);
    expect(JSON.stringify(request.messages)).toContain("还没翻译的日语字幕");
    expect(JSON.stringify(request.messages)).toContain("已准备好翻译");
    expect(state().session).toMatchObject({ title: "日语字幕翻译成中文", titleSource: "generated" });
    expect(state().tokenStats).toMatchObject({ totalTokens: 956, lastPromptTokens: 900 });
    await generateSessionTitle(id);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it("uses the Responses format when the agent model does", async () => {
    mocks.format = "responses";
    const id = converse();
    mocks.responses.mockReturnValue(answer("Subtitle translation"));
    await generateSessionTitle(id);
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.responses.mock.calls[0][0].messages[0]).toMatchObject({ role: "user" });
    expect(state().session.title).toBe("Subtitle translation");
  });

  it("keeps a title the user typed while the request was on its way", async () => {
    const id = converse();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    mocks.chat.mockReturnValue({ fullStream: (async function* () { await gate; yield { type: "text-delta", text: "Generated" } as const; yield { type: "finish", reason: "completed" } as const; })(), usage: Promise.resolve(undefined) });
    const operation = generateSessionTitle(id);
    state().renameSession(id, "Mine");
    release(); await operation;
    expect(state().session).toMatchObject({ title: "Mine", titleSource: "manual" });
    resetSessionTitleAttempts();
    await generateSessionTitle(id);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it("keeps the excerpt quietly when naming fails, and logs why", async () => {
    const id = converse();
    mocks.chat.mockReturnValue(stream({ type: "error", error: new Error("rate limited secret-key") }));
    await generateSessionTitle(id);
    expect(state().session).toMatchObject({ title: "把工作台里还没翻译的日语字幕翻成中文", titleSource: "auto" });
    const log = state().sessionLog.find((entry) => entry.summary === "title_failed");
    expect(log?.data?.reason).toContain("rate limited");
    expect(JSON.stringify(log)).not.toContain("secret-key");
    mocks.chat.mockReturnValue(answer("。。"));
    resetSessionTitleAttempts();
    await generateSessionTitle(id);
    expect(state().session.titleSource).toBe("auto");
  });

  it("waits for a first reply with text before using its one attempt", async () => {
    state().addMessage({ id: "u", role: "user", content: "hello", timestamp: 1 });
    const id = state().activeSessionId;
    await generateSessionTitle(id);
    expect(mocks.chat).not.toHaveBeenCalled();
    state().addMessage({ id: "a", role: "assistant", content: "Hi!", timestamp: 2 });
    mocks.chat.mockReturnValue(answer("Greeting"));
    await generateSessionTitle(id);
    expect(state().session.title).toBe("Greeting");
  });

  it("gives up when the session is deleted meanwhile", async () => {
    const id = converse();
    mocks.chat.mockImplementation((request: { abortSignal: AbortSignal }) => ({ fullStream: (async function* () {
      await new Promise((resolve) => request.abortSignal.addEventListener("abort", resolve, { once: true }));
      yield { type: "finish", reason: "cancelled" } as const;
    })(), usage: Promise.resolve(undefined) }));
    const operation = generateSessionTitle(id);
    state().removeSession(id);
    await operation;
    expect(state().hasSession(id)).toBe(false);
  });
});
