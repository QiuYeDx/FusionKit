import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeStreamPart } from "./runtime/types";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  return { chat: vi.fn(), responses: vi.fn(), execute: vi.fn(), actions: [] as unknown[] };
});
vi.mock("./runtime/chat-completions-agent-adapter", () => ({ ChatCompletionsAgentAdapter: class { streamTurn = mocks.chat; } }));
vi.mock("./runtime/responses-agent-adapter", () => ({ ResponsesAgentAdapter: class { streamTurn = mocks.responses; } }));
vi.mock("./tools", () => ({ agentTools: { echo: { execute: (...args: unknown[]) => mocks.execute(...args) } } }));
vi.mock("./prepared-actions", () => ({ usePreparedActionsStore: { getState: () => ({ actions: mocks.actions }) } }));
vi.mock("@/store/useModelStore", () => ({ default: { getState: () => ({ getAgentProfile: () => ({
  id: "test", apiKey: "secret-test-key", apiFormat: "chat_completions", baseUrl: "https://example.test/v1", modelKey: "test-model", tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 2 },
}) }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string, args?: { error?: string }) => args?.error ? `${key}: ${args.error}` : key } }));

import useAgentStore from "@/store/agent/useAgentStore";
import { abortCurrentStream, handleUserMessage } from "./orchestrator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const turn = (fullStream: AsyncIterable<AgentRuntimeStreamPart>) => ({ fullStream, usage: Promise.resolve(undefined) });
const parts = async function* (...events: AgentRuntimeStreamPart[]) { yield* events; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actions = [];
  useAgentStore.getState().resetSession();
  mocks.chat.mockReturnValue(turn(parts({ type: "text-delta", text: "done" }, { type: "finish", reason: "completed" })));
});

describe("Agent turn ownership and receipts", () => {
  it("claims synchronously so duplicate submissions do not duplicate user messages or requests", async () => {
    const gate = deferred();
    mocks.chat.mockReturnValue(turn((async function* () { await gate.promise; yield { type: "finish", reason: "completed" } as const; })()));
    const first = handleUserMessage("run");
    await handleUserMessage("duplicate");
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().session.messages.map((message) => message.content)).toEqual(["run"]);
    gate.resolve(); await first;
  });

  it("fences late old events and finally after reset while a new turn is active", async () => {
    const oldGate = deferred();
    const newGate = deferred();
    mocks.chat.mockReturnValueOnce(turn((async function* () {
      yield { type: "text-delta", text: "old" } as const;
      await oldGate.promise;
      yield { type: "text-delta", text: "late old" } as const;
    })()));
    mocks.chat.mockReturnValueOnce(turn((async function* () {
      yield { type: "text-delta", text: "new" } as const;
      await newGate.promise;
      yield { type: "finish", reason: "completed" } as const;
    })()));
    const oldTurn = handleUserMessage("old user");
    await vi.waitFor(() => expect(useAgentStore.getState().streamingText).toBe("old"));
    useAgentStore.getState().resetSession();
    expect(mocks.chat.mock.calls[0][0].abortSignal.aborted).toBe(true);
    const newTurn = handleUserMessage("new user");
    await vi.waitFor(() => expect(useAgentStore.getState().streamingText).toBe("new"));
    oldGate.resolve(); await oldTurn;
    expect(useAgentStore.getState().isStreaming).toBe(true);
    expect(useAgentStore.getState().streamingText).toBe("new");
    expect(useAgentStore.getState().session.messages.map((m) => m.content)).toEqual(["new user"]);
    newGate.resolve(); await newTurn;
    expect(useAgentStore.getState().isStreaming).toBe(false);
    expect(useAgentStore.getState().session.messages.at(-1)?.content).toBe("new");
  });

  it("cancels a turn on import and does not append old errors into restored history", async () => {
    const gate = deferred();
    const data = useAgentStore.getState().getSessionExportData();
    mocks.chat.mockReturnValue(turn((async function* () { await gate.promise; throw new Error("late error"); yield* []; })()));
    const operation = handleUserMessage("old");
    useAgentStore.getState().restoreSession(data);
    gate.resolve(); await operation;
    expect(useAgentStore.getState().session.messages).toEqual([]);
    expect(useAgentStore.getState().session.status).toBe("idle");
  });

  it("retains completed tool facts and supplies unknown results for interrupted calls", async () => {
    mocks.chat.mockReturnValue(turn((async function* () {
      yield { type: "tool-call", toolCallId: "done", toolName: "echo", input: { n: 1 } } as const;
      yield { type: "tool-result", toolCallId: "done", toolName: "echo", output: { success: true, data: { taskId: "accepted" } } } as const;
      yield { type: "tool-call", toolCallId: "unknown", toolName: "echo", input: { n: 2 } } as const;
      throw new Error("network lost");
    })()));
    await handleUserMessage("run both");
    const messages = useAgentStore.getState().session.messages;
    expect(messages.find((m) => m.toolCalls)?.toolCalls?.map((call) => call.toolCallId)).toEqual(["done", "unknown"]);
    expect(messages.find((m) => m.toolResult?.callId === "done")?.toolResult).toMatchObject({ success: true, data: { taskId: "accepted" } });
    expect(messages.find((m) => m.toolResult?.callId === "unknown")?.toolResult).toMatchObject({ success: false, error: expect.stringContaining("unknown") });
  });

  it("captures a direct tool receipt even when SDK cancellation drops its output event", async () => {
    mocks.execute.mockResolvedValue({ success: true, data: { taskId: "accepted" } });
    mocks.chat.mockImplementation((request) => turn((async function* () {
      await request.tools.echo.execute({}, { toolCallId: "receipt", messages: [] });
      abortCurrentStream();
      yield { type: "finish", reason: "cancelled" } as const;
    })()));
    await handleUserMessage("run");
    expect(useAgentStore.getState().session.messages.find((m) => m.toolResult)?.toolResult).toMatchObject({ success: true, data: { taskId: "accepted" } });
    expect(useAgentStore.getState().session.status).toBe("idle");
  });

  it.each(["completed", "step_limit", "incomplete"] as const)("ends remaining plan spinners on %s", async (reason) => {
    useAgentStore.getState().updatePlan({ goal: "Work", steps: [{ id: "one", title: "Do work", status: "in_progress" }] });
    mocks.chat.mockReturnValue(turn(parts({ type: "finish", reason })));
    await handleUserMessage("continue");
    expect(useAgentStore.getState().session.plan?.steps[0].status).toBe("blocked");
    expect(useAgentStore.getState().isStreaming).toBe(false);
    if (reason === "step_limit") expect(useAgentStore.getState().session.messages.at(-1)?.content).toBe("home:agent_step_limit");
  });

  it("includes current prepared receipts without callback data and isolates other sessions", async () => {
    mocks.actions = [
      { id: "mine", sessionId: useAgentStore.getState().session.id, toolKey: "studio_translation", status: "completed", summary: "submitted", result: { taskIds: ["task-1"] }, execute: "private" },
      { id: "other", sessionId: "other", toolKey: "studio_translation", status: "ready", summary: "other-private" },
    ];
    await handleUserMessage("status");
    const prompt = mocks.chat.mock.calls[0][0].system;
    expect(prompt).toContain("task-1");
    expect(prompt).not.toContain("other-private");
    expect(prompt).not.toContain('"execute":"private"');
    expect(prompt).toContain("prepare_studio_translation");
  });

  it("redacts the model credential from reported errors", async () => {
    mocks.chat.mockReturnValue(turn((async function* () { throw new Error("failed secret-test-key"); yield* []; })()));
    await handleUserMessage("run");
    expect(JSON.stringify(useAgentStore.getState().getSessionExportData())).not.toContain("secret-test-key");
  });
});
