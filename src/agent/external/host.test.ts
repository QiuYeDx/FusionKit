import { beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useModelStore from "@/store/useModelStore";
import type { ExternalAgentApi, ExternalAgentStatus, ExternalToolCall, ExternalToolResponse } from "./contract";
import { ExternalToolError } from "./errors";
import { installExternalAgentHost } from "./host";
import { EXTERNAL_ACTIVITY_LIMIT, useExternalAgentStore } from "./store";

function fakeApi() {
  const listeners = { call: [] as ((call: ExternalToolCall) => void)[], cancel: [] as ((value: { callId: string }) => void)[], status: [] as ((status: ExternalAgentStatus) => void)[] };
  const responses: ExternalToolResponse[] = [];
  const status: ExternalAgentStatus = { enabled: true, state: "running", port: 1, trust: "confirm_writes", sessions: [{ id: "s1", client: { name: "claude-code", version: "2" }, connectedAt: 1, lastActiveAt: 1 }] };
  const api = {
    getSettings: vi.fn(), updateSettings: vi.fn(), regenerateToken: vi.fn(), closeSession: vi.fn(), connectionInfo: vi.fn(), installSkill: vi.fn(), skillStatus: vi.fn(),
    writeClientConfig: vi.fn(), clientConfigStatus: vi.fn(), revealClientConfig: vi.fn(), openClientInstall: vi.fn(),
    getStatus: vi.fn(async () => ({ ok: true as const, value: status })),
    onCall: (listener) => { listeners.call.push(listener); return () => { listeners.call = listeners.call.filter(item => item !== listener); }; },
    onCancel: (listener) => { listeners.cancel.push(listener); return () => { listeners.cancel = []; }; },
    onStatus: (listener) => { listeners.status.push(listener); return () => { listeners.status = []; }; },
    ready: vi.fn(), requestAttention: vi.fn(),
    activityList: vi.fn(), activitySessions: vi.fn(), activityClear: vi.fn(), activityUndone: vi.fn(), reportActivity: vi.fn(), onActivity: () => () => {},
    respond: vi.fn(async (response: ExternalToolResponse) => { responses.push(response); }),
  } satisfies ExternalAgentApi;
  const send = (tool: string, args: Record<string, unknown> = {}, callId = `call-${responses.length}-${Math.random()}`) => {
    listeners.call.forEach(listener => listener({ callId, sessionId: "s1", client: { name: "claude-code", version: "2" }, tool, arguments: args }));
    return callId;
  };
  return { api, listeners, responses, send, status };
}
const answer = async (responses: ExternalToolResponse[], callId: string) => {
  await vi.waitFor(() => expect(responses.some(item => item.callId === callId)).toBe(true));
  return responses.find(item => item.callId === callId)!.result;
};

beforeEach(() => {
  useExternalAgentStore.setState({ status: null, activity: {} });
  useModelStore.setState({ profiles: [{ id: "task", name: "Task", provider: Model.OpenAI, apiKey: "sk-secret-123", baseUrl: "https://api.example/v1", modelKey: "m", apiFormat: "responses", tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { agent: null, taskExecution: "task" } });
});

describe("external tool host", () => {
  it("declares itself ready, runs calls with defaults applied and answers", async () => {
    const { api, send, responses } = fakeApi();
    const list = vi.fn(async (input: unknown, _ctx: unknown) => ({ input }));
    const stop = installExternalAgentHost(api, { list_studio_documents: list });
    expect(api.ready).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(useExternalAgentStore.getState().status?.sessions[0].client.name).toBe("claude-code"));
    const id = send("list_studio_documents", { query: "ep" });
    expect(await answer(responses, id)).toEqual({ ok: true, data: { input: { query: "ep", offset: 0, limit: 20, format: "all", status: "all" } } });
    expect(list.mock.calls[0][1]).toMatchObject({ sessionId: "s1", client: { name: "claude-code", version: "2" } });
    stop();
  });

  it("answers unknown tools and bad arguments with stable codes", async () => {
    const { api, send, responses } = fakeApi();
    installExternalAgentHost(api, { list_studio_documents: vi.fn() });
    expect(await answer(responses, send("delete_everything"))).toEqual({ ok: false, error: "unknown_tool" });
    expect(await answer(responses, send("get_fusionkit_status"))).toEqual({ ok: false, error: "unknown_tool" });
    const bad = await answer(responses, send("list_studio_documents", { limit: 0 }));
    expect(bad).toMatchObject({ ok: false, error: "invalid_arguments", detail: { issues: [expect.stringMatching(/^limit:/)] } });
  });

  it("keeps tool codes, and turns crashes into tool_failed without secrets", async () => {
    const { api, send, responses } = fakeApi();
    installExternalAgentHost(api, {
      get_fusionkit_status: async () => { throw new ExternalToolError("revision_conflict", { currentRevision: 4 }); },
      list_studio_documents: async () => { throw new Error(`request with sk-secret-123 failed ${"x".repeat(900)}`); },
    });
    expect(await answer(responses, send("get_fusionkit_status"))).toEqual({ ok: false, error: "revision_conflict", detail: { currentRevision: 4 } });
    const crashed = await answer(responses, send("list_studio_documents")) as { ok: false; error: string; detail: { reason: string } };
    expect(crashed.error).toBe("tool_failed");
    expect(crashed.detail.reason).toContain("[redacted]");
    expect(crashed.detail.reason).not.toContain("sk-secret-123");
    expect(crashed.detail.reason.length).toBe(600);
  });

  it("aborts a running tool when the call is cancelled", async () => {
    const { api, send, responses, listeners } = fakeApi();
    let signal: AbortSignal | undefined;
    installExternalAgentHost(api, { get_fusionkit_status: (_input, ctx) => new Promise((_resolve, reject) => { signal = ctx.signal; ctx.signal.addEventListener("abort", () => reject(new ExternalToolError("cancelled"))); }) });
    const id = send("get_fusionkit_status");
    await vi.waitFor(() => expect(signal).toBeDefined());
    listeners.cancel.forEach(listener => listener({ callId: id }));
    expect(await answer(responses, id)).toEqual({ ok: false, error: "cancelled" });
    expect(signal!.aborted).toBe(true);
  });

  it("records each call per session, keeps the latest 50 and forgets ended sessions", async () => {
    const { api, send, responses, listeners, status } = fakeApi();
    installExternalAgentHost(api, { list_studio_documents: async () => ({}) });
    await vi.waitFor(() => expect(useExternalAgentStore.getState().status).not.toBeNull());
    const ids = Array.from({ length: EXTERNAL_ACTIVITY_LIMIT + 5 }, () => send("list_studio_documents"));
    await answer(responses, ids.at(-1)!);
    await vi.waitFor(() => expect(useExternalAgentStore.getState().activity.s1).toHaveLength(EXTERNAL_ACTIVITY_LIMIT));
    expect(useExternalAgentStore.getState().activity.s1.at(-1)).toMatchObject({ tool: "list_studio_documents", ok: true });
    listeners.status.forEach(listener => listener({ ...status, sessions: [] }));
    expect(useExternalAgentStore.getState().activity.s1).toBeUndefined();
  });

  it("answers with the activity note: a read's document, nothing for a bare read", async () => {
    const { api, send, responses } = fakeApi();
    installExternalAgentHost(api, {
      read_studio_document: async () => ({ document: { documentId: "d1", name: "Ep01.srt" }, cues: [] }),
      list_studio_documents: async () => ({ items: [] }),
    });
    const read = send("read_studio_document", { documentId: "8d0f6f1e-2c1b-4d7a-9a51-3f0d2b7c9e10" });
    expect(await answer(responses, read)).toMatchObject({ ok: true });
    expect(responses.find(item => item.callId === read)?.activity).toEqual({ target: { documentId: "d1", documentName: "Ep01.srt" } });
    const list = send("list_studio_documents");
    await answer(responses, list);
    expect(responses.find(item => item.callId === list)).not.toHaveProperty("activity");
  });

  it("does nothing without the preload API", () => {
    expect(() => installExternalAgentHost(null)()).not.toThrow();
  });
});
