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
      { type: "finish", reason: "completed" },
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
          { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "echo_tool", arguments: "{}", status: "completed" } },
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
      { type: "finish", reason: "completed" },
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
            output: [{ id: "fc_limit", type: "function_call", call_id: "call_limit", name: "echo_tool", arguments: '{"value":"again"}', status: "completed" }],
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

    const parts = await collectParts(result.fullStream);
    expect(parts.at(-1)).toEqual({ type: "finish", reason: "step_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(result.usage).resolves.toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });
});

describe("Responses terminal safety", () => {
  const call = (id = "call-1", argumentsText = "{}") => ({ type: "response.output_item.done", item: { id: `fc-${id}`, type: "function_call", call_id: id, name: "run", arguments: argumentsText } });
  const completed = { type: "response.completed", response: { status: "completed" } };
  const create = (execute: (...args: any[]) => any, signal = new AbortController().signal) => new ResponsesAgentAdapter().streamTurn({
    profile, system: "safe", messages: [{ id: "u", role: "user", content: "run", timestamp: 1 }],
    tools: { run: tool({ inputSchema: z.object({ value: z.string().default("ok") }), execute }) },
    abortSignal: signal, temperature: 0.3, maxOutputTokens: 1000, maxSteps: 2,
  });

  it.each([
    { ending: [], error: "ended before completion" },
    { ending: [{ type: "response.incomplete", response: { status: "incomplete" } }], error: "response.incomplete" },
    { ending: [{ type: "response.failed", response: { error: { message: "provider failed" } } }], error: "provider failed" },
  ])("does not execute collected function calls without successful completion %#", async ({ ending, error }) => {
    const execute = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([call(), ...ending])));
    await expect(collectParts(create(execute).fullStream)).rejects.toThrow(error);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not accept added-only calls even when the response terminal says completed", async () => {
    const execute = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([{ ...call(), type: "response.output_item.added" }, completed])));
    await expect(collectParts(create(execute).fullStream)).rejects.toThrow("did not complete");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects the whole step when only one of two announced calls completes", async () => {
    const execute = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      { ...call("first"), type: "response.output_item.added" },
      { ...call("unfinished"), type: "response.output_item.added" },
      call("first"), completed,
    ])));
    await expect(collectParts(create(execute).fullStream)).rejects.toThrow("did not complete");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["response_output", "done_events"])("replays opaque reasoning and assistant phase in original order using %s", async (source) => {
    const output = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-one" },
      { type: "message", id: "msg_1", role: "assistant", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "Checking", annotations: [] }] },
      call("first").item,
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "opaque-two" },
      call("second").item,
    ];
    const requests: any[] = [];
    const execute = vi.fn(async () => ({ success: true }));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length > 1) return sseResponse([completed]);
      // Done events deliberately arrive in reverse order to exercise output_index.
      const events = output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })).reverse();
      return sseResponse([...events, source === "response_output" ? { type: "response.completed", response: { status: "completed", output } } : completed]);
    }));
    const events = await collectParts(create(execute).fullStream);
    expect(requests[1].input.slice(1, 6)).toEqual(output);
    expect(requests[1].input.slice(6).map((item: any) => item.call_id)).toEqual(["first", "second"]);
    expect(requests[0]).toMatchObject({ store: false });
    expect(requests[0]).not.toHaveProperty("include");
    expect(JSON.stringify(events)).not.toContain("opaque-");
    expect(JSON.stringify(events)).not.toContain('"type":"reasoning"');
    expect(execute).toHaveBeenCalledTimes(2);
    await collectParts(create(execute).fullStream);
    expect(requests[2].input).toEqual([{ role: "user", content: "run" }]);
  });

  it("counts encrypted reasoning toward the next-request budget", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const fetchMock = vi.fn(async () => sseResponse([{ type: "response.completed", response: { status: "completed", output: [
      { type: "reasoning", id: "rs_large", summary: [], encrypted_content: "x".repeat(96_000) }, call().item,
    ] } }]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectParts(create(execute).fullStream)).rejects.toThrow("context budget");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["{bad json", '{"value":123}'])("returns invalid arguments as a tool failure and lets the next step recover: %s", async (argumentsText) => {
    const requests: any[] = [];
    const execute = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return sseResponse(requests.length === 1 ? [call("bad", argumentsText), completed] : [{ type: "response.output_text.delta", delta: "Please provide a string." }, completed]);
    }));
    const parts = await collectParts(create(execute).fullStream);
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({ output: { success: false, error: expect.stringContaining("Invalid tool arguments") } });
    expect(requests).toHaveLength(2);
    expect(requests[1].input.at(-1).type).toBe("function_call_output");
    expect(execute).not.toHaveBeenCalled();
    expect(parts.at(-1)).toEqual({ type: "finish", reason: "completed" });
  });

  it("stops before the next call when a previous admitted tool cancels the turn", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(); return { success: true, data: { taskId: "accepted" } }; });
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([call("first"), call("second"), completed])));
    const received: AgentRuntimeStreamPart[] = [];
    const consume = async () => { for await (const part of create(execute, controller.signal).fullStream) received.push(part); };
    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(received.find((part) => part.type === "tool-result")).toMatchObject({ toolCallId: "first", output: { success: true } });
  });

  it("cancels a stalled SSE reader promptly", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const execute = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetchMock);
    const operation = collectParts(create(execute, controller.signal).fullStream);
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds model tool output while keeping raw results available in the stream", async () => {
    const output = { success: false, data: { value: "x".repeat(50_000) }, error: "failed" };
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return sseResponse(requests.length === 1 ? [call(), completed] : [completed]);
    }));
    const parts = await collectParts(create(async () => output).fullStream);
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({ output });
    const serialized = requests[1].input.at(-1).output;
    expect(serialized.length).toBeLessThanOrEqual(6000);
    expect(JSON.parse(serialized)).toMatchObject({ success: false, truncated: true });
  });

  it("checks the growing context before sending another model request", async () => {
    const execute = vi.fn(async () => ({ success: true, data: { text: "x".repeat(50_000) } }));
    const fetchMock = vi.fn(async () => sseResponse([call(), completed]));
    vi.stubGlobal("fetch", fetchMock);
    const result = new ResponsesAgentAdapter().streamTurn({
      profile, system: "safe", messages: [{ id: "u", role: "user", content: "x".repeat(95_800), timestamp: 1 }],
      tools: { run: tool({ inputSchema: z.object({}), execute }) },
      abortSignal: new AbortController().signal, temperature: 0.3, maxOutputTokens: 1000, maxSteps: 5,
    });
    await expect(collectParts(result.fullStream)).rejects.toThrow("context budget");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
