import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelProfile } from "@/type/model";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import type { AgentToolSet } from "../guarded-tools";
import { AGENT_CONTEXT_CHARACTER_BUDGET } from "../conversation-context";
import {
  getUnsupportedParameters,
  markParameterUnsupported,
  optionalParameterKey,
  rejectsOptionalParameter,
} from "./optional-parameters";
import type { AgentRuntimeStreamPart, AgentRuntimeTurnResult, AgentRuntimeUsage } from "./types";

export interface ChatCompletionsAgentTurnRequest {
  profile: Pick<ModelProfile, "apiKey" | "baseUrl" | "modelKey">;
  system: string;
  messages: ModelMessage[];
  tools: AgentToolSet;
  abortSignal: AbortSignal;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
}

export class ChatCompletionsAgentAdapter {
  streamTurn(request: ChatCompletionsAgentTurnRequest): AgentRuntimeTurnResult {
    const key = optionalParameterKey(resolveChatCompletionsAgentBaseUrl(request.profile.baseUrl), request.profile.modelKey);
    return streamWithTemperatureFallback(key, request.maxSteps, request.abortSignal, (omitTemperature) => streamText({
      model: createChatCompletionsAgentModel(request.profile),
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      stopWhen: stepCountIs(request.maxSteps),
      ...(omitTemperature ? {} : { temperature: request.temperature }),
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
      maxRetries: 0,
      prepareStep: ({ messages }) => {
        if (JSON.stringify(messages).length > AGENT_CONTEXT_CHARACTER_BUDGET) {
          throw new Error("Agent context budget reached; continue in a new conversation.");
        }
        return {};
      },
    }));
  }
}

interface ChatStreamAttempt {
  fullStream: AsyncIterable<unknown>;
  usage: PromiseLike<AgentRuntimeUsage | undefined>;
}

/**
 * Reasoning models reject `temperature`. When the very first event of a turn is a 400
 * naming it, nothing has streamed or executed, so restart once without it and remember
 * that for this endpoint and model.
 */
export function streamWithTemperatureFallback(
  key: string,
  maxSteps: number,
  signal: AbortSignal,
  start: (omitTemperature: boolean) => ChatStreamAttempt,
): AgentRuntimeTurnResult {
  let resolveAttempt: (attempt: ChatStreamAttempt | undefined) => void = () => {};
  const finalAttempt = new Promise<ChatStreamAttempt | undefined>((resolve) => { resolveAttempt = resolve; });
  async function* stream(): AsyncGenerator<AgentRuntimeStreamPart> {
    let attempt: ChatStreamAttempt | undefined;
    try {
      while (true) {
        const omitTemperature = getUnsupportedParameters(key).has("temperature");
        attempt = start(omitTemperature);
        let started = false;
        let retry = false;
        for await (const part of normalizeChatStream(attempt.fullStream, maxSteps, signal)) {
          if (!started && !omitTemperature && part.type === "error"
            && rejectsOptionalParameter(describeApiCallError(part.error), "temperature")) {
            markParameterUnsupported(key, "temperature");
            retry = true;
            break;
          }
          started = true;
          yield part;
        }
        if (!retry) return;
      }
    } finally {
      resolveAttempt(attempt);
    }
  }
  return {
    fullStream: stream(),
    usage: finalAttempt.then((attempt) => attempt?.usage).then((usage) => usage, () => undefined),
  };
}

function describeApiCallError(error: unknown): { status?: number; message: string; param?: string } {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  const body = typeof record.responseBody === "string" ? record.responseBody : "";
  let param: string | undefined;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error?.param === "string") param = parsed.error.param;
  } catch { /* Non-JSON bodies are matched by text only. */ }
  return {
    status: typeof record.statusCode === "number" ? record.statusCode : undefined,
    message: `${typeof record.message === "string" ? record.message : ""} ${body}`,
    param,
  };
}

export async function* normalizeChatStream(
  stream: AsyncIterable<unknown>,
  maxSteps: number,
  signal: AbortSignal,
): AsyncGenerator<AgentRuntimeStreamPart> {
  let steps = 0;
  let toolStep = false;
  let finished = false;
  for await (const raw of stream) {
    if (signal.aborted) {
      yield { type: "finish", reason: "cancelled" };
      return;
    }
    const part = raw as Record<string, any>;
    switch (part.type) {
      case "text-delta": yield { type: "text-delta", text: part.text }; break;
      case "tool-input-start": yield { type: "tool-input-start", id: part.id, toolName: part.toolName }; break;
      case "tool-call":
        toolStep = true;
        yield { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input ?? {} };
        break;
      case "tool-result": yield { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output }; break;
      case "tool-error":
        yield { type: "tool-error", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input, error: part.error };
        break;
      case "finish-step":
        steps += 1;
        yield { type: "finish-step", usage: part.usage };
        if (steps >= maxSteps && toolStep) {
          yield { type: "finish", reason: "step_limit" };
          return;
        }
        toolStep = false;
        break;
      case "error": yield { type: "error", error: part.error }; return;
      case "abort": yield { type: "finish", reason: "cancelled" }; return;
      case "finish":
        finished = true;
        yield { type: "finish", reason: ["length", "error", "content-filter", "unknown"].includes(part.finishReason) ? "incomplete" : "completed" };
        break;
    }
  }
  if (!finished) yield { type: "finish", reason: signal.aborted ? "cancelled" : "incomplete" };
}

export function createChatCompletionsAgentModel(
  profile: Pick<ModelProfile, "apiKey" | "baseUrl" | "modelKey">,
) {
  const provider = createOpenAICompatible({
    baseURL: resolveChatCompletionsAgentBaseUrl(profile.baseUrl),
    apiKey: profile.apiKey,
    name: "fusionkit-provider",
  });
  return provider(profile.modelKey);
}

export function resolveChatCompletionsAgentBaseUrl(endpoint: string): string {
  return normalizeModelEndpoint(endpoint).baseUrl;
}
