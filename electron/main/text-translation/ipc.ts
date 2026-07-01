import { ipcMain, type WebContents } from "electron";
import type {
  CreateTextTranslationTaskRequest,
  TextTranslationRecoverySummary,
  TextTranslationTask,
} from "@/type/textTranslation";
import {
  TEXT_TRANSLATION_IPC_CHANNELS,
  getTextTranslationEventChannel,
  textTranslationIpcFailure,
  validateCreateTextTranslationTaskIpcRequest,
  validateDeleteTextTranslationTaskIpcRequest,
  validateListRecoverableTextTranslationTasksIpcRequest,
  validateRestartTextTranslationTaskIpcRequest,
  validateRetranslateTextTranslationFromSegmentIpcRequest,
  validateTextTranslationTaskIdIpcRequest,
  type CancelTextTranslationTaskRequest,
  type DeleteTextTranslationTaskRequest,
  type DeleteTextTranslationTaskResult,
  type GetTextTranslationTaskDetailRequest,
  type PrepareTextTranslationTaskRequest,
  type RestartTextTranslationTaskRequest,
  type RetranslateTextTranslationFromSegmentRequest,
  type ResumeTextTranslationTaskRequest,
  type RevealTextTranslationOutputRequest,
  type RevealTextTranslationPathResult,
  type RevealTextTranslationWorkspaceRequest,
  type StartTextTranslationTaskRequest,
  type PauseTextTranslationTaskRequest,
  type TextTranslationEvent,
  type TextTranslationIpcResult,
} from "@/type/textTranslationIpc";
import {
  TextTranslationService,
  type TextTranslationIpcService,
} from "./text-translation-service";

type Validator<TRequest> = (
  payload: unknown,
) => TextTranslationIpcResult<TRequest>;

export function setupTextTranslationIPC(
  service: TextTranslationIpcService = new TextTranslationService(),
): void {
  handleValidatedRequest<CreateTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.createTask,
    validateCreateTextTranslationTaskIpcRequest,
    (request) => service.createTask(request),
  );

  handleTaskRequest<PrepareTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.prepareTask,
    (request) => service.prepareTask(request),
  );

  handleTaskRequest<StartTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.startTask,
    (request) => service.startTask(request),
  );

  handleTaskRequest<PauseTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.pauseTask,
    (request) => service.pauseTask(request),
  );

  handleTaskRequest<CancelTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.cancelTask,
    (request) => service.cancelTask(request),
  );

  handleTaskRequest<ResumeTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.resumeTask,
    (request) => service.resumeTask(request),
  );

  handleValidatedRequest<
    RetranslateTextTranslationFromSegmentRequest,
    TextTranslationTask
  >(
    TEXT_TRANSLATION_IPC_CHANNELS.retranslateFromSegment,
    validateRetranslateTextTranslationFromSegmentIpcRequest,
    (request) => service.retranslateFromSegment(request),
  );

  handleValidatedRequest<RestartTextTranslationTaskRequest, TextTranslationTask>(
    TEXT_TRANSLATION_IPC_CHANNELS.restartTask,
    validateRestartTextTranslationTaskIpcRequest,
    (request) => service.restartTask(request),
  );

  handleValidatedRequest<
    DeleteTextTranslationTaskRequest,
    DeleteTextTranslationTaskResult
  >(
    TEXT_TRANSLATION_IPC_CHANNELS.deleteTask,
    validateDeleteTextTranslationTaskIpcRequest,
    (request) => service.deleteTask(request),
  );

  handleValidatedRequest<undefined, TextTranslationRecoverySummary[]>(
    TEXT_TRANSLATION_IPC_CHANNELS.listRecoverableTasks,
    validateListRecoverableTextTranslationTasksIpcRequest,
    () => service.listRecoverableTasks(),
  );

  handleTaskRequest<GetTextTranslationTaskDetailRequest, TextTranslationTask | null>(
    TEXT_TRANSLATION_IPC_CHANNELS.getTaskDetail,
    (request) => service.getTaskDetail(request),
  );

  handleTaskRequest<
    RevealTextTranslationOutputRequest,
    RevealTextTranslationPathResult
  >(
    TEXT_TRANSLATION_IPC_CHANNELS.revealOutput,
    (request) => service.revealOutput(request),
  );

  handleTaskRequest<
    RevealTextTranslationWorkspaceRequest,
    RevealTextTranslationPathResult
  >(
    TEXT_TRANSLATION_IPC_CHANNELS.revealWorkspace,
    (request) => service.revealWorkspace(request),
  );
}

export function emitTextTranslationEvent(
  webContents: WebContents,
  event: TextTranslationEvent,
): void {
  webContents.send(getTextTranslationEventChannel(event), event);
}

function handleTaskRequest<TRequest extends { taskId: string }, TResponse>(
  channel: string,
  run: (request: TRequest) => Promise<TextTranslationIpcResult<TResponse>>,
): void {
  handleValidatedRequest<TRequest, TResponse>(
    channel,
    (payload) => {
      const result = validateTextTranslationTaskIdIpcRequest(payload);
      if (!result.ok) return result;
      return { ok: true, data: result.data as TRequest };
    },
    run,
  );
}

function handleValidatedRequest<TRequest, TResponse>(
  channel: string,
  validate: Validator<TRequest>,
  run: (request: TRequest) => Promise<TextTranslationIpcResult<TResponse>>,
): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    const validation = validate(payload);
    if (!validation.ok) {
      return validation;
    }

    try {
      return await run(validation.data);
    } catch (error) {
      return textTranslationIpcFailure({
        code: "internal_error",
        message:
          error instanceof Error
            ? error.message
            : "Text translation IPC handler failed.",
      });
    }
  });
}
