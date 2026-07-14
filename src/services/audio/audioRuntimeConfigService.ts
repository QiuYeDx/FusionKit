import useAudioApiStore from "@/store/useAudioApiStore";
import type { AudioRouteKey } from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  type AudioIpcChannel,
  type AudioIpcResult,
  type AudioRuntimeApiProfileSnapshot,
  type RevokeAudioInputFileResult,
  type RevokeAudioOutputDirectoryResult,
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

const AUDIO_CAPABILITY_REVOCATION_RETRY_DELAYS_MS = [
  250,
  1_000,
  5_000,
  15_000,
  60_000,
] as const;
const AUDIO_CAPABILITY_REVOCATION_FALLBACK_TTL_MS = 30 * 60 * 1_000;
const AUDIO_CAPABILITY_REVOCATION_ATTEMPT_TIMEOUT_MS = 5_000;

interface PendingAudioCapabilityRevocation {
  token: string;
  expiresAt: number;
  attemptCount: number;
  inFlight?: Promise<boolean>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const pendingAudioInputFileRevocations = new Map<
  string,
  PendingAudioCapabilityRevocation
>();
const pendingAudioOutputDirectoryRevocations = new Map<
  string,
  PendingAudioCapabilityRevocation
>();

type AudioCapabilityRevocationResult =
  | RevokeAudioInputFileResult
  | RevokeAudioOutputDirectoryResult;
type AudioCapabilityRevoker = (
  token: string,
) => Promise<AudioIpcResult<AudioCapabilityRevocationResult>>;

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

export interface AudioTaskInvocationOptions {
  signal?: AbortSignal;
  onDispatch?: () => void;
}

export async function invokeAudioTaskIpc<TResponse>(
  channel: AudioIpcChannel,
  request: unknown,
  options: AudioTaskInvocationOptions = {},
): Promise<AudioIpcResult<TResponse>> {
  let synced = await syncAudioRuntimeConfigFromStore();
  if (!synced.ok) return audioIpcFailure(synced.error);
  if (options.signal?.aborted) return audioTaskPreflightAborted();

  options.onDispatch?.();
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
  if (options.signal?.aborted) return audioTaskPreflightAborted();
  options.onDispatch?.();
  result = await invokeAudioIpc<TResponse>(
    channel,
    request,
    synced.data.revision,
  );
  return result;
}

function audioTaskPreflightAborted<TResponse>(): AudioIpcResult<TResponse> {
  return audioIpcFailure({
    code: "aborted",
    message: "Audio request was cancelled before dispatch.",
  });
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

export function revokeAudioInputFile(
  fileToken: string,
): Promise<AudioIpcResult<RevokeAudioInputFileResult>> {
  return getAudioApi().revokeInputFile(fileToken);
}

export function revokeAudioOutputDirectory(
  outputDirToken: string,
): Promise<AudioIpcResult<RevokeAudioOutputDirectoryResult>> {
  return getAudioApi().revokeOutputDirectory(outputDirToken);
}

/**
 * Retains failed revocations across SPA route changes and retries them until
 * main confirms the idempotent revoke or the capability has expired.
 */
export function queueAudioInputFileRevocation(
  fileToken: string,
  expiresAt = Date.now() + AUDIO_CAPABILITY_REVOCATION_FALLBACK_TTL_MS,
): Promise<boolean> {
  return queueAudioCapabilityRevocation(
    pendingAudioInputFileRevocations,
    fileToken,
    expiresAt,
    revokeAudioInputFile,
  );
}

export async function flushPendingAudioInputFileRevocations(): Promise<void> {
  await flushPendingAudioCapabilityRevocations(
    pendingAudioInputFileRevocations,
    revokeAudioInputFile,
  );
}

export function queueAudioOutputDirectoryRevocation(
  outputDirToken: string,
  expiresAt = Date.now() + AUDIO_CAPABILITY_REVOCATION_FALLBACK_TTL_MS,
): Promise<boolean> {
  return queueAudioCapabilityRevocation(
    pendingAudioOutputDirectoryRevocations,
    outputDirToken,
    expiresAt,
    revokeAudioOutputDirectory,
  );
}

export async function flushPendingAudioOutputDirectoryRevocations(): Promise<void> {
  await flushPendingAudioCapabilityRevocations(
    pendingAudioOutputDirectoryRevocations,
    revokeAudioOutputDirectory,
  );
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
  for (const pendingRevocations of [
    pendingAudioInputFileRevocations,
    pendingAudioOutputDirectoryRevocations,
  ]) {
    for (const pending of pendingRevocations.values()) {
      clearAudioCapabilityRevocationRetry(pending);
    }
    pendingRevocations.clear();
  }
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

function queueAudioCapabilityRevocation(
  pendingRevocations: Map<string, PendingAudioCapabilityRevocation>,
  token: string,
  expiresAt: number,
  revoke: AudioCapabilityRevoker,
): Promise<boolean> {
  const existing = pendingRevocations.get(token);
  const pending = existing ?? { token, expiresAt, attemptCount: 0 };
  pending.expiresAt = Math.max(pending.expiresAt, expiresAt);
  pendingRevocations.set(token, pending);
  clearAudioCapabilityRevocationRetry(pending);
  return attemptAudioCapabilityRevocation(pendingRevocations, pending, revoke);
}

async function flushPendingAudioCapabilityRevocations(
  pendingRevocations: Map<string, PendingAudioCapabilityRevocation>,
  revoke: AudioCapabilityRevoker,
): Promise<void> {
  await Promise.all(
    Array.from(pendingRevocations.values(), (pending) => {
      clearAudioCapabilityRevocationRetry(pending);
      return attemptAudioCapabilityRevocation(
        pendingRevocations,
        pending,
        revoke,
      );
    }),
  );
}

function attemptAudioCapabilityRevocation(
  pendingRevocations: Map<string, PendingAudioCapabilityRevocation>,
  pending: PendingAudioCapabilityRevocation,
  revoke: AudioCapabilityRevoker,
): Promise<boolean> {
  if (pending.inFlight) return pending.inFlight;
  if (Date.now() >= pending.expiresAt) {
    pendingRevocations.delete(pending.token);
    return Promise.resolve(false);
  }

  pending.attemptCount += 1;
  const attempt = (async () => {
    try {
      const response = await revokeAudioCapabilityWithTimeout(
        revoke,
        pending.token,
      );
      if (response?.ok) {
        pendingRevocations.delete(pending.token);
        clearAudioCapabilityRevocationRetry(pending);
        return true;
      }
    } catch {
      // Keep the token in the queue; the retry path handles transient IPC loss.
    }

    scheduleAudioCapabilityRevocationRetry(
      pendingRevocations,
      pending,
      revoke,
    );
    return false;
  })();
  pending.inFlight = attempt;
  void attempt.finally(() => {
    if (pending.inFlight === attempt) pending.inFlight = undefined;
  });
  return attempt;
}

async function revokeAudioCapabilityWithTimeout(
  revoke: AudioCapabilityRevoker,
  token: string,
): Promise<AudioIpcResult<AudioCapabilityRevocationResult> | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      revoke(token),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(
          () => resolve(undefined),
          AUDIO_CAPABILITY_REVOCATION_ATTEMPT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function scheduleAudioCapabilityRevocationRetry(
  pendingRevocations: Map<string, PendingAudioCapabilityRevocation>,
  pending: PendingAudioCapabilityRevocation,
  revoke: AudioCapabilityRevoker,
): void {
  if (pendingRevocations.get(pending.token) !== pending) return;
  if (Date.now() >= pending.expiresAt) {
    pendingRevocations.delete(pending.token);
    return;
  }
  const delayIndex = Math.min(
    pending.attemptCount - 1,
    AUDIO_CAPABILITY_REVOCATION_RETRY_DELAYS_MS.length - 1,
  );
  const delay = Math.min(
    AUDIO_CAPABILITY_REVOCATION_RETRY_DELAYS_MS[delayIndex],
    Math.max(0, pending.expiresAt - Date.now()),
  );
  pending.retryTimer = setTimeout(() => {
    pending.retryTimer = undefined;
    void attemptAudioCapabilityRevocation(
      pendingRevocations,
      pending,
      revoke,
    );
  }, delay);
}

function clearAudioCapabilityRevocationRetry(
  pending: PendingAudioCapabilityRevocation,
): void {
  if (pending.retryTimer === undefined) return;
  clearTimeout(pending.retryTimer);
  pending.retryTimer = undefined;
}
