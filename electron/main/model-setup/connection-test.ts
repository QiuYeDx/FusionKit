import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import {
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  apiKeyHasUnsendableCharacters,
  modelConnectionTestRequestSchema,
  type ModelConnectionTestReason,
  type ModelConnectionTestResult,
} from "@/model-setup/contract";
import type { ModelErrorCategory } from "@/lib/model-error-category";
import {
  sendModelRuntimeText,
  type ModelRuntimeTextRequest,
  type ModelRuntimeTextResult,
} from "../ai/model-runtime-client";
import { ModelRuntimeClientError, modelErrorCategory } from "../ai/model-runtime-errors";

/** Enough for every API to accept the request (the Responses API wants at least 16), little enough to cost nothing. */
export const CONNECTION_TEST_OUTPUT_TOKENS = 16;
const DETAIL_LIMIT = 300;

export interface ModelConnectionTestOptions {
  readonly send?: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Sends the smallest real request with the profile, through the same adapters and proxy agents
 * as real calls, and says whether it worked and, if not, why. The key is used for this request
 * only; it is never logged and is removed from the detail that goes back to the window.
 */
export async function testModelConnection(
  input: unknown,
  options: ModelConnectionTestOptions = {},
): Promise<ModelConnectionTestResult> {
  const parsed = modelConnectionTestRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, latencyMs: 0, category: "unknown" };
  const { baseUrl, apiFormat, modelKey, apiKey, outputTokenParameter } = parsed.data;
  // Checked before anything is sent; the window explains each one in the user's language.
  if (!apiKey.trim()) return notSent("auth", "missing_key");
  if (apiKeyHasUnsendableCharacters(apiKey)) return notSent("auth", "key_characters");
  if (!baseUrl) return notSent("bad_url", "missing_url");
  if (!isHttpUrl(normalizeModelEndpoint(baseUrl).baseUrl)) return notSent("bad_url", "invalid_url");
  if (!modelKey) return notSent("model_not_found", "missing_model");

  const send = options.send ?? sendModelRuntimeText;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MODEL_CONNECTION_TEST_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  try {
    await send({
      model: {
        apiKey: apiKey.trim(),
        modelKey,
        endpoint: baseUrl,
        apiFormat,
        ...(outputTokenParameter ? { outputTokenParameter } : {}),
      },
      messages: [{ role: "user", content: "Hi" }],
      maxOutputTokens: CONNECTION_TEST_OUTPUT_TOKENS,
      timeoutMs,
      signal: timeout.signal,
      retry: { maxRetries: 0 },
    });
    return { ok: true, latencyMs: elapsed(), category: "ok" };
  } catch (error) {
    const latencyMs = elapsed();
    const timedOut = timeout.signal.aborted || (error instanceof ModelRuntimeClientError && error.code === "request_timeout");
    if (timedOut) return { ok: false, latencyMs, category: "network", reason: "timeout" };
    if (!(error instanceof ModelRuntimeClientError)) return { ok: false, latencyMs, category: "unknown" };
    // A real completion that the tiny output limit cut short, or that said nothing: the adapters
    // only report these for a body shaped like a completion (a choice, a Responses output).
    if (error.code === "length_truncated" || error.code === "empty_response") return { ok: true, latencyMs, category: "ok" };
    const providerMessage = error.details.providerMessage;
    const fromProvider = providerMessage !== undefined || error.details.providerCode !== undefined || error.details.providerType !== undefined;
    let category = modelErrorCategory(error);
    // A 2xx answer that is neither a completion nor an error from the service: the address leads somewhere else.
    if (category === "unknown" && error.code === "invalid_response" && !fromProvider) category = "bad_url";
    // Only words that came from outside are shown: the service's own message, or what the
    // connection reported. Our own English wrappers say nothing the category does not.
    const detail: Pick<ModelConnectionTestResult, "detail" | "detailSource"> = providerMessage
      ? { detail: sanitizeDetail(providerMessage, apiKey), detailSource: "service" }
      : error.code === "network_error" && error.message
        ? { detail: sanitizeDetail(error.message, apiKey), detailSource: "connection" }
        : {};
    return {
      ok: false,
      latencyMs,
      category,
      ...(error.details.status !== undefined ? { httpStatus: error.details.status } : {}),
      ...detail,
    };
  } finally {
    clearTimeout(timer);
  }
}

function notSent(category: ModelErrorCategory, reason: ModelConnectionTestReason): ModelConnectionTestResult {
  return { ok: false, latencyMs: 0, category, reason };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname;
  } catch {
    return false;
  }
}

/** Shortens a message and removes the key and anything that looks like one. */
export function sanitizeDetail(message: string, apiKey: string): string {
  let text = message;
  const key = apiKey.trim();
  if (key) text = text.split(key).join("[redacted]");
  text = text
    .replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}
