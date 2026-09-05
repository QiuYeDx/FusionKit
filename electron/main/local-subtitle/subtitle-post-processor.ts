import {
  LOCAL_SUBTITLE_BACKENDS,
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_ENGINES,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleErrorCode,
  type LocalSubtitleInferenceSnapshot,
  type LocalSubtitleSegment,
  type LocalSubtitleTaskMode,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";
import { validateLocalSubtitleTranscript } from "@/type/localSubtitleIpc";
import { planLocalSubtitleReview, type LocalSubtitleReviewPlan } from "./local-review";
import type {
  LocalSubtitleServerInferenceResponse,
  LocalSubtitleServerInferenceResult,
  LocalSubtitleServerRawSegment,
} from "./server-contract";

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "grapheme",
});
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UNSAFE_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const QUALITY_COMPARISON_IGNORED_PATTERN = /[\p{P}\p{S}\s]+/gu;
const BOUNDARY_COMPARISON_IGNORED_PATTERN = /[\p{P}\s]+/gu;
const PUNCTUATION_ONLY_PATTERN = /^[\p{P}\s]+$/u;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const TERMINAL_PUNCTUATION_PATTERN = /[。！？.!?][”’」』】）)]*$/u;
const LEADING_PUNCTUATION_PATTERN = /^[\p{P}]/u;
const PREFERRED_BOUNDARY_PATTERN = /[。！？!?；;：:，,、…]/u;

export const LOCAL_SUBTITLE_POST_PROCESSING_POLICY = deepFreeze({
  schemaVersion: 1,
  pcmSampleRateHz: 16_000,
  rootWindowOverlapMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.overlapMs,
  boundaryToleranceMs:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.boundaryToleranceMs,
  maxRawSegmentDurationMs:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
  repeatedCueThreshold:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
  repeatedCoverageMs:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
  maxRetryDepth:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
  minRetryWindowMs: 4_000,
  retryOverlapMs: 2_000,
  minRetrySplitRatio: 1.25,
  boundaryTextGapMs: 500,
  boundaryTextMinCjkChars: 2,
  boundaryTextMinLatinChars: 4,
  shortCueMergeGapMs: 300,
  shortCueMergeMaxDurationMs: 1_000,
  maxCueLines: LOCAL_SUBTITLE_LIMITS.maxCueLines,
  qualityFingerprint: "nfkc-lowercase-without-punctuation-symbols-whitespace",
  boundaryFingerprint: "nfkc-lowercase-without-punctuation-whitespace",
  wordTimelineMode: "segment_only_v1",
} as const);

export type LocalSubtitlePostProcessorErrorCode =
  | "invalid_configuration"
  | "transcript_quality_failed"
  | "no_speech_detected"
  | "limit_exceeded";

export type LocalSubtitlePostProcessingStage =
  | "policy"
  | "window"
  | "coverage"
  | "merge"
  | "shaping"
  | "canonical";

export type LocalSubtitleRawQualityIssueCode =
  | "invalid_contract"
  | "non_positive_duration"
  | "reverse_order"
  | "overlap"
  | "out_of_window"
  | "overlong_segment"
  | "degenerate_repetition";

export interface LocalSubtitleRawQualityAssessment {
  readonly valid: boolean;
  readonly contractValid: boolean;
  readonly outcome: "speech" | "no_speech";
  readonly outcomeEvidence:
    | "non_empty_segment_text"
    | "empty_full_duration_server_response"
    | "invalid_contract";
  readonly issues: readonly LocalSubtitleRawQualityIssueCode[];
  readonly rawSegmentCount: number;
  readonly speechSegmentCount: number;
  readonly emptyTextSegmentCount: number;
  readonly normalizedUniqueTextCount: number;
  readonly nonPositiveDurationSegmentCount: number;
  readonly reverseOrderSegmentCount: number;
  readonly overlappingSegmentCount: number;
  readonly outOfWindowSegmentCount: number;
  readonly overlongSegmentCount: number;
  readonly invalidTimelineSegmentCount: number;
  readonly longestSegmentDurationMs: number;
  readonly longestConsecutiveRepeatCueCount: number;
  readonly longestConsecutiveRepeatSpanMs: number;
  readonly firstStartMs?: number;
  readonly lastEndMs?: number;
}

export interface LocalSubtitlePostProcessingWindow {
  readonly windowKey: string;
  readonly rootPlanId: string;
  readonly rootWindowKey: string;
  readonly parentWindowKey?: string;
  readonly retryDepth: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly coreStartFrame: number;
  readonly coreEndFrame: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly coreStartMs: number;
  readonly coreEndMs: number;
}

export interface LocalSubtitleRootWindowPlan {
  readonly schemaVersion: 1;
  readonly rootPlanId: string;
  readonly windows: readonly LocalSubtitlePostProcessingWindow[];
}

export interface LocalSubtitlePostProcessingWindowAttempt {
  readonly window: LocalSubtitlePostProcessingWindow;
  readonly windowAttempt: number;
  readonly processEpoch: number;
  readonly requestGeneration: number;
  readonly response: LocalSubtitleServerInferenceResponse;
}

export interface LocalSubtitlePostProcessPolicy {
  readonly schemaVersion: 1;
  readonly vadEnabled: boolean;
  readonly wordTimelineMode: "segment_only_v1";
  readonly qualityFingerprint: "nfkc-lowercase-without-punctuation-symbols-whitespace";
  readonly boundaryFingerprint: "nfkc-lowercase-without-punctuation-whitespace";
  readonly pcmSampleRateHz: number;
  readonly maxCueDurationMs: number;
  readonly maxCueChars: number;
  readonly maxLineChars: number;
  readonly maxCueLines: number;
  readonly maxWindowDurationMs: number;
  readonly rootWindowOverlapMs: number;
  readonly boundaryToleranceMs: number;
  readonly maxRawSegmentDurationMs: number;
  readonly repeatedCueThreshold: number;
  readonly repeatedCoverageMs: number;
  readonly maxRetryDepth: number;
  readonly minRetryWindowMs: number;
  readonly retryOverlapMs: number;
  readonly minRetrySplitRatio: number;
  readonly boundaryTextGapMs: number;
  readonly boundaryTextMinCjkChars: number;
  readonly boundaryTextMinLatinChars: number;
  readonly shortCueMergeGapMs: number;
  readonly shortCueMergeMaxDurationMs: number;
}

export interface LocalSubtitleWindowRetryTarget {
  readonly rootPlanId: string;
  readonly rootWindowKey: string;
  readonly parentWindowKey?: string;
  readonly windowKey: string;
  readonly windowAttempt: number;
  readonly retryDepth: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly processEpoch: number;
  readonly requestGeneration: number;
}

export type LocalSubtitleWindowRetryDecision =
  | {
      readonly action: "accept";
      readonly retryTarget: LocalSubtitleWindowRetryTarget;
      readonly outcome: "speech" | "no_speech";
      readonly outcomeEvidence:
        | "non_empty_segment_text"
        | "empty_full_duration_server_response";
    }
  | {
      readonly action: "split";
      readonly retryTarget: LocalSubtitleWindowRetryTarget;
      readonly reason: Exclude<
        LocalSubtitleRawQualityIssueCode,
        "invalid_contract"
      >;
      readonly nextDepth: number;
      readonly splitPolicy: Readonly<{
        windowMs: number;
        overlapMs: number;
      }>;
      readonly children: readonly [
        LocalSubtitlePostProcessingWindow,
        LocalSubtitlePostProcessingWindow,
      ];
    }
  | {
      readonly action: "fail";
      readonly retryTarget: LocalSubtitleWindowRetryTarget;
      readonly reason:
        | "contract_invalid"
        | "retry_exhausted"
        | "unsplittable";
    };

export type LocalSubtitlePostProcessingWarningCode =
  | "timeline_boundary_clamped"
  | "estimated_timing_used";

export interface LocalSubtitlePostProcessingWarning {
  readonly code: LocalSubtitlePostProcessingWarningCode;
  readonly count: number;
}

export interface LocalSubtitlePostProcessingReport {
  readonly localReview: LocalSubtitleReviewPlan;
  readonly policy: LocalSubtitlePostProcessPolicy;
  readonly attemptedWindowCount: number;
  readonly acceptedLeafWindowCount: number;
  readonly retryReplacementCount: number;
  readonly processEpochCount: number;
  readonly noSpeechWindowCount: number;
  readonly maximumRetryDepth: number;
  readonly windowExecutionCoverage: 1;
  readonly rawSegmentCount: number;
  readonly emptyRawSegmentCount: number;
  readonly normalizedUniqueRawTextCount: number;
  readonly invalidRawTimelineSegmentCount: number;
  readonly overlongRawSegmentCount: number;
  readonly longestConsecutiveRepeatCueCount: number;
  readonly longestConsecutiveRepeatSpanMs: number;
  readonly projectedSegmentCount: number;
  readonly duplicateBoundarySegmentCount: number;
  readonly trimmedBoundaryPrefixCount: number;
  readonly droppedBoundaryFragmentCount: number;
  readonly timelineOverlapAdjustmentCount: number;
  readonly timelineBoundaryClampCount: number;
  readonly splitSegmentCount: number;
  readonly shortCueMergeCount: number;
  readonly estimatedTimingSegmentCount: number;
  readonly finalSegmentCount: number;
  readonly firstFinalStartMs: number;
  readonly lastFinalEndMs: number;
}

export interface LocalSubtitlePostProcessingRequest {
  readonly source: LocalSubtitleTranscript["source"] & {
    readonly totalFrames: number;
    readonly sampleRateHz: number;
  };
  readonly model: LocalSubtitleTranscript["model"];
  readonly taskMode: LocalSubtitleTaskMode;
  readonly detectedLanguage?: string;
  readonly languageProbability?: number;
  readonly policy: LocalSubtitlePostProcessPolicy;
  readonly rootPlan: LocalSubtitleRootWindowPlan;
  readonly attempts: readonly LocalSubtitlePostProcessingWindowAttempt[];
}

export interface LocalSubtitlePostProcessingResult {
  readonly transcript: LocalSubtitleTranscript;
  readonly warnings: readonly LocalSubtitlePostProcessingWarning[];
  readonly report: LocalSubtitlePostProcessingReport;
}

export interface LocalSubtitlePostProcessorErrorDetails {
  readonly reason: string;
  readonly rootPlanId?: string;
  readonly rootWindowKey?: string;
  readonly parentWindowKey?: string;
  readonly windowKey?: string;
  readonly windowAttempt?: number;
  readonly retryDepth?: number;
  readonly windowStartMs?: number;
  readonly windowEndMs?: number;
  readonly qualityRecoveryAttempts?: number;
  readonly maxQualityRecoveryAttempts?: number;
  readonly processEpoch?: number;
  readonly requestGeneration?: number;
  readonly observed?: number;
  readonly limit?: number;
  readonly assessment?: LocalSubtitleRawQualityAssessment;
  readonly retryDecision?: LocalSubtitleWindowRetryDecision;
}

export class LocalSubtitlePostProcessorError extends Error {
  readonly code: LocalSubtitlePostProcessorErrorCode;
  readonly localSubtitleCode: LocalSubtitleErrorCode;
  readonly stage: LocalSubtitlePostProcessingStage;
  readonly details?: LocalSubtitlePostProcessorErrorDetails;

  constructor(
    code: LocalSubtitlePostProcessorErrorCode,
    message: string,
    options: {
      readonly localSubtitleCode: LocalSubtitleErrorCode;
      readonly stage: LocalSubtitlePostProcessingStage;
      readonly details?: LocalSubtitlePostProcessorErrorDetails;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LocalSubtitlePostProcessorError";
    this.code = code;
    this.localSubtitleCode = options.localSubtitleCode;
    this.stage = options.stage;
    this.details =
      options.details === undefined
        ? undefined
        : deepFreeze(structuredClone(options.details));
  }
}

interface TimelineSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

interface WorkingSegment {
  startMs: number;
  endMs: number;
  text: string;
  sourceWindowKey: string;
  sourceWindowOrder: number;
  sourceSegmentOrder: number;
  sourceWindowStartFrame: number;
  sourceWindowEndFrame: number;
  sourceWindowCoreStartFrame: number;
  sourceWindowCoreEndFrame: number;
  sourceWindowStartMs: number;
  sourceWindowEndMs: number;
  rawObservationStartMs: number;
  rawObservationEndMs: number;
  estimatedTiming?: true;
}

interface MergeDiagnostics {
  projectedSegmentCount: number;
  duplicateBoundarySegmentCount: number;
  trimmedBoundaryPrefixCount: number;
  droppedBoundaryFragmentCount: number;
  timelineOverlapAdjustmentCount: number;
  timelineBoundaryClampCount: number;
}

interface ShapingDiagnostics {
  splitSegmentCount: number;
  shortCueMergeCount: number;
  estimatedTimingSegmentCount: number;
}

export function createSubtitlePostProcessPolicy(
  inference: LocalSubtitleInferenceSnapshot,
): LocalSubtitlePostProcessPolicy {
  if (!isRecord(inference)) {
    throw invalidConfiguration(
      "The local subtitle inference snapshot is invalid.",
      "policy",
      "invalid_inference_snapshot",
    );
  }
  const rawQualityGate = inference.rawQualityGate;
  if (
    !rawQualityGate ||
    rawQualityGate.maxSegmentDurationMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRawSegmentDurationMs ||
    rawQualityGate.repeatedCueThreshold !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCueThreshold ||
    rawQualityGate.repeatedCoverageMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCoverageMs ||
    rawQualityGate.maxRetryDepth !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRetryDepth
  ) {
    throw invalidConfiguration(
      "The raw transcript quality policy does not match contract v1.",
      "policy",
      "quality_policy_mismatch",
    );
  }
  if (
    !inference.vad ||
    typeof inference.vad.enabled !== "boolean" ||
    inference.vad.tokenTimestamps !== false ||
    inference.vad.timelinePolicy !==
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy
  ) {
    throw invalidConfiguration(
      "The local subtitle inference policy is invalid.",
      "policy",
      "inference_policy_mismatch",
    );
  }

  const advanced = inference.advanced;
  if (
    !advanced ||
    !isSafeIntegerBetween(
      advanced.maxCueDurationMs,
      500,
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRawSegmentDurationMs,
    ) ||
    !isSafeIntegerBetween(
      advanced.maxCueChars,
      20,
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars,
    ) ||
    !isSafeIntegerBetween(
      advanced.maxLineChars,
      10,
      LOCAL_SUBTITLE_LIMITS.maxLineChars,
    )
  ) {
    throw invalidConfiguration(
      "The local subtitle shaping settings are invalid.",
      "policy",
      "shaping_policy_invalid",
    );
  }

  return deepFreeze({
    schemaVersion: 1,
    vadEnabled: inference.vad.enabled,
    wordTimelineMode: "segment_only_v1",
    qualityFingerprint: LOCAL_SUBTITLE_POST_PROCESSING_POLICY.qualityFingerprint,
    boundaryFingerprint:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryFingerprint,
    pcmSampleRateHz: LOCAL_SUBTITLE_POST_PROCESSING_POLICY.pcmSampleRateHz,
    maxCueDurationMs: advanced.maxCueDurationMs,
    maxCueChars: advanced.maxCueChars,
    maxLineChars: advanced.maxLineChars,
    maxCueLines: LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxCueLines,
    maxWindowDurationMs:
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.pcmWindowMs,
    rootWindowOverlapMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.rootWindowOverlapMs,
    boundaryToleranceMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryToleranceMs,
    maxRawSegmentDurationMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRawSegmentDurationMs,
    repeatedCueThreshold:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCueThreshold,
    repeatedCoverageMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCoverageMs,
    maxRetryDepth: LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRetryDepth,
    minRetryWindowMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.minRetryWindowMs,
    retryOverlapMs: LOCAL_SUBTITLE_POST_PROCESSING_POLICY.retryOverlapMs,
    minRetrySplitRatio:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.minRetrySplitRatio,
    boundaryTextGapMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextGapMs,
    boundaryTextMinCjkChars:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinCjkChars,
    boundaryTextMinLatinChars:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinLatinChars,
    shortCueMergeGapMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.shortCueMergeGapMs,
    shortCueMergeMaxDurationMs:
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.shortCueMergeMaxDurationMs,
  });
}

export function planLocalSubtitleRootWindows(input: {
  readonly rootPlanId: string;
  readonly totalFrames: number;
  readonly policy: LocalSubtitlePostProcessPolicy;
}): LocalSubtitleRootWindowPlan {
  validatePolicy(input.policy);
  validateSafeId(input.rootPlanId, "root_plan_id_invalid", "coverage");
  if (!Number.isSafeInteger(input.totalFrames) || input.totalFrames <= 0) {
    throw invalidConfiguration(
      "The root window plan requires a positive PCM frame count.",
      "coverage",
      "root_plan_frame_count_invalid",
    );
  }
  const roundedDurationMs = framesToMilliseconds(
    input.totalFrames,
    input.policy.pcmSampleRateHz,
  );
  if (
    !Number.isSafeInteger(roundedDurationMs) ||
    roundedDurationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs
  ) {
    throw limitExceeded(
      "The root window plan exceeds the canonical media duration limit.",
      "coverage",
      roundedDurationMs,
      LOCAL_SUBTITLE_LIMITS.maxDurationMs,
    );
  }
  const windows = planWindowRange({
    rootPlanId: input.rootPlanId,
    rootWindowKey: undefined,
    parentWindowKey: undefined,
    retryDepth: 0,
    rangeStartFrame: 0,
    rangeEndFrame: input.totalFrames,
    ownedStartFrame: 0,
    ownedEndFrame: input.totalFrames,
    windowMs: input.policy.maxWindowDurationMs,
    overlapMs: input.policy.rootWindowOverlapMs,
    sampleRateHz: input.policy.pcmSampleRateHz,
    keyForIndex: (index) => `w${String(index).padStart(6, "0")}`,
  });
  return deepFreeze({ schemaVersion: 1, rootPlanId: input.rootPlanId, windows });
}

export function planLocalSubtitleRetryChildren(input: {
  readonly parent: LocalSubtitlePostProcessingWindow;
  readonly splitPolicy: Readonly<{ windowMs: number; overlapMs: number }>;
  readonly policy: LocalSubtitlePostProcessPolicy;
}): readonly [
  LocalSubtitlePostProcessingWindow,
  LocalSubtitlePostProcessingWindow,
] {
  validatePolicy(input.policy);
  validateWindowDescriptor(input.parent, input.policy, "window");
  const children = planWindowRange({
    rootPlanId: input.parent.rootPlanId,
    rootWindowKey: input.parent.rootWindowKey,
    parentWindowKey: input.parent.windowKey,
    retryDepth: input.parent.retryDepth + 1,
    rangeStartFrame: input.parent.startFrame,
    rangeEndFrame: input.parent.endFrame,
    ownedStartFrame: input.parent.coreStartFrame,
    ownedEndFrame: input.parent.coreEndFrame,
    windowMs: input.splitPolicy.windowMs,
    overlapMs: input.splitPolicy.overlapMs,
    sampleRateHz: input.policy.pcmSampleRateHz,
    keyForIndex: (index) =>
      `${input.parent.windowKey}.c${String(index).padStart(3, "0")}`,
  });
  if (children.length !== 2) {
    throw invalidConfiguration(
      "The retry policy did not produce exactly two child windows.",
      "window",
      "retry_children_invalid",
    );
  }
  return deepFreeze([
    children[0]!,
    children[1]!,
  ] as const);
}

export function assessLocalSubtitleRawWindow(input: {
  readonly window: LocalSubtitlePostProcessingWindow;
  readonly result: LocalSubtitleServerInferenceResult;
  readonly policy: LocalSubtitlePostProcessPolicy;
}): LocalSubtitleRawQualityAssessment {
  validatePolicy(input.policy);
  validateWindowDescriptor(input.window, input.policy, "window");
  const durationMs = input.window.endMs - input.window.startMs;
  const resultHasText =
    isRecord(input.result) &&
    typeof input.result.text === "string" &&
    isSafeUnicodeText(input.result.text) &&
    normalizeSubtitleText(input.result.text).length > 0;
  const segmentsHaveText =
    isRecord(input.result) &&
    Array.isArray(input.result.segments) &&
    input.result.segments.some(
      (segment) =>
        isRecord(segment) &&
        typeof segment.text === "string" &&
        isSafeUnicodeText(segment.text) &&
        normalizeSubtitleText(segment.text).length > 0,
    );
  const contractValid =
    isInferenceResultContractValid(input.result) &&
    input.result.durationMs > 0 &&
    Math.abs(input.result.durationMs - durationMs) <=
      input.policy.boundaryToleranceMs &&
    resultHasText === segmentsHaveText &&
    input.result.wordTimelineStatus ===
      (input.policy.vadEnabled
        ? "discarded_vad_compressed_timeline"
        : "not_requested");
  if (!contractValid) {
    return emptyInvalidAssessment("invalid_contract");
  }
  return assessTimelineSegments(input.result.segments, durationMs, input.policy);
}

export function decideLocalSubtitleWindowRetry(input: {
  readonly attempt: LocalSubtitlePostProcessingWindowAttempt;
  readonly assessment: LocalSubtitleRawQualityAssessment;
  readonly policy: LocalSubtitlePostProcessPolicy;
}): LocalSubtitleWindowRetryDecision {
  validatePolicy(input.policy);
  validateWindowAttemptIdentity(input.attempt, input.policy);
  const window = input.attempt.window;
  const retryTarget = createRetryTarget(input.attempt);
  if (
    input.assessment.valid &&
    input.assessment.outcomeEvidence !== "invalid_contract"
  ) {
    return deepFreeze({
      action: "accept",
      retryTarget,
      outcome: input.assessment.outcome,
      outcomeEvidence: input.assessment.outcomeEvidence,
    });
  }
  if (!input.assessment.contractValid) {
    return deepFreeze({
      action: "fail",
      retryTarget,
      reason: "contract_invalid",
    });
  }
  if (window.retryDepth >= input.policy.maxRetryDepth) {
    return deepFreeze({
      action: "fail",
      retryTarget,
      reason: "retry_exhausted",
    });
  }

  const durationMs = window.endMs - window.startMs;
  if (
    durationMs <=
    input.policy.minRetryWindowMs * input.policy.minRetrySplitRatio
  ) {
    return deepFreeze({ action: "fail", retryTarget, reason: "unsplittable" });
  }
  const overlapMs = Math.min(
    input.policy.retryOverlapMs,
    Math.floor(durationMs / 4),
  );
  const windowMs = Math.max(
    input.policy.minRetryWindowMs,
    Math.ceil((durationMs + overlapMs) / 2),
  );
  if (windowMs >= durationMs) {
    return deepFreeze({ action: "fail", retryTarget, reason: "unsplittable" });
  }

  const reason = input.assessment.issues.find(
    (issue): issue is Exclude<LocalSubtitleRawQualityIssueCode, "invalid_contract"> =>
      issue !== "invalid_contract",
  );
  if (!reason) {
    return deepFreeze({
      action: "fail",
      retryTarget,
      reason: "contract_invalid",
    });
  }
  const splitPolicy = { windowMs, overlapMs } as const;
  let children: readonly [
    LocalSubtitlePostProcessingWindow,
    LocalSubtitlePostProcessingWindow,
  ];
  try {
    children = planLocalSubtitleRetryChildren({
      parent: window,
      splitPolicy,
      policy: input.policy,
    });
  } catch {
    return deepFreeze({ action: "fail", retryTarget, reason: "unsplittable" });
  }
  return deepFreeze({
    action: "split",
    retryTarget,
    reason,
    nextDepth: window.retryDepth + 1,
    splitPolicy,
    children,
  });
}

export function postProcessLocalSubtitleTranscript(
  input: LocalSubtitlePostProcessingRequest,
): LocalSubtitlePostProcessingResult {
  validatePolicy(input.policy);
  validateSourceAndModel(input);
  const graph = validateExecutionGraph(input);
  const { leaves, leafAssessments: assessments } = graph;

  const mergeDiagnostics: MergeDiagnostics = {
    projectedSegmentCount: 0,
    duplicateBoundarySegmentCount: 0,
    trimmedBoundaryPrefixCount: 0,
    droppedBoundaryFragmentCount: 0,
    timelineOverlapAdjustmentCount: 0,
    timelineBoundaryClampCount: 0,
  };
  const merged = mergeAcceptedWindows(
    leaves,
    input.source.durationMs,
    input.policy,
    mergeDiagnostics,
  );
  if (merged.length === 0) {
    throw noSpeechDetected("accepted_windows_contain_no_speech");
  }

  const mergedAssessment = assessTimelineSegments(
    merged,
    input.source.durationMs,
    input.policy,
  );
  if (!mergedAssessment.valid) {
    throw new LocalSubtitlePostProcessorError(
      "transcript_quality_failed",
      "The merged transcript failed the raw quality gate.",
      {
        localSubtitleCode: "transcript_quality_failed",
        stage: "merge",
        details: {
          reason: mergedAssessment.issues[0] ?? "merged_quality_failed",
          assessment: mergedAssessment,
        },
      },
    );
  }

  const shapingDiagnostics: ShapingDiagnostics = {
    splitSegmentCount: 0,
    shortCueMergeCount: 0,
    estimatedTimingSegmentCount: 0,
  };
  const shaped = shapeCanonicalSegments(
    merged,
    input.policy,
    shapingDiagnostics,
  );
  if (shaped.length === 0) {
    throw noSpeechDetected("canonical_transcript_is_empty");
  }
  if (shaped.length > LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments) {
    throw limitExceeded(
      "The canonical transcript contains too many segments.",
      "canonical",
      shaped.length,
      LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments,
    );
  }

  const candidate: LocalSubtitleTranscript = {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    source: {
      displayName: input.source.displayName,
      durationMs: input.source.durationMs,
    },
    model: { ...input.model },
    ...(input.detectedLanguage === undefined
      ? {}
      : { detectedLanguage: input.detectedLanguage }),
    ...(input.languageProbability === undefined
      ? {}
      : { languageProbability: input.languageProbability }),
    segments: shaped.map((segment, index) => ({
      id: `cue-${String(index + 1).padStart(6, "0")}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      ...(segment.estimatedTiming ? { estimatedTiming: true as const } : {}),
    })),
  };
  const validated = validateLocalSubtitleTranscript(candidate);
  if (!validated.ok) {
    throw new LocalSubtitlePostProcessorError(
      "transcript_quality_failed",
      "The canonical transcript does not satisfy the versioned schema.",
      {
        localSubtitleCode: "invalid_content",
        stage: "canonical",
        details: { reason: "canonical_schema_rejected" },
      },
    );
  }

  const rawNormalizedTexts = new Set<string>();
  let rawSegmentCount = 0;
  let emptyRawSegmentCount = 0;
  for (const leaf of leaves) {
    for (const segment of leaf.response.result.segments) {
      rawSegmentCount += 1;
      const displayText = normalizeSubtitleText(segment.text);
      if (!displayText) emptyRawSegmentCount += 1;
      const fingerprint = qualityFingerprint(displayText);
      if (fingerprint) rawNormalizedTexts.add(fingerprint);
    }
  }

  const warnings: LocalSubtitlePostProcessingWarning[] = [];
  if (mergeDiagnostics.timelineBoundaryClampCount > 0) {
    warnings.push({
      code: "timeline_boundary_clamped",
      count: mergeDiagnostics.timelineBoundaryClampCount,
    });
  }
  if (shapingDiagnostics.estimatedTimingSegmentCount > 0) {
    warnings.push({
      code: "estimated_timing_used",
      count: shapingDiagnostics.estimatedTimingSegmentCount,
    });
  }

  return deepFreeze({
    transcript: validated.data,
    warnings,
    report: {
      localReview: planLocalSubtitleReview({
        durationMs: input.source.durationMs,
        segments: merged,
        estimatedTimingConcerns: shaped.filter(segment => segment.estimatedTiming),
      }),
      policy: input.policy,
      attemptedWindowCount: input.attempts.length,
      acceptedLeafWindowCount: leaves.length,
      retryReplacementCount: graph.retryReplacementCount,
      processEpochCount: new Set(
        input.attempts.map((attempt) => attempt.processEpoch),
      ).size,
      noSpeechWindowCount: assessments.filter(
        (assessment) => assessment.outcome === "no_speech",
      ).length,
      maximumRetryDepth: input.attempts.reduce(
        (maximum, attempt) => Math.max(maximum, attempt.window.retryDepth),
        0,
      ),
      windowExecutionCoverage: 1,
      rawSegmentCount,
      emptyRawSegmentCount,
      normalizedUniqueRawTextCount: rawNormalizedTexts.size,
      invalidRawTimelineSegmentCount: assessments.reduce(
        (sum, assessment) => sum + assessment.invalidTimelineSegmentCount,
        0,
      ),
      overlongRawSegmentCount: assessments.reduce(
        (sum, assessment) => sum + assessment.overlongSegmentCount,
        0,
      ),
      longestConsecutiveRepeatCueCount:
        mergedAssessment.longestConsecutiveRepeatCueCount,
      longestConsecutiveRepeatSpanMs:
        mergedAssessment.longestConsecutiveRepeatSpanMs,
      projectedSegmentCount: mergeDiagnostics.projectedSegmentCount,
      duplicateBoundarySegmentCount:
        mergeDiagnostics.duplicateBoundarySegmentCount,
      trimmedBoundaryPrefixCount:
        mergeDiagnostics.trimmedBoundaryPrefixCount,
      droppedBoundaryFragmentCount:
        mergeDiagnostics.droppedBoundaryFragmentCount,
      timelineOverlapAdjustmentCount:
        mergeDiagnostics.timelineOverlapAdjustmentCount,
      timelineBoundaryClampCount:
        mergeDiagnostics.timelineBoundaryClampCount,
      splitSegmentCount: shapingDiagnostics.splitSegmentCount,
      shortCueMergeCount: shapingDiagnostics.shortCueMergeCount,
      estimatedTimingSegmentCount:
        shapingDiagnostics.estimatedTimingSegmentCount,
      finalSegmentCount: validated.data.segments.length,
      firstFinalStartMs: validated.data.segments[0]!.startMs,
      lastFinalEndMs: validated.data.segments.at(-1)!.endMs,
    },
  });
}

function assessTimelineSegments(
  segments: readonly TimelineSegment[],
  durationMs: number,
  policy: LocalSubtitlePostProcessPolicy,
): LocalSubtitleRawQualityAssessment {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw invalidConfiguration(
      "Transcript assessment requires a positive integer duration.",
      "window",
      "invalid_window_duration",
    );
  }

  const issues = new Set<LocalSubtitleRawQualityIssueCode>();
  const uniqueTexts = new Set<string>();
  const invalidTimelineIndexes = new Set<number>();
  let contractValid = true;
  let speechSegmentCount = 0;
  let emptyTextSegmentCount = 0;
  let nonPositiveDurationSegmentCount = 0;
  let reverseOrderSegmentCount = 0;
  let overlappingSegmentCount = 0;
  let outOfWindowSegmentCount = 0;
  let overlongSegmentCount = 0;
  let longestSegmentDurationMs = 0;
  let firstStartMs: number | undefined;
  let lastEndMs: number | undefined;
  let previous: { startMs: number; endMs: number } | undefined;
  let currentRun:
    | {
        fingerprint: string;
        cueCount: number;
        startMs: number;
        maximumEndMs: number;
      }
    | undefined;
  let longestRun = { cueCount: 0, spanMs: 0 };
  let repetitionDegenerate = false;

  for (const [index, value] of segments.entries()) {
    if (!isTimelineSegmentContractValid(value)) {
      contractValid = false;
      issues.add("invalid_contract");
      continue;
    }
    const { startMs, endMs } = value;
    const displayText = normalizeSubtitleText(value.text);
    const fingerprint = qualityFingerprint(displayText);
    if (displayText.length === 0) emptyTextSegmentCount += 1;
    else speechSegmentCount += 1;
    if (fingerprint) uniqueTexts.add(fingerprint);

    if (endMs <= startMs) {
      nonPositiveDurationSegmentCount += 1;
      invalidTimelineIndexes.add(index);
      issues.add("non_positive_duration");
    }
    const segmentDurationMs = endMs - startMs;
    if (segmentDurationMs > longestSegmentDurationMs) {
      longestSegmentDurationMs = segmentDurationMs;
    }
    if (segmentDurationMs > policy.maxRawSegmentDurationMs) {
      overlongSegmentCount += 1;
      // Whisper can legitimately emit a long segment for sparse speech. This
      // is a shaping concern, not evidence that the transcript is corrupt.
      // Canonical cue shaping below still enforces maxCueDurationMs, preserves
      // the text once, and marks any adjusted display timing as estimated.
    }
    if (
      startMs < -policy.boundaryToleranceMs ||
      endMs > durationMs + policy.boundaryToleranceMs
    ) {
      outOfWindowSegmentCount += 1;
      invalidTimelineIndexes.add(index);
      issues.add("out_of_window");
    }
    if (previous) {
      if (startMs < previous.startMs - policy.boundaryToleranceMs) {
        reverseOrderSegmentCount += 1;
        invalidTimelineIndexes.add(index);
        issues.add("reverse_order");
      }
      if (startMs < previous.endMs - policy.boundaryToleranceMs) {
        overlappingSegmentCount += 1;
        invalidTimelineIndexes.add(index);
        issues.add("overlap");
      }
    }
    firstStartMs =
      firstStartMs === undefined ? startMs : Math.min(firstStartMs, startMs);
    lastEndMs =
      lastEndMs === undefined ? endMs : Math.max(lastEndMs, endMs);

    if (fingerprint && currentRun?.fingerprint === fingerprint) {
      currentRun.cueCount += 1;
      currentRun.maximumEndMs = Math.max(currentRun.maximumEndMs, endMs);
    } else if (fingerprint) {
      currentRun = {
        fingerprint,
        cueCount: 1,
        startMs,
        maximumEndMs: endMs,
      };
    } else {
      currentRun = undefined;
    }
    if (
      currentRun &&
      (currentRun.cueCount > longestRun.cueCount ||
        (currentRun.cueCount === longestRun.cueCount &&
          repeatSpanMs(currentRun) > longestRun.spanMs))
    ) {
      longestRun = {
        cueCount: currentRun.cueCount,
        spanMs: repeatSpanMs(currentRun),
      };
    }
    if (
      currentRun &&
      currentRun.cueCount >= policy.repeatedCueThreshold &&
      repeatSpanMs(currentRun) >= policy.repeatedCoverageMs
    ) {
      repetitionDegenerate = true;
    }
    previous = { startMs, endMs };
  }

  if (repetitionDegenerate) {
    issues.add("degenerate_repetition");
  }

  return deepFreeze({
    valid: contractValid && issues.size === 0,
    contractValid,
    outcome: speechSegmentCount > 0 ? "speech" : "no_speech",
    outcomeEvidence:
      speechSegmentCount > 0
        ? "non_empty_segment_text"
        : "empty_full_duration_server_response",
    issues: [...issues],
    rawSegmentCount: segments.length,
    speechSegmentCount,
    emptyTextSegmentCount,
    normalizedUniqueTextCount: uniqueTexts.size,
    nonPositiveDurationSegmentCount,
    reverseOrderSegmentCount,
    overlappingSegmentCount,
    outOfWindowSegmentCount,
    overlongSegmentCount,
    invalidTimelineSegmentCount: invalidTimelineIndexes.size,
    longestSegmentDurationMs,
    longestConsecutiveRepeatCueCount: longestRun.cueCount,
    longestConsecutiveRepeatSpanMs: longestRun.spanMs,
    ...(firstStartMs === undefined ? {} : { firstStartMs }),
    ...(lastEndMs === undefined ? {} : { lastEndMs }),
  });
}

function validateExecutionGraph(input: LocalSubtitlePostProcessingRequest): {
  readonly leaves: readonly LocalSubtitlePostProcessingWindowAttempt[];
  readonly leafAssessments: readonly LocalSubtitleRawQualityAssessment[];
  readonly retryReplacementCount: number;
} {
  validateRootPlan(input);
  if (
    !Array.isArray(input.attempts) ||
    input.attempts.length === 0 ||
    input.attempts.length > LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments
  ) {
    throw graphFailure("attempt_graph_missing_or_too_large");
  }
  for (const attempt of input.attempts) {
    validateWindowAttemptIdentity(attempt, input.policy);
  }

  const attempts = [...input.attempts].sort((left, right) =>
    left.window.windowKey.localeCompare(right.window.windowKey) ||
    left.windowAttempt - right.windowAttempt ||
    left.processEpoch - right.processEpoch ||
    left.response.requestGeneration - right.response.requestGeneration,
  );
  const attemptsByKey = new Map<string, LocalSubtitlePostProcessingWindowAttempt>();
  const attemptNumbers = new Set<number>();
  const executionKeys = new Set<string>();
  const childrenByParent = new Map<
    string,
    LocalSubtitlePostProcessingWindowAttempt[]
  >();

  for (const attempt of attempts) {
    validateWindowFrameTimeMapping(attempt.window, input.source.sampleRateHz);
    const window = attempt.window;
    if (
      attempt.response.result.task !==
      (input.taskMode === "translate_to_english" ? "translate" : "transcribe")
    ) {
      throw graphFailure("attempt_task_mode_mismatch", createRetryTarget(attempt));
    }
    if (
      window.rootPlanId !== input.rootPlan.rootPlanId ||
      window.endFrame > input.source.totalFrames ||
      window.coreEndFrame > input.source.totalFrames ||
      window.endMs > input.source.durationMs ||
      window.coreEndMs > input.source.durationMs
    ) {
      throw graphFailure("attempt_outside_root_plan", createRetryTarget(attempt));
    }
    if (attemptsByKey.has(window.windowKey)) {
      throw graphFailure("duplicate_window_attempt", createRetryTarget(attempt));
    }
    attemptsByKey.set(window.windowKey, attempt);
    if (attemptNumbers.has(attempt.windowAttempt)) {
      throw graphFailure("duplicate_window_attempt_number", createRetryTarget(attempt));
    }
    attemptNumbers.add(attempt.windowAttempt);
    const executionKey = `${attempt.processEpoch}:${attempt.requestGeneration}`;
    if (executionKeys.has(executionKey)) {
      throw graphFailure("duplicate_execution_generation", createRetryTarget(attempt));
    }
    executionKeys.add(executionKey);
    if (window.parentWindowKey !== undefined) {
      const siblings = childrenByParent.get(window.parentWindowKey) ?? [];
      siblings.push(attempt);
      childrenByParent.set(window.parentWindowKey, siblings);
    }
  }

  const plannedRootsByKey = new Map(
    input.rootPlan.windows.map((window) => [window.windowKey, window] as const),
  );
  for (const attempt of attempts) {
    const { window } = attempt;
    if (window.parentWindowKey === undefined) {
      const planned = plannedRootsByKey.get(window.windowKey);
      if (!planned || !sameWindowDescriptor(planned, window)) {
        throw graphFailure("root_attempt_not_in_plan", createRetryTarget(attempt));
      }
      continue;
    }
    const parent = attemptsByKey.get(window.parentWindowKey);
    if (
      !parent ||
      window.rootWindowKey !== parent.window.rootWindowKey ||
      window.rootPlanId !== parent.window.rootPlanId ||
      window.retryDepth !== parent.window.retryDepth + 1 ||
      attempt.windowAttempt <= parent.windowAttempt
    ) {
      throw graphFailure("child_lineage_invalid", createRetryTarget(attempt));
    }
  }

  const leaves: LocalSubtitlePostProcessingWindowAttempt[] = [];
  const leafAssessments: LocalSubtitleRawQualityAssessment[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let retryReplacementCount = 0;

  const visit = (attempt: LocalSubtitlePostProcessingWindowAttempt): void => {
    const key = attempt.window.windowKey;
    if (visiting.has(key)) {
      throw graphFailure("attempt_graph_cycle", createRetryTarget(attempt));
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const assessment = assessLocalSubtitleRawWindow({
      window: attempt.window,
      result: attempt.response.result,
      policy: input.policy,
    });
    const decision = decideLocalSubtitleWindowRetry({
      attempt,
      assessment,
      policy: input.policy,
    });
    const children = [...(childrenByParent.get(key) ?? [])].sort((left, right) =>
      left.window.windowKey.localeCompare(right.window.windowKey),
    );

    if (decision.action === "accept") {
      if (children.length !== 0) {
        throw graphFailure("accepted_attempt_has_children", decision.retryTarget);
      }
      leaves.push(attempt);
      leafAssessments.push(assessment);
    } else if (decision.action === "split") {
      if (
        children.length !== decision.children.length ||
        !decision.children.every((expected, index) =>
          sameWindowDescriptor(expected, children[index]?.window),
        )
      ) {
        throw graphFailure(
          "retry_children_do_not_match_plan",
          decision.retryTarget,
          { assessment, retryDecision: decision },
        );
      }
      retryReplacementCount += 1;
      for (const child of children) visit(child);
    } else {
      if (children.length !== 0) {
        throw graphFailure("failed_attempt_has_children", decision.retryTarget);
      }
      throwLocalSubtitleWindowDecisionFailure(decision, assessment);
    }
    visiting.delete(key);
    visited.add(key);
  };

  for (const root of input.rootPlan.windows) {
    const attempt = attemptsByKey.get(root.windowKey);
    if (!attempt) {
      throw graphFailure("root_attempt_missing", {
        rootPlanId: root.rootPlanId,
        rootWindowKey: root.rootWindowKey,
        windowKey: root.windowKey,
        retryDepth: root.retryDepth,
      });
    }
    visit(attempt);
  }
  if (visited.size !== attempts.length) {
    const orphan = attempts.find((attempt) => !visited.has(attempt.window.windowKey));
    throw graphFailure(
      "attempt_graph_contains_orphan",
      orphan === undefined ? undefined : createRetryTarget(orphan),
    );
  }

  const assessmentByKey = new Map(
    leaves.map((leaf, index) => [leaf.window.windowKey, leafAssessments[index]!] as const),
  );
  const orderedLeaves = leaves.sort(compareAttemptCoverageOrder);
  validateAcceptedLeafCoverage(orderedLeaves, input);
  return {
    leaves: orderedLeaves,
    leafAssessments: orderedLeaves.map(
      (leaf) => assessmentByKey.get(leaf.window.windowKey)!,
    ),
    retryReplacementCount,
  };
}

function mergeAcceptedWindows(
  leaves: readonly LocalSubtitlePostProcessingWindowAttempt[],
  durationMs: number,
  policy: LocalSubtitlePostProcessPolicy,
  diagnostics: MergeDiagnostics,
): WorkingSegment[] {
  const projected: WorkingSegment[] = [];
  for (const [windowOrder, leaf] of leaves.entries()) {
    for (const [segmentOrder, segment] of leaf.response.result.segments.entries()) {
      const text = normalizeSubtitleText(segment.text);
      if (!text) continue;
      const absoluteStartMs = leaf.window.startMs + segment.startMs;
      const absoluteEndMs = leaf.window.startMs + segment.endMs;
      const sourceClampedStart = Math.max(0, absoluteStartMs);
      const sourceClampedEnd = Math.min(durationMs, absoluteEndMs);
      if (sourceClampedEnd <= sourceClampedStart) {
        throw qualityFailure("merge", "timeline_boundary_clamp_non_positive");
      }
      if (
        absoluteEndMs <= leaf.window.coreStartMs ||
        absoluteStartMs >= leaf.window.coreEndMs
      ) {
        continue;
      }

      if (
        sourceClampedStart !== absoluteStartMs ||
        sourceClampedEnd !== absoluteEndMs
      ) {
        diagnostics.timelineBoundaryClampCount += 1;
      }
      const startMs = Math.max(leaf.window.coreStartMs, sourceClampedStart);
      const endMs = Math.min(leaf.window.coreEndMs, sourceClampedEnd);
      if (endMs <= startMs) continue;
      projected.push({
        startMs,
        endMs,
        text,
        sourceWindowKey: leaf.window.windowKey,
        sourceWindowOrder: windowOrder,
        sourceSegmentOrder: segmentOrder,
        sourceWindowStartFrame: leaf.window.startFrame,
        sourceWindowEndFrame: leaf.window.endFrame,
        sourceWindowCoreStartFrame: leaf.window.coreStartFrame,
        sourceWindowCoreEndFrame: leaf.window.coreEndFrame,
        sourceWindowStartMs: leaf.window.startMs,
        sourceWindowEndMs: leaf.window.endMs,
        rawObservationStartMs: absoluteStartMs,
        rawObservationEndMs: absoluteEndMs,
      });
    }
  }
  diagnostics.projectedSegmentCount = projected.length;
  projected.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.sourceWindowOrder - right.sourceWindowOrder ||
      left.sourceSegmentOrder - right.sourceSegmentOrder,
  );

  const merged: WorkingSegment[] = [];
  for (const source of projected) {
    const candidate = { ...source };
    if (isPunctuationOnlyFragment(candidate.text)) {
      diagnostics.droppedBoundaryFragmentCount += 1;
      continue;
    }
    const previous = merged.at(-1);
    const crossWindow =
      previous !== undefined &&
      previous.sourceWindowKey !== candidate.sourceWindowKey;
    if (
      previous &&
      crossWindow &&
      hasBoundaryObservationProof(previous, candidate, true) &&
      boundaryFingerprint(previous.text) !== "" &&
      boundaryFingerprint(previous.text) === boundaryFingerprint(candidate.text) &&
      candidate.startMs <= previous.endMs + policy.boundaryToleranceMs
    ) {
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
      adoptLatestBoundaryProvenance(previous, candidate);
      diagnostics.duplicateBoundarySegmentCount += 1;
      continue;
    }

    if (
      previous &&
      crossWindow &&
      hasBoundaryObservationProof(previous, candidate, true) &&
      boundaryFingerprint(previous.text) !== boundaryFingerprint(candidate.text) &&
      candidate.startMs >= previous.endMs - policy.boundaryToleranceMs &&
      candidate.startMs - previous.endMs <= policy.boundaryTextGapMs
    ) {
      const overlap = findBoundaryTextOverlap(
        previous.text,
        candidate.text,
        policy,
      );
      if (overlap) {
        candidate.text = trimBoundaryComparisonPrefix(
          candidate.text,
          overlap.rightSourceUnitCount,
        );
        diagnostics.trimmedBoundaryPrefixCount += 1;
        if (!candidate.text || isPunctuationOnlyFragment(candidate.text)) {
          previous.endMs = Math.max(previous.endMs, candidate.endMs);
          adoptLatestBoundaryProvenance(previous, candidate);
          diagnostics.droppedBoundaryFragmentCount += 1;
          continue;
        }
      }
    }

    if (previous && candidate.startMs < previous.endMs) {
      const overlapMs = previous.endMs - candidate.startMs;
      if (overlapMs > policy.boundaryToleranceMs) {
        throw qualityFailure("merge", "unrepairable_timeline_overlap");
      }
      const minimumBoundary = previous.startMs + 1;
      const maximumBoundary = candidate.endMs - 1;
      const boundary = Math.min(
        maximumBoundary,
        Math.max(
          minimumBoundary,
          Math.round((candidate.startMs + previous.endMs) / 2),
        ),
      );
      if (
        boundary <= previous.startMs ||
        boundary >= candidate.endMs
      ) {
        throw qualityFailure("merge", "unrepairable_timeline_overlap");
      }
      previous.endMs = boundary;
      candidate.startMs = boundary;
      diagnostics.timelineOverlapAdjustmentCount += 1;
    }
    merged.push(candidate);
  }
  return merged;
}

function shapeCanonicalSegments(
  merged: readonly WorkingSegment[],
  policy: LocalSubtitlePostProcessPolicy,
  diagnostics: ShapingDiagnostics,
): WorkingSegment[] {
  const split: WorkingSegment[] = [];
  for (const segment of merged) {
    const parts = splitSegmentByTextAndDuration(segment, policy);
    if (parts.length > 1) diagnostics.splitSegmentCount += 1;
    split.push(...parts);
  }

  const combined: WorkingSegment[] = [];
  for (const source of split) {
    const candidate = { ...source };
    const previous = combined.at(-1);
    if (previous && canMergeShortCues(previous, candidate, policy)) {
      const joined = joinCueText(previous.text, candidate.text);
      const wrapped = wrapCueText(joined, policy.maxLineChars, policy.maxCueLines);
      if (
        subtitleTextLength(wrapped) <= policy.maxCueChars &&
        wrapped.split("\n").length <= policy.maxCueLines
      ) {
        previous.endMs = candidate.endMs;
        previous.text = wrapped;
        if (previous.estimatedTiming || candidate.estimatedTiming) {
          previous.estimatedTiming = true;
        }
        diagnostics.shortCueMergeCount += 1;
        continue;
      }
    }
    combined.push(candidate);
  }

  let previousEndMs = -1;
  for (const segment of combined) {
    if (
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs ||
      segment.startMs < previousEndMs ||
      segment.endMs - segment.startMs > policy.maxCueDurationMs ||
      subtitleTextLength(segment.text) > policy.maxCueChars ||
      segment.text.split("\n").length > policy.maxCueLines ||
      segment.text
        .split("\n")
        .some((line) => line.length > policy.maxLineChars)
    ) {
      throw qualityFailure("shaping", "canonical_shaping_limit_failed");
    }
    previousEndMs = segment.endMs;
  }
  diagnostics.estimatedTimingSegmentCount = combined.filter(
    (segment) => segment.estimatedTiming,
  ).length;
  return combined;
}

function splitSegmentByTextAndDuration(
  segment: WorkingSegment,
  policy: LocalSubtitlePostProcessPolicy,
): WorkingSegment[] {
  const text = flattenSubtitleText(segment.text);
  const units = graphemes(text);
  if (units.length === 0) return [];
  const capacity = Math.min(
    policy.maxCueChars,
    policy.maxLineChars * policy.maxCueLines,
  );
  if (units.some((unit) => unit.length > policy.maxLineChars)) {
    throw limitExceeded(
      "A subtitle grapheme exceeds the configured line limit.",
      "shaping",
      Math.max(...units.map((unit) => unit.length)),
      policy.maxLineChars,
    );
  }
  const durationMs = segment.endMs - segment.startMs;
  const durationParts = Math.max(
    1,
    Math.ceil(durationMs / policy.maxCueDurationMs),
  );
  const textCapacityParts = Math.max(
    1,
    Math.ceil(text.length / capacity),
  );
  const sparseTimeline = durationParts > units.length;
  const minimumParts = sparseTimeline
    ? textCapacityParts
    : Math.max(durationParts, textCapacityParts);
  const shapingDurationMs = sparseTimeline
    ? Math.min(durationMs, minimumParts * policy.maxCueDurationMs)
    : durationMs;
  const shapingSegment = shapingDurationMs === durationMs
    ? segment
    : {
        ...segment,
        endMs: segment.startMs + shapingDurationMs,
      };
  if (minimumParts > units.length || minimumParts > shapingDurationMs) {
    throw qualityFailure("shaping", "text_cannot_cover_timeline_without_duplication");
  }

  for (let partCount = minimumParts; partCount <= units.length; partCount += 1) {
    const textParts = partitionText(units, partCount, capacity);
    if (!textParts) continue;
    const timed = assignProportionalTimings(shapingSegment, textParts);
    if (
      timed.every(
        (part) => part.endMs - part.startMs <= policy.maxCueDurationMs,
      )
    ) {
      return timed.map((part) => ({
        ...part,
        text: wrapCueText(
          part.text,
          policy.maxLineChars,
          policy.maxCueLines,
        ),
        ...(textParts.length > 1 || shapingDurationMs !== durationMs
          ? { estimatedTiming: true as const }
          : {}),
      }));
    }
  }
  throw qualityFailure("shaping", "text_cannot_cover_timeline_without_duplication");
}

function partitionText(
  units: readonly string[],
  partCount: number,
  capacity: number,
): string[] | undefined {
  const prefixLengths = [0];
  for (const unit of units) {
    prefixLengths.push(prefixLengths.at(-1)! + unit.length);
  }
  const parts: string[] = [];
  let start = 0;
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const remainingParts = partCount - partIndex;
    if (remainingParts === 1) {
      const tail = units.slice(start).join("").trim();
      if (!tail || tail.length > capacity) return undefined;
      parts.push(tail);
      break;
    }
    const minimumEnd = Math.max(
      start + 1,
      findFirstEndThatLeavesCapacity(
        prefixLengths,
        start,
        units.length,
        remainingParts - 1,
        capacity,
      ),
    );
    const maximumEnd = findMaximumEndWithinCapacity(
      prefixLengths,
      start,
      units.length - (remainingParts - 1),
      capacity,
    );
    if (maximumEnd < minimumEnd) return undefined;
    const remainingLength =
      prefixLengths[units.length]! - prefixLengths[start]!;
    const targetLength = remainingLength / remainingParts;
    let bestEnd = minimumEnd;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let end = minimumEnd; end <= maximumEnd; end += 1) {
      const partLength = prefixLengths[end]! - prefixLengths[start]!;
      const boundaryBonus = isPreferredTextBoundary(units, end) ? -0.25 : 0;
      const score = Math.abs(partLength - targetLength) + boundaryBonus;
      if (score < bestScore || (score === bestScore && end > bestEnd)) {
        bestEnd = end;
        bestScore = score;
      }
    }
    const part = units.slice(start, bestEnd).join("").trim();
    if (!part || part.length > capacity) return undefined;
    parts.push(part);
    start = bestEnd;
    while (start < units.length && /^\s$/u.test(units[start]!)) start += 1;
  }
  return parts.length === partCount ? parts : undefined;
}

function assignProportionalTimings(
  segment: WorkingSegment,
  textParts: readonly string[],
): WorkingSegment[] {
  const totalWeight = textParts.reduce((sum, part) => sum + part.length, 0);
  const durationMs = segment.endMs - segment.startMs;
  let cumulativeWeight = 0;
  let startMs = segment.startMs;
  return textParts.map((text, index) => {
    cumulativeWeight += text.length;
    const endMs =
      index === textParts.length - 1
        ? segment.endMs
        : segment.startMs +
          Math.round((durationMs * cumulativeWeight) / totalWeight);
    if (endMs <= startMs) {
      throw qualityFailure("shaping", "zero_length_estimated_timing");
    }
    const part: WorkingSegment = {
      ...segment,
      startMs,
      endMs,
      text,
      ...(textParts.length > 1 || segment.estimatedTiming
        ? { estimatedTiming: true }
        : {}),
    };
    startMs = endMs;
    return part;
  });
}

function wrapCueText(
  value: string,
  maxLineChars: number,
  maxLines: number,
): string {
  const units = graphemes(flattenSubtitleText(value));
  const lines: string[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let length = 0;
    let preferredEnd: number | undefined;
    while (end < units.length && length + units[end]!.length <= maxLineChars) {
      length += units[end]!.length;
      end += 1;
      if (isPreferredTextBoundary(units, end)) preferredEnd = end;
    }
    if (end === start) {
      throw limitExceeded(
        "A subtitle grapheme exceeds the configured line limit.",
        "shaping",
        units[start]!.length,
        maxLineChars,
      );
    }
    if (end < units.length && preferredEnd !== undefined && preferredEnd > start) {
      end = preferredEnd;
    }
    const line = units.slice(start, end).join("").trim();
    if (line) lines.push(line);
    start = end;
    while (start < units.length && /^\s$/u.test(units[start]!)) start += 1;
  }
  if (lines.length > maxLines) {
    throw limitExceeded(
      "A subtitle cue exceeds the configured line count.",
      "shaping",
      lines.length,
      maxLines,
    );
  }
  return lines.join("\n");
}

function canMergeShortCues(
  left: WorkingSegment,
  right: WorkingSegment,
  policy: LocalSubtitlePostProcessPolicy,
): boolean {
  const gapMs = right.startMs - left.endMs;
  if (
    gapMs < 0 ||
    gapMs > policy.shortCueMergeGapMs ||
    // A readable decoder cue already has a boundary. Merging it would expose
    // the following words early, even when the combined cue fits the limits.
    left.endMs - left.startMs > policy.shortCueMergeMaxDurationMs ||
    right.endMs - right.startMs > policy.shortCueMergeMaxDurationMs ||
    boundaryFingerprint(left.text) === boundaryFingerprint(right.text) ||
    right.endMs - left.startMs > policy.maxCueDurationMs ||
    TERMINAL_PUNCTUATION_PATTERN.test(left.text)
  ) {
    return false;
  }
  const joined = joinCueText(left.text, right.text);
  return (
    subtitleTextLength(joined) <=
    Math.min(
      policy.maxCueChars,
      policy.maxLineChars * policy.maxCueLines,
    )
  );
}

function joinCueText(left: string, right: string): string {
  const normalizedLeft = flattenSubtitleText(left);
  const normalizedRight = flattenSubtitleText(right);
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;
  const separator =
    LEADING_PUNCTUATION_PATTERN.test(normalizedRight) ||
    CJK_PATTERN.test(normalizedLeft.at(-1) ?? "") ||
    CJK_PATTERN.test(normalizedRight.at(0) ?? "")
      ? ""
      : " ";
  return `${normalizedLeft}${separator}${normalizedRight}`;
}

function findFirstEndThatLeavesCapacity(
  prefixLengths: readonly number[],
  start: number,
  totalUnits: number,
  remainingParts: number,
  capacity: number,
): number {
  for (let end = start + 1; end <= totalUnits - remainingParts; end += 1) {
    const tailLength = prefixLengths[totalUnits]! - prefixLengths[end]!;
    if (tailLength <= remainingParts * capacity) return end;
  }
  return totalUnits;
}

function findMaximumEndWithinCapacity(
  prefixLengths: readonly number[],
  start: number,
  maximumEnd: number,
  capacity: number,
): number {
  let end = start;
  while (
    end < maximumEnd &&
    prefixLengths[end + 1]! - prefixLengths[start]! <= capacity
  ) {
    end += 1;
  }
  return end;
}

function isPreferredTextBoundary(
  units: readonly string[],
  end: number,
): boolean {
  if (end <= 0 || end > units.length) return false;
  const previous = units[end - 1]!;
  const next = units[end] ?? "";
  return (
    /^\s$/u.test(previous) ||
    PREFERRED_BOUNDARY_PATTERN.test(previous) ||
    (previous === "." && (next === "" || /^\s$/u.test(next)))
  );
}

function findBoundaryTextOverlap(
  left: string,
  right: string,
  policy: LocalSubtitlePostProcessPolicy,
): { readonly rightSourceUnitCount: number } | undefined {
  const leftMap = createBoundaryComparisonMap(left);
  const rightMap = createBoundaryComparisonMap(right);
  const prefixLengths = buildPrefixLengths(rightMap.units);
  let length = longestPrefixMatchingSuffix(
    leftMap.units,
    rightMap.units,
    prefixLengths,
  );
  while (length > 0) {
    const leftStart = leftMap.units.length - length;
    const rightSourceUnitCount = rightMap.sourceCountAtBoundary[length];
    if (
      leftMap.sourceCountAtBoundary[leftStart] === undefined ||
      rightSourceUnitCount === undefined
    ) {
      length = prefixLengths[length - 1] ?? 0;
      continue;
    }
    const suffix = leftMap.units.slice(-length).join("");
    const minimum = CJK_PATTERN.test(suffix)
      ? policy.boundaryTextMinCjkChars
      : policy.boundaryTextMinLatinChars;
    if (length >= minimum) return { rightSourceUnitCount };
    length = prefixLengths[length - 1] ?? 0;
  }
  return undefined;
}

function buildPrefixLengths(units: readonly string[]): number[] {
  const prefixLengths = new Array<number>(units.length).fill(0);
  for (let index = 1; index < units.length; index += 1) {
    let candidate = prefixLengths[index - 1]!;
    while (candidate > 0 && units[index] !== units[candidate]) {
      candidate = prefixLengths[candidate - 1]!;
    }
    if (units[index] === units[candidate]) candidate += 1;
    prefixLengths[index] = candidate;
  }
  return prefixLengths;
}

function longestPrefixMatchingSuffix(
  left: readonly string[],
  right: readonly string[],
  prefixLengths: readonly number[],
): number {
  if (right.length === 0) return 0;
  let matched = 0;
  for (const [index, unit] of left.entries()) {
    while (matched > 0 && unit !== right[matched]) {
      matched = prefixLengths[matched - 1]!;
    }
    if (unit === right[matched]) matched += 1;
    if (matched === right.length && index < left.length - 1) {
      matched = prefixLengths[matched - 1]!;
    }
  }
  return matched;
}

function trimBoundaryComparisonPrefix(
  value: string,
  sourceUnitCount: number,
): string {
  const sourceUnits = graphemes(flattenSubtitleText(value));
  if (sourceUnitCount <= 0) return normalizeSubtitleText(value);
  const remainder = sourceUnits.slice(sourceUnitCount).join("");
  return normalizeSubtitleText(remainder)
    .replace(/^[\p{P}\s]+/u, "")
    .trim();
}

function createBoundaryComparisonMap(value: string): {
  readonly units: readonly string[];
  readonly sourceCountAtBoundary: readonly (number | undefined)[];
} {
  const sourceUnits = graphemes(flattenSubtitleText(value));
  const units: string[] = [];
  const sourceCountAtBoundary: Array<number | undefined> = [0];
  sourceUnits.forEach((unit, index) => {
    sourceCountAtBoundary[units.length] = index;
    const normalized = unit
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .replace(BOUNDARY_COMPARISON_IGNORED_PATTERN, "");
    for (const normalizedUnit of Array.from(normalized)) {
      units.push(normalizedUnit);
    }
    sourceCountAtBoundary[units.length] = index + 1;
  });
  return { units, sourceCountAtBoundary };
}

function qualityFingerprint(value: string): string {
  return flattenSubtitleText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(QUALITY_COMPARISON_IGNORED_PATTERN, "");
}

function boundaryFingerprint(value: string): string {
  return createBoundaryComparisonMap(value).units.join("");
}

function normalizeSubtitleText(value: string): string {
  if (hasUnpairedSurrogate(value)) {
    throw new LocalSubtitlePostProcessorError(
      "transcript_quality_failed",
      "The transcript contains an invalid Unicode scalar value.",
      {
        localSubtitleCode: "invalid_content",
        stage: "shaping",
        details: { reason: "invalid_unicode_scalar" },
      },
    );
  }
  if (UNSAFE_CONTROL_PATTERN.test(value)) {
    throw new LocalSubtitlePostProcessorError(
      "transcript_quality_failed",
      "The transcript contains an unsupported control character.",
      {
        localSubtitleCode: "invalid_content",
        stage: "shaping",
        details: { reason: "unsafe_control_character" },
      },
    );
  }
  return value
    .replace(/\r\n?|[\n\u2028\u2029]/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\p{Zs}]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function flattenSubtitleText(value: string): string {
  return normalizeSubtitleText(value).replace(/\s*\n\s*/gu, " ").trim();
}

function isPunctuationOnlyFragment(value: string): boolean {
  const flattened = flattenSubtitleText(value);
  return flattened.length > 0 && PUNCTUATION_ONLY_PATTERN.test(flattened);
}

function subtitleTextLength(value: string): number {
  return value.split("\n").reduce((sum, line) => sum + line.length, 0);
}

function graphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), (entry) => entry.segment);
}

function planWindowRange(input: {
  readonly rootPlanId: string;
  readonly rootWindowKey?: string;
  readonly parentWindowKey?: string;
  readonly retryDepth: number;
  readonly rangeStartFrame: number;
  readonly rangeEndFrame: number;
  readonly ownedStartFrame: number;
  readonly ownedEndFrame: number;
  readonly windowMs: number;
  readonly overlapMs: number;
  readonly sampleRateHz: number;
  readonly keyForIndex: (index: number) => string;
}): LocalSubtitlePostProcessingWindow[] {
  const windowFrames = millisecondsToFrames(input.windowMs, input.sampleRateHz);
  const overlapFrames = millisecondsToFrames(input.overlapMs, input.sampleRateHz);
  if (
    overlapFrames < 0 ||
    overlapFrames >= windowFrames ||
    input.rangeEndFrame <= input.rangeStartFrame ||
    input.ownedStartFrame < input.rangeStartFrame ||
    input.ownedEndFrame > input.rangeEndFrame ||
    input.ownedEndFrame <= input.ownedStartFrame
  ) {
    throw invalidConfiguration(
      "The structural PCM window range is invalid.",
      "coverage",
      "window_plan_range_invalid",
    );
  }
  const stepFrames = windowFrames - overlapFrames;
  const ranges: Array<{ startFrame: number; endFrame: number }> = [];
  for (let startFrame = input.rangeStartFrame; startFrame < input.rangeEndFrame; ) {
    const endFrame = Math.min(input.rangeEndFrame, startFrame + windowFrames);
    ranges.push({ startFrame, endFrame });
    if (endFrame === input.rangeEndFrame) break;
    startFrame += stepFrames;
  }

  return ranges.map((range, index) => {
    const previous = ranges[index - 1];
    const next = ranges[index + 1];
    const naturalCoreStart = previous
      ? Math.floor((previous.endFrame + range.startFrame) / 2)
      : input.rangeStartFrame;
    const naturalCoreEnd = next
      ? Math.floor((range.endFrame + next.startFrame) / 2)
      : input.rangeEndFrame;
    const coreStartFrame = Math.max(input.ownedStartFrame, naturalCoreStart);
    const coreEndFrame = Math.min(input.ownedEndFrame, naturalCoreEnd);
    if (coreEndFrame <= coreStartFrame) {
      throw invalidConfiguration(
        "The structural PCM plan produced an empty owned core.",
        "coverage",
        "window_plan_empty_core",
      );
    }
    const windowKey = input.keyForIndex(index);
    validateSafeId(windowKey, "window_plan_key_invalid", "coverage");
    const rootWindowKey = input.rootWindowKey ?? windowKey;
    return {
      windowKey,
      rootPlanId: input.rootPlanId,
      rootWindowKey,
      ...(input.parentWindowKey === undefined
        ? {}
        : { parentWindowKey: input.parentWindowKey }),
      retryDepth: input.retryDepth,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      coreStartFrame,
      coreEndFrame,
      startMs: framesToMilliseconds(range.startFrame, input.sampleRateHz),
      endMs: framesToMilliseconds(range.endFrame, input.sampleRateHz),
      coreStartMs: framesToMilliseconds(coreStartFrame, input.sampleRateHz),
      coreEndMs: framesToMilliseconds(coreEndFrame, input.sampleRateHz),
    };
  });
}

function validateRootPlan(input: LocalSubtitlePostProcessingRequest): void {
  const plan = input.rootPlan;
  if (
    !isRecord(plan) ||
    !hasOnlyKeys(plan, ["schemaVersion", "rootPlanId", "windows"]) ||
    plan.schemaVersion !== 1 ||
    typeof plan.rootPlanId !== "string" ||
    !Array.isArray(plan.windows) ||
    plan.windows.length === 0
  ) {
    throw graphFailure("root_plan_invalid");
  }
  validateSafeId(plan.rootPlanId, "root_plan_id_invalid", "coverage");
  const expected = planLocalSubtitleRootWindows({
    rootPlanId: plan.rootPlanId,
    totalFrames: input.source.totalFrames,
    policy: input.policy,
  });
  if (
    expected.windows.length !== plan.windows.length ||
    !expected.windows.every((window, index) =>
      sameWindowDescriptor(window, plan.windows[index]),
    )
  ) {
    throw graphFailure("root_plan_does_not_match_structural_policy");
  }
}

function validateWindowAttemptIdentity(
  attempt: LocalSubtitlePostProcessingWindowAttempt,
  policy: LocalSubtitlePostProcessPolicy,
): void {
  if (
    !isRecord(attempt) ||
    !hasOnlyKeys(attempt, [
      "window",
      "windowAttempt",
      "processEpoch",
      "requestGeneration",
      "response",
    ]) ||
    !isRecord(attempt.window) ||
    !Number.isSafeInteger(attempt.windowAttempt) ||
    attempt.windowAttempt < 1 ||
    !Number.isSafeInteger(attempt.processEpoch) ||
    attempt.processEpoch < 1 ||
    !Number.isSafeInteger(attempt.requestGeneration) ||
    attempt.requestGeneration < 1 ||
    !isRecord(attempt.response) ||
    !hasOnlyKeys(attempt.response, [
      "requestGeneration",
      "sessionDisposition",
      "result",
    ]) ||
    !Number.isSafeInteger(attempt.response.requestGeneration) ||
    attempt.response.requestGeneration < 1 ||
    attempt.response.requestGeneration !== attempt.requestGeneration ||
    attempt.response.sessionDisposition !== "reusable" ||
    !isRecord(attempt.response.result)
  ) {
    throw graphFailure("window_attempt_identity_invalid");
  }
  validateWindowDescriptor(attempt.window, policy, "coverage");
  const window = attempt.window;
  const rootLineageValid =
    window.retryDepth === 0
      ? window.parentWindowKey === undefined &&
        window.rootWindowKey === window.windowKey
      : window.parentWindowKey !== undefined &&
        window.rootWindowKey !== window.windowKey;
  if (!rootLineageValid) {
    throw graphFailure("window_attempt_lineage_invalid", createRetryTarget(attempt));
  }
}

function createRetryTarget(
  attempt: LocalSubtitlePostProcessingWindowAttempt,
): LocalSubtitleWindowRetryTarget {
  return {
    rootPlanId: attempt.window.rootPlanId,
    rootWindowKey: attempt.window.rootWindowKey,
    ...(attempt.window.parentWindowKey === undefined
      ? {}
      : { parentWindowKey: attempt.window.parentWindowKey }),
    windowKey: attempt.window.windowKey,
    windowAttempt: attempt.windowAttempt,
    retryDepth: attempt.window.retryDepth,
    windowStartMs: attempt.window.startMs,
    windowEndMs: attempt.window.endMs,
    processEpoch: attempt.processEpoch,
    requestGeneration: attempt.requestGeneration,
  };
}

function sameWindowDescriptor(
  left: LocalSubtitlePostProcessingWindow,
  right: LocalSubtitlePostProcessingWindow | undefined,
): boolean {
  return (
    right !== undefined &&
    left.windowKey === right.windowKey &&
    left.rootPlanId === right.rootPlanId &&
    left.rootWindowKey === right.rootWindowKey &&
    left.parentWindowKey === right.parentWindowKey &&
    left.retryDepth === right.retryDepth &&
    left.startFrame === right.startFrame &&
    left.endFrame === right.endFrame &&
    left.coreStartFrame === right.coreStartFrame &&
    left.coreEndFrame === right.coreEndFrame &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.coreStartMs === right.coreStartMs &&
    left.coreEndMs === right.coreEndMs
  );
}

function compareAttemptCoverageOrder(
  left: LocalSubtitlePostProcessingWindowAttempt,
  right: LocalSubtitlePostProcessingWindowAttempt,
): number {
  return (
    left.window.coreStartFrame - right.window.coreStartFrame ||
    left.window.retryDepth - right.window.retryDepth ||
    left.window.windowKey.localeCompare(right.window.windowKey)
  );
}

function validateAcceptedLeafCoverage(
  leaves: readonly LocalSubtitlePostProcessingWindowAttempt[],
  input: LocalSubtitlePostProcessingRequest,
): void {
  let nextFrame = 0;
  let nextMs = 0;
  for (const leaf of leaves) {
    if (
      leaf.window.coreStartFrame !== nextFrame ||
      leaf.window.coreStartMs !== nextMs
    ) {
      throw graphFailure("accepted_leaf_coverage_gap_or_overlap", createRetryTarget(leaf));
    }
    nextFrame = leaf.window.coreEndFrame;
    nextMs = leaf.window.coreEndMs;
  }
  if (
    nextFrame !== input.source.totalFrames ||
    nextMs !== input.source.durationMs
  ) {
    throw graphFailure("accepted_leaf_coverage_missing_tail");
  }
}

function repeatSpanMs(run: {
  readonly cueCount: number;
  readonly startMs: number;
  readonly maximumEndMs: number;
}): number {
  return run.cueCount > 1 ? Math.max(0, run.maximumEndMs - run.startMs) : 0;
}

function hasBoundaryObservationProof(
  left: WorkingSegment,
  right: WorkingSegment,
  requireRawOverlap: boolean,
): boolean {
  if (
    right.sourceWindowOrder !== left.sourceWindowOrder + 1 ||
    left.sourceWindowCoreEndFrame !== right.sourceWindowCoreStartFrame
  ) {
    return false;
  }
  const sharedStartFrame = Math.max(
    left.sourceWindowStartFrame,
    right.sourceWindowStartFrame,
  );
  const sharedEndFrame = Math.min(
    left.sourceWindowEndFrame,
    right.sourceWindowEndFrame,
  );
  if (
    sharedEndFrame <= sharedStartFrame ||
    left.sourceWindowCoreEndFrame < sharedStartFrame ||
    left.sourceWindowCoreEndFrame > sharedEndFrame
  ) {
    return false;
  }
  const sharedStartMs = Math.max(
    left.sourceWindowStartMs,
    right.sourceWindowStartMs,
  );
  const sharedEndMs = Math.min(left.sourceWindowEndMs, right.sourceWindowEndMs);
  const leftObservedInOverlap =
    Math.max(left.rawObservationStartMs, sharedStartMs) <
    Math.min(left.rawObservationEndMs, sharedEndMs);
  const rightObservedInOverlap =
    Math.max(right.rawObservationStartMs, sharedStartMs) <
    Math.min(right.rawObservationEndMs, sharedEndMs);
  if (!leftObservedInOverlap || !rightObservedInOverlap) return false;
  return (
    !requireRawOverlap ||
    Math.max(left.rawObservationStartMs, right.rawObservationStartMs) <
      Math.min(left.rawObservationEndMs, right.rawObservationEndMs)
  );
}

function adoptLatestBoundaryProvenance(
  target: WorkingSegment,
  source: WorkingSegment,
): void {
  target.sourceWindowKey = source.sourceWindowKey;
  target.sourceWindowOrder = source.sourceWindowOrder;
  target.sourceSegmentOrder = source.sourceSegmentOrder;
  target.sourceWindowStartFrame = source.sourceWindowStartFrame;
  target.sourceWindowEndFrame = source.sourceWindowEndFrame;
  target.sourceWindowCoreStartFrame = source.sourceWindowCoreStartFrame;
  target.sourceWindowCoreEndFrame = source.sourceWindowCoreEndFrame;
  target.sourceWindowStartMs = source.sourceWindowStartMs;
  target.sourceWindowEndMs = source.sourceWindowEndMs;
  target.rawObservationStartMs = source.rawObservationStartMs;
  target.rawObservationEndMs = source.rawObservationEndMs;
}

function validateSourceAndModel(input: LocalSubtitlePostProcessingRequest): void {
  if (
    !isRecord(input.source) ||
    typeof input.source.displayName !== "string" ||
    input.source.displayName.length === 0 ||
    input.source.displayName.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
    input.source.displayName.trim().length === 0 ||
    input.source.displayName === "." ||
    input.source.displayName === ".." ||
    /[\\/]/u.test(input.source.displayName) ||
    UNSAFE_CONTROL_PATTERN.test(input.source.displayName) ||
    !Number.isSafeInteger(input.source.durationMs) ||
    input.source.durationMs <= 0 ||
    !Number.isSafeInteger(input.source.totalFrames) ||
    input.source.totalFrames <= 0 ||
    input.source.sampleRateHz !== LOCAL_SUBTITLE_POST_PROCESSING_POLICY.pcmSampleRateHz
  ) {
    throw invalidConfiguration(
      "The local subtitle source summary is invalid.",
      "canonical",
      "invalid_source_summary",
    );
  }
  if (
    input.taskMode !== "transcribe" &&
    input.taskMode !== "translate_to_english"
  ) {
    throw invalidConfiguration(
      "The local subtitle task mode is invalid.",
      "canonical",
      "invalid_task_mode",
    );
  }
  if (input.source.durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs) {
    throw limitExceeded(
      "The source duration exceeds the versioned subtitle limit.",
      "canonical",
      input.source.durationMs,
      LOCAL_SUBTITLE_LIMITS.maxDurationMs,
    );
  }
  if (
    framesToMilliseconds(input.source.totalFrames, input.source.sampleRateHz) !==
    input.source.durationMs
  ) {
    throw invalidConfiguration(
      "The PCM frame count does not match the source duration.",
      "coverage",
      "source_frame_time_mismatch",
    );
  }
  if (
    !isRecord(input.model) ||
    !(LOCAL_SUBTITLE_ENGINES as readonly unknown[]).includes(
      input.model.engine,
    ) ||
    typeof input.model.modelId !== "string" ||
    input.model.modelId.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(input.model.modelId) ||
    !SHA256_PATTERN.test(input.model.modelHash) ||
    !(LOCAL_SUBTITLE_BACKENDS as readonly unknown[]).includes(
      input.model.backend,
    )
  ) {
    throw invalidConfiguration(
      "The local subtitle model summary is invalid.",
      "canonical",
      "invalid_model_summary",
    );
  }
  if (
    input.detectedLanguage !== undefined &&
    (input.detectedLanguage.length > LOCAL_SUBTITLE_LIMITS.maxLanguageChars ||
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(input.detectedLanguage))
  ) {
    throw invalidConfiguration(
      "The detected subtitle language is invalid.",
      "canonical",
      "invalid_detected_language",
    );
  }
  if (
    input.languageProbability !== undefined &&
    (!Number.isFinite(input.languageProbability) ||
      input.languageProbability < 0 ||
      input.languageProbability > 1)
  ) {
    throw invalidConfiguration(
      "The detected language probability is invalid.",
      "canonical",
      "invalid_language_probability",
    );
  }
}

function validatePolicy(policy: LocalSubtitlePostProcessPolicy): void {
  if (
    !isRecord(policy) ||
    policy.schemaVersion !== 1 ||
    typeof policy.vadEnabled !== "boolean" ||
    policy.wordTimelineMode !== "segment_only_v1" ||
    policy.qualityFingerprint !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.qualityFingerprint ||
    policy.boundaryFingerprint !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryFingerprint ||
    policy.pcmSampleRateHz !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.pcmSampleRateHz ||
    policy.maxCueLines !== LOCAL_SUBTITLE_LIMITS.maxCueLines ||
    policy.maxWindowDurationMs !==
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.pcmWindowMs ||
    policy.rootWindowOverlapMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.rootWindowOverlapMs ||
    policy.boundaryToleranceMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryToleranceMs ||
    policy.maxRawSegmentDurationMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRawSegmentDurationMs ||
    policy.repeatedCueThreshold !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCueThreshold ||
    policy.repeatedCoverageMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.repeatedCoverageMs ||
    policy.maxRetryDepth !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.maxRetryDepth ||
    policy.minRetryWindowMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.minRetryWindowMs ||
    policy.retryOverlapMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.retryOverlapMs ||
    policy.minRetrySplitRatio !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.minRetrySplitRatio ||
    policy.boundaryTextGapMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextGapMs ||
    policy.boundaryTextMinCjkChars !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinCjkChars ||
    policy.boundaryTextMinLatinChars !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinLatinChars ||
    policy.shortCueMergeGapMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.shortCueMergeGapMs ||
    policy.shortCueMergeMaxDurationMs !==
      LOCAL_SUBTITLE_POST_PROCESSING_POLICY.shortCueMergeMaxDurationMs ||
    !isSafeIntegerBetween(
      policy.maxCueDurationMs,
      500,
      policy.maxRawSegmentDurationMs,
    ) ||
    !isSafeIntegerBetween(
      policy.maxCueChars,
      20,
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars,
    ) ||
    !isSafeIntegerBetween(
      policy.maxLineChars,
      10,
      LOCAL_SUBTITLE_LIMITS.maxLineChars,
    )
  ) {
    throw invalidConfiguration(
      "The local subtitle post-processing policy is invalid.",
      "policy",
      "invalid_post_processing_policy",
    );
  }
}

function validateWindowDescriptor(
  window: LocalSubtitlePostProcessingWindow,
  policy: LocalSubtitlePostProcessPolicy,
  stage: LocalSubtitlePostProcessingStage,
): void {
  if (
    !isRecord(window) ||
    !hasOnlyKeys(window, [
      "windowKey",
      "rootPlanId",
      "rootWindowKey",
      ...(window.parentWindowKey === undefined ? [] : ["parentWindowKey"]),
      "retryDepth",
      "startFrame",
      "endFrame",
      "coreStartFrame",
      "coreEndFrame",
      "startMs",
      "endMs",
      "coreStartMs",
      "coreEndMs",
    ]) ||
    typeof window.windowKey !== "string" ||
    window.windowKey.length === 0 ||
    window.windowKey.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(window.windowKey) ||
    typeof window.rootPlanId !== "string" ||
    window.rootPlanId.length === 0 ||
    window.rootPlanId.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(window.rootPlanId) ||
    typeof window.rootWindowKey !== "string" ||
    window.rootWindowKey.length === 0 ||
    window.rootWindowKey.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(window.rootWindowKey) ||
    (window.parentWindowKey !== undefined &&
      (typeof window.parentWindowKey !== "string" ||
        window.parentWindowKey.length === 0 ||
        window.parentWindowKey.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
        !SAFE_ID_PATTERN.test(window.parentWindowKey))) ||
    !isSafeIntegerBetween(window.retryDepth, 0, policy.maxRetryDepth) ||
    !isOrderedPositiveRange(window.startFrame, window.endFrame) ||
    !isOrderedPositiveRange(window.coreStartFrame, window.coreEndFrame) ||
    window.coreStartFrame < window.startFrame ||
    window.coreEndFrame > window.endFrame ||
    !isOrderedPositiveRange(window.startMs, window.endMs) ||
    window.endMs - window.startMs > policy.maxWindowDurationMs ||
    !isOrderedPositiveRange(window.coreStartMs, window.coreEndMs) ||
    window.coreStartMs < window.startMs ||
    window.coreEndMs > window.endMs
  ) {
    throw invalidConfiguration(
      "The local subtitle owned window descriptor is invalid.",
      stage,
      "invalid_window_descriptor",
    );
  }
}

function isInferenceResultContractValid(
  result: LocalSubtitleServerInferenceResult,
): boolean {
  return (
    isRecord(result) &&
    hasOnlyKeys(result, [
      "contractVersion",
      "task",
      "language",
      "durationMs",
      "text",
      "segments",
      "wordTimelineStatus",
    ]) &&
    result.contractVersion === 1 &&
    (result.task === "transcribe" || result.task === "translate") &&
    typeof result.language === "string" &&
    result.language.length > 0 &&
    result.language.length <= 128 &&
    isSafeUnicodeText(result.language) &&
    Number.isSafeInteger(result.durationMs) &&
    result.durationMs >= 0 &&
    typeof result.text === "string" &&
    isSafeUnicodeText(result.text) &&
    Array.isArray(result.segments) &&
    result.segments.length <= LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments &&
    result.segments.every(isServerRawSegmentContractValid) &&
    (result.wordTimelineStatus === "not_requested" ||
      result.wordTimelineStatus === "discarded_vad_compressed_timeline")
  );
}

function isServerRawSegmentContractValid(
  value: LocalSubtitleServerRawSegment,
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "startMs",
      "endMs",
      "text",
      "temperature",
      "averageLogProbability",
      "noSpeechProbability",
    ]) &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    Number.isSafeInteger(value.startMs) &&
    Number.isSafeInteger(value.endMs) &&
    typeof value.text === "string" &&
    value.text.length <= LOCAL_SUBTITLE_LIMITS.maxCueTextChars &&
    isSafeUnicodeText(value.text) &&
    Number.isFinite(value.temperature) &&
    value.temperature >= 0 &&
    value.temperature <= 2 &&
    Number.isFinite(value.averageLogProbability) &&
    Number.isFinite(value.noSpeechProbability) &&
    value.noSpeechProbability >= 0 &&
    value.noSpeechProbability <= 1
  );
}

function isTimelineSegmentContractValid(
  value: TimelineSegment,
): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.startMs) &&
    Number.isSafeInteger(value.endMs) &&
    typeof value.text === "string" &&
    value.text.length <= LOCAL_SUBTITLE_LIMITS.maxCueTextChars &&
    isSafeUnicodeText(value.text)
  );
}

function emptyInvalidAssessment(
  issue: LocalSubtitleRawQualityIssueCode,
): LocalSubtitleRawQualityAssessment {
  return deepFreeze({
    valid: false,
    contractValid: false,
    outcome: "no_speech",
    outcomeEvidence: "invalid_contract",
    issues: [issue],
    rawSegmentCount: 0,
    speechSegmentCount: 0,
    emptyTextSegmentCount: 0,
    normalizedUniqueTextCount: 0,
    nonPositiveDurationSegmentCount: 0,
    reverseOrderSegmentCount: 0,
    overlappingSegmentCount: 0,
    outOfWindowSegmentCount: 0,
    overlongSegmentCount: 0,
    invalidTimelineSegmentCount: 0,
    longestSegmentDurationMs: 0,
    longestConsecutiveRepeatCueCount: 0,
    longestConsecutiveRepeatSpanMs: 0,
  });
}

function invalidConfiguration(
  message: string,
  stage: LocalSubtitlePostProcessingStage,
  reason: string,
): LocalSubtitlePostProcessorError {
  return new LocalSubtitlePostProcessorError("invalid_configuration", message, {
    localSubtitleCode: "runtime_protocol_mismatch",
    stage,
    details: { reason },
  });
}

function graphFailure(
  reason: string,
  identity?: Omit<
    LocalSubtitlePostProcessorErrorDetails,
    "reason" | "assessment" | "retryDecision" | "observed" | "limit"
  >,
  diagnostics: Pick<
    LocalSubtitlePostProcessorErrorDetails,
    "assessment" | "retryDecision"
  > = {},
): LocalSubtitlePostProcessorError {
  return new LocalSubtitlePostProcessorError(
    "invalid_configuration",
    "The local subtitle window execution graph is invalid.",
    {
      localSubtitleCode: "runtime_protocol_mismatch",
      stage: "coverage",
      details: {
        reason,
        ...(identity ?? {}),
        ...diagnostics,
      },
    },
  );
}

export function throwLocalSubtitleWindowDecisionFailure(
  decision: Extract<LocalSubtitleWindowRetryDecision, { action: "fail" }>,
  assessment: LocalSubtitleRawQualityAssessment,
  recovery: Readonly<{
    qualityRecoveryAttempts: number;
    maxQualityRecoveryAttempts: number;
  }> = { qualityRecoveryAttempts: 0, maxQualityRecoveryAttempts: 0 },
): never {
  const contractInvalid = decision.reason === "contract_invalid";
  throw new LocalSubtitlePostProcessorError(
    contractInvalid ? "invalid_configuration" : "transcript_quality_failed",
    contractInvalid
      ? "The inference response does not satisfy the local server contract."
      : "The inference window exhausted its bounded quality retry policy.",
    {
      localSubtitleCode: contractInvalid
        ? "runtime_protocol_mismatch"
        : "transcript_quality_failed",
      stage: "window",
      details: {
        reason: decision.reason,
        ...decision.retryTarget,
        assessment,
        retryDecision: decision,
        ...recovery,
      },
    },
  );
}

function qualityFailure(
  stage: LocalSubtitlePostProcessingStage,
  reason: string,
): LocalSubtitlePostProcessorError {
  return new LocalSubtitlePostProcessorError(
    "transcript_quality_failed",
    "The local subtitle transcript failed a deterministic quality invariant.",
    {
      localSubtitleCode: "transcript_quality_failed",
      stage,
      details: { reason },
    },
  );
}

function noSpeechDetected(reason: string): LocalSubtitlePostProcessorError {
  return new LocalSubtitlePostProcessorError(
    "no_speech_detected",
    "No non-empty speech cue remained after local subtitle processing.",
    {
      localSubtitleCode: "no_speech_detected",
      stage: "canonical",
      details: { reason },
    },
  );
}

function limitExceeded(
  message: string,
  stage: LocalSubtitlePostProcessingStage,
  observed: number,
  limit: number,
): LocalSubtitlePostProcessorError {
  return new LocalSubtitlePostProcessorError("limit_exceeded", message, {
    localSubtitleCode: "limit_exceeded",
    stage,
    details: { reason: "versioned_limit_exceeded", observed, limit },
  });
}

function isSafeIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function isOrderedPositiveRange(start: unknown, end: unknown): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number)
  );
}

function validateSafeId(
  value: string,
  reason: string,
  stage: LocalSubtitlePostProcessingStage,
): void {
  if (
    value.length === 0 ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(value)
  ) {
    throw invalidConfiguration("A local subtitle identifier is invalid.", stage, reason);
  }
}

function validateWindowFrameTimeMapping(
  window: LocalSubtitlePostProcessingWindow,
  sampleRateHz: number,
): void {
  for (const [frame, milliseconds] of [
    [window.startFrame, window.startMs],
    [window.endFrame, window.endMs],
    [window.coreStartFrame, window.coreStartMs],
    [window.coreEndFrame, window.coreEndMs],
  ] as const) {
    if (framesToMilliseconds(frame, sampleRateHz) !== milliseconds) {
      throw invalidConfiguration(
        "The owned window frame and millisecond boundaries do not match.",
        "coverage",
        "window_frame_time_mismatch",
      );
    }
  }
}

function framesToMilliseconds(frames: number, sampleRateHz: number): number {
  return Math.round((frames * 1_000) / sampleRateHz);
}

function millisecondsToFrames(milliseconds: number, sampleRateHz: number): number {
  return Math.round((milliseconds * sampleRateHz) / 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeUnicodeText(value: string): boolean {
  return !UNSAFE_CONTROL_PATTERN.test(value) && !hasUnpairedSurrogate(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
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
