import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedCleanupRetryQueue } from "./boundedCleanupRetryQueue";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded cleanup retry queue", () => {
  it("preserves the existing latest-expiry behavior by default", async () => {
    const queue = new BoundedCleanupRetryQueue<string>({
      retryDelaysMs: [500],
      ttlMs: 1_000,
      attemptTimeoutMs: 100,
      operation: async () => false,
    });

    await queue.queue("key", "first", 1_200);
    await queue.queue("key", "second", 2_000);
    await vi.advanceTimersByTimeAsync(201);

    expect(queue.size).toBe(1);
    queue.reset();
  });

  it("bounds a hung attempt by the remaining authoritative TTL", async () => {
    const queue = new BoundedCleanupRetryQueue<string>({
      retryDelaysMs: [100],
      ttlMs: 1_000,
      attemptTimeoutMs: 500,
      operation: () => new Promise<boolean>(() => undefined),
    });

    void queue.queue("key", "request", 1_020);
    await vi.advanceTimersByTimeAsync(20);

    expect(queue.size).toBe(0);
    queue.reset();
  });

  it.each([[[]], [[0]]])(
    "rejects retry configuration %j that could spin forever",
    (retryDelaysMs) => {
      expect(
        () =>
          new BoundedCleanupRetryQueue<string>({
            retryDelaysMs,
            ttlMs: 1_000,
            attemptTimeoutMs: 100,
            operation: async () => true,
          }),
      ).toThrow(/retry delays/u);
    },
  );
});
