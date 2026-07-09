import {
  DEFAULT_AUDIO_MODEL_ASSIGNMENT,
  getAudioModelKeyForAssignment,
  getDefaultAudioCapabilities,
  isAudioApiDialect,
  isAudioCapability,
  isAudioSpeechResponseFormat,
  isAudioTranscriptionResponseFormat,
  isMimoSpeechSynthesisMode,
  validateAudioCapability,
  type AudioApiDialect,
  type AudioAssignmentKey,
  type AudioCapability,
  type AudioModelAssignment,
  type AudioModelProfile,
  type AudioModelVerificationStatus,
  type AudioSpeechResponseFormat,
  type AudioTranscriptionResponseFormat,
  type MimoSpeechSynthesisMode,
} from "@/type/audio";

export type AudioModelProfileInput = Omit<
  AudioModelProfile,
  "id" | "capabilities" | "models" | "defaults"
> & {
  capabilities?: AudioCapability[];
  models?: Partial<AudioModelProfile["models"]>;
  defaults?: Partial<AudioModelProfile["defaults"]>;
};

export function normalizeAudioModelProfileForRuntime(
  profile: AudioModelProfile | AudioModelProfileInput,
  id?: string,
): AudioModelProfile {
  const audioDialect = profile.audioDialect;
  const capabilities = normalizeCapabilities(
    profile.capabilities,
    audioDialect,
  );

  return {
    id: "id" in profile ? profile.id : requireProfileId(id),
    name: profile.name,
    connectionProfileId: profile.connectionProfileId,
    audioDialect,
    capabilities,
    models: {
      transcription: normalizeOptionalString(profile.models?.transcription),
      speechSynthesis: normalizeOptionalString(profile.models?.speechSynthesis),
      realtime: normalizeOptionalString(profile.models?.realtime),
    },
    defaults: normalizeDefaults(profile.defaults),
    ...(profile.verification
      ? { verification: normalizeVerification(profile.verification) }
      : {}),
  };
}

export function migrateAudioModelProfiles(raw: unknown): AudioModelProfile[] {
  if (!Array.isArray(raw)) return [];

  const profiles: AudioModelProfile[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (!isNonEmptyString(item.id)) continue;
    if (!isNonEmptyString(item.name)) continue;
    if (!isNonEmptyString(item.connectionProfileId)) continue;
    if (!isAudioApiDialect(item.audioDialect)) continue;

    profiles.push(
      normalizeAudioModelProfileForRuntime({
        id: item.id,
        name: item.name,
        connectionProfileId: item.connectionProfileId,
        audioDialect: item.audioDialect,
        capabilities: Array.isArray(item.capabilities)
          ? item.capabilities.filter(isAudioCapability)
          : [],
        models: isRecord(item.models) ? item.models : {},
        defaults: isRecord(item.defaults) ? item.defaults : {},
        ...(isRecord(item.verification)
          ? { verification: item.verification }
          : {}),
      } as AudioModelProfile),
    );
  }

  return profiles;
}

export function filterAudioProfilesByConnectionIds(
  audioProfiles: AudioModelProfile[],
  connectionProfileIds: ReadonlySet<string>,
): AudioModelProfile[] {
  return audioProfiles.filter((profile) =>
    connectionProfileIds.has(profile.connectionProfileId),
  );
}

export function normalizeAudioModelAssignment(
  raw: unknown,
  validAudioProfileIds: ReadonlySet<string>,
): AudioModelAssignment {
  const persisted = isRecord(raw) ? raw : {};

  return {
    transcription: normalizeAssignmentValue(
      persisted.transcription,
      validAudioProfileIds,
    ),
    speechSynthesis: normalizeAssignmentValue(
      persisted.speechSynthesis,
      validAudioProfileIds,
    ),
    realtimeCaptions: normalizeAssignmentValue(
      persisted.realtimeCaptions,
      validAudioProfileIds,
    ),
    realtimeVoice: normalizeAssignmentValue(
      persisted.realtimeVoice,
      validAudioProfileIds,
    ),
  };
}

export function clearAudioProfileFromAssignment(
  assignment: AudioModelAssignment,
  audioProfileId: string,
): AudioModelAssignment {
  return {
    transcription:
      assignment.transcription === audioProfileId
        ? null
        : assignment.transcription,
    speechSynthesis:
      assignment.speechSynthesis === audioProfileId
        ? null
        : assignment.speechSynthesis,
    realtimeCaptions:
      assignment.realtimeCaptions === audioProfileId
        ? null
        : assignment.realtimeCaptions,
    realtimeVoice:
      assignment.realtimeVoice === audioProfileId
        ? null
        : assignment.realtimeVoice,
  };
}

export function isConnectionProfileReferencedByAudioProfile(
  audioProfiles: readonly AudioModelProfile[],
  connectionProfileId: string,
): boolean {
  return audioProfiles.some(
    (profile) => profile.connectionProfileId === connectionProfileId,
  );
}

export function canAssignAudioProfileToTask(
  audioProfile: AudioModelProfile | undefined,
  assignmentKey: AudioAssignmentKey,
): boolean {
  if (!audioProfile) return false;
  return (
    validateAudioCapability(audioProfile, assignmentKey).ok &&
    getAudioModelKeyForAssignment(audioProfile, assignmentKey) !== undefined
  );
}

function normalizeCapabilities(
  capabilities: readonly AudioCapability[] | undefined,
  audioDialect: AudioApiDialect,
): AudioCapability[] {
  const validCapabilities =
    capabilities?.filter(isAudioCapability) ?? [];
  return validCapabilities.length > 0
    ? [...new Set(validCapabilities)]
    : getDefaultAudioCapabilities(audioDialect);
}

function normalizeDefaults(
  defaults: Partial<AudioModelProfile["defaults"]> | undefined,
): AudioModelProfile["defaults"] {
  const normalized: AudioModelProfile["defaults"] = {};

  const language = normalizeOptionalString(defaults?.language);
  if (language) normalized.language = language;

  if (
    isAudioTranscriptionResponseFormat(defaults?.transcriptionResponseFormat)
  ) {
    normalized.transcriptionResponseFormat =
      defaults.transcriptionResponseFormat as AudioTranscriptionResponseFormat;
  }

  const ttsVoice = normalizeOptionalString(defaults?.ttsVoice);
  if (ttsVoice) normalized.ttsVoice = ttsVoice;

  if (isAudioSpeechResponseFormat(defaults?.ttsResponseFormat)) {
    normalized.ttsResponseFormat =
      defaults.ttsResponseFormat as AudioSpeechResponseFormat;
  }

  const realtimeVoice = normalizeOptionalString(defaults?.realtimeVoice);
  if (realtimeVoice) normalized.realtimeVoice = realtimeVoice;

  if (isMimoSpeechSynthesisMode(defaults?.mimoTtsMode)) {
    normalized.mimoTtsMode = defaults.mimoTtsMode as MimoSpeechSynthesisMode;
  }

  if (typeof defaults?.streamSpeechByDefault === "boolean") {
    normalized.streamSpeechByDefault = defaults.streamSpeechByDefault;
  }

  return normalized;
}

function normalizeVerification(
  verification: Record<string, unknown>,
): AudioModelProfile["verification"] {
  return {
    ...(isVerificationStatus(verification.streamingSpeech)
      ? { streamingSpeech: verification.streamingSpeech }
      : {}),
    ...(isRealtimeVoiceVerificationStatus(verification.realtimeVoice)
      ? { realtimeVoice: verification.realtimeVoice }
      : {}),
    ...(isNonEmptyString(verification.updatedAt)
      ? { updatedAt: verification.updatedAt }
      : {}),
  };
}

function normalizeAssignmentValue(
  value: unknown,
  validAudioProfileIds: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string") return null;
  return validAudioProfileIds.has(value) ? value : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isVerificationStatus(
  value: unknown,
): value is AudioModelVerificationStatus {
  return (
    value === "untested" ||
    value === "verified" ||
    value === "degraded" ||
    value === "failed"
  );
}

function isRealtimeVoiceVerificationStatus(
  value: unknown,
): value is Exclude<AudioModelVerificationStatus, "degraded"> {
  return value === "untested" || value === "verified" || value === "failed";
}

function requireProfileId(id: string | undefined): string {
  if (!id) {
    throw new Error("Audio model profile id is required.");
  }
  return id;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { DEFAULT_AUDIO_MODEL_ASSIGNMENT };
