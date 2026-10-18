import type { ModelApiFormat } from "@/type/model";
import type { NetworkErrorCategory } from "@/network/contract";
import {
  classifyModelErrorSignals,
  type ModelErrorCategory,
} from "@/lib/model-error-category";
import type { ModelRuntimeUsage } from "./model-runtime-client";

export type ModelRuntimeErrorCode =
  | "aborted"
  | "network_error"
  | "request_timeout"
  | "http_rate_limited"
  | "http_retryable"
  | "provider_retryable"
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
  providerCode?: string;
  providerType?: string;
  /** Text produced before a length cut-off, so callers can salvage partial output. */
  partialContent?: string;
  /** No server answered: why the connection failed. */
  networkCategory?: NetworkErrorCategory;
  /** The server answered with text that is not JSON (a web page, plain text). */
  nonJsonResponse?: boolean;
  /** The server answered with an empty body. */
  emptyBody?: boolean;
  /** What the provider itself said (its error message, without the key), when it said anything. */
  providerMessage?: string;
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

/**
 * Why a model request failed, for the message the user sees (wrong key, no balance, wrong model
 * name, no network...). Errors that are not model runtime errors are "unknown".
 */
export function modelErrorCategory(error: unknown): ModelErrorCategory {
  if (!(error instanceof ModelRuntimeClientError)) return "unknown";
  if (error.code === "aborted") return "unknown";
  return classifyModelErrorSignals({
    status: error.details.status,
    providerCode: error.details.providerCode,
    providerType: error.details.providerType,
    // The provider's own words; our "Model request failed with HTTP …" wrapper says nothing about the cause.
    message: error.details.providerMessage ?? error.message,
    networkCategory: error.details.networkCategory
      ?? (error.code === "request_timeout" ? "timeout" : error.code === "network_error" ? "unknown" : undefined),
    nonJsonResponse: error.details.nonJsonResponse,
    emptyBody: error.details.emptyBody,
  });
}

/**
 * Node refuses a header value outside Latin-1 before connecting. The only such value we send is
 * the key, so this is a key pasted together with Chinese or full-width text, not a network problem.
 */
export function apiKeyHeaderError(error: unknown, attempt: number): ModelRuntimeClientError | undefined {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const message = typeof record?.message === "string" ? record.message : "";
  if (record?.code !== "ERR_INVALID_CHAR" && !/invalid character in header content/i.test(message)) return undefined;
  return new ModelRuntimeClientError(
    "http_unauthorized",
    "Invalid API key: it contains characters that cannot be sent in a request header (for example Chinese or full-width characters).",
    false,
    { attempt },
  );
}
