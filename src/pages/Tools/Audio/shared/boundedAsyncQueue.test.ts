import { describe, expect, it, vi } from "vitest";
import { BoundedAsyncQueue } from "./boundedAsyncQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BoundedAsyncQueue", () => {
  it("distinguishes queued work from the one in-flight cancellation", async () => {
    const first = deferred<void>();
    const firstCancel = vi.fn(async () => undefined);
    const secondRun = vi.fn(async () => undefined);
    const secondCancel = vi.fn(async () => undefined);
    const dropped: string[] = [];
    const queue = new BoundedAsyncQueue({
      maxPendingItems: 3,
      maxPendingBytes: 100,
      maxQueueAgeMs: 1000,
      onDrop: (task) => dropped.push(task.id),
    });

    queue.enqueue({
      id: "first",
      sizeBytes: 10,
      run: () => first.promise,
      cancel: firstCancel,
    });
    queue.enqueue({
      id: "second",
      sizeBytes: 10,
      run: secondRun,
      cancel: secondCancel,
    });
    expect(queue.getSnapshot()).toMatchObject({
      inFlightId: "first",
      queuedIds: ["second"],
      pendingBytes: 20,
    });

    await queue.abort();
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
    expect(dropped).toEqual(["second"]);
    first.resolve();
    await first.promise;
  });

  it("rejects work when count or byte backlog limits are reached", () => {
    const never = new Promise<void>(() => undefined);
    const drops: string[] = [];
    const queue = new BoundedAsyncQueue({
      maxPendingItems: 2,
      maxPendingBytes: 15,
      maxQueueAgeMs: 1000,
      onDrop: (task, reason) => drops.push(`${task.id}:${reason}`),
    });
    const task = (id: string, sizeBytes: number) => ({
      id,
      sizeBytes,
      run: () => never,
    });

    expect(queue.enqueue(task("first", 5))).toBeNull();
    expect(queue.enqueue(task("second", 5))).toBeNull();
    expect(queue.enqueue(task("count", 1))).toBe("backlog_limit");

    const byteQueue = new BoundedAsyncQueue({
      maxPendingItems: 4,
      maxPendingBytes: 5,
      maxQueueAgeMs: 1000,
      onDrop: (queuedTask, reason) => drops.push(`${queuedTask.id}:${reason}`),
    });
    expect(byteQueue.enqueue(task("bytes", 6))).toBe("byte_limit");
    expect(drops).toEqual([
      "count:backlog_limit",
      "bytes:byte_limit",
    ]);
  });

  it("drops stale queued work without starting it", async () => {
    let now = 0;
    const first = deferred<void>();
    const staleRun = vi.fn(async () => undefined);
    const drops: string[] = [];
    const queue = new BoundedAsyncQueue({
      maxPendingItems: 3,
      maxPendingBytes: 100,
      maxQueueAgeMs: 10,
      now: () => now,
      onDrop: (task, reason) => drops.push(`${task.id}:${reason}`),
    });
    queue.enqueue({ id: "first", sizeBytes: 1, run: () => first.promise });
    queue.enqueue({ id: "stale", sizeBytes: 1, run: staleRun });
    now = 11;
    first.resolve();
    await first.promise;
    await vi.waitFor(() => expect(drops).toContain("stale:stale"));
    expect(staleRun).not.toHaveBeenCalled();
  });
});
