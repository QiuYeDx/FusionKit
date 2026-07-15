import {
  type AudioApiDialect,
  type AudioApiProfile,
  type AudioAssignmentKey,
  type AudioCapability,
  type AudioProviderPreset,
  type AudioRoute,
  type AudioTaskAssignment,
  type SpeechSynthesisMode,
} from "@/type/audio";
import {
  isAudioRouteTransportSupported,
  resolveAudioApiRoute,
} from "@/lib/audio-provider-registry";

export type AudioToolConfigStatus =
  | "ready"
  | "audio_api_not_configured"
  | "audio_route_not_configured";

export interface AudioToolConfigSummary {
  assignmentKey: AudioAssignmentKey;
  status: AudioToolConfigStatus;
  profileId?: string;
  profileName?: string;
  audioDialect?: AudioApiDialect;
  modelKey?: string;
  capabilities: AudioCapability[];
  providerPreset?: AudioProviderPreset;
  availableModes?: SpeechSynthesisMode[];
  activeMode?: SpeechSynthesisMode;
  migrationNeedsAttention?: boolean;
  route?: AudioRoute;
}

export interface StandaloneAudioToolConfigState {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
}

export type StandaloneAudioToolConfigSummarySelector = (
  state: StandaloneAudioToolConfigState,
) => AudioToolConfigSummary;

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

  return {
    ...baseSummary,
    status: "ready",
    audioDialect: route.transport,
    modelKey: route.model,
    route,
    capabilities: getStandaloneAudioCapabilities(assignmentKey),
  };
}

/** Keeps React external-store snapshots stable while relevant slices are unchanged. */
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
