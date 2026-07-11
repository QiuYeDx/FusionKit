import type {
  AudioTranscriptionResult,
  AudioTranscriptionResponseFormat,
} from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcResult,
  type CancelAudioTranscriptionResult,
  type CreateAudioTranscriptionIpcRequest,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
  type SaveAudioTextOutputResult,
} from "@/type/audioIpc";
import {
  audioIpcUnavailableResult,
  invokeAudioIpc,
  syncAudioRuntimeConfigBeforeTask,
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

export async function transcribeAudio(
  request: CreateAudioTranscriptionIpcRequest,
): Promise<AudioIpcResult<AudioTranscriptionResult>> {
  try {
    const synced = await syncAudioRuntimeConfigBeforeTask();
    if (!synced.ok) return audioIpcFailure(synced.error);

    return invokeAudioIpc<AudioTranscriptionResult>(
      AUDIO_IPC_CHANNELS.transcribe,
      request,
      synced.data.revision,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export async function cancelAudioTranscription(
  requestId: string,
): Promise<AudioIpcResult<CancelAudioTranscriptionResult>> {
  try {
    return invokeAudioIpc<CancelAudioTranscriptionResult>(
      AUDIO_IPC_CHANNELS.cancelTranscription,
      { requestId },
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export function createAudioTranscriptionSaveArtifact(
  result: AudioTranscriptionResult,
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
  result: AudioTranscriptionResult,
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
    return invokeAudioIpc<RevealAudioOutputResult>(
      AUDIO_IPC_CHANNELS.revealOutput,
      request,
    );
  } catch (error) {
    return audioIpcUnavailableResult(error);
  }
}

export function saveAudioTextOutput(request: {
  defaultName: string;
  content: string;
  extension: "txt" | "json" | "srt" | "vtt";
}): Promise<AudioIpcResult<SaveAudioTextOutputResult>> {
  try {
    return invokeAudioIpc<SaveAudioTextOutputResult>(
      AUDIO_IPC_CHANNELS.saveTextOutput,
      request,
    );
  } catch (error) {
    return Promise.resolve(audioIpcUnavailableResult(error));
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

function serializeTranscriptionResult(result: AudioTranscriptionResult): string {
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
