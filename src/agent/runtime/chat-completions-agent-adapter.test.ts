import { describe, expect, it } from "vitest";
import { normalizeChatStream, resolveChatCompletionsAgentBaseUrl } from "./chat-completions-agent-adapter";

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

describe("Chat Completions stream normalization", () => {
  async function collect(parts: unknown[], maxSteps = 5, signal = new AbortController().signal) {
    const stream = (async function* () { yield* parts; })();
    const result = [];
    for await (const part of normalizeChatStream(stream, maxSteps, signal)) result.push(part);
    return result;
  }
  it("retains tool failures and exposes a completed terminal event", async () => {
    const error = new Error("bad input");
    const result = await collect([
      { type: "tool-call", toolCallId: "a", toolName: "run", input: {} },
      { type: "tool-error", toolCallId: "a", toolName: "run", error },
      { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(result[1]).toMatchObject({ type: "tool-error", toolCallId: "a", error });
    expect(result.at(-1)).toEqual({ type: "finish", reason: "completed" });
  });
  it("stops at the tool-step limit and drops later events", async () => {
    const result = await collect([
      { type: "tool-call", toolCallId: "a", toolName: "run", input: {} },
      { type: "finish-step" },
      { type: "tool-call", toolCallId: "later", toolName: "run", input: {} },
    ], 1);
    expect(result.at(-1)).toEqual({ type: "finish", reason: "step_limit" });
    expect(result.some((part) => part.type === "tool-call" && part.toolCallId === "later")).toBe(false);
  });
  it("marks premature EOF and output length termination incomplete", async () => {
    expect((await collect([{ type: "text-delta", text: "partial" }])).at(-1)).toEqual({ type: "finish", reason: "incomplete" });
    expect((await collect([{ type: "finish", finishReason: "length" }])).at(-1)).toEqual({ type: "finish", reason: "incomplete" });
  });
  it("honors cancellation before processing later content", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await collect([{ type: "text-delta", text: "late" }], 5, controller.signal)).toEqual([{ type: "finish", reason: "cancelled" }]);
  });
});
