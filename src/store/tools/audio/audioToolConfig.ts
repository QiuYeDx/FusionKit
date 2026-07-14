import {
  getAudioModelKeyForAssignment,
  resolveAudioCapabilities,
  validateAudioCapability,
  type AudioApiDialect,
  type AudioApiProfile,
  type AudioAssignmentKey,
  type AudioCapability,
  type AudioModelAssignment,
  type AudioModelProfile,
  type AudioProviderPreset,
  type AudioRoute,
  type AudioRouteVerificationStatus,
  type AudioTaskAssignment,
  type SpeechSynthesisMode,
} from "@/type/audio";
import {
  getAudioRouteKey,
  isAudioRouteTransportSupported,
  resolveAudioApiRoute,
} from "@/lib/audio-provider-registry";
import type { Model, ModelProfile } from "@/type/model";

export type AudioToolConfigStatus =
  | "ready"
  | "audio_api_not_configured"
  | "audio_route_not_configured"
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
  providerPreset?: AudioProviderPreset;
  availableModes?: SpeechSynthesisMode[];
  activeMode?: SpeechSynthesisMode;
  verificationStatus?: AudioRouteVerificationStatus | "unverified";
  migrationNeedsAttention?: boolean;
  route?: AudioRoute;
}

export interface AudioToolConfigState {
  profiles: ModelProfile[];
  audioProfiles: AudioModelProfile[];
  audioAssignment: AudioModelAssignment;
}

export type AudioToolConfigSummarySelector = (
  state: AudioToolConfigState,
) => AudioToolConfigSummary;

export interface StandaloneAudioToolConfigState {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
}

export type StandaloneAudioToolConfigSummarySelector = (
  state: StandaloneAudioToolConfigState,
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

export function resolveStandaloneAudioToolConfigSummary(
  state: StandaloneAudioToolConfigState,
  assignmentKey: AudioAssignmentKey,
): AudioToolConfigSummary {
  const profileId = state.assignment[assignmentKey];
  const profile = profileId
    ? state.profiles.find((candidate) => candidate.id === profileId)
    : undefined;
  if (!profile) {
    return {
      assignmentKey,
      status: "audio_api_not_configured",
      capabilities: [],
    };
  }

  const baseSummary = {
    assignmentKey,
    profileId: profile.id,
    profileName: profile.name,
    providerPreset: profile.providerPreset,
    migrationNeedsAttention: profile.migration?.needsAttention,
  };
  if (!profile.apiKey.trim() || !profile.baseUrl.trim()) {
    return {
      ...baseSummary,
      status: "audio_api_not_configured",
      capabilities: [],
    };
  }

  const route = assignmentKey === "speechSynthesis"
    ? undefined
    : resolveAudioApiRoute(profile, assignmentKey);
  if (
    !route ||
    !isAudioRouteTransportSupported({
      preset: profile.providerPreset,
      assignmentKey,
      transport: route.transport,
    })
  ) {
    return {
      ...baseSummary,
      status: "audio_route_not_configured",
      capabilities: [],
    };
  }

  const routeKey = getAudioRouteKey(assignmentKey);
  return {
    ...baseSummary,
    status: "ready",
    audioDialect: route.transport,
    modelKey: route.model,
    route,
    capabilities: getStandaloneAudioCapabilities(assignmentKey),
    verificationStatus: routeKey
      ? profile.verification?.[routeKey]?.status ?? "unverified"
      : "unverified",
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

export function createStandaloneAudioToolConfigSummarySelector(
  assignmentKey: AudioAssignmentKey,
): StandaloneAudioToolConfigSummarySelector {
  let cachedProfiles: AudioApiProfile[] | undefined;
  let cachedAssignment: AudioTaskAssignment | undefined;
  let cachedSummary: AudioToolConfigSummary | undefined;

  return (state) => {
    if (
      cachedSummary &&
      cachedProfiles === state.profiles &&
      cachedAssignment === state.assignment
    ) {
      return cachedSummary;
    }

    cachedProfiles = state.profiles;
    cachedAssignment = state.assignment;
    cachedSummary = resolveStandaloneAudioToolConfigSummary(
      state,
      assignmentKey,
    );
    return cachedSummary;
  };
}

function getStandaloneAudioCapabilities(
  assignmentKey: AudioAssignmentKey,
): AudioCapability[] {
  switch (assignmentKey) {
    case "transcription":
      return ["file_transcription"];
    case "speechSynthesis":
      return ["speech_synthesis"];
    case "realtimeCaptions":
      return ["realtime_transcription"];
    case "realtimeVoice":
      return ["realtime_duplex_voice"];
  }
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
