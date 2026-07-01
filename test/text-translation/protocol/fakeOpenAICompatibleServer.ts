import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface CapturedChatCompletionRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeOpenAIResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type FakeOpenAIResponder = (
  request: CapturedChatCompletionRequest,
) => FakeOpenAIResponse | Promise<FakeOpenAIResponse>;

export interface FakeOpenAICompatibleServer {
  baseUrl: string;
  requests: CapturedChatCompletionRequest[];
  enqueue(response: FakeOpenAIResponse | FakeOpenAIResponder): void;
  close(): Promise<void>;
}

export interface ChatCompletionBodyOptions {
  content: string;
  finishReason?: string | null;
  reasoningContent?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  model?: string;
}

export function createChatCompletionBody(
  options: ChatCompletionBodyOptions,
): Record<string, unknown> {
  return {
    id: "chatcmpl-fusionkit-fake",
    object: "chat.completion",
    created: 1_750_000_000,
    model: options.model ?? "fusionkit-fake-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.content,
          ...(options.reasoningContent
            ? { reasoning_content: options.reasoningContent }
            : {}),
        },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

export async function startFakeOpenAICompatibleServer(): Promise<FakeOpenAICompatibleServer> {
  const requests: CapturedChatCompletionRequest[] = [];
  const queuedResponses: Array<FakeOpenAIResponse | FakeOpenAIResponder> = [];

  const server = createServer(async (request, response) => {
    try {
      const captured = await captureRequest(request);
      requests.push(captured);

      if (captured.method !== "POST" || captured.url !== "/v1/chat/completions") {
        writeJson(response, {
          status: 404,
          body: {
            error: {
              message: `Unexpected fake-server route: ${captured.method} ${captured.url}`,
              type: "invalid_request_error",
              code: "route_not_found",
            },
          },
        });
        return;
      }

      const queued = queuedResponses.shift();
      if (!queued) {
        writeJson(response, {
          status: 500,
          body: {
            error: {
              message: "No fake response queued",
              type: "server_error",
              code: "fake_response_missing",
            },
          },
        });
        return;
      }

      const resolved =
        typeof queued === "function" ? await queued(captured) : queued;
      writeJson(response, resolved);
    } catch (error) {
      writeJson(response, {
        status: 500,
        body: {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "server_error",
            code: "fake_server_failure",
          },
        },
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fake OpenAI server did not expose a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    enqueue(response) {
      queuedResponses.push(response);
    },
    close: () => closeServer(server),
  };
}

async function captureRequest(
  request: IncomingMessage,
): Promise<CapturedChatCompletionRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  const parsedBody = rawBody ? JSON.parse(rawBody) : {};
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    Array.isArray(parsedBody)
  ) {
    throw new Error("Expected an object request body");
  }

  return {
    method: request.method ?? "",
    url: request.url ?? "",
    headers: request.headers,
    body: parsedBody as Record<string, unknown>,
  };
}

function writeJson(
  response: ServerResponse,
  fakeResponse: FakeOpenAIResponse,
): void {
  response.writeHead(fakeResponse.status ?? 200, {
    "Content-Type": "application/json; charset=utf-8",
    ...fakeResponse.headers,
  });
  response.end(JSON.stringify(fakeResponse.body));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}
