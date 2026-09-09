import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChatCompletionBody } from "../../electron/main/ai/adapters/chat-completions-adapter";
import { buildResponsesBody } from "../../electron/main/ai/adapters/responses-adapter";
import {
  sendModelRuntimeText,
  type ModelRuntimeTextRequest,
} from "../../electron/main/ai/model-runtime-client";
import {
  createChatCompletionBody,
  createResponsesBody,
  startFakeModelApiServer,
  type FakeModelApiServer,
} from "./fakeModelApiServer";

describe.each(["chat_completions", "responses"] as const)(
  "Model runtime %s response limits",
  (apiFormat) => {
    let server: FakeModelApiServer;

    beforeEach(async () => {
      server = await startFakeModelApiServer();
    });

    afterEach(async () => {
      await server?.close();
    });

    function request(): ModelRuntimeTextRequest {
      return {
        model: {
          apiKey: "runtime-limit-test-key",
          modelKey: "fake-model",
          endpoint: server.baseUrl,
          apiFormat,
          outputTokenParameter: "max_completion_tokens",
        },
        messages: [
          { role: "system", content: "Return a JSON translation." },
          { role: "user", content: '{"items":[{"id":"u1","text":"Hello"}]}' },
        ],
        responseFormat: "json_object",
        maxOutputTokens: 1024,
        temperature: 0.2,
        proxy: false,
        retry: { maxRetries: 0 },
      };
    }

    function responseBody(content: string): Record<string, unknown> {
      return apiFormat === "chat_completions"
        ? createChatCompletionBody({ content })
        : createResponsesBody({ outputText: content });
    }

    function buildBody(value: ModelRuntimeTextRequest): Record<string, unknown> {
      return apiFormat === "chat_completions"
        ? buildChatCompletionBody(value)
        : buildResponsesBody(value);
    }

    it("exports the exact default body sent over HTTP without transport fields", async () => {
      const value = request();
      const expected = apiFormat === "chat_completions"
        ? {
            model: "fake-model",
            messages: value.messages,
            temperature: 0.2,
            max_completion_tokens: 1024,
            response_format: { type: "json_object" },
          }
        : {
            model: "fake-model",
            instructions: value.messages[0].content,
            input: value.messages[1].content,
            store: false,
            temperature: 0.2,
            max_output_tokens: 1024,
            text: { format: { type: "json_object" } },
          };
      expect(buildBody(value)).toEqual(expected);
      expect(buildBody({ ...value, maxResponseBytes: 4096 })).toEqual(expected);
      server.enqueueRoute(apiFormat, { body: responseBody("Translated") });

      await expect(sendModelRuntimeText(value)).resolves.toMatchObject({
        content: "Translated",
      });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].body).toEqual(expected);
    });

    it("keeps the existing unlimited response behavior when no limit is provided", async () => {
      const content = "x".repeat(32_768);
      server.enqueueRoute(apiFormat, { body: responseBody(content) });

      await expect(sendModelRuntimeText(request())).resolves.toMatchObject({ content });
      expect(server.requests).toHaveLength(1);
    });

    it("rejects oversized response bytes and accepts the exact byte boundary", async () => {
      const content = "\u6f22".repeat(128);
      const body = responseBody(content);
      const serialized = JSON.stringify(body);
      const byteLength = Buffer.byteLength(serialized, "utf8");
      expect(byteLength).toBeGreaterThan(serialized.length);
      server.enqueueRoute(apiFormat, { body });

      await expect(sendModelRuntimeText({
        ...request(),
        maxResponseBytes: byteLength - 1,
      })).rejects.toMatchObject({
        code: "network_error",
        message: expect.stringContaining("maxContentLength"),
      });
      expect(server.requests).toHaveLength(1);

      server.enqueueRoute(apiFormat, { body });
      await expect(sendModelRuntimeText({
        ...request(),
        maxResponseBytes: byteLength,
      })).resolves.toMatchObject({ content });
      expect(server.requests).toHaveLength(2);
    });

    it("does not apply the response limit to the outgoing request body", async () => {
      const value = request();
      value.messages[1].content = "x".repeat(4096);
      const body = responseBody("OK");
      const maxResponseBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
      expect(Buffer.byteLength(JSON.stringify(buildBody(value)), "utf8"))
        .toBeGreaterThan(maxResponseBytes);
      server.enqueueRoute(apiFormat, { body });

      await expect(sendModelRuntimeText({ ...value, maxResponseBytes }))
        .resolves.toMatchObject({ content: "OK" });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].body).toEqual(buildBody(value));
    });
  },
);
