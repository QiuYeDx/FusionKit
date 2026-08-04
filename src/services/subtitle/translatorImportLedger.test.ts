import { describe, expect, it } from "vitest";
import { SubtitleSliceType, TaskStatus, type SubtitleTranslatorTask } from "@/type/subtitle";
import { deleteTask, type TranslatorQueueState } from "./translatorQueueService";
import {
  SubtitleTranslatorImportLedger,
  type AddGeneratedSubtitleTasksRequest,
} from "./translatorImportLedger";

function emptyState(): TranslatorQueueState {
  return {
    notStartedTaskQueue: [],
    waitingTaskQueue: [],
    pendingTaskQueue: [],
    resolvedTaskQueue: [],
    failedTaskQueue: [],
  };
}

function task(id: string, fileName = "generated.srt"): SubtitleTranslatorTask {
  return {
    taskId: `subtitle-task-${id}`,
    fileName,
    fileContent: "private subtitle content",
    sliceType: SubtitleSliceType.NORMAL,
    originFileURL: "/legacy/not-used/input.srt",
    targetFileURL: "/legacy/not-used/output",
    status: TaskStatus.NOT_STARTED,
    executionBinding: { status: "needs_configuration" },
  };
}

function request(
  candidates: AddGeneratedSubtitleTasksRequest["candidates"],
  overrides: Partial<AddGeneratedSubtitleTasksRequest> = {},
): AddGeneratedSubtitleTasksRequest {
  return {
    receiptId: "receipt-1",
    ownerId: "owner-1",
    snapshotId: "snapshot-1",
    candidates,
    ...overrides,
  };
}

describe("SubtitleTranslatorImportLedger", () => {
  it("returns the original immutable receipt on an exact replay after deletion", () => {
    const ledger = new SubtitleTranslatorImportLedger();
    const importedTask = task("one");
    const importRequest = request([
      {
        handoffKey: "handoff-1",
        candidateBinding: "binding-1",
        task: importedTask,
      },
    ]);
    const first = ledger.addTasks(emptyState(), importRequest);
    expect(first.receipt.addedTaskIds).toEqual([importedTask.taskId]);
    const deleted = deleteTask(first.state, importedTask.taskId).state;

    const replay = ledger.addTasks(deleted, importRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toBe(first.receipt);
    expect(replay.state.notStartedTaskQueue).toEqual([]);
    expect(JSON.stringify(replay.receipt)).not.toMatch(
      /private subtitle|legacy\/not-used/u,
    );
  });

  it("recognizes an exact handoff replay even when the caller remints receiptId", () => {
    const ledger = new SubtitleTranslatorImportLedger();
    const importedTask = task("one");
    const firstRequest = request([
      {
        handoffKey: "handoff-1",
        candidateBinding: "binding-1",
        task: importedTask,
      },
    ]);
    const first = ledger.addTasks(emptyState(), firstRequest);

    const replay = ledger.addTasks(first.state, {
      ...firstRequest,
      receiptId: "receipt-reminted",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toBe(first.receipt);
    expect(replay.state).toBe(first.state);
  });

  it("rejects receipt rebinding without reserving a new candidate", () => {
    const ledger = new SubtitleTranslatorImportLedger();
    const firstRequest = request([
      {
        handoffKey: "handoff-1",
        candidateBinding: "binding-1",
        task: task("one"),
      },
    ]);
    const first = ledger.addTasks(emptyState(), firstRequest);
    expect(() =>
      ledger.addTasks(first.state, {
        ...firstRequest,
        candidates: [
          {
            handoffKey: "handoff-2",
            candidateBinding: "binding-2",
            task: task("two"),
          },
        ],
      }),
    ).toThrow("receipt_conflict");
    expect(first.state.notStartedTaskQueue).toHaveLength(1);
  });

  it("supports partial add without using fileName as identity", () => {
    const ledger = new SubtitleTranslatorImportLedger();
    const existing = task("existing", "same.srt");
    const next = task("next", "same.srt");
    const result = ledger.addTasks(
      { ...emptyState(), notStartedTaskQueue: [existing] },
      request([
        {
          handoffKey: "handoff-existing",
          candidateBinding: "binding-existing",
          task: existing,
        },
        {
          handoffKey: "handoff-next",
          candidateBinding: "binding-next",
          task: next,
        },
      ]),
    );

    expect(result.receipt.addedTaskIds).toEqual([next.taskId]);
    expect(result.receipt.skipped).toEqual([
      {
        handoffKey: "handoff-existing",
        taskId: existing.taskId,
        displayName: "same.srt",
        reason: "task_id_conflict",
      },
    ]);
    expect(result.state.notStartedTaskQueue).toHaveLength(2);
  });

  it("rejects handoff rebinding before adding unrelated candidates", () => {
    const ledger = new SubtitleTranslatorImportLedger();
    const firstRequest = request([
      {
        handoffKey: "handoff-1",
        candidateBinding: "binding-1",
        task: task("one"),
      },
    ]);
    const first = ledger.addTasks(emptyState(), firstRequest);

    expect(() =>
      ledger.addTasks(first.state, request([
        {
          handoffKey: "handoff-new",
          candidateBinding: "binding-new",
          task: task("new"),
        },
        {
          handoffKey: "handoff-1",
          candidateBinding: "binding-rebound",
          task: task("rebound"),
        },
      ], { receiptId: "receipt-2" })),
    ).toThrow("handoff_conflict");
    expect(first.state.notStartedTaskQueue).toHaveLength(1);
  });
});
