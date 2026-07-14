import type {
  AudioTranscriptionResponseFormat,
} from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AuthorizedAudioTranscriptionResult,
  type AudioIpcResult,
  type CancelAudioTranscriptionResult,
  type CreateAudioTranscriptionIpcRequest,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
  type SaveAudioTextOutputResult,
} from "@/type/audioIpc";
import {
  audioIpcUnavailableResult,
  invokeAudioTaskIpc,
  invokeAudioIpc,
  type AudioTaskInvocationOptions,
} from "./audioRuntimeConfigService";

export interface AudioTranscriptionSaveArtifact {
  content: string;
  fileName: string;
  mimeType: string;
}

export interface AudioTranscriptionSavePort {
  save(artifact: AudioTranscriptionSaveArtifact):
    | Promise<{ cancelled?: boolean }>
    | { cancelled?: boolean }
    | Promise<void>
    | void;
}

export interface SaveAudioTranscriptionResult {
  saved: boolean;
  cancelled?: boolean;
  fileName: string;
}

const AUDIO_TRANSCRIPTION_CANCEL_RETRY_DELAYS_MS = [
  25,
  75,
  150,
  500,
  1_000,
  5_000,
] as const;
const AUDIO_TRANSCRIPTION_CANCEL_TTL_MS = 2 * 60 * 1_000;
const AUDIO_TRANSCRIPTION_CANCEL_ATTEMPT_TIMEOUT_MS = 5_000;

interface PendingAudioTranscriptionCancellation {
  requestId: string;
  expiresAt: number;
  attemptCount: number;
  inFlight?: Promise<boolean>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const pendingAudioTranscriptionCancellations = new Map<
  string,
  PendingAudioTranscriptionCancellation
>();

export async function transcribeAudio(
  request: CreateAudioTranscriptionIpcRequest,
  options: AudioTaskInvocationOptions = {},
): Promise<AudioIpcResult<AuthorizedAudioTranscriptionResult>> {
  try {
    return await invokeAudioTaskIpc<AuthorizedAudioTranscriptionResult>(
      AUDIO_IPC_CHANNELS.transcribe,
      request,
      options,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function cancelAudioTranscription(
  requestId: string,
): Promise<AudioIpcResult<CancelAudioTranscriptionResult>> {
  try {
    return await invokeAudioIpc<CancelAudioTranscriptionResult>(
      AUDIO_IPC_CHANNELS.cancelTranscription,
      { requestId },
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export function queueAudioTranscriptionCancellation(
  requestId: string,
  expiresAt = Date.now() + AUDIO_TRANSCRIPTION_CANCEL_TTL_MS,
): Promise<boolean> {
  const existing = pendingAudioTranscriptionCancellations.get(requestId);
  const pending = existing ?? {
    requestId,
    expiresAt,
    attemptCount: 0,
  };
  pending.expiresAt = Math.max(pending.expiresAt, expiresAt);
  pendingAudioTranscriptionCancellations.set(requestId, pending);
  clearAudioTranscriptionCancellationRetry(pending);
  return attemptAudioTranscriptionCancellation(pending);
}

export async function flushPendingAudioTranscriptionCancellations(): Promise<void> {
  await Promise.all(
    Array.from(pendingAudioTranscriptionCancellations.values(), (pending) => {
      clearAudioTranscriptionCancellationRetry(pending);
      return attemptAudioTranscriptionCancellation(pending);
    }),
  );
}

export function settleAudioTranscriptionCancellation(requestId: string): void {
  const pending = pendingAudioTranscriptionCancellations.get(requestId);
  if (!pending) return;
  pendingAudioTranscriptionCancellations.delete(requestId);
  clearAudioTranscriptionCancellationRetry(pending);
}

export function resetAudioTranscriptionCancellationQueueForTests(): void {
  for (const pending of pendingAudioTranscriptionCancellations.values()) {
    clearAudioTranscriptionCancellationRetry(pending);
  }
  pendingAudioTranscriptionCancellations.clear();
}

function attemptAudioTranscriptionCancellation(
  pending: PendingAudioTranscriptionCancellation,
): Promise<boolean> {
  if (pending.inFlight) return pending.inFlight;
  if (Date.now() >= pending.expiresAt) {
    pendingAudioTranscriptionCancellations.delete(pending.requestId);
    return Promise.resolve(false);
  }

  pending.attemptCount += 1;
  const attempt = (async () => {
    const response = await cancelAudioTranscriptionBounded(
      pending.requestId,
    );
    if (response?.ok && response.data.cancelled) {
      pendingAudioTranscriptionCancellations.delete(pending.requestId);
      clearAudioTranscriptionCancellationRetry(pending);
      return true;
    }
    scheduleAudioTranscriptionCancellationRetry(pending);
    return false;
  })();
  pending.inFlight = attempt;
  void attempt.finally(() => {
    if (pending.inFlight === attempt) pending.inFlight = undefined;
  });
  return attempt;
}

export async function cancelAudioTranscriptionBounded(
  requestId: string,
  timeoutMs = AUDIO_TRANSCRIPTION_CANCEL_ATTEMPT_TIMEOUT_MS,
): Promise<AudioIpcResult<CancelAudioTranscriptionResult> | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cancelAudioTranscription(requestId),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(
          () => resolve(undefined),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function scheduleAudioTranscriptionCancellationRetry(
  pending: PendingAudioTranscriptionCancellation,
): void {
  if (
    pendingAudioTranscriptionCancellations.get(pending.requestId) !== pending
  ) {
    return;
  }
  if (Date.now() >= pending.expiresAt) {
    pendingAudioTranscriptionCancellations.delete(pending.requestId);
    return;
  }
  const delayIndex = Math.min(
    pending.attemptCount - 1,
    AUDIO_TRANSCRIPTION_CANCEL_RETRY_DELAYS_MS.length - 1,
  );
  const delay = Math.min(
    AUDIO_TRANSCRIPTION_CANCEL_RETRY_DELAYS_MS[delayIndex],
    Math.max(0, pending.expiresAt - Date.now()),
  );
  pending.retryTimer = setTimeout(() => {
    pending.retryTimer = undefined;
    void attemptAudioTranscriptionCancellation(pending);
  }, delay);
}

function clearAudioTranscriptionCancellationRetry(
  pending: PendingAudioTranscriptionCancellation,
): void {
  if (pending.retryTimer === undefined) return;
  clearTimeout(pending.retryTimer);
  pending.retryTimer = undefined;
}

export function createAudioTranscriptionSaveArtifact(
  result: AuthorizedAudioTranscriptionResult,
  sourceFileName?: string,
): AudioTranscriptionSaveArtifact {
  const extension = getTranscriptionSaveExtension(result.responseFormat);
  const sourceStem = normalizeDownloadStem(sourceFileName);
  return {
    content: serializeTranscriptionResult(result),
    fileName: `${sourceStem}.transcript.${extension}`,
    mimeType: getTranscriptionSaveMimeType(result.responseFormat),
  };
}

export async function saveAudioTranscriptionResult(
  result: AuthorizedAudioTranscriptionResult,
  sourceFileName?: string,
  port: AudioTranscriptionSavePort = electronSavePort,
): Promise<AudioIpcResult<SaveAudioTranscriptionResult>> {
  const artifact = createAudioTranscriptionSaveArtifact(result, sourceFileName);
  try {
    const saved = await port.save(artifact);
    return {
      ok: true,
      data: {
        saved: !saved?.cancelled,
        ...(saved?.cancelled ? { cancelled: true } : {}),
        fileName: artifact.fileName,
      },
    };
  } catch (error) {
    return audioIpcFailure({
      code: "output_write_failed",
      message:
        error instanceof Error
          ? error.message
          : "Audio transcription result could not be saved.",
    });
  }
}

export async function revealAudioOutput(
  request: RevealAudioOutputRequest,
): Promise<AudioIpcResult<RevealAudioOutputResult>> {
  try {
    return await invokeAudioIpc<RevealAudioOutputResult>(
      AUDIO_IPC_CHANNELS.revealOutput,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function saveAudioTextOutput(request: {
  defaultName: string;
  content: string;
  extension: "txt" | "json" | "srt" | "vtt";
}): Promise<AudioIpcResult<SaveAudioTextOutputResult>> {
  try {
    return await invokeAudioIpc<SaveAudioTextOutputResult>(
      AUDIO_IPC_CHANNELS.saveTextOutput,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

const electronSavePort: AudioTranscriptionSavePort = {
  async save(artifact) {
    const extension = artifact.fileName.split(".").pop();
    const result = await invokeAudioIpc<SaveAudioTextOutputResult>(
      AUDIO_IPC_CHANNELS.saveTextOutput,
      {
        defaultName: artifact.fileName,
        content: artifact.content,
        extension:
          extension === "json" || extension === "srt" || extension === "vtt"
            ? extension
            : "txt",
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    return { cancelled: result.data.cancelled };
  },
};

function serializeTranscriptionResult(
  result: AuthorizedAudioTranscriptionResult,
): string {
  if (
    (result.responseFormat === "json" ||
      result.responseFormat === "verbose_json") &&
    result.rawJson !== undefined
  ) {
    return JSON.stringify(result.rawJson, null, 2);
  }
  return result.rawText ?? result.text;
}

function getTranscriptionSaveExtension(
  responseFormat: AudioTranscriptionResponseFormat,
): string {
  return responseFormat === "json" || responseFormat === "verbose_json"
    ? "json"
    : responseFormat;
}

function getTranscriptionSaveMimeType(
  responseFormat: AudioTranscriptionResponseFormat,
): string {
  if (responseFormat === "json" || responseFormat === "verbose_json") {
    return "application/json;charset=utf-8";
  }
  if (responseFormat === "vtt") return "text/vtt;charset=utf-8";
  if (responseFormat === "srt") return "application/x-subrip;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function normalizeDownloadStem(sourceFileName?: string): string {
  const fileName = sourceFileName?.split(/[\\/]/).pop()?.trim() ?? "";
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const safeStem = stem.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  return safeStem || "fusionkit-audio";
}
