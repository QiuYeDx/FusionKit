import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type FakeModelApiRoute =
  | "chat_completions"
  | "responses"
  | "models"
  | "unknown";

export interface CapturedModelApiRequest {
  method: string;
  url: string;
  route: FakeModelApiRoute;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeModelApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type FakeModelApiResponder = (
  request: CapturedModelApiRequest,
) => FakeModelApiResponse | Promise<FakeModelApiResponse>;

export interface FakeModelApiServer {
  baseUrl: string;
  chatCompletionsUrl: string;
  responsesUrl: string;
  modelsUrl: string;
  requests: CapturedModelApiRequest[];
  enqueue(response: FakeModelApiResponse | FakeModelApiResponder): void;
  enqueueRoute(
    route: Exclude<FakeModelApiRoute, "unknown">,
    response: FakeModelApiResponse | FakeModelApiResponder,
  ): void;
  close(): Promise<void>;
}

interface QueuedFakeResponse {
  route?: Exclude<FakeModelApiRoute, "unknown">;
  response: FakeModelApiResponse | FakeModelApiResponder;
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

export interface ResponsesBodyOptions {
  outputText?: string;
  output?: unknown[];
  includeOutputText?: boolean;
  status?: "completed" | "incomplete" | "failed";
  incompleteReason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  model?: string;
}

export interface ModelsBodyOptions {
  ids: string[];
}

export function createChatCompletionBody(
  options: ChatCompletionBodyOptions,
): Record<string, unknown> {
  return {
    id: "chatcmpl-fusionkit-fake",
    object: "chat.completion",
    created: 1_750_000_000,
    model: options.model ?? "fusionkit-fake-chat-model",
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

export function createResponsesBody(
  options: ResponsesBodyOptions,
): Record<string, unknown> {
  const outputText = options.outputText ?? "";
  const includeOutputText = options.includeOutputText ?? true;
  const output =
    options.output ??
    (outputText
      ? [
          {
            id: "msg_fusionkit_fake",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: outputText,
                annotations: [],
              },
            ],
          },
        ]
      : []);

  return {
    id: "resp_fusionkit_fake",
    object: "response",
    created_at: 1_750_000_000,
    status: options.status ?? "completed",
    model: options.model ?? "fusionkit-fake-responses-model",
    output,
    ...(includeOutputText ? { output_text: outputText } : {}),
    ...(options.incompleteReason
      ? { incomplete_details: { reason: options.incompleteReason } }
      : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

export function createModelsBody(
  options: ModelsBodyOptions,
): Record<string, unknown> {
  return {
    object: "list",
    data: options.ids.map((id, index) => ({
      id,
      object: "model",
      created: 1_750_000_000 + index,
      owned_by: "fusionkit-fake-provider",
    })),
  };
}

export function createErrorBody(
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

export async function startFakeModelApiServer(): Promise<FakeModelApiServer> {
  const requests: CapturedModelApiRequest[] = [];
  const queuedResponses: QueuedFakeResponse[] = [];

  const server = createServer(async (request, response) => {
    try {
      const captured = await captureRequest(request);
      requests.push(captured);

      if (captured.route === "unknown") {
        writeJson(response, {
          status: 404,
          body: createErrorBody(
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
        writeJson(response, {
          status: 500,
          body: createErrorBody(
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
      writeJson(response, resolved);
    } catch (error) {
      writeJson(response, {
        status: 500,
        body: createErrorBody(
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
    throw new Error("Fake model API server did not expose a TCP port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    responsesUrl: `${baseUrl}/responses`,
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
): Promise<CapturedModelApiRequest> {
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

  const method = request.method ?? "";
  const url = request.url ?? "";

  return {
    method,
    url,
    route: detectRoute(method, url),
    headers: request.headers,
    body: parsedBody as Record<string, unknown>,
  };
}

function detectRoute(method: string, url: string): FakeModelApiRoute {
  if (method === "POST" && url === "/v1/chat/completions") {
    return "chat_completions";
  }
  if (method === "POST" && url === "/v1/responses") {
    return "responses";
  }
  if (method === "GET" && url === "/v1/models") {
    return "models";
  }
  return "unknown";
}

function writeJson(
  response: ServerResponse,
  fakeResponse: FakeModelApiResponse,
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
