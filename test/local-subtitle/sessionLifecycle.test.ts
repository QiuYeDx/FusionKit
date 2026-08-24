import { describe, expect, it, vi } from "vitest";
import type { LocalSubtitleMainRuntimeTarget } from "../../electron/main/local-subtitle/main-runtime";
import { LocalSubtitleSessionLifecycle } from "../../electron/main/local-subtitle/session-lifecycle";

const OWNER = Object.freeze({
  webContentsId: 91,
  ownerSessionId: "session-lifecycle-owner",
});

describe("local subtitle session lifecycle", () => {
  it("releases Job first and Session Registry last even after a failure", () => {
    const order: string[] = [];
    const failure = new Error("job release failed");
    const lifecycle = new LocalSubtitleSessionLifecycle(
      target("job", order, { releaseFailure: failure }),
      target("model", order),
      target("media", order),
      target("server", order),
      target("registry", order),
    );

    expect(() => lifecycle.releaseOwner(OWNER)).toThrow(failure);
    expect(order).toEqual([
      "job:release",
      "media:release",
      "server:release",
      "model:release",
      "registry:release",
    ]);
  });

  it("quiesces managers before cleanup and closes the Registry last", async () => {
    const order: string[] = [];
    const job = deferred();
    const model = deferred();
    const jobTarget = target("job", order, { shutdown: () => job.promise });
    const modelTarget = target("model", order, { shutdown: () => model.promise });
    const media = target("media", order);
    const server = target("server", order);
    const registry = target("registry", order);
    const lifecycle = new LocalSubtitleSessionLifecycle(
      jobTarget,
      modelTarget,
      media,
      server,
      registry,
    );

    const first = lifecycle.shutdown("update");
    const second = lifecycle.shutdown("fatal");
    expect(second).toBe(first);
    expect(order).toEqual(["job:update", "model:update"]);

    job.resolve();
    await Promise.resolve();
    expect(order).toEqual(["job:update", "model:update"]);
    model.resolve();
    await first;

    expect(order).toEqual([
      "job:update",
      "model:update",
      "media:update",
      "server:update",
      "registry:update",
    ]);
    for (const candidate of [jobTarget, modelTarget, media, server, registry]) {
      expect(candidate.shutdown).toHaveBeenCalledOnce();
    }
  });

  it("continues later cleanup phases and rethrows the first failure", async () => {
    const order: string[] = [];
    const failure = new Error("job shutdown failed");
    const lifecycle = new LocalSubtitleSessionLifecycle(
      target("job", order, { shutdownFailure: failure }),
      target("model", order),
      target("media", order),
      target("server", order),
      target("registry", order),
    );

    await expect(lifecycle.shutdown("app_quit")).rejects.toThrow(failure);
    expect(order).toEqual([
      "job:app_quit",
      "model:app_quit",
      "media:app_quit",
      "server:app_quit",
      "registry:app_quit",
    ]);
  });

  it("caches shutdown before a manager synchronously reenters", async () => {
    const order: string[] = [];
    let lifecycle!: LocalSubtitleSessionLifecycle;
    let reentered: Promise<void> | undefined;
    const job = target("job", order, {
      shutdown: () => {
        reentered = lifecycle.shutdown("fatal");
        return Promise.resolve();
      },
    });
    lifecycle = new LocalSubtitleSessionLifecycle(
      job,
      target("model", order),
      target("media", order),
      target("server", order),
      target("registry", order),
    );

    const shutdown = lifecycle.shutdown("app_quit");

    expect(reentered).toBe(shutdown);
    await shutdown;
    expect(job.shutdown).toHaveBeenCalledOnce();
  });

  it("retries overwrite recovery after managers quiesce and before cleanup", async () => {
    const order: string[] = [];
    const lifecycle = new LocalSubtitleSessionLifecycle(
      target("job", order),
      target("model", order),
      target("media", order),
      target("server", order),
      target("registry", order),
      target("recovery", order),
    );

    lifecycle.releaseOwner(OWNER);
    expect(order).toEqual([
      "job:release",
      "recovery:release",
      "media:release",
      "server:release",
      "model:release",
      "registry:release",
    ]);

    order.length = 0;
    await lifecycle.shutdown("app_quit");
    expect(order).toEqual([
      "job:app_quit",
      "model:app_quit",
      "recovery:app_quit",
      "media:app_quit",
      "server:app_quit",
      "registry:app_quit",
    ]);
  });

  it("continues cleanup and Registry shutdown after overwrite recovery fails", async () => {
    const order: string[] = [];
    const failure = new Error("overwrite recovery pending");
    const lifecycle = new LocalSubtitleSessionLifecycle(
      target("job", order),
      target("model", order),
      target("media", order),
      target("server", order),
      target("registry", order),
      target("recovery", order, { shutdownFailure: failure }),
    );

    await expect(lifecycle.shutdown("update")).rejects.toThrow(failure);
    expect(order).toEqual([
      "job:update",
      "model:update",
      "recovery:update",
      "media:update",
      "server:update",
      "registry:update",
    ]);
  });
});

function target(
  name: string,
  order: string[],
  options: {
    readonly releaseFailure?: Error;
    readonly shutdownFailure?: Error;
    readonly shutdown?: () => Promise<void>;
  } = {},
): LocalSubtitleMainRuntimeTarget & {
  readonly shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    releaseOwner: () => {
      order.push(`${name}:release`);
      if (options.releaseFailure) throw options.releaseFailure;
    },
    shutdown: vi.fn((reason: "app_quit" | "update" | "fatal") => {
      order.push(`${name}:${reason}`);
      if (options.shutdownFailure) return Promise.reject(options.shutdownFailure);
      return options.shutdown?.() ?? Promise.resolve();
    }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
