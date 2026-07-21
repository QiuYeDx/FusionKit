import { z } from "zod";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  type LocalSubtitleErrorCode,
  type LocalSubtitleTaskMode,
} from "@/type/localSubtitle";

export const LOCAL_SUBTITLE_SERVER_HTTP_POLICY = deepFreeze({
  contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
  engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
  host: "127.0.0.1",
  privatePathPrefix: "/fusionkit-",
  privatePathEntropyBytes:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.privatePathEntropyBits / 8,
  healthPath: "/health",
  inferencePath: "/inference",
  fixedUploadFileName: "window.wav",
  startupTimeoutMs: 120_000,
  healthRequestTimeoutMs: 2_000,
  inferenceRequestTimeoutMs: 15 * 60 * 1_000,
  fileHandleCloseTimeoutMs: 2_000,
  abortGraceMs: 5_000,
  terminateGraceMs: 5_000,
  forceKillGraceMs: 2_000,
  maxHealthResponseBytes: 4 * 1024,
  maxInferenceUploadBytes: 1024 * 1024,
  maxInferenceResponseBytes:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxServerResponseBytes,
  maxActiveRequests:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxActiveNativeRequests,
  restartAfterAbort: true,
  parseHumanLogs: false,
  allowFetchDefaultTimeouts: false,
  allowMediaConversion: false,
} as const);

export const LOCAL_SUBTITLE_SERVER_CONTRACT_ERROR_CODES = [
  "invalid_configuration",
  "busy",
  "aborted",
  "timeout",
  "transport_failed",
  "http_error",
  "response_too_large",
  "invalid_response",
] as const;

export type LocalSubtitleServerContractErrorCode =
  (typeof LOCAL_SUBTITLE_SERVER_CONTRACT_ERROR_CODES)[number];

export type LocalSubtitleServerSessionDisposition =
  | "reusable"
  | "restart_required";

export interface LocalSubtitleServerContractErrorOptions {
  readonly localSubtitleCode: LocalSubtitleErrorCode;
  readonly sessionDisposition: LocalSubtitleServerSessionDisposition;
  readonly httpStatus?: number;
  readonly cause?: unknown;
}

export class LocalSubtitleServerContractError extends Error {
  readonly code: LocalSubtitleServerContractErrorCode;
  readonly localSubtitleCode: LocalSubtitleErrorCode;
  readonly sessionDisposition: LocalSubtitleServerSessionDisposition;
  readonly httpStatus?: number;

  constructor(
    code: LocalSubtitleServerContractErrorCode,
    message: string,
    options: LocalSubtitleServerContractErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalSubtitleServerContractError";
    this.code = code;
    this.localSubtitleCode = options.localSubtitleCode;
    this.sessionDisposition = options.sessionDisposition;
    this.httpStatus = options.httpStatus;
  }
}

export interface LocalSubtitleServerInferenceRequest {
  readonly requestGeneration: number;
  readonly filePath: string;
  readonly language: string;
  readonly taskMode: LocalSubtitleTaskMode;
  readonly beamSize: number;
  readonly temperature: number;
  readonly vadEnabled: boolean;
  readonly vadMinSilenceMs: number;
  readonly initialPrompt?: string;
  readonly signal?: AbortSignal;
}

export interface LocalSubtitleServerInferenceFields {
  readonly response_format: "verbose_json";
  readonly language: string;
  readonly translate: "true" | "false";
  readonly vad: "true" | "false";
  readonly token_timestamps: "false";
  readonly no_language_probabilities: "true";
  readonly beam_size: string;
  readonly temperature: string;
  readonly temperature_inc: "0.2";
  readonly no_timestamps: "false";
  readonly vad_min_silence_duration_ms?: string;
  readonly prompt?: string;
}

export interface LocalSubtitleServerRawSegment {
  readonly id: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly temperature: number;
  readonly averageLogProbability: number;
  readonly noSpeechProbability: number;
}

export interface LocalSubtitleServerInferenceResult {
  readonly contractVersion: typeof LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION;
  readonly task: "transcribe" | "translate";
  readonly language: string;
  readonly durationMs: number;
  readonly text: string;
  readonly segments: readonly LocalSubtitleServerRawSegment[];
  readonly wordTimelineStatus:
    | "not_requested"
    | "discarded_vad_compressed_timeline";
}

export interface LocalSubtitleServerInferenceResponse {
  readonly requestGeneration: number;
  readonly sessionDisposition: "reusable";
  readonly result: LocalSubtitleServerInferenceResult;
}

const safeIntegerSchema = z.number().int().safe();
const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const probabilitySchema = z.number().finite().min(0).max(1);
const boundedTextSchema = z
  .string()
  .max(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxServerResponseBytes)
  .refine(noUnsafeControlCharacters);

const rawWordSchema = z
  .object({
    word: z.string().max(LOCAL_SUBTITLE_LIMITS.maxCueTextChars),
    start: nonNegativeFiniteSchema.optional(),
    end: nonNegativeFiniteSchema.optional(),
    t_dtw: z.number().finite().optional(),
    probability: probabilitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.start === undefined) !== (value.end === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Word timestamps must include both start and end.",
      });
    }
    if (
      value.start !== undefined &&
      value.end !== undefined &&
      value.end < value.start
    ) {
      context.addIssue({
        code: "custom",
        message: "Word timestamps must be monotonic.",
      });
    }
  });

const rawSegmentSchema = z
  .object({
    id: safeIntegerSchema.nonnegative(),
    text: z
      .string()
      .max(LOCAL_SUBTITLE_LIMITS.maxCueTextChars)
      .refine(noUnsafeControlCharacters),
    start: nonNegativeFiniteSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxDurationMs / 1_000,
    ),
    end: nonNegativeFiniteSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxDurationMs / 1_000,
    ),
    tokens: z.array(safeIntegerSchema.nonnegative()).max(4_096).optional(),
    words: z
      .array(rawWordSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxWordsPerSegment)
      .optional(),
    temperature: z.number().finite().min(0).max(2),
    avg_logprob: z.number().finite(),
    no_speech_prob: probabilitySchema,
    compression_ratio: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.end >= value.start, {
    message: "Segment timestamps must be monotonic.",
  });

const verboseJsonSchema = z
  .object({
    task: z.enum(["transcribe", "translate"]),
    language: z.string().min(1).max(128).refine(noUnsafeControlCharacters),
    duration: nonNegativeFiniteSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxDurationMs / 1_000,
    ),
    text: boundedTextSchema,
    segments: z
      .array(rawSegmentSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments),
  })
  .strict();

const healthSchema = z.object({ status: z.literal("ok") }).strict();

export function createLocalSubtitleServerInferenceFields(
  request: Omit<
    LocalSubtitleServerInferenceRequest,
    "filePath" | "signal"
  >,
): LocalSubtitleServerInferenceFields {
  validateInferenceOptions(request);
  const fields: LocalSubtitleServerInferenceFields = {
    response_format: "verbose_json",
    language: mapLocalSubtitleLanguageToWhisper(request.language),
    translate:
      request.taskMode === "translate_to_english" ? "true" : "false",
    vad: request.vadEnabled ? "true" : "false",
    token_timestamps: "false",
    no_language_probabilities: "true",
    beam_size: String(request.beamSize),
    temperature: String(request.temperature),
    temperature_inc: "0.2",
    no_timestamps: "false",
    ...(request.vadEnabled
      ? { vad_min_silence_duration_ms: String(request.vadMinSilenceMs) }
      : {}),
    ...(request.initialPrompt === undefined
      ? {}
      : { prompt: request.initialPrompt }),
  };
  return Object.freeze(fields);
}

export function parseLocalSubtitleServerHealth(input: unknown): true {
  if (!healthSchema.safeParse(input).success) {
    throw invalidResponse("The local inference health response is invalid.");
  }
  return true;
}

export const LOCAL_SUBTITLE_WHISPER_LANGUAGE_CODES = [
  "af",
  "am",
  "ar",
  "as",
  "az",
  "ba",
  "be",
  "bg",
  "bn",
  "bo",
  "br",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fo",
  "fr",
  "gl",
  "gu",
  "ha",
  "haw",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "jw",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "la",
  "lb",
  "ln",
  "lo",
  "lt",
  "lv",
  "mg",
  "mi",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "ne",
  "nl",
  "nn",
  "no",
  "oc",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "sa",
  "sd",
  "si",
  "sk",
  "sl",
  "sn",
  "so",
  "sq",
  "sr",
  "su",
  "sv",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "tk",
  "tl",
  "tr",
  "tt",
  "uk",
  "ur",
  "uz",
  "vi",
  "yi",
  "yo",
  "yue",
  "zh",
] as const;

export function mapLocalSubtitleLanguageToWhisper(language: string): string {
  if (language === "auto") return language;
  const primary = language.split("-", 1)[0]!.toLowerCase();
  const alias = LANGUAGE_ALIASES[primary] ?? primary;
  if (
    !(LOCAL_SUBTITLE_WHISPER_LANGUAGE_CODES as readonly string[]).includes(alias)
  ) {
    throw invalidConfiguration(
      "The selected language is not supported by the pinned inference runtime.",
    );
  }
  return alias;
}

export function parseLocalSubtitleServerVerboseJson(
  input: unknown,
  options: {
    readonly taskMode: LocalSubtitleTaskMode;
    readonly vadEnabled: boolean;
  },
): LocalSubtitleServerInferenceResult {
  const parsed = verboseJsonSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidResponse("The local inference response does not match contract v1.");
  }
  const expectedTask =
    options.taskMode === "translate_to_english" ? "translate" : "transcribe";
  if (parsed.data.task !== expectedTask) {
    throw invalidResponse("The local inference response task does not match the request.");
  }

  let totalWords = 0;
  for (const segment of parsed.data.segments) {
    totalWords += segment.words?.length ?? 0;
    if (totalWords > LOCAL_SUBTITLE_LIMITS.maxTranscriptWords) {
      throw invalidResponse("The local inference response contains too many words.");
    }
  }

  return deepFreeze({
    contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    task: parsed.data.task,
    language: parsed.data.language,
    durationMs: secondsToMilliseconds(parsed.data.duration),
    text: parsed.data.text.trim(),
    segments: parsed.data.segments.map((segment) => ({
      id: segment.id,
      startMs: secondsToMilliseconds(segment.start),
      endMs: secondsToMilliseconds(segment.end),
      text: segment.text.trim(),
      temperature: segment.temperature,
      averageLogProbability: segment.avg_logprob,
      noSpeechProbability: segment.no_speech_prob,
    })),
    wordTimelineStatus: options.vadEnabled
      ? "discarded_vad_compressed_timeline"
      : "not_requested",
  });
}

export function validateLocalSubtitleServerInferenceRequest(
  request: LocalSubtitleServerInferenceRequest,
): void {
  if (typeof request.filePath !== "string" || request.filePath.length === 0) {
    throw invalidConfiguration("A main-owned normalized window is required.");
  }
  validateInferenceOptions(request);
}

export function invalidLocalSubtitleServerConfiguration(
  message: string,
): LocalSubtitleServerContractError {
  return invalidConfiguration(message);
}

export function invalidLocalSubtitleServerResponse(
  message: string,
  options: { readonly cause?: unknown } = {},
): LocalSubtitleServerContractError {
  return invalidResponse(message, options.cause);
}

function validateInferenceOptions(
  request: Omit<LocalSubtitleServerInferenceRequest, "filePath" | "signal">,
): void {
  if (!Number.isSafeInteger(request.requestGeneration) || request.requestGeneration < 1) {
    throw invalidConfiguration("The inference generation must be a positive integer.");
  }
  if (
    typeof request.language !== "string" ||
    request.language.length < 2 ||
    request.language.length > LOCAL_SUBTITLE_LIMITS.maxLanguageChars ||
    !(
      request.language === "auto" ||
      /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(request.language)
    )
  ) {
    throw invalidConfiguration("The inference language is invalid.");
  }
  if (
    request.taskMode !== "transcribe" &&
    request.taskMode !== "translate_to_english"
  ) {
    throw invalidConfiguration("The inference task mode is invalid.");
  }
  if (
    !Number.isSafeInteger(request.beamSize) ||
    request.beamSize < 1 ||
    request.beamSize > 10
  ) {
    throw invalidConfiguration("The inference beam size is invalid.");
  }
  if (
    typeof request.temperature !== "number" ||
    !Number.isFinite(request.temperature) ||
    request.temperature < 0 ||
    request.temperature > 1
  ) {
    throw invalidConfiguration("The inference temperature is invalid.");
  }
  if (typeof request.vadEnabled !== "boolean") {
    throw invalidConfiguration("The inference VAD preference is invalid.");
  }
  if (
    !Number.isSafeInteger(request.vadMinSilenceMs) ||
    request.vadMinSilenceMs < 100 ||
    request.vadMinSilenceMs > 5_000
  ) {
    throw invalidConfiguration("The VAD silence duration is invalid.");
  }
  if (
    request.initialPrompt !== undefined &&
    (typeof request.initialPrompt !== "string" ||
      request.initialPrompt.length > LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars ||
      !noUnsafeControlCharacters(request.initialPrompt))
  ) {
    throw invalidConfiguration("The inference prompt is invalid.");
  }
}

function secondsToMilliseconds(value: number): number {
  const milliseconds = Math.round(value * 1_000);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > LOCAL_SUBTITLE_LIMITS.maxDurationMs
  ) {
    throw invalidResponse("The local inference response contains an invalid timestamp.");
  }
  return milliseconds;
}

function noUnsafeControlCharacters(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  fil: "tl",
  in: "id",
  iw: "he",
  jv: "jw",
  nb: "no",
});

function invalidConfiguration(message: string): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError(
    "invalid_configuration",
    message,
    {
      localSubtitleCode: "runtime_protocol_mismatch",
      sessionDisposition: "reusable",
    },
  );
}

function invalidResponse(
  message: string,
  cause?: unknown,
): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError("invalid_response", message, {
    localSubtitleCode: "runtime_protocol_mismatch",
    sessionDisposition: "restart_required",
    cause,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
