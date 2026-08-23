import type {
  AudioApiRoutes,
  AudioAssignmentKey,
  AudioProviderPreset,
  AudioRoute,
  AudioRouteKey,
  AudioRouteVerification,
  AudioOutputPathMode,
  AudioRealtimeSessionCloseReason,
  AudioRealtimeSessionConfig,
  AudioRole,
  AudioSpeechResponseFormat,
  AudioStreamStats,
  AudioTaskAssignment,
  AudioTimestampGranularity,
  AudioTransport,
  AudioTranscriptionResult,
  AudioTranscriptionResponseFormat,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
  SpeechSynthesisIntent,
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  AUDIO_ASSIGNMENT_KEYS,
  AUDIO_SPEECH_MAX_INPUT_CHARS,
  AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
  DEFAULT_AUDIO_TASK_ASSIGNMENT,
  isAudioAssignmentKey,
  isAudioProviderPreset,
  isAudioSpeechResponseFormat,
  isAudioTransport,
  isAudioTranscriptionResponseFormat,
  isSpeechSynthesisMode,
} from "@/type/audio";

export const AUDIO_IPC_CHANNELS = {
  syncRuntimeConfig: "audio:sync-runtime-config",
  transcribe: "audio:transcribe",
  cancelTranscription: "audio:cancel-transcription",
  transcribeRecordedChunk: "audio:transcribe-recorded-chunk",
  cancelRecordedChunkTranscription: "audio:cancel-recorded-chunk-transcription",
  synthesizeSpeech: "audio:synthesize-speech",
  cancelSpeechSynthesis: "audio:cancel-speech-synthesis",
  synthesizeSpeechStream: "audio:synthesize-speech-stream",
  cancelSpeechSynthesisStream: "audio:cancel-speech-synthesis-stream",
  revealOutput: "audio:reveal-output",
  readOutput: "audio:read-output",
  saveTextOutput: "audio:save-text-output",
  realtimeCreateEphemeralSession: "audio:realtime:create-ephemeral-session",
  realtimeSessionEvent: "audio:realtime:session-event",
  realtimeStopSession: "audio:realtime:stop-session",
} as const;

export const AUDIO_PRELOAD_INTERNAL_CHANNELS = {
  registerCapability: "audio:internal:register-preload-capability",
  authorizeInputFile: "audio:internal:authorize-input-file",
  revokeInputFile: "audio:internal:revoke-input-file",
  selectOutputDirectory: "audio:internal:select-output-directory",
  revokeOutputDirectory: "audio:internal:revoke-output-directory",
} as const;

export const AUDIO_EVENT_CHANNELS = {
  speechSynthesisStream: "audio:speech-synthesis-stream",
  realtimeSessionEvent: "audio:realtime:session-event",
} as const;

export type AudioIpcChannel =
  (typeof AUDIO_IPC_CHANNELS)[keyof typeof AUDIO_IPC_CHANNELS];

export type AudioEventChannel =
  (typeof AUDIO_EVENT_CHANNELS)[keyof typeof AUDIO_EVENT_CHANNELS];

export interface AudioSecureIpcEnvelope<TPayload = unknown> {
  capability: string;
  payload: TPayload;
  configRevision?: string;
}

export type AudioIpcErrorCode =
  | "invalid_ipc_request"
  | "stale_audio_config"
  | "audio_api_not_configured"
  | "audio_route_not_configured"
  | "audio_route_unverified"
  | "invalid_task_parameters"
  | "audio_profile_not_configured"
  | "connection_profile_not_configured"
  | "audio_model_not_configured"
  | "unsupported_audio_capability"
  | "unsupported_audio_format"
  | "microphone_permission_denied"
  | "file_too_large"
  | "file_read_failed"
  | "output_write_failed"
  | "stream_parse_failed"
  | "realtime_session_failed"
  | "network_error"
  | "request_timeout"
  | "http_unauthorized"
  | "http_payment_required"
  | "http_forbidden"
  | "http_rate_limited"
  | "http_retryable"
  | "http_non_retryable"
  | "empty_response"
  | "invalid_response"
  | "aborted";

export interface AudioIpcError {
  code: AudioIpcErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

export type AudioIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AudioIpcError };

export interface RevealAudioOutputRequest {
  outputToken: string;
}

export interface RevealAudioOutputResult {
  revealed: boolean;
}

export interface CancelAudioTranscriptionRequest {
  requestId: string;
}

export interface CancelAudioTranscriptionResult {
  cancelled: boolean;
  requestId: string;
}

export interface TranscribeRecordedAudioChunkRequest {
  assignmentKey: "realtimeCaptions";
  requestId: string;
  audioBytes: Uint8Array;
  mimeType: "audio/wav";
  language?: string;
  responseFormat: "json" | "text";
  startedAtMs?: number;
  endedAtMs?: number;
}

export interface TranscribeRecordedAudioChunkResult {
  requestId: string;
  text: string;
  responseFormat: "json" | "text";
  model?: string;
  startedAtMs?: number;
  endedAtMs?: number;
}

export interface CancelRecordedAudioChunkTranscriptionRequest {
  requestId: string;
}

export interface CancelRecordedAudioChunkTranscriptionResult {
  cancelled: boolean;
  requestId: string;
}

export interface CancelSpeechSynthesisRequest {
  requestId: string;
}

export interface CancelSpeechSynthesisResult {
  cancelled: boolean;
  requestId: string;
}

export interface AudioRuntimeApiProfileSnapshot {
  id: string;
  providerPreset: AudioProviderPreset;
  apiKey: string;
  baseUrl: string;
  routes: AudioApiRoutes;
  verification?: Partial<Record<AudioRouteKey, AudioRouteVerification>>;
}

export interface SyncAudioRuntimeConfigRequest {
  profiles: AudioRuntimeApiProfileSnapshot[];
  assignment: AudioTaskAssignment;
}

export interface SyncAudioRuntimeConfigResult {
  synced: boolean;
  audioProfileCount: number;
  revision: string;
}

export interface ReadAudioOutputRequest {
  outputToken: string;
}

export interface ReadAudioOutputResult {
  bytes: Uint8Array;
  mimeType: string;
}

export interface SaveAudioTextOutputRequest {
  defaultName: string;
  content: string;
  extension: "txt" | "json" | "srt" | "vtt";
}

export interface SaveAudioTextOutputResult {
  saved: boolean;
  cancelled: boolean;
}

export interface AuthorizedAudioInputFile {
  fileToken: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: number;
}

export interface RevokeAudioInputFileResult {
  revoked: boolean;
}

export interface RevokeAudioOutputDirectoryResult {
  revoked: boolean;
}

export interface SelectAudioOutputDirectoryRequest {
  title?: string;
  buttonLabel?: string;
}

export type AudioOutputDirectorySelection =
  | { cancelled: true }
  | {
      cancelled: false;
      outputDirToken: string;
      directoryName: string;
      expiresAt: number;
    };

export type CreateAudioTranscriptionIpcRequest = Omit<
  CreateAudioTranscriptionRequest,
  "filePath" | "outputDir"
> & {
  fileToken: string;
  outputDirToken?: string;
};

export interface CreateSpeechSynthesisIpcRequest {
  assignmentKey: "speechSynthesis";
  requestId?: string;
  input: string;
  intent: SpeechSynthesisIntent;
  responseFormat: AudioSpeechResponseFormat;
  instructions?: string;
  speed?: number;
  stream?: boolean;
  outputPathMode?: AudioOutputPathMode;
  outputDirToken?: string;
  fileNameHint?: string;
}

export interface CreateSpeechSynthesisStreamIpcRequest {
  requestId: string;
  payload: CreateSpeechSynthesisIpcRequest;
}

export type AudioInputSelectionSource = "picker" | "drop";

export interface AudioRendererApi {
  invoke<TResponse>(
    channel: AudioIpcChannel,
    payload: unknown,
    options?: { configRevision?: string },
  ): Promise<AudioIpcResult<TResponse>>;
  authorizeInputFile(
    file: File,
    source?: AudioInputSelectionSource,
  ): Promise<AudioIpcResult<AuthorizedAudioInputFile>>;
  revokeInputFile(
    fileToken: string,
  ): Promise<AudioIpcResult<RevokeAudioInputFileResult>>;
  selectOutputDirectory(
    request?: SelectAudioOutputDirectoryRequest,
  ): Promise<AudioIpcResult<AudioOutputDirectorySelection>>;
  revokeOutputDirectory(
    outputDirToken: string,
  ): Promise<AudioIpcResult<RevokeAudioOutputDirectoryResult>>;
  on(
    channel: AudioEventChannel,
    listener: (event: unknown, payload: unknown) => void,
  ): void;
  off(
    channel: AudioEventChannel,
    listener: (event: unknown, payload: unknown) => void,
  ): void;
}

export interface CancelSpeechSynthesisStreamRequest {
  requestId: string;
}

export interface CancelSpeechSynthesisStreamResult {
  cancelled: boolean;
  requestId: string;
}

export interface RealtimeEphemeralSessionResult {
  sessionId?: string;
  clientSecret: string;
  expiresAt?: string;
  model?: string;
  realtimeCallsUrl?: string;
}

export interface StopAudioRealtimeSessionRequest {
  sessionId: string;
  reason?: AudioRealtimeSessionCloseReason;
}

export interface StopAudioRealtimeSessionResult {
  stopped: boolean;
  sessionId: string;
  reason: AudioRealtimeSessionCloseReason;
}

export type AuthorizedAudioTranscriptionResult = Omit<
  AudioTranscriptionResult,
  "outputPath"
>;

export type AuthorizedSpeechSynthesisResult = Omit<
  SpeechSynthesisResult,
  "outputPath"
> & {
  outputToken: string;
};

type SpeechSynthesisStreamEventBase =
  | { type: "started"; requestId: string; sampleRate: 24000; channels: 1 }
  | { type: "audio_delta"; requestId: string; pcmBytes: Uint8Array }
  | { type: "text_delta"; requestId: string; text: string }
  | {
      type: "metadata";
      requestId: string;
      stats: Partial<AudioStreamStats>;
    }
  | { type: "error"; requestId: string; error: AudioIpcError };

export type SpeechSynthesisStreamEvent =
  | SpeechSynthesisStreamEventBase
  | {
      type: "completed";
      requestId: string;
      result: AuthorizedSpeechSynthesisResult;
    };

export type SpeechSynthesisRuntimeStreamEvent =
  | SpeechSynthesisStreamEventBase
  | { type: "completed"; requestId: string; result: SpeechSynthesisResult };

export type AudioRealtimeSessionEvent =
  | { type: "session_started"; sessionId: string }
  | {
      type: "mic_state";
      state: "requesting" | "granted" | "denied" | "muted";
    }
  | {
      type: "transcript_delta";
      role: AudioRole;
      text: string;
      itemId?: string;
      responseId?: string;
      contentIndex?: number;
      outputIndex?: number;
    }
  | {
      type: "transcript_final";
      role: AudioRole;
      text: string;
      itemId?: string;
      responseId?: string;
      contentIndex?: number;
      outputIndex?: number;
    }
  | {
      type: "audio_started";
      role: "assistant";
      responseId?: string;
      itemId?: string;
      source?: "response" | "output_buffer";
    }
  | {
      type: "audio_stopped";
      role: "assistant";
      responseId?: string;
      itemId?: string;
      source?: "response" | "output_buffer";
      cleared?: boolean;
    }
  | { type: "response_started"; responseId: string }
  | {
      type: "response_completed";
      responseId: string;
      status: "completed" | "cancelled" | "failed" | "incomplete";
    }
  | { type: "error"; error: AudioIpcError; fatal: boolean }
  | { type: "session_closed"; reason: AudioRealtimeSessionCloseReason };

const FORBIDDEN_RUNTIME_CONFIG_FIELDS = [
  "model",
  "apiKey",
  "baseUrl",
  "provider",
  "providerPreset",
  "transport",
  "route",
  "routes",
  "profileId",
  "audioProfileId",
  "connectionProfileId",
  "audioDialect",
  "modelKey",
  "endpoint",
] as const;

const FORBIDDEN_AUDIO_PAYLOAD_FIELDS = [
  "audioData",
  "audioBase64",
  "base64",
  "bytes",
  "buffer",
  "pcmBytes",
  "pcmBase64",
  "file",
  "blob",
  "content",
  "rawAudio",
  "requestBody",
  "voiceSampleBase64",
  "inputAudio",
  "input_audio",
] as const;

const MAX_RECORDED_CHUNK_BYTES = 5 * 1024 * 1024;

export function audioIpcSuccess<T>(data: T): AudioIpcResult<T> {
  return { ok: true, data };
}

export function audioIpcFailure<T = never>(
  error: AudioIpcError,
): AudioIpcResult<T> {
  return { ok: false, error };
}

export function validateSyncAudioRuntimeConfigIpcRequest(
  payload: unknown,
): AudioIpcResult<SyncAudioRuntimeConfigRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }

  const unexpectedField = findUnexpectedField(payload, [
    "profiles",
    "assignment",
  ]);
  if (unexpectedField) {
    return invalidRequest(
      "Runtime config snapshot contains an unsupported field.",
      unexpectedField,
    );
  }
  if (!Array.isArray(payload.profiles)) {
    return invalidRequest("profiles must be an array.", "profiles");
  }
  if (payload.profiles.length > 100) {
    return invalidRequest("profiles exceeds the supported limit.", "profiles");
  }

  const profiles: AudioRuntimeApiProfileSnapshot[] = [];
  const profileIds = new Set<string>();
  for (const [index, value] of payload.profiles.entries()) {
    const result = validateRuntimeApiProfileSnapshot(value, `profiles.${index}`);
    if (!result.ok) return result;
    const canonicalId = result.data.id.trim();
    if (profileIds.has(canonicalId)) {
      return invalidRequest(
        "Runtime audio profile ids must be unique.",
        `profiles.${index}.id`,
      );
    }
    profileIds.add(canonicalId);
    profiles.push(result.data);
  }

  const assignmentResult = validateAudioTaskAssignmentSnapshot(
    payload.assignment,
  );
  if (!assignmentResult.ok) return assignmentResult;

  return audioIpcSuccess({
    profiles,
    assignment: assignmentResult.data,
  });
}

export function validateCreateAudioTranscriptionIpcRequest(
  payload: unknown,
): AudioIpcResult<CreateAudioTranscriptionIpcRequest> {
  const commonResult = validateCommonAudioTaskPayload(payload);
  if (!commonResult.ok) return commonResult;
  const record = commonResult.data;

  if (record.assignmentKey !== "transcription") {
    return invalidRequest(
      "Transcription request must use the transcription assignment.",
      "assignmentKey",
    );
  }

  if (record.filePath !== undefined) {
    return invalidRequest(
      "Renderer audio requests must use an authorized fileToken, not filePath.",
      "filePath",
    );
  }
  if (record.outputDir !== undefined) {
    return invalidRequest(
      "Renderer audio requests must use an authorized outputDirToken, not outputDir.",
      "outputDir",
    );
  }
  for (const key of ["fileToken", "fileName", "mimeType"] as const) {
    if (!isNonEmptyString(record[key])) {
      return invalidRequest(`${key} must be a non-empty string.`, key);
    }
  }
  const fileToken = record.fileToken as string;
  const fileName = record.fileName as string;
  const mimeType = record.mimeType as string;
  const requestId = optionalString(record.requestId, "requestId");
  if (!requestId.ok) return requestId;

  if (!isAudioTranscriptionResponseFormat(record.responseFormat)) {
    return invalidRequest(
      "Transcription response format is not supported.",
      "responseFormat",
    );
  }
  const responseFormat = record.responseFormat;

  const language = optionalString(record.language, "language");
  if (!language.ok) return language;
  const prompt = optionalString(record.prompt, "prompt");
  if (!prompt.ok) return prompt;
  if (prompt.data && prompt.data.length > 4096) {
    return invalidRequest("prompt exceeds 4096 characters.", "prompt");
  }
  const outputPathMode = optionalOutputPathMode(record.outputPathMode);
  if (!outputPathMode.ok) return outputPathMode;
  const outputDirToken = validateOutputDirectoryToken(
    record.outputDirToken,
    outputPathMode.data,
  );
  if (!outputDirToken.ok) return outputDirToken;

  if (
    record.temperature !== undefined &&
    (!isFiniteNumber(record.temperature) ||
      record.temperature < 0 ||
      record.temperature > 1)
  ) {
    return invalidRequest(
      "temperature must be between 0 and 1.",
      "temperature",
    );
  }

  const timestampResult = optionalTimestampGranularities(
    record.timestampGranularities,
  );
  if (!timestampResult.ok) return timestampResult;

  const stream = optionalBoolean(record.stream, "stream");
  if (!stream.ok) return stream;

  return audioIpcSuccess({
    assignmentKey: "transcription",
    ...(requestId.data ? { requestId: requestId.data } : {}),
    fileToken,
    fileName,
    mimeType,
    ...(language.data ? { language: language.data } : {}),
    ...(prompt.data !== undefined ? { prompt: prompt.data } : {}),
    responseFormat,
    ...(record.temperature !== undefined
      ? { temperature: record.temperature }
      : {}),
    ...(timestampResult.data
      ? { timestampGranularities: timestampResult.data }
      : {}),
    ...(stream.data !== undefined ? { stream: stream.data } : {}),
    ...(outputPathMode.data ? { outputPathMode: outputPathMode.data } : {}),
    ...(outputDirToken.data
      ? { outputDirToken: outputDirToken.data }
      : {}),
  });
}

export function validateCancelAudioTranscriptionIpcRequest(
  payload: unknown,
): AudioIpcResult<CancelAudioTranscriptionRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }
  return audioIpcSuccess({ requestId: payload.requestId });
}

export function validateTranscribeRecordedAudioChunkIpcRequest(
  payload: unknown,
): AudioIpcResult<TranscribeRecordedAudioChunkRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }

  const runtimeField = findForbiddenField(
    payload,
    FORBIDDEN_RUNTIME_CONFIG_FIELDS,
  );
  if (runtimeField) {
    return invalidRequest(
      "Audio API configuration must be resolved from global settings, not passed by the tool page.",
      runtimeField,
    );
  }

  if (payload.assignmentKey !== "realtimeCaptions") {
    return invalidRequest(
      "Recorded chunk transcription must use realtimeCaptions assignment.",
      "assignmentKey",
    );
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }
  if (payload.mimeType !== "audio/wav") {
    return invalidRequest(
      "Recorded chunk mimeType must be audio/wav.",
      "mimeType",
    );
  }
  if (payload.responseFormat !== "json" && payload.responseFormat !== "text") {
    return invalidRequest(
      "Recorded chunk responseFormat must be json or text.",
      "responseFormat",
    );
  }
  if (typeof payload.audioBytes === "string") {
    return invalidRequest(
      "Recorded chunk audioBytes must be binary data, not Base64 text.",
      "audioBytes",
    );
  }

  const audioBytes = normalizeAudioChunkBytes(payload.audioBytes);
  if (!audioBytes) {
    return invalidRequest(
      "Recorded chunk audioBytes must be Uint8Array or ArrayBuffer.",
      "audioBytes",
    );
  }
  if (audioBytes.byteLength === 0) {
    return invalidRequest(
      "Recorded chunk audioBytes must not be empty.",
      "audioBytes",
    );
  }
  if (audioBytes.byteLength > MAX_RECORDED_CHUNK_BYTES) {
    return invalidRequest(
      "Recorded chunk audioBytes exceeds the per-chunk size limit.",
      "audioBytes",
      { sizeBytes: audioBytes.byteLength, maxBytes: MAX_RECORDED_CHUNK_BYTES },
    );
  }

  const language = optionalString(payload.language, "language");
  if (!language.ok) return language;
  if (
    payload.startedAtMs !== undefined &&
    !isFiniteNumber(payload.startedAtMs)
  ) {
    return invalidRequest(
      "startedAtMs must be a finite number when provided.",
      "startedAtMs",
    );
  }
  if (payload.endedAtMs !== undefined && !isFiniteNumber(payload.endedAtMs)) {
    return invalidRequest(
      "endedAtMs must be a finite number when provided.",
      "endedAtMs",
    );
  }
  const startedAtMs = isFiniteNumber(payload.startedAtMs)
    ? payload.startedAtMs
    : undefined;
  const endedAtMs = isFiniteNumber(payload.endedAtMs)
    ? payload.endedAtMs
    : undefined;
  if (
    (startedAtMs !== undefined && startedAtMs < 0) ||
    (endedAtMs !== undefined && endedAtMs < 0) ||
    (startedAtMs !== undefined &&
      endedAtMs !== undefined &&
      endedAtMs < startedAtMs)
  ) {
    return invalidRequest(
      "Recorded chunk timestamps are out of range.",
      "endedAtMs",
    );
  }

  return audioIpcSuccess({
    assignmentKey: "realtimeCaptions",
    requestId: payload.requestId,
    audioBytes,
    mimeType: "audio/wav",
    responseFormat: payload.responseFormat,
    ...(language.data ? { language: language.data } : {}),
    ...(payload.startedAtMs !== undefined
      ? { startedAtMs: payload.startedAtMs }
      : {}),
    ...(payload.endedAtMs !== undefined
      ? { endedAtMs: payload.endedAtMs }
      : {}),
  });
}

export function validateCancelRecordedAudioChunkTranscriptionIpcRequest(
  payload: unknown,
): AudioIpcResult<CancelRecordedAudioChunkTranscriptionRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }
  return audioIpcSuccess({ requestId: payload.requestId });
}

export function validateCreateSpeechSynthesisIpcRequest(
  payload: unknown,
): AudioIpcResult<CreateSpeechSynthesisIpcRequest> {
  const commonResult = validateCommonAudioTaskPayload(payload);
  if (!commonResult.ok) return commonResult;
  const record = commonResult.data;

  if (record.assignmentKey !== "speechSynthesis") {
    return invalidRequest(
      "Speech synthesis request must use the speechSynthesis assignment.",
      "assignmentKey",
    );
  }
  if (record.outputDir !== undefined) {
    return invalidRequest(
      "Renderer audio requests must use an authorized outputDirToken, not outputDir.",
      "outputDir",
    );
  }

  const unexpectedField = findUnexpectedField(record, [
    "assignmentKey",
    "requestId",
    "input",
    "intent",
    "responseFormat",
    "instructions",
    "speed",
    "stream",
    "outputPathMode",
    "outputDirToken",
    "fileNameHint",
  ]);
  if (unexpectedField) {
    return invalidRequest(
      "Speech synthesis request contains an unsupported field.",
      unexpectedField,
    );
  }

  if (typeof record.input !== "string") {
    return invalidRequest("input must be a string.", "input");
  }
  if (record.input.length > AUDIO_SPEECH_MAX_INPUT_CHARS) {
    return invalidRequest(
      `input exceeds ${AUDIO_SPEECH_MAX_INPUT_CHARS} characters.`,
      "input",
    );
  }
  const requestId = optionalString(record.requestId, "requestId");
  if (!requestId.ok) return requestId;
  const intentResult = validateSpeechSynthesisIntent(record.intent);
  if (!intentResult.ok) return intentResult;

  if (!isAudioSpeechResponseFormat(record.responseFormat)) {
    return invalidRequest(
      "Speech response format is not supported.",
      "responseFormat",
    );
  }
  const responseFormat = record.responseFormat;

  const instructions = optionalString(record.instructions, "instructions");
  if (!instructions.ok) return instructions;
  if (
    instructions.data &&
    instructions.data.length > AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS
  ) {
    return invalidRequest(
      `instructions exceeds ${AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS} characters.`,
      "instructions",
    );
  }
  const fileNameHint = optionalString(record.fileNameHint, "fileNameHint");
  if (!fileNameHint.ok) return fileNameHint;
  const outputPathMode = optionalOutputPathMode(record.outputPathMode);
  if (!outputPathMode.ok) return outputPathMode;
  const outputDirToken = validateOutputDirectoryToken(
    record.outputDirToken,
    outputPathMode.data,
  );
  if (!outputDirToken.ok) return outputDirToken;

  if (
    record.speed !== undefined &&
    (!isFiniteNumber(record.speed) || record.speed < 0.25 || record.speed > 4)
  ) {
    return invalidRequest("speed must be between 0.25 and 4.", "speed");
  }

  const stream = optionalBoolean(record.stream, "stream");
  if (!stream.ok) return stream;

  if (
    record.input.trim().length === 0 &&
    !(
      intentResult.data.mode === "voice_design" &&
      intentResult.data.optimizeTextPreview === true
    )
  ) {
    return invalidRequest(
      "input must be non-empty unless voice design preview optimization is enabled.",
      "input",
    );
  }

  return audioIpcSuccess({
    assignmentKey: "speechSynthesis",
    ...(requestId.data ? { requestId: requestId.data } : {}),
    input: record.input,
    intent: intentResult.data,
    ...(instructions.data !== undefined
      ? { instructions: instructions.data }
      : {}),
    responseFormat,
    ...(record.speed !== undefined ? { speed: record.speed } : {}),
    ...(stream.data !== undefined ? { stream: stream.data } : {}),
    ...(outputPathMode.data ? { outputPathMode: outputPathMode.data } : {}),
    ...(outputDirToken.data
      ? { outputDirToken: outputDirToken.data }
      : {}),
    ...(fileNameHint.data !== undefined
      ? { fileNameHint: fileNameHint.data }
      : {}),
  });
}

export function validateCancelSpeechSynthesisIpcRequest(
  payload: unknown,
): AudioIpcResult<CancelSpeechSynthesisRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }
  return audioIpcSuccess({ requestId: payload.requestId });
}

export function validateCreateSpeechSynthesisStreamIpcRequest(
  payload: unknown,
): AudioIpcResult<CreateSpeechSynthesisStreamIpcRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }

  const payloadResult = validateCreateSpeechSynthesisIpcRequest(payload.payload);
  if (!payloadResult.ok) return payloadResult;
  if (payloadResult.data.stream !== true) {
    return invalidRequest(
      "Streaming speech synthesis requests must set stream to true.",
      "payload.stream",
    );
  }

  return audioIpcSuccess({
    requestId: payload.requestId,
    payload: payloadResult.data,
  });
}

export function validateCancelSpeechSynthesisStreamIpcRequest(
  payload: unknown,
): AudioIpcResult<CancelSpeechSynthesisStreamRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.requestId)) {
    return invalidRequest("requestId must be a non-empty string.", "requestId");
  }
  return audioIpcSuccess({ requestId: payload.requestId });
}

export function validateAudioRealtimeSessionIpcRequest(
  payload: unknown,
): AudioIpcResult<AudioRealtimeSessionConfig> {
  const commonResult = validateCommonAudioTaskPayload(payload);
  if (!commonResult.ok) return commonResult;
  const record = commonResult.data;

  if (
    record.assignmentKey !== "realtimeCaptions" &&
    record.assignmentKey !== "realtimeVoice"
  ) {
    return invalidRequest(
      "Realtime request must use a realtime assignment.",
      "assignmentKey",
    );
  }

  if (record.assignmentKey === "realtimeCaptions" && record.mode !== "caption") {
    return invalidRequest(
      "Realtime captions must use caption mode.",
      "mode",
    );
  }
  if (record.assignmentKey === "realtimeVoice" && record.mode !== "duplex_voice") {
    return invalidRequest(
      "Realtime voice must use duplex_voice mode.",
      "mode",
    );
  }
  const assignmentKey = record.assignmentKey;
  const mode = record.mode as AudioRealtimeSessionConfig["mode"];

  const instructions = optionalString(record.instructions, "instructions");
  if (!instructions.ok) return instructions;
  const language = optionalString(record.language, "language");
  if (!language.ok) return language;
  const voice = optionalString(record.voice, "voice");
  if (!voice.ok) return voice;

  if (
    record.turnDetection !== undefined &&
    record.turnDetection !== "server_vad" &&
    record.turnDetection !== "manual"
  ) {
    return invalidRequest(
      "turnDetection must be server_vad or manual when provided.",
      "turnDetection",
    );
  }

  const inputAudioFormat = optionalRealtimeAudioFormat(
    record.inputAudioFormat,
    "inputAudioFormat",
  );
  if (!inputAudioFormat.ok) return inputAudioFormat;
  const outputAudioFormat = optionalRealtimeAudioFormat(
    record.outputAudioFormat,
    "outputAudioFormat",
  );
  if (!outputAudioFormat.ok) return outputAudioFormat;

  return audioIpcSuccess({
    assignmentKey,
    mode,
    ...(instructions.data !== undefined
      ? { instructions: instructions.data }
      : {}),
    ...(language.data !== undefined ? { language: language.data } : {}),
    ...(voice.data !== undefined ? { voice: voice.data } : {}),
    ...(record.turnDetection ? { turnDetection: record.turnDetection } : {}),
    ...(inputAudioFormat.data
      ? { inputAudioFormat: inputAudioFormat.data }
      : {}),
    ...(outputAudioFormat.data
      ? { outputAudioFormat: outputAudioFormat.data }
      : {}),
  });
}

export function validateStopAudioRealtimeSessionIpcRequest(
  payload: unknown,
): AudioIpcResult<StopAudioRealtimeSessionRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.sessionId)) {
    return invalidRequest("sessionId must be a non-empty string.", "sessionId");
  }
  if (
    payload.reason !== undefined &&
    payload.reason !== "user" &&
    payload.reason !== "page_unload" &&
    payload.reason !== "error"
  ) {
    return invalidRequest(
      "reason must be user, page_unload, or error when provided.",
      "reason",
    );
  }
  return audioIpcSuccess({
    sessionId: payload.sessionId,
    reason: payload.reason as AudioRealtimeSessionCloseReason | undefined,
  });
}

export function validateRevealAudioOutputIpcRequest(
  payload: unknown,
): AudioIpcResult<RevealAudioOutputRequest> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }
  if (!isNonEmptyString(payload.outputToken)) {
    return invalidRequest("outputToken must be a non-empty string.", "outputToken");
  }
  return audioIpcSuccess({ outputToken: payload.outputToken });
}

export const validateReadAudioOutputIpcRequest =
  validateRevealAudioOutputIpcRequest;

export function validateSaveAudioTextOutputIpcRequest(
  payload: unknown,
): AudioIpcResult<SaveAudioTextOutputRequest> {
  if (!isRecord(payload)) return invalidRequest("Request payload must be an object.");
  if (!isNonEmptyString(payload.defaultName) || payload.defaultName.length > 240) {
    return invalidRequest("defaultName must be a valid file name.", "defaultName");
  }
  if (typeof payload.content !== "string" || payload.content.length > 10 * 1024 * 1024) {
    return invalidRequest("content exceeds the 10MB text limit.", "content");
  }
  if (
    payload.extension !== "txt" &&
    payload.extension !== "json" &&
    payload.extension !== "srt" &&
    payload.extension !== "vtt"
  ) {
    return invalidRequest("extension is not supported.", "extension");
  }
  return audioIpcSuccess({
    defaultName: payload.defaultName,
    content: payload.content,
    extension: payload.extension,
  });
}

export function isSpeechSynthesisStreamEventPayload(
  payload: unknown,
): payload is SpeechSynthesisStreamEvent {
  if (!isRecord(payload) || !isNonEmptyString(payload.requestId)) {
    return false;
  }

  switch (payload.type) {
    case "started":
      return payload.sampleRate === 24000 && payload.channels === 1;
    case "audio_delta":
      return payload.pcmBytes instanceof Uint8Array;
    case "text_delta":
      return typeof payload.text === "string";
    case "metadata":
      return isRecord(payload.stats);
    case "completed":
      return isAuthorizedSpeechSynthesisResult(payload.result);
    case "error":
      return isAudioIpcError(payload.error);
    default:
      return false;
  }
}

function isAuthorizedSpeechSynthesisResult(
  value: unknown,
): value is AuthorizedSpeechSynthesisResult {
  if (!isRecord(value) || "outputPath" in value) return false;
  if (
    findUnexpectedField(value, [
      "outputToken",
      "mimeType",
      "responseFormat",
      "sizeBytes",
      "model",
      "durationMs",
      "streamStats",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.outputToken) &&
    isNonEmptyString(value.mimeType) &&
    isAudioSpeechResponseFormat(value.responseFormat) &&
    isFiniteNumber(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.durationMs === undefined || isFiniteNumber(value.durationMs)) &&
    (value.streamStats === undefined || isRecord(value.streamStats))
  );
}

export function isAudioRealtimeSessionEventPayload(
  payload: unknown,
): payload is AudioRealtimeSessionEvent {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return false;
  }

  switch (payload.type) {
    case "session_started":
      return isNonEmptyString(payload.sessionId);
    case "mic_state":
      return (
        payload.state === "requesting" ||
        payload.state === "granted" ||
        payload.state === "denied" ||
        payload.state === "muted"
      );
    case "transcript_delta":
    case "transcript_final":
      return isAudioRole(payload.role) && typeof payload.text === "string";
    case "audio_started":
      return (
        payload.role === "assistant" &&
        (payload.source === undefined ||
          payload.source === "response" ||
          payload.source === "output_buffer")
      );
    case "audio_stopped":
      return (
        payload.role === "assistant" &&
        (payload.source === undefined ||
          payload.source === "response" ||
          payload.source === "output_buffer") &&
        (payload.cleared === undefined || typeof payload.cleared === "boolean")
      );
    case "response_started":
      return isNonEmptyString(payload.responseId);
    case "response_completed":
      return (
        isNonEmptyString(payload.responseId) &&
        (payload.status === "completed" ||
          payload.status === "cancelled" ||
          payload.status === "failed" ||
          payload.status === "incomplete")
      );
    case "error":
      return isAudioIpcError(payload.error) && typeof payload.fatal === "boolean";
    case "session_closed":
      return (
        payload.reason === "user" ||
        payload.reason === "page_unload" ||
        payload.reason === "error"
      );
    default:
      return false;
  }
}

function validateCommonAudioTaskPayload(
  payload: unknown,
): AudioIpcResult<Record<string, unknown>> {
  if (!isRecord(payload)) {
    return invalidRequest("Request payload must be an object.");
  }

  const runtimeField = findForbiddenField(
    payload,
    FORBIDDEN_RUNTIME_CONFIG_FIELDS,
  );
  if (runtimeField) {
    return invalidRequest(
      "Audio API configuration must be resolved from global settings, not passed by the tool page.",
      runtimeField,
    );
  }

  const rawAudioField = findForbiddenField(
    payload,
    FORBIDDEN_AUDIO_PAYLOAD_FIELDS,
  );
  if (rawAudioField) {
    return invalidRequest(
      "Raw audio content must not be sent through audio IPC requests.",
      rawAudioField,
    );
  }

  if (!isAudioAssignmentKey(payload.assignmentKey)) {
    return invalidRequest("assignmentKey is not supported.", "assignmentKey");
  }

  return audioIpcSuccess(payload);
}

function validateRuntimeApiProfileSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<AudioRuntimeApiProfileSnapshot> {
  if (!isRecord(value)) {
    return invalidRequest("Runtime audio profile must be an object.", prefix);
  }
  const unexpectedField = findUnexpectedField(value, [
    "id",
    "providerPreset",
    "apiKey",
    "baseUrl",
    "routes",
    "verification",
  ], prefix);
  if (unexpectedField) {
    return invalidRequest(
      "Runtime audio profile contains an unsupported field.",
      unexpectedField,
    );
  }
  if (!isNonEmptyString(value.id)) {
    return invalidRequest("Runtime audio profile id is required.", `${prefix}.id`);
  }
  if (!isAudioProviderPreset(value.providerPreset)) {
    return invalidRequest(
      "Runtime audio provider preset is not supported.",
      `${prefix}.providerPreset`,
    );
  }
  if (typeof value.apiKey !== "string") {
    return invalidRequest(
      "Runtime audio profile apiKey must be a string.",
      `${prefix}.apiKey`,
    );
  }
  if (typeof value.baseUrl !== "string") {
    return invalidRequest(
      "Runtime audio profile baseUrl must be a string.",
      `${prefix}.baseUrl`,
    );
  }
  const routesResult = validateAudioApiRoutesSnapshot(
    value.routes,
    `${prefix}.routes`,
  );
  if (!routesResult.ok) return routesResult;
  const verificationResult = validateAudioRouteVerificationSnapshot(
    value.verification,
    `${prefix}.verification`,
  );
  if (!verificationResult.ok) return verificationResult;

  return audioIpcSuccess({
    id: value.id.trim(),
    providerPreset: value.providerPreset,
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
    routes: routesResult.data,
    ...(verificationResult.data
      ? { verification: verificationResult.data }
      : {}),
  });
}

function validateAudioApiRoutesSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<AudioApiRoutes> {
  if (!isRecord(value)) {
    return invalidRequest("Audio routes must be an object.", prefix);
  }
  const unexpectedField = findUnexpectedField(value, [
    "transcription",
    "speechSynthesis",
    "realtimeCaptions",
    "realtimeVoice",
  ], prefix);
  if (unexpectedField) {
    return invalidRequest("Audio routes contain an unsupported field.", unexpectedField);
  }
  if (!isRecord(value.speechSynthesis)) {
    return invalidRequest(
      "speechSynthesis routes must be an object.",
      `${prefix}.speechSynthesis`,
    );
  }

  const speechSynthesis: AudioApiRoutes["speechSynthesis"] = {};
  for (const [mode, routeValue] of Object.entries(value.speechSynthesis)) {
    if (!isSpeechSynthesisMode(mode)) {
      return invalidRequest(
        "Speech synthesis route mode is not supported.",
        `${prefix}.speechSynthesis.${mode}`,
      );
    }
    const routeResult = validateAudioRouteSnapshot(
      routeValue,
      `${prefix}.speechSynthesis.${mode}`,
    );
    if (!routeResult.ok) return routeResult;
    speechSynthesis[mode] = routeResult.data;
  }

  const optionalRoutes: Partial<
    Record<"transcription" | "realtimeCaptions" | "realtimeVoice", AudioRoute>
  > = {};
  for (const key of [
    "transcription",
    "realtimeCaptions",
    "realtimeVoice",
  ] as const) {
    if (value[key] === undefined) continue;
    const routeResult = validateAudioRouteSnapshot(value[key], `${prefix}.${key}`);
    if (!routeResult.ok) return routeResult;
    optionalRoutes[key] = routeResult.data;
  }

  return audioIpcSuccess({
    ...optionalRoutes,
    speechSynthesis,
  });
}

function validateAudioRouteSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<AudioRoute> {
  if (!isRecord(value)) {
    return invalidRequest("Audio route must be an object.", prefix);
  }
  const unexpectedField = findUnexpectedField(
    value,
    ["transport", "model", "enabled"],
    prefix,
  );
  if (unexpectedField) {
    return invalidRequest("Audio route contains an unsupported field.", unexpectedField);
  }
  if (!isAudioTransport(value.transport)) {
    return invalidRequest("Audio route transport is not supported.", `${prefix}.transport`);
  }
  if (!isNonEmptyString(value.model)) {
    return invalidRequest("Audio route model is required.", `${prefix}.model`);
  }
  if (typeof value.enabled !== "boolean") {
    return invalidRequest("Audio route enabled must be a boolean.", `${prefix}.enabled`);
  }
  return audioIpcSuccess({
    transport: value.transport,
    model: value.model.trim(),
    enabled: value.enabled,
  });
}

function validateAudioRouteVerificationSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<
  Partial<Record<AudioRouteKey, AudioRouteVerification>> | undefined
> {
  if (value === undefined) return audioIpcSuccess(undefined);
  if (!isRecord(value)) {
    return invalidRequest("Audio route verification must be an object.", prefix);
  }
  const verification: Partial<Record<AudioRouteKey, AudioRouteVerification>> = {};
  for (const [routeKey, rawVerification] of Object.entries(value)) {
    if (!isAudioRouteKeyValue(routeKey)) {
      return invalidRequest(
        "Audio route verification key is not supported.",
        `${prefix}.${routeKey}`,
      );
    }
    if (!isRecord(rawVerification)) {
      return invalidRequest(
        "Audio route verification must be an object.",
        `${prefix}.${routeKey}`,
      );
    }
    const unexpectedField = findUnexpectedField(
      rawVerification,
      ["status", "updatedAt"],
      `${prefix}.${routeKey}`,
    );
    if (unexpectedField) {
      return invalidRequest(
        "Audio route verification contains an unsupported field.",
        unexpectedField,
      );
    }
    if (!isAudioRouteVerificationStatus(rawVerification.status)) {
      return invalidRequest(
        "Audio route verification status is not supported.",
        `${prefix}.${routeKey}.status`,
      );
    }
    const updatedAt = optionalString(
      rawVerification.updatedAt,
      `${prefix}.${routeKey}.updatedAt`,
    );
    if (!updatedAt.ok) return updatedAt;
    verification[routeKey] = {
      status: rawVerification.status,
      ...(updatedAt.data ? { updatedAt: updatedAt.data } : {}),
    };
  }
  return audioIpcSuccess(verification);
}

function validateAudioTaskAssignmentSnapshot(
  value: unknown,
): AudioIpcResult<AudioTaskAssignment> {
  if (!isRecord(value)) {
    return invalidRequest("assignment must be an object.", "assignment");
  }
  const unexpectedField = findUnexpectedField(
    value,
    AUDIO_ASSIGNMENT_KEYS,
    "assignment",
  );
  if (unexpectedField) {
    return invalidRequest(
      "Audio assignment contains an unsupported field.",
      unexpectedField,
    );
  }

  const assignment: AudioTaskAssignment = { ...DEFAULT_AUDIO_TASK_ASSIGNMENT };
  for (const key of AUDIO_ASSIGNMENT_KEYS) {
    const candidate = value[key];
    if (candidate === null || candidate === undefined) {
      assignment[key] = null;
      continue;
    }
    if (typeof candidate !== "string") {
      return invalidRequest(
        "Audio assignment values must be strings or null.",
        `assignment.${key}`,
      );
    }
    assignment[key] = candidate.trim() || null;
  }
  return audioIpcSuccess(assignment);
}

function validateSpeechSynthesisIntent(
  intent: unknown,
): AudioIpcResult<SpeechSynthesisIntent> {
  if (!isRecord(intent)) {
    return invalidRequest("intent must be an object.", "intent");
  }
  if (!isSpeechSynthesisMode(intent.mode)) {
    return invalidRequest("Speech synthesis mode is not supported.", "intent.mode");
  }

  if (intent.mode === "preset_voice") {
    const unexpected = findUnexpectedField(
      intent,
      ["mode", "voice", "styleInstruction"],
      "intent",
    );
    if (unexpected) return invalidRequest("Preset voice intent contains an unsupported field.", unexpected);
    if (!isNonEmptyString(intent.voice)) {
      return invalidRequest("voice is required for preset voice.", "intent.voice");
    }
    const styleInstruction = optionalString(
      intent.styleInstruction,
      "intent.styleInstruction",
    );
    if (!styleInstruction.ok) return styleInstruction;
    return audioIpcSuccess({
      mode: "preset_voice",
      voice: intent.voice.trim(),
      ...(styleInstruction.data
        ? { styleInstruction: styleInstruction.data }
        : {}),
    });
  }

  if (intent.mode === "voice_design") {
    const unexpected = findUnexpectedField(
      intent,
      ["mode", "voiceDesignPrompt", "optimizeTextPreview"],
      "intent",
    );
    if (unexpected) return invalidRequest("Voice design intent contains an unsupported field.", unexpected);
    if (!isNonEmptyString(intent.voiceDesignPrompt)) {
      return invalidRequest(
        "voiceDesignPrompt is required for voice design.",
        "intent.voiceDesignPrompt",
      );
    }
    if (
      intent.optimizeTextPreview !== undefined &&
      typeof intent.optimizeTextPreview !== "boolean"
    ) {
      return invalidRequest(
        "optimizeTextPreview must be a boolean when provided.",
        "intent.optimizeTextPreview",
      );
    }
    return audioIpcSuccess({
      mode: "voice_design",
      voiceDesignPrompt: intent.voiceDesignPrompt.trim(),
      ...(intent.optimizeTextPreview !== undefined
        ? { optimizeTextPreview: intent.optimizeTextPreview }
        : {}),
    });
  }

  const unexpected = findUnexpectedField(
    intent,
    ["mode", "voiceSampleToken", "styleInstruction"],
    "intent",
  );
  if (unexpected) return invalidRequest("Voice clone intent contains an unsupported field.", unexpected);
  if (!isNonEmptyString(intent.voiceSampleToken)) {
    return invalidRequest(
      "voiceSampleToken is required for voice clone.",
      "intent.voiceSampleToken",
    );
  }
  const styleInstruction = optionalString(
    intent.styleInstruction,
    "intent.styleInstruction",
  );
  if (!styleInstruction.ok) return styleInstruction;
  return audioIpcSuccess({
    mode: "voice_clone",
    voiceSampleToken: intent.voiceSampleToken,
    ...(styleInstruction.data ? { styleInstruction: styleInstruction.data } : {}),
  });
}

function optionalTimestampGranularities(
  value: unknown,
): AudioIpcResult<AudioTimestampGranularity[] | undefined> {
  if (value === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (!Array.isArray(value)) {
    return invalidRequest(
      "timestampGranularities must be an array when provided.",
      "timestampGranularities",
    );
  }
  const granularities: AudioTimestampGranularity[] = [];
  for (const [index, item] of value.entries()) {
    if (item !== "word" && item !== "segment") {
      return invalidRequest(
        "timestampGranularities only supports word or segment.",
        `timestampGranularities.${index}`,
      );
    }
    granularities.push(item);
  }
  return audioIpcSuccess(granularities);
}

function optionalOutputPathMode(
  value: unknown,
): AudioIpcResult<AudioOutputPathMode | undefined> {
  if (value === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (value === "temp" || value === "source_dir" || value === "custom_dir") {
    return audioIpcSuccess(value);
  }
  return invalidRequest(
    "outputPathMode must be temp, source_dir, or custom_dir.",
    "outputPathMode",
  );
}

function validateOutputDirectoryToken(
  value: unknown,
  outputPathMode: AudioOutputPathMode | undefined,
): AudioIpcResult<string | undefined> {
  if (outputPathMode === "custom_dir") {
    if (!isNonEmptyString(value)) {
      return invalidRequest(
        "custom_dir output requires an authorized outputDirToken.",
        "outputDirToken",
      );
    }
    return audioIpcSuccess(value.trim());
  }
  if (value !== undefined) {
    return invalidRequest(
      "outputDirToken is only valid for custom_dir output.",
      "outputDirToken",
    );
  }
  return audioIpcSuccess(undefined);
}

function optionalRealtimeAudioFormat(
  value: unknown,
  field: string,
): AudioIpcResult<"pcm16" | "pcmu" | "pcma" | undefined> {
  if (value === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (value === "pcm16" || value === "pcmu" || value === "pcma") {
    return audioIpcSuccess(value);
  }
  return invalidRequest(`${field} must be pcm16, pcmu, or pcma.`, field);
}

function optionalString(
  value: unknown,
  field: string,
): AudioIpcResult<string | undefined> {
  if (value === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (typeof value === "string") {
    return audioIpcSuccess(value);
  }
  return invalidRequest(`${field} must be a string when provided.`, field);
}

function optionalBoolean(
  value: unknown,
  field: string,
): AudioIpcResult<boolean | undefined> {
  if (value === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (typeof value === "boolean") {
    return audioIpcSuccess(value);
  }
  return invalidRequest(`${field} must be a boolean when provided.`, field);
}

function isAudioIpcError(value: unknown): value is AudioIpcError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isAudioRole(value: unknown): value is AudioRole {
  return value === "user" || value === "assistant";
}

function isAudioRouteKeyValue(value: string): value is AudioRouteKey {
  return (
    value === "transcription" ||
    value === "realtimeCaptions" ||
    value === "realtimeVoice" ||
    value === "speechSynthesis.preset_voice" ||
    value === "speechSynthesis.voice_design" ||
    value === "speechSynthesis.voice_clone"
  );
}

function isAudioRouteVerificationStatus(
  value: unknown,
): value is AudioRouteVerification["status"] {
  return (
    value === "untested" ||
    value === "verified" ||
    value === "degraded" ||
    value === "failed"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalidRequest(
  message: string,
  field?: string,
  details?: Record<string, unknown>,
): AudioIpcResult<never> {
  return audioIpcFailure({
    code: "invalid_ipc_request",
    message,
    field,
    ...(details ? { details } : {}),
  });
}

function normalizeAudioChunkBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return undefined;
}

function findForbiddenField(
  payload: Record<string, unknown>,
  forbiddenKeys: readonly string[],
  prefix?: string,
): string | undefined {
  for (const [key, value] of Object.entries(payload)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (forbiddenKeys.includes(key)) {
      return field;
    }
    if (isRecord(value)) {
      const nested = findForbiddenField(value, forbiddenKeys, field);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findUnexpectedField(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix?: string,
): string | undefined {
  const unexpectedKey = Object.keys(value).find(
    (key) => !allowedKeys.includes(key),
  );
  if (!unexpectedKey) return undefined;
  return prefix ? `${prefix}.${unexpectedKey}` : unexpectedKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
