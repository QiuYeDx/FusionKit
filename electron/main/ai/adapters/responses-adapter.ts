import axios, { type AxiosError } from "axios";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import { getAxiosProxyConfig } from "../../proxy";
import { cleanThinkTags } from "./chat-completions-adapter";
import type {
  ModelRuntimeMessage,
  ModelRuntimeTextRequest,
  ModelRuntimeTextResult,
  ModelRuntimeUsage,
} from "../model-runtime-client";
import {
  DEFAULT_MODEL_RUNTIME_RETRY_OPTIONS,
  ModelRuntimeClientError,
  type ModelRuntimeRetryOptions,
} from "../model-runtime-errors";

export async function sendResponsesText(
  request: ModelRuntimeTextRequest,
): Promise<ModelRuntimeTextResult> {
  const retry = { ...DEFAULT_MODEL_RUNTIME_RETRY_OPTIONS, ...request.retry };
  let attempt = 0;

  while (true) {
    throwIfAborted(request.signal);

    try {
      return await sendOnce(request, attempt);
    } catch (error) {
      const clientError = toRuntimeError(error, request.model.apiKey, attempt);
      if (!clientError.retryable || attempt >= retry.maxRetries) {
        throw clientError;
      }

      const retryDelay = resolveRetryDelay(clientError, attempt, retry);
      await delay(retryDelay, request.signal);
      attempt += 1;
    }
  }
}

async function sendOnce(
  request: ModelRuntimeTextRequest,
  attempt: number,
): Promise<ModelRuntimeTextResult> {
  const response = await axios.post(
    normalizeModelEndpoint(request.model.endpoint).responsesUrl,
    buildResponsesBody(request),
    {
      headers: {
        Authorization: `Bearer ${request.model.apiKey}`,
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
      request.model.apiKey,
    );
  }

  return parseResponsesResponse(response.data, attempt);
}

function buildResponsesBody(
  request: ModelRuntimeTextRequest,
): Record<string, unknown> {
  const { instructions, input } = mapMessagesToResponsesInput(request.messages);
  const body: Record<string, unknown> = {
    model: request.model.modelKey,
    input,
    store: false,
  };

  if (instructions) {
    body.instructions = instructions;
  }

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.maxOutputTokens !== undefined) {
    body.max_output_tokens = request.maxOutputTokens;
  }

  if (request.responseFormat === "json_object") {
    body.text = { format: { type: "json_object" } };
  }

  return body;
}

function mapMessagesToResponsesInput(messages: ModelRuntimeMessage[]): {
  instructions?: string;
  input: string | Array<{ role: "user" | "assistant"; content: string }>;
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const inputMessages = messages.filter((message) => message.role !== "system");

  if (inputMessages.length === 0) {
    return { instructions, input: instructions || "" };
  }

  if (inputMessages.length === 1 && inputMessages[0].role === "user") {
    return { instructions, input: inputMessages[0].content };
  }

  return {
    instructions,
    input: inputMessages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
  };
}

function parseResponsesResponse(
  data: unknown,
  attempt: number,
): ModelRuntimeTextResult {
  if (!isRecord(data)) {
    throw new ModelRuntimeClientError(
      "invalid_response",
      "Model response is not an object.",
      true,
      { attempt },
    );
  }
  const usage = parseUsage(data.usage);

  const status = typeof data.status === "string" ? data.status : undefined;
  if (status === "incomplete") {
    const incompleteDetails = isRecord(data.incomplete_details)
      ? data.incomplete_details
      : undefined;
    if (incompleteDetails?.reason === "max_output_tokens") {
      throw new ModelRuntimeClientError(
        "length_truncated",
        "Model response was truncated by the output-token limit. Consider reducing the slice token limit or using a model with a larger context window.",
        false,
        { attempt, usage },
      );
    }
  }

  if (status === "failed") {
    const responseError = isRecord(data.error) ? data.error : undefined;
    throw new ModelRuntimeClientError(
      "invalid_response",
      typeof responseError?.message === "string"
        ? responseError.message
        : "Model response failed.",
      false,
      { attempt, usage },
    );
  }

  const content = cleanThinkTags(extractResponseText(data));
  if (!content.trim()) {
    throw new ModelRuntimeClientError(
      "empty_response",
      "Model response content is empty.",
      true,
      { attempt, usage },
    );
  }

  return {
    content,
    finishReason: status,
    usage,
    responseId: typeof data.id === "string" ? data.id : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    apiFormat: "responses",
    rawStatus: status,
  };
}

function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";

  return data.output
    .map((item) => extractOutputItemText(item))
    .filter(Boolean)
    .join("");
}

function extractOutputItemText(item: unknown): string {
  if (!isRecord(item)) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";

  return item.content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function parseUsage(usage: unknown): ModelRuntimeUsage | undefined {
  if (!isRecord(usage)) return undefined;

  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : undefined;
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : undefined;

  return {
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    reasoningTokens: numberOrUndefined(outputDetails?.reasoning_tokens),
    cachedInputTokens: numberOrUndefined(inputDetails?.cached_tokens),
  };
}

function httpErrorFromResponse(
  status: number,
  body: unknown,
  retryAfterMs: number | undefined,
  attempt: number,
  apiKey: string,
): ModelRuntimeClientError {
  const message = sanitizeErrorMessage(extractHttpErrorMessage(body, status), apiKey);
  if (status === 401) {
    return new ModelRuntimeClientError(
      "http_unauthorized",
      message,
      false,
      { status, attempt },
    );
  }
  if (status === 403) {
    return new ModelRuntimeClientError("http_forbidden", message, false, {
      status,
      attempt,
    });
  }
  if (status === 429) {
    return new ModelRuntimeClientError("http_rate_limited", message, true, {
      status,
      retryAfterMs,
      attempt,
    });
  }
  if (status === 408 || status >= 500) {
    return new ModelRuntimeClientError("http_retryable", message, true, {
      status,
      retryAfterMs,
      attempt,
    });
  }
  return new ModelRuntimeClientError("http_non_retryable", message, false, {
    status,
    attempt,
  });
}

function toRuntimeError(
  error: unknown,
  apiKey: string,
  attempt: number,
): ModelRuntimeClientError {
  if (error instanceof ModelRuntimeClientError) return error;

  if (isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") {
      return new ModelRuntimeClientError(
        "aborted",
        "Model request was aborted.",
        false,
        { attempt },
      );
    }
    if (error.code === "ECONNABORTED") {
      return new ModelRuntimeClientError(
        "request_timeout",
        "Model request timed out.",
        true,
        { attempt },
      );
    }
    return new ModelRuntimeClientError(
      "network_error",
      sanitizeErrorMessage(error.message, apiKey),
      true,
      { attempt },
    );
  }

  if (error instanceof Error) {
    return new ModelRuntimeClientError(
      "network_error",
      sanitizeErrorMessage(error.message, apiKey),
      true,
      { attempt },
    );
  }

  return new ModelRuntimeClientError(
    "network_error",
    "Unknown model request error.",
    true,
    { attempt },
  );
}

function resolveRetryDelay(
  error: ModelRuntimeClientError,
  attempt: number,
  retry: ModelRuntimeRetryOptions,
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
        new ModelRuntimeClientError(
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
    throw new ModelRuntimeClientError(
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
