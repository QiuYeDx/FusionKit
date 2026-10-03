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

  it("restores the composer when stopping an abort-aware tool request", async () => {
    mocks.execute.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    mocks.chat.mockImplementation(request => turn((async function* () {
      await request.tools.echo.execute({}, { toolCallId: "slow", messages: [] });
      yield { type: "finish", reason: "completed" } as const;
    })()));
    const operation = handleUserMessage("plan names");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    abortCurrentStream();
    await operation;
    expect(useAgentStore.getState()).toMatchObject({ isStreaming: false, session: { status: "idle" } });
  });

  it.each(["queue_only", "ask_before_execute", "auto_execute"] as const)("distinguishes classic queues from modern prepared actions in %s", async executionMode => {
    useAgentStore.setState({ executionMode });
    await handleUserMessage("prepare a translation");
    const prompt = mocks.chat.mock.calls[0][0].system;
    expect(prompt).toContain("Classic queued_only tasks are already in their tool queue");
    expect(prompt).toContain("modern prepared/ready action requires confirmation on HomeAgent");
    expect(prompt).not.toContain("After queuing, tell the user");
    if (executionMode === "queue_only") expect(prompt).toContain("no task is admitted until the user confirms that action here");
  });

  it("preserves bounded current confirmation state after its original preview leaves context", async () => {
    const store = useAgentStore.getState();
    store.addMessage({ id: "preview-user", role: "user", content: "ORIGINAL_PREVIEW_CONTEXT", timestamp: 1 });
    store.addMessage({ id: "long-one", role: "user", content: "x".repeat(60_000), timestamp: 2 });
    store.addMessage({ id: "long-two", role: "user", content: "y".repeat(60_000), timestamp: 3 });
    useAgentStore.setState({
      pendingExecution: { stores: ["convert"], taskCounts: { convert: 100 }, taskRefs: Array.from({ length: 100 }, (_, i) => ({ store: "convert", taskId: `task-${i}` })), timestamp: 1, resolvedAction: "confirm" },
      pendingNameTranslationPlan: {
        planId: "rename-current", createdByUserMessageId: "preview-user", createdAt: 1, resolvedAction: null,
        summary: { planId: "rename-current", totalTargets: 100, previewLimit: 30, readyCount: 100, blockedCount: 0, skippedCount: 0, unchangedCount: 0, warnings: [], applyable: true,
          itemsPreview: Array.from({ length: 30 }, (_, i) => ({ sourcePath: `source-${i}` + "s".repeat(1000), targetPath: `target-${i}` + "t".repeat(1000), status: "ready" })) as never },
      },
    });
    await handleUserMessage("确认执行刚才的重命名计划");
    const request = mocks.chat.mock.calls[0][0];
    expect(JSON.stringify(request.messages)).not.toContain("ORIGINAL_PREVIEW_CONTEXT");
    expect(request.system).toContain('"planId":"rename-current"');
    expect(request.system).toContain('"createdByUserMessageId":"preview-user"');
    expect(request.system).toContain('"status":"awaiting_confirmation"');
    expect(request.system).toContain('"status":"execution_requested"');
    expect(request.system).toContain('"taskRefsTruncated":true');
    expect(request.system).not.toContain('"taskId":"task-20"');
    expect(request.system).not.toContain("source-3");
    expect(request.system.length).toBeLessThan(22_000);
    expect(request.system).toContain("still requires a later explicit user confirmation");
    expect(useAgentStore.getState().pendingNameTranslationPlan?.resolvedAction).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not carry pending authority into a new session", async () => {
    useAgentStore.getState().setPendingExecution({ stores: ["convert"], taskCounts: { convert: 1 }, taskRefs: [{ store: "convert", taskId: "old-task-id" }], timestamp: 1 });
    useAgentStore.getState().resetSession();
    await handleUserMessage("status");
    expect(mocks.chat.mock.calls[0][0].system).not.toContain("old-task-id");
  });
});
