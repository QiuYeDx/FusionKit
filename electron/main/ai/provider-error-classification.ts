export type ProviderErrorMetadata = Readonly<{
  message?: string;
  code?: string;
  type?: string;
}>;

const TRANSIENT_PROVIDER_ERROR_MARKERS = new Set([
  "api_connection_error",
  "engine_overloaded",
  "internal_error",
  "model_overloaded",
  "model_unavailable",
  "overloaded",
  "provider_unavailable",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
  "service_unavailable",
  "temporarily_unavailable",
  "timeout",
  "upstream_error",
]);

const PERMANENT_PROVIDER_ERROR_MARKERS = new Set([
  "authentication_error",
  "billing_hard_limit_reached",
  "content_policy_violation",
  "insufficient_quota",
  "invalid_api_key",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "model_not_found",
  "permission_error",
  "unsupported_value",
]);

export function extractProviderErrorMetadata(
  body: unknown,
): ProviderErrorMetadata {
  if (!isRecord(body)) return {};
  const error = isRecord(body.error) ? body.error : undefined;
  if (!error) return {};
  const code = boundedMarker(error.code);
  const type = boundedMarker(error.type);

  return {
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

/**
 * Returns true/false for known provider markers and undefined when the
 * provider did not expose enough structured information to decide.
 */
export function classifyProviderErrorRetryability(
  metadata: ProviderErrorMetadata,
): boolean | undefined {
  const markers = [metadata.code, metadata.type]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeMarker)
    .filter(Boolean);

  if (markers.some((marker) => TRANSIENT_PROVIDER_ERROR_MARKERS.has(marker))) {
    return true;
  }
  if (markers.some((marker) => PERMANENT_PROVIDER_ERROR_MARKERS.has(marker))) {
    return false;
  }
  return undefined;
}

export function isRetryableModelHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status >= 500;
}

function normalizeMarker(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function boundedMarker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
