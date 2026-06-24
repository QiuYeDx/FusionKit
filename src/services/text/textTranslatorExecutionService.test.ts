import { describe, expect, it, vi } from "vitest";
import {
  TextTranslationEventSequenceGuard,
  subscribeTextTranslationEvents,
} from "@/services/text/textTranslatorExecutionService";
import { TEXT_TRANSLATION_EVENT_CHANNELS } from "@/type/textTranslationIpc";
import type { TextTranslationProgressEvent } from "@/type/textTranslationIpc";

describe("text translator execution service", () => {
  it("ignores duplicate and older event sequences per task", () => {
    const guard = new TextTranslationEventSequenceGuard();

    expect(guard.shouldAccept({ taskId: "task_a", sequence: 1 })).toBe(true);
    expect(guard.shouldAccept({ taskId: "task_a", sequence: 1 })).toBe(false);
    expect(guard.shouldAccept({ taskId: "task_a", sequence: 0 })).toBe(false);
    expect(guard.shouldAccept({ taskId: "task_b", sequence: 0 })).toBe(true);
    expect(guard.shouldAccept({ taskId: "task_a", sequence: 2 })).toBe(true);
    expect(guard.getLatestSequence("task_a")).toBe(2);

    guard.reset("task_a");
    expect(guard.getLatestSequence("task_a")).toBeUndefined();
    expect(guard.shouldAccept({ taskId: "task_a", sequence: 0 })).toBe(true);
  });

  it("dispatches only matching fresh namespaced events", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const progressHandler = vi.fn();
    const anyHandler = vi.fn();

    vi.stubGlobal("window", {
      ipcRenderer: {
        on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
          listeners.set(channel, listener);
        }),
        off: vi.fn((channel: string) => {
          listeners.delete(channel);
        }),
      },
    });

    const unsubscribe = subscribeTextTranslationEvents({
      progress: progressHandler,
      any: anyHandler,
    });

    const progressEvent: TextTranslationProgressEvent = {
      type: "progress",
      taskId: "task_001",
      sequence: 1,
      occurredAt: "2026-06-23T00:00:00.000Z",
      progress: {
        phase: "translating",
        completedFiles: 0,
        totalFiles: 1,
        completedSegments: 1,
        totalSegments: 2,
        activeSegmentIds: ["segment_002"],
        percentage: 50,
      },
    };

    listeners.get(TEXT_TRANSLATION_EVENT_CHANNELS.progress)?.(
      {},
      progressEvent,
    );
    listeners.get(TEXT_TRANSLATION_EVENT_CHANNELS.progress)?.(
      {},
      progressEvent,
    );
    listeners.get(TEXT_TRANSLATION_EVENT_CHANNELS.progress)?.(
      {},
      { ...progressEvent, type: "warning", sequence: 2 },
    );

    expect(progressHandler).toHaveBeenCalledTimes(1);
    expect(progressHandler).toHaveBeenCalledWith(progressEvent);
    expect(anyHandler).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
