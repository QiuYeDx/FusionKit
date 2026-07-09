import type {
  AudioRealtimeSessionCloseReason,
  AudioRealtimeSessionConfig,
} from "@/type/audio";
import {
  AUDIO_EVENT_CHANNELS,
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  isAudioRealtimeSessionEventPayload,
  type AudioIpcError,
  type AudioIpcResult,
  type AudioRealtimeSessionEvent,
  type RealtimeEphemeralSessionResult,
  type StopAudioRealtimeSessionRequest,
  type StopAudioRealtimeSessionResult,
  type TranscribeRecordedAudioChunkRequest,
  type TranscribeRecordedAudioChunkResult,
  type CancelRecordedAudioChunkTranscriptionResult,
} from "@/type/audioIpc";
import {
  audioIpcUnavailableResult,
  invokeAudioIpc,
  syncAudioRuntimeConfigBeforeTask,
} from "./audioRuntimeConfigService";

export interface AudioRealtimeSessionHandlers {
  sessionStarted?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "session_started" }>,
  ) => void;
  micState?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "mic_state" }>,
  ) => void;
  transcriptDelta?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "transcript_delta" }>,
  ) => void;
  transcriptFinal?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "transcript_final" }>,
  ) => void;
  audioStarted?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "audio_started" }>,
  ) => void;
  audioStopped?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "audio_stopped" }>,
  ) => void;
  responseStarted?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "response_started" }>,
  ) => void;
  responseCompleted?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "response_completed" }>,
  ) => void;
  error?: (event: Extract<AudioRealtimeSessionEvent, { type: "error" }>) => void;
  sessionClosed?: (
    event: Extract<AudioRealtimeSessionEvent, { type: "session_closed" }>,
  ) => void;
  any?: (event: AudioRealtimeSessionEvent) => void;
}

export interface OpenAIRealtimeWebRtcSessionOptions {
  handlers?: AudioRealtimeSessionHandlers;
  remoteAudioElement?: HTMLAudioElement;
  peerConnectionFactory?: () => RTCPeerConnection;
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  fetchSdp?: (
    url: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "ok" | "status" | "text">>;
  signal?: AbortSignal;
}

export interface AudioRealtimeSessionHandle {
  sessionId?: string;
  closed: boolean;
  setMuted: (muted: boolean) => void;
  sendClientEvent: (event: Record<string, unknown>) => boolean;
  stop: (reason?: AudioRealtimeSessionCloseReason) => Promise<void>;
}

interface AudioRealtimeSessionResources {
  sessionId?: string;
  peerConnection?: Pick<RTCPeerConnection, "close">;
  dataChannel?: Pick<RTCDataChannel, "close"> & Partial<Pick<RTCDataChannel, "send">>;
  mediaStream?: Pick<MediaStream, "getTracks">;
  onEvent?: (event: AudioRealtimeSessionEvent) => void;
  stopRemoteSession?: (
    request: StopAudioRealtimeSessionRequest,
  ) => Promise<AudioIpcResult<StopAudioRealtimeSessionResult>>;
}

export async function createRealtimeEphemeralSession(
  request: AudioRealtimeSessionConfig,
): Promise<AudioIpcResult<RealtimeEphemeralSessionResult>> {
  try {
    const synced = await syncAudioRuntimeConfigBeforeTask();
    if (!synced.ok) return audioIpcFailure(synced.error);

    return invokeAudioIpc<RealtimeEphemeralSessionResult>(
      AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function stopRealtimeSession(
  request: StopAudioRealtimeSessionRequest,
): Promise<AudioIpcResult<StopAudioRealtimeSessionResult>> {
  try {
    return invokeAudioIpc<StopAudioRealtimeSessionResult>(
      AUDIO_IPC_CHANNELS.realtimeStopSession,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function transcribeRecordedAudioChunk(
  request: TranscribeRecordedAudioChunkRequest,
): Promise<AudioIpcResult<TranscribeRecordedAudioChunkResult>> {
  try {
    const synced = await syncAudioRuntimeConfigBeforeTask();
    if (!synced.ok) return audioIpcFailure(synced.error);

    return invokeAudioIpc<TranscribeRecordedAudioChunkResult>(
      AUDIO_IPC_CHANNELS.transcribeRecordedChunk,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function cancelRecordedAudioChunkTranscription(
  requestId: string,
): Promise<AudioIpcResult<CancelRecordedAudioChunkTranscriptionResult>> {
  try {
    return invokeAudioIpc<CancelRecordedAudioChunkTranscriptionResult>(
      AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription,
      { requestId },
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function startOpenAIRealtimeWebRtcSession(
  config: AudioRealtimeSessionConfig,
  options: OpenAIRealtimeWebRtcSessionOptions = {},
): Promise<AudioIpcResult<AudioRealtimeSessionHandle>> {
  const emit = (event: AudioRealtimeSessionEvent) => {
    options.handlers?.any?.(event);
    dispatchAudioRealtimeSessionEvent(options.handlers ?? {}, event);
  };

  emit({ type: "mic_state", state: "requesting" });

  const credentialResult = await createRealtimeEphemeralSession(config);
  if (!credentialResult.ok) {
    return audioIpcFailure(credentialResult.error);
  }
  const credentials = credentialResult.data;

  let stream: MediaStream;
  try {
    stream = await resolveGetUserMedia(options)({ audio: true });
    emit({ type: "mic_state", state: "granted" });
  } catch (error) {
    const ipcError: AudioIpcError = {
      code: "microphone_permission_denied",
      message: error instanceof Error
        ? error.message
        : "Microphone permission was denied.",
    };
    emit({ type: "mic_state", state: "denied" });
    emit({ type: "error", error: ipcError });
    return audioIpcFailure(ipcError);
  }

  const peerConnection = resolvePeerConnectionFactory(options)();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  const handle = createAudioRealtimeSessionHandle({
    sessionId: credentials.sessionId,
    peerConnection,
    dataChannel,
    mediaStream: stream,
    onEvent: emit,
  });

  dataChannel.addEventListener("message", (event) => {
    for (const mappedEvent of mapOpenAIRealtimeServerEvent(event.data)) {
      emit(mappedEvent);
    }
  });
  dataChannel.addEventListener("error", () => {
    emit({
      type: "error",
      error: {
        code: "realtime_session_failed",
        message: "OpenAI Realtime data channel failed.",
      },
    });
  });

  peerConnection.addEventListener("track", (event) => {
    const [remoteStream] = event.streams;
    if (options.remoteAudioElement && remoteStream) {
      options.remoteAudioElement.srcObject = remoteStream;
    }
  });
  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const sdpResponse = await resolveFetchSdp(options)(
      credentials.realtimeCallsUrl ?? "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${credentials.clientSecret}`,
          "Content-Type": "application/sdp",
        },
        signal: options.signal,
      },
    );
    if (!sdpResponse.ok) {
      throw new Error(`OpenAI Realtime SDP exchange failed with HTTP ${sdpResponse.status}.`);
    }
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
    if (credentials.sessionId) {
      emit({ type: "session_started", sessionId: credentials.sessionId });
    }
    return { ok: true, data: handle };
  } catch (error) {
    await handle.stop("error");
    const ipcError: AudioIpcError = {
      code: "realtime_session_failed",
      message: error instanceof Error
        ? error.message
        : "OpenAI Realtime WebRTC session failed.",
    };
    emit({ type: "error", error: ipcError });
    return audioIpcFailure(ipcError);
  }
}

export function createAudioRealtimeSessionHandle(
  resources: AudioRealtimeSessionResources,
): AudioRealtimeSessionHandle {
  let closed = false;
  return {
    sessionId: resources.sessionId,
    get closed() {
      return closed;
    },
    setMuted: (muted) => {
      for (const track of resources.mediaStream?.getTracks() ?? []) {
        if (track.kind === "audio") {
          track.enabled = !muted;
        }
      }
      resources.onEvent?.({
        type: "mic_state",
        state: muted ? "muted" : "granted",
      });
    },
    sendClientEvent: (event) => {
      if (closed || typeof resources.dataChannel?.send !== "function") {
        return false;
      }
      try {
        resources.dataChannel.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    },
    stop: async (reason = "user") => {
      if (closed) return;
      closed = true;
      safeClose(resources.dataChannel);
      safeClose(resources.peerConnection);
      for (const track of resources.mediaStream?.getTracks() ?? []) {
        track.stop();
      }
      resources.onEvent?.({ type: "session_closed", reason });
      if (resources.sessionId) {
        await (resources.stopRemoteSession ?? stopRealtimeSession)({
          sessionId: resources.sessionId,
          reason,
        });
      }
    },
  };
}

export function subscribeAudioRealtimeSessionEvents(
  handlers: AudioRealtimeSessionHandlers,
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    if (!isAudioRealtimeSessionEventPayload(payload)) return;
    dispatchAudioRealtimeSessionEvent(handlers, payload);
  };

  window.ipcRenderer.on(AUDIO_EVENT_CHANNELS.realtimeSessionEvent, listener);
  return () => {
    window.ipcRenderer.off(AUDIO_EVENT_CHANNELS.realtimeSessionEvent, listener);
  };
}

export function mapOpenAIRealtimeServerEvent(
  rawEvent: unknown,
): AudioRealtimeSessionEvent[] {
  const event = parseRealtimeServerEvent(rawEvent);
  if (!event) return [];

  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const session = isRecord(event.session) ? event.session : event;
      const sessionId = firstString(session.id, event.session_id);
      return sessionId ? [{ type: "session_started", sessionId }] : [];
    }
    case "conversation.item.input_audio_transcription.delta": {
      const text = firstString(event.delta);
      return text ? [{ type: "transcript_delta", role: "user", text }] : [];
    }
    case "conversation.item.input_audio_transcription.completed": {
      const text = firstString(event.transcript);
      return text
        ? [
            {
              type: "transcript_final",
              role: "user",
              text,
              ...(firstString(event.item_id) ? { itemId: firstString(event.item_id) } : {}),
            },
          ]
        : [];
    }
    case "response.created": {
      const response = isRecord(event.response) ? event.response : event;
      const responseId = firstString(response.id, event.response_id);
      return responseId ? [{ type: "response_started", responseId }] : [];
    }
    case "response.done": {
      const response = isRecord(event.response) ? event.response : event;
      const responseId = firstString(response.id, event.response_id);
      return responseId ? [{ type: "response_completed", responseId }] : [];
    }
    case "response.audio_transcript.delta": {
      const text = firstString(event.delta);
      return text ? [{ type: "transcript_delta", role: "assistant", text }] : [];
    }
    case "response.audio_transcript.done": {
      const text = firstString(event.transcript);
      return text
        ? [{ type: "transcript_final", role: "assistant", text }]
        : [];
    }
    case "response.audio.delta":
      return [{ type: "audio_started", role: "assistant" }];
    case "response.audio.done":
      return [{ type: "audio_stopped", role: "assistant" }];
    case "error":
      return [
        {
          type: "error",
          error: {
            code: "realtime_session_failed",
            message: firstString(
              isRecord(event.error) ? event.error.message : undefined,
              event.message,
            ) ?? "OpenAI Realtime session failed.",
          },
        },
      ];
    default:
      return [];
  }
}

function dispatchAudioRealtimeSessionEvent(
  handlers: AudioRealtimeSessionHandlers,
  event: AudioRealtimeSessionEvent,
): void {
  switch (event.type) {
    case "session_started":
      handlers.sessionStarted?.(event);
      break;
    case "mic_state":
      handlers.micState?.(event);
      break;
    case "transcript_delta":
      handlers.transcriptDelta?.(event);
      break;
    case "transcript_final":
      handlers.transcriptFinal?.(event);
      break;
    case "audio_started":
      handlers.audioStarted?.(event);
      break;
    case "audio_stopped":
      handlers.audioStopped?.(event);
      break;
    case "response_started":
      handlers.responseStarted?.(event);
      break;
    case "response_completed":
      handlers.responseCompleted?.(event);
      break;
    case "error":
      handlers.error?.(event);
      break;
    case "session_closed":
      handlers.sessionClosed?.(event);
      break;
  }
}

function resolvePeerConnectionFactory(
  options: OpenAIRealtimeWebRtcSessionOptions,
): () => RTCPeerConnection {
  if (options.peerConnectionFactory) return options.peerConnectionFactory;
  return () => new RTCPeerConnection();
}

function resolveGetUserMedia(
  options: OpenAIRealtimeWebRtcSessionOptions,
): (constraints: MediaStreamConstraints) => Promise<MediaStream> {
  if (options.getUserMedia) return options.getUserMedia;
  return (constraints) => navigator.mediaDevices.getUserMedia(constraints);
}

function resolveFetchSdp(
  options: OpenAIRealtimeWebRtcSessionOptions,
): (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">> {
  return options.fetchSdp ?? fetch;
}

function parseRealtimeServerEvent(rawEvent: unknown): Record<string, unknown> | null {
  if (isRecord(rawEvent)) return rawEvent;
  if (typeof rawEvent !== "string") return null;
  try {
    const parsed = JSON.parse(rawEvent);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeClose(target: { close: () => void } | undefined): void {
  try {
    target?.close();
  } catch {
    // Closing browser media resources should be best-effort during teardown.
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
