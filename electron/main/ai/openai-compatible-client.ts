import axios, { type AxiosError, type AxiosProxyConfig } from "axios";
import { getAxiosProxyConfig } from "../proxy";

export interface OpenAICompatibleChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAICompatibleChatRequest {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: OpenAICompatibleChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  proxy?: AxiosProxyConfig | false;
  retry?: Partial<OpenAICompatibleRetryOptions>;
}

export interface OpenAICompatibleRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface OpenAICompatibleUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface OpenAICompatibleChatResult {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  usage?: OpenAICompatibleUsage;
  responseId?: string;
  model?: string;
}

export type OpenAICompatibleClientErrorCode =
  | "aborted"
  | "network_error"
  | "request_timeout"
  | "http_rate_limited"
  | "http_retryable"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_non_retryable"
  | "empty_response"
  | "length_truncated"
  | "invalid_response";

export class OpenAICompatibleClientError extends Error {
  constructor(
    readonly code: OpenAICompatibleClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: {
      status?: number;
      retryAfterMs?: number;
      attempt?: number;
    } = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleClientError";
  }
}

const DEFAULT_RETRY_OPTIONS: OpenAICompatibleRetryOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};

export async function sendOpenAICompatibleChatCompletion(
  request: OpenAICompatibleChatRequest,
): Promise<OpenAICompatibleChatResult> {
  const retry = { ...DEFAULT_RETRY_OPTIONS, ...request.retry };
  let attempt = 0;

  while (true) {
    throwIfAborted(request.signal);

    try {
      return await sendOnce(request, attempt);
    } catch (error) {
      const clientError = toClientError(error, request.apiKey, attempt);
      if (!clientError.retryable || attempt >= retry.maxRetries) {
        throw clientError;
      }

      const retryDelay = resolveRetryDelay(clientError, attempt, retry);
      await delay(retryDelay, request.signal);
      attempt += 1;
    }
  }
}

function buildChatCompletionUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function sendOnce(
  request: OpenAICompatibleChatRequest,
  attempt: number,
): Promise<OpenAICompatibleChatResult> {
  const response = await axios.post(
    buildChatCompletionUrl(request.endpoint),
    {
      model: request.model,
      messages: request.messages,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens !== undefined
        ? { max_tokens: request.maxTokens }
        : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: request.timeoutMs ?? 60_000,
      signal: request.signal,
      validateStatus: () => true,
      ...(request.proxy !== undefined
        ? { proxy: request.proxy }
        : getAxiosProxyConfig()),
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw httpErrorFromResponse(
      response.status,
      response.data,
      parseRetryAfter(response.headers["retry-after"]),
      attempt,
      request.apiKey,
    );
  }

  return parseChatCompletionResponse(response.data, attempt);
}

function parseChatCompletionResponse(
  data: unknown,
  attempt: number,
): OpenAICompatibleChatResult {
  if (!isRecord(data)) {
    throw new OpenAICompatibleClientError(
      "invalid_response",
      "Model response is not an object.",
      true,
      { attempt },
    );
  }

  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!isRecord(choice)) {
    throw new OpenAICompatibleClientError(
      "invalid_response",
      "Model response does not contain a chat completion choice.",
      true,
      { attempt },
    );
  }

  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  if (finishReason === "length") {
    throw new OpenAICompatibleClientError(
      "length_truncated",
      "Model response was truncated by the output-token limit. Consider reducing the slice token limit or using a model with a larger context window.",
      false,
      { attempt },
    );
  }

  const message = isRecord(choice.message) ? choice.message : undefined;
  const content = cleanThinkTags(extractMessageContent(message?.content));
  if (!content.trim()) {
    throw new OpenAICompatibleClientError(
      "empty_response",
      "Model response content is empty.",
      true,
      { attempt },
    );
  }

  return {
    content,
    reasoningContent:
      typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : undefined,
    finishReason,
    usage: parseUsage(data.usage),
    responseId: typeof data.id === "string" ? data.id : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
  };
}

export function cleanThinkTags(text: string): string {
  let normalized = text.replace(/^\uFEFF/, "").trim();
  while (/^<think>/i.test(normalized)) {
    const closingIndex = normalized.toLowerCase().indexOf("</think>");
    if (closingIndex < 0) break;
    normalized = normalized.slice(closingIndex + "</think>".length).trim();
  }
  return normalized;
}

function extractMessageContent(content: unknown): string {
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

function parseUsage(usage: unknown): OpenAICompatibleUsage | undefined {
  if (!isRecord(usage)) return undefined;

  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;

  return {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    reasoningTokens: numberOrUndefined(completionDetails?.reasoning_tokens),
  };
}

function httpErrorFromResponse(
  status: number,
  body: unknown,
  retryAfterMs: number | undefined,
  attempt: number,
  apiKey: string,
): OpenAICompatibleClientError {
  const message = sanitizeErrorMessage(extractHttpErrorMessage(body, status), apiKey);
  if (status === 401) {
    return new OpenAICompatibleClientError(
      "http_unauthorized",
      message,
      false,
      { status, attempt },
    );
  }
  if (status === 403) {
    return new OpenAICompatibleClientError("http_forbidden", message, false, {
      status,
      attempt,
    });
  }
  if (status === 429) {
    return new OpenAICompatibleClientError("http_rate_limited", message, true, {
      status,
      retryAfterMs,
      attempt,
    });
  }
  if (status === 408 || status >= 500) {
    return new OpenAICompatibleClientError("http_retryable", message, true, {
      status,
      retryAfterMs,
      attempt,
    });
  }
  return new OpenAICompatibleClientError("http_non_retryable", message, false, {
    status,
    attempt,
  });
}

function toClientError(
  error: unknown,
  apiKey: string,
  attempt: number,
): OpenAICompatibleClientError {
  if (error instanceof OpenAICompatibleClientError) return error;

  if (isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") {
      return new OpenAICompatibleClientError(
        "aborted",
        "Model request was aborted.",
        false,
        { attempt },
      );
    }
    if (error.code === "ECONNABORTED") {
      return new OpenAICompatibleClientError(
        "request_timeout",
        "Model request timed out.",
        true,
        { attempt },
      );
    }
    return new OpenAICompatibleClientError(
      "network_error",
      sanitizeErrorMessage(error.message, apiKey),
      true,
      { attempt },
    );
  }

  if (error instanceof Error) {
    return new OpenAICompatibleClientError(
      "network_error",
      sanitizeErrorMessage(error.message, apiKey),
      true,
      { attempt },
    );
  }

  return new OpenAICompatibleClientError(
    "network_error",
    "Unknown model request error.",
    true,
    { attempt },
  );
}

function resolveRetryDelay(
  error: OpenAICompatibleClientError,
  attempt: number,
  retry: OpenAICompatibleRetryOptions,
): number {
  if (error.details.retryAfterMs !== undefined) {
    return Math.max(0, error.details.retryAfterMs);
  }

  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** attempt,
  );
  const jitter = exponential * retry.jitterRatio * Math.random();
  return Math.round(exponential + jitter);
}

function parseRetryAfter(value: unknown): number | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function extractHttpErrorMessage(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = isRecord(body.error) ? body.error : undefined;
    if (typeof error?.message === "string") {
      return `Model request failed with HTTP ${status}: ${error.message}`;
    }
  }
  return `Model request failed with HTTP ${status}.`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        new OpenAICompatibleClientError(
          "aborted",
          "Model request was aborted.",
          false,
        ),
      );
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OpenAICompatibleClientError(
      "aborted",
      "Model request was aborted.",
      false,
    );
  }
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, "[REDACTED_API_KEY]") : message;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAxiosError(error: unknown): error is AxiosError {
  return axios.isAxiosError(error);
}
