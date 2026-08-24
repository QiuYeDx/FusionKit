import {
  getGeneratedSubtitleImportCoordinator,
} from "@/services/subtitle/generatedSubtitleImportCoordinator";
import type {
  AutomaticSubtitleTranslationHandoffMode,
  PrepareGeneratedSubtitleImportResult,
  SubtitleTranslationImportReceipt,
  SubtitleTranslationImportSkipReason,
} from "@/type/generatedSubtitleImport";
import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleBatchSummary,
  LocalSubtitleErrorCode,
  LocalSubtitleFormat,
  LocalSubtitlePostActionState,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleCompletePostActionRequest,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";
import {
  getLocalSubtitleRuntimeService,
  type LocalSubtitleRuntimeService,
} from "./localSubtitleRuntimeService";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 100, 500]);

interface GeneratedImportCoordinator {
  prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult>;
  importArtifact(request: {
    readonly translationImportToken: string;
    readonly snapshotId: string;
  }): Promise<SubtitleTranslationImportReceipt>;
  releaseBatch(snapshotId: string): Promise<void>;
  hasTask?(taskId: string): boolean;
}

interface AutomaticBatchState {
  readonly batchId: string;
  readonly snapshotId: string;
  readonly taskIds: ReadonlySet<string>;
  readonly settledTaskIds: Set<string>;
  readonly finalPostActions: Map<string, LocalSubtitlePostActionState>;
  readonly operations: Map<string, Promise<void>>;
  lastBatch: LocalSubtitleBatchSummary;
  seenInRuntime: boolean;
  releaseOperation?: Promise<void>;
}

export interface LocalSubtitlePostActionServiceOptions {
  readonly runtime: Pick<
    LocalSubtitleRuntimeService,
    "getState" | "subscribe"
  >;
  readonly getLocalApi: () => Pick<
    LocalSubtitleRendererApi,
    "handoffArtifact" | "completePostAction"
  >;
  readonly imports: GeneratedImportCoordinator;
  readonly retryDelaysMs?: readonly number[];
}

export type LocalSubtitleManualHandoffResult =
  | Readonly<{
      ok: true;
      mode: AutomaticSubtitleTranslationHandoffMode;
      receipt: SubtitleTranslationImportReceipt;
    }>
  | Readonly<{
      ok: false;
      code: LocalSubtitleErrorCode;
    }>;

export class LocalSubtitlePostActionService {
  readonly #runtime: LocalSubtitlePostActionServiceOptions["runtime"];
  readonly #getLocalApi: LocalSubtitlePostActionServiceOptions["getLocalApi"];
  readonly #imports: GeneratedImportCoordinator;
  readonly #retryDelaysMs: readonly number[];
  readonly #automaticBatches = new Map<string, AutomaticBatchState>();
  readonly #pendingSnapshotReleases = new Map<string, Promise<boolean>>();
  readonly #unsubscribe: () => void;

  constructor(options: LocalSubtitlePostActionServiceOptions) {
    if (
      !options ||
      typeof options.runtime?.getState !== "function" ||
      typeof options.runtime?.subscribe !== "function" ||
      typeof options.getLocalApi !== "function" ||
      typeof options.imports?.prepareBatch !== "function" ||
      typeof options.imports?.importArtifact !== "function" ||
      typeof options.imports?.releaseBatch !== "function"
    ) {
      throw new TypeError("Local subtitle post-action services are invalid.");
    }
    this.#runtime = options.runtime;
    this.#getLocalApi = options.getLocalApi;
    this.#imports = options.imports;
    this.#retryDelaysMs = normalizeRetryDelays(options.retryDelaysMs);
    this.#unsubscribe = this.#runtime.subscribe(() => this.#synchronize());
  }

  prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult> {
    return this.#imports.prepareBatch(mode);
  }

  hasTranslationTask(taskId: string): boolean {
    return safeId(taskId) && (this.#imports.hasTask?.(taskId) ?? false);
  }

  registerAutomaticBatch(
    batch: LocalSubtitleBatchSummary,
    snapshotId: string,
  ): void {
    if (
      !safeId(snapshotId) ||
      batch.config.postActionMode === "export_only" ||
      !batch.config.preferredHandoffFormat ||
      batch.tasks.length === 0 ||
      batch.tasks.some(
        (task) =>
          task.postAction.mode !== batch.config.postActionMode ||
          task.postAction.preferredFormat !==
            batch.config.preferredHandoffFormat,
      )
    ) {
      throw new TypeError("Local subtitle automatic post-action batch is invalid.");
    }
    const existing = this.#automaticBatches.get(batch.batchId);
    if (existing) {
      if (existing.snapshotId !== snapshotId) {
        throw new TypeError("Local subtitle automatic batch snapshot conflicts.");
      }
      existing.lastBatch = batch;
      this.#synchronizeBatch(existing, batch);
      this.#synchronize();
      return;
    }
    const state: AutomaticBatchState = {
      batchId: batch.batchId,
      snapshotId,
      taskIds: new Set(batch.tasks.map((task) => task.taskId)),
      settledTaskIds: new Set(),
      finalPostActions: new Map(),
      operations: new Map(),
      lastBatch: batch,
      seenInRuntime: false,
    };
    this.#automaticBatches.set(batch.batchId, state);
    this.#synchronizeBatch(state, batch);
    this.#synchronize();
  }

  async importManually(input: {
    readonly artifact: GeneratedSubtitleArtifactSummary;
    readonly mode: AutomaticSubtitleTranslationHandoffMode;
  }): Promise<LocalSubtitleManualHandoffResult> {
    const prepared = await this.#imports.prepareBatch(input.mode);
    if (!prepared.ok) {
      return Object.freeze({
        ok: false,
        code: mapPrepareFailure(prepared.code),
      });
    }
    const snapshotId = prepared.snapshot.snapshotId;
    let result: LocalSubtitleManualHandoffResult;
    try {
      const handoff = await this.#getLocalApi().handoffArtifact(
        input.artifact.artifactRef,
      );
      if (!handoff.ok) {
        result = Object.freeze({ ok: false, code: handoff.error.code });
      } else {
        const receipt = await this.#imports.importArtifact({
          translationImportToken: handoff.data.translationImportToken,
          snapshotId,
        });
        result = Object.freeze({
          ok: true,
          mode: prepared.snapshot.handoffMode,
          receipt,
        });
      }
    } catch {
      result = Object.freeze({ ok: false, code: "import_failed" });
    }
    void this.releaseSnapshot(snapshotId);
    return result;
  }

  releaseSnapshot(snapshotId: string): Promise<boolean> {
    if (!safeId(snapshotId)) return Promise.resolve(false);
    const pending = this.#pendingSnapshotReleases.get(snapshotId);
    if (pending) return pending;
    const operation = retryOperation(
      () => this.#imports.releaseBatch(snapshotId),
      this.#retryDelaysMs,
    ).finally(() => {
      if (this.#pendingSnapshotReleases.get(snapshotId) === operation) {
        this.#pendingSnapshotReleases.delete(snapshotId);
      }
    });
    this.#pendingSnapshotReleases.set(snapshotId, operation);
    return operation;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #synchronize(): void {
    const batches = new Map(
      this.#runtime.getState().batches.map((batch) => [batch.batchId, batch]),
    );
    for (const state of this.#automaticBatches.values()) {
      const batch = batches.get(state.batchId);
      if (batch) {
        state.seenInRuntime = true;
        state.lastBatch = batch;
        this.#synchronizeBatch(state, batch);
      } else if (state.seenInRuntime) {
        for (const taskId of state.taskIds) state.settledTaskIds.add(taskId);
        this.#releaseAutomaticBatchIfSettled(state);
      }
    }
  }

  #synchronizeBatch(
    state: AutomaticBatchState,
    batch: LocalSubtitleBatchSummary,
  ): void {
    for (const taskId of state.taskIds) {
      if (state.settledTaskIds.has(taskId) || state.operations.has(taskId)) {
        continue;
      }
      const task = batch.tasks.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        state.settledTaskIds.add(taskId);
        continue;
      }
      if (task.status === "cancelled") {
        state.settledTaskIds.add(taskId);
        continue;
      }
      if (task.status !== "completed") continue;
      if (isFinalPostAction(task.postAction)) {
        state.settledTaskIds.add(taskId);
        continue;
      }
      const operation = this.#processAutomaticTask(state, task).finally(() => {
        state.operations.delete(taskId);
        this.#releaseAutomaticBatchIfSettled(state);
      });
      state.operations.set(taskId, operation);
    }
    this.#releaseAutomaticBatchIfSettled(state);
  }

  async #processAutomaticTask(
    state: AutomaticBatchState,
    task: LocalSubtitleTaskSummary,
  ): Promise<void> {
    let finalState = state.finalPostActions.get(task.taskId);
    if (!finalState) {
      finalState = await this.#performAutomaticImport(state.snapshotId, task);
      state.finalPostActions.set(task.taskId, finalState);
    }
    const request: LocalSubtitleCompletePostActionRequest = {
      taskId: task.taskId,
      generation: task.generation,
      postAction: finalState,
    };
    const completed = await retryResultOperation(
      () => this.#getLocalApi().completePostAction(request),
      this.#retryDelaysMs,
    );
    if (completed) state.settledTaskIds.add(task.taskId);
  }

  async #performAutomaticImport(
    snapshotId: string,
    task: LocalSubtitleTaskSummary,
  ): Promise<LocalSubtitlePostActionState> {
    const preferredFormat = task.postAction.preferredFormat;
    if (!preferredFormat || task.postAction.mode === "export_only") {
      throw new TypeError("Local subtitle automatic task state is invalid.");
    }
    if (
      task.completion?.warnings.includes("cancelled_after_partial_commit")
    ) {
      return failedArtifactPostAction(
        task.postAction.mode,
        preferredFormat,
        "cancelled_after_partial_commit",
      );
    }
    const preferredResult = task.artifactResults.find(
      (result) => result.format === preferredFormat,
    );
    if (!preferredResult || preferredResult.status !== "committed") {
      return failedArtifactPostAction(
        task.postAction.mode,
        preferredFormat,
        preferredResult?.errorCode ?? "unsupported_format",
      );
    }
    try {
      const handoff = await this.#getLocalApi().handoffArtifact(
        preferredResult.artifact.artifactRef,
      );
      if (!handoff.ok) {
        return failedImportPostAction(
          task.postAction.mode,
          preferredFormat,
          handoff.error.code,
        );
      }
      const receipt = await this.#imports.importArtifact({
        translationImportToken: handoff.data.translationImportToken,
        snapshotId,
      });
      return createLocalSubtitlePostActionFromReceipt(
        task.postAction.mode,
        preferredFormat,
        receipt,
      );
    } catch {
      return failedImportPostAction(
        task.postAction.mode,
        preferredFormat,
        "import_failed",
      );
    }
  }

  #releaseAutomaticBatchIfSettled(state: AutomaticBatchState): void {
    if (
      state.releaseOperation ||
      state.operations.size > 0 ||
      state.settledTaskIds.size !== state.taskIds.size
    ) {
      return;
    }
    state.releaseOperation = this.releaseSnapshot(state.snapshotId).then(
      (released) => {
        if (released) this.#automaticBatches.delete(state.batchId);
      },
    ).finally(() => {
      state.releaseOperation = undefined;
    });
  }
}

export function createLocalSubtitlePostActionFromReceipt(
  mode: AutomaticSubtitleTranslationHandoffMode,
  preferredFormat: LocalSubtitleFormat,
  receipt: SubtitleTranslationImportReceipt,
): LocalSubtitlePostActionState {
  const taskId = receipt.addedTaskIds[0];
  if (!taskId) {
    return failedArtifactPostAction(
      mode,
      preferredFormat,
      mapImportSkipReason(receipt.skipped[0]?.reason ?? "invalid_content"),
    );
  }
  if (receipt.addedTaskIds.length !== 1) {
    return failedImportPostAction(mode, preferredFormat, "invalid_content");
  }
  if (mode === "enqueue_translation") {
    return Object.freeze({
      mode,
      preferredFormat,
      importStatus: "queued",
      startStatus: "not_requested",
      importReceiptId: receipt.receiptId,
      translationTaskId: taskId,
    });
  }
  if (receipt.startedTaskIds.includes(taskId)) {
    return Object.freeze({
      mode,
      preferredFormat,
      importStatus: "queued",
      startStatus: "started",
      importReceiptId: receipt.receiptId,
      translationTaskId: taskId,
    });
  }
  if (receipt.waitingTaskIds.includes(taskId)) {
    return Object.freeze({
      mode,
      preferredFormat,
      importStatus: "queued",
      startStatus: "waiting",
      importReceiptId: receipt.receiptId,
      translationTaskId: taskId,
    });
  }
  const reason = receipt.startFailures.find(
    (failure) => failure.taskId === taskId,
  )?.reason ?? "start_rejected";
  return Object.freeze({
    mode,
    preferredFormat,
    importStatus: "queued",
    startStatus: "failed",
    importReceiptId: receipt.receiptId,
    translationTaskId: taskId,
    startFailureReason: reason,
  });
}

function failedArtifactPostAction(
  mode: AutomaticSubtitleTranslationHandoffMode,
  preferredFormat: LocalSubtitleFormat,
  code: LocalSubtitleErrorCode,
): LocalSubtitlePostActionState {
  return Object.freeze({
    mode,
    preferredFormat,
    importStatus: "skipped",
    startStatus: "not_requested",
    importErrorCode: code,
  });
}

function failedImportPostAction(
  mode: AutomaticSubtitleTranslationHandoffMode,
  preferredFormat: LocalSubtitleFormat,
  code: LocalSubtitleErrorCode,
): LocalSubtitlePostActionState {
  return Object.freeze({
    mode,
    preferredFormat,
    importStatus: "failed",
    startStatus: "not_requested",
    importErrorCode: code,
  });
}

function mapPrepareFailure(
  code: Extract<PrepareGeneratedSubtitleImportResult, { ok: false }>["code"],
): LocalSubtitleErrorCode {
  return code;
}

function mapImportSkipReason(
  reason: SubtitleTranslationImportSkipReason,
): LocalSubtitleErrorCode {
  return reason;
}

function isFinalPostAction(state: LocalSubtitlePostActionState): boolean {
  return state.importStatus === "queued" ||
    state.importStatus === "skipped" ||
    state.importStatus === "failed";
}

function normalizeRetryDelays(value: readonly number[] | undefined): readonly number[] {
  const candidate = value ?? DEFAULT_RETRY_DELAYS_MS;
  if (
    candidate.length === 0 ||
    candidate.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new TypeError("Local subtitle post-action retry delays are invalid.");
  }
  return Object.freeze([...candidate]);
}

async function retryOperation(
  operation: () => Promise<void>,
  delays: readonly number[],
): Promise<boolean> {
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      await operation();
      return true;
    } catch {
      // Continue through the bounded retry schedule.
    }
  }
  return false;
}

async function retryResultOperation(
  operation: () => ReturnType<
    Pick<LocalSubtitleRendererApi, "completePostAction">["completePostAction"]
  >,
  delays: readonly number[],
): Promise<boolean> {
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      const result = await operation();
      if (result.ok) return true;
      if (
        result.error.code === "owner_released" ||
        result.error.code === "authorization_expired"
      ) {
        return true;
      }
    } catch {
      // Continue through the bounded retry schedule.
    }
  }
  return false;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

let sharedService: LocalSubtitlePostActionService | undefined;

export function getLocalSubtitlePostActionService():
  LocalSubtitlePostActionService {
  sharedService ??= new LocalSubtitlePostActionService({
    runtime: getLocalSubtitleRuntimeService(),
    getLocalApi: () => window.localSubtitleApi,
    imports: getGeneratedSubtitleImportCoordinator(),
  });
  return sharedService;
}

export function resetLocalSubtitlePostActionServiceForTests(): void {
  sharedService?.dispose();
  sharedService = undefined;
}
