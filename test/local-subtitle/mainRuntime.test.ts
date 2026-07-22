import { describe, expect, it, vi } from "vitest";
import {
  LocalSubtitleMainRuntime,
  type LocalSubtitleMainRuntimeMediaTarget,
  type LocalSubtitleMainRuntimeTarget,
  type LocalSubtitleMainRuntimeServerTarget,
} from "../../electron/main/local-subtitle/main-runtime";

const OWNER = Object.freeze({
  webContentsId: 7,
  ownerSessionId: "12345678-1234-4123-8123-123456789abc",
});

describe("local subtitle main runtime", () => {
  it("synchronously fences media and server owner state", () => {
    const order: string[] = [];
    const runtime = createRuntime({
      mediaRelease: () => order.push("media"),
      serverRelease: () => order.push("server"),
    });

    runtime.releaseOwner(OWNER);

    expect(order).toEqual(["media", "server"]);
  });

  it("still fences the server if media owner release throws", () => {
    const serverRelease = vi.fn();
    const runtime = createRuntime({
      mediaRelease: () => {
        throw new Error("media fence failed");
      },
      serverRelease,
    });

    expect(() => runtime.releaseOwner(OWNER)).toThrow("media fence failed");
    expect(serverRelease).toHaveBeenCalledWith(OWNER);
  });

  it("fences every additional target and rethrows the first release failure", () => {
    const order: string[] = [];
    const firstFailure = new Error("media fence failed");
    const runtime = createRuntime({
      mediaRelease: () => {
        order.push("media");
        throw firstFailure;
      },
      serverRelease: () => order.push("server"),
      additionalTargets: [
        {
          releaseOwner: () => order.push("model"),
          shutdown: () => Promise.resolve(),
        },
      ],
    });

    expect(() => runtime.releaseOwner(OWNER)).toThrow(firstFailure);
    expect(order).toEqual(["media", "server", "model"]);
  });

  it("shares composite shutdown and waits for both targets", async () => {
    let finishMedia!: () => void;
    let finishServer!: () => void;
    const mediaPending = new Promise<void>((resolve) => {
      finishMedia = resolve;
    });
    const serverPending = new Promise<void>((resolve) => {
      finishServer = resolve;
    });
    const mediaShutdown = vi.fn(() => mediaPending);
    const serverShutdown = vi.fn(() => serverPending);
    const runtime = createRuntime({ mediaShutdown, serverShutdown });

    const first = runtime.shutdown("update");
    const second = runtime.shutdown("app_quit");
    expect(first).toBe(second);
    finishMedia();
    await Promise.resolve();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishServer();
    await first;

    expect(mediaShutdown).toHaveBeenCalledOnce();
    expect(serverShutdown).toHaveBeenCalledOnce();
    expect(mediaShutdown).toHaveBeenCalledWith("update");
    expect(serverShutdown).toHaveBeenCalledWith("update");
    await expect(runtime.shutdown("fatal")).resolves.toBeUndefined();
  });

  it("allows an explicit retry after composite shutdown fails", async () => {
    const mediaShutdown = vi
      .fn<(reason: "app_quit" | "update" | "fatal") => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const serverShutdown = vi.fn(() => Promise.resolve());
    const runtime = createRuntime({ mediaShutdown, serverShutdown });

    await expect(runtime.shutdown("update")).rejects.toThrow("cleanup failed");
    await expect(runtime.shutdown("update")).resolves.toBeUndefined();
    expect(mediaShutdown).toHaveBeenCalledTimes(2);
    expect(serverShutdown).toHaveBeenCalledTimes(2);
  });

  it("starts both shutdown targets when one throws synchronously", async () => {
    let finishServer!: () => void;
    const serverPending = new Promise<void>((resolve) => {
      finishServer = resolve;
    });
    const serverShutdown = vi.fn(() => serverPending);
    const runtime = createRuntime({
      mediaShutdown: () => {
        throw new Error("synchronous media failure");
      },
      serverShutdown,
    });

    const shutdown = runtime.shutdown("fatal");
    let settled = false;
    void shutdown.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    finishServer();
    await expect(shutdown).rejects.toThrow(
      "synchronous media failure",
    );
    expect(serverShutdown).toHaveBeenCalledWith("fatal");
  });

  it("starts every additional shutdown target before reporting a failure", async () => {
    const modelShutdown = vi.fn(() => Promise.resolve());
    const runtime = createRuntime({
      mediaShutdown: () => Promise.reject(new Error("media cleanup failed")),
      additionalTargets: [
        {
          releaseOwner: () => undefined,
          shutdown: modelShutdown,
        },
      ],
    });

    await expect(runtime.shutdown("app_quit")).rejects.toThrow(
      "media cleanup failed",
    );
    expect(modelShutdown).toHaveBeenCalledWith("app_quit");
  });
});

function createRuntime(overrides: {
  readonly mediaRelease?: LocalSubtitleMainRuntimeMediaTarget["releaseOwner"];
  readonly serverRelease?: LocalSubtitleMainRuntimeServerTarget["releaseOwner"];
  readonly mediaShutdown?: LocalSubtitleMainRuntimeMediaTarget["shutdown"];
  readonly serverShutdown?: LocalSubtitleMainRuntimeServerTarget["shutdown"];
  readonly additionalTargets?: readonly LocalSubtitleMainRuntimeTarget[];
} = {}): LocalSubtitleMainRuntime {
  const media: LocalSubtitleMainRuntimeMediaTarget = {
    releaseOwner: overrides.mediaRelease ?? (() => undefined),
    shutdown: overrides.mediaShutdown ?? (() => Promise.resolve()),
  };
  const server: LocalSubtitleMainRuntimeServerTarget = {
    releaseOwner: overrides.serverRelease ?? (() => undefined),
    shutdown: overrides.serverShutdown ?? (() => Promise.resolve()),
  };
  return new LocalSubtitleMainRuntime(
    media,
    server,
    ...(overrides.additionalTargets ?? []),
  );
}
