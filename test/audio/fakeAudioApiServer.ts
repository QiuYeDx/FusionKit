import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type FakeAudioApiRoute =
  | "openai_transcriptions"
  | "openai_speech"
  | "openai_realtime_client_secrets"
  | "mimo_chat_completions"
  | "models"
  | "unknown";

export interface CapturedAudioApiRequest {
  method: string;
  url: string;
  route: FakeAudioApiRoute;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  body: Record<string, unknown> | null;
}

export interface FakeAudioApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer | string;
  sseEvents?: Array<Record<string, unknown> | string>;
  sseEventDelayMs?: number;
}

export type FakeAudioApiResponder = (
  request: CapturedAudioApiRequest,
) => FakeAudioApiResponse | Promise<FakeAudioApiResponse>;

export interface FakeAudioApiServer {
  baseUrl: string;
  audioTranscriptionsUrl: string;
  audioSpeechUrl: string;
  chatCompletionsUrl: string;
  realtimeClientSecretsUrl: string;
  modelsUrl: string;
  requests: CapturedAudioApiRequest[];
  enqueue(response: FakeAudioApiResponse | FakeAudioApiResponder): void;
  enqueueRoute(
    route: Exclude<FakeAudioApiRoute, "unknown">,
    response: FakeAudioApiResponse | FakeAudioApiResponder,
  ): void;
  close(): Promise<void>;
}

interface QueuedFakeAudioResponse {
  route?: Exclude<FakeAudioApiRoute, "unknown">;
  response: FakeAudioApiResponse | FakeAudioApiResponder;
}

export interface OpenAITranscriptionBodyOptions {
  text: string;
  model?: string;
  segments?: Array<Record<string, unknown>>;
  words?: Array<Record<string, unknown>>;
}

export interface OpenAIRealtimeClientSecretOptions {
  clientSecret?: string;
  sessionId?: string;
  expiresAt?: number;
  model?: string;
}

export type MimoAsrFinishReason = "stop" | "length" | "content_filter" | null;

export interface MimoAsrUsageOptions {
  seconds: number;
}

export interface MimoAsrBodyOptions {
  text?: string;
  model?: string;
  finishReason?: MimoAsrFinishReason;
  usage?: MimoAsrUsageOptions;
  omitChoices?: boolean;
}

export interface MimoStreamingAsrOptions {
  textChunks: readonly string[];
  model?: string;
  finishReason?: Exclude<MimoAsrFinishReason, null>;
  usage?: MimoAsrUsageOptions;
  includeTerminalChunk?: boolean;
  includeDone?: boolean;
}

export interface MimoSpeechBodyOptions {
  audioBase64: string;
  model?: string;
  content?: string;
  finishReason?: string | null;
}

export interface MimoStreamingSpeechOptions {
  audioBase64Chunks: string[];
  model?: string;
  textChunks?: string[];
  includeDone?: boolean;
}

export function createOpenAITranscriptionBody(
  options: OpenAITranscriptionBodyOptions,
): Record<string, unknown> {
  return {
    text: options.text,
    ...(options.model ? { model: options.model } : {}),
    ...(options.segments ? { segments: options.segments } : {}),
    ...(options.words ? { words: options.words } : {}),
  };
}

export function createOpenAISpeechBuffer(
  text = "fusionkit-fake-audio",
): Buffer {
  const payload = Buffer.from(text, "utf8");
  const wav = Buffer.alloc(44 + payload.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + payload.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(payload.length, 40);
  payload.copy(wav, 44);
  return wav;
}

export function createOpenAIRealtimeClientSecretBody(
  options: OpenAIRealtimeClientSecretOptions = {},
): Record<string, unknown> {
  return {
    id: options.sessionId ?? "sess_fusionkit_fake",
    object: "realtime.session",
    model: options.model ?? "gpt-realtime-fake",
    client_secret: {
      value: options.clientSecret ?? "ek_fusionkit_fake_client_secret",
      expires_at: options.expiresAt ?? 1_750_000_000,
    },
  };
}

export function createMimoAsrBody(
  options: MimoAsrBodyOptions,
): Record<string, unknown> {
  const choices = options.omitChoices
    ? []
    : [
        {
          index: 0,
          message: {
            role: "assistant",
            content: options.text ?? "",
          },
          finish_reason: options.finishReason === undefined
            ? "stop"
            : options.finishReason,
        },
      ];

  return {
    id: "chatcmpl-fusionkit-fake-asr",
    object: "chat.completion",
    created: 1_750_000_000,
    model: options.model ?? "mimo-v2.5-asr",
    choices,
    ...(options.usage ? { usage: { seconds: options.usage.seconds } } : {}),
  };
}

export function createMimoStreamingAsrEvents(
  options: MimoStreamingAsrOptions,
): Array<Record<string, unknown> | string> {
  const model = options.model ?? "mimo-v2.5-asr";
  const events: Array<Record<string, unknown> | string> = options.textChunks.map(
    (content, index) => ({
      id: "chatcmpl-fusionkit-fake-asr-stream",
      object: "chat.completion.chunk",
      created: 1_750_000_000 + index,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }),
  );

  if (options.includeTerminalChunk ?? true) {
    events.push({
      id: "chatcmpl-fusionkit-fake-asr-stream",
      object: "chat.completion.chunk",
      created: 1_750_000_000 + options.textChunks.length,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: options.finishReason ?? "stop",
        },
      ],
      ...(options.usage ? { usage: { seconds: options.usage.seconds } } : {}),
    });
  }

  if (options.includeDone ?? true) {
    events.push("[DONE]");
  }

  return events;
}

export function createMimoSpeechBody(
  options: MimoSpeechBodyOptions,
): Record<string, unknown> {
  return {
    id: "chatcmpl-fusionkit-fake-tts",
    object: "chat.completion",
    created: 1_750_000_000,
    model: options.model ?? "mimo-v2.5-tts",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.content ?? "",
          audio: {
            data: options.audioBase64,
          },
        },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
  };
}

export function createMimoStreamingSpeechEvents(
  options: MimoStreamingSpeechOptions,
): Array<Record<string, unknown> | string> {
  const events: Array<Record<string, unknown> | string> = [];
  const maxLength = Math.max(
    options.audioBase64Chunks.length,
    options.textChunks?.length ?? 0,
  );

  for (let index = 0; index < maxLength; index += 1) {
    const delta: Record<string, unknown> = {};
    const audio = options.audioBase64Chunks[index];
    if (audio !== undefined) {
      delta.audio = { data: audio };
    }
    const text = options.textChunks?.[index];
    if (text !== undefined) {
      delta.content = text;
    }
    events.push({
      id: "chatcmpl-fusionkit-fake-tts-stream",
      object: "chat.completion.chunk",
      created: 1_750_000_000 + index,
      model: options.model ?? "mimo-v2.5-tts",
      choices: [
        {
          index: 0,
          delta,
          finish_reason: index === maxLength - 1 ? "stop" : null,
        },
      ],
    });
  }

  if (options.includeDone ?? true) {
    events.push("[DONE]");
  }

  return events;
}

export function createAudioModelsBody(ids: string[]): Record<string, unknown> {
  return {
    object: "list",
    data: ids.map((id, index) => ({
      id,
      object: "model",
      created: 1_750_000_000 + index,
      owned_by: "fusionkit-fake-provider",
    })),
  };
}

export function createAudioErrorBody(
  message: string,
  code: string,
  type = "invalid_request_error",
): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      code,
    },
  };
}

export async function startFakeAudioApiServer(): Promise<FakeAudioApiServer> {
  const requests: CapturedAudioApiRequest[] = [];
  const queuedResponses: QueuedFakeAudioResponse[] = [];

  const server = createServer(async (request, response) => {
    try {
      const captured = await captureRequest(request);
      requests.push(captured);

      if (captured.route === "unknown") {
        await writeResponse(response, {
          status: 404,
          body: createAudioErrorBody(
            `Unexpected fake-server route: ${captured.method} ${captured.url}`,
            "route_not_found",
          ),
        });
        return;
      }

      const queuedIndex = queuedResponses.findIndex(
        (queued) => !queued.route || queued.route === captured.route,
      );
      if (queuedIndex < 0) {
        await writeResponse(response, {
          status: 500,
          body: createAudioErrorBody(
            `No fake response queued for route: ${captured.route}`,
            "fake_response_missing",
            "server_error",
          ),
        });
        return;
      }

      const [queued] = queuedResponses.splice(queuedIndex, 1);
      const resolved =
        typeof queued.response === "function"
          ? await queued.response(captured)
          : queued.response;
      await writeResponse(response, resolved);
    } catch (error) {
      await writeResponse(response, {
        status: 500,
        body: createAudioErrorBody(
          error instanceof Error ? error.message : String(error),
          "fake_server_failure",
          "server_error",
        ),
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fake audio API server did not expose a TCP port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseUrl,
    audioTranscriptionsUrl: `${baseUrl}/audio/transcriptions`,
    audioSpeechUrl: `${baseUrl}/audio/speech`,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    realtimeClientSecretsUrl: `${baseUrl}/realtime/client_secrets`,
    modelsUrl: `${baseUrl}/models`,
    requests,
    enqueue(response) {
      queuedResponses.push({ response });
    },
    enqueueRoute(route, response) {
      queuedResponses.push({ route, response });
    },
    close: () => closeServer(server),
  };
}

async function captureRequest(
  request: IncomingMessage,
): Promise<CapturedAudioApiRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks);
  const body = parseJsonBody(request.headers, rawBody);
  const method = request.method ?? "";
  const url = request.url ?? "";

  return {
    method,
    url,
    route: detectRoute(method, url),
    headers: request.headers,
    rawBody,
    body,
  };
}

function detectRoute(method: string, url: string): FakeAudioApiRoute {
  const path = url.split("?")[0];
  if (method === "POST" && path === "/v1/audio/transcriptions") {
    return "openai_transcriptions";
  }
  if (method === "POST" && path === "/v1/audio/speech") {
    return "openai_speech";
  }
  if (method === "POST" && path === "/v1/realtime/client_secrets") {
    return "openai_realtime_client_secrets";
  }
  if (method === "POST" && path === "/v1/chat/completions") {
    return "mimo_chat_completions";
  }
  if (method === "GET" && path === "/v1/models") {
    return "models";
  }
  return "unknown";
}

function parseJsonBody(
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
): Record<string, unknown> | null {
  const contentType = String(headers["content-type"] ?? "");
  if (!rawBody.length || !contentType.includes("application/json")) {
    return null;
  }

  const parsed = JSON.parse(rawBody.toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Expected an object JSON request body");
  }
  return parsed as Record<string, unknown>;
}

async function writeResponse(
  response: ServerResponse,
  fakeResponse: FakeAudioApiResponse,
): Promise<void> {
  if (fakeResponse.sseEvents) {
    response.writeHead(fakeResponse.status ?? 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...fakeResponse.headers,
    });
    const delayMs = fakeResponse.sseEventDelayMs ?? 0;
    for (const event of fakeResponse.sseEvents) {
      if (response.destroyed) return;
      const data = typeof event === "string" ? event : JSON.stringify(event);
      response.write(`data: ${data}\n\n`);
      if (delayMs > 0) {
        await delay(delayMs);
      }
    }
    if (!response.destroyed) {
      response.end();
    }
    return;
  }

  if (fakeResponse.rawBody !== undefined) {
    response.writeHead(fakeResponse.status ?? 200, {
      "Content-Type": "application/octet-stream",
      ...fakeResponse.headers,
    });
    response.end(fakeResponse.rawBody);
    return;
  }

  response.writeHead(fakeResponse.status ?? 200, {
    "Content-Type": "application/json; charset=utf-8",
    ...fakeResponse.headers,
  });
  response.end(JSON.stringify(fakeResponse.body ?? {}));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}
