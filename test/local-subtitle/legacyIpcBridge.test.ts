import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSafeLegacyIpcBridge,
  type SafeLegacyIpcBridge,
  type SafeLegacyIpcListener,
} from "../../electron/preload/legacy-ipc-bridge";

describe("safe legacy IPC bridge", () => {
  it("types the renderer event as unavailable and all commands as narrow returns", () => {
    expectTypeOf<Parameters<SafeLegacyIpcListener>[0]>().toEqualTypeOf<
      undefined
    >();
    expectTypeOf<ReturnType<SafeLegacyIpcBridge["on"]>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<SafeLegacyIpcBridge["off"]>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<SafeLegacyIpcBridge["send"]>>().toEqualTypeOf<void>();
  });

  it("drops the raw Electron event and removes the exact wrapped listener", () => {
    const transport = createTransport();
    const bridge = createSafeLegacyIpcBridge({
      ipcRenderer: transport,
      assertListenChannelAllowed: vi.fn(),
      assertCommandChannelAllowed: vi.fn(),
    });
    const listener = vi.fn();

    expect(bridge.on("legacy:event", listener)).toBeUndefined();
    expect(bridge.on("legacy:event", listener)).toBeUndefined();
    expect(transport.on).toHaveBeenCalledOnce();
    const wrapped = transport.on.mock.calls[0]?.[1];
    expect(wrapped).toBeTypeOf("function");

    const dangerousEvent = {
      sender: { sendSync: vi.fn() },
    };
    wrapped?.(dangerousEvent as never, { value: 1 });
    expect(listener).toHaveBeenCalledWith(undefined, { value: 1 });
    expect(listener.mock.calls[0]?.[0]).not.toBe(dangerousEvent);

    expect(bridge.off("legacy:event", listener)).toBeUndefined();
    expect(bridge.off("legacy:event", listener)).toBeUndefined();
    expect(transport.off).toHaveBeenCalledOnce();
    expect(transport.off).toHaveBeenCalledWith("legacy:event", wrapped);
  });

  it("applies exact guards and never returns the underlying transport", async () => {
    const transport = createTransport();
    const assertListenChannelAllowed = vi.fn((channel: string) => {
      if (channel.startsWith("local-subtitle:")) throw new Error("blocked");
    });
    const assertCommandChannelAllowed = vi.fn((channel: string) => {
      if (channel.startsWith("local-subtitle:")) throw new Error("blocked");
    });
    const bridge = createSafeLegacyIpcBridge({
      ipcRenderer: transport,
      assertListenChannelAllowed,
      assertCommandChannelAllowed,
    });

    expect(() => bridge.on("local-subtitle:task-event", vi.fn())).toThrow(
      "blocked",
    );
    expect(() => bridge.send("local-subtitle:enqueue", {})).toThrow("blocked");
    await expect(
      bridge.invoke("local-subtitle:get-session-snapshot", {}),
    ).rejects.toThrow("blocked");
    expect(transport.on).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.invoke).not.toHaveBeenCalled();

    expect(bridge.send("legacy:send", { value: 1 })).toBeUndefined();
    await expect(bridge.invoke("legacy:invoke", { value: 2 })).resolves.toEqual(
      { ok: true },
    );
  });
});

function createTransport() {
  return {
    on: vi.fn(() => ({ dangerous: true })),
    off: vi.fn(() => ({ dangerous: true })),
    send: vi.fn(() => ({ dangerous: true })),
    invoke: vi.fn(async () => ({ ok: true })),
  } as never;
}
