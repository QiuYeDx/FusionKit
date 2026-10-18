import { afterEach, describe, expect, it } from "vitest";
import { sendModelRuntimeText } from "../../electron/main/ai/model-runtime-client";
import { ModelRuntimeClientError, modelErrorCategory } from "../../electron/main/ai/model-runtime-errors";
import { classifyTranslationError } from "../../electron/main/name-translation/translator";
import { providerError } from "../../electron/main/subtitle-studio/knowledge-trial";
import { closeAllServers, closedPort, startHttpServer } from "../network/local-servers";

async function failure(endpoint: string, apiFormat: "chat_completions" | "responses" = "chat_completions") {
  return sendModelRuntimeText({
    model: { apiKey: "sk-category-secret", modelKey: "m", endpoint, apiFormat },
    messages: [{ role: "user", content: "Hi" }],
    retry: { maxRetries: 0 },
    timeoutMs: 5_000,
  }).then(() => { throw new Error("expected a failure"); }, (error: unknown) => error as ModelRuntimeClientError);
}

async function answering(status: number, body: string, type = "application/json") {
  const server = await startHttpServer((_request, response) => {
    response.writeHead(status, { "Content-Type": type });
    response.end(body);
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

afterEach(() => closeAllServers());

describe("model runtime error categories", () => {
  it("keeps why a connection failed", async () => {
    for (const format of ["chat_completions", "responses"] as const) {
      const error = await failure(`http://127.0.0.1:${await closedPort()}/v1`, format);
      expect(error).toBeInstanceOf(ModelRuntimeClientError);
      expect(error.details.networkCategory).toBe("refused");
      expect(modelErrorCategory(error)).toBe("network");
    }
  });

  it("marks web pages and empty bodies as not coming from a model API", async () => {
    for (const format of ["chat_completions", "responses"] as const) {
      const notFound = await failure(await answering(404, "<html>Not Found</html>", "text/html"), format);
      expect(notFound.details).toMatchObject({ status: 404, nonJsonResponse: true });
      expect(modelErrorCategory(notFound)).toBe("bad_url");
      const page = await failure(await answering(200, "<!doctype html><title>Home</title>", "text/html"), format);
      expect(page).toMatchObject({ code: "invalid_response", details: { nonJsonResponse: true } });
      expect(modelErrorCategory(page)).toBe("bad_url");
    }
  });

  it("tells an empty refusal from a page and reads non-OpenAI error bodies", async () => {
    const empty = await failure(await answering(401, ""));
    expect(empty.details).toMatchObject({ status: 401, emptyBody: true });
    expect(empty.details).not.toHaveProperty("nonJsonResponse");
    expect(modelErrorCategory(empty)).toBe("auth");
    const fastApi = await failure(await answering(404, JSON.stringify({ detail: "Not Found" })));
    expect(fastApi.details.providerMessage).toBe("Not Found");
    expect(modelErrorCategory(fastApi)).toBe("bad_url");
    const vllm = await failure(await answering(404, JSON.stringify({ object: "error", message: "The model `m` does not exist.", type: "NotFoundError", code: 404 })));
    expect(vllm.message).toBe("Model request failed with HTTP 404: The model `m` does not exist.");
    expect(modelErrorCategory(vllm)).toBe("model_not_found");
  });

  it("reads an error a gateway sends with HTTP 200", async () => {
    for (const format of ["chat_completions", "responses"] as const) {
      const quota = await failure(await answering(200, JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } })), format);
      expect(quota).toMatchObject({ code: "invalid_response", retryable: false, details: { providerCode: "insufficient_quota", providerMessage: "You exceeded your current quota" } });
      expect(modelErrorCategory(quota)).toBe("balance");
      const key = await failure(await answering(200, JSON.stringify({ error: { message: "invalid api key", type: "invalid_api_key" } })), format);
      expect(modelErrorCategory(key)).toBe("auth");
    }
    // A Responses request answered by something that is not a Responses API.
    const other = await failure(await answering(200, JSON.stringify({ status: "ok" })), "responses");
    expect(other).toMatchObject({ code: "invalid_response" });
    expect(modelErrorCategory(other)).toBe("unknown");
  });

  it("reports a key pasted with characters a header cannot carry as a key problem, without a request", async () => {
    let requests = 0;
    const server = await startHttpServer((_request, response) => { requests += 1; response.writeHead(200); response.end("{}"); });
    for (const format of ["chat_completions", "responses"] as const) {
      const error = await sendModelRuntimeText({
        model: { apiKey: "密钥：sk-abc", modelKey: "m", endpoint: `http://127.0.0.1:${server.port}/v1`, apiFormat: format },
        messages: [{ role: "user", content: "Hi" }],
        timeoutMs: 5_000,
      }).then(() => { throw new Error("expected a failure"); }, (failure: unknown) => failure as ModelRuntimeClientError);
      expect(error).toMatchObject({ code: "http_unauthorized", retryable: false });
      expect(error.message).not.toContain("sk-abc");
      expect(modelErrorCategory(error)).toBe("auth");
    }
    expect(requests).toBe(0);
  });

  it("reads the provider's answer for keys, balance and model names", async () => {
    const balance = await failure(await answering(402, JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } })));
    expect(balance.details).not.toHaveProperty("nonJsonResponse");
    expect(modelErrorCategory(balance)).toBe("balance");
    expect(modelErrorCategory(await failure(await answering(401, JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }))))).toBe("auth");
    expect(modelErrorCategory(await failure(await answering(400, JSON.stringify({ error: { message: "Model Not Exist" } }))))).toBe("model_not_found");
  });

  it("leaves cancelled requests and foreign errors unclassified", () => {
    expect(modelErrorCategory(new ModelRuntimeClientError("aborted", "Model request was aborted.", false))).toBe("unknown");
    expect(modelErrorCategory(new Error("boom"))).toBe("unknown");
    expect(modelErrorCategory(new ModelRuntimeClientError("request_timeout", "Model request timed out.", true))).toBe("network");
  });

  it("passes the category on to the name translator and Subtitle Studio", () => {
    // The adapters mark an empty account as not retryable; it stops the run.
    const quota = new ModelRuntimeClientError("http_non_retryable", "Model request failed with HTTP 429: You exceeded your current quota", false, { status: 429, providerCode: "insufficient_quota" });
    expect(classifyTranslationError(quota)).toMatchObject({ code: "model_quota", category: "balance" });
    expect(classifyTranslationError(new ModelRuntimeClientError("http_non_retryable", "Model request failed with HTTP 402: Insufficient Balance", false, { status: 402, providerMessage: "Insufficient Balance" })))
      .toMatchObject({ code: "model_quota", category: "balance" });
    // A rate limit whose message links to the billing page is retried, not a stop for an empty account.
    const rateLimit = new ModelRuntimeClientError("http_rate_limited", "Model request failed with HTTP 429: Rate limit reached", true, {
      status: 429, providerCode: "rate_limit_exceeded",
      providerMessage: "Rate limit reached for requests. Please try again in 20s. Visit https://platform.openai.com/account/billing to add a payment method.",
    });
    expect(classifyTranslationError(rateLimit)).toMatchObject({ code: "model_failed", category: "rate_limited" });
    const auth = new ModelRuntimeClientError("http_unauthorized", "Model request failed with HTTP 401.", false, { status: 401 });
    expect(classifyTranslationError(auth)).toMatchObject({ code: "model_auth", category: "auth" });
    // A 404 keeps the tool's own code; the advice follows what the answer says.
    expect(classifyTranslationError(new ModelRuntimeClientError("http_non_retryable", "HTTP 404", false, { status: 404 }))).toMatchObject({ code: "model_not_found", category: "bad_url" });
    expect(classifyTranslationError(new ModelRuntimeClientError("http_non_retryable", "Model request failed with HTTP 404: The model `m` does not exist.", false, { status: 404, providerMessage: "The model `m` does not exist." })))
      .toMatchObject({ code: "model_not_found", category: "model_not_found" });
    expect(classifyTranslationError(new ModelRuntimeClientError("aborted", "aborted", false))).toEqual({ code: "cancelled", message: "Translation was cancelled." });
    expect(classifyTranslationError(new Error("odd"))).not.toHaveProperty("category");

    expect(providerError(auth)).toMatchObject({ code: "needs_configuration", category: "auth" });
    expect(providerError(new ModelRuntimeClientError("network_error", "socket hang up", true, { networkCategory: "reset" }))).toMatchObject({ code: "translation_failed", category: "network" });
    expect(providerError(new ModelRuntimeClientError("invalid_response", "Model response is not an object.", true, { nonJsonResponse: true }))).toMatchObject({ code: "translation_protocol_invalid", category: "bad_url" });
    expect(providerError(new ModelRuntimeClientError("length_truncated", "cut", false)).category).toBeUndefined();
    expect(providerError(new Error("boom"))).toMatchObject({ code: "translation_failed" });
    expect(providerError(new Error("boom")).category).toBeUndefined();
  });
});
