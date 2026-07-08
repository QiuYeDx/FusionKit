import { describe, expect, it } from "vitest";
import { resolveChatCompletionsAgentBaseUrl } from "./chat-completions-agent-adapter";

describe("ChatCompletionsAgentAdapter endpoint normalization", () => {
  it("keeps base URL input unchanged", () => {
    expect(
      resolveChatCompletionsAgentBaseUrl("https://api.example.com/v1"),
    ).toBe("https://api.example.com/v1");
  });

  it("accepts historical Chat Completions full endpoint input", () => {
    expect(
      resolveChatCompletionsAgentBaseUrl(
        "https://api.example.com/v1/chat/completions",
      ),
    ).toBe("https://api.example.com/v1");
  });

  it("derives the same base URL from a Responses endpoint", () => {
    expect(
      resolveChatCompletionsAgentBaseUrl(
        "https://api.example.com/v1/responses",
      ),
    ).toBe("https://api.example.com/v1");
  });
});
