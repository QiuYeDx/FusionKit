import type { AudioCapabilityValidationIssue } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
} from "./audio-errors";

export function audioCapabilityIssueToIpcError(
  issue: AudioCapabilityValidationIssue,
): AudioIpcError {
  return {
    code: issue.code,
    message: issue.message,
    details: {
      ...(issue.assignmentKey ? { assignmentKey: issue.assignmentKey } : {}),
      ...(issue.missingCapabilities
        ? { missingCapabilities: issue.missingCapabilities }
        : {}),
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
    message: error instanceof Error
      ? error.message
      : "Audio IPC handler failed.",
    cause: error,
  });
  return {
    code: wrapped.code,
    message: wrapped.message,
    ...(wrapped.details ? { details: wrapped.details } : {}),
  };
}
