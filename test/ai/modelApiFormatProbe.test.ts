import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChatCompletionBody,
  createErrorBody,
  createModelsBody,
  createResponsesBody,
  startFakeModelApiServer,
  type FakeModelApiServer,
} from "./fakeModelApiServer";

describe("PRE-001 fake model API server", () => {
  let server: FakeModelApiServer | undefined;

  beforeEach(async () => {
    server = await startFakeModelApiServer();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("captures Chat Completions requests and returns OpenAI-style usage", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({
        content: "Translated text",
        reasoningContent: "hidden reasoning",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    });

    const response = await postJson(activeServer.chatCompletionsUrl, {
      model: "fusionkit-fake-chat-model",
      messages: [{ role: "user", content: "Translate" }],
      max_tokens: 4096,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Translated text",
            reasoning_content: "hidden reasoning",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
    expect(activeServer.requests).toHaveLength(1);
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      route: "chat_completions",
      body: {
        model: "fusionkit-fake-chat-model",
        max_tokens: 4096,
      },
    });
    expect(activeServer.requests[0].headers.authorization).toBe(
      "Bearer fusionkit-test-key",
    );
  });

  it("captures Responses requests with store:false and max_output_tokens", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Responses translation",
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    });

    const response = await postJson(activeServer.responsesUrl, {
      model: "fusionkit-fake-responses-model",
      instructions: "Translate faithfully.",
      input: "Source text",
      max_output_tokens: 4096,
      store: false,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "Responses translation",
      usage: {
        input_tokens: 13,
        output_tokens: 5,
        total_tokens: 18,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/responses",
      route: "responses",
      body: {
        model: "fusionkit-fake-responses-model",
        instructions: "Translate faithfully.",
        input: "Source text",
        max_output_tokens: 4096,
        store: false,
      },
    });
  });

  it("can fixture Responses output[] fallback without output_text", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Output array text",
        includeOutputText: false,
      }),
    });

    const response = await postJson(activeServer.responsesUrl, {
      model: "fusionkit-fake-responses-model",
      input: "Source text",
      store: false,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output_text).toBeUndefined();
    expect(body.output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Output array text",
        },
      ],
    });
  });

  it("can fixture Responses incomplete output-token truncation", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "Partial text",
        status: "incomplete",
        incompleteReason: "max_output_tokens",
      }),
    });

    const response = await postJson(activeServer.responsesUrl, {
      model: "fusionkit-fake-responses-model",
      input: "Source text",
      max_output_tokens: 8,
      store: false,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
  });

  it("returns model list fixtures from /models", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("models", {
      body: createModelsBody({
        ids: ["gpt-fusionkit-main", "gpt-fusionkit-mini"],
      }),
    });

    const response = await fetch(activeServer.modelsUrl, {
      headers: { Authorization: "Bearer fusionkit-test-key" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "list",
      data: [
        { id: "gpt-fusionkit-main", object: "model" },
        { id: "gpt-fusionkit-mini", object: "model" },
      ],
    });
    expect(activeServer.requests[0]).toMatchObject({
      method: "GET",
      url: "/v1/models",
      route: "models",
      body: {},
    });
  });

  it("returns OpenAI-style route errors for unexpected endpoints", async () => {
    const activeServer = requireServer(server);

    const response = await fetch(`${activeServer.baseUrl}/unknown`, {
      method: "POST",
      body: JSON.stringify({ model: "fusionkit-fake-model" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "route_not_found",
      },
    });
    expect(activeServer.requests[0]).toMatchObject({
      route: "unknown",
      url: "/v1/unknown",
    });
  });

  it("preserves queued HTTP error status and Retry-After headers", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueueRoute("chat_completions", {
      status: 429,
      headers: { "Retry-After": "2" },
      body: createErrorBody("slow down", "rate_limit_exceeded"),
    });

    const response = await postJson(activeServer.chatCompletionsUrl, {
      model: "fusionkit-fake-chat-model",
      messages: [{ role: "user", content: "Translate" }],
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "slow down",
        code: "rate_limit_exceeded",
      },
    });
  });
});

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer fusionkit-test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function requireServer(
  server: FakeModelApiServer | undefined,
): FakeModelApiServer {
  if (!server) throw new Error("Fake model API server is not running");
  return server;
}
