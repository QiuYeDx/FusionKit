import { describe, expect, it } from "vitest";
import { createSubtitleTaskModelFields } from "./task-model-config";

describe("agent task model config", () => {
  it("copies Responses API metadata into subtitle tasks", () => {
    expect(
      createSubtitleTaskModelFields({
        apiKey: "sk-test",
        modelKey: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
        apiFormat: "responses",
        outputTokenParameter: "max_completion_tokens",
      }),
    ).toEqual({
      apiKey: "sk-test",
      apiModel: "gpt-5",
      endPoint: "https://api.openai.com/v1",
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
    });
  });

  it("copies Chat Completions output token parameter into subtitle tasks", () => {
    expect(
      createSubtitleTaskModelFields({
        apiKey: "sk-compatible",
        modelKey: "deepseek-chat",
        baseUrl: "https://api.example.com/v1/chat/completions",
        apiFormat: "chat_completions",
        outputTokenParameter: "max_tokens",
      }),
    ).toMatchObject({
      apiFormat: "chat_completions",
      outputTokenParameter: "max_tokens",
    });
  });
});
