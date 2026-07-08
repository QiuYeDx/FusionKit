import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelProfile } from "@/type/model";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import type { agentTools } from "../tools";
import type { AgentRuntimeTurnResult } from "./types";

type AgentTools = typeof agentTools;

export interface ChatCompletionsAgentTurnRequest {
  profile: Pick<ModelProfile, "apiKey" | "baseUrl" | "modelKey">;
  system: string;
  messages: ModelMessage[];
  tools: AgentTools;
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
    });

    return {
      fullStream: result.fullStream as AgentRuntimeTurnResult["fullStream"],
      usage: Promise.resolve(result.usage),
    };
  }
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
