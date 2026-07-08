import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_MODEL_BASE_URL_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
} from "@/constants/model";
import { Model } from "@/type/model";
import { normalizeModelEndpoint } from "./model-endpoint";

describe("normalizeModelEndpoint", () => {
  it("derives all OpenAI-compatible endpoints from a base URL", () => {
    expect(normalizeModelEndpoint("https://api.openai.com/v1")).toEqual({
      baseUrl: "https://api.openai.com/v1",
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
      responsesUrl: "https://api.openai.com/v1/responses",
      modelsUrl: "https://api.openai.com/v1/models",
      originalInput: "https://api.openai.com/v1",
      detectedInputKind: "base_url",
    });
  });

  it("normalizes historical chat completions full endpoint input", () => {
    expect(
      normalizeModelEndpoint("https://api.openai.com/v1/chat/completions"),
    ).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
      responsesUrl: "https://api.openai.com/v1/responses",
      modelsUrl: "https://api.openai.com/v1/models",
      detectedInputKind: "chat_completions_endpoint",
    });
  });

  it("normalizes responses full endpoint input", () => {
    expect(normalizeModelEndpoint("https://api.openai.com/v1/responses")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
      responsesUrl: "https://api.openai.com/v1/responses",
      modelsUrl: "https://api.openai.com/v1/models",
      detectedInputKind: "responses_endpoint",
    });
  });

  it("trims whitespace and trailing slashes without changing originalInput", () => {
    expect(
      normalizeModelEndpoint("  http://127.0.0.1:11434/v1/responses///  "),
    ).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      chatCompletionsUrl: "http://127.0.0.1:11434/v1/chat/completions",
      responsesUrl: "http://127.0.0.1:11434/v1/responses",
      modelsUrl: "http://127.0.0.1:11434/v1/models",
      originalInput: "  http://127.0.0.1:11434/v1/responses///  ",
      detectedInputKind: "responses_endpoint",
    });
  });

  it("keeps unrelated URL paths as base URLs", () => {
    expect(
      normalizeModelEndpoint("https://provider.example/api/openai"),
    ).toMatchObject({
      baseUrl: "https://provider.example/api/openai",
      chatCompletionsUrl:
        "https://provider.example/api/openai/chat/completions",
      responsesUrl: "https://provider.example/api/openai/responses",
      modelsUrl: "https://provider.example/api/openai/models",
      detectedInputKind: "base_url",
    });
  });

  it("keeps empty endpoint input empty", () => {
    expect(normalizeModelEndpoint("   ")).toEqual({
      baseUrl: "",
      chatCompletionsUrl: "",
      responsesUrl: "",
      modelsUrl: "",
      originalInput: "   ",
      detectedInputKind: "base_url",
    });
  });

  it("exposes conservative provider defaults without changing legacy URL defaults", () => {
    expect(DEFAULT_MODEL_BASE_URL_MAP[Model.OpenAI]).toBe(
      "https://api.openai.com/v1",
    );
    expect(DEFAULT_MODEL_API_FORMAT_MAP).toEqual({
      [Model.DeepSeek]: "chat_completions",
      [Model.OpenAI]: "responses",
      [Model.Other]: "chat_completions",
    });
    expect(DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP).toEqual({
      [Model.DeepSeek]: "max_tokens",
      [Model.OpenAI]: "max_completion_tokens",
      [Model.Other]: "max_tokens",
    });
  });
});
