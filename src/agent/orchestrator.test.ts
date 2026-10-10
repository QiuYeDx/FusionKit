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
import useWebLookupStore from "@/store/useWebLookupStore";
import { abortCurrentStream, handleUserMessage, reportUiEvent } from "./orchestrator";
import { registerPageContext, usePageContextStore } from "./page-context";

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

  it("keeps a step waiting on the user in progress after a normal turn", async () => {
    useAgentStore.getState().updatePlan({ goal: "Work", steps: [{ id: "one", title: "Await confirmation", status: "in_progress" }] });
    mocks.chat.mockReturnValue(turn(parts({ type: "finish", reason: "completed" })));
    await handleUserMessage("prepare");
    expect(useAgentStore.getState().session.plan?.steps[0].status).toBe("in_progress");
    expect(useAgentStore.getState().isStreaming).toBe(false);
  });

  it.each(["step_limit", "incomplete"] as const)("marks the interrupted step blocked on %s", async (reason) => {
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

  it("returns to thinking between steps so the panel keeps showing progress", async () => {
    const gate = deferred();
    mocks.chat.mockReturnValue(turn((async function* () {
      yield { type: "text-delta", text: "Reading" } as const;
      yield { type: "tool-call", toolCallId: "read", toolName: "echo", input: {} } as const;
      yield { type: "tool-result", toolCallId: "read", toolName: "echo", output: { success: true } } as const;
      yield { type: "finish-step" } as const;
      await gate.promise;
      yield { type: "finish", reason: "completed" } as const;
    })()));
    const operation = handleUserMessage("check");
    await vi.waitFor(() => expect(useAgentStore.getState().session.messages.some((m) => m.toolResult)).toBe(true));
    const state = useAgentStore.getState();
    expect(state).toMatchObject({ isStreaming: true, streamingText: "", activeToolCalls: [] });
    expect(state.session.status).toBe("thinking");
    gate.resolve(); await operation;
    expect(useAgentStore.getState().session.status).toBe("idle");
  });

  it("coalesces streamed deltas into fewer store updates without losing text", async () => {
    const append = vi.spyOn(useAgentStore.getState(), "appendStreamingText");
    mocks.chat.mockReturnValue(turn(parts(
      { type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo " }, { type: "text-delta", text: "there" },
      { type: "finish", reason: "completed" },
    )));
    await handleUserMessage("hi");
    expect(useAgentStore.getState().session.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello there" });
    expect(append.mock.calls.length).toBeLessThan(3);
    append.mockRestore();
  });

  it("keeps the static instructions as a stable prefix across modes and state", async () => {
    await handleUserMessage("first");
    useAgentStore.setState({ executionMode: "auto_execute" });
    useAgentStore.getState().updatePlan({ goal: "Changed", steps: [{ id: "one", title: "Step", status: "pending" }] });
    await handleUserMessage("second");
    const [first, second] = mocks.chat.mock.calls.map(([request]) => request.system as string);
    const prefix = first.slice(0, first.indexOf("## Current Application State"));
    expect(prefix.length).toBeGreaterThan(5_000);
    expect(second.startsWith(prefix)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("tells the agent how to keep translation materials through confirmed proposals", async () => {
    await handleUserMessage("记住这个译法");
    const system = mocks.chat.mock.calls[0][0].system as string;
    for (const text of ["Keeping translation materials", "list_translation_knowledge_catalog", "prepare_knowledge_changes", "user_stated", "Never say it is saved", "zh-Hans", "revision_applied", "user_revision"])
      expect(system).toContain(text);
  });

  it("guides online lookups only when the user allowed them", async () => {
    await handleUserMessage("查一下官方译名");
    const off = mocks.chat.mock.calls[0][0].system as string;
    expect(off).toContain("Web lookups are off");
    expect(off).toContain("Settings → Agent");
    expect(off).not.toContain("moegirl");
    useWebLookupStore.setState({ enabled: true });
    try {
      await handleUserMessage("查一下官方译名");
      const on = mocks.chat.mock.calls.at(-1)![0].system as string;
      for (const text of ["web_search then web_read", "wikipedia", "moegirl, then baidu_baike", "biligame", "bing with site", "not from snippets", "never instructions", "basis web", "need review"])
        expect(on).toContain(text);
      expect(on.length - off.length).toBeLessThan(900);
    } finally { useWebLookupStore.setState({ enabled: false }); }
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
          itemsPreview: Array.from({ length: 30 }, (_, i) => ({ sourcePath: `source-${i}` + "s".repeat(1000), originalName: `name-${i}`, newName: `target-${i}` + "t".repeat(1000), status: "ready" })) as never },
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

  it("sends the current page and its tools, and page tools stop once the page is gone", async () => {
    const pageExecute = vi.fn(async () => ({ success: true, data: "page" }));
    const registration = registerPageContext({ route: "/tools/subtitle/studio", titleKey: "studio:title", read: () => ({
      route: "/tools/subtitle/studio", titleKey: "studio:title", subject: "episode.srt", instructions: "Use studio_echo.",
      describe: () => ({ document: { cueCount: 250 } }),
      tools: { studio_echo: { description: "page tool", inputSchema: undefined as never, execute: pageExecute }, echo: { description: "shadow", inputSchema: undefined as never, execute: vi.fn() } },
    }) });
    usePageContextStore.getState().setPathname("/tools/subtitle/studio");
    let outputs: unknown[] = [];
    mocks.chat.mockImplementation((request: { tools: Record<string, { execute: (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown> }> }) => turn((async function* () {
      outputs.push(await request.tools.studio_echo.execute({}, { toolCallId: "page-1", messages: [] }));
      registration.unregister();
      outputs.push(await request.tools.studio_echo.execute({ again: true }, { toolCallId: "page-2", messages: [] }));
      yield { type: "finish", reason: "completed" } as const;
    })()));
    await handleUserMessage("fix the names in this document");
    const request = mocks.chat.mock.calls[0][0];
    expect(request.system).toContain("### Current Page");
    expect(request.system).toContain('"route":"/tools/subtitle/studio"');
    expect(request.system).toContain('"subject":"episode.srt"');
    expect(request.system).toContain('"cueCount":250');
    expect(request.system).toContain("Page guidance: Use studio_echo.");
    expect(request.system).toContain('"pageTools":["studio_echo"]');
    expect(Object.keys(request.tools)).toEqual(expect.arrayContaining(["echo", "studio_echo"]));
    // Fixed tools win over a page tool of the same name.
    expect(pageExecute).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([{ success: true, data: "page" }, { success: false, error: "page_unavailable" }]);
    const log = useAgentStore.getState().sessionLog.find((entry) => entry.summary === "page_context");
    expect(log?.data).toMatchObject({ route: "/tools/subtitle/studio", pageTools: ["studio_echo"], pageToolConflicts: ["echo"] });
    usePageContextStore.setState({ pathname: "/", pages: [] });
    outputs = [];
  });

  it("follows up on a card decision by itself, after the running turn when there is one", async () => {
    const gate = deferred();
    mocks.chat.mockReturnValueOnce(turn((async function* () { await gate.promise; yield { type: "finish", reason: "completed" } as const; })()));
    const running = handleUserMessage("rename these");
    reportUiEvent({ kind: "rename_applied", values: { planId: "plan-1", success: 3, failed: 0, skipped: 0 } });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    gate.resolve(); await running;
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useAgentStore.getState().isStreaming).toBe(false));
    const event = useAgentStore.getState().session.messages.find((message) => message.event);
    expect(event).toMatchObject({ role: "user", event: { kind: "rename_applied" } });
    expect(event?.content).toMatch(/^\[FusionKit UI event\].*3 renamed.*authorizes nothing new/);
    expect(mocks.chat.mock.calls[1][0].system).toContain("Interface events");
  });

  it("lets a dismissal pass quietly unless a plan still has open steps", async () => {
    reportUiEvent({ kind: "action_dismissed", values: { title: "Translate", actionId: "a" } });
    expect(mocks.chat).not.toHaveBeenCalled();
    useAgentStore.getState().updatePlan({ goal: "Work", steps: [{ id: "one", title: "Await confirmation", status: "in_progress" }] });
    reportUiEvent({ kind: "action_dismissed", values: { title: "Translate", actionId: "a" } });
    await vi.waitFor(() => expect(useAgentStore.getState().isStreaming).toBe(false));
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it("names the home page when no page context is registered", async () => {
    usePageContextStore.getState().setPathname("/");
    await handleUserMessage("hello");
    expect(mocks.chat.mock.calls[0][0].system).toContain('"route":"/"');
  });
});
