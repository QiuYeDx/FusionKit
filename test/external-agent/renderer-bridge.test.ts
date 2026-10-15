import { describe, expect, it, vi } from "vitest";
import { RendererBridge, type BridgeTarget } from "../../electron/main/external-agent/renderer-bridge";

function window(id = 1) {
  const sent: { channel: string; payload: any }[] = [];
  const target: BridgeTarget & { destroyed: boolean } = { id, destroyed: false, send: (channel, payload) => { sent.push({ channel, payload }); }, isDestroyed() { return this.destroyed; } };
  return { target, sent };
}
const call = { sessionId: "s1", client: { name: "c", version: "1" }, tool: "get_fusionkit_status", arguments: {} };
const lastCall = (sent: { channel: string; payload: any }[]) => sent.filter(item => item.channel === "external-agent:call").at(-1)!.payload;

describe("renderer bridge", () => {
  it("delivers a call to the ready window and returns its answer", async () => {
    const { target, sent } = window();
    const bridge = new RendererBridge({ getTarget: () => target });
    bridge.markReady(1);
    const pending = bridge.call(call);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const { callId } = lastCall(sent);
    expect(lastCall(sent)).toMatchObject({ ...call, callId: expect.any(String) });
    expect(bridge.respond(1, { callId, result: { ok: true, data: { version: "1" } } })).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: { ok: true, data: { version: "1" } } });
  });

  it("waits for the window to become ready, then gives up", async () => {
    const { target, sent } = window();
    const bridge = new RendererBridge({ getTarget: () => target, readyWaitMs: 30 });
    await expect(bridge.call(call)).resolves.toEqual({ outcome: { ok: false, error: "fusionkit_window_unavailable" } });
    const later = bridge.call(call);
    bridge.markReady(1);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    bridge.respond(1, { callId: lastCall(sent).callId, result: { ok: true, data: 1 } });
    await expect(later).resolves.toEqual({ outcome: { ok: true, data: 1 } });
  });

  it("fails calls the window held when it navigates or closes, and needs a new ready", async () => {
    const { target, sent } = window();
    const bridge = new RendererBridge({ getTarget: () => target, readyWaitMs: 20 });
    bridge.markReady(1);
    const pending = bridge.call(call);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    bridge.invalidate(1);
    await expect(pending).resolves.toEqual({ outcome: { ok: false, error: "fusionkit_window_unavailable" } });
    await expect(bridge.call(call)).resolves.toEqual({ outcome: { ok: false, error: "fusionkit_window_unavailable" } });
  });

  it("tells the window to stop when the caller cancels, and times out", async () => {
    const { target, sent } = window();
    const bridge = new RendererBridge({ getTarget: () => target });
    bridge.markReady(1);
    const controller = new AbortController();
    const cancelled = bridge.call(call, controller.signal);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    controller.abort();
    await expect(cancelled).resolves.toEqual({ outcome: { ok: false, error: "cancelled" } });
    expect(sent.at(-1)).toEqual({ channel: "external-agent:cancel", payload: { callId: lastCall(sent).callId } });
    const slow = new RendererBridge({ getTarget: () => target, callTimeoutMs: 30 });
    slow.markReady(1);
    await expect(slow.call(call)).resolves.toEqual({ outcome: { ok: false, error: "tool_timeout" } });
    expect(sent.at(-1)?.channel).toBe("external-agent:cancel");
  });

  it("drops answers from another window, for unknown calls or of the wrong shape, and caps their size", async () => {
    const { target, sent } = window(7);
    const bridge = new RendererBridge({ getTarget: () => target });
    bridge.markReady(3); // not the main window: ignored
    expect(bridge.isReady).toBe(false);
    bridge.markReady(7);
    const pending = bridge.call(call);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const { callId } = lastCall(sent);
    expect(bridge.respond(3, { callId, result: { ok: true, data: 1 } })).toBe(false);
    expect(bridge.respond(7, { callId: "other", result: { ok: true, data: 1 } })).toBe(false);
    expect(bridge.respond(7, { callId, result: { ok: "yes" } })).toBe(false);
    expect(bridge.respond(7, { callId, result: { ok: true, data: "x".repeat(4 * 1024 * 1024 + 10) } })).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: { ok: false, error: "result_too_large" } });
  });

  it("returns the window's activity note when it has the record's shape, and drops it otherwise", async () => {
    const { target, sent } = window();
    const bridge = new RendererBridge({ getTarget: () => target });
    bridge.markReady(1);
    const noted = bridge.call(call);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const note = { approval: "session", result: { written: 3 }, target: { documentId: "d1", documentName: "Ep01.srt" } };
    expect(bridge.respond(1, { callId: lastCall(sent).callId, result: { ok: true, data: 1 }, activity: note })).toBe(true);
    await expect(noted).resolves.toEqual({ outcome: { ok: true, data: 1 }, activity: note });
    const malformed = bridge.call(call);
    await vi.waitFor(() => expect(sent.length).toBe(2));
    // An unknown approval or a field the record does not have: the note goes, the answer stays.
    expect(bridge.respond(1, { callId: lastCall(sent).callId, result: { ok: true, data: 2 }, activity: { approval: "trusted", sessionId: "other" } })).toBe(true);
    await expect(malformed).resolves.toEqual({ outcome: { ok: true, data: 2 } });
  });
});
