import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitConfirmation, confirmed, forgetEndedSessions, pathItem, resetExternalConfirmations, useExternalConfirmationsStore } from "./confirmations";
import { useExternalAgentStore } from "./store";
import type { ExternalTrust } from "./contract";

const originalWindow = globalThis.window;
const attention = vi.fn();
const ctx = (sessionId = "s1", signal = new AbortController().signal) => ({ sessionId, client: { name: "claude-code", version: "2" }, signal });
const display = { action: "translation" as const, summary: "write_translations" as const, values: { count: 2, document: "ep01.srt", track: "zh" }, items: [{ text: "早上好" }, { text: "天气真好" }] };
const trust = (value: ExternalTrust) => useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: value, sessions: [] }, activity: {} });
const pending = () => useExternalConfirmationsStore.getState().requests.filter(item => item.status === "pending");
const waitForRequest = () => vi.waitFor(() => expect(pending().length).toBeGreaterThan(0));

beforeEach(() => {
  resetExternalConfirmations();
  attention.mockClear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { externalAgent: { requestAttention: attention } } });
  trust("confirm_writes");
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); vi.useRealTimers(); });

describe("confirmations", () => {
  it("runs at once when nothing needs asking, and refuses changes when read-only", async () => {
    trust("auto");
    await expect(confirmed(ctx(), "write_studio_translations", display, async () => "done")).resolves.toBe("done");
    expect(pending()).toEqual([]);
    trust("read_only");
    const execute = vi.fn();
    await expect(confirmed(ctx(), "write_studio_translations", display, execute)).rejects.toMatchObject({ code: "read_only" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("asks, runs on yes and returns the result; flashes the taskbar", async () => {
    const execute = vi.fn(async () => ({ revision: 5 }));
    const call = confirmed(ctx(), "write_studio_translations", display, execute);
    await waitForRequest();
    expect(attention).toHaveBeenCalledOnce();
    expect(pending()[0]).toMatchObject({ client: "claude-code", action: "translation", group: "studio_translation", sessionGrant: true, destructive: false });
    expect(execute).not.toHaveBeenCalled();
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true);
    await expect(call).resolves.toEqual({ revision: 5 });
  });

  it("declines without running, and remembers a connection allowance for its group only", async () => {
    const execute = vi.fn(async () => 1);
    const declined = confirmed(ctx(), "write_studio_translations", display, execute);
    await waitForRequest();
    useExternalConfirmationsStore.getState().decide(pending()[0].id, false);
    await expect(declined).rejects.toMatchObject({ code: "declined_by_user" });
    expect(execute).not.toHaveBeenCalled();

    const allowed = confirmed(ctx(), "create_studio_translation_track", display, execute);
    await waitForRequest();
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true, { allowSession: true });
    await allowed;
    // Same group, same connection: no question.
    await expect(confirmed(ctx(), "write_studio_translations", display, async () => "silent")).resolves.toBe("silent");
    // Another group, or another connection: asked again.
    void confirmed(ctx(), "import_studio_subtitles", { ...display, action: "import", summary: "import" }, execute).catch(() => undefined);
    void confirmed(ctx("s2"), "write_studio_translations", display, execute).catch(() => undefined);
    await vi.waitFor(() => expect(pending()).toHaveLength(2));
    // A connection that ends loses its allowance and its open requests.
    forgetEndedSessions(new Set(["s2"]));
    expect(useExternalConfirmationsStore.getState().grants.s1).toBeUndefined();
    expect(pending().map(item => item.sessionId)).toEqual(["s2"]);
  });

  it("asks for destructive calls even in auto, without an allowance", async () => {
    trust("auto");
    const call = confirmed(ctx(), "export_studio_document", { ...display, action: "export", summary: "export_source", warning: "overwrite" }, async () => "written", { destructive: true });
    await waitForRequest();
    expect(pending()[0]).toMatchObject({ destructive: true, sessionGrant: false, warning: "overwrite" });
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true, { allowSession: true });
    await expect(call).resolves.toBe("written");
    expect(useExternalConfirmationsStore.getState().grants).toEqual({});
  });

  it("answers confirmation_pending after the wait, runs on a later yes and hands the result to get_confirmation_result", async () => {
    let id = "";
    const call = confirmed(ctx(), "write_studio_translations", display, async () => ({ written: 2 }), { waitMs: 20 }).catch(error => { id = error.detail.confirmationId; return error; });
    const error = await call;
    expect(error).toMatchObject({ code: "confirmation_pending" });
    expect(id).toMatch(/^confirm-/);
    await expect(awaitConfirmation(ctx("other"), id, 10)).rejects.toMatchObject({ code: "confirmation_not_found" });
    await expect(awaitConfirmation(ctx(), id, 10)).rejects.toMatchObject({ code: "confirmation_pending" });
    const waiting = awaitConfirmation(ctx(), id, 1000);
    useExternalConfirmationsStore.getState().decide(id, true);
    await expect(waiting).resolves.toMatchObject({ confirmationId: id, status: "completed", result: { written: 2 } });
  });

  it("expires undecided requests and withdraws them when the agent cancels", async () => {
    vi.useFakeTimers();
    const first = confirmed(ctx(), "write_studio_translations", display, async () => 1, { waitMs: 5 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    const { detail } = await first;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await expect(awaitConfirmation(ctx(), detail.confirmationId, 5)).rejects.toMatchObject({ code: "confirmation_expired" });
    vi.useRealTimers();

    const controller = new AbortController();
    const cancelled = confirmed(ctx("s1", controller.signal), "write_studio_translations", display, async () => 1);
    await waitForRequest();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(pending()).toEqual([]);
  });

  it("shows a path as its last part over the whole path", () => {
    expect(pathItem("C:\\Media\\Show\\Episode 01.srt")).toEqual({ text: "Episode 01.srt", detail: "C:\\Media\\Show\\Episode 01.srt" });
    expect(pathItem("/Users/me/Subs/")).toEqual({ text: "Subs", detail: "/Users/me/Subs/" });
  });

  it("reports a failing action through the request", async () => {
    const call = confirmed(ctx(), "write_studio_translations", display, async () => { throw Object.assign(new Error("x"), {}); });
    await waitForRequest();
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true);
    await expect(call).rejects.toMatchObject({ code: "tool_failed" });
  });
});
