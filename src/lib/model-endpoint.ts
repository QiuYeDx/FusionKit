export type ModelEndpointInputKind =
  | "base_url"
  | "chat_completions_endpoint"
  | "responses_endpoint";

export interface NormalizedModelEndpoint {
  baseUrl: string;
  chatCompletionsUrl: string;
  responsesUrl: string;
  modelsUrl: string;
  originalInput: string;
  detectedInputKind: ModelEndpointInputKind;
}

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";
const MODELS_SUFFIX = "/models";

export function normalizeModelEndpoint(input: string): NormalizedModelEndpoint {
  const originalInput = input;
  const trimmed = input.trim().replace(/\/+$/, "");

  if (!trimmed) {
    return {
      baseUrl: "",
      chatCompletionsUrl: "",
      responsesUrl: "",
      modelsUrl: "",
      originalInput,
      detectedInputKind: "base_url",
    };
  }

  const lower = trimmed.toLowerCase();
  let baseUrl = trimmed;
  let detectedInputKind: ModelEndpointInputKind = "base_url";

  if (lower.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    baseUrl = trimmed.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
    detectedInputKind = "chat_completions_endpoint";
  } else if (lower.endsWith(RESPONSES_SUFFIX)) {
    baseUrl = trimmed.slice(0, -RESPONSES_SUFFIX.length);
    detectedInputKind = "responses_endpoint";
  }

  baseUrl = baseUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    chatCompletionsUrl: appendEndpoint(baseUrl, CHAT_COMPLETIONS_SUFFIX),
    responsesUrl: appendEndpoint(baseUrl, RESPONSES_SUFFIX),
    modelsUrl: appendEndpoint(baseUrl, MODELS_SUFFIX),
    originalInput,
    detectedInputKind,
  };
}

function appendEndpoint(baseUrl: string, suffix: string): string {
  return baseUrl ? `${baseUrl}${suffix}` : "";
}
