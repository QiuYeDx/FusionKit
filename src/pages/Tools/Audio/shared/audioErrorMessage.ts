import type { AudioIpcError, AudioIpcErrorCode } from "@/type/audioIpc";

type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

const ERROR_KEY_BY_CODE: Record<AudioIpcErrorCode, string> = {
  invalid_ipc_request: "audio:runtime_error.invalid_request",
  audio_profile_not_configured: "audio:runtime_error.profile_not_configured",
  connection_profile_not_configured: "audio:runtime_error.connection_not_configured",
  audio_model_not_configured: "audio:runtime_error.model_not_configured",
  unsupported_audio_capability: "audio:runtime_error.unsupported_capability",
  unsupported_audio_format: "audio:runtime_error.unsupported_format",
  microphone_permission_denied: "audio:runtime_error.microphone_denied",
  file_too_large: "audio:runtime_error.file_too_large",
  file_read_failed: "audio:runtime_error.file_read_failed",
  output_write_failed: "audio:runtime_error.output_write_failed",
  stream_parse_failed: "audio:runtime_error.stream_parse_failed",
  realtime_session_failed: "audio:runtime_error.realtime_failed",
  network_error: "audio:runtime_error.network",
  request_timeout: "audio:runtime_error.timeout",
  http_unauthorized: "audio:runtime_error.unauthorized",
  http_forbidden: "audio:runtime_error.forbidden",
  http_rate_limited: "audio:runtime_error.rate_limited",
  http_retryable: "audio:runtime_error.service_unavailable",
  http_non_retryable: "audio:runtime_error.request_rejected",
  empty_response: "audio:runtime_error.empty_response",
  invalid_response: "audio:runtime_error.invalid_response",
  aborted: "audio:runtime_error.aborted",
};

export function getAudioErrorMessage(
  t: Translate,
  error: Pick<AudioIpcError, "code" | "field"> | { code: "renderer_error"; field?: string },
  fallback?: string,
): string {
  if (error.code === "renderer_error") {
    return fallback ?? t("audio:runtime_error.renderer");
  }
  return t(ERROR_KEY_BY_CODE[error.code], {
    ...(error.field ? { field: error.field } : {}),
  });
}
