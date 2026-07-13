import useAudioApiStore from "@/store/useAudioApiStore";
import type { AudioRouteKey } from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcChannel,
  type AudioIpcResult,
  type AudioRuntimeApiProfileSnapshot,
  type AuthorizedAudioInputFile,
  type SyncAudioRuntimeConfigRequest,
  type SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";

type AudioApiStoreSnapshot = ReturnType<typeof useAudioApiStore.getState>;
let currentAudioRuntimeRevision: string | undefined;
let currentAudioRuntimeSnapshotKey: string | undefined;
let currentAudioRuntimeSyncResult:
  | AudioIpcResult<SyncAudioRuntimeConfigResult>
  | undefined;
let currentAudioRuntimeSyncGeneration = 0;
let pendingAudioRuntimeSync:
  | {
      snapshotKey: string;
      promise: Promise<AudioIpcResult<SyncAudioRuntimeConfigResult>>;
    }
  | undefined;

export function createAudioRuntimeConfigSnapshotFromStore(
  state: Pick<AudioApiStoreSnapshot, "profiles" | "assignment">,
): SyncAudioRuntimeConfigRequest {
  return {
    profiles: state.profiles.map(toRuntimeAudioProfileSnapshot),
    assignment: { ...state.assignment },
  };
}

export async function syncAudioRuntimeConfigFromStore(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  while (true) {
    const snapshot = createAudioRuntimeConfigSnapshotFromStore(
      useAudioApiStore.getState(),
    );
    const snapshotKey = JSON.stringify(snapshot);
    if (
      snapshotKey === currentAudioRuntimeSnapshotKey &&
      currentAudioRuntimeSyncResult?.ok
    ) {
      return currentAudioRuntimeSyncResult;
    }

    const pending = pendingAudioRuntimeSync;
    if (pending) {
      const pendingResult = await pending.promise;
      const latestSnapshotKey = getCurrentAudioRuntimeSnapshotKey();
      if (!pendingResult.ok && latestSnapshotKey === pending.snapshotKey) {
        return pendingResult;
      }
      continue;
    }

    const generation = currentAudioRuntimeSyncGeneration;
    const syncPromise = getAudioApi().invoke<SyncAudioRuntimeConfigResult>(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      snapshot,
    );
    pendingAudioRuntimeSync = { snapshotKey, promise: syncPromise };
    let result: AudioIpcResult<SyncAudioRuntimeConfigResult>;
    try {
      result = await syncPromise;
    } finally {
      if (pendingAudioRuntimeSync?.promise === syncPromise) {
        pendingAudioRuntimeSync = undefined;
      }
    }

    const latestSnapshotKey = getCurrentAudioRuntimeSnapshotKey();
    if (
      result.ok &&
      generation === currentAudioRuntimeSyncGeneration &&
      latestSnapshotKey === snapshotKey
    ) {
      currentAudioRuntimeRevision = result.data.revision;
      currentAudioRuntimeSnapshotKey = snapshotKey;
      currentAudioRuntimeSyncResult = result;
      return result;
    }

    currentAudioRuntimeRevision = undefined;
    currentAudioRuntimeSnapshotKey = undefined;
    currentAudioRuntimeSyncResult = undefined;
    if (!result.ok && latestSnapshotKey === snapshotKey) return result;
  }
}

export async function syncAudioRuntimeConfigBeforeTask(): Promise<
  AudioIpcResult<SyncAudioRuntimeConfigResult>
> {
  return syncAudioRuntimeConfigFromStore();
}

export async function invokeAudioTaskIpc<TResponse>(
  channel: AudioIpcChannel,
  request: unknown,
): Promise<AudioIpcResult<TResponse>> {
  let synced = await syncAudioRuntimeConfigFromStore();
  if (!synced.ok) return audioIpcFailure(synced.error);

  let result = await invokeAudioIpc<TResponse>(
    channel,
    request,
    synced.data.revision,
  );
  if (result.ok || result.error.code !== "stale_audio_config") {
    return result;
  }

  invalidateAudioRuntimeConfigCache();
  synced = await syncAudioRuntimeConfigFromStore();
  if (!synced.ok) return audioIpcFailure(synced.error);
  result = await invokeAudioIpc<TResponse>(
    channel,
    request,
    synced.data.revision,
  );
  return result;
}

export function invokeAudioIpc<TResponse>(
  channel: AudioIpcChannel,
  request: unknown,
  configRevision = currentAudioRuntimeRevision,
): Promise<AudioIpcResult<TResponse>> {
  return getAudioApi().invoke<TResponse>(channel, request, {
    ...(configRevision ? { configRevision } : {}),
  });
}

export function authorizeAudioInputFile(
  file: File,
): Promise<AudioIpcResult<AuthorizedAudioInputFile>> {
  return getAudioApi().authorizeInputFile(file);
}

function toRuntimeAudioProfileSnapshot(
  profile: AudioApiStoreSnapshot["profiles"][number],
): AudioRuntimeApiProfileSnapshot {
  const verification = profile.verification
    ? Object.fromEntries(
        Object.entries(profile.verification)
          .filter(([key]) => isAudioRouteKey(key))
          .map(([key, value]) => [key, value ? { ...value } : value]),
      ) as AudioRuntimeApiProfileSnapshot["verification"]
    : undefined;
  return {
    id: profile.id,
    providerPreset: profile.providerPreset,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    routes: {
      ...(profile.routes.transcription
        ? { transcription: { ...profile.routes.transcription } }
        : {}),
      speechSynthesis: Object.fromEntries(
        Object.entries(profile.routes.speechSynthesis).map(([mode, route]) => [
          mode,
          route ? { ...route } : route,
        ]),
      ),
      ...(profile.routes.realtimeCaptions
        ? { realtimeCaptions: { ...profile.routes.realtimeCaptions } }
        : {}),
      ...(profile.routes.realtimeVoice
        ? { realtimeVoice: { ...profile.routes.realtimeVoice } }
        : {}),
    },
    ...(verification && Object.keys(verification).length
      ? { verification }
      : {}),
  };
}

function isAudioRouteKey(value: string): value is AudioRouteKey {
  return (
    value === "transcription" ||
    value === "realtimeCaptions" ||
    value === "realtimeVoice" ||
    value === "speechSynthesis.preset_voice" ||
    value === "speechSynthesis.voice_design" ||
    value === "speechSynthesis.voice_clone"
  );
}

function getCurrentAudioRuntimeSnapshotKey(): string {
  return JSON.stringify(
    createAudioRuntimeConfigSnapshotFromStore(useAudioApiStore.getState()),
  );
}

function getAudioApi(): Window["audioApi"] {
  if (typeof window === "undefined" || !window.audioApi) {
    throw new Error("Audio IPC is only available in the Electron renderer.");
  }
  return window.audioApi;
}

export function invalidateAudioRuntimeConfigCache(): void {
  currentAudioRuntimeSyncGeneration += 1;
  currentAudioRuntimeRevision = undefined;
  currentAudioRuntimeSnapshotKey = undefined;
  currentAudioRuntimeSyncResult = undefined;
}

export function resetAudioRuntimeConfigCacheForTests(): void {
  invalidateAudioRuntimeConfigCache();
}

export function audioIpcUnavailableResult<TResponse>(
  error: unknown,
): AudioIpcResult<TResponse> {
  return audioIpcFailure({
    code: "network_error",
    message:
      error instanceof Error ? error.message : "Audio IPC unavailable.",
  });
}
