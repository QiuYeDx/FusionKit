import {
  getAudioModelKeyForAssignment,
  resolveAudioCapabilities,
  validateAudioCapability,
  type AudioApiDialect,
  type AudioAssignmentKey,
  type AudioCapability,
  type AudioModelAssignment,
  type AudioModelProfile,
} from "@/type/audio";
import type { Model, ModelProfile } from "@/type/model";

export type AudioToolConfigStatus =
  | "ready"
  | "profile_not_configured"
  | "connection_missing"
  | "model_missing"
  | "unsupported_capability";

export interface AudioToolConnectionSummary {
  id: string;
  name: string;
  provider: Model;
  baseUrl: string;
}

export interface AudioToolConfigSummary {
  assignmentKey: AudioAssignmentKey;
  status: AudioToolConfigStatus;
  profileId?: string;
  profileName?: string;
  audioDialect?: AudioApiDialect;
  modelKey?: string;
  capabilities: AudioCapability[];
  defaults?: AudioModelProfile["defaults"];
  connectionProfile?: AudioToolConnectionSummary;
  missingCapabilities?: AudioCapability[];
}

export interface AudioToolConfigState {
  profiles: ModelProfile[];
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;
}

export type AudioToolConfigSummarySelector = (
  state: AudioToolConfigState,
) => AudioToolConfigSummary;

export interface MimoVoicePreset {
  id: string;
  label: string;
  localeHint: "zh" | "en" | "neutral";
}

export const MIMO_VOICE_PRESETS: MimoVoicePreset[] = [
  { id: "mimo_default", label: "mimo_default", localeHint: "neutral" },
  { id: "冰糖", label: "冰糖", localeHint: "zh" },
  { id: "茉莉", label: "茉莉", localeHint: "zh" },
  { id: "苏打", label: "苏打", localeHint: "zh" },
  { id: "白桦", label: "白桦", localeHint: "zh" },
  { id: "Mia", label: "Mia", localeHint: "en" },
  { id: "Chloe", label: "Chloe", localeHint: "en" },
  { id: "Milo", label: "Milo", localeHint: "en" },
  { id: "Dean", label: "Dean", localeHint: "en" },
];

export function resolveAudioToolConfigSummary(
  state: AudioToolConfigState,
  assignmentKey: AudioAssignmentKey,
): AudioToolConfigSummary {
  const profileId = state.audioAssignment[assignmentKey];
  const audioProfile = profileId
    ? state.audioProfiles.find((profile) => profile.id === profileId)
    : undefined;

  if (!audioProfile) {
    return {
      assignmentKey,
      status: "profile_not_configured",
      capabilities: [],
    };
  }

  const capabilities = resolveAudioCapabilities(audioProfile);
  const capabilityResult = validateAudioCapability(audioProfile, assignmentKey);
  if (!capabilityResult.ok) {
    return {
      assignmentKey,
      status: "unsupported_capability",
      ...createProfileSummary(audioProfile, capabilities),
      missingCapabilities: capabilityResult.issue.missingCapabilities,
    };
  }

  const modelKey = getAudioModelKeyForAssignment(audioProfile, assignmentKey);
  if (!modelKey) {
    return {
      assignmentKey,
      status: "model_missing",
      ...createProfileSummary(audioProfile, capabilities),
    };
  }

  const connectionProfile = state.profiles.find(
    (profile) => profile.id === audioProfile.connectionProfileId,
  );
  if (!connectionProfile) {
    return {
      assignmentKey,
      status: "connection_missing",
      ...createProfileSummary(audioProfile, capabilities),
      modelKey,
    };
  }

  return {
    assignmentKey,
    status: "ready",
    ...createProfileSummary(audioProfile, capabilities),
    modelKey,
    connectionProfile: {
      id: connectionProfile.id,
      name: connectionProfile.name,
      provider: connectionProfile.provider,
      baseUrl: connectionProfile.baseUrl,
    },
  };
}

/**
 * Keeps useSyncExternalStore snapshots referentially stable while none of the
 * model slices used by the summary changed. React 19 requires a selector to
 * return the same reference for the same external-store snapshot.
 */
export function createAudioToolConfigSummarySelector(
  assignmentKey: AudioAssignmentKey,
): AudioToolConfigSummarySelector {
  let cachedProfiles: ModelProfile[] | undefined;
  let cachedAudioProfiles: AudioModelProfile[] | undefined;
  let cachedAudioAssignment: AudioModelAssignment | undefined;
  let cachedSummary: AudioToolConfigSummary | undefined;

  return (state) => {
    if (
      cachedSummary
      && cachedProfiles === state.profiles
      && cachedAudioProfiles === state.audioProfiles
      && cachedAudioAssignment === state.audioAssignment
    ) {
      return cachedSummary;
    }

    cachedProfiles = state.profiles;
    cachedAudioProfiles = state.audioProfiles;
    cachedAudioAssignment = state.audioAssignment;
    cachedSummary = resolveAudioToolConfigSummary(state, assignmentKey);
    return cachedSummary;
  };
}

function createProfileSummary(
  profile: AudioModelProfile,
  capabilities: AudioCapability[],
): Pick<
  AudioToolConfigSummary,
  | "profileId"
  | "profileName"
  | "audioDialect"
  | "capabilities"
  | "defaults"
> {
  return {
    profileId: profile.id,
    profileName: profile.name,
    audioDialect: profile.audioDialect,
    capabilities,
    defaults: profile.defaults,
  };
}
