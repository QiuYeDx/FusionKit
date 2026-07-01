import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createChatCompletionBody,
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "./fakeOpenAICompatibleServer";
import {
  buildPlaceholderRetryInstruction,
  createSequentialProtocolMarkers,
  formatSequentialResponse,
  parsePlainTranslationResponse,
  parseSequentialTranslationResponse,
  parseStructuredSequentialJson,
  TranslationProtocolError,
  validatePlaceholders,
} from "./modelResponseProtocolProbe";

describe("PRE-003 fake OpenAI Compatible transport", () => {
  let server: FakeOpenAICompatibleServer | undefined;

  beforeEach(async () => {
    server = await startFakeOpenAICompatibleServer();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("round-trips an OpenAI-style response with usage through the installed AI SDK", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueue({
      body: createChatCompletionBody({
        content: "译文",
        usage: {
          prompt_tokens: 17,
          completion_tokens: 5,
          total_tokens: 22,
        },
      }),
    });

    const result = await requestFakeModel(activeServer, "translate");

    expect(result.text).toBe("译文");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({
      inputTokens: 17,
      outputTokens: 5,
      totalTokens: 22,
    });
    expect(activeServer.requests).toHaveLength(1);
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
    });
    expect(activeServer.requests[0].headers.authorization).toBe(
      "Bearer fusionkit-test-key",
    );
    expect(activeServer.requests[0].body).toMatchObject({
      model: "fusionkit-fake-model",
    });
    expect(activeServer.requests[0].body).not.toHaveProperty("stream");
  });

  it("accepts DeepSeek-style reasoning_content and missing usage", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueue({
      body: createChatCompletionBody({
        content: "只保留正文",
        reasoningContent: "这里是独立的推理字段",
      }),
    });

    const result = await requestFakeModel(activeServer, "translate");

    expect(result.text).toBe("只保留正文");
    expect(result.reasoningText).toBe("这里是独立的推理字段");
    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.outputTokens).toBeUndefined();
    expect(result.usage.totalTokens).toBeUndefined();
  });

  it("proves response_format is not a safe baseline while marker text still works", async () => {
    const activeServer = requireServer(server);
    activeServer.enqueue((request) => {
      expect(request.body.response_format).toBeDefined();
      return {
        status: 400,
        body: {
          error: {
            message: "response_format is not supported by this provider",
            type: "invalid_request_error",
            code: "unsupported_response_format",
          },
        },
      };
    });
    activeServer.enqueue({
      body: createChatCompletionBody({
        content: formatSequentialResponse("seg_0001", "译文", {
          currentSceneSummary: "场景继续发生在车站。",
        }),
      }),
    });

    const provider = createFakeProvider(activeServer);
    await expect(
      generateText({
        model: provider.chatModel("fusionkit-fake-model"),
        prompt: "return structured data",
        output: Output.object({
          schema: z.object({
            translatedText: z.string(),
            memoryPatch: z.object({}).passthrough(),
          }),
        }),
        maxRetries: 0,
      }),
    ).rejects.toThrow(/response_format is not supported/i);

    const markerResult = await generateText({
      model: provider.chatModel("fusionkit-fake-model"),
      prompt: "return marker protocol",
      maxRetries: 0,
    });
    const parsed = parseSequentialTranslationResponse(
      {
        text: markerResult.text,
        finishReason: markerResult.finishReason,
      },
      "seg_0001",
    );

    expect(parsed.translatedText).toBe("译文");
    expect(parsed.memoryPatch).toEqual({
      currentSceneSummary: "场景继续发生在车站。",
    });
  });
});

describe("PRE-003 translation response protocol", () => {
  it("cleans leading think blocks for ordinary translation responses", () => {
    const parsed = parsePlainTranslationResponse({
      text: "<think>reasoning must not leak</think>\n真正的译文",
      finishReason: "stop",
    });

    expect(parsed).toEqual({
      translatedText: "真正的译文",
      warnings: [],
      usage: undefined,
    });
  });

  it("parses a valid sequential marker envelope and bounded memory patch", () => {
    const text = formatSequentialResponse(
      "segment-42",
      "爱丽丝握住了⟦FKP:segment-42:0001⟧。",
      {
        characterUpserts: [
          {
            sourceName: "Alice",
            translatedName: "爱丽丝",
          },
        ],
        recentContinuityNotesToAdd: ["爱丽丝仍然拿着钥匙。"],
      },
    );

    const parsed = parseSequentialTranslationResponse(
      {
        text,
        finishReason: "stop",
        expectedPlaceholders: ["⟦FKP:segment-42:0001⟧"],
      },
      "segment-42",
    );

    expect(parsed.memoryUpdated).toBe(true);
    expect(parsed.memoryPatch?.characterUpserts?.[0].translatedName).toBe(
      "爱丽丝",
    );
    expect(parsed.translatedText).toContain("⟦FKP:segment-42:0001⟧");
  });

  it("keeps valid translated text but refuses an invalid memory patch", () => {
    const markers = createSequentialProtocolMarkers("segment-43");
    const text = [
      markers.translation,
      "这部分译文仍然有效。",
      markers.memoryPatch,
      '{"version":999,"terminologyUpserts":"not-an-array"}',
      markers.end,
    ].join("\n");

    const parsed = parseSequentialTranslationResponse(
      { text, finishReason: "stop" },
      "segment-43",
    );

    expect(parsed.translatedText).toBe("这部分译文仍然有效。");
    expect(parsed.memoryUpdated).toBe(false);
    expect(parsed.memoryPatch).toBeUndefined();
    expect(parsed.warnings).toEqual([
      "memory_patch_invalid:schema_validation_failed",
    ]);
  });

  it("shows why one strict JSON object cannot preserve translation on an invalid patch", () => {
    const text = JSON.stringify({
      translatedText: "这部分译文原本有效。",
      memoryPatch: {
        version: 999,
      },
    });

    expect(() =>
      parseStructuredSequentialJson({ text, finishReason: "stop" }),
    ).toThrowError(
      expect.objectContaining({
        code: "structured_response_invalid",
        retryable: true,
      }),
    );
  });

  it("treats finish_reason=length as a retryable truncation", () => {
    expect(() =>
      parsePlainTranslationResponse({
        text: "被截断的译文",
        finishReason: "length",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "response_truncated",
        retryable: true,
      }),
    );
  });

  it("rejects missing, duplicated, unknown, and reordered placeholders", () => {
    const expected = ["⟦FKP:seg:0001⟧", "⟦FKP:seg:0002⟧"];

    expect(validatePlaceholders("a", expected)).toContain(
      "missing:⟦FKP:seg:0001⟧",
    );
    expect(
      validatePlaceholders(
        "⟦FKP:seg:0001⟧ ⟦FKP:seg:0001⟧ ⟦FKP:alien:9⟧",
        expected,
      ),
    ).toEqual(
      expect.arrayContaining([
        "duplicate:⟦FKP:seg:0001⟧",
        "missing:⟦FKP:seg:0002⟧",
        "unknown:⟦FKP:alien:9⟧",
      ]),
    );
    expect(
      validatePlaceholders(
        "⟦FKP:seg:0002⟧ then ⟦FKP:seg:0001⟧",
        expected,
      ),
    ).toContain("out_of_order");
  });

  it("returns an exact strengthened retry instruction for placeholder failures", () => {
    const expected = ["⟦FKP:seg:0001⟧"];

    expect(() =>
      parsePlainTranslationResponse({
        text: "模型擅自删除了占位符",
        expectedPlaceholders: expected,
      }),
    ).toThrowError(TranslationProtocolError);

    try {
      parsePlainTranslationResponse({
        text: "模型擅自删除了占位符",
        expectedPlaceholders: expected,
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "placeholder_mismatch",
        retryable: true,
        retryInstruction: buildPlaceholderRetryInstruction(expected),
      });
    }
  });

  it("rejects missing, duplicated, or out-of-order sequential markers", () => {
    const markers = createSequentialProtocolMarkers("segment-44");
    const malformed = [
      markers.memoryPatch,
      "{}",
      markers.translation,
      "译文",
      markers.end,
    ].join("\n");

    expect(() =>
      parseSequentialTranslationResponse(
        { text: malformed, finishReason: "stop" },
        "segment-44",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "sequential_boundary_invalid",
        retryable: true,
      }),
    );
  });
});

function createFakeProvider(server: FakeOpenAICompatibleServer) {
  return createOpenAICompatible({
    baseURL: server.baseUrl,
    apiKey: "fusionkit-test-key",
    name: "fusionkit-pre-003",
  });
}

async function requestFakeModel(
  server: FakeOpenAICompatibleServer,
  prompt: string,
) {
  const provider = createFakeProvider(server);
  return generateText({
    model: provider.chatModel("fusionkit-fake-model"),
    prompt,
    maxRetries: 0,
  });
}

function requireServer(
  server: FakeOpenAICompatibleServer | undefined,
): FakeOpenAICompatibleServer {
  if (!server) throw new Error("Fake OpenAI server is not running");
  return server;
}
