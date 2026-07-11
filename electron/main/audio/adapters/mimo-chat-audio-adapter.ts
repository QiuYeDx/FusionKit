import axios from "axios";
import { normalizeAudioEndpoint } from "@/lib/audio-endpoint";
import type {
  AudioTranscriptionResult,
  MimoSpeechOptions,
  MimoSpeechSynthesisMode,
  SpeechSynthesisResult,
} from "@/type/audio";
import type { AudioIpcError, SpeechSynthesisStreamEvent } from "@/type/audioIpc";
import {
  createSpeechOutputFileNameHint,
  createTranscriptOutputFileNameHint,
  detectAudioMimeTypeFromHeader,
  discardAudioOutputIfAborted,
  readAudioFileAsDataUri,
  resolveAudioInputFile,
  resolveAudioOutputPath,
  writeAudioOutputFile,
} from "../audio-file";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
} from "../audio-errors";
import {
  createAudioHttpErrorFromResponse,
  resolveAudioAxiosProxyConfig,
  runAudioRuntimeRequest,
  throwIfAudioRequestAborted,
} from "../audio-http";
import {
  createAudioStreamStats,
  writePcm16WavFile,
} from "../audio-stream";
import type {
  AudioRuntimeSpeechSynthesisRequest,
  AudioRuntimeTranscriptionRequest,
} from "../audio-runtime-client";

const MIMO_ASR_LANGUAGES = new Set(["auto", "zh", "en"]);
const MIMO_TTS_MODEL_BY_MODE: Record<MimoSpeechSynthesisMode, string> = {
  preset_voice: "mimo-v2.5-tts",
  voice_design: "mimo-v2.5-tts-voicedesign",
  voice_clone: "mimo-v2.5-tts-voiceclone",
};
const MIMO_STREAM_SAMPLE_RATE = 24_000;
const MIMO_STREAM_CHANNELS = 1;
const MIMO_MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const MIMO_MAX_STREAM_AUDIO_BYTES = 64 * 1024 * 1024;
const MIMO_MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;

interface BuildMimoSpeechBodyOptions {
  stream: boolean;
}

interface MimoStreamChunkPayload {
  model?: string;
  audioBase64?: string;
  finalAudioBase64?: string;
  text?: string;
}

export async function sendMimoAudioTranscription(
  request: AudioRuntimeTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  return runAudioRuntimeRequest(
    {
      apiKey: request.model.apiKey,
      signal: request.signal,
      proxy: request.proxy,
      retry: request.retry,
    },
    async (attempt) => sendMimoAudioTranscriptionOnce(request, attempt),
  );
}

export async function sendMimoSpeechSynthesis(
  request: AudioRuntimeSpeechSynthesisRequest,
): Promise<SpeechSynthesisResult> {
  let emittedOutput = false;
  const guardedRequest: AudioRuntimeSpeechSynthesisRequest = {
    ...request,
    onStreamEvent: async (event) => {
      if (event.type === "audio_delta" || event.type === "text_delta") {
        emittedOutput = true;
      }
      await request.onStreamEvent?.(event);
    },
  };
  try {
    return await runAudioRuntimeRequest(
      {
        apiKey: request.model.apiKey,
        signal: request.signal,
        proxy: request.proxy,
        retry: request.retry,
      },
      async (attempt) => {
        try {
          return await sendMimoSpeechSynthesisOnce(guardedRequest, attempt);
        } catch (error) {
          throwIfAudioRequestAborted(request.signal);
          if (
            emittedOutput &&
            !(error instanceof AudioRuntimeClientError &&
              (error.code === "aborted" || error.code === "output_write_failed"))
          ) {
            throw createAudioRuntimeError({
              code: "stream_parse_failed",
              message: "MiMo speech stream failed after output was emitted; the request will not be retried.",
              details: { attempt },
              cause: error,
            });
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (request.payload.stream) {
      await emitMimoSpeechStreamError(request, error);
    }
    throw error;
  }
}

async function sendMimoAudioTranscriptionOnce(
  request: AudioRuntimeTranscriptionRequest,
  attempt: number,
): Promise<AudioTranscriptionResult> {
  const endpoint = normalizeAudioEndpoint(request.model.baseUrl);
  if (!endpoint.chatCompletionsUrl) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "MiMo chat completions endpoint is not configured.",
      field: "baseUrl",
    });
  }
  validateMimoAsrPayload(request);

  const fileInfo = await resolveAudioInputFile({
    filePath: request.payload.filePath,
    mimeType: request.payload.mimeType,
    dialect: "mimo_chat_audio",
  });
  const dataUri = await readAudioFileAsDataUri(fileInfo);

  const response = await axios.post(
    endpoint.chatCompletionsUrl,
    {
      model: request.model.modelKey,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: dataUri,
              },
            },
          ],
        },
      ],
      asr_options: {
        language: request.payload.language ?? "auto",
      },
      ...(request.payload.stream ? { stream: true } : {}),
    },
    {
      headers: {
        "api-key": request.model.apiKey,
        "Content-Type": "application/json",
      },
      timeout: request.timeoutMs ?? 60_000,
      signal: request.signal,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      ...(request.payload.stream ? { responseType: "stream" as const } : {}),
      ...resolveAudioAxiosProxyConfig(request.proxy),
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw createAudioHttpErrorFromResponse({
      status: response.status,
      body: request.payload.stream
        ? await readStreamBodyAsText(response.data)
        : response.data,
      headers: response.headers,
      attempt,
      apiKey: request.model.apiKey,
    });
  }

  let text: string;
  let model: string | undefined;
  let rawJson: unknown = response.data;
  if (request.payload.stream) {
    const streamed = await parseMimoAsrStream(response.data, request, attempt);
    text = streamed.text;
    model = streamed.model;
    rawJson = streamed.rawJson;
  } else {
    const parsed = parseMimoChatCompletion(response.data, attempt);
    text = extractMimoMessageText(parsed.message);
    model = parsed.model;
  }
  if (!text.trim()) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "MiMo ASR response text is empty.",
      details: { attempt },
    });
  }

  const result: AudioTranscriptionResult = {
    text,
    responseFormat: request.payload.responseFormat,
    rawJson,
    ...(request.payload.responseFormat === "text" ? { rawText: text } : {}),
    model: model ?? request.model.modelKey,
    ...(request.payload.stream ? { streamMode: "incremental" as const } : {}),
  };
  const outputPath = await maybeWriteMimoTranscriptionOutput(request, result);
  return {
    ...result,
    ...(outputPath ? { outputPath } : {}),
  };
}

function validateMimoAsrPayload(
  request: AudioRuntimeTranscriptionRequest,
): void {
  if (request.model.modelKey !== "mimo-v2.5-asr") {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo ASR requires the mimo-v2.5-asr model.",
      field: "modelKey",
      details: { modelKey: request.model.modelKey },
    });
  }
  const language = request.payload.language ?? "auto";
  if (!MIMO_ASR_LANGUAGES.has(language)) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "MiMo ASR only supports auto, zh, or en language values.",
      field: "language",
      details: { language },
    });
  }
  if (
    request.payload.responseFormat !== "json" &&
    request.payload.responseFormat !== "text"
  ) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "MiMo ASR only supports json or text response output.",
      field: "responseFormat",
      details: { responseFormat: request.payload.responseFormat },
    });
  }
  if (request.payload.prompt?.trim()) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo ASR does not support OpenAI prompt parameters.",
      field: "prompt",
    });
  }
  if (request.payload.timestampGranularities?.length) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo ASR does not support timestamp granularities.",
      field: "timestampGranularities",
    });
  }
}

async function parseMimoAsrStream(
  stream: unknown,
  request: AudioRuntimeTranscriptionRequest,
  attempt: number,
): Promise<{
  text: string;
  model?: string;
  rawJson: Record<string, unknown>;
}> {
  let text = "";
  let model: string | undefined;
  let eventCount = 0;

  for await (const data of iterateSseDataValues(stream, request.signal)) {
    if (data === "[DONE]") break;
    const payload = parseMimoSseJson(data, attempt);
    const chunk = extractMimoStreamChunkPayload(payload);
    model = model ?? chunk.model;
    if (chunk.text) text += chunk.text;
    if (text.length > MIMO_MAX_TRANSCRIPT_CHARS) {
      throw createAudioRuntimeError({
        code: "invalid_response",
        message: "MiMo streaming transcription exceeded the safe text limit.",
        details: { attempt },
      });
    }
    eventCount += 1;
  }

  return {
    text,
    ...(model ? { model } : {}),
    rawJson: { stream: true, eventCount, text },
  };
}

async function maybeWriteMimoTranscriptionOutput(
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
    extension: request.payload.responseFormat === "json" ? "json" : "txt",
    now: request.now,
  });
  const written = await writeAudioOutputFile(
    outputPath,
    request.payload.responseFormat === "json"
      ? JSON.stringify(result.rawJson ?? { text: result.text }, null, 2)
      : result.text,
  );
  await discardAudioOutputIfAborted(written.outputPath, request.signal);
  return written.outputPath;
}

async function sendMimoSpeechSynthesisOnce(
  request: AudioRuntimeSpeechSynthesisRequest,
  attempt: number,
): Promise<SpeechSynthesisResult> {
  const endpoint = normalizeAudioEndpoint(request.model.baseUrl);
  if (!endpoint.chatCompletionsUrl) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "MiMo chat completions endpoint is not configured.",
      field: "baseUrl",
    });
  }
  await validateMimoSpeechPayload(request);

  if (request.payload.stream) {
    return sendMimoSpeechSynthesisStreamOnce(
      request,
      endpoint.chatCompletionsUrl,
      attempt,
    );
  }

  const startedAt = Date.now();
  const body = await buildMimoSpeechBody(request, { stream: false });
  const response = await axios.post(
    endpoint.chatCompletionsUrl,
    body,
    {
      headers: {
        "api-key": request.model.apiKey,
        "Content-Type": "application/json",
      },
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

  const parsed = parseMimoChatCompletion(response.data, attempt);
  const audioBase64 = extractMimoAudioData(parsed.message);
  if (!audioBase64) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "MiMo speech response does not contain audio data.",
      details: { attempt },
    });
  }

  const audioBytes = decodeStrictBase64(audioBase64, attempt, "MiMo speech audio");
  if (audioBytes.byteLength === 0) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "MiMo speech response audio is empty.",
      details: { attempt },
    });
  }
  if (detectAudioMimeTypeFromHeader(audioBytes.subarray(0, 16)) !== "audio/wav") {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "MiMo speech response is not a valid WAV artifact.",
      details: { attempt },
    });
  }

  const outputPath = await resolveAudioOutputPath({
    outputPathMode: request.payload.outputPathMode,
    outputDir: request.payload.outputDir,
    tempRoot: request.outputTempRoot,
    fileNameHint:
      request.payload.fileNameHint || createSpeechOutputFileNameHint(request.now),
    extension: "wav",
    now: request.now,
  });
  const written = await writeAudioOutputFile(outputPath, audioBytes);
  await discardAudioOutputIfAborted(written.outputPath, request.signal);

  return {
    outputPath: written.outputPath,
    sizeBytes: written.sizeBytes,
    responseFormat: "wav",
    mimeType: "audio/wav",
    model: parsed.model ?? request.model.modelKey,
    durationMs: Date.now() - startedAt,
  };
}

async function sendMimoSpeechSynthesisStreamOnce(
  request: AudioRuntimeSpeechSynthesisRequest,
  chatCompletionsUrl: string,
  attempt: number,
): Promise<SpeechSynthesisResult> {
  const startedAt = Date.now();
  const body = await buildMimoSpeechBody(request, { stream: true });
  const response = await axios.post(
    chatCompletionsUrl,
    body,
    {
      headers: {
        "api-key": request.model.apiKey,
        "Content-Type": "application/json",
      },
      timeout: request.timeoutMs ?? 60_000,
      signal: request.signal,
      validateStatus: () => true,
      responseType: "stream",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      ...resolveAudioAxiosProxyConfig(request.proxy),
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw createAudioHttpErrorFromResponse({
      status: response.status,
      body: await readStreamBodyAsText(response.data),
      headers: response.headers,
      attempt,
      apiKey: request.model.apiKey,
    });
  }

  await emitMimoSpeechStreamEvent(request, {
    type: "started",
    requestId: resolveSpeechStreamRequestId(request),
    sampleRate: MIMO_STREAM_SAMPLE_RATE,
    channels: MIMO_STREAM_CHANNELS,
  });

  const pcmChunks: Uint8Array[] = [];
  let bufferedPcmBytes = 0;
  let firstChunkAtMs: number | undefined;
  let finalAudioBase64: string | undefined;
  let model: string | undefined;
  let textDeltaCount = 0;

  for await (const data of iterateSseDataValues(response.data, request.signal)) {
    if (data === "[DONE]") break;

    const payload = parseMimoSseJson(data, attempt);
    const chunk = extractMimoStreamChunkPayload(payload);
    model = model ?? chunk.model;

    if (chunk.text) {
      textDeltaCount += 1;
      await emitMimoSpeechStreamEvent(request, {
        type: "text_delta",
        requestId: resolveSpeechStreamRequestId(request),
        text: chunk.text,
      });
    }

    if (chunk.audioBase64) {
      const pcmBytes = decodeMimoStreamPcmChunk(chunk.audioBase64, attempt);
      if (pcmBytes.byteLength > 0) {
        if (bufferedPcmBytes + pcmBytes.byteLength > MIMO_MAX_STREAM_AUDIO_BYTES) {
          throw createAudioRuntimeError({
            code: "stream_parse_failed",
            message: "MiMo streaming speech exceeded the safe audio limit.",
            details: { attempt, maxBytes: MIMO_MAX_STREAM_AUDIO_BYTES },
          });
        }
        bufferedPcmBytes += pcmBytes.byteLength;
        firstChunkAtMs = firstChunkAtMs ?? Date.now();
        pcmChunks.push(pcmBytes);
        await emitMimoSpeechStreamEvent(request, {
          type: "audio_delta",
          requestId: resolveSpeechStreamRequestId(request),
          pcmBytes,
        });
      }
    }

    if (chunk.finalAudioBase64) {
      finalAudioBase64 = chunk.finalAudioBase64;
    }
  }

  const streamMode = pcmChunks.length > 0 ? "incremental" : "final_only";
  if (pcmChunks.length === 0 && finalAudioBase64) {
    const finalPcmBytes = decodeMimoStreamPcmChunk(finalAudioBase64, attempt);
    if (finalPcmBytes.byteLength > 0) {
      if (finalPcmBytes.byteLength > MIMO_MAX_STREAM_AUDIO_BYTES) {
        throw createAudioRuntimeError({
          code: "stream_parse_failed",
          message: "MiMo final speech audio exceeded the safe audio limit.",
          details: { attempt, maxBytes: MIMO_MAX_STREAM_AUDIO_BYTES },
        });
      }
      bufferedPcmBytes = finalPcmBytes.byteLength;
      firstChunkAtMs = firstChunkAtMs ?? Date.now();
      pcmChunks.push(finalPcmBytes);
      await emitMimoSpeechStreamEvent(request, {
        type: "audio_delta",
        requestId: resolveSpeechStreamRequestId(request),
        pcmBytes: finalPcmBytes,
      });
    }
  }

  if (pcmChunks.length === 0) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "MiMo streaming speech response audio is empty.",
      details: { attempt, textDeltaCount },
    });
  }

  const totalPcmBytes = pcmChunks.reduce(
    (sum, chunk) => sum + chunk.byteLength,
    0,
  );
  const streamStats = createAudioStreamStats({
    startedAtMs: startedAt,
    firstChunkAtMs,
    chunkCount: pcmChunks.length,
    totalBytes: totalPcmBytes,
    sampleRate: MIMO_STREAM_SAMPLE_RATE,
    channels: MIMO_STREAM_CHANNELS,
    streamMode,
  });
  const outputPath = await resolveAudioOutputPath({
    outputPathMode: request.payload.outputPathMode,
    outputDir: request.payload.outputDir,
    tempRoot: request.outputTempRoot,
    fileNameHint:
      request.payload.fileNameHint || createSpeechOutputFileNameHint(request.now),
    extension: "wav",
    now: request.now,
  });
  const written = await writePcm16WavFile(outputPath, pcmChunks, {
    sampleRate: MIMO_STREAM_SAMPLE_RATE,
    channels: MIMO_STREAM_CHANNELS,
  });
  await discardAudioOutputIfAborted(written.outputPath, request.signal);

  const result: SpeechSynthesisResult = {
    outputPath: written.outputPath,
    sizeBytes: written.sizeBytes,
    responseFormat: "wav",
    mimeType: "audio/wav",
    model: model ?? request.model.modelKey,
    durationMs: Date.now() - startedAt,
    streamStats: { ...streamStats, streamEncoding: "pcm16" },
  };

  await emitMimoSpeechStreamEvent(request, {
    type: "metadata",
    requestId: resolveSpeechStreamRequestId(request),
    stats: streamStats,
  });
  await emitMimoSpeechStreamEvent(request, {
    type: "completed",
    requestId: resolveSpeechStreamRequestId(request),
    result,
  });

  return result;
}

async function validateMimoSpeechPayload(
  request: AudioRuntimeSpeechSynthesisRequest,
): Promise<void> {
  const options = getMimoSpeechOptions(request);
  const expectedModel = MIMO_TTS_MODEL_BY_MODE[options.mode];
  if (request.model.modelKey !== expectedModel) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo TTS mode does not match the selected model.",
      field: "mimoOptions.mode",
      details: { mode: options.mode, model: request.model.modelKey },
    });
  }
  if (request.payload.stream && request.payload.responseFormat !== "pcm16") {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "MiMo streaming speech synthesis requires pcm16 output.",
      field: "responseFormat",
      details: { responseFormat: request.payload.responseFormat },
    });
  }
  if (!request.payload.stream && request.payload.responseFormat !== "wav") {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "MiMo non-streaming speech synthesis only supports wav output.",
      field: "responseFormat",
      details: { responseFormat: request.payload.responseFormat },
    });
  }
  if (request.payload.speed !== undefined) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "MiMo speech synthesis does not support OpenAI speed.",
      field: "speed",
    });
  }
  if (
    !request.payload.input.trim() &&
    !options.optimizeTextPreview
  ) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message:
        "MiMo speech synthesis input is required unless optimizeTextPreview is enabled.",
      field: "input",
    });
  }
  if (options.mode === "voice_design" && !options.voiceDesignPrompt?.trim()) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "MiMo voice design requires a voice design prompt.",
      field: "mimoOptions.voiceDesignPrompt",
    });
  }
  if (options.mode === "voice_clone") {
    if (!options.voiceSamplePath?.trim()) {
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "MiMo voice clone requires a reference audio file.",
        field: "mimoOptions.voiceSamplePath",
      });
    }
    await resolveAudioInputFile({
      filePath: options.voiceSamplePath,
      mimeType: options.voiceSampleMime,
      dialect: "mimo_chat_audio",
    });
  }
}

async function buildMimoSpeechBody(
  request: AudioRuntimeSpeechSynthesisRequest,
  buildOptions: BuildMimoSpeechBodyOptions,
): Promise<Record<string, unknown>> {
  const options = getMimoSpeechOptions(request);
  const messages = buildMimoSpeechMessages(request, options);
  const voice = await resolveMimoSpeechVoice(request, options);
  const audio: Record<string, unknown> = {
    format: buildOptions.stream ? "pcm16" : "wav",
  };
  if (voice) {
    audio.voice = voice;
  }
  if (options.optimizeTextPreview !== undefined) {
    audio.optimize_text_preview = options.optimizeTextPreview;
  }
  if (options.audioTagsEnabled !== undefined) {
    audio.audio_tags_enabled = options.audioTagsEnabled;
  }

  return {
    model: request.model.modelKey,
    messages,
    audio,
    ...(buildOptions.stream ? { stream: true } : {}),
  };
}

function buildMimoSpeechMessages(
  request: AudioRuntimeSpeechSynthesisRequest,
  options: MimoSpeechOptions,
): Array<Record<string, string>> {
  const userContent =
    options.mode === "voice_design"
      ? options.voiceDesignPrompt?.trim()
      : options.styleInstruction?.trim() || request.payload.instructions?.trim();

  return [
    ...(userContent ? [{ role: "user", content: userContent }] : []),
    { role: "assistant", content: request.payload.input },
  ];
}

async function resolveMimoSpeechVoice(
  request: AudioRuntimeSpeechSynthesisRequest,
  options: MimoSpeechOptions,
): Promise<string | undefined> {
  if (options.mode === "voice_design") {
    return undefined;
  }
  if (options.mode === "voice_clone") {
    if (!options.voiceSamplePath) {
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "MiMo voice clone requires a reference audio file.",
        field: "mimoOptions.voiceSamplePath",
      });
    }
    const fileInfo = await resolveAudioInputFile({
      filePath: options.voiceSamplePath,
      mimeType: options.voiceSampleMime,
      dialect: "mimo_chat_audio",
    });
    return readAudioFileAsDataUri(fileInfo);
  }
  return request.payload.voice?.trim() || "mimo_default";
}

async function emitMimoSpeechStreamEvent(
  request: AudioRuntimeSpeechSynthesisRequest,
  event: SpeechSynthesisStreamEvent,
): Promise<void> {
  await request.onStreamEvent?.(event);
}

async function emitMimoSpeechStreamError(
  request: AudioRuntimeSpeechSynthesisRequest,
  error: unknown,
): Promise<void> {
  try {
    await emitMimoSpeechStreamEvent(request, {
      type: "error",
      requestId: resolveSpeechStreamRequestId(request),
      error: toAudioIpcError(error),
    });
  } catch {
    // Stream error notification should not hide the original runtime error.
  }
}

function resolveSpeechStreamRequestId(
  request: AudioRuntimeSpeechSynthesisRequest,
): string {
  return request.requestId ?? `${request.model.audioProfileId}:speechSynthesis`;
}

function toAudioIpcError(error: unknown): AudioIpcError {
  if (error instanceof AudioRuntimeClientError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  return {
    code: "network_error",
    message: error instanceof Error
      ? error.message
      : "Unknown MiMo streaming speech error.",
  };
}

async function readStreamBodyAsText(stream: unknown): Promise<string | undefined> {
  if (typeof stream === "string") return stream;
  if (Buffer.isBuffer(stream)) return stream.toString("utf8");
  if (stream instanceof Uint8Array) return Buffer.from(stream).toString("utf8");
  if (!isAsyncIterable(stream)) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(toBuffer(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* iterateSseDataValues(
  stream: unknown,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!isAsyncIterable(stream)) {
    throw createAudioRuntimeError({
      code: "stream_parse_failed",
      message: "MiMo streaming speech response is not readable.",
    });
  }

  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of stream) {
    throwIfAudioRequestAborted(signal);
    try {
      buffer += decoder.decode(toBuffer(chunk), { stream: true });
    } catch (error) {
      throw createAudioRuntimeError({
        code: "stream_parse_failed",
        message: "MiMo SSE response contained invalid UTF-8.",
        cause: error,
      });
    }
    if (buffer.length > MIMO_MAX_SSE_BUFFER_CHARS) {
      throw createAudioRuntimeError({
        code: "stream_parse_failed",
        message: "MiMo SSE event exceeded the safe buffer limit.",
      });
    }

    while (true) {
      const separator = findSseEventSeparator(buffer);
      if (!separator) break;

      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const data = extractSseDataValue(rawEvent);
      if (data !== undefined) {
        throwIfAudioRequestAborted(signal);
        yield data;
      }
    }
  }

  buffer += decoder.decode();

  const remainingData = extractSseDataValue(buffer);
  if (remainingData !== undefined) {
    throwIfAudioRequestAborted(signal);
    yield remainingData;
  }
}

function findSseEventSeparator(
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

function extractSseDataValue(rawEvent: string): string | undefined {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n").trimEnd();
  return data.length > 0 ? data : undefined;
}

function parseMimoSseJson(data: string, attempt: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data);
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    throw createAudioRuntimeError({
      code: "stream_parse_failed",
      message: "MiMo streaming speech response contained invalid SSE JSON.",
      details: { attempt },
      cause: error,
    });
  }

  throw createAudioRuntimeError({
    code: "stream_parse_failed",
    message: "MiMo streaming speech SSE event is not an object.",
    details: { attempt },
  });
}

function extractMimoStreamChunkPayload(
  data: Record<string, unknown>,
): MimoStreamChunkPayload {
  const choice = Array.isArray(data.choices) && isRecord(data.choices[0])
    ? data.choices[0]
    : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const deltaAudio = isRecord(delta?.audio) ? delta.audio : undefined;
  const messageAudio = isRecord(message?.audio) ? message.audio : undefined;
  const deltaText = typeof delta?.content === "string"
    ? delta.content
    : undefined;
  const messageText = !deltaText && message
    ? extractMimoMessageText(message)
    : undefined;

  return {
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(typeof deltaAudio?.data === "string"
      ? { audioBase64: deltaAudio.data }
      : {}),
    ...(typeof messageAudio?.data === "string"
      ? { finalAudioBase64: messageAudio.data }
      : {}),
    ...(deltaText || messageText ? { text: deltaText ?? messageText } : {}),
  };
}

function decodeMimoStreamPcmChunk(
  audioBase64: string,
  attempt: number,
): Uint8Array {
  return decodeStrictBase64(audioBase64, attempt, "MiMo streaming speech chunk");
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), "utf8");
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function getMimoSpeechOptions(
  request: AudioRuntimeSpeechSynthesisRequest,
): MimoSpeechOptions {
  if (!request.payload.mimoOptions) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "MiMo speech synthesis options are required.",
      field: "mimoOptions",
    });
  }
  return request.payload.mimoOptions;
}

function parseMimoChatCompletion(
  data: unknown,
  attempt: number,
): {
  message: Record<string, unknown>;
  model?: string;
} {
  if (!isRecord(data)) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "MiMo response is not an object.",
      details: { attempt },
    });
  }

  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!isRecord(choice)) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "MiMo response does not contain a choice.",
      details: { attempt },
    });
  }

  const message = isRecord(choice.message) ? choice.message : undefined;
  if (!message) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "MiMo response choice does not contain a message.",
      details: { attempt },
    });
  }

  return {
    message,
    ...(typeof data.model === "string" ? { model: data.model } : {}),
  };
}

function extractMimoMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function extractMimoAudioData(message: Record<string, unknown>): string | undefined {
  const audio = isRecord(message.audio) ? message.audio : undefined;
  return typeof audio?.data === "string" ? audio.data : undefined;
}

function stripDataUriPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  if (/^data:audio\//i.test(value) && commaIndex >= 0) {
    return value.slice(commaIndex + 1);
  }
  return value;
}

function decodeStrictBase64(
  value: string,
  attempt: number,
  label: string,
): Buffer {
  const normalized = stripDataUriPrefix(value).replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw createAudioRuntimeError({
      code: "stream_parse_failed",
      message: `${label} is not valid Base64.`,
      details: { attempt },
    });
  }
  const bytes = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalOutput = bytes.toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalOutput) {
    throw createAudioRuntimeError({
      code: "stream_parse_failed",
      message: `${label} failed Base64 integrity validation.`,
      details: { attempt },
    });
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
