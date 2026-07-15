import { normalizeAudioEndpoint } from "@/lib/audio-endpoint";
import {
  canAudioApiHandleTask,
  createDefaultAudioApiRoutes,
  getAudioProviderDefinition,
  isAudioRouteTransportSupported,
} from "@/lib/audio-provider-registry";
import {
  AUDIO_ASSIGNMENT_KEYS,
  SPEECH_SYNTHESIS_MODES,
  type AudioApiProfile,
  type AudioApiRoutes,
  type AudioAssignmentKey,
  type AudioProviderPreset,
  type AudioRoute,
  type AudioRouteKey,
  type SpeechSynthesisMode,
} from "@/type/audio";
import type { AudioApiProfileDraft } from "@/store/useAudioApiStore";

export interface AudioApiFormState extends AudioApiProfileDraft {}

export type AudioApiFormField = "name" | "baseUrl" | "apiKey" | "routes";

export type AudioApiFormErrorCode =
  | "name_required"
  | "base_url_required"
  | "base_url_invalid"
  | "api_key_required"
  | "route_required"
  | "route_model_required"
  | "route_transport_invalid";

export interface AudioApiFormValidation {
  draft: AudioApiProfileDraft | null;
  fieldErrors: Partial<Record<AudioApiFormField, AudioApiFormErrorCode>>;
  routeErrors: Partial<Record<CustomAudioRouteKey, AudioApiFormErrorCode>>;
}

export const CUSTOM_AUDIO_ROUTE_DEFINITIONS = [
  {
    key: "transcription",
    assignmentKey: "transcription",
    transport: "openai_audio",
  },
  {
    key: "speechSynthesis.preset_voice",
    assignmentKey: "speechSynthesis",
    speechMode: "preset_voice",
    transport: "openai_audio",
  },
  {
    key: "realtimeCaptions",
    assignmentKey: "realtimeCaptions",
    transport: "openai_realtime",
  },
  {
    key: "realtimeVoice",
    assignmentKey: "realtimeVoice",
    transport: "openai_realtime",
  },
] as const;

export type CustomAudioRouteKey =
  (typeof CUSTOM_AUDIO_ROUTE_DEFINITIONS)[number]["key"];

export function createAudioApiFormState(
  profile?: AudioApiProfile | null,
  defaultPreset: AudioProviderPreset = "mimo",
): AudioApiFormState {
  if (profile) {
    return {
      name: profile.name,
      providerPreset: profile.providerPreset,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      routes: cloneRoutes(profile.routes),
    };
  }

  const definition = getAudioProviderDefinition(defaultPreset);
  return {
    name: "",
    providerPreset: defaultPreset,
    baseUrl: definition.defaultBaseUrl,
    apiKey: "",
    routes: createDefaultAudioApiRoutes(defaultPreset),
  };
}

export function applyAudioProviderPreset(
  state: AudioApiFormState,
  providerPreset: AudioProviderPreset,
): AudioApiFormState {
  if (state.providerPreset === providerPreset) return state;

  const definition = getAudioProviderDefinition(providerPreset);
  return {
    ...state,
    providerPreset,
    baseUrl: definition.defaultBaseUrl,
    apiKey: "",
    routes: createDefaultAudioApiRoutes(providerPreset),
  };
}

export function getCustomAudioRoute(
  routes: AudioApiRoutes,
  key: CustomAudioRouteKey,
): AudioRoute | undefined {
  if (key === "transcription") return routes.transcription;
  if (key === "realtimeCaptions") return routes.realtimeCaptions;
  if (key === "realtimeVoice") return routes.realtimeVoice;
  return routes.speechSynthesis.preset_voice;
}

export function setCustomAudioRoute(
  state: AudioApiFormState,
  key: CustomAudioRouteKey,
  enabled: boolean,
  model = "",
): AudioApiFormState {
  const definition = CUSTOM_AUDIO_ROUTE_DEFINITIONS.find(
    (candidate) => candidate.key === key,
  )!;
  const routes = cloneRoutes(state.routes);
  const route = enabled
    ? {
        transport: definition.transport,
        model,
        enabled: true,
      }
    : undefined;

  if (key === "transcription") {
    if (route) routes.transcription = route;
    else delete routes.transcription;
  } else if (key === "realtimeCaptions") {
    if (route) routes.realtimeCaptions = route;
    else delete routes.realtimeCaptions;
  } else if (key === "realtimeVoice") {
    if (route) routes.realtimeVoice = route;
    else delete routes.realtimeVoice;
  } else if (route) {
    routes.speechSynthesis.preset_voice = route;
  } else {
    delete routes.speechSynthesis.preset_voice;
  }

  return { ...state, routes };
}

export function validateAudioApiForm(
  state: AudioApiFormState,
): AudioApiFormValidation {
  const fieldErrors: AudioApiFormValidation["fieldErrors"] = {};
  const routeErrors: AudioApiFormValidation["routeErrors"] = {};
  const name = state.name.trim();
  const apiKey = state.apiKey.trim();
  const normalizedBaseUrl = normalizeAudioEndpoint(state.baseUrl).baseUrl;

  if (!name) fieldErrors.name = "name_required";
  if (!state.baseUrl.trim()) {
    fieldErrors.baseUrl = "base_url_required";
  } else if (!isHttpBaseUrl(normalizedBaseUrl)) {
    fieldErrors.baseUrl = "base_url_invalid";
  }
  if (!apiKey) fieldErrors.apiKey = "api_key_required";

  let configuredRouteCount = 0;
  for (const routeEntry of listConfiguredRoutes(state.routes)) {
    configuredRouteCount += 1;
    if (!routeEntry.route.model.trim()) {
      if (isCustomAudioRouteKey(routeEntry.routeKey)) {
        routeErrors[routeEntry.routeKey] = "route_model_required";
      } else {
        fieldErrors.routes = "route_model_required";
      }
      continue;
    }
    if (!isAudioRouteTransportSupported({
      preset: state.providerPreset,
      assignmentKey: routeEntry.assignmentKey,
      transport: routeEntry.route.transport,
      ...(routeEntry.speechMode
        ? { speechMode: routeEntry.speechMode }
        : {}),
    })) {
      if (isCustomAudioRouteKey(routeEntry.routeKey)) {
        routeErrors[routeEntry.routeKey] = "route_transport_invalid";
      } else {
        fieldErrors.routes = "route_transport_invalid";
      }
    }
  }
  if (configuredRouteCount === 0) fieldErrors.routes = "route_required";

  const valid = Object.keys(fieldErrors).length === 0 &&
    Object.keys(routeErrors).length === 0;
  return {
    draft: valid
      ? {
          name,
          providerPreset: state.providerPreset,
          baseUrl: normalizedBaseUrl,
          apiKey,
          routes: cloneRoutes(state.routes),
        }
      : null,
    fieldErrors,
    routeErrors,
  };
}

export function getConfiguredAudioTasks(
  profileOrRoutes: Pick<AudioApiProfile, "routes"> | AudioApiRoutes,
): AudioAssignmentKey[] {
  const profile = "routes" in profileOrRoutes
    ? profileOrRoutes
    : { routes: profileOrRoutes };
  return AUDIO_ASSIGNMENT_KEYS.filter((key) =>
    canAudioApiHandleTask(profile, key),
  );
}

function listConfiguredRoutes(routes: AudioApiRoutes): Array<{
  routeKey: AudioRouteKey;
  assignmentKey: AudioAssignmentKey;
  speechMode?: SpeechSynthesisMode;
  route: AudioRoute;
}> {
  const entries: Array<{
    routeKey: AudioRouteKey;
    assignmentKey: AudioAssignmentKey;
    speechMode?: SpeechSynthesisMode;
    route: AudioRoute;
  }> = [];
  if (routes.transcription?.enabled) {
    entries.push({
      routeKey: "transcription",
      assignmentKey: "transcription",
      route: routes.transcription,
    });
  }
  for (const mode of SPEECH_SYNTHESIS_MODES) {
    const route = routes.speechSynthesis[mode];
    if (route?.enabled) {
      entries.push({
        routeKey: `speechSynthesis.${mode}`,
        assignmentKey: "speechSynthesis",
        speechMode: mode,
        route,
      });
    }
  }
  if (routes.realtimeCaptions?.enabled) {
    entries.push({
      routeKey: "realtimeCaptions",
      assignmentKey: "realtimeCaptions",
      route: routes.realtimeCaptions,
    });
  }
  if (routes.realtimeVoice?.enabled) {
    entries.push({
      routeKey: "realtimeVoice",
      assignmentKey: "realtimeVoice",
      route: routes.realtimeVoice,
    });
  }
  return entries;
}

function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isCustomAudioRouteKey(value: AudioRouteKey): value is CustomAudioRouteKey {
  return CUSTOM_AUDIO_ROUTE_DEFINITIONS.some(
    (definition) => definition.key === value,
  );
}

function cloneRoutes(routes: AudioApiRoutes): AudioApiRoutes {
  return {
    ...(routes.transcription
      ? { transcription: { ...routes.transcription } }
      : {}),
    speechSynthesis: Object.fromEntries(
      Object.entries(routes.speechSynthesis).map(([mode, route]) => [
        mode,
        route ? { ...route } : route,
      ]),
    ),
    ...(routes.realtimeCaptions
      ? { realtimeCaptions: { ...routes.realtimeCaptions } }
      : {}),
    ...(routes.realtimeVoice
      ? { realtimeVoice: { ...routes.realtimeVoice } }
      : {}),
  };
}
