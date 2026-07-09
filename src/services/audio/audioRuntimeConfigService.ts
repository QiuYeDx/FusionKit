import useModelStore from "@/store/useModelStore";
import type { ModelProfile } from "@/type/model";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcChannel,
  type AudioIpcResult,
  type SyncAudioRuntimeConfigRequest,
  type SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";

type ModelStoreSnapshot = ReturnType<typeof useModelStore.getState>;

export function createAudioRuntimeConfigSnapshotFromStore(
  state: Pick<ModelStoreSnapshot, "profiles" | "audioProfiles" | "audioAssignment">,
): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: state.profiles.map(toRuntimeConnectionProfileSnapshot),
    audioProfiles: [...state.audioProfiles],
    audioAssignment: { ...state.audioAssignment },
  };
}

export function syncAudioRuntimeConfigFromStore(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  const snapshot = createAudioRuntimeConfigSnapshotFromStore(
    useModelStore.getState(),
  );
  return invokeAudioIpc<SyncAudioRuntimeConfigResult>(
    AUDIO_IPC_CHANNELS.syncRuntimeConfig,
    snapshot,
  );
}

export async function syncAudioRuntimeConfigBeforeTask(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  return syncAudioRuntimeConfigFromStore();
}

export function invokeAudioIpc<TResponse>(
  channel: AudioIpcChannel,
  request: unknown,
): Promise<AudioIpcResult<TResponse>> {
  const ipcRenderer = getIpcRenderer();
  return ipcRenderer.invoke(channel, request) as Promise<AudioIpcResult<TResponse>>;
}

function toRuntimeConnectionProfileSnapshot(profile: ModelProfile) {
  return {
    id: profile.id,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
  };
}

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error("Audio IPC is only available in the Electron renderer.");
  }
  return window.ipcRenderer;
}

export function audioIpcUnavailableResult<TResponse>(
  error: unknown,
): AudioIpcResult<TResponse> {
  return audioIpcFailure({
    code: "network_error",
    message: error instanceof Error ? error.message : "Audio IPC unavailable.",
  });
}
