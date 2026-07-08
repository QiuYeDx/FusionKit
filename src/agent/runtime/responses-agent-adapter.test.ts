import { afterEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
  ResponsesAgentAdapter,
  buildResponsesInput,
  resolveResponsesAgentUrl,
} from "./responses-agent-adapter";
import type { AgentRuntimeStreamPart } from "./types";
import type { AgentMessage } from "../types";

const profile = {
  apiKey: "test-key",
  baseUrl: "https://api.example.com/v1",
  modelKey: "gpt-responses-test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResponsesAgentAdapter endpoint normalization", () => {
  it("accepts base URL input", () => {
    expect(resolveResponsesAgentUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/responses",
    );
  });

  it("accepts historical Responses full endpoint input", () => {
    expect(
      resolveResponsesAgentUrl("https://api.example.com/v1/responses"),
    ).toBe("https://api.example.com/v1/responses");
  });

  it("derives Responses endpoint from Chat Completions full endpoint input", () => {
    expect(
      resolveResponsesAgentUrl(
        "https://api.example.com/v1/chat/completions",
      ),
    ).toBe("https://api.example.com/v1/responses");
  });
});

describe("ResponsesAgentAdapter conversation mapping", () => {
  it("preserves function calls and outputs in later turns", () => {
    const messages: AgentMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "scan this",
        timestamp: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: "I will scan it.",
        timestamp: 2,
        toolCalls: [
          {
            toolCallId: "call_1",
            responseItemId: "fc_1",
            toolName: "scan_subtitle_files",
            args: { directories: ["/tmp"] },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        content: "{\"totalCount\":0}",
        timestamp: 3,
        toolResult: {
          callId: "call_1",
          toolName: "scan_subtitle_files",
          success: true,
          data: { totalCount: 0 },
        },
      },
    ];

    expect(buildResponsesInput(messages)).toEqual([
      { role: "user", content: "scan this" },
      { role: "assistant", content: "I will scan it." },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "scan_subtitle_files",
        arguments: "{\"directories\":[\"/tmp\"]}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"success\":true,\"data\":{\"totalCount\":0}}",
      },
    ]);
  });
});

describe("ResponsesAgentAdapter streaming", () => {
  it("streams normal assistant text and records usage", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return sseResponse([
          { type: "response.output_text.delta", delta: "Hello " },
          { type: "response.output_text.delta", delta: "there" },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
              },
            },
          },
        ]);
      }),
    );

    const adapter = new ResponsesAgentAdapter();
    const result = adapter.streamTurn({
      profile,
      system: "You are helpful.",
      messages: [
        { id: "u1", role: "user", content: "Hi", timestamp: 1 },
      ],
      tools: {},
      abortSignal: new AbortController().signal,
      temperature: 0.3,
      maxOutputTokens: 1024,
      maxSteps: 5,
    });

    const parts = await collectParts(result.fullStream);

    expect(parts).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "there" },
      {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    ]);
    await expect(result.usage).resolves.toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
    expect(requests[0]).toMatchObject({
      model: "gpt-responses-test",
      instructions: "You are helpful.",
      input: [{ role: "user", content: "Hi" }],
      stream: true,
      store: false,
      temperature: 0.3,
      max_output_tokens: 1024,
      tools: [],
    });
  });

  it("executes function calls and continues with function_call_output", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const executedInputs: unknown[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "echo_tool",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: "{}",
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "fc_1",
            arguments: "{}",
          },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 8,
                output_tokens: 3,
                total_tokens: 11,
              },
            },
          },
        ]);
      }

      return sseResponse([
        { type: "response.output_text.delta", delta: "Tool done." },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 2,
              total_tokens: 14,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ResponsesAgentAdapter();
    const result = adapter.streamTurn({
      profile,
      system: "Use tools when useful.",
      messages: [
        { id: "u1", role: "user", content: "Run echo", timestamp: 1 },
      ],
      tools: {
        echo_tool: tool({
          description: "Echo a value.",
          inputSchema: z.object({
            value: z.string().default("fallback"),
          }),
          execute: async (input) => {
            executedInputs.push(input);
            return { success: true, data: { value: input.value } };
          },
        }),
      },
      abortSignal: new AbortController().signal,
      temperature: 0.2,
      maxOutputTokens: 2048,
      maxSteps: 5,
    });

    const parts = await collectParts(result.fullStream);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executedInputs).toEqual([{ value: "fallback" }]);
    expect(parts).toMatchObject([
      { type: "tool-input-start", id: "call_1", toolName: "echo_tool" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "echo_tool",
        input: { value: "fallback" },
        responseItemId: "fc_1",
      },
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "echo_tool",
        output: { success: true, data: { value: "fallback" } },
      },
      {
        type: "finish-step",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
      { type: "text-delta", text: "Tool done." },
      {
        type: "finish-step",
        usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
      },
    ]);
    expect(requests[1].input).toEqual([
      { role: "user", content: "Run echo" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "echo_tool",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"success\":true,\"data\":{\"value\":\"fallback\"}}",
      },
    ]);
  });

  it("stops the tool loop when maxSteps is reached", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_limit",
            type: "function_call",
            call_id: "call_limit",
            name: "echo_tool",
            arguments: "{\"value\":\"again\"}",
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              total_tokens: 6,
            },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ResponsesAgentAdapter();
    const result = adapter.streamTurn({
      profile,
      system: "Use tools when useful.",
      messages: [
        { id: "u1", role: "user", content: "Run echo", timestamp: 1 },
      ],
      tools: {
        echo_tool: tool({
          description: "Echo a value.",
          inputSchema: z.object({ value: z.string() }),
          execute: async (input) => ({
            success: true,
            data: { value: input.value },
          }),
        }),
      },
      abortSignal: new AbortController().signal,
      temperature: 0.2,
      maxOutputTokens: 2048,
      maxSteps: 1,
    });

    await expect(collectParts(result.fullStream)).rejects.toThrow(
      "maximum tool-loop steps",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(result.usage).resolves.toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });
});

async function collectParts(
  stream: AsyncIterable<AgentRuntimeStreamPart>,
): Promise<AgentRuntimeStreamPart[]> {
  const parts: AgentRuntimeStreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
