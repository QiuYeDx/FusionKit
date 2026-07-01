import { describe, expect, it } from "vitest";
import {
  TextTranslationRequestScheduler,
  TextTranslationRequestSchedulerCancelledError,
  type ReleaseTextTranslationRequestSlot,
} from "../../../electron/main/text-translation/request-scheduler";

describe("TextTranslationRequestScheduler", () => {
  it("enforces global and per-task limits while letting other tasks use free slots", async () => {
    const scheduler = new TextTranslationRequestScheduler({
      globalLimit: 3,
      parallelTaskLimit: 2,
    });

    const releaseA1 = await scheduler.acquire({ taskId: "task_a" });
    const releaseA2 = await scheduler.acquire({ taskId: "task_a" });
    const pendingA3 = scheduler.acquire({ taskId: "task_a" });
    const releaseB1 = await scheduler.acquire({ taskId: "task_b" });

    expect(await promiseState(pendingA3)).toBe("pending");
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 3,
      activeByTask: { task_a: 2, task_b: 1 },
      waitingByTask: { task_a: 1 },
    });

    releaseA1();
    const releaseA3 = await pendingA3;
    expect(scheduler.snapshot().activeByTask).toMatchObject({
      task_a: 2,
      task_b: 1,
    });

    releaseA2();
    releaseA3();
    releaseB1();
    expect(scheduler.snapshot().activeCount).toBe(0);
  });

  it("uses task round-robin fairness when a slot is released", async () => {
    const scheduler = new TextTranslationRequestScheduler({
      globalLimit: 2,
      parallelTaskLimit: 2,
    });

    const releaseA1 = await scheduler.acquire({ taskId: "task_a" });
    const releaseA2 = await scheduler.acquire({ taskId: "task_a" });
    const pendingA3 = scheduler.acquire({ taskId: "task_a" });
    const pendingB1 = scheduler.acquire({ taskId: "task_b" });

    releaseA1();

    const releaseB1 = await pendingB1;
    expect(await promiseState(pendingA3)).toBe("pending");
    expect(scheduler.snapshot().activeByTask).toEqual({
      task_a: 1,
      task_b: 1,
    });

    releaseA2();
    const releaseA3 = await pendingA3;

    releaseA3();
    releaseB1();
  });

  it("limits sequential-context tasks to one active request per task", async () => {
    const scheduler = new TextTranslationRequestScheduler({
      globalLimit: 5,
      sequentialTaskLimit: 1,
    });

    const releaseA1 = await scheduler.acquire({
      taskId: "task_a",
      executionMode: "sequential_context",
    });
    const pendingA2 = scheduler.acquire({
      taskId: "task_a",
      executionMode: "sequential_context",
    });
    const releaseB1 = await scheduler.acquire({
      taskId: "task_b",
      executionMode: "sequential_context",
    });

    expect(await promiseState(pendingA2)).toBe("pending");

    releaseA1();
    const releaseA2 = await pendingA2;

    releaseA2();
    releaseB1();
  });

  it("cancels only waiting requests for a task", async () => {
    const scheduler = new TextTranslationRequestScheduler({
      globalLimit: 1,
      parallelTaskLimit: 1,
    });

    const releaseA1 = await scheduler.acquire({ taskId: "task_a" });
    const pendingA2 = scheduler.acquire({ taskId: "task_a" });
    const pendingB1 = scheduler.acquire({ taskId: "task_b" });

    scheduler.cancelWaiting("task_a");
    await expect(pendingA2).rejects.toBeInstanceOf(
      TextTranslationRequestSchedulerCancelledError,
    );

    releaseA1();
    const releaseB1 = await pendingB1;
    expect(scheduler.snapshot().activeByTask).toEqual({ task_b: 1 });
    releaseB1();
  });

  it("supports AbortSignal cancellation for queued requests and idempotent release", async () => {
    const scheduler = new TextTranslationRequestScheduler({
      globalLimit: 1,
      parallelTaskLimit: 1,
    });

    const releaseA1 = await scheduler.acquire({ taskId: "task_a" });
    const controller = new AbortController();
    const pendingB1 = scheduler.acquire({
      taskId: "task_b",
      signal: controller.signal,
    });

    controller.abort();
    await expect(pendingB1).rejects.toBeInstanceOf(
      TextTranslationRequestSchedulerCancelledError,
    );

    releaseA1();
    releaseA1();
    expect(scheduler.snapshot().activeCount).toBe(0);
  });
});

async function promiseState<T>(promise: Promise<T>): Promise<"pending" | "settled"> {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<typeof marker>((resolve) => setTimeout(resolve, 0, marker)),
  ]);

  return result === marker ? "pending" : "settled";
}
