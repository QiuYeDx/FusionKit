import { describe, expect, it } from "vitest";
import {
  classifyModelErrorSignals,
  isModelErrorCategory,
  isNonJsonBody,
  modelCategoryForNetworkError,
  providerErrorFromBody,
  responseBodySignals,
} from "./model-error-category";

describe("model error classification", () => {
  it.each([
    // DeepSeek's real answers.
    [{ status: 401, message: "Authentication Fails, Your api key: ****abcd is invalid", providerType: "authentication_error" }, "auth"],
    [{ status: 402, message: "Insufficient Balance", providerType: "unknown_error" }, "balance"],
    [{ status: 400, message: "Model Not Exist", providerType: "invalid_request_error" }, "model_not_found"],
    // OpenAI reports an empty account as 429 insufficient_quota, not as a rate limit.
    [{ status: 429, message: "You exceeded your current quota, please check your plan and billing details.", providerCode: "insufficient_quota" }, "balance"],
    [{ status: 429, message: "Rate limit reached for requests", providerCode: "rate_limit_exceeded" }, "rate_limited"],
    // OpenAI's free-tier rate limit links to the billing page; its code still says rate limit.
    [{ status: 429, providerCode: "rate_limit_exceeded", providerType: "requests", message: "Rate limit reached for gpt-4o-mini in organization org-x on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. Visit https://platform.openai.com/account/billing to add a payment method to increase your rate limit." }, "rate_limited"],
    [{ status: 429, providerType: "exceeded_current_quota_error", message: "Your account is suspended, please check your plan and billing details" }, "balance"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 404, message: "The model `gpt-9` does not exist or you do not have access to it.", providerCode: "model_not_found" }, "model_not_found"],
    // A 404 that names no model: the path is wrong.
    [{ status: 404 }, "bad_url"],
    [{ status: 404, message: "Not Found" }, "bad_url"],
    [{ status: 404, emptyBody: true }, "bad_url"],
    [{ status: 404, message: "Invalid URL (POST /v1/chat/completionsx)", providerType: "invalid_request_error" }, "bad_url"],
    [{ status: 404, nonJsonResponse: true }, "bad_url"],
    // vLLM and Ollama name the model.
    [{ status: 404, message: "The model `qwen-9` does not exist.", providerType: "NotFoundError" }, "model_not_found"],
    [{ status: 404, message: 'model "llama9" not found, try pulling it first' }, "model_not_found"],
    // Our own wrapper around a provider message must not read as a missing model.
    [{ status: 400, message: "Model request failed with HTTP 400: Unsupported parameter: temperature" }, "unknown"],
    [{ status: 404, message: "Model request failed with HTTP 404: Not Found" }, "bad_url"],
    [{ status: 405 }, "bad_url"],
    [{ status: 403, nonJsonResponse: true }, "bad_url"],
    // An empty 401/403 is still a refused key.
    [{ status: 401, emptyBody: true }, "auth"],
    [{ status: 403, emptyBody: true }, "auth"],
    [{ status: 403, message: "Country, region, or territory not supported", providerCode: "unsupported_country_region_territory" }, "network"],
    [{ status: 403 }, "auth"],
    [{ status: 500 }, "server"],
    [{ status: 503, providerCode: "model_overloaded" }, "server"],
    [{ status: 401, message: "余额不足，请充值" }, "balance"],
    [{ nonJsonResponse: true }, "bad_url"],
    [{ emptyBody: true }, "bad_url"],
    [{ status: 400, message: "Unsupported parameter: temperature" }, "unknown"],
    [{}, "unknown"],
  ] as const)("classifies %j as %s", (signals, expected) => {
    expect(classifyModelErrorSignals(signals)).toBe(expected);
  });

  it("maps connection failures from the network layer", () => {
    for (const category of ["dns", "timeout", "refused", "reset", "network_unreachable", "tls"] as const) {
      expect(classifyModelErrorSignals({ networkCategory: category, message: "connect failed" })).toBe("network");
      expect(modelCategoryForNetworkError(category)).toBe("network");
    }
    expect(classifyModelErrorSignals({ networkCategory: "proxy_failed" })).toBe("proxy");
    expect(classifyModelErrorSignals({ networkCategory: "proxy_auth" })).toBe("proxy");
    expect(classifyModelErrorSignals({ networkCategory: "unknown", message: "Invalid URL" })).toBe("bad_url");
    expect(classifyModelErrorSignals({ networkCategory: "unknown", message: "something odd" })).toBe("network");
    expect(modelCategoryForNetworkError("aborted")).toBeUndefined();
    expect(classifyModelErrorSignals({ networkCategory: "aborted" })).toBe("unknown");
  });

  it("blames the key, not the network, when it cannot go into a request header", () => {
    expect(classifyModelErrorSignals({ networkCategory: "unknown", message: 'Invalid character in header content ["Authorization"]' })).toBe("auth");
    expect(classifyModelErrorSignals({ message: "Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point." })).toBe("auth");
    expect(classifyModelErrorSignals({ message: "Invalid API key: it contains characters that cannot be sent in a request header (for example Chinese or full-width characters)." })).toBe("auth");
  });

  it("understands what Chromium's fetch says when the Agent cannot connect", () => {
    expect(classifyModelErrorSignals({ message: "Cannot connect to API: Failed to fetch" })).toBe("network");
    expect(classifyModelErrorSignals({ message: "net::ERR_PROXY_CONNECTION_FAILED" })).toBe("proxy");
    expect(classifyModelErrorSignals({ message: "Failed to parse URL from not a url/chat/completions" })).toBe("bad_url");
  });

  it("reads OpenAI-style error bodies and recognises non-JSON answers", () => {
    expect(providerErrorFromBody({ error: { message: "Insufficient Balance", type: "unknown_error", code: "invalid_request_error" } }))
      .toEqual({ message: "Insufficient Balance", providerType: "unknown_error", providerCode: "invalid_request_error" });
    expect(providerErrorFromBody(JSON.stringify({ error: { message: "Model Not Exist" } }))).toEqual({ message: "Model Not Exist" });
    expect(providerErrorFromBody({ error: "plain text error" })).toEqual({ message: "plain text error" });
    expect(providerErrorFromBody("<html>404</html>")).toEqual({});
    // vLLM-style top-level fields and FastAPI's "detail".
    expect(providerErrorFromBody({ object: "error", message: "The model `x` does not exist.", type: "NotFoundError", code: 404 }))
      .toEqual({ message: "The model `x` does not exist.", providerType: "NotFoundError" });
    expect(providerErrorFromBody({ detail: "Not Found" })).toEqual({ message: "Not Found" });
    expect(isNonJsonBody("<html>Not Found</html>")).toBe(true);
    // An empty body is told apart from a page: an empty 401 is a refused key, a page is a wrong address.
    expect(isNonJsonBody("")).toBe(false);
    expect(responseBodySignals("  ")).toEqual({ emptyBody: true });
    expect(responseBodySignals("<html></html>")).toEqual({ nonJsonResponse: true });
    expect(responseBodySignals("{}")).toEqual({});
    expect(responseBodySignals(undefined)).toEqual({});
    expect(isNonJsonBody("{\"error\":{}}")).toBe(false);
    expect(isNonJsonBody({ error: {} })).toBe(false);
    expect(isModelErrorCategory("balance")).toBe(true);
    expect(isModelErrorCategory("ok")).toBe(false);
  });
});
