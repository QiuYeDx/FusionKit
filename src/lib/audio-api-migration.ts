import { normalizeAudioEndpoint } from "@/lib/audio-endpoint";
import {
  MIMO_TTS_MODEL_BY_MODE,
  canAudioApiHandleTask,
  createDefaultAudioApiRoutes,
  inferAudioProviderPresetFromLegacy,
} from "@/lib/audio-provider-registry";
import {
  AUDIO_ASSIGNMENT_KEYS,
  DEFAULT_AUDIO_TASK_ASSIGNMENT,
  isAudioProviderPreset,
  isAudioTransport,
  isSpeechSynthesisMode,
  type AudioApiProfile,
  type AudioApiRoutes,
  type AudioAssignmentKey,
  type AudioRoute,
  type AudioRouteVerification,
  type AudioRouteVerificationStatus,
  type AudioTaskAssignment,
  type AudioTransport,
  type SpeechSynthesisMode,
} from "@/type/audio";

export const LEGACY_MODEL_STORAGE_KEY = "fusionkit-model";
export const AUDIO_API_STORAGE_KEY = "fusionkit-audio-settings";
export const AUDIO_API_STORE_VERSION = 1;

export type LegacyModelStoreVersion = 4 | 5;

export interface LegacyModelStoreEnvelope {
  version: LegacyModelStoreVersion;
  state: {
    profiles: unknown[];
    assignment: unknown;
    audioProfiles: unknown[];
    audioAssignment: unknown;
  };
}

export interface AudioApiStoreMigrationState {
  legacyModelStore: {
    status: "not_needed" | "completed";
    sourceVersion?: LegacyModelStoreVersion;
  };
}

export interface AudioApiPersistedState {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
  migration: AudioApiStoreMigrationState;
}

export interface AudioApiStoreEnvelope {
  version: typeof AUDIO_API_STORE_VERSION;
  state: AudioApiPersistedState;
}

export interface AudioSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AudioApiBootstrapResult =
  | { status: "migrated"; state: AudioApiPersistedState }
  | { status: "already_complete"; state: AudioApiPersistedState }
  | { status: "no_source" }
  | { status: "no_storage" }
  | {
      status: "failed";
      reason:
        | "invalid_source"
        | "invalid_target"
        | "read_failed"
        | "write_failed"
        | "verification_failed";
    };

export const DEFAULT_AUDIO_API_MIGRATION_STATE: AudioApiStoreMigrationState = {
  legacyModelStore: { status: "not_needed" },
};

export function parseLegacyModelStoreEnvelope(
  input: unknown,
): LegacyModelStoreEnvelope | null {
  const value = parseJsonInput(input);
  if (!isRecord(value) || !isLegacyVersion(value.version)) return null;
  if (!isValidLegacyModelStoreState(value.state)) return null;

  return {
    version: value.version,
    state: {
      profiles: [...value.state.profiles],
      assignment: value.state.assignment,
      audioProfiles: [...value.state.audioProfiles],
      audioAssignment: value.state.audioAssignment,
    },
  };
}

export function parseAudioApiStoreEnvelope(
  input: unknown,
): AudioApiStoreEnvelope | null {
  const value = parseJsonInput(input);
  if (!isRecord(value) || value.version !== AUDIO_API_STORE_VERSION) {
    return null;
  }
  if (!isValidAudioApiPersistedState(value.state)) return null;

  return {
    version: AUDIO_API_STORE_VERSION,
    state: normalizeAudioApiPersistedState(value.state),
  };
}

export function normalizeAudioApiPersistedState(
  input: unknown,
): AudioApiPersistedState {
  const value = isRecord(input) ? input : {};
  const profiles = Array.isArray(value.profiles)
    ? value.profiles
        .map(normalizeAudioApiProfile)
        .filter((profile): profile is AudioApiProfile => Boolean(profile))
    : [];

  return {
    profiles: dedupeAudioApiProfiles(profiles),
    assignment: normalizeAudioTaskAssignment(value.assignment),
    migration: normalizeMigrationState(value.migration),
  };
}

export function normalizeAudioApiProfile(
  input: unknown,
): AudioApiProfile | null {
  if (!isRecord(input)) return null;
  const id = nonEmptyString(input.id);
  const name = nonEmptyString(input.name);
  if (!id || !name || !isAudioProviderPreset(input.providerPreset)) {
    return null;
  }

  const verification = normalizeVerification(input.verification);
  const migration = normalizeProfileMigration(input.migration);
  return {
    id,
    name,
    providerPreset: input.providerPreset,
    baseUrl: normalizeAudioEndpoint(stringValue(input.baseUrl)).baseUrl,
    apiKey: stringValue(input.apiKey),
    routes: normalizeAudioApiRoutes(input.routes),
    ...(verification ? { verification } : {}),
    ...(migration ? { migration } : {}),
  };
}

export function migrateLegacyAudioSettings(
  source: LegacyModelStoreEnvelope,
  existingTarget?: AudioApiPersistedState,
): AudioApiPersistedState {
  const existing = existingTarget
    ? normalizeAudioApiPersistedState(existingTarget)
    : null;
  const outputProfiles = existing
    ? existing.profiles.map(cloneAudioApiProfile)
    : [];
  const usedIds = new Set(outputProfiles.map((profile) => profile.id));
  const existingBySourceId = new Map(
    outputProfiles
      .filter((profile) => profile.migration?.sourceId)
      .map((profile) => [profile.migration!.sourceId, profile]),
  );
  const connections = indexLegacyConnections(source.state.profiles);
  const legacyAssignment = normalizeAudioTaskAssignment(
    source.state.audioAssignment,
  );
  const oldToNewId = new Map<string, string>();

  for (const entry of createLegacyAudioProfileEntries(
    source.state.audioProfiles,
  )) {
    const { rawProfile, rawId, occurrence, sourceId } = entry;

    const alreadyMigrated = existingBySourceId.get(sourceId);
    if (alreadyMigrated) {
      if (!oldToNewId.has(rawId)) oldToNewId.set(rawId, alreadyMigrated.id);
      continue;
    }

    const id = reserveStableId(
      occurrence === 0 ? rawId : sourceId,
      usedIds,
    );
    const migrated = migrateLegacyAudioProfile({
      rawProfile,
      id,
      sourceId,
      duplicateSourceId: occurrence > 0,
      connection: connections.get(stringValue(rawProfile.connectionProfileId)),
      legacyAssignment,
    });
    outputProfiles.push(migrated);
    existingBySourceId.set(sourceId, migrated);
    if (!oldToNewId.has(rawId)) oldToNewId.set(rawId, id);
  }

  const migratedAssignment = rewriteLegacyAssignment(
    legacyAssignment,
    oldToNewId,
  );
  markInvalidMigratedAssignments(outputProfiles, migratedAssignment);

  return {
    profiles: outputProfiles,
    assignment: mergeAudioAssignments(existing?.assignment, migratedAssignment),
    migration: {
      legacyModelStore: {
        status: "completed",
        sourceVersion: source.version,
      },
    },
  };
}

export function bootstrapLegacyAudioSettings(
  storage: AudioSettingsStorage,
): AudioApiBootstrapResult {
  let targetRaw: string | null;
  try {
    targetRaw = storage.getItem(AUDIO_API_STORAGE_KEY);
  } catch {
    return { status: "failed", reason: "read_failed" };
  }
  const existingTarget = targetRaw
    ? parseAudioApiStoreEnvelope(targetRaw)
    : null;
  if (targetRaw && !existingTarget) {
    return { status: "failed", reason: "invalid_target" };
  }
  if (
    existingTarget?.state.migration.legacyModelStore.status === "completed"
  ) {
    return { status: "already_complete", state: existingTarget.state };
  }

  let sourceRaw: string | null;
  try {
    sourceRaw = storage.getItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {
    return { status: "failed", reason: "read_failed" };
  }
  if (!sourceRaw) return { status: "no_source" };
  const source = parseLegacyModelStoreEnvelope(sourceRaw);
  if (!source) return { status: "failed", reason: "invalid_source" };

  const state = migrateLegacyAudioSettings(source, existingTarget?.state);
  const envelope: AudioApiStoreEnvelope = {
    version: AUDIO_API_STORE_VERSION,
    state,
  };
  const serialized = JSON.stringify(envelope);

  try {
    storage.setItem(AUDIO_API_STORAGE_KEY, serialized);
  } catch {
    return { status: "failed", reason: "write_failed" };
  }

  let verifiedRaw: string | null;
  try {
    verifiedRaw = storage.getItem(AUDIO_API_STORAGE_KEY);
  } catch {
    return { status: "failed", reason: "verification_failed" };
  }
  if (verifiedRaw !== serialized) {
    return { status: "failed", reason: "verification_failed" };
  }
  const verified = parseAudioApiStoreEnvelope(verifiedRaw);
  if (
    !verified ||
    verified.state.migration.legacyModelStore.status !== "completed"
  ) {
    return { status: "failed", reason: "verification_failed" };
  }
  return { status: "migrated", state: verified.state };
}

export function bootstrapLegacyAudioSettingsFromGlobalStorage(): AudioApiBootstrapResult {
  try {
    if (typeof globalThis.localStorage === "undefined") {
      return { status: "no_storage" };
    }
    return bootstrapLegacyAudioSettings(globalThis.localStorage);
  } catch {
    return { status: "no_storage" };
  }
}

function migrateLegacyAudioProfile(options: {
  rawProfile: Record<string, unknown>;
  id: string;
  sourceId: string;
  duplicateSourceId: boolean;
  connection?: Record<string, unknown>;
  legacyAssignment: AudioTaskAssignment;
}): AudioApiProfile {
  const { rawProfile, connection } = options;
  const transport = isAudioTransport(rawProfile.audioDialect)
    ? rawProfile.audioDialect
    : undefined;
  const inferred = transport
    ? inferAudioProviderPresetFromLegacy({
        transport,
        connectionProvider: nonEmptyString(connection?.provider),
      })
    : { preset: "custom_openai_compatible" as const, needsAttention: true };
  const modelConfig = isRecord(rawProfile.models) ? rawProfile.models : {};
  const defaults = isRecord(rawProfile.defaults) ? rawProfile.defaults : {};
  const migrationResult = migrateLegacyRoutes({
    transport,
    models: modelConfig,
    defaults,
    profileId: nonEmptyString(rawProfile.id) ?? options.sourceId,
    legacyAssignment: options.legacyAssignment,
  });
  const verification = migrateLegacyVerification(
    rawProfile.verification,
    modelConfig,
    defaults,
  );
  const baseUrl = normalizeAudioEndpoint(stringValue(connection?.baseUrl)).baseUrl;
  const apiKey = stringValue(connection?.apiKey);
  const needsAttention =
    !connection ||
    !baseUrl ||
    !nonEmptyString(apiKey) ||
    !transport ||
    inferred.needsAttention ||
    migrationResult.needsAttention ||
    options.duplicateSourceId;

  return {
    id: options.id,
    name: nonEmptyString(rawProfile.name) ?? `Migrated audio API ${options.id}`,
    providerPreset: inferred.preset,
    baseUrl,
    apiKey,
    routes: migrationResult.routes,
    ...(verification ? { verification } : {}),
    migration: {
      source: "legacy_audio_profile",
      sourceId: options.sourceId,
      ...(needsAttention ? { needsAttention: true } : {}),
    },
  };
}

function migrateLegacyRoutes(options: {
  transport?: AudioTransport;
  models: Record<string, unknown>;
  defaults: Record<string, unknown>;
  profileId: string;
  legacyAssignment: AudioTaskAssignment;
}): { routes: AudioApiRoutes; needsAttention: boolean } {
  const routes: AudioApiRoutes = { speechSynthesis: {} };
  let needsAttention = false;
  const transcription = nonEmptyString(options.models.transcription);
  const speech = nonEmptyString(options.models.speechSynthesis);
  const realtimeFallback = nonEmptyString(options.models.realtime);

  if (options.transport === "mimo_chat_audio") {
    const defaults = createDefaultAudioApiRoutes("mimo");
    routes.speechSynthesis = defaults.speechSynthesis;
    if (transcription) {
      routes.transcription = audioRoute("mimo_chat_audio", transcription);
      routes.realtimeCaptions = audioRoute(
        "mimo_chat_audio",
        transcription,
      );
    }
    if (speech && !Object.values(MIMO_TTS_MODEL_BY_MODE).includes(speech)) {
      const legacyMode = isSpeechSynthesisMode(options.defaults.mimoTtsMode)
        ? options.defaults.mimoTtsMode
        : "preset_voice";
      routes.speechSynthesis[legacyMode] = audioRoute(
        "mimo_chat_audio",
        speech,
      );
      needsAttention = true;
    }
    return { routes, needsAttention };
  }

  if (options.transport === "openai_audio") {
    if (transcription) {
      routes.transcription = audioRoute("openai_audio", transcription);
      if (options.legacyAssignment.realtimeCaptions === options.profileId) {
        routes.realtimeCaptions = audioRoute(
          "openai_audio",
          transcription,
        );
      }
    }
    if (speech) {
      routes.speechSynthesis.preset_voice = audioRoute(
        "openai_audio",
        speech,
      );
    }
    return {
      routes,
      needsAttention: !transcription && !speech,
    };
  }

  if (options.transport === "openai_realtime") {
    const realtimeTranscription =
      nonEmptyString(options.models.realtimeTranscription) ?? realtimeFallback;
    const realtimeVoice =
      nonEmptyString(options.models.realtimeVoice) ?? realtimeFallback;
    if (realtimeTranscription) {
      routes.realtimeCaptions = audioRoute(
        "openai_realtime",
        realtimeTranscription,
      );
    }
    if (realtimeVoice) {
      routes.realtimeVoice = audioRoute("openai_realtime", realtimeVoice);
    }
    return {
      routes,
      needsAttention: !realtimeTranscription && !realtimeVoice,
    };
  }

  return { routes, needsAttention: true };
}

function migrateLegacyVerification(
  input: unknown,
  models: Record<string, unknown>,
  defaults: Record<string, unknown>,
): AudioApiProfile["verification"] | undefined {
  if (!isRecord(input)) return undefined;
  const output: Record<string, AudioRouteVerification> = {};
  const updatedAt = nonEmptyString(input.updatedAt);
  if (isVerificationStatus(input.streamingSpeech)) {
    const speechModel = nonEmptyString(models.speechSynthesis);
    const mode = findMimoModeForModel(speechModel)
      ?? (isSpeechSynthesisMode(defaults.mimoTtsMode)
        ? defaults.mimoTtsMode
        : undefined);
    if (mode) {
      output[`speechSynthesis.${mode}`] = {
        status: input.streamingSpeech,
        ...(updatedAt ? { updatedAt } : {}),
      };
    }
  }
  if (isVerificationStatus(input.realtimeVoice)) {
    output.realtimeVoice = {
      status: input.realtimeVoice,
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  return Object.keys(output).length ? output : undefined;
}

function indexLegacyConnections(
  profiles: unknown[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const profile of profiles) {
    if (!isRecord(profile)) continue;
    const id = nonEmptyString(profile.id);
    if (id && !result.has(id)) result.set(id, profile);
  }
  return result;
}

interface LegacyAudioProfileEntry {
  rawProfile: Record<string, unknown>;
  rawId: string;
  occurrence: number;
  sourceId: string;
}

function createLegacyAudioProfileEntries(
  profiles: unknown[],
): LegacyAudioProfileEntry[] {
  if (!profiles.every(isValidLegacyAudioProfile)) {
    throw new TypeError("Invalid legacy audio profile state.");
  }

  const rawProfiles = profiles as Record<string, unknown>[];
  const reservedSourceIds = new Set(
    rawProfiles.map((profile) => nonEmptyString(profile.id)!),
  );
  const sourceIdCounts = new Map<string, number>();

  return rawProfiles.map((rawProfile) => {
    const rawId = nonEmptyString(rawProfile.id)!;
    const occurrence = sourceIdCounts.get(rawId) ?? 0;
    sourceIdCounts.set(rawId, occurrence + 1);

    if (occurrence === 0) {
      return { rawProfile, rawId, occurrence, sourceId: rawId };
    }

    const base = `${rawId}#legacy-duplicate-${occurrence + 1}`;
    let sourceId = base;
    let suffix = 2;
    while (reservedSourceIds.has(sourceId)) {
      sourceId = `${base}-${suffix}`;
      suffix += 1;
    }
    reservedSourceIds.add(sourceId);
    return { rawProfile, rawId, occurrence, sourceId };
  });
}

function rewriteLegacyAssignment(
  assignment: AudioTaskAssignment,
  oldToNewId: ReadonlyMap<string, string>,
): AudioTaskAssignment {
  return Object.fromEntries(
    AUDIO_ASSIGNMENT_KEYS.map((key) => {
      const legacyId = assignment[key];
      return [key, legacyId ? oldToNewId.get(legacyId) ?? legacyId : null];
    }),
  ) as AudioTaskAssignment;
}

function markInvalidMigratedAssignments(
  profiles: AudioApiProfile[],
  assignment: AudioTaskAssignment,
): void {
  for (const key of AUDIO_ASSIGNMENT_KEYS) {
    const profileId = assignment[key];
    if (!profileId) continue;
    const index = profiles.findIndex((profile) => profile.id === profileId);
    if (index < 0 || canAudioApiHandleTask(profiles[index], key)) continue;
    const profile = profiles[index];
    if (!profile.migration) continue;
    profiles[index] = {
      ...profile,
      migration: { ...profile.migration, needsAttention: true },
    };
  }
}

function mergeAudioAssignments(
  existing: AudioTaskAssignment | undefined,
  migrated: AudioTaskAssignment,
): AudioTaskAssignment {
  if (!existing) return migrated;
  return Object.fromEntries(
    AUDIO_ASSIGNMENT_KEYS.map((key) => [
      key,
      existing[key] ?? migrated[key],
    ]),
  ) as AudioTaskAssignment;
}

function reserveStableId(preferred: string, usedIds: Set<string>): string {
  if (!usedIds.has(preferred)) {
    usedIds.add(preferred);
    return preferred;
  }
  let index = 1;
  let candidate = `legacy-${preferred}`;
  while (usedIds.has(candidate)) {
    index += 1;
    candidate = `legacy-${preferred}-${index}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeAudioApiRoutes(input: unknown): AudioApiRoutes {
  const value = isRecord(input) ? input : {};
  const speech = isRecord(value.speechSynthesis)
    ? value.speechSynthesis
    : {};
  const speechSynthesis: AudioApiRoutes["speechSynthesis"] = {};
  for (const mode of Object.keys(MIMO_TTS_MODEL_BY_MODE) as SpeechSynthesisMode[]) {
    const route = normalizeRoute(speech[mode]);
    if (route) speechSynthesis[mode] = route;
  }

  const transcription = normalizeRoute(value.transcription);
  const realtimeCaptions = normalizeRoute(value.realtimeCaptions);
  const realtimeVoice = normalizeRoute(value.realtimeVoice);
  return {
    ...(transcription ? { transcription } : {}),
    speechSynthesis,
    ...(realtimeCaptions ? { realtimeCaptions } : {}),
    ...(realtimeVoice ? { realtimeVoice } : {}),
  };
}

function normalizeRoute(input: unknown): AudioRoute | undefined {
  if (!isRecord(input) || !isAudioTransport(input.transport)) {
    return undefined;
  }
  return {
    transport: input.transport,
    model: stringValue(input.model).trim(),
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
  };
}

function normalizeAudioTaskAssignment(input: unknown): AudioTaskAssignment {
  const value = isRecord(input) ? input : {};
  return Object.fromEntries(
    AUDIO_ASSIGNMENT_KEYS.map((key) => [
      key,
      nonEmptyString(value[key]) ?? null,
    ]),
  ) as AudioTaskAssignment;
}

function normalizeVerification(
  input: unknown,
): AudioApiProfile["verification"] | undefined {
  if (!isRecord(input)) return undefined;
  const output: Record<string, AudioRouteVerification> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value) || !isVerificationStatus(value.status)) continue;
    const updatedAt = nonEmptyString(value.updatedAt);
    output[key] = {
      status: value.status,
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  return Object.keys(output).length ? output : undefined;
}

function normalizeProfileMigration(
  input: unknown,
): AudioApiProfile["migration"] | undefined {
  if (!isRecord(input) || input.source !== "legacy_audio_profile") {
    return undefined;
  }
  const sourceId = nonEmptyString(input.sourceId);
  if (!sourceId) return undefined;
  return {
    source: "legacy_audio_profile",
    sourceId,
    ...(input.needsAttention === true ? { needsAttention: true } : {}),
  };
}

function normalizeMigrationState(input: unknown): AudioApiStoreMigrationState {
  if (!isRecord(input) || !isRecord(input.legacyModelStore)) {
    return cloneMigrationState(DEFAULT_AUDIO_API_MIGRATION_STATE);
  }
  const legacy = input.legacyModelStore;
  if (legacy.status !== "completed" || !isLegacyVersion(legacy.sourceVersion)) {
    return cloneMigrationState(DEFAULT_AUDIO_API_MIGRATION_STATE);
  }
  return {
    legacyModelStore: {
      status: "completed",
      sourceVersion: legacy.sourceVersion,
    },
  };
}

function dedupeAudioApiProfiles(
  profiles: AudioApiProfile[],
): AudioApiProfile[] {
  const ids = new Set<string>();
  return profiles.filter((profile) => {
    if (ids.has(profile.id)) return false;
    ids.add(profile.id);
    return true;
  });
}

function cloneAudioApiProfile(profile: AudioApiProfile): AudioApiProfile {
  return normalizeAudioApiProfile(profile)!;
}

function cloneMigrationState(
  state: AudioApiStoreMigrationState,
): AudioApiStoreMigrationState {
  return {
    legacyModelStore: { ...state.legacyModelStore },
  };
}

function audioRoute(transport: AudioTransport, model: string): AudioRoute {
  return { transport, model, enabled: true };
}

function findMimoModeForModel(
  model: string | undefined,
): SpeechSynthesisMode | undefined {
  if (!model) return undefined;
  return (Object.entries(MIMO_TTS_MODEL_BY_MODE) as Array<
    [SpeechSynthesisMode, string]
  >).find(([, value]) => value === model)?.[0];
}

function isVerificationStatus(
  input: unknown,
): input is AudioRouteVerificationStatus {
  return (
    input === "untested" ||
    input === "verified" ||
    input === "degraded" ||
    input === "failed"
  );
}

function isLegacyVersion(input: unknown): input is LegacyModelStoreVersion {
  return input === 4 || input === 5;
}

function isValidLegacyModelStoreState(
  input: unknown,
): input is LegacyModelStoreEnvelope["state"] {
  if (!isRecord(input)) return false;
  if (!Array.isArray(input.profiles) || !input.profiles.every(isRecord)) {
    return false;
  }
  if (
    !Array.isArray(input.audioProfiles) ||
    !input.audioProfiles.every(isValidLegacyAudioProfile)
  ) {
    return false;
  }
  return (
    isRecord(input.assignment) &&
    isValidAudioTaskAssignmentInput(input.audioAssignment)
  );
}

function isValidLegacyAudioProfile(
  input: unknown,
): input is Record<string, unknown> {
  if (!isRecord(input)) return false;
  if (!nonEmptyString(input.id) || !nonEmptyString(input.name)) return false;
  if (!isRecord(input.models)) return false;
  const models = input.models;
  if (
    input.connectionProfileId !== undefined &&
    typeof input.connectionProfileId !== "string"
  ) {
    return false;
  }
  if (
    input.audioDialect !== undefined &&
    typeof input.audioDialect !== "string"
  ) {
    return false;
  }
  if (input.defaults !== undefined && !isRecord(input.defaults)) return false;
  if (input.verification !== undefined && !isRecord(input.verification)) {
    return false;
  }

  return [
    "transcription",
    "speechSynthesis",
    "realtime",
    "realtimeTranscription",
    "realtimeVoice",
  ].every(
    (key) => models[key] === undefined || typeof models[key] === "string",
  );
}

function isValidAudioApiPersistedState(
  input: unknown,
): input is Record<string, unknown> {
  if (!isRecord(input) || !Array.isArray(input.profiles)) return false;
  if (!input.profiles.every(isValidAudioApiProfileInput)) return false;
  const profileIds = input.profiles.map((profile) => nonEmptyString(profile.id)!);
  if (new Set(profileIds).size !== profileIds.length) return false;
  return (
    isValidAudioTaskAssignmentInput(input.assignment) &&
    isValidAudioApiMigrationStateInput(input.migration)
  );
}

function isValidAudioApiProfileInput(
  input: unknown,
): input is Record<string, unknown> & { id: string } {
  if (!isRecord(input)) return false;
  if (
    !nonEmptyString(input.id) ||
    !nonEmptyString(input.name) ||
    !isAudioProviderPreset(input.providerPreset) ||
    typeof input.baseUrl !== "string" ||
    typeof input.apiKey !== "string" ||
    !isValidAudioApiRoutesInput(input.routes)
  ) {
    return false;
  }
  if (
    input.verification !== undefined &&
    !isValidAudioVerificationInput(input.verification)
  ) {
    return false;
  }
  return (
    input.migration === undefined ||
    isValidAudioProfileMigrationInput(input.migration)
  );
}

function isValidAudioApiRoutesInput(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.speechSynthesis)) return false;
  for (const [mode, route] of Object.entries(input.speechSynthesis)) {
    if (!isSpeechSynthesisMode(mode) || !isValidAudioRouteInput(route)) {
      return false;
    }
  }
  return ["transcription", "realtimeCaptions", "realtimeVoice"].every(
    (key) => input[key] === undefined || isValidAudioRouteInput(input[key]),
  );
}

function isValidAudioRouteInput(input: unknown): boolean {
  return (
    isRecord(input) &&
    isAudioTransport(input.transport) &&
    typeof input.model === "string" &&
    typeof input.enabled === "boolean"
  );
}

function isValidAudioVerificationInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return Object.values(input).every(
    (value) =>
      isRecord(value) &&
      isVerificationStatus(value.status) &&
      (value.updatedAt === undefined || Boolean(nonEmptyString(value.updatedAt))),
  );
}

function isValidAudioProfileMigrationInput(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.source === "legacy_audio_profile" &&
    Boolean(nonEmptyString(input.sourceId)) &&
    (input.needsAttention === undefined ||
      typeof input.needsAttention === "boolean")
  );
}

function isValidAudioTaskAssignmentInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return AUDIO_ASSIGNMENT_KEYS.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(input, key) &&
      (input[key] === null || Boolean(nonEmptyString(input[key]))),
  );
}

function isValidAudioApiMigrationStateInput(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.legacyModelStore)) return false;
  const legacy = input.legacyModelStore;
  if (legacy.status === "not_needed") {
    return legacy.sourceVersion === undefined;
  }
  return (
    legacy.status === "completed" && isLegacyVersion(legacy.sourceVersion)
  );
}

function parseJsonInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed || undefined;
}

function stringValue(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
