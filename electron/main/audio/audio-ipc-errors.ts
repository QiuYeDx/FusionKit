import type { AudioRouteResolutionIssue } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
} from "./audio-errors";

export function audioRouteIssueToIpcError(
  issue: AudioRouteResolutionIssue,
): AudioIpcError {
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.code === "stale_audio_config"
      ? { field: "configRevision" }
      : {}),
    details: {
      assignmentKey: issue.assignmentKey,
      ...(issue.mode ? { mode: issue.mode } : {}),
    },
  };
}

export function toAudioIpcError(error: unknown): AudioIpcError {
  if (error instanceof AudioRuntimeClientError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  const wrapped = createAudioRuntimeError({
    code: "network_error",
    message: "Audio IPC handler failed.",
    cause: error,
  });
  return {
    code: wrapped.code,
    message: wrapped.message,
    ...(wrapped.details ? { details: wrapped.details } : {}),
  };
}
