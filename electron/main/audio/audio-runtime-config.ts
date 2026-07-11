import type {
  AudioAssignmentKey,
  AudioRuntimeModelConfigResult,
} from "@/type/audio";
import { resolveAudioRuntimeModelConfig } from "@/type/audio";
import type {
  SyncAudioRuntimeConfigRequest,
  SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";
import { randomUUID } from "node:crypto";

type AudioRuntimeConfigOwner = number | "default";

interface AudioRuntimeConfigSnapshotEntry {
  revision: string;
  snapshot: SyncAudioRuntimeConfigRequest;
}

export class AudioRuntimeConfigStore {
  private readonly snapshots = new Map<
    AudioRuntimeConfigOwner,
    AudioRuntimeConfigSnapshotEntry
  >();

  sync(
    request: SyncAudioRuntimeConfigRequest,
    ownerId: AudioRuntimeConfigOwner = "default",
  ): SyncAudioRuntimeConfigResult {
    const revision = randomUUID();
    this.snapshots.set(ownerId, {
      revision,
      snapshot: {
        connectionProfiles: [...request.connectionProfiles],
        audioProfiles: [...request.audioProfiles],
        audioAssignment: { ...request.audioAssignment },
      },
    });

    return {
      synced: true,
      audioProfileCount: request.audioProfiles.length,
      revision,
    };
  }

  isRevisionCurrent(
    ownerId: AudioRuntimeConfigOwner,
    revision: string | undefined,
  ): boolean {
    if (!revision) return false;
    return this.snapshots.get(ownerId)?.revision === revision;
  }

  clearOwner(ownerId: AudioRuntimeConfigOwner): void {
    this.snapshots.delete(ownerId);
  }

  resolveModel(
    assignmentKey: AudioAssignmentKey,
    ownerId: AudioRuntimeConfigOwner = "default",
  ): AudioRuntimeModelConfigResult {
    const snapshot =
      this.snapshots.get(ownerId)?.snapshot ?? createEmptyRuntimeConfigSnapshot();
    const audioProfileId = snapshot.audioAssignment[assignmentKey];
    const audioProfile = audioProfileId
      ? snapshot.audioProfiles.find(
          (profile) => profile.id === audioProfileId,
        )
      : null;
    const connectionProfile = audioProfile
      ? snapshot.connectionProfiles.find(
          (profile) => profile.id === audioProfile.connectionProfileId,
        )
      : null;

    return resolveAudioRuntimeModelConfig({
      audioProfile,
      connectionProfile,
      assignmentKey,
    });
  }
}

export const sharedAudioRuntimeConfigStore = new AudioRuntimeConfigStore();

export function createEmptyRuntimeConfigSnapshot(): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: [],
    audioProfiles: [],
    audioAssignment: {
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: null,
    },
  };
}
