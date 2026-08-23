import type { SubtitleTranslatorTask } from "@/type/subtitle";

export interface SubtitleTranslatorDisplayTaskQueues {
  readonly pendingTaskQueue: readonly SubtitleTranslatorTask[];
  readonly waitingTaskQueue: readonly SubtitleTranslatorTask[];
  readonly notStartedTaskQueue: readonly SubtitleTranslatorTask[];
  readonly failedTaskQueue: readonly SubtitleTranslatorTask[];
  readonly resolvedTaskQueue: readonly SubtitleTranslatorTask[];
}

/**
 * Group rows by user-facing urgency without re-sorting any authoritative queue.
 * Each input array already carries its own FIFO order from the queue service.
 */
export function orderSubtitleTranslatorTasksForDisplay(
  queues: SubtitleTranslatorDisplayTaskQueues,
): SubtitleTranslatorTask[] {
  return [
    ...queues.pendingTaskQueue,
    ...queues.waitingTaskQueue,
    ...queues.notStartedTaskQueue,
    ...queues.failedTaskQueue,
    ...queues.resolvedTaskQueue,
  ];
}
