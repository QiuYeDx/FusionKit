import type {
  TextTranslationPhase,
  TextTranslationTaskStatus,
} from "@/type/textTranslation";

export interface TextTranslationWorkspaceEventBase {
  taskId: string;
  sequence: number;
  occurredAt: string;
}

export type TextTranslationWorkspaceEvent =
  | (TextTranslationWorkspaceEventBase & {
      type: "task_status_changed";
      status: TextTranslationTaskStatus;
      phase?: TextTranslationPhase;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "segment_started";
      segmentId: string;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "segment_completed";
      segmentId: string;
      resultPath: string;
      inputMemoryVersion?: number;
      memoryVersion?: number;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
      };
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "segment_failed";
      segmentId: string;
      errorCode: string;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "segment_stale";
      segmentId: string;
      reason: string;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "file_completed";
      fileId: string;
      outputPath: string;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "task_completed";
      outputPaths: string[];
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "task_failed";
      errorCode: string;
    })
  | (TextTranslationWorkspaceEventBase & {
      type: "warning";
      warningCode: string;
      message: string;
    });

export interface TextTranslationReplayedState {
  taskId: string;
  lastSequence: number;
  status?: TextTranslationTaskStatus;
  phase?: TextTranslationPhase;
  completedSegmentIds: string[];
  failedSegmentIds: string[];
  staleSegmentIds: string[];
  segmentResultPaths: Record<string, string>;
  segmentMemoryVersions: Record<
    string,
    {
      inputMemoryVersion?: number;
      memoryVersion?: number;
    }
  >;
  completedFileOutputPaths: Record<string, string>;
  taskOutputPaths: string[];
  warningCodes: string[];
}

const FORBIDDEN_LOG_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "content",
  "sourcetext",
  "translatedtext",
  "rawtext",
  "body",
]);

export function replayTextTranslationEvents(
  events: TextTranslationWorkspaceEvent[],
): TextTranslationReplayedState {
  const state: TextTranslationReplayedState = {
    taskId: events[0]?.taskId ?? "",
    lastSequence: -1,
    completedSegmentIds: [],
    failedSegmentIds: [],
    staleSegmentIds: [],
    segmentResultPaths: {},
    segmentMemoryVersions: {},
    completedFileOutputPaths: {},
    taskOutputPaths: [],
    warningCodes: [],
  };

  const completedSegmentIds = new Set<string>();
  const failedSegmentIds = new Set<string>();
  const staleSegmentIds = new Set<string>();

  for (const event of events) {
    if (event.sequence <= state.lastSequence) continue;

    state.taskId = event.taskId;
    state.lastSequence = event.sequence;

    switch (event.type) {
      case "task_status_changed":
        state.status = event.status;
        state.phase = event.phase;
        break;
      case "segment_started":
        break;
      case "segment_completed":
        completedSegmentIds.add(event.segmentId);
        failedSegmentIds.delete(event.segmentId);
        staleSegmentIds.delete(event.segmentId);
        state.segmentResultPaths[event.segmentId] = event.resultPath;
        state.segmentMemoryVersions[event.segmentId] = {
          inputMemoryVersion: event.inputMemoryVersion,
          memoryVersion: event.memoryVersion,
        };
        break;
      case "segment_failed":
        if (!completedSegmentIds.has(event.segmentId)) {
          failedSegmentIds.add(event.segmentId);
        }
        break;
      case "segment_stale":
        staleSegmentIds.add(event.segmentId);
        completedSegmentIds.delete(event.segmentId);
        delete state.segmentResultPaths[event.segmentId];
        delete state.segmentMemoryVersions[event.segmentId];
        break;
      case "file_completed":
        state.completedFileOutputPaths[event.fileId] = event.outputPath;
        break;
      case "task_completed":
        state.status = "completed";
        state.phase = "completed";
        state.taskOutputPaths = [...event.outputPaths];
        break;
      case "task_failed":
        state.status = "failed";
        break;
      case "warning":
        state.warningCodes.push(event.warningCode);
        break;
    }
  }

  state.completedSegmentIds = [...completedSegmentIds];
  state.failedSegmentIds = [...failedSegmentIds];
  state.staleSegmentIds = [...staleSegmentIds];

  return state;
}

export function assertTextTranslationEventLogPayloadSafe(
  event: TextTranslationWorkspaceEvent,
): void {
  const forbiddenPath = findForbiddenLogKey(event);
  if (forbiddenPath) {
    throw new Error(
      `Text translation event log payload contains forbidden field: ${forbiddenPath}`,
    );
  }
}

function findForbiddenLogKey(value: unknown, path = "$"): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenLogKey(item, `${path}.${index}`);
      if (found) return found;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_LOG_KEYS.has(key.toLowerCase())) {
      return `${path}.${key}`;
    }
    const found = findForbiddenLogKey(item, `${path}.${key}`);
    if (found) return found;
  }

  return undefined;
}
