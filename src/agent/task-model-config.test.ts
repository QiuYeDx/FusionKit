import { describe, expect, it } from "vitest";
import {
  createSubtitleTaskExecutionBinding,
  createSubtitleTaskModelFields,
} from "./task-model-config";
import { hasReadySubtitleTaskExecution } from "@/services/subtitle/subtitleTranslatorTaskFactory";

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
      maxOutputTokens: 128_000,
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

  it("creates a complete immutable ready execution binding", () => {
    const binding = createSubtitleTaskExecutionBinding({
      id: "profile-1",
      name: "Primary profile",
      apiKey: "sk-test",
      modelKey: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
      maxOutputTokens: 32_000,
    });

    expect(binding).toEqual({
      status: "ready",
      profileId: "profile-1",
      profileLabel: "Primary profile",
      apiKey: "sk-test",
      apiModel: "gpt-5",
      endPoint: "https://api.openai.com/v1",
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
      maxOutputTokens: 32_000,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(hasReadySubtitleTaskExecution({ executionBinding: binding })).toBe(true);
  });
});
