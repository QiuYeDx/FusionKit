import type { AxiosProxyConfig } from "axios";
import type { ModelApiFormat, OutputTokenParameter } from "@/type/model";
import { sendChatCompletionsText } from "./adapters/chat-completions-adapter";
import { sendResponsesText } from "./adapters/responses-adapter";
import type { ModelRuntimeRetryOptions } from "./model-runtime-errors";

export interface ModelRuntimeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRuntimeConfig {
  profileId?: string;
  apiKey: string;
  modelKey: string;
  endpoint: string;
  apiFormat: ModelApiFormat;
  outputTokenParameter?: OutputTokenParameter;
  thinkingEnabled?: boolean;
}

export interface ModelRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ModelRuntimeTextRequest {
  model: ModelRuntimeConfig;
  messages: ModelRuntimeMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "text" | "json_object";
  timeoutMs?: number;
  signal?: AbortSignal;
  proxy?: AxiosProxyConfig | false;
  retry?: Partial<ModelRuntimeRetryOptions>;
}

export interface ModelRuntimeTextResult {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  usage?: ModelRuntimeUsage;
  responseId?: string;
  model?: string;
  apiFormat: ModelApiFormat;
  rawStatus?: string;
}

export async function sendModelRuntimeText(
  request: ModelRuntimeTextRequest,
): Promise<ModelRuntimeTextResult> {
  const apiFormat = request.model.apiFormat ?? "chat_completions";
  const normalizedRequest: ModelRuntimeTextRequest =
    apiFormat === request.model.apiFormat
      ? request
      : {
          ...request,
          model: {
            ...request.model,
            apiFormat,
          },
        };

  switch (apiFormat) {
    case "chat_completions":
      return sendChatCompletionsText(normalizedRequest);
    case "responses":
      return sendResponsesText(normalizedRequest);
  }
}
