import type { ModelApiFormat } from "@/type/model";
import type { ModelRuntimeUsage } from "./model-runtime-client";

export type ModelRuntimeErrorCode =
  | "aborted"
  | "network_error"
  | "request_timeout"
  | "http_rate_limited"
  | "http_retryable"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_non_retryable"
  | "unsupported_api_format"
  | "empty_response"
  | "length_truncated"
  | "invalid_response";

export interface ModelRuntimeErrorDetails {
  status?: number;
  retryAfterMs?: number;
  attempt?: number;
  apiFormat?: ModelApiFormat;
  usage?: ModelRuntimeUsage;
}

export class ModelRuntimeClientError extends Error {
  constructor(
    readonly code: ModelRuntimeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: ModelRuntimeErrorDetails = {},
  ) {
    super(message);
    this.name = "ModelRuntimeClientError";
  }
}

export interface ModelRuntimeRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_MODEL_RUNTIME_RETRY_OPTIONS: ModelRuntimeRetryOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};
