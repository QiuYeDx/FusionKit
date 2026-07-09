import type { AudioIpcErrorCode } from "@/type/audioIpc";

export interface AudioRuntimeClientErrorOptions {
  code: AudioIpcErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const SENSITIVE_KEY_PATTERN =
  /(api[-_ ]?key|authorization|token|secret|base64|audio|pcm|buffer|bytes|requestbody|body)/i;

export class AudioRuntimeClientError extends Error {
  readonly code: AudioIpcErrorCode;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(options: AudioRuntimeClientErrorOptions) {
    super(options.message);
    this.name = "AudioRuntimeClientError";
    this.code = options.code;
    this.field = options.field;
    this.details = sanitizeAudioErrorDetails(options.details);
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function createAudioRuntimeError(
  options: AudioRuntimeClientErrorOptions,
): AudioRuntimeClientError {
  return new AudioRuntimeClientError(options);
}

export function sanitizeAudioErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = sanitizeAudioErrorValue(key, value);
  }
  return sanitized;
}

function sanitizeAudioErrorValue(key: string, value: unknown): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    if (looksLikeSensitiveString(value)) {
      return "[redacted]";
    }
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAudioErrorValue(key, item));
  }

  if (isRecord(value)) {
    return sanitizeAudioErrorDetails(value);
  }

  return value;
}

function looksLikeSensitiveString(value: string): boolean {
  if (/^(sk|ek|mimo)-[a-z0-9_-]{12,}/i.test(value)) {
    return true;
  }
  if (/^Bearer\s+/i.test(value)) {
    return true;
  }
  if (/^data:audio\/[a-z0-9.+-]+;base64,/i.test(value)) {
    return true;
  }
  if (/^[A-Za-z0-9+/]{80,}={0,2}$/.test(value)) {
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
