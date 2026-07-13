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
  invokeAudioTaskIpc,
  invokeAudioIpc,
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
  onInputLevel?: (level: number) => void;
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
  stopInputLevelMonitor?: () => void;
}

export async function createRealtimeEphemeralSession(
  request: AudioRealtimeSessionConfig,
): Promise<AudioIpcResult<RealtimeEphemeralSessionResult>> {
  try {
    return await invokeAudioTaskIpc<RealtimeEphemeralSessionResult>(
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
    return await invokeAudioIpc<StopAudioRealtimeSessionResult>(
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
    return await invokeAudioTaskIpc<TranscribeRecordedAudioChunkResult>(
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
    return await invokeAudioIpc<CancelRecordedAudioChunkTranscriptionResult>(
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

  if (options.signal?.aborted) {
    return abortedRealtimeSessionResult();
  }
  emit({ type: "mic_state", state: "requesting" });

  const credentialResult = await createRealtimeEphemeralSession(config);
  if (!credentialResult.ok) {
    if (options.signal?.aborted) {
      return abortedRealtimeSessionResult();
    }
    return audioIpcFailure(credentialResult.error);
  }
  const credentials = credentialResult.data;
  if (options.signal?.aborted) {
    await stopPendingRealtimeSession(credentials.sessionId);
    return abortedRealtimeSessionResult();
  }

  let stream: MediaStream;
  try {
    stream = await resolveGetUserMedia(options)({ audio: true });
  } catch (error) {
    await stopPendingRealtimeSession(credentials.sessionId);
    if (options.signal?.aborted || isAbortError(error)) {
      return abortedRealtimeSessionResult();
    }
    const ipcError: AudioIpcError = {
      code: "microphone_permission_denied",
      message: error instanceof Error
        ? error.message
        : "Microphone permission was denied.",
    };
    emit({ type: "mic_state", state: "denied" });
    emit({ type: "error", error: ipcError, fatal: true });
    return audioIpcFailure(ipcError);
  }

  if (options.signal?.aborted) {
    stopMediaStream(stream);
    await stopPendingRealtimeSession(credentials.sessionId);
    return abortedRealtimeSessionResult();
  }
  emit({ type: "mic_state", state: "granted" });

  const peerConnection = resolvePeerConnectionFactory(options)();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  const stopInputLevelMonitor = createInputLevelMonitor(
    stream,
    options.onInputLevel,
  );
  const handle = createAudioRealtimeSessionHandle({
    sessionId: credentials.sessionId,
    peerConnection,
    dataChannel,
    mediaStream: stream,
    onEvent: emit,
    stopInputLevelMonitor,
  });
  let failureStarted = false;
  let failureMessage: string | undefined;
  const failSession = (message: string) => {
    if (failureStarted || handle.closed) return;
    failureStarted = true;
    failureMessage = message;
    emit({
      type: "error",
      fatal: true,
      error: {
        code: "realtime_session_failed",
        message,
      },
    });
    void handle.stop("error");
  };

  dataChannel.addEventListener("message", (event) => {
    if (handle.closed) return;
    for (const mappedEvent of mapOpenAIRealtimeServerEvent(event.data)) {
      emit(mappedEvent);
    }
  });
  dataChannel.addEventListener("error", () => {
    failSession("OpenAI Realtime data channel failed.");
  });
  dataChannel.addEventListener("close", () => {
    failSession("OpenAI Realtime data channel closed unexpectedly.");
  });
  peerConnection.addEventListener("connectionstatechange", () => {
    if (peerConnection.connectionState === "failed") {
      failSession("OpenAI Realtime peer connection failed.");
    } else if (peerConnection.connectionState === "closed") {
      failSession("OpenAI Realtime peer connection closed unexpectedly.");
    }
  });
  peerConnection.addEventListener("iceconnectionstatechange", () => {
    if (peerConnection.iceConnectionState === "failed") {
      failSession("OpenAI Realtime ICE connection failed.");
    } else if (peerConnection.iceConnectionState === "closed") {
      failSession("OpenAI Realtime ICE connection closed unexpectedly.");
    }
  });

  peerConnection.addEventListener("track", (event) => {
    if (handle.closed) return;
    const [remoteStream] = event.streams;
    if (options.remoteAudioElement && remoteStream) {
      options.remoteAudioElement.srcObject = remoteStream;
    }
  });
  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  try {
    throwIfAborted(options.signal);
    const offer = await peerConnection.createOffer();
    throwIfAborted(options.signal);
    await peerConnection.setLocalDescription(offer);
    throwIfAborted(options.signal);
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
    throwIfAborted(options.signal);
    const answerSdp = await sdpResponse.text();
    throwIfAborted(options.signal);
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
    throwIfAborted(options.signal);
    if (failureStarted || handle.closed) {
      throw new Error(
        failureMessage ?? "OpenAI Realtime session closed during startup.",
      );
    }
    if (credentials.sessionId) {
      emit({ type: "session_started", sessionId: credentials.sessionId });
    }
    return { ok: true, data: handle };
  } catch (error) {
    const aborted = options.signal?.aborted || isAbortError(error);
    await handle.stop(aborted ? "page_unload" : "error");
    if (aborted) {
      return abortedRealtimeSessionResult();
    }
    if (failureStarted) {
      return audioIpcFailure({
        code: "realtime_session_failed",
        message: failureMessage ?? "OpenAI Realtime session failed during startup.",
      });
    }
    const ipcError: AudioIpcError = {
      code: "realtime_session_failed",
      message: error instanceof Error
        ? error.message
        : "OpenAI Realtime WebRTC session failed.",
    };
    emit({ type: "error", error: ipcError, fatal: true });
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
      stopMediaStream(resources.mediaStream);
      resources.stopInputLevelMonitor?.();
      resources.onEvent?.({ type: "session_closed", reason });
      if (resources.sessionId) {
        try {
          await (resources.stopRemoteSession ?? stopRealtimeSession)({
            sessionId: resources.sessionId,
            reason,
          });
        } catch {
          // Local media ownership is already released; remote cleanup is best-effort.
        }
      }
    },
  };
}

function createInputLevelMonitor(
  stream: MediaStream,
  onLevel: ((level: number) => void) | undefined,
): (() => void) | undefined {
  if (!onLevel || typeof window === "undefined" || !window.AudioContext) {
    return undefined;
  }
  let context: AudioContext | undefined;
  let timer: number | undefined;
  try {
    context = new window.AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      onLevel(Math.min(1, Math.sqrt(sumSquares / samples.length) * 3));
    }, 100);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      source.disconnect();
      void context?.close().catch(() => undefined);
      onLevel(0);
    };
  } catch {
    void context?.close().catch(() => undefined);
    return undefined;
  }
}

function abortedRealtimeSessionResult(): AudioIpcResult<AudioRealtimeSessionHandle> {
  return audioIpcFailure({
    code: "aborted",
    message: "OpenAI Realtime session start was aborted.",
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException("OpenAI Realtime session start was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function stopMediaStream(
  stream: Pick<MediaStream, "getTracks"> | undefined,
): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // Tracks may already be stopped by the browser or another teardown path.
    }
  }
}

async function stopPendingRealtimeSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    await stopRealtimeSession({ sessionId, reason: "page_unload" });
  } catch {
    // The ephemeral session will expire; local media has not been retained.
  }
}

export function subscribeAudioRealtimeSessionEvents(
  handlers: AudioRealtimeSessionHandlers,
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    if (!isAudioRealtimeSessionEventPayload(payload)) return;
    dispatchAudioRealtimeSessionEvent(handlers, payload);
  };

  window.audioApi.on(AUDIO_EVENT_CHANNELS.realtimeSessionEvent, listener);
  return () => {
    window.audioApi.off(AUDIO_EVENT_CHANNELS.realtimeSessionEvent, listener);
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
      return text
        ? [{
            type: "transcript_delta",
            role: "user",
            text,
            ...readRealtimeItemIdentity(event),
          }]
        : [];
    }
    case "conversation.item.input_audio_transcription.completed": {
      const text = firstString(event.transcript);
      return text
        ? [
            {
              type: "transcript_final",
              role: "user",
              text,
              ...readRealtimeItemIdentity(event),
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
      if (!responseId) return [];
      const status = normalizeRealtimeResponseStatus(response.status);
      const completed: AudioRealtimeSessionEvent = {
        type: "response_completed",
        responseId,
        status,
      };
      if (status === "completed" || status === "cancelled") return [completed];
      const statusDetails = isRecord(response.status_details)
        ? response.status_details
        : undefined;
      return [
        completed,
        {
          type: "error",
          fatal: false,
          error: {
            code: "realtime_session_failed",
            message: firstString(
              isRecord(statusDetails?.error) ? statusDetails.error.message : undefined,
              statusDetails?.reason,
            ) ?? `OpenAI Realtime response ended with status ${status}.`,
          },
        },
      ];
    }
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta": {
      const text = firstString(event.delta);
      return text
        ? [{
            type: "transcript_delta",
            role: "assistant",
            text,
            ...readRealtimeItemIdentity(event),
          }]
        : [];
    }
    case "conversation.item.input_audio_transcription.failed": {
      const error = isRecord(event.error) ? event.error : undefined;
      return [{
        type: "error",
        fatal: false,
        error: {
          code: "realtime_session_failed",
          message: firstString(error?.message, event.message) ??
            "OpenAI Realtime could not transcribe an input audio item.",
        },
      }];
    }
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done": {
      const text = firstString(event.transcript);
      return text
        ? [{
            type: "transcript_final",
            role: "assistant",
            text,
            ...readRealtimeItemIdentity(event),
          }]
        : [];
    }
    case "response.output_audio.delta":
    case "response.audio.delta":
      return [{
        type: "audio_started",
        role: "assistant",
        ...readRealtimeItemIdentity(event),
      }];
    case "response.output_audio.done":
    case "response.audio.done":
      return [{
        type: "audio_stopped",
        role: "assistant",
        ...readRealtimeItemIdentity(event),
      }];
    case "output_audio_buffer.started":
      return [{ type: "audio_started", role: "assistant" }];
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      return [{ type: "audio_stopped", role: "assistant" }];
    case "error":
      return [
        {
          type: "error",
          // Realtime API operation errors do not imply that the WebRTC
          // transport is dead. Transport listeners emit fatal errors.
          fatal: false,
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

function readRealtimeItemIdentity(event: Record<string, unknown>) {
  const itemId = firstString(event.item_id, event.itemId);
  const responseId = firstString(event.response_id, event.responseId);
  const contentIndex = finiteInteger(event.content_index);
  const outputIndex = finiteInteger(event.output_index);
  return {
    ...(itemId ? { itemId } : {}),
    ...(responseId ? { responseId } : {}),
    ...(contentIndex !== undefined ? { contentIndex } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {}),
  };
}

function normalizeRealtimeResponseStatus(
  value: unknown,
): "completed" | "cancelled" | "failed" | "incomplete" {
  if (
    value === "completed" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "incomplete"
  ) {
    return value;
  }
  return "incomplete";
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
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
