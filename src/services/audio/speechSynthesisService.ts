import type {
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  AUDIO_EVENT_CHANNELS,
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  isSpeechSynthesisStreamEventPayload,
  type AudioIpcResult,
  type CancelSpeechSynthesisResult,
  type CancelSpeechSynthesisStreamResult,
  type CreateSpeechSynthesisIpcRequest,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
  type ReadAudioOutputResult,
  type SpeechSynthesisStreamEvent,
} from "@/type/audioIpc";
import {
  audioIpcUnavailableResult,
  invokeAudioIpc,
  syncAudioRuntimeConfigBeforeTask,
} from "./audioRuntimeConfigService";

export interface SpeechSynthesisStreamHandlers {
  started?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "started" }>,
  ) => void;
  audioDelta?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "audio_delta" }>,
  ) => void;
  textDelta?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "text_delta" }>,
  ) => void;
  metadata?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "metadata" }>,
  ) => void;
  completed?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "completed" }>,
  ) => void;
  error?: (
    event: Extract<SpeechSynthesisStreamEvent, { type: "error" }>,
  ) => void;
  any?: (event: SpeechSynthesisStreamEvent) => void;
}

export interface SpeechSynthesisStreamHandle {
  requestId: string;
  result: Promise<AudioIpcResult<SpeechSynthesisResult>>;
  cancel: () => Promise<AudioIpcResult<CancelSpeechSynthesisStreamResult>>;
  unsubscribe: () => void;
}

export async function synthesizeSpeech(
  request: CreateSpeechSynthesisIpcRequest,
): Promise<AudioIpcResult<SpeechSynthesisResult>> {
  try {
    const synced = await syncAudioRuntimeConfigBeforeTask();
    if (!synced.ok) return audioIpcFailure(synced.error);

    return invokeAudioIpc<SpeechSynthesisResult>(
      AUDIO_IPC_CHANNELS.synthesizeSpeech,
      request,
      synced.data.revision,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function cancelSpeechSynthesis(
  requestId: string,
): Promise<AudioIpcResult<CancelSpeechSynthesisResult>> {
  try {
    return invokeAudioIpc<CancelSpeechSynthesisResult>(
      AUDIO_IPC_CHANNELS.cancelSpeechSynthesis,
      { requestId },
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export function synthesizeSpeechStream(
  request: CreateSpeechSynthesisIpcRequest,
  handlers: SpeechSynthesisStreamHandlers = {},
  options: { requestId?: string } = {},
): SpeechSynthesisStreamHandle {
  const requestId = options.requestId ?? createAudioRequestId();
  const removeListener = subscribeSpeechSynthesisStreamEvents(requestId, handlers);
  let subscribed = true;
  const unsubscribe = () => {
    if (!subscribed) return;
    subscribed = false;
    removeListener();
  };
  const payload = {
    requestId,
    payload: {
      ...request,
      stream: true,
    },
  };

  const result = (async () => {
    try {
      const synced = await syncAudioRuntimeConfigBeforeTask();
      if (!synced.ok) return audioIpcFailure(synced.error);

      return await invokeAudioIpc<SpeechSynthesisResult>(
        AUDIO_IPC_CHANNELS.synthesizeSpeechStream,
        payload,
        synced.data.revision,
      );
    } catch (error) {
      return audioIpcUnavailableResult<SpeechSynthesisResult>(error);
    }
  })().finally(unsubscribe);

  return {
    requestId,
    result,
    cancel: () => cancelSpeechSynthesisStream({ requestId }),
    unsubscribe,
  };
}

export async function revealSpeechOutput(
  request: RevealAudioOutputRequest,
): Promise<AudioIpcResult<RevealAudioOutputResult>> {
  try {
    return invokeAudioIpc<RevealAudioOutputResult>(
      AUDIO_IPC_CHANNELS.revealOutput,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export function cancelSpeechSynthesisStream(request: {
  requestId: string;
}): Promise<AudioIpcResult<CancelSpeechSynthesisStreamResult>> {
  try {
    return invokeAudioIpc<CancelSpeechSynthesisStreamResult>(
      AUDIO_IPC_CHANNELS.cancelSpeechSynthesisStream,
      request,
    );
  } catch (error) {
    return Promise.resolve(
      audioIpcUnavailableResult<CancelSpeechSynthesisStreamResult>(error),
    );
  }
}

export function subscribeSpeechSynthesisStreamEvents(
  requestId: string,
  handlers: SpeechSynthesisStreamHandlers,
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    if (!isSpeechSynthesisStreamEventPayload(payload)) return;
    if (payload.requestId !== requestId) return;

    handlers.any?.(payload);
    dispatchSpeechSynthesisStreamEvent(handlers, payload);
  };

  window.audioApi.on(AUDIO_EVENT_CHANNELS.speechSynthesisStream, listener);
  return () => {
    window.audioApi.off(AUDIO_EVENT_CHANNELS.speechSynthesisStream, listener);
  };
}

export async function readSpeechOutput(
  outputToken: string,
): Promise<AudioIpcResult<ReadAudioOutputResult>> {
  try {
    return invokeAudioIpc<ReadAudioOutputResult>(AUDIO_IPC_CHANNELS.readOutput, {
      outputToken,
    });
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

function dispatchSpeechSynthesisStreamEvent(
  handlers: SpeechSynthesisStreamHandlers,
  event: SpeechSynthesisStreamEvent,
): void {
  switch (event.type) {
    case "started":
      handlers.started?.(event);
      break;
    case "audio_delta":
      handlers.audioDelta?.(event);
      break;
    case "text_delta":
      handlers.textDelta?.(event);
      break;
    case "metadata":
      handlers.metadata?.(event);
      break;
    case "completed":
      handlers.completed?.(event);
      break;
    case "error":
      handlers.error?.(event);
      break;
  }
}

function createAudioRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `audio_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
