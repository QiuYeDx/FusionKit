import type {
  AudioTranscriptionResult,
  CreateAudioTranscriptionRequest,
} from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcResult,
  type CancelAudioTranscriptionResult,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
} from "@/type/audioIpc";
import {
  audioIpcUnavailableResult,
  invokeAudioIpc,
  syncAudioRuntimeConfigBeforeTask,
} from "./audioRuntimeConfigService";

export async function transcribeAudio(
  request: CreateAudioTranscriptionRequest,
): Promise<AudioIpcResult<AudioTranscriptionResult>> {
  try {
    const synced = await syncAudioRuntimeConfigBeforeTask();
    if (!synced.ok) return audioIpcFailure(synced.error);

    return invokeAudioIpc<AudioTranscriptionResult>(
      AUDIO_IPC_CHANNELS.transcribe,
      request,
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
