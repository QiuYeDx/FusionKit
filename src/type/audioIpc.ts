import type {
  AudioApiDialect,
  AudioAssignmentKey,
  AudioCapability,
  AudioModelAssignment,
  AudioModelProfile,
  AudioOutputPathMode,
  AudioRealtimeSessionCloseReason,
  AudioRealtimeSessionConfig,
  AudioRole,
  AudioSpeechResponseFormat,
  AudioStreamStats,
  AudioTimestampGranularity,
  AudioTranscriptionResponseFormat,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
  MimoSpeechOptions,
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  AUDIO_ASSIGNMENT_KEYS,
  AUDIO_CAPABILITIES,
  AUDIO_API_DIALECTS,
  DEFAULT_AUDIO_MODEL_ASSIGNMENT,
  isAudioAssignmentKey,
  isAudioSpeechResponseFormat,
  isAudioTranscriptionResponseFormat,
  isMimoSpeechSynthesisMode,
} from "@/type/audio";
import { Model } from "@/type/model";

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
  path: string;
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

export interface AudioRuntimeConnectionProfileSnapshot {
  id: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
}

export interface SyncAudioRuntimeConfigRequest {
  connectionProfiles: AudioRuntimeConnectionProfileSnapshot[];
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;
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
  path?: string;
}

export interface AuthorizedAudioInputFile {
  fileToken: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: number;
}

export type CreateAudioTranscriptionIpcRequest = Omit<
  CreateAudioTranscriptionRequest,
  "filePath"
> & {
  fileToken: string;
};

export type MimoSpeechIpcOptions = Omit<MimoSpeechOptions, "voiceSamplePath"> & {
  voiceSampleToken?: string;
};

export type CreateSpeechSynthesisIpcRequest = Omit<
  CreateSpeechSynthesisRequest,
  "mimoOptions"
> & {
  mimoOptions?: MimoSpeechIpcOptions;
};

export interface CreateSpeechSynthesisStreamIpcRequest {
  requestId: string;
  payload: CreateSpeechSynthesisIpcRequest;
}

export interface AudioRendererApi {
  invoke<TResponse>(
    channel: AudioIpcChannel,
    payload: unknown,
    options?: { configRevision?: string },
  ): Promise<AudioIpcResult<TResponse>>;
  authorizeInputFile(file: File): Promise<AudioIpcResult<AuthorizedAudioInputFile>>;
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

export type SpeechSynthesisStreamEvent =
  | { type: "started"; requestId: string; sampleRate: 24000; channels: 1 }
  | { type: "audio_delta"; requestId: string; pcmBytes: Uint8Array }
  | { type: "text_delta"; requestId: string; text: string }
  | {
      type: "metadata";
      requestId: string;
      stats: Partial<AudioStreamStats>;
    }
  | { type: "completed"; requestId: string; result: SpeechSynthesisResult }
  | { type: "error"; requestId: string; error: AudioIpcError };

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
  | { type: "audio_started"; role: "assistant"; responseId?: string; itemId?: string }
  | { type: "audio_stopped"; role: "assistant"; responseId?: string; itemId?: string }
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

  if (!Array.isArray(payload.connectionProfiles)) {
    return invalidRequest(
      "connectionProfiles must be an array.",
      "connectionProfiles",
    );
  }
  if (!Array.isArray(payload.audioProfiles)) {
    return invalidRequest("audioProfiles must be an array.", "audioProfiles");
  }

  const connectionProfiles: AudioRuntimeConnectionProfileSnapshot[] = [];
  for (const [index, value] of payload.connectionProfiles.entries()) {
    const result = validateRuntimeConnectionProfileSnapshot(
      value,
      `connectionProfiles.${index}`,
    );
    if (!result.ok) return result;
    connectionProfiles.push(result.data);
  }

  const audioProfiles: AudioModelProfile[] = [];
  for (const [index, value] of payload.audioProfiles.entries()) {
    const result = validateAudioModelProfileSnapshot(
      value,
      `audioProfiles.${index}`,
    );
    if (!result.ok) return result;
    audioProfiles.push(result.data);
  }

  const assignmentResult = validateAudioModelAssignmentSnapshot(
    payload.audioAssignment,
  );
  if (!assignmentResult.ok) return assignmentResult;

  return audioIpcSuccess({
    connectionProfiles,
    audioProfiles,
    audioAssignment: assignmentResult.data,
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
  const outputDir = optionalString(record.outputDir, "outputDir");
  if (!outputDir.ok) return outputDir;
  const outputPathMode = optionalOutputPathMode(record.outputPathMode);
  if (!outputPathMode.ok) return outputPathMode;

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
    ...(outputDir.data !== undefined ? { outputDir: outputDir.data } : {}),
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

  if (typeof record.input !== "string") {
    return invalidRequest("input must be a string.", "input");
  }
  if (record.input.length > 4096) {
    return invalidRequest("input exceeds 4096 characters.", "input");
  }
  const requestId = optionalString(record.requestId, "requestId");
  if (!requestId.ok) return requestId;

  if (!isAudioSpeechResponseFormat(record.responseFormat)) {
    return invalidRequest(
      "Speech response format is not supported.",
      "responseFormat",
    );
  }
  const responseFormat = record.responseFormat;

  const voice = optionalString(record.voice, "voice");
  if (!voice.ok) return voice;
  const instructions = optionalString(record.instructions, "instructions");
  if (!instructions.ok) return instructions;
  if (instructions.data && instructions.data.length > 4096) {
    return invalidRequest("instructions exceeds 4096 characters.", "instructions");
  }
  const outputDir = optionalString(record.outputDir, "outputDir");
  if (!outputDir.ok) return outputDir;
  const fileNameHint = optionalString(record.fileNameHint, "fileNameHint");
  if (!fileNameHint.ok) return fileNameHint;
  const outputPathMode = optionalOutputPathMode(record.outputPathMode);
  if (!outputPathMode.ok) return outputPathMode;

  if (
    record.speed !== undefined &&
    (!isFiniteNumber(record.speed) || record.speed < 0.25 || record.speed > 4)
  ) {
    return invalidRequest("speed must be between 0.25 and 4.", "speed");
  }

  const stream = optionalBoolean(record.stream, "stream");
  if (!stream.ok) return stream;

  const mimoOptionsResult = validateMimoSpeechOptions(record.mimoOptions);
  if (!mimoOptionsResult.ok) return mimoOptionsResult;

  if (
    record.input.trim().length === 0 &&
    !mimoOptionsResult.data?.optimizeTextPreview
  ) {
    return invalidRequest(
      "input must be non-empty unless MiMo optimizeTextPreview is enabled.",
      "input",
    );
  }

  return audioIpcSuccess({
    assignmentKey: "speechSynthesis",
    ...(requestId.data ? { requestId: requestId.data } : {}),
    input: record.input,
    ...(voice.data !== undefined ? { voice: voice.data } : {}),
    ...(instructions.data !== undefined
      ? { instructions: instructions.data }
      : {}),
    responseFormat,
    ...(record.speed !== undefined ? { speed: record.speed } : {}),
    ...(stream.data !== undefined ? { stream: stream.data } : {}),
    ...(outputPathMode.data ? { outputPathMode: outputPathMode.data } : {}),
    ...(outputDir.data !== undefined ? { outputDir: outputDir.data } : {}),
    ...(fileNameHint.data !== undefined
      ? { fileNameHint: fileNameHint.data }
      : {}),
    ...(mimoOptionsResult.data ? { mimoOptions: mimoOptionsResult.data } : {}),
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
      return isRecord(payload.result);
    case "error":
      return isAudioIpcError(payload.error);
    default:
      return false;
  }
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
    case "audio_stopped":
      return payload.role === "assistant";
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

function validateRuntimeConnectionProfileSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<AudioRuntimeConnectionProfileSnapshot> {
  if (!isRecord(value)) {
    return invalidRequest("Connection profile must be an object.", prefix);
  }
  if (!isNonEmptyString(value.id)) {
    return invalidRequest("Connection profile id is required.", `${prefix}.id`);
  }
  if (!isModelProvider(value.provider)) {
    return invalidRequest(
      "Connection profile provider is not supported.",
      `${prefix}.provider`,
    );
  }
  if (typeof value.apiKey !== "string") {
    return invalidRequest(
      "Connection profile apiKey must be a string.",
      `${prefix}.apiKey`,
    );
  }
  if (typeof value.baseUrl !== "string") {
    return invalidRequest(
      "Connection profile baseUrl must be a string.",
      `${prefix}.baseUrl`,
    );
  }

  return audioIpcSuccess({
    id: value.id,
    provider: value.provider,
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
  });
}

function validateAudioModelProfileSnapshot(
  value: unknown,
  prefix: string,
): AudioIpcResult<AudioModelProfile> {
  if (!isRecord(value)) {
    return invalidRequest("Audio profile must be an object.", prefix);
  }
  if (!isNonEmptyString(value.id)) {
    return invalidRequest("Audio profile id is required.", `${prefix}.id`);
  }
  if (!isNonEmptyString(value.name)) {
    return invalidRequest("Audio profile name is required.", `${prefix}.name`);
  }
  if (!isNonEmptyString(value.connectionProfileId)) {
    return invalidRequest(
      "Audio profile connectionProfileId is required.",
      `${prefix}.connectionProfileId`,
    );
  }
  if (!isAudioApiDialectValue(value.audioDialect)) {
    return invalidRequest(
      "Audio profile dialect is not supported.",
      `${prefix}.audioDialect`,
    );
  }
  if (!Array.isArray(value.capabilities)) {
    return invalidRequest(
      "Audio profile capabilities must be an array.",
      `${prefix}.capabilities`,
    );
  }
  if (!isRecord(value.models)) {
    return invalidRequest(
      "Audio profile models must be an object.",
      `${prefix}.models`,
    );
  }
  if (!isRecord(value.defaults)) {
    return invalidRequest(
      "Audio profile defaults must be an object.",
      `${prefix}.defaults`,
    );
  }

  const capabilities: AudioCapability[] = [];
  for (const [index, capability] of value.capabilities.entries()) {
    if (!isAudioCapabilityValue(capability)) {
      return invalidRequest(
        "Audio profile capability is not supported.",
        `${prefix}.capabilities.${index}`,
      );
    }
    capabilities.push(capability);
  }

  const transcription = optionalString(
    value.models.transcription,
    `${prefix}.models.transcription`,
  );
  if (!transcription.ok) return transcription;
  const speechSynthesis = optionalString(
    value.models.speechSynthesis,
    `${prefix}.models.speechSynthesis`,
  );
  if (!speechSynthesis.ok) return speechSynthesis;
  const realtime = optionalString(value.models.realtime, `${prefix}.models.realtime`);
  if (!realtime.ok) return realtime;
  const realtimeTranscription = optionalString(
    value.models.realtimeTranscription,
    `${prefix}.models.realtimeTranscription`,
  );
  if (!realtimeTranscription.ok) return realtimeTranscription;
  const realtimeVoice = optionalString(
    value.models.realtimeVoice,
    `${prefix}.models.realtimeVoice`,
  );
  if (!realtimeVoice.ok) return realtimeVoice;

  return audioIpcSuccess({
    id: value.id,
    name: value.name,
    connectionProfileId: value.connectionProfileId,
    audioDialect: value.audioDialect,
    capabilities,
    models: {
      ...(transcription.data ? { transcription: transcription.data } : {}),
      ...(speechSynthesis.data
        ? { speechSynthesis: speechSynthesis.data }
        : {}),
      ...(realtime.data ? { realtime: realtime.data } : {}),
      ...(realtimeTranscription.data
        ? { realtimeTranscription: realtimeTranscription.data }
        : {}),
      ...(realtimeVoice.data ? { realtimeVoice: realtimeVoice.data } : {}),
    },
    defaults: value.defaults as AudioModelProfile["defaults"],
    ...(isRecord(value.verification)
      ? { verification: value.verification as AudioModelProfile["verification"] }
      : {}),
  });
}

function validateAudioModelAssignmentSnapshot(
  value: unknown,
): AudioIpcResult<AudioModelAssignment> {
  if (!isRecord(value)) {
    return invalidRequest("audioAssignment must be an object.", "audioAssignment");
  }

  const assignment: AudioModelAssignment = { ...DEFAULT_AUDIO_MODEL_ASSIGNMENT };
  for (const key of AUDIO_ASSIGNMENT_KEYS) {
    const candidate = value[key];
    if (candidate === null || candidate === undefined) {
      assignment[key] = null;
      continue;
    }
    if (typeof candidate !== "string") {
      return invalidRequest(
        "Audio assignment values must be strings or null.",
        `audioAssignment.${key}`,
      );
    }
    assignment[key] = candidate;
  }
  return audioIpcSuccess(assignment);
}

function validateMimoSpeechOptions(
  options: unknown,
): AudioIpcResult<MimoSpeechIpcOptions | undefined> {
  if (options === undefined) {
    return audioIpcSuccess(undefined);
  }
  if (!isRecord(options)) {
    return invalidRequest("mimoOptions must be an object.", "mimoOptions");
  }

  const rawAudioField = findForbiddenField(
    options,
    FORBIDDEN_AUDIO_PAYLOAD_FIELDS,
    "mimoOptions",
  );
  if (rawAudioField) {
    return invalidRequest(
      "MiMo voice clone reference audio must be passed as a file path, not raw audio content.",
      rawAudioField,
    );
  }

  if (!isMimoSpeechSynthesisMode(options.mode)) {
    return invalidRequest(
      "MiMo speech synthesis mode is not supported.",
      "mimoOptions.mode",
    );
  }

  const styleInstruction = optionalString(
    options.styleInstruction,
    "mimoOptions.styleInstruction",
  );
  if (!styleInstruction.ok) return styleInstruction;
  const voiceDesignPrompt = optionalString(
    options.voiceDesignPrompt,
    "mimoOptions.voiceDesignPrompt",
  );
  if (!voiceDesignPrompt.ok) return voiceDesignPrompt;
  if (options.voiceSamplePath !== undefined) {
    return invalidRequest(
      "Renderer audio requests must use an authorized voiceSampleToken, not voiceSamplePath.",
      "mimoOptions.voiceSamplePath",
    );
  }
  const voiceSampleToken = optionalString(
    options.voiceSampleToken,
    "mimoOptions.voiceSampleToken",
  );
  if (!voiceSampleToken.ok) return voiceSampleToken;

  if (
    options.optimizeTextPreview !== undefined &&
    typeof options.optimizeTextPreview !== "boolean"
  ) {
    return invalidRequest(
      "optimizeTextPreview must be a boolean when provided.",
      "mimoOptions.optimizeTextPreview",
    );
  }
  if (
    options.audioTagsEnabled !== undefined &&
    typeof options.audioTagsEnabled !== "boolean"
  ) {
    return invalidRequest(
      "audioTagsEnabled must be a boolean when provided.",
      "mimoOptions.audioTagsEnabled",
    );
  }
  if (
    options.voiceSampleMime !== undefined &&
    options.voiceSampleMime !== "audio/mpeg" &&
    options.voiceSampleMime !== "audio/mp3" &&
    options.voiceSampleMime !== "audio/wav"
  ) {
    return invalidRequest(
      "voiceSampleMime must be audio/mpeg, audio/mp3, or audio/wav.",
      "mimoOptions.voiceSampleMime",
    );
  }

  if (
    options.mode === "voice_design" &&
    !voiceDesignPrompt.data &&
    options.optimizeTextPreview !== true
  ) {
    return invalidRequest(
      "voiceDesignPrompt is required for voice design unless optimizeTextPreview is enabled.",
      "mimoOptions.voiceDesignPrompt",
    );
  }

  if (options.mode === "voice_clone" && !voiceSampleToken.data) {
    return invalidRequest(
      "voiceSampleToken is required for voice clone.",
      "mimoOptions.voiceSampleToken",
    );
  }

  return audioIpcSuccess({
    mode: options.mode,
    ...(styleInstruction.data !== undefined
      ? { styleInstruction: styleInstruction.data }
      : {}),
    ...(voiceDesignPrompt.data !== undefined
      ? { voiceDesignPrompt: voiceDesignPrompt.data }
      : {}),
    ...(options.optimizeTextPreview !== undefined
      ? { optimizeTextPreview: options.optimizeTextPreview }
      : {}),
    ...(voiceSampleToken.data !== undefined
      ? { voiceSampleToken: voiceSampleToken.data }
      : {}),
    ...(options.voiceSampleMime !== undefined
      ? { voiceSampleMime: options.voiceSampleMime }
      : {}),
    ...(options.audioTagsEnabled !== undefined
      ? { audioTagsEnabled: options.audioTagsEnabled }
      : {}),
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

function isAudioApiDialectValue(value: unknown): value is AudioApiDialect {
  return (
    typeof value === "string" &&
    (AUDIO_API_DIALECTS as readonly string[]).includes(value)
  );
}

function isAudioCapabilityValue(value: unknown): value is AudioCapability {
  return (
    typeof value === "string" &&
    (AUDIO_CAPABILITIES as readonly string[]).includes(value)
  );
}

function isModelProvider(value: unknown): value is Model {
  return Object.values(Model).includes(value as Model);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
