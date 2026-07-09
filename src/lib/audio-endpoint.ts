export type AudioEndpointInputKind =
  | "base_url"
  | "chat_completions_endpoint"
  | "audio_speech_endpoint"
  | "audio_transcriptions_endpoint"
  | "realtime_client_secrets_endpoint"
  | "realtime_calls_endpoint"
  | "models_endpoint";

export interface NormalizedAudioEndpoint {
  baseUrl: string;
  chatCompletionsUrl: string;
  audioSpeechUrl: string;
  audioTranscriptionsUrl: string;
  realtimeClientSecretsUrl: string;
  realtimeCallsUrl: string;
  modelsUrl: string;
  originalInput: string;
  detectedInputKind: AudioEndpointInputKind;
}

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const AUDIO_SPEECH_SUFFIX = "/audio/speech";
const AUDIO_TRANSCRIPTIONS_SUFFIX = "/audio/transcriptions";
const REALTIME_CLIENT_SECRETS_SUFFIX = "/realtime/client_secrets";
const REALTIME_CALLS_SUFFIX = "/realtime/calls";
const MODELS_SUFFIX = "/models";

const KNOWN_SUFFIXES: Array<{
  suffix: string;
  kind: AudioEndpointInputKind;
}> = [
  {
    suffix: REALTIME_CLIENT_SECRETS_SUFFIX,
    kind: "realtime_client_secrets_endpoint",
  },
  {
    suffix: AUDIO_TRANSCRIPTIONS_SUFFIX,
    kind: "audio_transcriptions_endpoint",
  },
  {
    suffix: CHAT_COMPLETIONS_SUFFIX,
    kind: "chat_completions_endpoint",
  },
  {
    suffix: AUDIO_SPEECH_SUFFIX,
    kind: "audio_speech_endpoint",
  },
  {
    suffix: REALTIME_CALLS_SUFFIX,
    kind: "realtime_calls_endpoint",
  },
  {
    suffix: MODELS_SUFFIX,
    kind: "models_endpoint",
  },
];

export function normalizeAudioEndpoint(input: string): NormalizedAudioEndpoint {
  const originalInput = input;
  const trimmed = input.trim().replace(/\/+$/, "");

  if (!trimmed) {
    return createNormalizedEndpoint("", originalInput, "base_url");
  }

  const lower = trimmed.toLowerCase();
  let baseUrl = trimmed;
  let detectedInputKind: AudioEndpointInputKind = "base_url";

  for (const { suffix, kind } of KNOWN_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      baseUrl = trimmed.slice(0, -suffix.length);
      detectedInputKind = kind;
      break;
    }
  }

  return createNormalizedEndpoint(
    baseUrl.replace(/\/+$/, ""),
    originalInput,
    detectedInputKind,
  );
}

function createNormalizedEndpoint(
  baseUrl: string,
  originalInput: string,
  detectedInputKind: AudioEndpointInputKind,
): NormalizedAudioEndpoint {
  return {
    baseUrl,
    chatCompletionsUrl: appendEndpoint(baseUrl, CHAT_COMPLETIONS_SUFFIX),
    audioSpeechUrl: appendEndpoint(baseUrl, AUDIO_SPEECH_SUFFIX),
    audioTranscriptionsUrl: appendEndpoint(
      baseUrl,
      AUDIO_TRANSCRIPTIONS_SUFFIX,
    ),
    realtimeClientSecretsUrl: appendEndpoint(
      baseUrl,
      REALTIME_CLIENT_SECRETS_SUFFIX,
    ),
    realtimeCallsUrl: appendEndpoint(baseUrl, REALTIME_CALLS_SUFFIX),
    modelsUrl: appendEndpoint(baseUrl, MODELS_SUFFIX),
    originalInput,
    detectedInputKind,
  };
}

function appendEndpoint(baseUrl: string, suffix: string): string {
  return baseUrl ? `${baseUrl}${suffix}` : "";
}
