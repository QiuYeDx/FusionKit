import type {
  CreateTextTranslationTaskRequest,
  TextTranslationPhase,
  TextTranslationProgress,
  TextTranslationRecoverySummary,
  TextTranslationRuntimeModelConfig,
  TextTranslationTask,
  TextTranslationValidationIssue,
} from "@/type/textTranslation";

export const TEXT_TRANSLATION_IPC_CHANNELS = {
  createTask: "text-translation:create-task",
  prepareTask: "text-translation:prepare-task",
  startTask: "text-translation:start-task",
  pauseTask: "text-translation:pause-task",
  cancelTask: "text-translation:cancel-task",
  resumeTask: "text-translation:resume-task",
  retranslateFromSegment: "text-translation:retranslate-from-segment",
  restartTask: "text-translation:restart-task",
  deleteTask: "text-translation:delete-task",
  listRecoverableTasks: "text-translation:list-recoverable-tasks",
  getTaskDetail: "text-translation:get-task-detail",
  revealOutput: "text-translation:reveal-output",
  revealWorkspace: "text-translation:reveal-workspace",
} as const;

export const TEXT_TRANSLATION_EVENT_CHANNELS = {
  taskUpdated: "text-translation:task-updated",
  progress: "text-translation:progress",
  fileCompleted: "text-translation:file-completed",
  taskCompleted: "text-translation:task-completed",
  taskFailed: "text-translation:task-failed",
  warning: "text-translation:warning",
} as const;

export type TextTranslationIpcChannel =
  (typeof TEXT_TRANSLATION_IPC_CHANNELS)[keyof typeof TEXT_TRANSLATION_IPC_CHANNELS];

export type TextTranslationEventChannel =
  (typeof TEXT_TRANSLATION_EVENT_CHANNELS)[keyof typeof TEXT_TRANSLATION_EVENT_CHANNELS];

export type TextTranslationIpcErrorCode =
  | "invalid_ipc_request"
  | "missing_task_id"
  | "full_text_payload_not_allowed"
  | "not_implemented"
  | "internal_error";

export interface TextTranslationIpcError {
  code: TextTranslationIpcErrorCode;
  message: string;
  phase?: TextTranslationPhase;
  field?: string;
  details?: Record<string, unknown>;
}

export type TextTranslationIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TextTranslationIpcError };

export interface TextTranslationTaskIdRequest {
  taskId: string;
}

export type PrepareTextTranslationTaskRequest = TextTranslationTaskIdRequest;
export type StartTextTranslationTaskRequest = TextTranslationTaskIdRequest;
export type PauseTextTranslationTaskRequest = TextTranslationTaskIdRequest;
export type CancelTextTranslationTaskRequest = TextTranslationTaskIdRequest;
export type GetTextTranslationTaskDetailRequest = TextTranslationTaskIdRequest;
export type RevealTextTranslationOutputRequest = TextTranslationTaskIdRequest;
export type RevealTextTranslationWorkspaceRequest = TextTranslationTaskIdRequest;

export interface RestartTextTranslationTaskRequest
  extends TextTranslationTaskIdRequest {
  model?: TextTranslationRuntimeModelConfig;
}

export interface ResumeTextTranslationTaskRequest
  extends TextTranslationTaskIdRequest {
  model?: TextTranslationRuntimeModelConfig;
}

export interface RetranslateTextTranslationFromSegmentRequest
  extends TextTranslationTaskIdRequest {
  segmentId: string;
  model?: TextTranslationRuntimeModelConfig;
}

export interface DeleteTextTranslationTaskRequest
  extends TextTranslationTaskIdRequest {
  deleteWorkspace?: boolean;
}

export interface DeleteTextTranslationTaskResult {
  taskId: string;
  deleted: boolean;
}

export interface RevealTextTranslationPathResult {
  taskId: string;
  revealed: boolean;
  path?: string;
}

export type TextTranslationEventType =
  | "task-updated"
  | "progress"
  | "file-completed"
  | "task-completed"
  | "task-failed"
  | "warning";

export interface TextTranslationEventBase {
  type: TextTranslationEventType;
  taskId: string;
  sequence: number;
  occurredAt: string;
}

export interface TextTranslationTaskUpdatedEvent
  extends TextTranslationEventBase {
  type: "task-updated";
  task: TextTranslationTask;
}

export interface TextTranslationProgressEvent extends TextTranslationEventBase {
  type: "progress";
  progress: TextTranslationProgress;
}

export interface TextTranslationFileCompletedEvent
  extends TextTranslationEventBase {
  type: "file-completed";
  fileId: string;
  outputPath: string;
}

export interface TextTranslationTaskCompletedEvent
  extends TextTranslationEventBase {
  type: "task-completed";
  task: TextTranslationTask;
  outputPaths: string[];
}

export interface TextTranslationTaskFailedEvent
  extends TextTranslationEventBase {
  type: "task-failed";
  task: TextTranslationTask;
  error: TextTranslationIpcError;
}

export interface TextTranslationWarningEvent extends TextTranslationEventBase {
  type: "warning";
  warning: TextTranslationValidationIssue;
}

export type TextTranslationEvent =
  | TextTranslationTaskUpdatedEvent
  | TextTranslationProgressEvent
  | TextTranslationFileCompletedEvent
  | TextTranslationTaskCompletedEvent
  | TextTranslationTaskFailedEvent
  | TextTranslationWarningEvent;

export type TextTranslationTaskMutationResult =
  TextTranslationIpcResult<TextTranslationTask>;

export type TextTranslationRecoverableTasksResult = TextTranslationIpcResult<
  TextTranslationRecoverySummary[]
>;

export function textTranslationIpcSuccess<T>(
  data: T,
): TextTranslationIpcResult<T> {
  return { ok: true, data };
}

export function textTranslationIpcFailure<T = never>(
  error: TextTranslationIpcError,
): TextTranslationIpcResult<T> {
  return { ok: false, error };
}

export function validateCreateTextTranslationTaskIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<CreateTextTranslationTaskRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }

  const fullTextField = findFullTextPayloadField(payload);
  if (fullTextField) {
    return fullTextPayloadNotAllowed(fullTextField);
  }

  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    return invalidRequest("At least one file path is required.", "files");
  }

  const orders = new Set<number>();
  for (const [index, file] of payload.files.entries()) {
    if (!isRecord(file)) {
      return invalidRequest("Each file entry must be an object.", "files");
    }

    const fileFullTextField = findFullTextPayloadField(file, `files.${index}`);
    if (fileFullTextField) {
      return fullTextPayloadNotAllowed(fileFullTextField);
    }

    if (!isNonEmptyString(file.sourcePath)) {
      return invalidRequest(
        "Each file entry must include a source path.",
        `files.${index}.sourcePath`,
      );
    }

    if (
      file.relativePath !== undefined &&
      typeof file.relativePath !== "string"
    ) {
      return invalidRequest(
        "File relative path must be a string when provided.",
        `files.${index}.relativePath`,
      );
    }

    const fileOrder = file.order;
    if (typeof fileOrder !== "number" || !Number.isInteger(fileOrder)) {
      return invalidRequest(
        "Each file entry must include an integer order.",
        `files.${index}.order`,
      );
    }

    if (orders.has(fileOrder)) {
      return invalidRequest(
        "File order values must be unique within the request.",
        `files.${index}.order`,
      );
    }
    orders.add(fileOrder);
  }

  const optionsResult = validateTextTranslationOptionsPayload(payload.options);
  if (!optionsResult.ok) return optionsResult;

  const modelResult = validateRuntimeModelPayload(payload.model, "model");
  if (!modelResult.ok) return modelResult;

  return textTranslationIpcSuccess(
    payload as unknown as CreateTextTranslationTaskRequest,
  );
}

export function validateTextTranslationTaskIdIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<TextTranslationTaskIdRequest> {
  if (!isRecord(payload)) {
    return missingTaskId();
  }

  if (!isNonEmptyString(payload.taskId)) {
    return missingTaskId();
  }

  return textTranslationIpcSuccess(
    payload as unknown as TextTranslationTaskIdRequest,
  );
}

export function validateRestartTextTranslationTaskIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<RestartTextTranslationTaskRequest> {
  const taskIdResult = validateTextTranslationTaskIdIpcRequest(payload);
  if (!taskIdResult.ok) return taskIdResult;
  if (!isRecord(payload)) return missingTaskId();

  if (payload.model !== undefined) {
    const modelResult = validateRuntimeModelPayload(payload.model, "model");
    if (!modelResult.ok) return modelResult;
  }

  return textTranslationIpcSuccess(
    payload as unknown as RestartTextTranslationTaskRequest,
  );
}

export function validateRetranslateTextTranslationFromSegmentIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<RetranslateTextTranslationFromSegmentRequest> {
  const taskIdResult = validateTextTranslationTaskIdIpcRequest(payload);
  if (!taskIdResult.ok) return taskIdResult;
  if (!isRecord(payload)) return missingTaskId();

  if (!isNonEmptyString(payload.segmentId)) {
    return invalidRequest("segmentId is required.", "segmentId");
  }

  if (payload.model !== undefined) {
    const modelResult = validateRuntimeModelPayload(payload.model, "model");
    if (!modelResult.ok) return modelResult;
  }

  return textTranslationIpcSuccess(
    payload as unknown as RetranslateTextTranslationFromSegmentRequest,
  );
}

export function validateDeleteTextTranslationTaskIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<DeleteTextTranslationTaskRequest> {
  const taskIdResult = validateTextTranslationTaskIdIpcRequest(payload);
  if (!taskIdResult.ok) return taskIdResult;
  if (!isRecord(payload)) return missingTaskId();

  if (
    payload.deleteWorkspace !== undefined &&
    typeof payload.deleteWorkspace !== "boolean"
  ) {
    return invalidRequest(
      "deleteWorkspace must be a boolean when provided.",
      "deleteWorkspace",
    );
  }

  return textTranslationIpcSuccess(
    payload as unknown as DeleteTextTranslationTaskRequest,
  );
}

export function validateListRecoverableTextTranslationTasksIpcRequest(
  payload: unknown,
): TextTranslationIpcResult<undefined> {
  if (payload === undefined || payload === null) {
    return textTranslationIpcSuccess(undefined);
  }
  if (isRecord(payload) && Object.keys(payload).length === 0) {
    return textTranslationIpcSuccess(undefined);
  }
  return invalidRequest(
    "List recoverable tasks does not accept a request payload.",
  );
}

export function isTextTranslationEventPayload(
  payload: unknown,
): payload is TextTranslationEvent {
  return (
    isRecord(payload) &&
    isTextTranslationEventType(payload.type) &&
    isNonEmptyString(payload.taskId) &&
    typeof payload.sequence === "number" &&
    Number.isInteger(payload.sequence) &&
    payload.sequence >= 0 &&
    isNonEmptyString(payload.occurredAt)
  );
}

export function getTextTranslationEventChannel(
  event: TextTranslationEvent,
): TextTranslationEventChannel {
  switch (event.type) {
    case "task-updated":
      return TEXT_TRANSLATION_EVENT_CHANNELS.taskUpdated;
    case "progress":
      return TEXT_TRANSLATION_EVENT_CHANNELS.progress;
    case "file-completed":
      return TEXT_TRANSLATION_EVENT_CHANNELS.fileCompleted;
    case "task-completed":
      return TEXT_TRANSLATION_EVENT_CHANNELS.taskCompleted;
    case "task-failed":
      return TEXT_TRANSLATION_EVENT_CHANNELS.taskFailed;
    case "warning":
      return TEXT_TRANSLATION_EVENT_CHANNELS.warning;
  }
}

function validateTextTranslationOptionsPayload(
  options: unknown,
): TextTranslationIpcResult<unknown> {
  if (!isRecord(options)) {
    return invalidRequest("Options must be an object.", "options");
  }

  const requiredStringFields = [
    "sourceLang",
    "targetLang",
    "executionMode",
    "outputMode",
    "projectMode",
    "outputPathMode",
    "conflictPolicy",
  ] as const;

  for (const field of requiredStringFields) {
    if (!isNonEmptyString(options[field])) {
      return invalidRequest(
        `Option ${field} must be a non-empty string.`,
        `options.${field}`,
      );
    }
  }

  const requiredIntegerFields = [
    "sliceTokenLimit",
    "semanticMemoryTokenLimit",
    "modelContextTokenLimit",
    "outputTokenReserve",
    "parallelSliceConcurrency",
  ] as const;

  for (const field of requiredIntegerFields) {
    if (!Number.isInteger(options[field])) {
      return invalidRequest(
        `Option ${field} must be an integer.`,
        `options.${field}`,
      );
    }
  }

  if (!isOneOfString(options.executionMode, ["parallel", "sequential_context"])) {
    return invalidRequest(
      "Execution mode is not supported.",
      "options.executionMode",
    );
  }
  if (!isOneOfString(options.outputMode, ["target_only", "bilingual"])) {
    return invalidRequest("Output mode is not supported.", "options.outputMode");
  }
  if (
    options.bilingualLabelMode !== undefined &&
    !isOneOfString(options.bilingualLabelMode, ["none", "labels"])
  ) {
    return invalidRequest(
      "Bilingual label mode is not supported.",
      "options.bilingualLabelMode",
    );
  }
  if (
    !isOneOfString(options.projectMode, [
      "independent_files",
      "ordered_project",
    ])
  ) {
    return invalidRequest(
      "Project mode is not supported.",
      "options.projectMode",
    );
  }
  if (!isOneOfString(options.outputPathMode, ["source", "custom"])) {
    return invalidRequest(
      "Output path mode is not supported.",
      "options.outputPathMode",
    );
  }
  if (!isOneOfString(options.conflictPolicy, ["overwrite", "index"])) {
    return invalidRequest(
      "Conflict policy is not supported.",
      "options.conflictPolicy",
    );
  }

  if (
    options.outputDir !== undefined &&
    typeof options.outputDir !== "string"
  ) {
    return invalidRequest(
      "Output directory must be a string when provided.",
      "options.outputDir",
    );
  }

  const optionalTextFields = [
    "documentBackground",
    "translationInstructions",
    "styleInstructions",
  ] as const;

  for (const field of optionalTextFields) {
    if (options[field] !== undefined && typeof options[field] !== "string") {
      return invalidRequest(
        `Option ${field} must be a string when provided.`,
        `options.${field}`,
      );
    }
  }

  if (options.glossary !== undefined) {
    if (!Array.isArray(options.glossary)) {
      return invalidRequest("Glossary must be an array.", "options.glossary");
    }
    for (const [index, entry] of options.glossary.entries()) {
      if (!isRecord(entry)) {
        return invalidRequest(
          "Each glossary entry must be an object.",
          `options.glossary.${index}`,
        );
      }
      if (!isNonEmptyString(entry.source) || !isNonEmptyString(entry.target)) {
        return invalidRequest(
          "Glossary entries must include source and target strings.",
          `options.glossary.${index}`,
        );
      }
      if (entry.note !== undefined && typeof entry.note !== "string") {
        return invalidRequest(
          "Glossary entry note must be a string when provided.",
          `options.glossary.${index}.note`,
        );
      }
    }
  }

  if (options.memoryResetFileIds !== undefined) {
    if (!Array.isArray(options.memoryResetFileIds)) {
      return invalidRequest(
        "Memory reset file ids must be an array.",
        "options.memoryResetFileIds",
      );
    }
    for (const [index, fileId] of options.memoryResetFileIds.entries()) {
      if (!isNonEmptyString(fileId)) {
        return invalidRequest(
          "Memory reset file ids must be non-empty strings.",
          `options.memoryResetFileIds.${index}`,
        );
      }
    }
  }

  if (options.memoryResetFileOrders !== undefined) {
    if (!Array.isArray(options.memoryResetFileOrders)) {
      return invalidRequest(
        "Memory reset file orders must be an array.",
        "options.memoryResetFileOrders",
      );
    }
    for (const [index, order] of options.memoryResetFileOrders.entries()) {
      if (!Number.isInteger(order) || order < 0) {
        return invalidRequest(
          "Memory reset file orders must be non-negative integers.",
          `options.memoryResetFileOrders.${index}`,
        );
      }
    }
  }

  return textTranslationIpcSuccess(options);
}

function validateRuntimeModelPayload(
  model: unknown,
  field: string,
): TextTranslationIpcResult<TextTranslationRuntimeModelConfig> {
  if (!isRecord(model)) {
    return invalidRequest("Runtime model must be an object.", field);
  }

  if (
    model.profileId !== undefined &&
    typeof model.profileId !== "string"
  ) {
    return invalidRequest(
      "Runtime model profileId must be a string when provided.",
      `${field}.profileId`,
    );
  }

  for (const key of ["apiKey", "modelKey", "endpoint"] as const) {
    if (!isNonEmptyString(model[key])) {
      return invalidRequest(
        `Runtime model ${key} must be a non-empty string.`,
        `${field}.${key}`,
      );
    }
  }

  return textTranslationIpcSuccess(
    model as unknown as TextTranslationRuntimeModelConfig,
  );
}

function invalidRequest(
  message: string,
  field?: string,
): TextTranslationIpcResult<never> {
  return textTranslationIpcFailure({
    code: "invalid_ipc_request",
    message,
    field,
  });
}

function missingTaskId(): TextTranslationIpcResult<never> {
  return textTranslationIpcFailure({
    code: "missing_task_id",
    message: "A non-empty taskId is required.",
    field: "taskId",
  });
}

function fullTextPayloadNotAllowed(
  field: string,
): TextTranslationIpcResult<never> {
  return textTranslationIpcFailure({
    code: "full_text_payload_not_allowed",
    message:
      "Long text source content must stay in the main process workspace and cannot be sent through IPC.",
    field,
  });
}

function findFullTextPayloadField(
  payload: Record<string, unknown>,
  prefix?: string,
): string | undefined {
  for (const key of ["content", "text", "sourceText", "rawText", "body"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return prefix ? `${prefix}.${key}` : key;
    }
  }
  return undefined;
}

function isTextTranslationEventType(
  value: unknown,
): value is TextTranslationEventType {
  return (
    value === "task-updated" ||
    value === "progress" ||
    value === "file-completed" ||
    value === "task-completed" ||
    value === "task-failed" ||
    value === "warning"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOfString<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === "string" && allowedValues.includes(value as T);
}
