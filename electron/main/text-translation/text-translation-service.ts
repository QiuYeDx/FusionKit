import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type {
  CancelTextTranslationTaskRequest,
  DeleteTextTranslationTaskRequest,
  DeleteTextTranslationTaskResult,
  GetTextTranslationTaskDetailRequest,
  PrepareTextTranslationTaskRequest,
  RetranslateTextTranslationFromSegmentRequest,
  RestartTextTranslationTaskRequest,
  ResumeTextTranslationTaskRequest,
  RevealTextTranslationOutputRequest,
  RevealTextTranslationPathResult,
  RevealTextTranslationWorkspaceRequest,
  StartTextTranslationTaskRequest,
  PauseTextTranslationTaskRequest,
  TextTranslationEvent,
  TextTranslationIpcResult,
} from "@/type/textTranslationIpc";
import {
  textTranslationIpcFailure,
  textTranslationIpcSuccess,
} from "@/type/textTranslationIpc";
import {
  createPersistedTextTranslationTask,
  createTextTranslationTask,
  type CreateTextTranslationTaskRequest,
  type SourceFingerprint,
  type TextTranslationProgress,
  type TextTranslationRecoverySummary,
  type TextTranslationRuntimeModelConfig,
  type TextTranslationTask,
} from "@/type/textTranslation";
import {
  sendOpenAICompatibleChatCompletion,
  type OpenAICompatibleUsage,
} from "../ai/openai-compatible-client";
import {
  readAndDecodeTextTranslationInputFile,
  type TextTranslationDecodedInputFile,
} from "./input/file-reader";
import {
  parseMarkdownTranslationUnits,
} from "./parsing/markdown-parser";
import {
  applyProtectedPlaceholders,
  type MarkdownProtectedSpan,
  type ProtectedPlaceholder,
} from "./parsing/protected-placeholders";
import { parseTxtTranslationUnits } from "./parsing/text-parser";
import { planTranslationSegments } from "./planning/segment-planner";
import { countTextTokens } from "./planning/token-counter";
import { TextTranslationRequestScheduler } from "./request-scheduler";
import { TextTranslationWorkspaceRepository } from "./persistence/workspace-repository";
import { trimSemanticMemoryToBudget } from "./memory/memory-budget";
import {
  createSemanticMemorySnapshotId,
  SemanticMemoryManager,
} from "./memory/semantic-memory-manager";
import {
  buildMarkdownBilingualTranslationPrompt,
  buildMarkdownTargetOnlyTranslationPrompt,
  buildSequentialTranslationPrompt,
  parseMarkdownBilingualTranslationResponse,
  parseMarkdownTargetOnlyTranslationResponse,
  parseSequentialTranslationResponse,
  TranslationProtocolError,
  type MarkdownExpectedBlockTranslation,
  type MarkdownExpectedUnitTranslation,
  type MarkdownBlockTranslationProtocolResult,
  type MarkdownUnitTranslationProtocolResult,
} from "./model/translation-response-protocol";
import {
  writeTxtOutput,
  type TextTranslationSegmentResult,
} from "./output/text-output-assembler";
import {
  collectMarkdownBilingualBlocks,
  writeMarkdownBilingualOutput,
  writeMarkdownTargetOnlyOutput,
  type MarkdownBilingualBlock,
} from "./output/markdown-output-assembler";
import type {
  TranslationSegment,
  TranslationUnit,
  TranslationUnitKind,
} from "./types";
import type { TextTranslationWorkspaceEvent } from "./persistence/event-log";
import type { SemanticMemoryWarning } from "./memory/memory-patch";
import type { SemanticMemory } from "./memory/semantic-memory";

export type TextTranslationEventSink = (event: TextTranslationEvent) => void;

export interface TextTranslationIpcService {
  createTask(
    request: CreateTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  prepareTask(
    request: PrepareTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  startTask(
    request: StartTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  pauseTask(
    request: PauseTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  cancelTask(
    request: CancelTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  resumeTask(
    request: ResumeTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  retranslateFromSegment(
    request: RetranslateTextTranslationFromSegmentRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  restartTask(
    request: RestartTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>>;
  deleteTask(
    request: DeleteTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<DeleteTextTranslationTaskResult>>;
  listRecoverableTasks(): Promise<
    TextTranslationIpcResult<TextTranslationRecoverySummary[]>
  >;
  getTaskDetail(
    request: GetTextTranslationTaskDetailRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask | null>>;
  revealOutput(
    request: RevealTextTranslationOutputRequest,
  ): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>>;
  revealWorkspace(
    request: RevealTextTranslationWorkspaceRequest,
  ): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>>;
}

export interface TextTranslationServiceOptions {
  repository?: TextTranslationWorkspaceRepository;
  scheduler?: TextTranslationRequestScheduler;
  memoryManager?: SemanticMemoryManager;
  eventSink?: TextTranslationEventSink;
}

interface RuntimeTaskRecord {
  task: TextTranslationTask;
  model: TextTranslationRuntimeModelConfig;
  sourceFingerprint: SourceFingerprint[];
  controller?: AbortController;
  abortReason?: "cancel" | "pause";
  units?: TranslationUnit[];
  segments?: TranslationSegment[];
  results?: RuntimeTranslationSegmentResult[];
  failedSegmentIds?: string[];
  staleFromSegmentId?: string;
  outputPaths?: string[];
}

interface TranslationSegmentFailure {
  segmentId: string;
  errorCode: string;
  message: string;
}

interface TranslateSegmentsResult {
  results: RuntimeTranslationSegmentResult[];
  failures: TranslationSegmentFailure[];
}

type PersistedTranslationSegment = Omit<TranslationSegment, "sourceText">;

interface MarkdownTargetOnlySegmentPayload {
  schemaVersion: 1;
  kind: "markdown_target_only";
  segmentId: string;
  fileId: string;
  units: MarkdownExpectedUnitTranslation[];
}

interface MarkdownBilingualSegmentItem
  extends MarkdownExpectedBlockTranslation {
  block: MarkdownBilingualBlock;
}

interface MarkdownBilingualSegmentPayload {
  schemaVersion: 1;
  kind: "markdown_bilingual";
  segmentId: string;
  fileId: string;
  blocks: MarkdownBilingualSegmentItem[];
}

type MarkdownSegmentPayload =
  | MarkdownTargetOnlySegmentPayload
  | MarkdownBilingualSegmentPayload;

interface MarkdownTargetOnlySegmentResult {
  schemaVersion: 1;
  kind: "markdown_target_only";
  segmentId: string;
  results: MarkdownUnitTranslationProtocolResult[];
  stale?: boolean;
}

interface MarkdownBilingualSegmentResult {
  schemaVersion: 1;
  kind: "markdown_bilingual";
  segmentId: string;
  translations: MarkdownBlockTranslationProtocolResult[];
  stale?: boolean;
}

type MarkdownSegmentResult =
  | MarkdownTargetOnlySegmentResult
  | MarkdownBilingualSegmentResult;

type RuntimeTranslationSegmentResult =
  | TextTranslationSegmentResult
  | MarkdownSegmentResult;

export class TextTranslationService implements TextTranslationIpcService {
  private readonly repository: TextTranslationWorkspaceRepository;
  private readonly scheduler: TextTranslationRequestScheduler;
  private readonly memoryManager: SemanticMemoryManager;
  private readonly eventSink?: TextTranslationEventSink;
  private readonly tasks = new Map<string, RuntimeTaskRecord>();
  private readonly nextSequenceByTask = new Map<string, number>();

  constructor(options: TextTranslationServiceOptions = {}) {
    this.repository =
      options.repository ?? new TextTranslationWorkspaceRepository();
    this.scheduler = options.scheduler ?? new TextTranslationRequestScheduler();
    this.memoryManager =
      options.memoryManager ?? new SemanticMemoryManager(this.repository);
    this.eventSink = options.eventSink;
  }

  async createTask(
    request: CreateTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    if (
      request.files.length !== 1 &&
      request.options.projectMode !== "ordered_project"
    ) {
      return this.failure(
        "invalid_ipc_request",
        "Multiple text files require ordered_project mode.",
      );
    }
    if (
      request.options.outputMode !== "target_only" &&
      request.options.outputMode !== "bilingual"
    ) {
      return this.failure(
        "not_implemented",
        "Text translation currently supports target-only or bilingual output.",
      );
    }

    try {
      const taskId = `text_task_${randomUUID().replace(/-/g, "_")}`;
      const orderedFiles = [...request.files].sort(
        (left, right) => left.order - right.order,
      );
      const inspections = [];
      for (const file of orderedFiles) {
        const inspection = await readAndDecodeTextTranslationInputFile({
          ...file,
          fileId: undefined,
        });
        inspections.push(inspection);
      }
      if (
        request.options.executionMode === "sequential_context" &&
        inspections.some(
          (inspection) => inspection.file.format === "markdown",
        )
      ) {
        return this.failure(
          "not_implemented",
          "Sequential-context Markdown translation will be enabled by MD-006.",
        );
      }

      const task = createTextTranslationTask({
        taskId,
        files: inspections.map((inspection) =>
          withEncodingSummary(inspection.file, inspection.encoding),
        ),
        options: request.options,
      });
      const record: RuntimeTaskRecord = {
        task,
        model: request.model,
        sourceFingerprint: inspections.map((inspection) => inspection.fingerprint),
      };
      this.tasks.set(taskId, record);

      await this.repository.ensureWorkspace(taskId);
      await this.repository.writeFilesIndex(taskId, task.files);
      await this.persistTask(record, 0);
      await this.appendEvent(taskId, {
        type: "task_status_changed",
        taskId,
        sequence: this.nextSequence(taskId),
        occurredAt: new Date().toISOString(),
        status: task.status,
        phase: task.phase,
      });
      this.emitTaskUpdated(record);

      return textTranslationIpcSuccess(task);
    } catch (error) {
      return this.errorToFailure(error);
    }
  }

  async prepareTask(
    request: PrepareTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    const record = this.tasks.get(request.taskId);
    if (!record) return this.taskNotFound(request.taskId);
    const guard = this.requireStatus(record, [
      "not_started",
      "failed",
      "cancelled",
    ]);
    if (!guard.ok) return guard;

    try {
      this.patchTask(record, {
        status: "preparing",
        phase: "inspecting_files",
      });
      this.emitTaskUpdated(record);

      const decodedFiles = [];
      const orderedFiles = [...record.task.files].sort(
        (left, right) => left.order - right.order,
      );
      for (const file of orderedFiles) {
        decodedFiles.push(
          await readAndDecodeTextTranslationInputFile({
            sourcePath: file.sourcePath,
            relativePath: file.relativePath,
            order: file.order,
            fileId: file.fileId,
          }),
        );
      }
      record.sourceFingerprint = decodedFiles.map(
        (decoded) => decoded.fingerprint,
      );
      record.task.files = decodedFiles.map((decoded) =>
        withEncodingSummary(decoded.file, decoded.encoding),
      );

      this.patchTask(record, { phase: "parsing" });
      this.emitTaskUpdated(record);
      const preparedFiles: PreparedTranslationFile[] = [];
      const segments: TranslationSegment[] = [];
      for (const decoded of decodedFiles) {
        const prepared = prepareDecodedTranslationFile({
          decoded,
          outputMode: record.task.options.outputMode,
          sliceTokenLimit: record.task.options.sliceTokenLimit,
          startingGlobalIndex: segments.length,
        });
        preparedFiles.push(prepared);
        segments.push(...prepared.segments);
      }

      this.patchTask(record, { phase: "planning_segments" });
      this.emitTaskUpdated(record);
      record.units = preparedFiles.flatMap((entry) => entry.units);
      record.segments = segments;
      record.results = [];
      record.failedSegmentIds = [];
      record.staleFromSegmentId = undefined;
      record.outputPaths = [];

      for (const entry of preparedFiles) {
        await this.repository.writeUnits(
          request.taskId,
          entry.file.fileId,
          entry.units,
        );
        if (entry.file.format === "markdown") {
          await this.repository.writeFileSourceSnapshot(
            request.taskId,
            entry.file.fileId,
            entry.sourceText,
          );
        }
      }
      await this.repository.writeSegmentsIndex(
        request.taskId,
        segments.map(({ sourceText, ...segment }) => segment),
      );
      for (const entry of preparedFiles) {
        const markdownPayloadBySegmentId = new Map(
          entry.markdownPayloads.map((payload) => [
            payload.segmentId,
            payload,
          ]),
        );
        for (const segment of entry.segments) {
          const markdownPayload = markdownPayloadBySegmentId.get(
            segment.segmentId,
          );
          if (markdownPayload) {
            await this.repository.writeSegmentSourcePayload(
              request.taskId,
              segment.segmentId,
              markdownPayload,
            );
          } else {
            await this.repository.writeSegmentSource(
              request.taskId,
              segment.segmentId,
              segment.sourceText,
            );
          }
        }
      }
      if (record.task.options.executionMode === "sequential_context") {
        await this.memoryManager.initialize(request.taskId, {
          glossary: record.task.options.glossary,
          documentBackground: record.task.options.documentBackground,
          styleInstructions: record.task.options.styleInstructions,
        });
      }

      this.patchTask(record, {
        status: "waiting",
        phase: "estimating",
        progress: this.createProgress(
          "estimating",
          segments.length,
          0,
          [],
          sumSourceTokens(segments),
        ),
      });
      await this.appendStatusChanged(record);
      await this.persistTask(record, segments.length);
      this.emitTaskUpdated(record);
      this.emitProgress(record);

      return textTranslationIpcSuccess(record.task);
    } catch (error) {
      this.patchTask(record, { status: "failed" });
      await this.persistTask(record, record.segments?.length ?? 0);
      const failure = this.errorToFailure(error);
      this.emitTaskUpdated(record);
      this.emitTaskFailed(record, failure.error);
      return failure;
    }
  }

  async startTask(
    request: StartTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    const record = this.tasks.get(request.taskId);
    if (!record) return this.taskNotFound(request.taskId);
    const guard = this.requireStatus(record, ["waiting"]);
    if (!guard.ok) return guard;
    if (!record.segments) {
      return this.failure("invalid_ipc_request", "Task must be prepared first.");
    }

    const controller = new AbortController();
    record.controller = controller;
    record.abortReason = undefined;
    record.results = [];
    record.failedSegmentIds = [];

    try {
      this.patchTask(record, {
        status: "running",
        phase: "translating",
        progress: this.createProgress(
          "translating",
          record.segments.length,
          0,
          [],
          record.task.progress.estimatedInputTokens,
        ),
      });
      await this.persistTask(record, record.segments.length);
      this.emitTaskUpdated(record);
      this.emitProgress(record);

      const translated =
        record.task.options.executionMode === "sequential_context"
          ? await this.translateSegmentsSequential(record, controller.signal)
          : await this.translateSegments(record, controller.signal);
      record.results = translated.results;
      record.failedSegmentIds = translated.failures.map(
        (failure) => failure.segmentId,
      );

      if (translated.failures.length > 0) {
        const status =
          translated.results.length > 0 ? "partially_completed" : "failed";
        this.patchTask(record, {
          status,
          phase: "translating",
          progress: this.createProgress(
            "translating",
            record.segments.length,
            translated.results.length,
            [],
            record.task.progress.estimatedInputTokens,
          ),
        });
        await this.appendStatusChanged(record);
        await this.persistTask(record, record.segments.length);
        this.emitTaskUpdated(record);
        this.emitProgress(record);
        if (status === "failed") {
          const failure = this.failure(
            "internal_error",
            "All text translation segments failed.",
          );
          this.emitTaskFailed(record, failure.error);
          return failure;
        }
        return textTranslationIpcSuccess(record.task);
      }

      this.patchTask(record, { phase: "assembling_outputs" });
      record.outputPaths = await this.writeTaskOutputs(
        record,
        translated.results,
      );
      this.patchTask(record, {
        status: "completed",
        phase: "completed",
        progress: this.createProgress(
          "completed",
          record.segments.length,
          record.segments.length,
          [],
          record.task.progress.estimatedInputTokens,
        ),
      });
      await this.appendEvent(record.task.taskId, {
        type: "task_completed",
        taskId: record.task.taskId,
        sequence: this.nextSequence(record.task.taskId),
        occurredAt: new Date().toISOString(),
        outputPaths: record.outputPaths,
      });
      await this.persistTask(record, record.segments.length);
      this.emitTaskUpdated(record);
      this.emitProgress(record);
      this.emitTaskCompleted(record, record.outputPaths);

      return textTranslationIpcSuccess(record.task);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const abortReason = record.abortReason;
      this.patchTask(record, {
        status: aborted
          ? abortReason === "pause"
            ? "paused"
            : "cancelled"
          : "failed",
        phase: "translating",
      });
      await this.appendStatusChanged(record);
      await this.persistTask(record, record.segments.length);
      const failure = this.errorToFailure(error);
      this.emitTaskUpdated(record);
      this.emitTaskFailed(record, failure.error);
      return failure;
    } finally {
      record.controller = undefined;
      record.abortReason = undefined;
    }
  }

  async pauseTask(
    request: PauseTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    const record = this.tasks.get(request.taskId);
    if (!record) return this.taskNotFound(request.taskId);
    const guard = this.requireStatus(record, ["running"]);
    if (!guard.ok) return guard;
    record.abortReason = "pause";
    record.controller?.abort();
    this.scheduler.cancelWaiting(request.taskId);
    this.patchTask(record, { status: "paused" });
    await this.appendStatusChanged(record);
    await this.persistTask(record, record.segments?.length ?? 0);
    this.emitTaskUpdated(record);
    return textTranslationIpcSuccess(record.task);
  }

  async cancelTask(
    request: CancelTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    const record = this.tasks.get(request.taskId);
    if (!record) return this.taskNotFound(request.taskId);
    const guard = this.requireStatus(record, [
      "preparing",
      "waiting",
      "running",
      "paused",
      "failed",
      "partially_completed",
    ]);
    if (!guard.ok) return guard;
    record.abortReason = "cancel";
    record.controller?.abort();
    this.scheduler.cancelWaiting(request.taskId);
    this.patchTask(record, { status: "cancelled" });
    await this.appendStatusChanged(record);
    await this.persistTask(record, record.segments?.length ?? 0);
    this.emitTaskUpdated(record);
    return textTranslationIpcSuccess(record.task);
  }

  async resumeTask(
    request: ResumeTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    let record = this.tasks.get(request.taskId);
    if (!record) {
      if (!request.model) {
        return this.failure(
          "invalid_ipc_request",
          "Runtime model is required to resume a recovered task.",
        );
      }
      const recovered = await this.recoverRuntimeRecord(
        request.taskId,
        request.model,
      );
      if (!recovered.ok) return recovered;
      record = recovered.data;
      this.tasks.set(request.taskId, record);
    } else if (request.model) {
      record.model = request.model;
    }

    const guard = this.requireStatus(record, [
      "paused",
      "cancelled",
      "failed",
      "partially_completed",
      "waiting",
    ]);
    if (!guard.ok) return guard;
    if (!record.segments) {
      const recovered = await this.recoverRuntimeRecord(
        request.taskId,
        record.model,
      );
      if (!recovered.ok) return recovered;
      record = recovered.data;
      this.tasks.set(request.taskId, record);
    }

    const completedSegmentIds = new Set(
      (record.results ?? []).map((result) => result.segmentId),
    );
    return this.runResumeTranslation(record, completedSegmentIds);
  }

  async retranslateFromSegment(
    request: RetranslateTextTranslationFromSegmentRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    let record = this.tasks.get(request.taskId);
    if (!record) {
      if (!request.model) {
        return this.failure(
          "invalid_ipc_request",
          "Runtime model is required to retranslate a recovered task.",
        );
      }
      const recovered = await this.recoverRuntimeRecord(
        request.taskId,
        request.model,
      );
      if (!recovered.ok) return recovered;
      record = recovered.data;
      this.tasks.set(request.taskId, record);
    } else if (request.model) {
      record.model = request.model;
    }

    const guard = this.requireStatus(record, [
      "waiting",
      "paused",
      "cancelled",
      "failed",
      "partially_completed",
      "completed",
    ]);
    if (!guard.ok) return guard;
    if (record.task.options.executionMode !== "sequential_context") {
      return this.failure(
        "invalid_ipc_request",
        "Retranslation from a segment is available only for sequential-context tasks.",
      );
    }
    if (!record.segments) {
      const recovered = await this.recoverRuntimeRecord(
        request.taskId,
        record.model,
      );
      if (!recovered.ok) return recovered;
      record = recovered.data;
      this.tasks.set(request.taskId, record);
    }
    if (!record.segments) {
      return this.failure("invalid_ipc_request", "Task has no segment plan.");
    }

    const targetIndex = record.segments.findIndex(
      (segment) => segment.segmentId === request.segmentId,
    );
    if (targetIndex < 0) {
      return this.failure(
        "invalid_ipc_request",
        `Segment not found: ${request.segmentId}`,
      );
    }

    const restored = await this.restoreMemoryBeforeSegment(record, targetIndex);
    if (!restored.ok) return restored;

    const staleSegments = record.segments.slice(targetIndex);
    for (const segment of staleSegments) {
      await this.appendEvent(record.task.taskId, {
        type: "segment_stale",
        taskId: record.task.taskId,
        sequence: this.nextSequence(record.task.taskId),
        occurredAt: new Date().toISOString(),
        segmentId: segment.segmentId,
        reason: `retranslate_from:${request.segmentId}`,
      });
    }

    const validSegmentIds = new Set(
      record.segments
        .slice(0, targetIndex)
        .map((segment) => segment.segmentId),
    );
    record.results = (record.results ?? []).filter((result) =>
      validSegmentIds.has(result.segmentId),
    );
    record.failedSegmentIds = [];
    record.outputPaths = [];
    record.staleFromSegmentId = request.segmentId;
    this.patchTask(record, {
      status: "waiting",
      phase: "translating",
      progress: this.createProgress(
        "translating",
        record.segments.length,
        record.results.length,
        [],
        record.task.progress.estimatedInputTokens,
      ),
    });
    await this.appendStatusChanged(record);
    await this.persistTask(record, record.segments.length);
    this.emitTaskUpdated(record);
    this.emitProgress(record);

    return this.runResumeTranslation(record, validSegmentIds);
  }

  async restartTask(
    request: RestartTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    let record = this.tasks.get(request.taskId);
    if (!record) {
      if (!request.model) {
        return this.failure(
          "invalid_ipc_request",
          "Runtime model is required to restart a recovered task.",
        );
      }
      const recovered = await this.recoverRuntimeRecord(
        request.taskId,
        request.model,
      );
      if (!recovered.ok) return recovered;
      record = recovered.data;
    } else if (request.model) {
      record.model = request.model;
    }

    const guard = this.requireStatus(record, [
      "paused",
      "cancelled",
      "failed",
      "partially_completed",
      "completed",
      "waiting",
    ]);
    if (!guard.ok) return guard;

    await this.repository.deleteWorkspace(request.taskId);
    record.task = {
      ...record.task,
      status: "not_started",
      phase: "idle",
      progress: this.createProgress("idle", 0, 0, []),
      workspacePath: this.repository.getTaskWorkspacePath(request.taskId),
      updatedAt: new Date().toISOString(),
    };
    record.units = undefined;
    record.segments = undefined;
    record.results = [];
    record.failedSegmentIds = [];
    record.staleFromSegmentId = undefined;
    record.outputPaths = [];
    this.tasks.set(request.taskId, record);
    await this.repository.ensureWorkspace(request.taskId);
    await this.repository.writeFilesIndex(request.taskId, record.task.files);
    await this.persistTask(record, 0);
    await this.appendStatusChanged(record);
    this.emitTaskUpdated(record);
    return textTranslationIpcSuccess(record.task);
  }

  async deleteTask(
    request: DeleteTextTranslationTaskRequest,
  ): Promise<TextTranslationIpcResult<DeleteTextTranslationTaskResult>> {
    const record = this.tasks.get(request.taskId);
    if (record?.task.status === "running" || record?.task.status === "preparing") {
      return this.failure(
        "invalid_ipc_request",
        "Running text translation tasks must be cancelled before deletion.",
      );
    }
    this.tasks.delete(request.taskId);
    if (request.deleteWorkspace !== false) {
      await this.repository.deleteWorkspace(request.taskId);
    }
    return textTranslationIpcSuccess({
      taskId: request.taskId,
      deleted: true,
    });
  }

  async listRecoverableTasks(): Promise<
    TextTranslationIpcResult<TextTranslationRecoverySummary[]>
  > {
    const taskIds = await this.repository.listTaskIds();
    const summaries: TextTranslationRecoverySummary[] = [];

    for (const taskId of taskIds) {
      const summary = await this.inspectRecoverableTask(taskId);
      if (summary && summary.status !== "completed") {
        summaries.push(summary);
      }
    }

    return textTranslationIpcSuccess(summaries);
  }

  async getTaskDetail(
    request: GetTextTranslationTaskDetailRequest,
  ): Promise<TextTranslationIpcResult<TextTranslationTask | null>> {
    return textTranslationIpcSuccess(this.tasks.get(request.taskId)?.task ?? null);
  }

  async revealOutput(
    request: RevealTextTranslationOutputRequest,
  ): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>> {
    const record = this.tasks.get(request.taskId);
    return textTranslationIpcSuccess({
      taskId: request.taskId,
      revealed: Boolean(record?.outputPaths?.[0]),
      path: record?.outputPaths?.[0],
    });
  }

  async revealWorkspace(
    request: RevealTextTranslationWorkspaceRequest,
  ): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>> {
    return textTranslationIpcSuccess({
      taskId: request.taskId,
      revealed: true,
      path: this.repository.getTaskWorkspacePath(request.taskId),
    });
  }

  private async inspectRecoverableTask(
    taskId: string,
  ): Promise<TextTranslationRecoverySummary | null> {
    const task = await this.repository.readTask(taskId);
    if (!task) return null;

    const segments =
      await this.repository.readSegmentsIndex<PersistedTranslationSegment>(
        taskId,
      );
    const files = await this.repository.readFilesIndex(taskId);
    const fileById = new Map(files.map((file) => [file.fileId, file]));
    const segmentById = new Map(
      segments.map((segment) => [segment.segmentId, segment]),
    );
    const replayed = await this.repository.replayEvents(taskId);
    const validCompletedSegmentIds: string[] = [];

    for (const segmentId of replayed.completedSegmentIds) {
      try {
        const segment = segmentById.get(segmentId);
        const file = segment ? fileById.get(segment.fileId) : undefined;
        if (file?.format === "markdown") {
          assertMarkdownSegmentResult(
            await this.repository.readSegmentResultPayload<unknown>(
              taskId,
              segmentId,
            ),
            segmentId,
          );
        } else {
          await this.repository.readSegmentResult(taskId, segmentId);
        }
        validCompletedSegmentIds.push(segmentId);
      } catch {
        // A missing or corrupted result is treated as incomplete.
      }
    }

    const completedSet = new Set(validCompletedSegmentIds);
    let missingSourceSnapshots = 0;
    for (const segment of segments) {
      if (completedSet.has(segment.segmentId)) continue;
      try {
        const file = fileById.get(segment.fileId);
        if (file?.format === "markdown") {
          assertMarkdownSegmentPayload(
            await this.repository.readSegmentSourcePayload<unknown>(
              taskId,
              segment.segmentId,
            ),
            segment.segmentId,
          );
        } else {
          await this.repository.readSegmentSource(taskId, segment.segmentId);
        }
      } catch {
        missingSourceSnapshots += 1;
      }
    }
    for (const file of files) {
      if (file.format !== "markdown") continue;
      try {
        await this.repository.readFileSourceSnapshot(taskId, file.fileId);
      } catch {
        missingSourceSnapshots += 1;
      }
    }

    const sourceStatus = await this.resolveSourceStatus(task.sourceFingerprint[0]);
    const totalSegmentCount = task.segmentCount || segments.length;
    const blockingReason =
      totalSegmentCount === 0
        ? "missing_segment_index"
        : missingSourceSnapshots > 0
          ? "missing_source_snapshot"
          : undefined;

    return {
      taskId,
      workspacePath: this.repository.getTaskWorkspacePath(taskId),
      status: replayed.status ?? task.status,
      resumable: !blockingReason && task.status !== "completed",
      completedSegmentCount: validCompletedSegmentIds.length,
      totalSegmentCount,
      failedSegmentIds: replayed.failedSegmentIds,
      staleFromSegmentId: task.staleFromSegmentId,
      blockingReason,
      sourceStatus,
    };
  }

  private async recoverRuntimeRecord(
    taskId: string,
    model: TextTranslationRuntimeModelConfig,
  ): Promise<TextTranslationIpcResult<RuntimeTaskRecord>> {
    const task = await this.repository.readTask(taskId);
    if (!task) {
      return this.failure(
        "invalid_ipc_request",
        `Text translation task metadata not found: ${taskId}`,
      );
    }

    const files = await this.repository.readFilesIndex(taskId);
    const fileById = new Map(files.map((file) => [file.fileId, file]));
    const persistedSegments =
      await this.repository.readSegmentsIndex<PersistedTranslationSegment>(
        taskId,
      );
    if (persistedSegments.length === 0) {
      return this.failure(
        "invalid_ipc_request",
        "Recovered task does not have a segment index.",
      );
    }

    const segments: TranslationSegment[] = [];
    for (const segment of persistedSegments) {
      const file = fileById.get(segment.fileId);
      const sourceText =
        file?.format === "markdown"
          ? summarizeMarkdownSegmentPayload(
              assertMarkdownSegmentPayload(
                await this.repository.readSegmentSourcePayload<unknown>(
                  taskId,
                  segment.segmentId,
                ),
                segment.segmentId,
              ),
            )
          : await this.repository.readSegmentSource(taskId, segment.segmentId);
      segments.push({
        ...segment,
        sourceText,
      });
    }

    const replayed = await this.repository.replayEvents(taskId);
    this.nextSequenceByTask.set(taskId, replayed.lastSequence + 1);
    const results: RuntimeTranslationSegmentResult[] = [];
    for (const segmentId of replayed.completedSegmentIds) {
      try {
        const segment = segments.find((item) => item.segmentId === segmentId);
        const file = segment ? fileById.get(segment.fileId) : undefined;
        if (file?.format === "markdown") {
          results.push(
            assertMarkdownSegmentResult(
              await this.repository.readSegmentResultPayload<unknown>(
                taskId,
                segmentId,
              ),
              segmentId,
            ),
          );
        } else {
          results.push({
            segmentId,
            translatedText: await this.repository.readSegmentResult(
              taskId,
              segmentId,
            ),
          });
        }
      } catch {
        // Missing result files are not considered completed.
      }
    }

    const status = replayed.status ?? task.status;
    const phase = replayed.phase ?? task.phase;
    const record: RuntimeTaskRecord = {
      task: {
        taskId: task.taskId,
        projectId: task.projectId,
        files,
        options: task.options,
        status,
        phase,
        progress: this.createProgress(
          phase,
          task.segmentCount || segments.length,
          results.length,
          [],
          sumSourceTokens(segments),
        ),
        workspacePath: this.repository.getTaskWorkspacePath(taskId),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      model,
      sourceFingerprint: task.sourceFingerprint,
      segments,
      results,
      failedSegmentIds: replayed.failedSegmentIds,
      staleFromSegmentId: task.staleFromSegmentId,
      outputPaths: replayed.taskOutputPaths,
    };

    return textTranslationIpcSuccess(record);
  }

  private async runResumeTranslation(
    record: RuntimeTaskRecord,
    completedSegmentIds: Set<string>,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    if (!record.segments) {
      return this.failure("invalid_ipc_request", "Task has no segment plan.");
    }

    const existingResults = record.results ?? [];
    const controller = new AbortController();
    record.controller = controller;
    record.abortReason = undefined;
    record.failedSegmentIds = [];

    try {
      this.patchTask(record, {
        status: "running",
        phase: "translating",
        progress: this.createProgress(
          "translating",
          record.segments.length,
          completedSegmentIds.size,
          [],
          record.task.progress.estimatedInputTokens ??
            sumSourceTokens(record.segments),
        ),
      });
      await this.appendStatusChanged(record);
      await this.persistTask(record, record.segments.length);
      this.emitTaskUpdated(record);
      this.emitProgress(record);

      const translated =
        record.task.options.executionMode === "sequential_context"
          ? await this.translateSegmentsSequential(
              record,
              controller.signal,
              completedSegmentIds,
            )
          : await this.translateSegments(
              record,
              controller.signal,
              completedSegmentIds,
            );
      const allResults = [...existingResults, ...translated.results];
      record.results = allResults;
      record.failedSegmentIds = translated.failures.map(
        (failure) => failure.segmentId,
      );

      if (translated.failures.length > 0) {
        const status = allResults.length > 0 ? "partially_completed" : "failed";
        this.patchTask(record, {
          status,
          phase: "translating",
          progress: this.createProgress(
            "translating",
            record.segments.length,
            allResults.length,
            [],
            record.task.progress.estimatedInputTokens,
          ),
        });
        await this.appendStatusChanged(record);
        await this.persistTask(record, record.segments.length);
        this.emitTaskUpdated(record);
        this.emitProgress(record);
        if (status === "failed") {
          const failure = this.failure(
            "internal_error",
            "All remaining text translation segments failed.",
          );
          this.emitTaskFailed(record, failure.error);
          return failure;
        }
        return textTranslationIpcSuccess(record.task);
      }

      const completedIds = new Set(allResults.map((result) => result.segmentId));
      if (completedIds.size < record.segments.length) {
        this.patchTask(record, {
          status: "partially_completed",
          phase: "translating",
          progress: this.createProgress(
            "translating",
            record.segments.length,
            allResults.length,
            [],
            record.task.progress.estimatedInputTokens,
          ),
        });
        await this.appendStatusChanged(record);
        await this.persistTask(record, record.segments.length);
        this.emitTaskUpdated(record);
        this.emitProgress(record);
        return textTranslationIpcSuccess(record.task);
      }

      record.staleFromSegmentId = undefined;
      this.patchTask(record, { phase: "assembling_outputs" });
      record.outputPaths = await this.writeTaskOutputs(record, allResults);
      this.patchTask(record, {
        status: "completed",
        phase: "completed",
        progress: this.createProgress(
          "completed",
          record.segments.length,
          record.segments.length,
          [],
          record.task.progress.estimatedInputTokens,
        ),
      });
      await this.appendEvent(record.task.taskId, {
        type: "task_completed",
        taskId: record.task.taskId,
        sequence: this.nextSequence(record.task.taskId),
        occurredAt: new Date().toISOString(),
        outputPaths: record.outputPaths,
      });
      await this.persistTask(record, record.segments.length);
      this.emitTaskUpdated(record);
      this.emitProgress(record);
      this.emitTaskCompleted(record, record.outputPaths);
      return textTranslationIpcSuccess(record.task);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const abortReason = record.abortReason;
      this.patchTask(record, {
        status: aborted
          ? abortReason === "pause"
            ? "paused"
            : "cancelled"
          : "failed",
        phase: "translating",
      });
      await this.appendStatusChanged(record);
      await this.persistTask(record, record.segments.length);
      const failure = this.errorToFailure(error);
      this.emitTaskUpdated(record);
      this.emitTaskFailed(record, failure.error);
      return failure;
    } finally {
      record.controller = undefined;
      record.abortReason = undefined;
    }
  }

  private async translateSegments(
    record: RuntimeTaskRecord,
    signal: AbortSignal,
    skipSegmentIds = new Set<string>(),
  ): Promise<TranslateSegmentsResult> {
    const allSegments = record.segments ?? [];
    const segments = allSegments.filter(
      (segment) => !skipSegmentIds.has(segment.segmentId),
    );
    const results: RuntimeTranslationSegmentResult[] = [];
    const failures: TranslationSegmentFailure[] = [];
    let completedSegments = skipSegmentIds.size;

    await Promise.all(
      segments.map(async (segment) => {
        let release: (() => void) | undefined;

        try {
          release = await this.scheduler.acquire({
            taskId: record.task.taskId,
            executionMode: record.task.options.executionMode,
            signal,
          });
          await this.appendEvent(record.task.taskId, {
            type: "segment_started",
            taskId: record.task.taskId,
            sequence: this.nextSequence(record.task.taskId),
            occurredAt: new Date().toISOString(),
            segmentId: segment.segmentId,
          });

          const file = record.task.files.find(
            (item) => item.fileId === segment.fileId,
          );
          if (!file) {
            throw new Error(
              `Translation segment references an unknown file: ${segment.fileId}`,
            );
          }

          let result: RuntimeTranslationSegmentResult;
          let resultPath: string;
          let usage: OpenAICompatibleUsage | undefined;
          if (file.format === "markdown") {
            const payload = assertMarkdownSegmentPayload(
              await this.repository.readSegmentSourcePayload<unknown>(
                record.task.taskId,
                segment.segmentId,
              ),
              segment.segmentId,
            );
            const translated = await this.translateMarkdownSegment(
              record,
              payload,
              signal,
            );
            result = translated.result;
            usage = translated.usage;
            resultPath = await this.repository.writeSegmentResultPayload(
              record.task.taskId,
              segment.segmentId,
              result,
            );
          } else {
            const response = await sendOpenAICompatibleChatCompletion({
              endpoint: record.model.endpoint,
              apiKey: record.model.apiKey,
              model: record.model.modelKey,
              signal,
              messages: [
                {
                  role: "system",
                  content:
                    "Translate the provided text. Return only the translation.",
                },
                { role: "user", content: segment.sourceText },
              ],
            });
            result = {
              segmentId: segment.segmentId,
              translatedText: response.content,
            };
            usage = response.usage;
            resultPath = await this.repository.writeSegmentResult(
              record.task.taskId,
              segment.segmentId,
              response.content,
            );
          }
          await this.appendEvent(record.task.taskId, {
            type: "segment_completed",
            taskId: record.task.taskId,
            sequence: this.nextSequence(record.task.taskId),
            occurredAt: new Date().toISOString(),
            segmentId: segment.segmentId,
            resultPath,
            usage: toWorkspaceUsage(usage),
          });

          results.push(result);
          completedSegments += 1;
          this.patchTask(record, {
            progress: this.createProgress(
              "translating",
              allSegments.length,
              completedSegments,
              [],
              record.task.progress.estimatedInputTokens,
            ),
          });
          this.emitProgress(record);
        } catch (error) {
          if (signal.aborted) throw error;
          const failure = toSegmentFailure(segment.segmentId, error);
          failures.push(failure);
          await this.appendEvent(record.task.taskId, {
            type: "segment_failed",
            taskId: record.task.taskId,
            sequence: this.nextSequence(record.task.taskId),
            occurredAt: new Date().toISOString(),
            segmentId: segment.segmentId,
            errorCode: failure.errorCode,
          });
        } finally {
          release?.();
        }
      }),
    );

    return { results, failures };
  }

  private async translateMarkdownSegment(
    record: RuntimeTaskRecord,
    payload: MarkdownSegmentPayload,
    signal: AbortSignal,
  ): Promise<{
    result: MarkdownSegmentResult;
    usage?: OpenAICompatibleUsage;
  }> {
    const basePrompt =
      payload.kind === "markdown_target_only"
        ? buildMarkdownTargetOnlyTranslationPrompt({
            sourceLang: record.task.options.sourceLang,
            targetLang: record.task.options.targetLang,
            protocolId: payload.segmentId,
            units: payload.units,
            documentBackground: record.task.options.documentBackground,
            translationInstructions:
              record.task.options.translationInstructions,
            styleInstructions: record.task.options.styleInstructions,
            glossaryText: formatGlossary(record.task.options.glossary),
          })
        : buildMarkdownBilingualTranslationPrompt({
            sourceLang: record.task.options.sourceLang,
            targetLang: record.task.options.targetLang,
            protocolId: payload.segmentId,
            blocks: payload.blocks.map((item) => ({
              blockId: item.blockId,
              sourceText: item.sourceText,
              placeholders: item.placeholders,
            })),
            documentBackground: record.task.options.documentBackground,
            translationInstructions:
              record.task.options.translationInstructions,
            styleInstructions: record.task.options.styleInstructions,
            glossaryText: formatGlossary(record.task.options.glossary),
          });
    let prompt = basePrompt;

    for (let protocolAttempt = 0; protocolAttempt < 2; protocolAttempt += 1) {
      const response = await sendOpenAICompatibleChatCompletion({
        endpoint: record.model.endpoint,
        apiKey: record.model.apiKey,
        model: record.model.modelKey,
        signal,
        messages: [
          {
            role: "system",
            content:
              "Translate Markdown while preserving the required FusionKit protocol and protected placeholders exactly.",
          },
          { role: "user", content: prompt },
        ],
      });

      try {
        const result: MarkdownSegmentResult =
          payload.kind === "markdown_target_only"
            ? {
                schemaVersion: 1,
                kind: "markdown_target_only",
                segmentId: payload.segmentId,
                results: parseMarkdownTargetOnlyTranslationResponse({
                  text: response.content,
                  finishReason: response.finishReason,
                  protocolId: payload.segmentId,
                  expectedUnits: payload.units,
                }).results,
              }
            : {
                schemaVersion: 1,
                kind: "markdown_bilingual",
                segmentId: payload.segmentId,
                translations: parseMarkdownBilingualTranslationResponse({
                  text: response.content,
                  finishReason: response.finishReason,
                  protocolId: payload.segmentId,
                  expectedBlocks: payload.blocks.map((item) => ({
                    blockId: item.blockId,
                    sourceText: item.sourceText,
                    placeholders: item.placeholders,
                  })),
                }).translations,
              };

        return { result, usage: response.usage };
      } catch (error) {
        if (
          !(error instanceof TranslationProtocolError) ||
          !error.retryable ||
          protocolAttempt > 0
        ) {
          throw error;
        }
        prompt = [
          basePrompt,
          "",
          "Retry correction:",
          error.retryInstruction ??
            "The previous response did not match the required Markdown item boundaries or expected ids. Return the exact protocol with every expected item exactly once and in order.",
        ].join("\n");
      }
    }

    throw new Error(`Markdown translation failed: ${payload.segmentId}`);
  }

  private async restoreMemoryBeforeSegment(
    record: RuntimeTaskRecord,
    targetIndex: number,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    if (!record.segments) {
      return this.failure("invalid_ipc_request", "Task has no segment plan.");
    }

    if (targetIndex === 0) {
      await this.memoryManager.initialize(record.task.taskId, {
        glossary: record.task.options.glossary,
        documentBackground: record.task.options.documentBackground,
        styleInstructions: record.task.options.styleInstructions,
      });
      return textTranslationIpcSuccess(record.task);
    }

    const previousSegment = record.segments[targetIndex - 1];
    const replayed = await this.repository.replayEvents(record.task.taskId);
    const previousMemoryVersion =
      replayed.segmentMemoryVersions[previousSegment.segmentId]?.memoryVersion;
    if (previousMemoryVersion === undefined) {
      return this.failure(
        "invalid_ipc_request",
        "Cannot retranslate because the previous segment memory version is missing.",
      );
    }

    const snapshotId = createSemanticMemorySnapshotId({
      kind: "periodic",
      segmentId: previousSegment.segmentId,
      version: previousMemoryVersion,
    });
    const snapshot = await this.repository.readMemorySnapshot<SemanticMemory>(
      record.task.taskId,
      snapshotId,
    );
    if (!snapshot) {
      return this.failure(
        "invalid_ipc_request",
        `Cannot retranslate because memory snapshot is missing: ${snapshotId}`,
      );
    }

    await this.repository.writeMemoryLatest(record.task.taskId, snapshot);
    return textTranslationIpcSuccess(record.task);
  }

  private async translateSegmentsSequential(
    record: RuntimeTaskRecord,
    signal: AbortSignal,
    completedSegmentIds = new Set<string>(),
  ): Promise<TranslateSegmentsResult> {
    const allSegments = record.segments ?? [];
    const startIndex = allSegments.findIndex(
      (segment) => !completedSegmentIds.has(segment.segmentId),
    );
    if (startIndex < 0) return { results: [], failures: [] };

    const results: TextTranslationSegmentResult[] = [];
    const failures: TranslationSegmentFailure[] = [];
    const resultBySegmentId = new Map(
      (record.results ?? [])
        .filter(isTextTranslationSegmentResult)
        .map((result) => [result.segmentId, result]),
    );
    let completedSegments = completedSegmentIds.size;
    let recentSourceText = "";
    let recentTranslatedText = "";

    for (let index = startIndex - 1; index >= 0; index -= 1) {
      const previousSegment = allSegments[index];
      const previousResult = resultBySegmentId.get(previousSegment.segmentId);
      if (previousResult) {
        recentSourceText = tailText(previousSegment.sourceText);
        recentTranslatedText = tailText(previousResult.translatedText);
        break;
      }
    }

    for (let index = startIndex; index < allSegments.length; index += 1) {
      const segment = allSegments[index];
      let release: (() => void) | undefined;

      try {
        release = await this.scheduler.acquire({
          taskId: record.task.taskId,
          executionMode: record.task.options.executionMode,
          signal,
        });
        await this.appendEvent(record.task.taskId, {
          type: "segment_started",
          taskId: record.task.taskId,
          sequence: this.nextSequence(record.task.taskId),
          occurredAt: new Date().toISOString(),
          segmentId: segment.segmentId,
        });

        if (shouldResetMemoryBeforeSegment(record, segment)) {
          await this.memoryManager.initialize(record.task.taskId, {
            glossary: record.task.options.glossary,
            documentBackground: record.task.options.documentBackground,
            styleInstructions: record.task.options.styleInstructions,
          });
          recentSourceText = "";
          recentTranslatedText = "";
        }
        const latestMemory =
          (await this.memoryManager.loadLatest(record.task.taskId)) ??
          (await this.memoryManager.initialize(record.task.taskId, {
            glossary: record.task.options.glossary,
            documentBackground: record.task.options.documentBackground,
            styleInstructions: record.task.options.styleInstructions,
          }));
        const trimmedMemory = trimSemanticMemoryToBudget(
          latestMemory,
          record.task.options.semanticMemoryTokenLimit,
        ).memory;
        const response = await sendOpenAICompatibleChatCompletion({
          endpoint: record.model.endpoint,
          apiKey: record.model.apiKey,
          model: record.model.modelKey,
          signal,
          messages: [
            {
              role: "system",
              content:
                "Translate long-form prose with continuity. Return only the required FusionKit sequential protocol.",
            },
            {
              role: "user",
              content: buildSequentialTranslationPrompt({
                sourceLang: record.task.options.sourceLang,
                targetLang: record.task.options.targetLang,
                protocolId: segment.segmentId,
                memoryJson: JSON.stringify(trimmedMemory),
                sourceText: segment.sourceText,
                recentSourceText,
                recentTranslatedText,
                documentBackground: record.task.options.documentBackground,
                translationInstructions:
                  record.task.options.translationInstructions,
                styleInstructions: record.task.options.styleInstructions,
                glossaryText: formatGlossary(record.task.options.glossary),
              }),
            },
          ],
        });
        const parsed = parseSequentialTranslationResponse({
          text: response.content,
          finishReason: response.finishReason,
          protocolId: segment.segmentId,
        });

        for (const warning of parsed.warnings) {
          await this.appendMemoryWarning(record, warning);
        }

        let outputMemoryVersion = latestMemory.version;
        if (parsed.memoryPatch) {
          const patchResult = await this.memoryManager.applyPatch(
            record.task.taskId,
            parsed.memoryPatch,
            {
              updatedAfterSegmentId: segment.segmentId,
              snapshot: {
                kind: "periodic",
                segmentId: segment.segmentId,
              },
            },
          );
          outputMemoryVersion = patchResult.memory.version;
          for (const warning of patchResult.warnings) {
            await this.appendMemoryWarning(record, warning);
          }
        }

        const resultPath = await this.repository.writeSegmentResult(
          record.task.taskId,
          segment.segmentId,
          parsed.translatedText,
        );
        await this.appendEvent(record.task.taskId, {
          type: "segment_completed",
          taskId: record.task.taskId,
          sequence: this.nextSequence(record.task.taskId),
          occurredAt: new Date().toISOString(),
          segmentId: segment.segmentId,
          resultPath,
          inputMemoryVersion: latestMemory.version,
          memoryVersion: outputMemoryVersion,
          usage: toWorkspaceUsage(response.usage),
        });
        await this.writeFileEndMemorySnapshotIfNeeded(
          record,
          segment,
          allSegments[index + 1],
        );

        const result = {
          segmentId: segment.segmentId,
          translatedText: parsed.translatedText,
        };
        results.push(result);
        resultBySegmentId.set(segment.segmentId, result);
        recentSourceText = tailText(segment.sourceText);
        recentTranslatedText = tailText(parsed.translatedText);
        completedSegments += 1;
        this.patchTask(record, {
          progress: this.createProgress(
            "translating",
            allSegments.length,
            completedSegments,
            [],
            record.task.progress.estimatedInputTokens,
          ),
        });
        this.emitProgress(record);
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = toSegmentFailure(segment.segmentId, error);
        failures.push(failure);
        await this.appendEvent(record.task.taskId, {
          type: "segment_failed",
          taskId: record.task.taskId,
          sequence: this.nextSequence(record.task.taskId),
          occurredAt: new Date().toISOString(),
          segmentId: segment.segmentId,
          errorCode: failure.errorCode,
        });
        break;
      } finally {
        release?.();
      }
    }

    return { results, failures };
  }

  private async appendMemoryWarning(
    record: RuntimeTaskRecord,
    warning: SemanticMemoryWarning,
  ): Promise<void> {
    await this.appendEvent(record.task.taskId, {
      type: "warning",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      warningCode: warning.code,
      message: warning.message,
    });
  }

  private async writeTaskOutputs(
    record: RuntimeTaskRecord,
    results: RuntimeTranslationSegmentResult[],
  ): Promise<string[]> {
    const segments = record.segments ?? [];
    const outputPaths: string[] = [];
    const orderedFiles = [...record.task.files].sort(
      (left, right) => left.order - right.order,
    );

    for (const file of orderedFiles) {
      const fileSegments = segments.filter(
        (segment) => segment.fileId === file.fileId,
      );
      if (fileSegments.length === 0 && file.format === "txt") continue;
      const fileSegmentIds = new Set(
        fileSegments.map((segment) => segment.segmentId),
      );
      const outputDir = resolveOutputDirForFile(
        record.task.options.outputDir,
        file.relativePath,
      );
      const output =
        file.format === "markdown"
          ? await this.writeMarkdownFileOutput({
              record,
              file,
              fileSegments,
              results: results
                .filter(isMarkdownSegmentResult)
                .filter((result) => fileSegmentIds.has(result.segmentId)),
              outputDir,
            })
          : await writeTxtOutput({
              sourcePath: file.sourcePath,
              targetLang: record.task.options.targetLang,
              outputMode: record.task.options.outputMode,
              labelMode: record.task.options.bilingualLabelMode,
              outputPathMode: record.task.options.outputPathMode,
              outputDir,
              conflictPolicy: record.task.options.conflictPolicy,
              segments: fileSegments,
              results: results
                .filter(isTextTranslationSegmentResult)
                .filter((result) => fileSegmentIds.has(result.segmentId)),
            });
      outputPaths.push(output.outputPath);
      this.emitFileCompleted(record, file.fileId, output.outputPath);
    }

    return outputPaths;
  }

  private async writeMarkdownFileOutput(input: {
    record: RuntimeTaskRecord;
    file: TextTranslationTask["files"][number];
    fileSegments: TranslationSegment[];
    results: MarkdownSegmentResult[];
    outputDir?: string;
  }): Promise<{ outputPath: string; bytesWritten: number }> {
    const sourceText = await this.repository.readFileSourceSnapshot(
      input.record.task.taskId,
      input.file.fileId,
    );
    const commonOutputOptions = {
      sourcePath: input.file.sourcePath,
      targetLang: input.record.task.options.targetLang,
      outputPathMode: input.record.task.options.outputPathMode,
      outputDir: input.outputDir,
      conflictPolicy: input.record.task.options.conflictPolicy,
    };

    if (input.record.task.options.outputMode === "target_only") {
      const units = await this.repository.readUnits<TranslationUnit>(
        input.record.task.taskId,
        input.file.fileId,
      );
      const unitResults = input.results.flatMap((result) => {
        if (result.kind !== "markdown_target_only") {
          throw new Error(
            `Unexpected Markdown result kind for target-only output: ${result.kind}`,
          );
        }
        return result.results;
      });
      return writeMarkdownTargetOnlyOutput({
        ...commonOutputOptions,
        sourceText,
        units,
        results: unitResults,
      });
    }

    const blocks: MarkdownBilingualBlock[] = [];
    for (const segment of input.fileSegments) {
      const payload = assertMarkdownSegmentPayload(
        await this.repository.readSegmentSourcePayload<unknown>(
          input.record.task.taskId,
          segment.segmentId,
        ),
        segment.segmentId,
      );
      if (payload.kind !== "markdown_bilingual") {
        throw new Error(
          `Unexpected Markdown payload kind for bilingual output: ${payload.kind}`,
        );
      }
      blocks.push(...payload.blocks.map((item) => item.block));
    }
    const translations = input.results.flatMap((result) => {
      if (result.kind !== "markdown_bilingual") {
        throw new Error(
          `Unexpected Markdown result kind for bilingual output: ${result.kind}`,
        );
      }
      return result.translations;
    });

    return writeMarkdownBilingualOutput({
      ...commonOutputOptions,
      sourceText,
      blocks,
      translations,
    });
  }

  private async writeFileEndMemorySnapshotIfNeeded(
    record: RuntimeTaskRecord,
    segment: TranslationSegment,
    nextSegment: TranslationSegment | undefined,
  ): Promise<void> {
    if (record.task.options.executionMode !== "sequential_context") return;
    if (nextSegment && nextSegment.fileId === segment.fileId) return;

    const latest = await this.memoryManager.loadLatest(record.task.taskId);
    if (!latest) return;
    await this.repository.writeMemorySnapshot(
      record.task.taskId,
      createSemanticMemorySnapshotId({
        kind: "file_end",
        segmentId: segment.segmentId,
        version: latest.version,
      }),
      latest,
    );
  }

  private patchTask(
    record: RuntimeTaskRecord,
    patch: Partial<
      Pick<TextTranslationTask, "status" | "phase" | "progress" | "workspacePath">
    >,
  ): void {
    record.task = {
      ...record.task,
      ...patch,
      updatedAt: new Date().toISOString(),
      workspacePath: this.repository.getTaskWorkspacePath(record.task.taskId),
    };
  }

  private createProgress(
    phase: TextTranslationProgress["phase"],
    totalSegments: number,
    completedSegments: number,
    activeSegmentIds: string[],
    estimatedInputTokens?: number,
  ): TextTranslationProgress {
    return {
      phase,
      completedFiles: phase === "completed" ? 1 : 0,
      totalFiles: 1,
      completedSegments,
      totalSegments,
      activeSegmentIds,
      estimatedInputTokens,
      percentage:
        totalSegments === 0
          ? 0
          : Math.round((completedSegments / totalSegments) * 100),
    };
  }

  private async persistTask(
    record: RuntimeTaskRecord,
    segmentCount: number,
  ): Promise<void> {
    await this.repository.writeTask(
      createPersistedTextTranslationTask({
        task: record.task,
        sourceFingerprint: record.sourceFingerprint,
        segmentCount,
        completedSegmentCount: record.task.progress.completedSegments,
        failedSegmentIds: record.failedSegmentIds ?? [],
        staleFromSegmentId: record.staleFromSegmentId,
      }),
    );
  }

  private async appendEvent(
    taskId: string,
    event: TextTranslationWorkspaceEvent,
  ): Promise<void> {
    await this.repository.appendEvent(taskId, event);
  }

  private async appendStatusChanged(
    record: RuntimeTaskRecord,
  ): Promise<void> {
    await this.appendEvent(record.task.taskId, {
      type: "task_status_changed",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      status: record.task.status,
      phase: record.task.phase,
    });
  }

  private async resolveSourceStatus(
    fingerprint: SourceFingerprint | undefined,
  ): Promise<TextTranslationRecoverySummary["sourceStatus"]> {
    if (!fingerprint?.sourcePath) return "unchecked";
    try {
      const stat = await fs.stat(fingerprint.sourcePath);
      if (
        stat.size === fingerprint.sizeBytes &&
        Math.abs(stat.mtimeMs - fingerprint.modifiedAt) < 1
      ) {
        return "matched";
      }
      return "changed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      return "unchecked";
    }
  }

  private nextSequence(taskId: string): number {
    const next = this.nextSequenceByTask.get(taskId) ?? 0;
    this.nextSequenceByTask.set(taskId, next + 1);
    return next;
  }

  private taskNotFound(
    taskId: string,
  ): Promise<TextTranslationIpcResult<TextTranslationTask>> {
    return Promise.resolve(
      this.failure("invalid_ipc_request", `Text translation task not found: ${taskId}`),
    );
  }

  private requireStatus(
    record: RuntimeTaskRecord,
    allowedStatuses: TextTranslationTask["status"][],
  ): TextTranslationIpcResult<TextTranslationTask> {
    if (allowedStatuses.includes(record.task.status)) {
      return textTranslationIpcSuccess(record.task);
    }
    return this.failure(
      "invalid_ipc_request",
      `Cannot run this action while task status is ${record.task.status}.`,
    );
  }

  private errorToFailure<T = TextTranslationTask>(
    error: unknown,
  ): Extract<TextTranslationIpcResult<T>, { ok: false }> {
    return this.failure(
      "internal_error",
      error instanceof Error ? error.message : "Text translation task failed.",
    );
  }

  private failure<T = never>(
    code: "invalid_ipc_request" | "not_implemented" | "internal_error",
    message: string,
  ): Extract<TextTranslationIpcResult<T>, { ok: false }> {
    return textTranslationIpcFailure({ code, message }) as Extract<
      TextTranslationIpcResult<T>,
      { ok: false }
    >;
  }

  private emitTaskUpdated(record: RuntimeTaskRecord): void {
    this.eventSink?.({
      type: "task-updated",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      task: record.task,
    });
  }

  private emitProgress(record: RuntimeTaskRecord): void {
    this.eventSink?.({
      type: "progress",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      progress: record.task.progress,
    });
  }

  private emitFileCompleted(
    record: RuntimeTaskRecord,
    fileId: string,
    outputPath: string,
  ): void {
    this.eventSink?.({
      type: "file-completed",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      fileId,
      outputPath,
    });
  }

  private emitTaskCompleted(
    record: RuntimeTaskRecord,
    outputPaths: string[],
  ): void {
    this.eventSink?.({
      type: "task-completed",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      task: record.task,
      outputPaths,
    });
  }

  private emitTaskFailed(
    record: RuntimeTaskRecord,
    error: Extract<TextTranslationIpcResult<never>, { ok: false }>["error"],
  ): void {
    this.eventSink?.({
      type: "task-failed",
      taskId: record.task.taskId,
      sequence: this.nextSequence(record.task.taskId),
      occurredAt: new Date().toISOString(),
      error,
    });
  }
}

interface PreparedTranslationFile {
  file: TextTranslationDecodedInputFile["file"];
  sourceText: string;
  units: TranslationUnit[];
  segments: TranslationSegment[];
  markdownPayloads: MarkdownSegmentPayload[];
}

function prepareDecodedTranslationFile(input: {
  decoded: TextTranslationDecodedInputFile;
  outputMode: TextTranslationTask["options"]["outputMode"];
  sliceTokenLimit: number;
  startingGlobalIndex: number;
}): PreparedTranslationFile {
  if (input.decoded.file.format === "txt") {
    const units = parseTxtTranslationUnits({
      fileId: input.decoded.file.fileId,
      text: input.decoded.text,
      maxUnitTokens: input.sliceTokenLimit,
    });
    return {
      file: input.decoded.file,
      sourceText: input.decoded.text,
      units,
      segments: planTranslationSegments({
        fileId: input.decoded.file.fileId,
        units,
        sliceTokenLimit: input.sliceTokenLimit,
        startingGlobalIndex: input.startingGlobalIndex,
      }),
      markdownPayloads: [],
    };
  }

  const parsed = parseMarkdownTranslationUnits({
    fileId: input.decoded.file.fileId,
    text: input.decoded.text,
  });
  if (input.outputMode === "target_only") {
    const segments = planTranslationSegments({
      fileId: input.decoded.file.fileId,
      units: parsed.units,
      sliceTokenLimit: input.sliceTokenLimit,
      startingGlobalIndex: input.startingGlobalIndex,
    });
    const unitById = new Map(
      parsed.units.map((unit) => [unit.unitId, unit]),
    );
    const markdownPayloads = segments.map((segment) => {
      const units = segment.unitIds.map((unitId) => {
        const unit = unitById.get(unitId);
        if (!unit) {
          throw new Error(`Markdown segment references unknown unit: ${unitId}`);
        }
        return createMarkdownExpectedUnit({
          sourceText: input.decoded.text,
          unit,
          protectedSpans: parsed.protectedSpans,
          placeholderScope: `${segment.segmentId}_${unit.unitId}`,
        });
      });
      const payload: MarkdownTargetOnlySegmentPayload = {
        schemaVersion: 1,
        kind: "markdown_target_only",
        segmentId: segment.segmentId,
        fileId: segment.fileId,
        units,
      };
      applyMarkdownPayloadToSegment(segment, payload);
      return payload;
    });

    return {
      file: input.decoded.file,
      sourceText: input.decoded.text,
      units: parsed.units,
      segments,
      markdownPayloads,
    };
  }

  const blocks = collectMarkdownBilingualBlocks(
    input.decoded.text,
    parsed.ast,
  );
  const blockPlanningUnits = blocks.map(
    (block, order): TranslationUnit => ({
      unitId: block.blockId,
      fileId: input.decoded.file.fileId,
      order,
      kind: resolveMarkdownBlockUnitKind(block),
      sourceStart: block.start,
      sourceEnd: block.end,
      sourceText: block.sourceText,
      translatable: true,
      tokenCount: countTextTokens(block.sourceText),
      structuralContext:
        block.quoteDepth > 1
          ? { quoteDepth: block.quoteDepth - 1 }
          : undefined,
    }),
  );
  const segments = planTranslationSegments({
    fileId: input.decoded.file.fileId,
    units: blockPlanningUnits,
    sliceTokenLimit: input.sliceTokenLimit,
    startingGlobalIndex: input.startingGlobalIndex,
  });
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  const markdownPayloads = segments.map((segment) => {
    const blockItems = segment.unitIds.map((blockId) => {
      const block = blockById.get(blockId);
      if (!block) {
        throw new Error(
          `Markdown segment references unknown bilingual block: ${blockId}`,
        );
      }
      return createMarkdownExpectedBlock({
        sourceText: input.decoded.text,
        block,
        protectedSpans: parsed.protectedSpans,
        placeholderScope: `${segment.segmentId}_${block.blockId}`,
      });
    });
    const payload: MarkdownBilingualSegmentPayload = {
      schemaVersion: 1,
      kind: "markdown_bilingual",
      segmentId: segment.segmentId,
      fileId: segment.fileId,
      blocks: blockItems,
    };
    applyMarkdownPayloadToSegment(segment, payload);
    return payload;
  });

  return {
    file: input.decoded.file,
    sourceText: input.decoded.text,
    units: parsed.units,
    segments,
    markdownPayloads,
  };
}

function createMarkdownExpectedUnit(input: {
  sourceText: string;
  unit: TranslationUnit;
  protectedSpans: MarkdownProtectedSpan[];
  placeholderScope: string;
}): MarkdownExpectedUnitTranslation {
  const tokenized = applyMarkdownRangePlaceholders({
    sourceText: input.sourceText,
    start: input.unit.sourceStart,
    end: input.unit.sourceEnd,
    protectedSpans: input.protectedSpans,
    placeholderScope: input.placeholderScope,
  });
  return {
    unitId: input.unit.unitId,
    sourceText: tokenized.text,
    ...(tokenized.placeholders.length > 0
      ? { placeholders: tokenized.placeholders }
      : {}),
  };
}

function createMarkdownExpectedBlock(input: {
  sourceText: string;
  block: MarkdownBilingualBlock;
  protectedSpans: MarkdownProtectedSpan[];
  placeholderScope: string;
}): MarkdownBilingualSegmentItem {
  const tokenized = applyMarkdownRangePlaceholders({
    sourceText: input.sourceText,
    start: input.block.start,
    end: input.block.end,
    protectedSpans: input.protectedSpans,
    placeholderScope: input.placeholderScope,
  });
  return {
    blockId: input.block.blockId,
    sourceText: tokenized.text,
    ...(tokenized.placeholders.length > 0
      ? { placeholders: tokenized.placeholders }
      : {}),
    block: input.block,
  };
}

function applyMarkdownRangePlaceholders(input: {
  sourceText: string;
  start: number;
  end: number;
  protectedSpans: MarkdownProtectedSpan[];
  placeholderScope: string;
}): { text: string; placeholders: ProtectedPlaceholder[] } {
  const rangeText = input.sourceText.slice(input.start, input.end);
  const containedSpans = input.protectedSpans
    .filter((span) => span.start >= input.start && span.end <= input.end)
    .map((span) => ({
      ...span,
      start: span.start - input.start,
      end: span.end - input.start,
    }));
  return applyProtectedPlaceholders({
    source: rangeText,
    spans: containedSpans,
    segmentId: input.placeholderScope,
  });
}

function applyMarkdownPayloadToSegment(
  segment: TranslationSegment,
  payload: MarkdownSegmentPayload,
): void {
  segment.sourceText = summarizeMarkdownSegmentPayload(payload);
  segment.sourceTokenCount = countTextTokens(segment.sourceText);
  segment.sourceTextSnapshotPath = path.posix.join(
    "segments",
    "source",
    `${segment.segmentId}.json`,
  );
}

function summarizeMarkdownSegmentPayload(
  payload: MarkdownSegmentPayload,
): string {
  return (
    payload.kind === "markdown_target_only"
      ? payload.units.map((unit) => unit.sourceText ?? "")
      : payload.blocks.map((block) => block.sourceText ?? "")
  ).join("\n\n");
}

function resolveMarkdownBlockUnitKind(
  block: MarkdownBilingualBlock,
): TranslationUnitKind {
  switch (block.nodeType) {
    case "heading":
      return "heading";
    case "list":
      return "list_item";
    case "blockquote":
      return "blockquote";
    case "table":
      return "table_cell";
    case "paragraph":
      return "paragraph";
    default:
      return "plain_text";
  }
}

function assertMarkdownSegmentPayload(
  value: unknown,
  expectedSegmentId: string,
): MarkdownSegmentPayload {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(
      `Invalid Markdown segment source payload: ${expectedSegmentId}`,
    );
  }
  if (
    value.segmentId !== expectedSegmentId ||
    typeof value.fileId !== "string"
  ) {
    throw new Error(
      `Markdown segment source payload identity mismatch: ${expectedSegmentId}`,
    );
  }
  if (value.kind === "markdown_target_only" && Array.isArray(value.units)) {
    return value as unknown as MarkdownTargetOnlySegmentPayload;
  }
  if (value.kind === "markdown_bilingual" && Array.isArray(value.blocks)) {
    return value as unknown as MarkdownBilingualSegmentPayload;
  }
  throw new Error(
    `Unsupported Markdown segment source payload: ${expectedSegmentId}`,
  );
}

function assertMarkdownSegmentResult(
  value: unknown,
  expectedSegmentId: string,
): MarkdownSegmentResult {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Invalid Markdown segment result: ${expectedSegmentId}`);
  }
  if (value.segmentId !== expectedSegmentId) {
    throw new Error(
      `Markdown segment result identity mismatch: ${expectedSegmentId}`,
    );
  }
  if (value.kind === "markdown_target_only" && Array.isArray(value.results)) {
    return value as unknown as MarkdownTargetOnlySegmentResult;
  }
  if (
    value.kind === "markdown_bilingual" &&
    Array.isArray(value.translations)
  ) {
    return value as unknown as MarkdownBilingualSegmentResult;
  }
  throw new Error(`Unsupported Markdown segment result: ${expectedSegmentId}`);
}

function isMarkdownSegmentResult(
  result: RuntimeTranslationSegmentResult,
): result is MarkdownSegmentResult {
  return (
    "kind" in result &&
    (result.kind === "markdown_target_only" ||
      result.kind === "markdown_bilingual")
  );
}

function isTextTranslationSegmentResult(
  result: RuntimeTranslationSegmentResult,
): result is TextTranslationSegmentResult {
  return "translatedText" in result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatGlossary(
  glossary: RuntimeTaskRecord["task"]["options"]["glossary"],
): string | undefined {
  if (!glossary || glossary.length === 0) return undefined;
  return glossary
    .map((entry) =>
      [entry.source, "=>", entry.target, entry.note ? `(${entry.note})` : ""]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");
}

function tailText(text: string, maxLength = 2_000): string {
  if (text.length <= maxLength) return text;
  return text.slice(-maxLength);
}

function resolveOutputDirForFile(
  outputDir: string | undefined,
  relativePath: string | undefined,
): string | undefined {
  if (!outputDir || !relativePath) return outputDir;
  const relativeDir = path.dirname(relativePath);
  if (!relativeDir || relativeDir === ".") return outputDir;
  return path.join(outputDir, relativeDir);
}

function shouldResetMemoryBeforeSegment(
  record: RuntimeTaskRecord,
  segment: TranslationSegment,
): boolean {
  const file = record.task.files.find((item) => item.fileId === segment.fileId);
  return (
    segment.indexInFile === 0 &&
    (Boolean(record.task.options.memoryResetFileIds?.includes(segment.fileId)) ||
      (file?.order !== undefined &&
        Boolean(record.task.options.memoryResetFileOrders?.includes(file.order))))
  );
}

function toWorkspaceUsage(
  usage: OpenAICompatibleUsage | undefined,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function withEncodingSummary(
  file: RuntimeTaskRecord["task"]["files"][number],
  encoding: {
    encoding: string;
    confidence: number;
  },
): RuntimeTaskRecord["task"]["files"][number] {
  return {
    ...file,
    detectedEncoding: encoding.encoding,
    encodingConfidence: encoding.confidence,
  };
}

function sumSourceTokens(
  segments: NonNullable<RuntimeTaskRecord["segments"]>,
): number {
  return segments.reduce((total, segment) => total + segment.sourceTokenCount, 0);
}

function toSegmentFailure(
  segmentId: string,
  error: unknown,
): TranslationSegmentFailure {
  const errorWithCode = error as { code?: unknown };
  return {
    segmentId,
    errorCode:
      typeof errorWithCode?.code === "string"
        ? errorWithCode.code
        : "segment_failed",
    message: error instanceof Error ? error.message : "Segment failed.",
  };
}
