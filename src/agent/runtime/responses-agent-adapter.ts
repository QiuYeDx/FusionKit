import { asSchema, type ModelMessage, type Tool } from "ai";
import type { ModelProfile } from "@/type/model";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import type { AgentMessage } from "../types";
import type {
  AgentRuntimeStreamPart,
  AgentRuntimeTurnResult,
  AgentRuntimeUsage,
} from "./types";

export type ResponsesAgentToolSet = Record<string, Tool<any, any>>;

export interface ResponsesAgentTurnRequest {
  profile: Pick<ModelProfile, "apiKey" | "baseUrl" | "modelKey">;
  system: string;
  messages: AgentMessage[];
  tools: ResponsesAgentToolSet;
  abortSignal: AbortSignal;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
}

type ResponsesInputItem =
  | {
      role: "user" | "assistant";
      content: string;
    }
  | {
      type: "function_call";
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

interface PendingFunctionCall {
  responseItemId?: string;
  callId: string;
  name: string;
  argumentsText: string;
  parsedInput?: unknown;
}

interface ResponsesStepResult {
  functionCalls: PendingFunctionCall[];
  assistantText: string;
  usage?: AgentRuntimeUsage;
}

export class ResponsesAgentAdapter {
  streamTurn(request: ResponsesAgentTurnRequest): AgentRuntimeTurnResult {
    let finalUsage: AgentRuntimeUsage | undefined;
    let resolveUsage: (usage: AgentRuntimeUsage | undefined) => void = () => {};
    const usage = new Promise<AgentRuntimeUsage | undefined>((resolve) => {
      resolveUsage = resolve;
    });

    const fullStream = this.streamLoop(request, (usage) => {
      finalUsage = usage;
    }, () => resolveUsage(finalUsage));

    return {
      fullStream,
      usage,
    };
  }

  private async *streamLoop(
    request: ResponsesAgentTurnRequest,
    setFinalUsage: (usage: AgentRuntimeUsage | undefined) => void,
    finalizeUsage: () => void,
  ): AsyncGenerator<AgentRuntimeStreamPart> {
    try {
      let input = buildResponsesInput(request.messages);

      for (let step = 0; step < request.maxSteps; step += 1) {
        const stepResult: ResponsesStepResult = {
          functionCalls: [],
          assistantText: "",
        };

        const response = await fetch(resolveResponsesAgentUrl(request.profile.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${request.profile.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(await buildResponsesRequestBody(request, input)),
          signal: request.abortSignal,
        });

        if (!response.ok) {
          throw await createResponsesHttpError(response, request.profile.apiKey);
        }

        if (!response.body) {
          throw new Error("Responses API stream body is empty.");
        }

        for await (const part of parseResponsesStream(
          response.body,
          stepResult,
          request.tools,
        )) {
          yield part;
        }

        setFinalUsage(stepResult.usage);

        const toolResults = await executeFunctionCalls(
          stepResult.functionCalls,
          request,
        );

        for (const toolResult of toolResults) {
          yield {
            type: "tool-result",
            toolCallId: toolResult.call.callId,
            toolName: toolResult.call.name,
            output: toolResult.output,
          };
        }

        yield {
          type: "finish-step",
          usage: stepResult.usage,
        };

        if (stepResult.functionCalls.length === 0) {
          return;
        }

        if (step + 1 >= request.maxSteps) {
          throw new Error("Responses Agent exceeded the maximum tool-loop steps.");
        }

        input = [
          ...input,
          ...(stepResult.assistantText
            ? [{ role: "assistant" as const, content: stepResult.assistantText }]
            : []),
          ...stepResult.functionCalls.map(toFunctionCallInputItem),
          ...toolResults.map((toolResult) => ({
            type: "function_call_output" as const,
            call_id: toolResult.call.callId,
            output: stringifyToolOutput(toolResult.output),
          })),
        ];
      }
    } finally {
      finalizeUsage();
    }
  }
}

export function resolveResponsesAgentUrl(endpoint: string): string {
  return normalizeModelEndpoint(endpoint).responsesUrl;
}

export function buildResponsesInput(messages: AgentMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      input.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          id: toolCall.responseItemId,
          call_id: toolCall.toolCallId,
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.args ?? {}),
        });
      }
      continue;
    }

    if (message.role === "tool" && message.toolResult) {
      input.push({
        type: "function_call_output",
        call_id: message.toolResult.callId,
        output: stringifyToolOutput(
          message.toolResult.success === false
            ? { success: false, error: message.toolResult.error }
            : {
                success: true,
                data: message.toolResult.data ?? null,
              },
        ),
      });
    }
  }

  return input;
}

async function buildResponsesRequestBody(
  request: ResponsesAgentTurnRequest,
  input: ResponsesInputItem[],
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: request.profile.modelKey,
    instructions: request.system,
    input,
    tools: await buildResponsesTools(request.tools),
    stream: true,
    store: false,
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens,
  };

  return body;
}

async function buildResponsesTools(
  tools: ResponsesAgentToolSet,
): Promise<Array<Record<string, unknown>>> {
  const entries = Object.entries(tools);
  const resolved = await Promise.all(
    entries.map(async ([name, tool]) => ({
      type: "function",
      name,
      description: tool.description ?? "",
      parameters: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );
  return resolved;
}

async function* parseResponsesStream(
  stream: ReadableStream<Uint8Array>,
  stepResult: ResponsesStepResult,
  tools: ResponsesAgentToolSet,
): AsyncGenerator<AgentRuntimeStreamPart> {
  const callsByItemId = new Map<string, PendingFunctionCall>();
  const itemIdByOutputIndex = new Map<number, string>();

  for await (const event of readSseJsonEvents(stream)) {
    if (!isRecord(event)) continue;

    const eventType = stringValue(event.type);
    switch (eventType) {
      case "response.output_text.delta": {
        const delta = stringValue(event.delta);
        if (delta) {
          stepResult.assistantText += delta;
          yield { type: "text-delta", text: delta };
        }
        break;
      }

      case "response.output_item.added": {
        const item = isRecord(event.item) ? event.item : undefined;
        if (!item || item.type !== "function_call") break;

        const call = upsertFunctionCall(callsByItemId, item);
        const outputIndex = numberValue(event.output_index);
        if (outputIndex !== undefined && call.responseItemId) {
          itemIdByOutputIndex.set(outputIndex, call.responseItemId);
        }

        yield {
          type: "tool-input-start",
          id: call.callId,
          toolName: call.name,
        };
        break;
      }

      case "response.function_call_arguments.delta": {
        const call = resolveFunctionCallForArgumentsEvent(
          event,
          callsByItemId,
          itemIdByOutputIndex,
        );
        if (call) {
          call.argumentsText += stringValue(event.delta);
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const call = resolveFunctionCallForArgumentsEvent(
          event,
          callsByItemId,
          itemIdByOutputIndex,
        );
        if (call && typeof event.arguments === "string") {
          call.argumentsText = event.arguments;
        }
        break;
      }

      case "response.output_item.done": {
        const item = isRecord(event.item) ? event.item : undefined;
        if (item?.type === "function_call") {
          upsertFunctionCall(callsByItemId, item);
        }
        break;
      }

      case "response.completed": {
        const response = isRecord(event.response) ? event.response : undefined;
        stepResult.usage = parseResponsesUsage(response?.usage);
        break;
      }

      case "response.failed": {
        const response = isRecord(event.response) ? event.response : undefined;
        const error = isRecord(response?.error) ? response.error : undefined;
        yield {
          type: "error",
          error: new Error(
            stringValue(error?.message) || "Responses API stream failed.",
          ),
        };
        break;
      }
    }
  }

  for (const call of callsByItemId.values()) {
    call.parsedInput = await parseAndValidateToolInput(
      tools[call.name],
      call.argumentsText,
    );
    stepResult.functionCalls.push(call);
    yield {
      type: "tool-call",
      toolCallId: call.callId,
      toolName: call.name,
      input: call.parsedInput,
      responseItemId: call.responseItemId,
    };
  }
}

async function* readSseJsonEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = findSseSeparator(buffer);
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(
          buffer.startsWith("\r\n\r\n", separatorIndex)
            ? separatorIndex + 4
            : separatorIndex + 2,
        );
        const parsed = parseSseJsonEvent(rawEvent);
        if (parsed !== undefined) yield parsed;
        separatorIndex = findSseSeparator(buffer);
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseJsonEvent(buffer);
    if (parsed !== undefined) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function findSseSeparator(buffer: string): number {
  const unixIndex = buffer.indexOf("\n\n");
  const windowsIndex = buffer.indexOf("\r\n\r\n");
  if (unixIndex < 0) return windowsIndex;
  if (windowsIndex < 0) return unixIndex;
  return Math.min(unixIndex, windowsIndex);
}

function parseSseJsonEvent(rawEvent: string): unknown {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data);
}

function upsertFunctionCall(
  callsByItemId: Map<string, PendingFunctionCall>,
  item: Record<string, unknown>,
): PendingFunctionCall {
  const responseItemId = stringValue(item.id) || stringValue(item.item_id);
  const callId =
    stringValue(item.call_id) ||
    stringValue(item.callId) ||
    responseItemId ||
    `call_${Date.now().toString(36)}`;
  const key = responseItemId || callId;
  const existing = callsByItemId.get(key);
  if (existing) {
    existing.name = stringValue(item.name) || existing.name;
    if (typeof item.arguments === "string") {
      existing.argumentsText = item.arguments;
    }
    return existing;
  }

  const call: PendingFunctionCall = {
    responseItemId,
    callId,
    name: stringValue(item.name),
    argumentsText: stringValue(item.arguments),
  };
  callsByItemId.set(key, call);
  return call;
}

function resolveFunctionCallForArgumentsEvent(
  event: Record<string, unknown>,
  callsByItemId: Map<string, PendingFunctionCall>,
  itemIdByOutputIndex: Map<number, string>,
): PendingFunctionCall | undefined {
  const itemId = stringValue(event.item_id);
  if (itemId) return callsByItemId.get(itemId);

  const outputIndex = numberValue(event.output_index);
  const mappedItemId =
    outputIndex === undefined ? undefined : itemIdByOutputIndex.get(outputIndex);
  if (mappedItemId) return callsByItemId.get(mappedItemId);

  if (callsByItemId.size === 1) {
    return [...callsByItemId.values()][0];
  }

  return undefined;
}

async function executeFunctionCalls(
  calls: PendingFunctionCall[],
  request: ResponsesAgentTurnRequest,
): Promise<Array<{ call: PendingFunctionCall; output: unknown }>> {
  const results: Array<{ call: PendingFunctionCall; output: unknown }> = [];

  for (const call of calls) {
    const tool = request.tools[call.name];
    if (!tool?.execute) {
      results.push({
        call,
        output: {
          success: false,
          error: `Unknown or non-executable tool: ${call.name}`,
        },
      });
      continue;
    }

    try {
      const input = call.parsedInput ?? await parseAndValidateToolInput(tool, call.argumentsText);
      const output = await tool.execute(input, {
        toolCallId: call.callId,
        messages: [] as ModelMessage[],
        abortSignal: request.abortSignal,
      });
      results.push({ call, output });
    } catch (error) {
      results.push({
        call,
        output: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return results;
}

async function parseAndValidateToolInput(
  tool: Tool<any, any> | undefined,
  argumentsText: string,
): Promise<unknown> {
  const parsed = await parseToolInput(argumentsText);
  if (!tool) return parsed;
  const schema = asSchema(tool.inputSchema);
  const result = await schema.validate?.(parsed);
  if (!result) return parsed;
  if (result.success) return result.value;
  throw result.error;
}

async function parseToolInput(argumentsText: string): Promise<Record<string, unknown>> {
  const text = argumentsText.trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed;
}

function toFunctionCallInputItem(call: PendingFunctionCall): ResponsesInputItem {
  return {
    type: "function_call",
    id: call.responseItemId,
    call_id: call.callId,
    name: call.name,
    arguments: call.argumentsText || "{}",
  };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? null);
}

function parseResponsesUsage(usage: unknown): AgentRuntimeUsage | undefined {
  if (!isRecord(usage)) return undefined;

  return {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    totalTokens: numberValue(usage.total_tokens),
  };
}

async function createResponsesHttpError(
  response: Response,
  apiKey: string,
): Promise<Error> {
  let message = `Responses API request failed with HTTP ${response.status}.`;
  try {
    const body = await response.json();
    const error = isRecord(body?.error) ? body.error : undefined;
    message = stringValue(error?.message) || message;
  } catch {
    const text = await response.text().catch(() => "");
    if (text) message = text;
  }

  return new Error(sanitizeErrorMessage(message, apiKey));
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("[redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
