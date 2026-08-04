import { TaskStatus, type SubtitleTranslatorTask } from "@/type/subtitle";
import {
  addTask,
  type TranslatorQueueState,
} from "./translatorQueueService";
import {
  hasReadySubtitleTaskExecution,
  isSubtitleTranslatorTaskId,
} from "./subtitleTranslatorTaskFactory";

export type GeneratedSubtitleQueueCandidate = Readonly<{
  handoffKey: string;
  candidateBinding: string;
  task: SubtitleTranslatorTask;
}>;

export type AddGeneratedSubtitleTasksRequest = Readonly<{
  receiptId: string;
  ownerId: string;
  snapshotId: string;
  candidates: readonly GeneratedSubtitleQueueCandidate[];
}>;

export type GeneratedSubtitleQueueSkipReason =
  | "handoff_conflict"
  | "task_id_conflict";

export type GeneratedSubtitleQueueReceipt = Readonly<{
  receiptId: string;
  snapshotId: string;
  addedTaskIds: readonly string[];
  notStartedTaskIds: readonly string[];
  skipped: readonly Readonly<{
    handoffKey: string;
    taskId: string;
    displayName: string;
    reason: GeneratedSubtitleQueueSkipReason;
  }>[];
}>;

type StoredReceipt = Readonly<{
  signature: string;
  requestFingerprint: string;
  ownerId: string;
  snapshotId: string;
  handoffKeys: readonly string[];
  receipt: GeneratedSubtitleQueueReceipt;
}>;

type HandoffReservation = Readonly<{
  receiptId: string;
  ownerId: string;
  snapshotId: string;
  taskId: string;
  candidateBinding: string;
}>;

export class SubtitleTranslatorImportLedger {
  readonly #receipts = new Map<string, StoredReceipt>();
  readonly #handoffs = new Map<string, HandoffReservation>();

  addTasks(
    state: TranslatorQueueState,
    request: AddGeneratedSubtitleTasksRequest,
  ): Readonly<{
    state: TranslatorQueueState;
    receipt: GeneratedSubtitleQueueReceipt;
    replayed: boolean;
  }> {
    const normalized = validateRequest(request);
    const signature = requestSignature(normalized);
    const existingReceipt = this.#receipts.get(normalized.receiptId);
    if (existingReceipt) {
      if (existingReceipt.signature !== signature) {
        throw new Error("subtitle_import_receipt_conflict");
      }
      return Object.freeze({
        state,
        receipt: existingReceipt.receipt,
        replayed: true,
      });
    }

    const handoffReplay = this.#findExactHandoffReplay(normalized);
    if (handoffReplay) {
      return Object.freeze({
        state,
        receipt: handoffReplay.receipt,
        replayed: true,
      });
    }

    const occupiedTaskIds = new Set(
      allTasks(state).map((task) => task.taskId),
    );
    let nextState = state;
    const addedTaskIds: string[] = [];
    const skipped: Array<{
      handoffKey: string;
      taskId: string;
      displayName: string;
      reason: GeneratedSubtitleQueueSkipReason;
    }> = [];
    const reservations: Array<[string, HandoffReservation]> = [];

    for (const candidate of normalized.candidates) {
      const existingHandoff = this.#handoffs.get(candidate.handoffKey);
      if (existingHandoff) {
        skipped.push({
          handoffKey: candidate.handoffKey,
          taskId: candidate.task.taskId,
          displayName: candidate.task.fileName,
          reason: "handoff_conflict",
        });
        continue;
      }
      if (occupiedTaskIds.has(candidate.task.taskId)) {
        skipped.push({
          handoffKey: candidate.handoffKey,
          taskId: candidate.task.taskId,
          displayName: candidate.task.fileName,
          reason: "task_id_conflict",
        });
        continue;
      }

      const added = addTask(nextState, candidate.task);
      if (added.isDuplicate) {
        throw new Error("subtitle_import_atomic_insert_failed");
      }
      nextState = added.state;
      occupiedTaskIds.add(candidate.task.taskId);
      addedTaskIds.push(candidate.task.taskId);
      reservations.push([
        candidate.handoffKey,
        Object.freeze({
          receiptId: normalized.receiptId,
          ownerId: normalized.ownerId,
          snapshotId: normalized.snapshotId,
          taskId: candidate.task.taskId,
          candidateBinding: candidate.candidateBinding,
        }),
      ]);
    }

    const receipt = freezeReceipt({
      receiptId: normalized.receiptId,
      snapshotId: normalized.snapshotId,
      addedTaskIds,
      notStartedTaskIds: addedTaskIds,
      skipped,
    });
    const stored = Object.freeze({
      signature,
      requestFingerprint: requestFingerprint(normalized),
      ownerId: normalized.ownerId,
      snapshotId: normalized.snapshotId,
      handoffKeys: Object.freeze(reservations.map(([key]) => key)),
      receipt,
    });

    for (const [handoffKey, reservation] of reservations) {
      this.#handoffs.set(handoffKey, reservation);
    }
    this.#receipts.set(normalized.receiptId, stored);
    return Object.freeze({ state: nextState, receipt, replayed: false });
  }

  #findExactHandoffReplay(
    request: AddGeneratedSubtitleTasksRequest,
  ): StoredReceipt | undefined {
    const reservations = request.candidates.map((candidate) => {
      const reservation = this.#handoffs.get(candidate.handoffKey);
      if (
        reservation &&
        (reservation.ownerId !== request.ownerId ||
          reservation.snapshotId !== request.snapshotId ||
          reservation.taskId !== candidate.task.taskId ||
          reservation.candidateBinding !== candidate.candidateBinding)
      ) {
        throw new Error("subtitle_import_handoff_conflict");
      }
      return reservation;
    });
    if (reservations.some((reservation) => !reservation)) return undefined;
    const receiptIds = new Set(
      reservations.map((reservation) => reservation!.receiptId),
    );
    if (receiptIds.size !== 1) return undefined;
    const stored = this.#receipts.get([...receiptIds][0]);
    return stored?.requestFingerprint === requestFingerprint(request)
      ? stored
      : undefined;
  }

  releaseSnapshot(ownerId: string, snapshotId: string): void {
    for (const [receiptId, stored] of this.#receipts) {
      if (stored.ownerId !== ownerId || stored.snapshotId !== snapshotId) {
        continue;
      }
      this.#receipts.delete(receiptId);
      for (const handoffKey of stored.handoffKeys) {
        const reservation = this.#handoffs.get(handoffKey);
        if (reservation?.receiptId === receiptId) {
          this.#handoffs.delete(handoffKey);
        }
      }
    }
  }
}

function validateRequest(
  request: AddGeneratedSubtitleTasksRequest,
): AddGeneratedSubtitleTasksRequest {
  if (
    !request ||
    !safeOpaqueId(request.receiptId) ||
    !safeOpaqueId(request.ownerId) ||
    !safeOpaqueId(request.snapshotId) ||
    !Array.isArray(request.candidates) ||
    request.candidates.length === 0 ||
    request.candidates.length > 100
  ) {
    throw new TypeError("Generated subtitle import request is invalid.");
  }
  const handoffKeys = new Set<string>();
  const taskIds = new Set<string>();
  for (const candidate of request.candidates) {
    if (
      !candidate ||
      !safeOpaqueId(candidate.handoffKey) ||
      !safeOpaqueId(candidate.candidateBinding) ||
      !isSubtitleTranslatorTaskId(candidate.task?.taskId) ||
      !safeDisplayName(candidate.task.fileName) ||
      candidate.task.status !== TaskStatus.NOT_STARTED ||
      (candidate.task.executionBinding?.status !== "needs_configuration" &&
        !hasReadySubtitleTaskExecution(candidate.task)) ||
      handoffKeys.has(candidate.handoffKey) ||
      taskIds.has(candidate.task.taskId)
    ) {
      throw new TypeError("Generated subtitle import candidate is invalid.");
    }
    handoffKeys.add(candidate.handoffKey);
    taskIds.add(candidate.task.taskId);
  }
  return request;
}

function requestSignature(request: AddGeneratedSubtitleTasksRequest): string {
  return JSON.stringify({
    receiptId: request.receiptId,
    fingerprint: requestFingerprint(request),
  });
}

function requestFingerprint(request: AddGeneratedSubtitleTasksRequest): string {
  return JSON.stringify({
    ownerId: request.ownerId,
    snapshotId: request.snapshotId,
    candidates: request.candidates.map((candidate) => ({
      handoffKey: candidate.handoffKey,
      candidateBinding: candidate.candidateBinding,
      taskId: candidate.task.taskId,
    })),
  });
}

function safeDisplayName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim().length > 0 &&
    !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function freezeReceipt(
  receipt: Omit<GeneratedSubtitleQueueReceipt, never>,
): GeneratedSubtitleQueueReceipt {
  return Object.freeze({
    receiptId: receipt.receiptId,
    snapshotId: receipt.snapshotId,
    addedTaskIds: Object.freeze([...receipt.addedTaskIds]),
    notStartedTaskIds: Object.freeze([...receipt.notStartedTaskIds]),
    skipped: Object.freeze(
      receipt.skipped.map((item) => Object.freeze({ ...item })),
    ),
  });
}

function allTasks(state: TranslatorQueueState): SubtitleTranslatorTask[] {
  return [
    ...state.notStartedTaskQueue,
    ...state.waitingTaskQueue,
    ...state.pendingTaskQueue,
    ...state.resolvedTaskQueue,
    ...state.failedTaskQueue,
  ];
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value);
}
