import axios, { type AxiosError, type AxiosProxyConfig } from "axios";
import { getAxiosProxyConfig } from "../proxy";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
} from "./audio-errors";

export interface AudioRuntimeRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface AudioRuntimeHttpOptions {
  apiKey: string;
  signal?: AbortSignal;
  proxy?: AxiosProxyConfig | false;
  retry?: Partial<AudioRuntimeRetryOptions>;
}

export const DEFAULT_AUDIO_RUNTIME_RETRY_OPTIONS: AudioRuntimeRetryOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};

export async function runAudioRuntimeRequest<T>(
  options: AudioRuntimeHttpOptions,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  const retry = { ...DEFAULT_AUDIO_RUNTIME_RETRY_OPTIONS, ...options.retry };
  let attempt = 0;

  while (true) {
    throwIfAudioRequestAborted(options.signal);

    try {
      return await operation(attempt);
    } catch (error) {
      const clientError = toAudioRuntimeError(error, options.apiKey, attempt);
      if (!isRetryableAudioRuntimeError(clientError) || attempt >= retry.maxRetries) {
        throw clientError;
      }

      await delay(resolveAudioRetryDelay(clientError, attempt, retry), options.signal);
      attempt += 1;
    }
  }
}

export function createAudioHttpErrorFromResponse(args: {
  status: number;
  body: unknown;
  headers?: unknown;
  attempt: number;
  apiKey: string;
}): AudioRuntimeClientError {
  const retryAfterMs = parseRetryAfter(readHeader(args.headers, "retry-after"));
  const message = sanitizeAudioErrorMessage(
    extractHttpErrorMessage(args.body, args.status),
    args.apiKey,
  );

  if (args.status === 401) {
    return createAudioRuntimeError({
      code: "http_unauthorized",
      message,
      details: { status: args.status, attempt: args.attempt },
    });
  }
  if (args.status === 403) {
    return createAudioRuntimeError({
      code: "http_forbidden",
      message,
      details: { status: args.status, attempt: args.attempt },
    });
  }
  if (args.status === 429) {
    return createAudioRuntimeError({
      code: "http_rate_limited",
      message,
      details: {
        status: args.status,
        retryAfterMs,
        attempt: args.attempt,
      },
    });
  }
  if (args.status === 408 || args.status >= 500) {
    return createAudioRuntimeError({
      code: "http_retryable",
      message,
      details: {
        status: args.status,
        retryAfterMs,
        attempt: args.attempt,
      },
    });
  }

  return createAudioRuntimeError({
    code: "http_non_retryable",
    message,
    details: { status: args.status, attempt: args.attempt },
  });
}

export function resolveAudioAxiosProxyConfig(
  proxy: AxiosProxyConfig | false | undefined,
): { proxy?: AxiosProxyConfig | false } {
  if (proxy !== undefined) {
    return { proxy };
  }
  return getAxiosProxyConfig();
}

export function throwIfAudioRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAudioRuntimeError({
      code: "aborted",
      message: "Audio request was aborted.",
    });
  }
}

function toAudioRuntimeError(
  error: unknown,
  apiKey: string,
  attempt: number,
): AudioRuntimeClientError {
  if (error instanceof AudioRuntimeClientError) return error;

  if (isAxiosError(error)) {
    if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
      return createAudioRuntimeError({
        code: "aborted",
        message: "Audio request was aborted.",
        details: { attempt },
        cause: error,
      });
    }
    if (error.code === "ECONNABORTED") {
      return createAudioRuntimeError({
        code: "request_timeout",
        message: "Audio request timed out.",
        details: { attempt },
        cause: error,
      });
    }
    return createAudioRuntimeError({
      code: "network_error",
      message: sanitizeAudioErrorMessage(error.message, apiKey),
      details: { attempt },
      cause: error,
    });
  }

  if (error instanceof Error) {
    return createAudioRuntimeError({
      code: "network_error",
      message: "Audio request failed.",
      details: { attempt },
      cause: error,
    });
  }

  return createAudioRuntimeError({
    code: "network_error",
    message: "Unknown audio request error.",
    details: { attempt },
  });
}

function isRetryableAudioRuntimeError(error: AudioRuntimeClientError): boolean {
  return (
    error.code === "network_error" ||
    error.code === "request_timeout" ||
    error.code === "http_rate_limited" ||
    error.code === "http_retryable" ||
    error.code === "empty_response" ||
    error.code === "invalid_response"
  );
}

function resolveAudioRetryDelay(
  error: AudioRuntimeClientError,
  attempt: number,
  retry: AudioRuntimeRetryOptions,
): number {
  const retryAfterMs =
    typeof error.details?.retryAfterMs === "number"
      ? error.details.retryAfterMs
      : undefined;
  if (retryAfterMs !== undefined) {
    return Math.max(0, retryAfterMs);
  }

  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** attempt,
  );
  const jitter = exponential * retry.jitterRatio * Math.random();
  return Math.round(exponential + jitter);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(
        createAudioRuntimeError({
          code: "aborted",
          message: "Audio request was aborted.",
        }),
      );
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
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
  const normalized = normalizeErrorBody(body);
  if (isRecord(normalized)) {
    const error = isRecord(normalized.error) ? normalized.error : undefined;
    if (typeof error?.message === "string") {
      return `Audio request failed with HTTP ${status}: ${error.message}`;
    }
  }
  return `Audio request failed with HTTP ${status}.`;
}

function normalizeErrorBody(body: unknown): unknown {
  if (body instanceof ArrayBuffer) {
    return parseJsonText(Buffer.from(body).toString("utf8")) ?? body;
  }
  if (Buffer.isBuffer(body)) {
    return parseJsonText(body.toString("utf8")) ?? body;
  }
  if (typeof body === "string") {
    return parseJsonText(body) ?? body;
  }
  return body;
}

function parseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: (headerName: string) => unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    if (value !== undefined) return value;
  }
  const lowerName = name.toLowerCase();
  const record = headers as Record<string, unknown>;
  return record[lowerName] ?? record[name] ?? record[name.toUpperCase()];
}

function sanitizeAudioErrorMessage(message: string, apiKey: string): string {
  let sanitized = message;
  if (apiKey) {
    sanitized = sanitized.split(apiKey).join("[redacted]");
  }
  return sanitized.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function isAxiosError(error: unknown): error is AxiosError {
  return axios.isAxiosError(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
