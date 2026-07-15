import {
  getAudioRouteKey,
  isAudioRouteTransportSupported,
  resolveAudioApiRoute,
} from "@/lib/audio-provider-registry";
import {
  DEFAULT_AUDIO_TASK_ASSIGNMENT,
  type AudioRouteResolutionResult,
  type AudioRuntimeAdapterModelConfig,
  type AudioTaskRouteIntent,
} from "@/type/audio";
import type {
  AudioRuntimeApiProfileSnapshot,
  SyncAudioRuntimeConfigRequest,
  SyncAudioRuntimeConfigResult,
} from "@/type/audioIpc";
import { Model } from "@/type/model";
import { randomUUID } from "node:crypto";

interface AudioRuntimeConfigSnapshotEntry {
  revision: string;
  snapshot: SyncAudioRuntimeConfigRequest;
}

export class AudioRuntimeConfigStore {
  private readonly snapshots = new Map<
    number,
    AudioRuntimeConfigSnapshotEntry
  >();

  sync(
    request: SyncAudioRuntimeConfigRequest,
    ownerId: number,
  ): SyncAudioRuntimeConfigResult {
    const revision = randomUUID();
    this.snapshots.set(ownerId, {
      revision,
      snapshot: cloneRuntimeConfigSnapshot(request),
    });

    return {
      synced: true,
      audioProfileCount: request.profiles.length,
      revision,
    };
  }

  isRevisionCurrent(ownerId: number, revision: string | undefined): boolean {
    if (!revision) return false;
    return this.snapshots.get(ownerId)?.revision === revision;
  }

  clearOwner(ownerId: number): void {
    this.snapshots.delete(ownerId);
  }

  resolveRoute(
    intent: AudioTaskRouteIntent,
    ownerId: number,
    revision: string | undefined,
  ): AudioRouteResolutionResult {
    const entry = this.snapshots.get(ownerId);
    if (!revision || entry?.revision !== revision) {
      return routeFailure(intent, {
        code: "stale_audio_config",
        message:
          "Audio runtime configuration is missing, stale, or belongs to another renderer.",
      });
    }

    const profileId = entry.snapshot.assignment[intent.assignmentKey];
    const profile = profileId
      ? entry.snapshot.profiles.find((candidate) => candidate.id === profileId)
      : undefined;
    if (!profile || !profile.apiKey.trim() || !profile.baseUrl.trim()) {
      return routeFailure(intent, {
        code: "audio_api_not_configured",
        message: "The assigned audio API is not configured.",
      });
    }

    const speechMode = intent.assignmentKey === "speechSynthesis"
      ? intent.mode
      : undefined;
    const routeKey = getAudioRouteKey(intent.assignmentKey, speechMode);
    const route = resolveAudioApiRoute(
      profile,
      intent.assignmentKey,
      speechMode,
    );
    if (
      !routeKey ||
      !route ||
      !isAudioRouteTransportSupported({
        preset: profile.providerPreset,
        assignmentKey: intent.assignmentKey,
        transport: route?.transport ?? "openai_audio",
        ...(speechMode ? { speechMode } : {}),
      })
    ) {
      return routeFailure(intent, {
        code: "audio_route_not_configured",
        message: "The assigned audio API does not provide the requested route.",
      });
    }

    return {
      ok: true,
      config: {
        audioProfileId: profile.id,
        providerPreset: profile.providerPreset,
        assignmentKey: intent.assignmentKey,
        routeKey,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        transport: route.transport,
        model: route.model,
      },
    };
  }
}

export const sharedAudioRuntimeConfigStore = new AudioRuntimeConfigStore();

export function createEmptyRuntimeConfigSnapshot(): SyncAudioRuntimeConfigRequest {
  return {
    profiles: [],
    assignment: { ...DEFAULT_AUDIO_TASK_ASSIGNMENT },
  };
}

export function toAudioRuntimeAdapterModelConfig(
  config: Extract<AudioRouteResolutionResult, { ok: true }>["config"],
): AudioRuntimeAdapterModelConfig {
  return {
    audioProfileId: config.audioProfileId,
    provider:
      config.providerPreset === "openai" ? Model.OpenAI : Model.Other,
    providerPreset: config.providerPreset,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    audioDialect: config.transport,
    modelKey: config.model,
  };
}

function cloneRuntimeConfigSnapshot(
  snapshot: SyncAudioRuntimeConfigRequest,
): SyncAudioRuntimeConfigRequest {
  return {
    profiles: snapshot.profiles.map(cloneRuntimeProfile),
    assignment: { ...snapshot.assignment },
  };
}

function cloneRuntimeProfile(
  profile: AudioRuntimeApiProfileSnapshot,
): AudioRuntimeApiProfileSnapshot {
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
    ...(profile.verification
      ? {
          verification: Object.fromEntries(
            Object.entries(profile.verification).map(([key, value]) => [
              key,
              value ? { ...value } : value,
            ]),
          ),
        }
      : {}),
  };
}

function routeFailure(
  intent: AudioTaskRouteIntent,
  issue: Omit<
    Extract<AudioRouteResolutionResult, { ok: false }>["issue"],
    "assignmentKey" | "mode"
  >,
): AudioRouteResolutionResult {
  return {
    ok: false,
    issue: {
      ...issue,
      assignmentKey: intent.assignmentKey,
      ...(intent.assignmentKey === "speechSynthesis"
        ? { mode: intent.mode }
        : {}),
    },
  };
}
