import type { AxiosProxyConfig } from "axios";
import type {
  AudioRuntimeModelConfig,
  AudioTranscriptionResult,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
  SpeechSynthesisResult,
} from "@/type/audio";
import type { SpeechSynthesisStreamEvent } from "@/type/audioIpc";
import { createAudioRuntimeError } from "./audio-errors";
import type { AudioRuntimeRetryOptions } from "./audio-http";
import {
  sendOpenAIAudioTranscription,
  sendOpenAISpeechSynthesis,
} from "./adapters/openai-audio-adapter";
import {
  sendMimoAudioTranscription,
  sendMimoSpeechSynthesis,
} from "./adapters/mimo-chat-audio-adapter";

export interface AudioRuntimeRequestOptions {
  model: AudioRuntimeModelConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  proxy?: AxiosProxyConfig | false;
  retry?: Partial<AudioRuntimeRetryOptions>;
  outputTempRoot?: string;
  now?: Date;
  requestId?: string;
  onStreamEvent?: (
    event: SpeechSynthesisStreamEvent,
  ) => void | Promise<void>;
}

export interface AudioRuntimeTranscriptionRequest
  extends AudioRuntimeRequestOptions {
  payload: CreateAudioTranscriptionRequest;
}

export interface AudioRuntimeSpeechSynthesisRequest
  extends AudioRuntimeRequestOptions {
  payload: CreateSpeechSynthesisRequest;
}

export async function sendAudioTranscription(
  request: AudioRuntimeTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  switch (request.model.audioDialect) {
    case "openai_audio":
      return sendOpenAIAudioTranscription(request);
    case "mimo_chat_audio":
      return sendMimoAudioTranscription(request);
    case "openai_realtime":
      throw createAudioRuntimeError({
        code: "unsupported_audio_capability",
        message:
          "The selected audio dialect does not support OpenAI file transcription in this runtime path.",
        field: "audioDialect",
        details: { audioDialect: request.model.audioDialect },
      });
  }
}

export async function sendSpeechSynthesis(
  request: AudioRuntimeSpeechSynthesisRequest,
): Promise<SpeechSynthesisResult> {
  switch (request.model.audioDialect) {
    case "openai_audio":
      return sendOpenAISpeechSynthesis(request);
    case "mimo_chat_audio":
      return sendMimoSpeechSynthesis(request);
    case "openai_realtime":
      throw createAudioRuntimeError({
        code: "unsupported_audio_capability",
        message:
          "The selected audio dialect does not support OpenAI speech synthesis in this runtime path.",
        field: "audioDialect",
        details: { audioDialect: request.model.audioDialect },
      });
  }
}
