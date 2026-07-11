import useModelStore from "@/store/useModelStore";
import type { ModelProfile } from "@/type/model";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcChannel,
  type AudioIpcResult,
  type AuthorizedAudioInputFile,
  type SyncAudioRuntimeConfigRequest,
  type SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";

type ModelStoreSnapshot = ReturnType<typeof useModelStore.getState>;
let currentAudioRuntimeRevision: string | undefined;
let currentAudioRuntimeSnapshotKey: string | undefined;
let currentAudioRuntimeSyncResult: AudioIpcResult<SyncAudioRuntimeConfigResult> | undefined;

export function createAudioRuntimeConfigSnapshotFromStore(
  state: Pick<ModelStoreSnapshot, "profiles" | "audioProfiles" | "audioAssignment">,
): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: state.profiles.map(toRuntimeConnectionProfileSnapshot),
    audioProfiles: [...state.audioProfiles],
    audioAssignment: { ...state.audioAssignment },
  };
}

export async function syncAudioRuntimeConfigFromStore(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  const snapshot = createAudioRuntimeConfigSnapshotFromStore(
    useModelStore.getState(),
  );
  const snapshotKey = JSON.stringify(snapshot);
  if (
    snapshotKey === currentAudioRuntimeSnapshotKey &&
    currentAudioRuntimeSyncResult?.ok
  ) {
    return currentAudioRuntimeSyncResult;
  }
  const result = await getAudioApi().invoke<SyncAudioRuntimeConfigResult>(
    AUDIO_IPC_CHANNELS.syncRuntimeConfig,
    snapshot,
  );
  if (result.ok) {
    currentAudioRuntimeRevision = result.data.revision;
    currentAudioRuntimeSnapshotKey = snapshotKey;
    currentAudioRuntimeSyncResult = result;
  } else {
    currentAudioRuntimeSyncResult = undefined;
  }
  return result;
}

export async function syncAudioRuntimeConfigBeforeTask(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  return syncAudioRuntimeConfigFromStore();
}

export function invokeAudioIpc<TResponse>(
  channel: AudioIpcChannel,
  request: unknown,
  configRevision = currentAudioRuntimeRevision,
): Promise<AudioIpcResult<TResponse>> {
  return getAudioApi().invoke<TResponse>(channel, request, {
    ...(configRevision
      ? { configRevision }
      : {}),
  });
}

export function authorizeAudioInputFile(
  file: File,
): Promise<AudioIpcResult<AuthorizedAudioInputFile>> {
  return getAudioApi().authorizeInputFile(file);
}

function toRuntimeConnectionProfileSnapshot(profile: ModelProfile) {
  return {
    id: profile.id,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
  };
}

function getAudioApi(): Window["audioApi"] {
  if (typeof window === "undefined" || !window.audioApi) {
    throw new Error("Audio IPC is only available in the Electron renderer.");
  }
  return window.audioApi;
}

export function resetAudioRuntimeConfigCacheForTests(): void {
  currentAudioRuntimeRevision = undefined;
  currentAudioRuntimeSnapshotKey = undefined;
  currentAudioRuntimeSyncResult = undefined;
}

export function audioIpcUnavailableResult<TResponse>(
  error: unknown,
): AudioIpcResult<TResponse> {
  return audioIpcFailure({
    code: "network_error",
    message: error instanceof Error ? error.message : "Audio IPC unavailable.",
  });
}
