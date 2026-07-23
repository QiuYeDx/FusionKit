import { describe, expect, it, vi } from "vitest";
import {
  fenceLocalSubtitleOverwriteDirectory,
  localSubtitleOverwriteDirectoryKey,
  releaseLocalSubtitleOverwriteDirectoryFence,
  snapshotLocalSubtitleOverwriteDirectoryIdentity,
  withLocalSubtitleOverwriteDirectory,
} from "../../electron/main/local-subtitle/overwrite-directory-coordinator";

describe("local subtitle overwrite directory identity", () => {
  it("snapshots exact own data fields and derives a stable tuple key", () => {
    const identity = { dev: 1, ino: 2, birthtimeMs: 3.5 };
    const snapshot = snapshotLocalSubtitleOverwriteDirectoryIdentity(identity);

    expect(snapshot).toEqual(identity);
    expect(snapshot).not.toBe(identity);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(localSubtitleOverwriteDirectoryKey(identity)).toBe("[1,2,3.5]");
    expect(localSubtitleOverwriteDirectoryKey({ ...identity })).toBe("[1,2,3.5]");
    expect(localSubtitleOverwriteDirectoryKey({ ...identity, ino: 4 })).not.toBe(
      "[1,2,3.5]",
    );
  });

  it.each([
    ["negative dev", { dev: -1, ino: 2, birthtimeMs: 3 }],
    ["negative zero dev", { dev: -0, ino: 2, birthtimeMs: 3 }],
    ["unsafe inode", { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1, birthtimeMs: 3 }],
    ["NaN birthtime", { dev: 1, ino: 2, birthtimeMs: Number.NaN }],
    ["infinite birthtime", { dev: 1, ino: 2, birthtimeMs: Number.POSITIVE_INFINITY }],
    ["negative zero birthtime", { dev: 1, ino: 2, birthtimeMs: -0 }],
    ["extra field", { dev: 1, ino: 2, birthtimeMs: 3, path: "/private" }],
  ])("rejects %s", (_label, identity) => {
    expect(snapshotLocalSubtitleOverwriteDirectoryIdentity(identity)).toBeUndefined();
    expect(() => localSubtitleOverwriteDirectoryKey(identity)).toThrow(TypeError);
  });

  it("rejects accessors without invoking them", () => {
    const dev = vi.fn(() => 1);
    const identity = { ino: 2, birthtimeMs: 3 } as Record<string, unknown>;
    Object.defineProperty(identity, "dev", { enumerable: true, get: dev });

    expect(snapshotLocalSubtitleOverwriteDirectoryIdentity(identity)).toBeUndefined();
    expect(dev).not.toHaveBeenCalled();
  });

  it("rejects a Proxy without invoking reflection traps", () => {
    const ownKeys = vi.fn(() => {
      throw new Error("proxy trap must not run");
    });
    const identity = new Proxy(
      { dev: 1, ino: 2, birthtimeMs: 3 },
      { ownKeys },
    );

    expect(snapshotLocalSubtitleOverwriteDirectoryIdentity(identity)).toBeUndefined();
    expect(ownKeys).not.toHaveBeenCalled();
  });
});

describe("local subtitle overwrite directory coordination", () => {
  it("serializes operations in FIFO order and releases the tail after failure", async () => {
    const key = localSubtitleOverwriteDirectoryKey({
      dev: 101,
      ino: 102,
      birthtimeMs: 103,
    });
    const gate = deferred<void>();
    const events: string[] = [];
    const first = withLocalSubtitleOverwriteDirectory(key, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = withLocalSubtitleOverwriteDirectory(key, () => {
      events.push("second");
      throw new Error("injected operation failure");
    });
    const third = withLocalSubtitleOverwriteDirectory(key, () => {
      events.push("third");
      return "completed";
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    gate.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("injected operation failure");
    await expect(third).resolves.toBe("completed");
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("admits only the matching recovery while preserving independent fences", async () => {
    const key = localSubtitleOverwriteDirectoryKey({
      dev: 201,
      ino: 202,
      birthtimeMs: 203,
    });
    fenceLocalSubtitleOverwriteDirectory(key, "recovery-a");
    fenceLocalSubtitleOverwriteDirectory(key, "recovery-b");

    try {
      await expect(
        withLocalSubtitleOverwriteDirectory(key, () => undefined),
      ).rejects.toThrow("pending overwrite recovery");
      await expect(
        withLocalSubtitleOverwriteDirectory(
          key,
          () => undefined,
          { recoveryId: "recovery-a" },
        ),
      ).rejects.toThrow("pending overwrite recovery");

      releaseLocalSubtitleOverwriteDirectoryFence(key, "recovery-b");
      await expect(
        withLocalSubtitleOverwriteDirectory(
          key,
          () => "recovery-a",
          { recoveryId: "recovery-a" },
        ),
      ).resolves.toBe("recovery-a");
      await expect(
        withLocalSubtitleOverwriteDirectory(key, () => undefined),
      ).rejects.toThrow("pending overwrite recovery");

      releaseLocalSubtitleOverwriteDirectoryFence(key, "recovery-a");
      await expect(
        withLocalSubtitleOverwriteDirectory(key, () => "released"),
      ).resolves.toBe("released");
    } finally {
      releaseLocalSubtitleOverwriteDirectoryFence(key, "recovery-a");
      releaseLocalSubtitleOverwriteDirectoryFence(key, "recovery-b");
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
