import axios from "axios";
import { readFile } from "node:fs/promises";
import { normalizeAudioEndpoint } from "@/lib/audio-endpoint";
import {
  inferAudioProviderPresetFromLegacy,
  resolveTranscriptionRouteDefinition,
} from "@/lib/audio-provider-registry";
import type {
  AudioSpeechResponseFormat,
  AudioTranscriptSegment,
  AudioTranscriptWord,
  AudioTranscriptionResponseFormat,
  AudioTranscriptionResult,
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  createSpeechOutputFileNameHint,
  createTranscriptOutputFileNameHint,
  detectAudioMimeTypeFromHeader,
  discardAudioOutputIfAborted,
  resolveAudioInputFile,
  resolveAudioOutputPath,
  writeAudioOutputFile,
} from "../audio-file";
import { createPcm16WavBuffer } from "../audio-stream";
import { createAudioRuntimeError } from "../audio-errors";
import {
  createAudioHttpErrorFromResponse,
  resolveAudioAxiosProxyConfig,
  runAudioRuntimeRequest,
  throwIfAudioRequestAborted,
} from "../audio-http";
import type {
  AudioRuntimeSpeechSynthesisRequest,
  AudioRuntimeTranscriptionRequest,
} from "../audio-runtime-client";

const OPENAI_SPEECH_MIME_BY_FORMAT: Record<
  Exclude<AudioSpeechResponseFormat, "pcm16">,
  string
> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

export async function sendOpenAIAudioTranscription(
  request: AudioRuntimeTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  return runAudioRuntimeRequest(
    {
      apiKey: request.model.apiKey,
      signal: request.signal,
      proxy: request.proxy,
      retry: request.retry,
    },
    async (attempt) => sendOpenAIAudioTranscriptionOnce(request, attempt),
  );
}

export async function sendOpenAISpeechSynthesis(
  request: AudioRuntimeSpeechSynthesisRequest,
): Promise<SpeechSynthesisResult> {
  return runAudioRuntimeRequest(
    {
      apiKey: request.model.apiKey,
      signal: request.signal,
      proxy: request.proxy,
      retry: request.retry,
    },
    async (attempt) => sendOpenAISpeechSynthesisOnce(request, attempt),
  );
}

async function sendOpenAIAudioTranscriptionOnce(
  request: AudioRuntimeTranscriptionRequest,
  attempt: number,
): Promise<AudioTranscriptionResult> {
  const endpoint = normalizeAudioEndpoint(request.model.baseUrl);
  if (!endpoint.audioTranscriptionsUrl) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "Audio transcription endpoint is not configured.",
      field: "baseUrl",
    });
  }
  validateOpenAITranscriptionPayload(request);

  const fileInfo = await resolveAudioInputFile({
    filePath: request.payload.filePath,
    mimeType: request.payload.mimeType,
    dialect: "openai_audio",
  });
  const form = await createOpenAITranscriptionForm(request, fileInfo.fileName);

  const response = await axios.post(endpoint.audioTranscriptionsUrl, form, {
    headers: {
      Authorization: `Bearer ${request.model.apiKey}`,
    },
    timeout: request.timeoutMs ?? 60_000,
    signal: request.signal,
    validateStatus: () => true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    ...(request.payload.stream ? { responseType: "stream" as const } : {}),
    ...resolveAudioAxiosProxyConfig(request.proxy),
  });

  if (response.status < 200 || response.status >= 300) {
    throw createAudioHttpErrorFromResponse({
      status: response.status,
      body: request.payload.stream
        ? await readOpenAIStreamBodyAsText(response.data)
        : response.data,
      headers: response.headers,
      attempt,
      apiKey: request.model.apiKey,
    });
  }

  const transcriptionContentType = readResponseHeader(
    response.headers,
    "content-type",
  )?.toLowerCase();
  if (transcriptionContentType?.includes("text/html")) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "Audio transcription returned HTML instead of a transcript.",
      details: { attempt, contentType: transcriptionContentType },
    });
  }

  const result = request.payload.stream
    ? await parseOpenAITranscriptionStream(
        response.data,
        request.payload.responseFormat,
        attempt,
        request.signal,
      )
    : parseOpenAITranscriptionResponse(
        response.data,
        request.payload.responseFormat,
        attempt,
      );
  const outputPath = await maybeWriteTranscriptionOutput(request, result);
  return {
    ...result,
    ...(outputPath ? { outputPath } : {}),
    model: result.model ?? request.model.modelKey,
  };
}

function validateOpenAITranscriptionPayload(
  request: AudioRuntimeTranscriptionRequest,
): void {
  const providerPreset = request.model.providerPreset ??
    inferAudioProviderPresetFromLegacy({
      transport: request.model.audioDialect,
      connectionProvider: request.model.provider,
    }).preset;
  const definition = resolveTranscriptionRouteDefinition({
    providerPreset,
    transport: request.model.audioDialect,
    model: request.model.modelKey,
  });
  if (!definition) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "The selected OpenAI transcription model is not supported.",
      field: "modelKey",
      details: { modelKey: request.model.modelKey },
    });
  }
  const { constraints } = definition;
  if (!constraints.responseFormats.includes(request.payload.responseFormat)) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "The selected transcription model does not support this response format.",
      field: "responseFormat",
      details: {
        modelKey: request.model.modelKey,
        responseFormat: request.payload.responseFormat,
      },
    });
  }
  if (request.payload.stream && !constraints.supportsStreaming) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "The selected transcription model does not support streaming.",
      field: "stream",
      details: { modelKey: request.model.modelKey },
    });
  }
  if (
    request.payload.timestampGranularities?.length &&
    (!constraints.supportsTimestampGranularities ||
      request.payload.responseFormat !== "verbose_json")
  ) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message:
        "Timestamp granularities require a model with verbose JSON timestamp support.",
      field: "timestampGranularities",
      details: { modelKey: request.model.modelKey },
    });
  }
  if (request.payload.prompt?.trim() && !constraints.supportsPrompt) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "The selected transcription model does not support prompts.",
      field: "prompt",
      details: { modelKey: request.model.modelKey },
    });
  }
}

async function parseOpenAITranscriptionStream(
  stream: unknown,
  responseFormat: AudioTranscriptionResponseFormat,
  attempt: number,
  signal?: AbortSignal,
): Promise<AudioTranscriptionResult> {
  let text = "";
  let doneEvent: Record<string, unknown> | undefined;

  for await (const data of iterateOpenAISseDataValues(stream, signal)) {
    if (data === "[DONE]") break;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch (error) {
      throw createAudioRuntimeError({
        code: "stream_parse_failed",
        message: "OpenAI transcription stream contained invalid SSE JSON.",
        details: { attempt },
        cause: error,
      });
    }
    if (!isRecord(event)) continue;
    if (event.type === "transcript.text.delta" && typeof event.delta === "string") {
      text += event.delta;
    }
    if (event.type === "transcript.text.done") {
      doneEvent = event;
      const finalText =
        typeof event.text === "string"
          ? event.text
          : typeof event.transcript === "string"
            ? event.transcript
            : undefined;
      if (finalText !== undefined) text = finalText;
    }
  }

  if (!text.trim()) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "OpenAI streaming transcription response is empty.",
      details: { attempt },
    });
  }

  return {
    text,
    responseFormat,
    rawText: text,
    rawJson: doneEvent ?? { text },
    streamMode: "incremental",
  };
}

async function createOpenAITranscriptionForm(
  request: AudioRuntimeTranscriptionRequest,
  resolvedFileName: string,
): Promise<FormData> {
  let bytes: Buffer;
  try {
    bytes = await readFile(request.payload.filePath);
  } catch (error) {
    throw createAudioRuntimeError({
      code: "file_read_failed",
      message: "Audio file could not be read.",
      field: "filePath",
      details: { filePath: request.payload.filePath },
      cause: error,
    });
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: request.payload.mimeType }),
    request.payload.fileName || resolvedFileName,
  );
  form.append("model", request.model.modelKey);
  form.append("response_format", request.payload.responseFormat);

  if (request.payload.language) {
    form.append("language", request.payload.language);
  }
  if (request.payload.prompt) {
    form.append("prompt", request.payload.prompt);
  }
  if (request.payload.temperature !== undefined) {
    form.append("temperature", String(request.payload.temperature));
  }
  if (request.payload.stream !== undefined) {
    form.append("stream", String(request.payload.stream));
  }
  for (const granularity of request.payload.timestampGranularities ?? []) {
    form.append("timestamp_granularities[]", granularity);
  }

  return form;
}

function parseOpenAITranscriptionResponse(
  data: unknown,
  responseFormat: AudioTranscriptionResponseFormat,
  attempt: number,
): AudioTranscriptionResult {
  const parsed = parseJsonStringIfPossible(data);

  if (responseFormat === "text" || responseFormat === "srt" || responseFormat === "vtt") {
    const text = extractTranscriptionText(parsed);
    if (!text.trim()) {
      throw createAudioRuntimeError({
        code: "empty_response",
        message: "Audio transcription response is empty.",
        details: { attempt },
      });
    }
    return {
      text,
      responseFormat,
      ...(typeof parsed === "string" ? { rawText: parsed } : {}),
      ...(isRecord(parsed) ? { rawJson: parsed } : {}),
      ...(isRecord(parsed) && typeof parsed.model === "string"
        ? { model: parsed.model }
        : {}),
    };
  }

  if (!isRecord(parsed)) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "Audio transcription JSON response is not an object.",
      details: { attempt },
    });
  }

  const text = typeof parsed.text === "string" ? parsed.text : "";
  if (!text.trim()) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "Audio transcription response text is empty.",
      details: { attempt },
    });
  }

  return {
    text,
    responseFormat,
    rawJson: parsed,
    segments: parseTranscriptSegments(parsed.segments),
    words: parseTranscriptWords(parsed.words),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
  };
}

async function maybeWriteTranscriptionOutput(
  request: AudioRuntimeTranscriptionRequest,
  result: AudioTranscriptionResult,
): Promise<string | undefined> {
  if (request.payload.outputPathMode === undefined) {
    return undefined;
  }

  const outputPath = await resolveAudioOutputPath({
    outputPathMode: request.payload.outputPathMode,
    outputDir: request.payload.outputDir,
    sourcePath: request.payload.filePath,
    tempRoot: request.outputTempRoot,
    fileNameHint: createTranscriptOutputFileNameHint(request.payload.filePath),
    extension: getTranscriptionOutputExtension(request.payload.responseFormat),
    now: request.now,
  });
  const written = await writeAudioOutputFile(
    outputPath,
    serializeTranscriptionOutput(result, request.payload.responseFormat),
  );
  await discardAudioOutputIfAborted(written.outputPath, request.signal);
  return written.outputPath;
}

function getTranscriptionOutputExtension(
  responseFormat: AudioTranscriptionResponseFormat,
): string {
  switch (responseFormat) {
    case "json":
    case "verbose_json":
      return "json";
    case "srt":
      return "srt";
    case "vtt":
      return "vtt";
    case "text":
      return "txt";
  }
}

function serializeTranscriptionOutput(
  result: AudioTranscriptionResult,
  responseFormat: AudioTranscriptionResponseFormat,
): string {
  if (responseFormat === "json" || responseFormat === "verbose_json") {
    return JSON.stringify(result.rawJson ?? { text: result.text }, null, 2);
  }
  return result.rawText ?? result.text;
}

async function sendOpenAISpeechSynthesisOnce(
  request: AudioRuntimeSpeechSynthesisRequest,
  attempt: number,
): Promise<SpeechSynthesisResult> {
  const endpoint = normalizeAudioEndpoint(request.model.baseUrl);
  if (!endpoint.audioSpeechUrl) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "Audio speech endpoint is not configured.",
      field: "baseUrl",
    });
  }
  validateOpenAISpeechSynthesisPayload(request);

  const startedAt = Date.now();
  const response = await axios.post(
    endpoint.audioSpeechUrl,
    buildOpenAISpeechBody(request),
    {
      headers: {
        Authorization: `Bearer ${request.model.apiKey}`,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout: request.timeoutMs ?? 60_000,
      signal: request.signal,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      ...resolveAudioAxiosProxyConfig(request.proxy),
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw createAudioHttpErrorFromResponse({
      status: response.status,
      body: response.data,
      headers: response.headers,
      attempt,
      apiKey: request.model.apiKey,
    });
  }

  let audioBytes = Buffer.from(response.data);
  if (audioBytes.byteLength === 0) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "Speech synthesis response audio is empty.",
      details: { attempt },
    });
  }

  validateOpenAISpeechResponse(
    audioBytes,
    response.headers,
    request.payload.responseFormat,
    attempt,
  );
  const artifactFormat = request.payload.responseFormat === "pcm"
    ? "wav"
    : request.payload.responseFormat;
  if (request.payload.responseFormat === "pcm") {
    audioBytes = createPcm16WavBuffer([audioBytes], {
      sampleRate: 24_000,
      channels: 1,
    });
  }

  const outputPath = await resolveAudioOutputPath({
    outputPathMode: request.payload.outputPathMode,
    outputDir: request.payload.outputDir,
    tempRoot: request.outputTempRoot,
    fileNameHint:
      request.payload.fileNameHint || createSpeechOutputFileNameHint(request.now),
    extension: getOpenAISpeechOutputExtension(artifactFormat),
    now: request.now,
  });
  const written = await writeAudioOutputFile(outputPath, audioBytes);
  await discardAudioOutputIfAborted(written.outputPath, request.signal);

  return {
    outputPath: written.outputPath,
    sizeBytes: written.sizeBytes,
    responseFormat: artifactFormat,
    mimeType: OPENAI_SPEECH_MIME_BY_FORMAT[
      artifactFormat as Exclude<AudioSpeechResponseFormat, "pcm16">
    ],
    model: request.model.modelKey,
    durationMs: Date.now() - startedAt,
  };
}

function validateOpenAISpeechResponse(
  bytes: Buffer,
  headers: unknown,
  format: AudioSpeechResponseFormat,
  attempt: number,
): void {
  const contentType = readResponseHeader(headers, "content-type")?.toLowerCase();
  if (
    contentType &&
    !contentType.startsWith("audio/") &&
    !contentType.startsWith("application/octet-stream")
  ) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "Speech synthesis returned a non-audio content type.",
      details: { attempt, contentType },
    });
  }
  if (format === "pcm") return;
  const detected = detectAudioMimeTypeFromHeader(bytes.subarray(0, 16));
  const valid =
    (format === "wav" && detected === "audio/wav") ||
    (format === "mp3" && detected === "audio/mpeg") ||
    (format === "flac" && detected === "audio/flac") ||
    (format === "opus" && detected === "audio/ogg") ||
    (format === "aac" && bytes.length >= 2 && bytes[0] === 0xff &&
      (bytes[1] & 0xf6) === 0xf0);
  if (!valid) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "Speech synthesis response signature does not match the requested audio format.",
      details: { attempt, format, detected: detected ?? "unknown" },
    });
  }
}

function readResponseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: (key: string) => unknown }).get;
  const value = typeof getter === "function"
    ? getter.call(headers, name)
    : (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function validateOpenAISpeechSynthesisPayload(
  request: AudioRuntimeSpeechSynthesisRequest,
): void {
  if (request.payload.responseFormat === "pcm16") {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "OpenAI speech synthesis does not support pcm16 output.",
      field: "responseFormat",
      details: { responseFormat: request.payload.responseFormat },
    });
  }
  if (!request.payload.voice?.trim()) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "OpenAI speech synthesis requires a voice.",
      field: "voice",
    });
  }
  if (request.payload.mimoOptions) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo speech options cannot be sent to OpenAI speech synthesis.",
      field: "mimoOptions",
    });
  }
}

function buildOpenAISpeechBody(
  request: AudioRuntimeSpeechSynthesisRequest,
): Record<string, unknown> {
  return {
    model: request.model.modelKey,
    input: request.payload.input,
    voice: request.payload.voice,
    response_format: request.payload.responseFormat,
    ...(request.payload.instructions
      ? { instructions: request.payload.instructions }
      : {}),
    ...(request.payload.speed !== undefined ? { speed: request.payload.speed } : {}),
  };
}

function getOpenAISpeechOutputExtension(
  responseFormat: AudioSpeechResponseFormat,
): string {
  if (responseFormat === "pcm16") return "pcm";
  return responseFormat;
}

function extractTranscriptionText(data: unknown): string {
  if (typeof data === "string") return data;
  if (isRecord(data) && typeof data.text === "string") return data.text;
  return "";
}

function parseTranscriptSegments(
  value: unknown,
): AudioTranscriptSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value
    .filter(isRecord)
    .map((segment): AudioTranscriptSegment | undefined => {
      if (typeof segment.text !== "string") return undefined;
      return {
        text: segment.text,
        ...(typeof segment.id === "string" || typeof segment.id === "number"
          ? { id: segment.id }
          : {}),
        ...(typeof segment.start === "number" ? { start: segment.start } : {}),
        ...(typeof segment.end === "number" ? { end: segment.end } : {}),
      };
    })
    .filter((segment): segment is AudioTranscriptSegment => Boolean(segment));
  return segments.length > 0 ? segments : undefined;
}

function parseTranscriptWords(value: unknown): AudioTranscriptWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words = value
    .filter(isRecord)
    .map((word): AudioTranscriptWord | undefined => {
      if (typeof word.word !== "string") return undefined;
      return {
        word: word.word,
        ...(typeof word.start === "number" ? { start: word.start } : {}),
        ...(typeof word.end === "number" ? { end: word.end } : {}),
      };
    })
    .filter((word): word is AudioTranscriptWord => Boolean(word));
  return words.length > 0 ? words : undefined;
}

function parseJsonStringIfPossible(data: unknown): unknown {
  if (typeof data !== "string") return data;
  const trimmed = data.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return data;
  try {
    return JSON.parse(trimmed);
  } catch {
    return data;
  }
}

async function readOpenAIStreamBodyAsText(
  stream: unknown,
): Promise<string | undefined> {
  if (typeof stream === "string") return stream;
  if (Buffer.isBuffer(stream)) return stream.toString("utf8");
  if (stream instanceof Uint8Array) return Buffer.from(stream).toString("utf8");
  if (!isAsyncIterable(stream)) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(toBuffer(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function* iterateOpenAISseDataValues(
  stream: unknown,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!isAsyncIterable(stream)) {
    throw createAudioRuntimeError({
      code: "stream_parse_failed",
      message: "OpenAI transcription stream is not readable.",
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    throwIfAudioRequestAborted(signal);
    buffer += decoder.decode(toBuffer(chunk), { stream: true });
    while (true) {
      const separator = findSseSeparator(buffer);
      if (!separator) break;
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const data = extractSseData(rawEvent);
      if (data !== undefined) yield data;
    }
  }
  buffer += decoder.decode();
  const remaining = extractSseData(buffer);
  if (remaining !== undefined) yield remaining;
}

function findSseSeparator(
  value: string,
): { index: number; length: number } | undefined {
  const crlfIndex = value.indexOf("\r\n\r\n");
  const lfIndex = value.indexOf("\n\n");
  if (crlfIndex < 0 && lfIndex < 0) return undefined;
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

function extractSseData(rawEvent: string): string | undefined {
  const lines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (lines.length === 0) return undefined;
  const data = lines.join("\n").trimEnd();
  return data || undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(String(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
