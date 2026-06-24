import type {
  CreateTextTranslationTaskRequest,
  TextTranslationRecoverySummary,
  TextTranslationTask,
} from "@/type/textTranslation";
import {
  TEXT_TRANSLATION_EVENT_CHANNELS,
  TEXT_TRANSLATION_IPC_CHANNELS,
  isTextTranslationEventPayload,
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
  type TextTranslationFileCompletedEvent,
  type TextTranslationIpcChannel,
  type TextTranslationIpcResult,
  type TextTranslationProgressEvent,
  type TextTranslationTaskCompletedEvent,
  type TextTranslationTaskFailedEvent,
  type TextTranslationTaskUpdatedEvent,
  type TextTranslationWarningEvent,
} from "@/type/textTranslationIpc";

export interface TextTranslationEventHandlers {
  taskUpdated?: (event: TextTranslationTaskUpdatedEvent) => void;
  progress?: (event: TextTranslationProgressEvent) => void;
  fileCompleted?: (event: TextTranslationFileCompletedEvent) => void;
  taskCompleted?: (event: TextTranslationTaskCompletedEvent) => void;
  taskFailed?: (event: TextTranslationTaskFailedEvent) => void;
  warning?: (event: TextTranslationWarningEvent) => void;
  any?: (event: TextTranslationEvent) => void;
}

export class TextTranslationEventSequenceGuard {
  private readonly latestSequenceByTaskId = new Map<string, number>();

  shouldAccept(event: Pick<TextTranslationEvent, "taskId" | "sequence">): boolean {
    const latestSequence = this.latestSequenceByTaskId.get(event.taskId) ?? -1;
    if (event.sequence <= latestSequence) {
      return false;
    }

    this.latestSequenceByTaskId.set(event.taskId, event.sequence);
    return true;
  }

  getLatestSequence(taskId: string): number | undefined {
    return this.latestSequenceByTaskId.get(taskId);
  }

  reset(taskId?: string): void {
    if (taskId) {
      this.latestSequenceByTaskId.delete(taskId);
      return;
    }
    this.latestSequenceByTaskId.clear();
  }
}

export function createTextTranslationTask(
  request: CreateTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.createTask,
    request,
  );
}

export function prepareTextTranslationTask(
  request: PrepareTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.prepareTask,
    request,
  );
}

export function startTextTranslationTask(
  request: StartTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.startTask,
    request,
  );
}

export function pauseTextTranslationTask(
  request: PauseTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.pauseTask,
    request,
  );
}

export function cancelTextTranslationTask(
  request: CancelTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.cancelTask,
    request,
  );
}

export function resumeTextTranslationTask(
  request: ResumeTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.resumeTask,
    request,
  );
}

export function retranslateTextTranslationFromSegment(
  request: RetranslateTextTranslationFromSegmentRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.retranslateFromSegment,
    request,
  );
}

export function restartTextTranslationTask(
  request: RestartTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.restartTask,
    request,
  );
}

export function deleteTextTranslationTask(
  request: DeleteTextTranslationTaskRequest,
): Promise<TextTranslationIpcResult<DeleteTextTranslationTaskResult>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.deleteTask,
    request,
  );
}

export function listRecoverableTextTranslationTasks(): Promise<
  TextTranslationIpcResult<TextTranslationRecoverySummary[]>
> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.listRecoverableTasks,
    undefined,
  );
}

export function getTextTranslationTaskDetail(
  request: GetTextTranslationTaskDetailRequest,
): Promise<TextTranslationIpcResult<TextTranslationTask | null>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.getTaskDetail,
    request,
  );
}

export function revealTextTranslationOutput(
  request: RevealTextTranslationOutputRequest,
): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.revealOutput,
    request,
  );
}

export function revealTextTranslationWorkspace(
  request: RevealTextTranslationWorkspaceRequest,
): Promise<TextTranslationIpcResult<RevealTextTranslationPathResult>> {
  return invokeTextTranslation(
    TEXT_TRANSLATION_IPC_CHANNELS.revealWorkspace,
    request,
  );
}

export function subscribeTextTranslationEvents(
  handlers: TextTranslationEventHandlers,
  guard = new TextTranslationEventSequenceGuard(),
): () => void {
  const listeners = eventChannelEntries.map(([channel, eventType]) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (!isTextTranslationEventPayload(payload)) return;
      if (payload.type !== eventType) return;
      if (!guard.shouldAccept(payload)) return;

      handlers.any?.(payload);
      dispatchTextTranslationEvent(handlers, payload);
    };

    window.ipcRenderer.on(channel, listener);
    return () => window.ipcRenderer.off(channel, listener);
  });

  return () => {
    for (const unsubscribe of listeners) {
      unsubscribe();
    }
  };
}

function invokeTextTranslation<TResponse>(
  channel: TextTranslationIpcChannel,
  request: unknown,
): Promise<TextTranslationIpcResult<TResponse>> {
  return window.ipcRenderer.invoke(channel, request) as Promise<
    TextTranslationIpcResult<TResponse>
  >;
}

function dispatchTextTranslationEvent(
  handlers: TextTranslationEventHandlers,
  event: TextTranslationEvent,
): void {
  switch (event.type) {
    case "task-updated":
      handlers.taskUpdated?.(event);
      break;
    case "progress":
      handlers.progress?.(event);
      break;
    case "file-completed":
      handlers.fileCompleted?.(event);
      break;
    case "task-completed":
      handlers.taskCompleted?.(event);
      break;
    case "task-failed":
      handlers.taskFailed?.(event);
      break;
    case "warning":
      handlers.warning?.(event);
      break;
  }
}

const eventChannelEntries = [
  [TEXT_TRANSLATION_EVENT_CHANNELS.taskUpdated, "task-updated"],
  [TEXT_TRANSLATION_EVENT_CHANNELS.progress, "progress"],
  [TEXT_TRANSLATION_EVENT_CHANNELS.fileCompleted, "file-completed"],
  [TEXT_TRANSLATION_EVENT_CHANNELS.taskCompleted, "task-completed"],
  [TEXT_TRANSLATION_EVENT_CHANNELS.taskFailed, "task-failed"],
  [TEXT_TRANSLATION_EVENT_CHANNELS.warning, "warning"],
] as const;
