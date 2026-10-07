import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeChatStream, resolveChatCompletionsAgentBaseUrl, streamWithTemperatureFallback } from "./chat-completions-agent-adapter";
import { resetOptionalParameterCompatibility } from "./optional-parameters";

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

describe("Chat Completions temperature fallback", () => {
  afterEach(() => resetOptionalParameterCompatibility());
  const rejection = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", param: "temperature" } }),
  });
  const attempt = (parts: unknown[]) => ({
    fullStream: (async function* () { yield* parts; })(),
    usage: Promise.resolve({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }),
  });
  async function drain(result: ReturnType<typeof streamWithTemperatureFallback>) {
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    return parts;
  }

  it("restarts once without temperature and remembers the model", async () => {
    const start = vi.fn((omit: boolean) => omit
      ? attempt([{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }])
      : attempt([{ type: "error", error: rejection }]));
    const result = streamWithTemperatureFallback("k", 5, new AbortController().signal, start);
    expect(await drain(result)).toEqual([{ type: "text-delta", text: "ok" }, { type: "finish", reason: "completed" }]);
    expect(start.mock.calls).toEqual([[false], [true]]);
    await expect(result.usage).resolves.toMatchObject({ totalTokens: 4 });
    const next = vi.fn(() => attempt([{ type: "finish", finishReason: "stop" }]));
    await drain(streamWithTemperatureFallback("k", 5, new AbortController().signal, next));
    expect(next.mock.calls).toEqual([[true]]);
  });

  it("does not retry other errors or errors after output started", async () => {
    const other = vi.fn(() => attempt([{ type: "error", error: Object.assign(new Error("quota"), { statusCode: 429 }) }]));
    expect((await drain(streamWithTemperatureFallback("a", 5, new AbortController().signal, other))).at(-1)).toMatchObject({ type: "error" });
    expect(other).toHaveBeenCalledTimes(1);
    const late = vi.fn(() => attempt([{ type: "text-delta", text: "x" }, { type: "error", error: rejection }]));
    expect((await drain(streamWithTemperatureFallback("b", 5, new AbortController().signal, late))).at(-1)).toMatchObject({ type: "error" });
    expect(late).toHaveBeenCalledTimes(1);
  });
});
