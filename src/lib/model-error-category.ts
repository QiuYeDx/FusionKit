import type { NetworkErrorCategory } from "../network/contract";

/**
 * Why a model request failed, in terms a user can act on. Shared by the main process (model
 * runtime errors, the connection test) and the renderer (the Agent's own requests), so every
 * place that shows a model error explains it the same way.
 */
export const MODEL_ERROR_CATEGORIES = [
  "auth",
  "balance",
  "model_not_found",
  "rate_limited",
  "network",
  "proxy",
  "server",
  "bad_url",
  "unknown",
] as const;
export type ModelErrorCategory = (typeof MODEL_ERROR_CATEGORIES)[number];

export function isModelErrorCategory(value: unknown): value is ModelErrorCategory {
  return typeof value === "string" && (MODEL_ERROR_CATEGORIES as readonly string[]).includes(value);
}

/** What is known about a failed request. Every field is optional; more fields, better answers. */
export interface ModelErrorSignals {
  /** HTTP status of a server that answered. */
  readonly status?: number;
  /** `error.code` / `error.type` of an OpenAI-style error body. */
  readonly providerCode?: string;
  readonly providerType?: string;
  /** The provider's or the transport's message. */
  readonly message?: string;
  /** Set when no server answered: why the connection failed (see electron/main/network/errors.ts). */
  readonly networkCategory?: NetworkErrorCategory;
  /** The server answered with text that is not JSON (a web page, plain text). */
  readonly nonJsonResponse?: boolean;
  /** The server answered with an empty body. */
  readonly emptyBody?: boolean;
}

const BALANCE_MARKERS = new Set([
  "insufficient_quota",
  "insufficient_balance",
  "insufficient_funds",
  "billing_hard_limit_reached",
  "billing_not_active",
  "payment_required",
  "arrearage",
  "exceeded_current_quota_error",
]);
const AUTH_MARKERS = new Set([
  "invalid_api_key",
  "authentication_error",
  "invalid_authentication",
  "authentication_failed",
  "unauthorized",
  "incorrect_api_key",
]);
const MODEL_MARKERS = new Set(["model_not_found", "model_not_exist", "invalid_model", "deploymentnotfound"]);
const RATE_MARKERS = new Set(["rate_limit_exceeded", "rate_limit_error", "too_many_requests"]);

// DeepSeek answers 402 "Insufficient Balance"; OpenAI 429 "You exceeded your current quota";
// several domestic services say 余额不足 / 欠费 / Arrearage. A bare "billing" is not enough: OpenAI's
// ordinary rate-limit message links to the billing page too.
const BALANCE_TEXT = /insufficient[ _-]?(balance|quota|credit|funds)|exceeded (your )?current quota|quota (exceeded|exhausted)|out of credits|credit balance is too low|billing (hard )?limit|arrearage|payment required|余额不足|欠费|额度不足|额度已用尽/i;
// DeepSeek: "Authentication Fails, Your api key: ****abcd is invalid"; OpenAI: "Incorrect API key provided".
const AUTH_TEXT = /invalid[ _-]?api[ _-]?key|incorrect api key|api key (is )?(invalid|not valid|missing|expired)|your api key|authentication (fails|failed|error)|unauthori[sz]ed|invalid (token|authentication)|鉴权失败|认证失败|密钥无效/i;
// A key pasted with Chinese or full-width text cannot go into a request header: Node and Chromium refuse it.
const KEY_CHARACTERS_TEXT = /invalid character in header content|non ISO-8859-1 code point/i;
// DeepSeek: 400 "Model Not Exist"; OpenAI: 404 "The model `x` does not exist or you do not have access to it.";
// Ollama: 'model "x" not found'. The name must follow "model" directly, so "Model request failed … Not Found" does not count.
const MODEL_TEXT = /model[ _-]?not[ _-]?(found|exists?)|\bmodel\b[\s:]*[`'"“]?[\w./:@-]{1,120}[`'"”]?\s+(does not exist|doesn't exist|not found|not exist|is not supported|is unsupported)|(unknown|invalid|unsupported) model|no such model|模型不存在/i;
const REGION_TEXT = /unsupported_country|country, region,? or territory|not available in your (region|country)/i;
const BAD_URL_TEXT = /invalid url|unsupported protocol|not a valid url|failed to parse url|ERR_INVALID_URL|no route (found|matched)|unknown (url|endpoint|path)/i;
const RATE_TEXT = /rate[ _-]?limit|too many requests|请求过于频繁/i;
// The Agent's requests run in Chromium; there a failed connection only says that it failed.
const NETWORK_TEXT = /failed to fetch|fetch failed|cannot connect to api|networkerror|network error|load failed|net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|CERT_|SSL_)|timed? ?out|socket hang up|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/i;
const PROXY_TEXT = /net::ERR_(PROXY|TUNNEL|SOCKS|PAC_|MANDATORY_PROXY)|proxy (connection|authentication)/i;

function markers(signals: ModelErrorSignals): string[] {
  return [signals.providerCode, signals.providerType]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

/** Maps the network layer's connection categories onto the two the user can act on. */
export function modelCategoryForNetworkError(category: NetworkErrorCategory): ModelErrorCategory | undefined {
  switch (category) {
    case "proxy_failed":
    case "proxy_auth":
      return "proxy";
    case "dns":
    case "timeout":
    case "refused":
    case "reset":
    case "network_unreachable":
    case "tls":
      return "network";
    default:
      return undefined;
  }
}

/**
 * Classifies a failed model request. The provider's own error codes decide first; its words come
 * next. Balance words are checked before rate limits (OpenAI reports an empty account as 429) and
 * before keys (some services answer 401/403 for an unpaid account).
 */
export function classifyModelErrorSignals(signals: ModelErrorSignals): ModelErrorCategory {
  const codes = markers(signals);
  const message = signals.message ?? "";
  const status = typeof signals.status === "number" && Number.isFinite(signals.status) ? signals.status : undefined;

  // The request never left: the key holds characters a request header cannot carry.
  if (status === undefined && KEY_CHARACTERS_TEXT.test(message)) return "auth";

  if (status === undefined && signals.networkCategory) {
    // No server answered: the connection itself failed.
    const fromNetwork = modelCategoryForNetworkError(signals.networkCategory);
    if (fromNetwork) return fromNetwork;
    if (BAD_URL_TEXT.test(message)) return "bad_url";
    if (PROXY_TEXT.test(message)) return "proxy";
    if (signals.networkCategory === "unknown") return "network";
  }

  if (codes.some((code) => BALANCE_MARKERS.has(code))) return "balance";
  if (codes.some((code) => RATE_MARKERS.has(code))) return "rate_limited";
  if (codes.some((code) => AUTH_MARKERS.has(code))) return "auth";
  if (codes.some((code) => MODEL_MARKERS.has(code))) return "model_not_found";
  if (BALANCE_TEXT.test(message) || status === 402) return "balance";
  if (REGION_TEXT.test(message) || codes.includes("unsupported_country_region_territory")) return "network";
  // A web page instead of a JSON error usually means the address does not lead to the model API;
  // an empty 401/403 is still a refused key.
  if ((status === 401 || status === 403) && signals.nonJsonResponse) return "bad_url";
  if (status === 401 || status === 403) return "auth";
  if (MODEL_TEXT.test(message)) return "model_not_found";
  // A 404 that names no model: the path leads nowhere, so the address is wrong.
  if (status === 404 || status === 405) return "bad_url";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500 && status <= 599) return "server";
  if (signals.nonJsonResponse || signals.emptyBody || BAD_URL_TEXT.test(message)) return "bad_url";
  if (AUTH_TEXT.test(message)) return "auth";
  if (RATE_TEXT.test(message)) return "rate_limited";
  if (status === undefined && PROXY_TEXT.test(message)) return "proxy";
  if (status === undefined && NETWORK_TEXT.test(message)) return "network";
  return "unknown";
}

/** Reads `error.code`, `error.type` and `error.message` from an OpenAI-style JSON error body. */
export function providerErrorFromBody(body: unknown): Pick<ModelErrorSignals, "providerCode" | "providerType" | "message"> {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const error = record.error;
  const source = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : record;
  const text = (key: string) => typeof source[key] === "string" && (source[key] as string).trim()
    ? (source[key] as string).trim().slice(0, 500) : undefined;
  // FastAPI-style servers (vLLM and others) put their words in "detail".
  const message = text("message") ?? (typeof error === "string" && error.trim() ? error.trim().slice(0, 500) : undefined) ?? text("detail");
  const providerCode = text("code");
  const providerType = text("type");
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(message ? { message } : {}),
  };
}

/** What a response body that is not a JSON value says: a web page or plain text, or nothing at all. */
export function responseBodySignals(body: unknown): Pick<ModelErrorSignals, "nonJsonResponse" | "emptyBody"> {
  if (typeof body !== "string") return {};
  const trimmed = body.trim();
  if (!trimmed) return { emptyBody: true };
  try { JSON.parse(trimmed); return {}; } catch { return { nonJsonResponse: true }; }
}

/** True when a response body is text that does not parse as JSON (an HTML page, plain text). */
export function isNonJsonBody(body: unknown): boolean {
  return responseBodySignals(body).nonJsonResponse === true;
}
