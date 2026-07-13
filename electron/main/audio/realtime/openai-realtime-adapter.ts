import axios from "axios";
import type { AxiosProxyConfig } from "axios";
import { normalizeAudioEndpoint } from "@/lib/audio-endpoint";
import type {
  AudioRealtimeSessionConfig,
  AudioRuntimeAdapterModelConfig,
} from "@/type/audio";
import type { RealtimeEphemeralSessionResult } from "@/type/audioIpc";
import { createAudioRuntimeError } from "../audio-errors";
import type { AudioRuntimeRetryOptions } from "../audio-http";
import {
  createAudioHttpErrorFromResponse,
  resolveAudioAxiosProxyConfig,
  runAudioRuntimeRequest,
} from "../audio-http";

export interface OpenAIRealtimeEphemeralSessionRequest {
  model: AudioRuntimeAdapterModelConfig;
  payload: AudioRealtimeSessionConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  proxy?: AxiosProxyConfig | false;
  retry?: Partial<AudioRuntimeRetryOptions>;
}

export async function createOpenAIRealtimeEphemeralSession(
  request: OpenAIRealtimeEphemeralSessionRequest,
): Promise<RealtimeEphemeralSessionResult> {
  return runAudioRuntimeRequest(
    {
      apiKey: request.model.apiKey,
      signal: request.signal,
      proxy: request.proxy,
      retry: request.retry,
    },
    async (attempt) => createOpenAIRealtimeEphemeralSessionOnce(request, attempt),
  );
}

async function createOpenAIRealtimeEphemeralSessionOnce(
  request: OpenAIRealtimeEphemeralSessionRequest,
  attempt: number,
): Promise<RealtimeEphemeralSessionResult> {
  if (request.model.audioDialect !== "openai_realtime") {
    throw createAudioRuntimeError({
      code: "unsupported_audio_capability",
      message: "The selected audio profile does not support native OpenAI Realtime sessions.",
      field: "audioDialect",
      details: { audioDialect: request.model.audioDialect },
    });
  }

  const endpoint = normalizeAudioEndpoint(request.model.baseUrl);
  if (!endpoint.realtimeClientSecretsUrl) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "OpenAI Realtime client secret endpoint is not configured.",
      field: "baseUrl",
    });
  }

  const response = await axios.post(
    endpoint.realtimeClientSecretsUrl,
    createRealtimeClientSecretRequestBody(request),
    {
      headers: {
        Authorization: `Bearer ${request.model.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: request.timeoutMs ?? 30_000,
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

  return {
    ...parseRealtimeClientSecretResponse(response.data, attempt),
    realtimeCallsUrl: endpoint.realtimeCallsUrl,
  };
}

export function createRealtimeClientSecretRequestBody(
  request: OpenAIRealtimeEphemeralSessionRequest,
): Record<string, unknown> {
  return {
    session: request.payload.mode === "caption"
      ? createRealtimeTranscriptionSession(request)
      : createRealtimeDuplexVoiceSession(request),
  };
}

function createRealtimeDuplexVoiceSession(
  request: OpenAIRealtimeEphemeralSessionRequest,
): Record<string, unknown> {
  const outputAudio: Record<string, unknown> = {};
  const voice = request.payload.voice?.trim();
  if (voice) {
    outputAudio.voice = voice;
  }
  const outputFormat = createRealtimeAudioFormat(request.payload.outputAudioFormat);
  if (outputFormat) {
    outputAudio.format = outputFormat;
  }

  return removeEmptyObjects({
    type: "realtime",
    model: request.model.modelKey,
    ...(request.payload.instructions
      ? { instructions: request.payload.instructions }
      : {}),
    audio: {
      input: {
        ...createRealtimeTurnDetection(request.payload.turnDetection),
        ...createInputAudioFormat(request.payload.inputAudioFormat),
      },
      ...(Object.keys(outputAudio).length ? { output: outputAudio } : {}),
    },
  });
}

function createRealtimeTranscriptionSession(
  request: OpenAIRealtimeEphemeralSessionRequest,
): Record<string, unknown> {
  return removeEmptyObjects({
    type: "transcription",
    audio: {
      input: {
        transcription: {
          model: request.model.modelKey,
          ...(request.payload.language
            ? { language: request.payload.language }
            : {}),
        },
        ...createRealtimeTurnDetection(request.payload.turnDetection),
        ...createInputAudioFormat(request.payload.inputAudioFormat),
      },
    },
  });
}

function createRealtimeTurnDetection(
  turnDetection: AudioRealtimeSessionConfig["turnDetection"],
): Record<string, unknown> {
  if (turnDetection === "server_vad") {
    return { turn_detection: { type: "server_vad" } };
  }
  if (turnDetection === "manual") {
    return { turn_detection: null };
  }
  return {};
}

function createInputAudioFormat(
  inputAudioFormat: AudioRealtimeSessionConfig["inputAudioFormat"],
): Record<string, unknown> {
  const format = createRealtimeAudioFormat(inputAudioFormat);
  return format ? { format } : {};
}

function createRealtimeAudioFormat(
  format: AudioRealtimeSessionConfig["inputAudioFormat"],
): Record<string, unknown> | undefined {
  if (format === "pcm16") {
    return { type: "audio/pcm", rate: 24000 };
  }
  if (format === "pcmu") {
    return { type: "audio/pcmu" };
  }
  if (format === "pcma") {
    return { type: "audio/pcma" };
  }
  return undefined;
}

function parseRealtimeClientSecretResponse(
  data: unknown,
  attempt: number,
): RealtimeEphemeralSessionResult {
  if (!isRecord(data)) {
    throw createAudioRuntimeError({
      code: "invalid_response",
      message: "OpenAI Realtime client secret response is not an object.",
      details: { attempt },
    });
  }

  const nestedSecret = isRecord(data.client_secret)
    ? data.client_secret
    : undefined;
  const clientSecret = firstString(
    data.value,
    nestedSecret?.value,
    data.clientSecret,
  );
  if (!clientSecret) {
    throw createAudioRuntimeError({
      code: "empty_response",
      message: "OpenAI Realtime client secret response did not include a client secret.",
      details: { attempt },
    });
  }

  const expiresAt = normalizeExpiresAt(
    data.expires_at ?? nestedSecret?.expires_at ?? data.expiresAt,
  );
  const sessionId = firstString(data.id, data.session_id);
  const model = firstString(data.model);

  return {
    clientSecret,
    ...(expiresAt ? { expiresAt } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
  };
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric * 1000).toISOString();
    }
    return value.trim() || undefined;
  }
  return undefined;
}

function removeEmptyObjects(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) {
      const nested = removeEmptyObjects(item);
      if (Object.keys(nested).length > 0) {
        output[key] = nested;
      }
      continue;
    }
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
