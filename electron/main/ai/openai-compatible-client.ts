import type { AxiosProxyConfig } from "axios";
import { cleanThinkTags } from "./adapters/chat-completions-adapter";
import {
  sendModelRuntimeText,
  type ModelRuntimeMessage,
  type ModelRuntimeUsage,
} from "./model-runtime-client";
import {
  ModelRuntimeClientError,
  type ModelRuntimeErrorCode,
  type ModelRuntimeErrorDetails,
  type ModelRuntimeRetryOptions,
} from "./model-runtime-errors";

export interface OpenAICompatibleChatMessage extends ModelRuntimeMessage {}

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

export type OpenAICompatibleRetryOptions = ModelRuntimeRetryOptions;

export type OpenAICompatibleUsage = ModelRuntimeUsage;

export interface OpenAICompatibleChatResult {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  usage?: OpenAICompatibleUsage;
  responseId?: string;
  model?: string;
}

export type OpenAICompatibleClientErrorCode = Exclude<
  ModelRuntimeErrorCode,
  "unsupported_api_format"
>;

export class OpenAICompatibleClientError extends Error {
  constructor(
    readonly code: OpenAICompatibleClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: ModelRuntimeErrorDetails = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleClientError";
  }
}

export async function sendOpenAICompatibleChatCompletion(
  request: OpenAICompatibleChatRequest,
): Promise<OpenAICompatibleChatResult> {
  try {
    const result = await sendModelRuntimeText({
      model: {
        apiKey: request.apiKey,
        modelKey: request.model,
        endpoint: request.endpoint,
        apiFormat: "chat_completions",
        outputTokenParameter: "max_tokens",
      },
      messages: request.messages,
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      proxy: request.proxy,
      retry: request.retry,
    });

    return {
      content: result.content,
      reasoningContent: result.reasoningContent,
      finishReason: result.finishReason,
      usage: result.usage,
      responseId: result.responseId,
      model: result.model,
    };
  } catch (error) {
    if (error instanceof ModelRuntimeClientError) {
      throw toOpenAICompatibleClientError(error);
    }
    throw error;
  }
}

export { cleanThinkTags };

function toOpenAICompatibleClientError(
  error: ModelRuntimeClientError,
): OpenAICompatibleClientError {
  return new OpenAICompatibleClientError(
    toOpenAICompatibleErrorCode(error.code),
    error.message,
    error.retryable,
    error.details,
  );
}

function toOpenAICompatibleErrorCode(
  code: ModelRuntimeErrorCode,
): OpenAICompatibleClientErrorCode {
  return code === "unsupported_api_format" ? "invalid_response" : code;
}
