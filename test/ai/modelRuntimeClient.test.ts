import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendModelRuntimeText } from "../../electron/main/ai/model-runtime-client";
import { ModelRuntimeClientError } from "../../electron/main/ai/model-runtime-errors";
import {
  createChatCompletionBody,
  createErrorBody,
  createResponsesBody,
  startFakeModelApiServer,
  type FakeModelApiServer,
} from "./fakeModelApiServer";

describe("ModelRuntimeClient Chat Completions adapter", () => {
  let server: FakeModelApiServer | undefined;

  beforeEach(async () => {
    server = await startFakeModelApiServer();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends Chat Completions text requests through the normalized runtime path", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({
        content: "<think>scratch</think>\nTranslated text",
        reasoningContent: "reasoning side channel",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          completion_tokens_details: { reasoning_tokens: 3 },
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
    });

    const result = await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-chat-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "chat_completions",
        outputTokenParameter: "max_completion_tokens",
      },
      messages: [{ role: "user", content: "Translate" }],
      maxOutputTokens: 2048,
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      content: "Translated text",
      reasoningContent: "reasoning side channel",
      apiFormat: "chat_completions",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reasoningTokens: 3,
        cachedInputTokens: 4,
      },
    });
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "fake-chat-model",
        max_completion_tokens: 2048,
      },
    });
    expect(activeServer.requests[0].body).not.toHaveProperty("max_tokens");
    expect(activeServer.requests[0].body).not.toHaveProperty("thinking");
    expect(activeServer.requests[0].headers.authorization).toBe(
      "Bearer sk-runtime-secret",
    );
  });

  it("sends explicit DeepSeek thinking enable and disable controls", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "Disabled" }),
    });
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "Enabled" }),
    });

    for (const thinkingEnabled of [false, true]) {
      await sendModelRuntimeText({
        model: {
          apiKey: "sk-runtime-secret",
          modelKey: "deepseek-v4-flash",
          endpoint: activeServer.baseUrl,
          apiFormat: "chat_completions",
          outputTokenParameter: "max_tokens",
          thinkingEnabled,
        },
        messages: [{ role: "user", content: "Translate" }],
        retry: { maxRetries: 0 },
      });
    }

    expect(activeServer.requests[0].body).toMatchObject({
      thinking: { type: "disabled" },
    });
    expect(activeServer.requests[1].body).toMatchObject({
      thinking: { type: "enabled" },
    });
  });

  it("omits DeepSeek thinking controls for non-DeepSeek models", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "Translated" }),
    });

    await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "gpt-compatible",
        endpoint: activeServer.baseUrl,
        apiFormat: "chat_completions",
        outputTokenParameter: "max_tokens",
        thinkingEnabled: true,
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 0 },
    });

    expect(activeServer.requests[0].body).not.toHaveProperty("thinking");
  });

  it("keeps historical full chat endpoint inputs compatible", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "Endpoint ok" }),
    });

    await expect(
      sendModelRuntimeText({
        model: {
          apiKey: "sk-runtime-secret",
          modelKey: "fake-chat-model",
          endpoint: activeServer.chatCompletionsUrl,
          apiFormat: "chat_completions",
          outputTokenParameter: "max_tokens",
        },
        messages: [{ role: "user", content: "Translate" }],
        maxOutputTokens: 1024,
        retry: { maxRetries: 0 },
      }),
    ).resolves.toMatchObject({
      content: "Endpoint ok",
      apiFormat: "chat_completions",
    });

    expect(activeServer.requests[0]).toMatchObject({
      url: "/v1/chat/completions",
      body: {
        max_tokens: 1024,
      },
    });
    expect(activeServer.requests[0].body).not.toHaveProperty(
      "max_completion_tokens",
    );
  });

  it("retains Chat Completions usage when the response is truncated", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({
        content: "Partial",
        finishReason: "length",
        usage: {
          prompt_tokens: 9,
          completion_tokens: 6,
          total_tokens: 15,
        },
      }),
    });

    await expect(sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-chat-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "chat_completions",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 0 },
    })).rejects.toMatchObject({
      code: "length_truncated",
      details: {
        usage: {
          inputTokens: 9,
          outputTokens: 6,
          totalTokens: 15,
        },
      },
    });
  });

  it("sends Responses text requests with store disabled and parses output_text", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Responses translation",
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
          output_tokens_details: { reasoning_tokens: 2 },
          input_tokens_details: { cached_tokens: 6 },
        },
      }),
    });

    const result = await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-responses-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "responses",
      },
      messages: [
        { role: "system", content: "Translate faithfully." },
        { role: "user", content: "Source text" },
      ],
      maxOutputTokens: 4096,
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      content: "Responses translation",
      apiFormat: "responses",
      rawStatus: "completed",
      usage: {
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        reasoningTokens: 2,
        cachedInputTokens: 6,
      },
    });
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/responses",
      body: {
        model: "fake-responses-model",
        instructions: "Translate faithfully.",
        input: "Source text",
        max_output_tokens: 4096,
        store: false,
      },
    });
  });

  it("falls back to Responses output array content", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Output array translation",
        includeOutputText: false,
      }),
    });

    await expect(
      sendModelRuntimeText({
        model: {
          apiKey: "sk-runtime-secret",
          modelKey: "fake-responses-model",
          endpoint: activeServer.responsesUrl,
          apiFormat: "responses",
        },
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Second" },
          { role: "user", content: "Third" },
        ],
        retry: { maxRetries: 0 },
      }),
    ).resolves.toMatchObject({
      content: "Output array translation",
      apiFormat: "responses",
    });

    expect(activeServer.requests[0]).toMatchObject({
      url: "/v1/responses",
      body: {
        input: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Second" },
          { role: "user", content: "Third" },
        ],
        store: false,
      },
    });
  });

  it("maps Responses incomplete max_output_tokens to length_truncated", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Partial",
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        usage: {
          input_tokens: 14,
          output_tokens: 8,
          total_tokens: 22,
        },
      }),
    });

    await expect(
      sendModelRuntimeText({
        model: {
          apiKey: "sk-runtime-secret",
          modelKey: "fake-responses-model",
          endpoint: activeServer.baseUrl,
          apiFormat: "responses",
        },
        messages: [{ role: "user", content: "Translate" }],
        retry: { maxRetries: 2, baseDelayMs: 1, jitterRatio: 0 },
      }),
    ).rejects.toMatchObject({
      code: "length_truncated",
      retryable: false,
      details: {
        usage: {
          inputTokens: 14,
          outputTokens: 8,
          totalTokens: 22,
        },
      },
    });
    expect(activeServer.requests).toHaveLength(1);
  });

  it("retries Responses rate limits and respects Retry-After", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      status: 429,
      headers: { "Retry-After": "0" },
      body: createErrorBody("slow down", "rate_limit_exceeded"),
    });
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({ outputText: "Recovered response" }),
    });

    const result = await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-responses-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "responses",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.content).toBe("Recovered response");
    expect(activeServer.requests).toHaveLength(2);
  });

  it("does not retry permanent quota failures reported with HTTP 429", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      status: 429,
      body: createErrorBody(
        "quota exhausted",
        "insufficient_quota",
        "insufficient_quota",
      ),
    });

    await expect(sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-responses-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "responses",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 3, baseDelayMs: 1, jitterRatio: 0 },
    })).rejects.toMatchObject({
      code: "http_non_retryable",
      retryable: false,
      details: { providerCode: "insufficient_quota" },
    });
    expect(activeServer.requests).toHaveLength(1);
  });

  it("retries transient Responses failed envelopes returned with HTTP 200", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: {
        ...createResponsesBody({ status: "failed" }),
        error: {
          message: "provider is temporarily unavailable",
          code: "server_error",
          type: "server_error",
        },
      },
    });
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({ outputText: "Recovered response" }),
    });

    const result = await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-responses-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "responses",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.content).toBe("Recovered response");
    expect(activeServer.requests).toHaveLength(2);
  });

  it("fails fast for permanent Responses failed envelopes", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: {
        ...createResponsesBody({ status: "failed" }),
        error: {
          message: "unsupported request field",
          code: "unsupported_value",
          type: "invalid_request_error",
        },
      },
    });

    await expect(sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-responses-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "responses",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 3, baseDelayMs: 1, jitterRatio: 0 },
    })).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
      details: {
        providerCode: "unsupported_value",
        providerType: "invalid_request_error",
      },
    });
    expect(activeServer.requests).toHaveLength(1);
  });

  it("recovers when a compatible gateway reports a transient body with HTTP 400", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      status: 400,
      body: createErrorBody(
        "upstream provider is unavailable",
        "server_error",
        "server_error",
      ),
    });
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "Recovered chat response" }),
    });

    const result = await sendModelRuntimeText({
      model: {
        apiKey: "sk-runtime-secret",
        modelKey: "fake-chat-model",
        endpoint: activeServer.baseUrl,
        apiFormat: "chat_completions",
      },
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.content).toBe("Recovered chat response");
    expect(activeServer.requests).toHaveLength(2);
  });

  it("keeps API keys redacted in runtime HTTP errors", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      status: 401,
      body: {
        error: {
          message: "bad key sk-runtime-secret",
        },
      },
    });

    let error: unknown;
    try {
      await sendModelRuntimeText({
        model: {
          apiKey: "sk-runtime-secret",
          modelKey: "fake-chat-model",
          endpoint: activeServer.baseUrl,
          apiFormat: "chat_completions",
        },
        messages: [{ role: "user", content: "Translate" }],
        retry: { maxRetries: 0 },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ModelRuntimeClientError);
    expect(error).toMatchObject({
      code: "http_unauthorized",
      retryable: false,
    });
    expect((error as Error).message).not.toContain("sk-runtime-secret");
  });
});

function requireServer(
  server: FakeModelApiServer | undefined,
): FakeModelApiServer {
  if (!server) {
    throw new Error("Fake model API server is not available");
  }
  return server;
}
