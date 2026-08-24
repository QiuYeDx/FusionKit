import { describe, expect, it, vi } from "vitest";
import {
  LocalSubtitleServerAppLifecycle,
  LocalSubtitleServerAppLifecycleError,
  type LocalSubtitleBeforeQuitEvent,
  type LocalSubtitleBeforeQuitHost,
} from "../../electron/main/local-subtitle/server-app-lifecycle";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function createHost(): LocalSubtitleBeforeQuitHost & {
  readonly listeners: Array<(event: LocalSubtitleBeforeQuitEvent) => void>;
  readonly quit: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(event: LocalSubtitleBeforeQuitEvent) => void> = [];
  return {
    listeners,
    onBeforeQuit: (listener) => listeners.push(listener),
    quit: vi.fn(),
  };
}

describe("local subtitle server app lifecycle", () => {
  it("installs once, fences quit, and retries after shutdown", async () => {
    const shutdown = deferred();
    const target = { shutdown: vi.fn(() => shutdown.promise) };
    const host = createHost();
    const lifecycle = new LocalSubtitleServerAppLifecycle(target);
    lifecycle.install(host);
    lifecycle.install(host);

    expect(host.listeners).toHaveLength(1);
    const event = { preventDefault: vi.fn() };
    host.listeners[0]!(event);
    host.listeners[0]!(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(target.shutdown).toHaveBeenCalledTimes(1);
    expect(target.shutdown).toHaveBeenCalledWith("app_quit");
    expect(host.quit).not.toHaveBeenCalled();

    shutdown.resolve();
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));

    const retriedEvent = { preventDefault: vi.fn() };
    host.listeners[0]!(retriedEvent);
    expect(retriedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("awaits the shared shutdown before allowing update installation", async () => {
    const shutdown = deferred();
    const target = { shutdown: vi.fn(() => shutdown.promise) };
    const host = createHost();
    const lifecycle = new LocalSubtitleServerAppLifecycle(target);
    lifecycle.install(host);

    const preparing = lifecycle.prepareUpdateInstall();
    expect(target.shutdown).toHaveBeenCalledWith("update");
    shutdown.resolve();
    await preparing;

    const event = { preventDefault: vi.fn() };
    host.listeners[0]!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(host.quit).not.toHaveBeenCalled();
  });

  it("caches shutdown before the target synchronously reenters", async () => {
    let lifecycle!: LocalSubtitleServerAppLifecycle;
    let reentered: Promise<void> | undefined;
    const target = {
      shutdown: vi.fn(() => {
        reentered = lifecycle.shutdown("fatal");
        return Promise.resolve();
      }),
    };
    lifecycle = new LocalSubtitleServerAppLifecycle(target);

    const shutdown = lifecycle.shutdown("app_quit");

    await Promise.all([shutdown, reentered]);
    expect(target.shutdown).toHaveBeenCalledOnce();
  });

  it("retries an app quit even when bounded shutdown reports a failure", async () => {
    const host = createHost();
    const shutdown = vi.fn(() => Promise.reject(new Error("shutdown failed")));
    const lifecycle = new LocalSubtitleServerAppLifecycle({ shutdown });
    lifecycle.install(host);
    const event = { preventDefault: vi.fn() };

    host.listeners[0]!(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledOnce());
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("allows a later update attempt after a transient shutdown failure", async () => {
    const shutdown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const lifecycle = new LocalSubtitleServerAppLifecycle({ shutdown });

    await expect(lifecycle.prepareUpdateInstall()).rejects.toThrow(
      "transient failure",
    );
    await expect(lifecycle.prepareUpdateInstall()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("keeps observing a timed-out shutdown and reuses its later success", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred();
      const shutdown = vi.fn(() => pending.promise);
      const lifecycle = new LocalSubtitleServerAppLifecycle(
        { shutdown },
        { shutdownTimeoutMs: 25 },
      );
      const first = lifecycle.shutdown("update");
      const rejection = expect(first).rejects.toBeInstanceOf(
        LocalSubtitleServerAppLifecycleError,
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      pending.resolve();
      await Promise.resolve();
      await expect(lifecycle.shutdown("update")).resolves.toBeUndefined();
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a shutdown that never settles", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new LocalSubtitleServerAppLifecycle(
        { shutdown: vi.fn(() => new Promise<void>(() => undefined)) },
        { shutdownTimeoutMs: 25 },
      );
      const result = lifecycle.shutdown("fatal");
      const rejection = expect(result).rejects.toBeInstanceOf(
        LocalSubtitleServerAppLifecycleError,
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
