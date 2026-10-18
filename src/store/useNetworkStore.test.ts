import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkApi, NetworkSettingsSnapshot } from "@/network/contract";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    has: (key: string) => values.has(key),
  };
}

function fakeApi(snapshot: Partial<NetworkSettingsSnapshot> = {}) {
  let current: NetworkSettingsSnapshot = {
    proxy: { mode: "system", host: "", port: "" }, downloadSource: "auto", stored: false, ...snapshot,
  };
  const api = {
    getSettings: vi.fn(async () => current),
    setSettings: vi.fn(async (patch: Parameters<NetworkApi["setSettings"]>[0]) => {
      current = { ...current, ...patch, proxy: { ...current.proxy, ...patch.proxy }, stored: true } as NetworkSettingsSnapshot;
      return current;
    }),
    test: vi.fn(),
  };
  return api;
}

async function loadStore(api: ReturnType<typeof fakeApi>, storage = memoryStorage()) {
  vi.resetModules();
  vi.stubGlobal("window", { network: api });
  vi.stubGlobal("localStorage", storage);
  return (await import("./useNetworkStore")).default;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("network settings store", () => {
  it("moves a proxy saved by an older version into the main process once", async () => {
    const api = fakeApi();
    const storage = memoryStorage({
      "fusionkit-proxy": JSON.stringify({ state: { proxyConfig: { mode: "custom", host: "127.0.0.1", port: "7890" } }, version: 0 }),
    });
    const store = await loadStore(api, storage);
    await store.getState().init();
    await store.getState().init();
    expect(api.setSettings).toHaveBeenCalledOnce();
    expect(api.setSettings).toHaveBeenCalledWith({ proxy: { mode: "custom", host: "127.0.0.1", port: "7890" } });
    expect(store.getState()).toMatchObject({ loaded: true, settings: { proxy: { mode: "custom", port: "7890" } } });
    expect(storage.has("fusionkit-proxy")).toBe(false);
  });

  it("trusts the main process once it has saved settings", async () => {
    const api = fakeApi({ stored: true, proxy: { mode: "none", host: "", port: "" }, downloadSource: "mirror" });
    const storage = memoryStorage({ proxyConfig: JSON.stringify({ mode: "custom", host: "1.2.3.4", port: "1" }) });
    const store = await loadStore(api, storage);
    await store.getState().init();
    expect(api.setSettings).not.toHaveBeenCalled();
    expect(store.getState().settings).toEqual({ proxy: { mode: "none", host: "", port: "" }, downloadSource: "mirror" });
    expect(storage.has("proxyConfig")).toBe(false);
  });

  it("sends a mode at once and a typed address after a pause", async () => {
    vi.useFakeTimers();
    const api = fakeApi({ stored: true });
    const store = await loadStore(api);
    await store.getState().init();
    store.getState().setProxyMode("custom");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.setSettings).toHaveBeenLastCalledWith({ proxy: { mode: "custom", host: "", port: "" }, downloadSource: "auto" });
    for (const value of ["1", "12", "127.0.0.1"]) store.getState().setProxyHost(value);
    store.getState().setProxyPort("78a90");
    await vi.advanceTimersByTimeAsync(399);
    expect(api.setSettings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.setSettings).toHaveBeenCalledTimes(2);
    expect(api.setSettings).toHaveBeenLastCalledWith({ proxy: { mode: "custom", host: "127.0.0.1", port: "7890" }, downloadSource: "auto" });
    store.getState().setDownloadSource("official");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ downloadSource: "official" }));
  });

  it("tells the page when the main process rejected a change", async () => {
    vi.useFakeTimers();
    const api = fakeApi({ stored: true });
    api.setSettings.mockRejectedValueOnce(new Error("invalid"));
    const store = await loadStore(api);
    await store.getState().init();
    store.getState().setDownloadSource("mirror");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().saveFailed).toBe(true);
  });

  it("sends a typed address at once when the page needs it (before a connection test)", async () => {
    vi.useFakeTimers();
    const api = fakeApi({ stored: true });
    let finish: (() => void) | undefined;
    const store = await loadStore(api);
    await store.getState().init();
    api.setSettings.mockImplementationOnce(async (patch) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { proxy: { mode: "custom", host: "", port: "" }, downloadSource: "auto", stored: true, ...patch } as NetworkSettingsSnapshot;
    });
    store.getState().setProxyMode("custom");
    store.getState().setProxyHost("127.0.0.1");
    store.getState().setProxyPort("7890");
    let flushed = false;
    const flush = store.getState().flush().then(() => { flushed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.setSettings).toHaveBeenCalledTimes(1);
    expect(api.setSettings).toHaveBeenLastCalledWith({ proxy: { mode: "custom", host: "127.0.0.1", port: "7890" }, downloadSource: "auto" });
    expect(flushed).toBe(false);
    finish!();
    await flush;
    expect(flushed).toBe(true);
    // Nothing is left waiting for the pause.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.setSettings).toHaveBeenCalledTimes(1);
  });
});
