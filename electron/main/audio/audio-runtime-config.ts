import type {
  AudioAssignmentKey,
  AudioRuntimeModelConfigResult,
} from "@/type/audio";
import { resolveAudioRuntimeModelConfig } from "@/type/audio";
import type {
  SyncAudioRuntimeConfigRequest,
  SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";

export class AudioRuntimeConfigStore {
  private snapshot = createEmptyRuntimeConfigSnapshot();

  sync(request: SyncAudioRuntimeConfigRequest): SyncAudioRuntimeConfigResult {
    this.snapshot = {
      connectionProfiles: [...request.connectionProfiles],
      audioProfiles: [...request.audioProfiles],
      audioAssignment: { ...request.audioAssignment },
    };

    return {
      synced: true,
      audioProfileCount: request.audioProfiles.length,
    };
  }

  resolveModel(assignmentKey: AudioAssignmentKey): AudioRuntimeModelConfigResult {
    const audioProfileId = this.snapshot.audioAssignment[assignmentKey];
    const audioProfile = audioProfileId
      ? this.snapshot.audioProfiles.find(
          (profile) => profile.id === audioProfileId,
        )
      : null;
    const connectionProfile = audioProfile
      ? this.snapshot.connectionProfiles.find(
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
