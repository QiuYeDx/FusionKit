import {
  LOCAL_SUBTITLE_DEVICE_PREFERENCES,
  LOCAL_SUBTITLE_FORMATS,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_OUTPUT_MODES,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_QUALITY_PRESETS,
  type LocalSubtitleDevicePreference,
  type LocalSubtitleFormat,
  type LocalSubtitleOutputMode,
  type LocalSubtitleQualityPreset,
} from "@/type/localSubtitle";

export interface LocalSubtitleTranscriberPreferences {
  readonly modelId: string;
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly language: string;
  readonly vadEnabled: boolean;
  readonly qualityPreset: LocalSubtitleQualityPreset;
  readonly beamSize: number;
  readonly temperature: number;
  readonly vadMinSilenceMs: number;
  readonly maxCueDurationMs: number;
  readonly maxCueChars: number;
  readonly maxLineChars: number;
  readonly outputFormats: readonly LocalSubtitleFormat[];
  readonly outputMode: LocalSubtitleOutputMode;
  readonly outputDirectoryDisplayLabel: string | null;
}

export const DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES = {
  modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  devicePreference: "auto",
  language: "auto",
  vadEnabled: true,
  qualityPreset: "subtitle_quality",
  beamSize: 5,
  temperature: 0,
  vadMinSilenceMs: 500,
  maxCueDurationMs: 7_000,
  maxCueChars: 84,
  maxLineChars: 42,
  outputFormats: ["SRT"],
  outputMode: "source",
  outputDirectoryDisplayLabel: null,
} as const satisfies LocalSubtitleTranscriberPreferences;

export function sanitizeLocalSubtitleTranscriberPreferences(
  value: unknown,
): LocalSubtitleTranscriberPreferences {
  const record = isRecord(value) ? value : {};
  const outputMode = oneOf(
    record.outputMode,
    LOCAL_SUBTITLE_OUTPUT_MODES,
    DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.outputMode,
  );
  return {
    modelId: isSafeId(record.modelId)
      ? record.modelId
      : DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.modelId,
    devicePreference: oneOf(
      record.devicePreference,
      LOCAL_SUBTITLE_DEVICE_PREFERENCES,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.devicePreference,
    ),
    language: isLanguage(record.language)
      ? record.language
      : DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.language,
    vadEnabled: booleanOr(
      record.vadEnabled,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.vadEnabled,
    ),
    qualityPreset: oneOf(
      record.qualityPreset,
      LOCAL_SUBTITLE_QUALITY_PRESETS,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.qualityPreset,
    ),
    beamSize: boundedIntegerOr(
      record.beamSize,
      1,
      10,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.beamSize,
    ),
    temperature: boundedNumberOr(
      record.temperature,
      0,
      1,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.temperature,
    ),
    vadMinSilenceMs: boundedIntegerOr(
      record.vadMinSilenceMs,
      100,
      5_000,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.vadMinSilenceMs,
    ),
    maxCueDurationMs: boundedIntegerOr(
      record.maxCueDurationMs,
      500,
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.maxCueDurationMs,
    ),
    maxCueChars: boundedIntegerOr(
      record.maxCueChars,
      20,
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.maxCueChars,
    ),
    maxLineChars: boundedIntegerOr(
      record.maxLineChars,
      10,
      LOCAL_SUBTITLE_LIMITS.maxLineChars,
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.maxLineChars,
    ),
    outputFormats: sanitizeOutputFormats(record.outputFormats),
    outputMode,
    outputDirectoryDisplayLabel:
      outputMode === "custom"
        ? sanitizeDisplayLabel(record.outputDirectoryDisplayLabel)
        : null,
  };
}

function sanitizeOutputFormats(value: unknown): readonly LocalSubtitleFormat[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.outputFormats];
  }
  const formats = Array.from(
    new Set(
      value.filter((entry): entry is LocalSubtitleFormat =>
        (LOCAL_SUBTITLE_FORMATS as readonly unknown[]).includes(entry),
      ),
    ),
  );
  return formats.length > 0
    ? formats
    : [...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES.outputFormats];
}

function sanitizeDisplayLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (
    value.length === 0 ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/]/u.test(value) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LOCAL_SUBTITLE_LIMITS.maxIdChars &&
    value !== "." &&
    value !== ".." &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)
  );
}

function isLanguage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= LOCAL_SUBTITLE_LIMITS.maxLanguageChars &&
    (value === "auto" || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value))
  );
}

function boundedIntegerOr(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fallback;
}

function boundedNumberOr(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  fallback: TValues[number],
): TValues[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as TValues[number])
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
