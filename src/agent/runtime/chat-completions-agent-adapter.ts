import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelProfile } from "@/type/model";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import type { AgentToolSet } from "../guarded-tools";
import { AGENT_CONTEXT_CHARACTER_BUDGET } from "../conversation-context";
import type { AgentRuntimeStreamPart, AgentRuntimeTurnResult } from "./types";

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
    const result = streamText({
      model: createChatCompletionsAgentModel(request.profile),
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      stopWhen: stepCountIs(request.maxSteps),
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
      maxRetries: 0,
      prepareStep: ({ messages }) => {
        if (JSON.stringify(messages).length > AGENT_CONTEXT_CHARACTER_BUDGET) {
          throw new Error("Agent context budget reached; continue in a new conversation.");
        }
        return {};
      },
    });

    return {
      fullStream: normalizeChatStream(result.fullStream, request.maxSteps, request.abortSignal),
      usage: Promise.resolve(result.usage).catch(() => undefined),
    };
  }
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
