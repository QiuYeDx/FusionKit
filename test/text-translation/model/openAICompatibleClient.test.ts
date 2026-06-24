import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpenAICompatibleClientError,
  cleanThinkTags,
  sendOpenAICompatibleChatCompletion,
} from "../../../electron/main/ai/openai-compatible-client";
import {
  createChatCompletionBody,
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "../protocol/fakeOpenAICompatibleServer";

describe("OpenAI Compatible client", () => {
  let server: FakeOpenAICompatibleServer;

  beforeEach(async () => {
    server = await startFakeOpenAICompatibleServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("sends chat completions with authorization and parses usage", async () => {
    server.enqueue({
      body: createChatCompletionBody({
        content: "<think>hidden reasoning</think>\nTranslated text",
        reasoningContent: "reasoning side channel",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    });

    const result = await sendOpenAICompatibleChatCompletion({
      endpoint: server.baseUrl,
      apiKey: "sk-test-secret",
      model: "fake-model",
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 0 },
    });

    expect(result.content).toBe("Translated text");
    expect(result.reasoningContent).toBe("reasoning side channel");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 3,
    });
    expect(server.requests[0].headers.authorization).toBe(
      "Bearer sk-test-secret",
    );
    expect(server.requests[0].body).toMatchObject({
      model: "fake-model",
    });
  });

  it("retries 429 responses and respects Retry-After", async () => {
    server.enqueue({
      status: 429,
      headers: { "Retry-After": "0" },
      body: { error: { message: "slow down" } },
    });
    server.enqueue({
      body: createChatCompletionBody({ content: "Recovered" }),
    });

    const result = await sendOpenAICompatibleChatCompletion({
      endpoint: server.baseUrl,
      apiKey: "sk-test-secret",
      model: "fake-model",
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.content).toBe("Recovered");
    expect(server.requests).toHaveLength(2);
  });

  it("does not retry unauthorized responses and keeps API keys out of errors", async () => {
    server.enqueue({
      status: 401,
      body: { error: { message: "bad key sk-test-secret" } },
    });

    let error: unknown;
    try {
      await sendOpenAICompatibleChatCompletion({
        endpoint: server.baseUrl,
        apiKey: "sk-test-secret",
        model: "fake-model",
        messages: [{ role: "user", content: "Translate" }],
        retry: { maxRetries: 2, baseDelayMs: 1, jitterRatio: 0 },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "http_unauthorized",
      retryable: false,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("sk-test-secret");

    expect(server.requests).toHaveLength(1);
  });

  it("retries empty content and truncated finish reasons", async () => {
    server.enqueue({
      body: createChatCompletionBody({ content: "" }),
    });
    server.enqueue({
      body: createChatCompletionBody({
        content: "cut off",
        finishReason: "length",
      }),
    });
    server.enqueue({
      body: createChatCompletionBody({ content: "Final translation" }),
    });

    const result = await sendOpenAICompatibleChatCompletion({
      endpoint: server.baseUrl,
      apiKey: "sk-test-secret",
      model: "fake-model",
      messages: [{ role: "user", content: "Translate" }],
      retry: { maxRetries: 2, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.content).toBe("Final translation");
    expect(server.requests).toHaveLength(3);
  });

  it("classifies aborts as non-retryable", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      sendOpenAICompatibleChatCompletion({
        endpoint: server.baseUrl,
        apiKey: "sk-test-secret",
        model: "fake-model",
        messages: [{ role: "user", content: "Translate" }],
        signal: controller.signal,
        retry: { maxRetries: 2, baseDelayMs: 1, jitterRatio: 0 },
      }),
    ).rejects.toMatchObject({
      code: "aborted",
      retryable: false,
    });

    expect(server.requests).toHaveLength(0);
  });

  it("cleans leading think tags without touching normal text", () => {
    expect(cleanThinkTags("<think>draft</think>\nVisible")).toBe("Visible");
    expect(cleanThinkTags("Already visible")).toBe("Already visible");
  });

  it("surfaces timeout as a retryable client error", async () => {
    server.enqueue(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              body: createChatCompletionBody({ content: "late" }),
            });
          }, 50);
        }),
    );

    await expect(
      sendOpenAICompatibleChatCompletion({
        endpoint: server.baseUrl,
        apiKey: "sk-test-secret",
        model: "fake-model",
        messages: [{ role: "user", content: "Translate" }],
        timeoutMs: 5,
        retry: { maxRetries: 0 },
      }),
    ).rejects.toBeInstanceOf(OpenAICompatibleClientError);
  });
});
