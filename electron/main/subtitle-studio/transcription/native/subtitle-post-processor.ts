import {
  LOCAL_SUBTITLE_CUE_POLICY,
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
} from "../../../../../src/subtitle-studio/transcription/domain";
import { LocalSubtitleCuePlanError, planLocalSubtitleSegmentCue } from "./cue-boundary-planner";
import { LOCAL_SUBTITLE_PAUSE_POLICY, planLocalSubtitlePauseRanges,
  type LocalSubtitleQuietCandidate } from "./pause-window-plan";
import { validateLocalSubtitleTranscript } from "../../../../../src/subtitle-studio/transcription/ipc-contract";
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
// Alone between letters or digits these join one word (don't, e-mail, 3.5, 陈·嘉禾).
const WORD_JOINER_PATTERN = /^['’\-‐‑.·・]$/u;
const WORD_CHARACTER_PATTERN = /^[\p{L}\p{N}]/u;
// Transcript confidence keeps three decimals.
const CONFIDENCE_SCALE = 1_000;
// A clipped seam cue repeats the other window when edits to at most a fifth of
// its characters turn it into one stretch there.
const SEAM_DUPLICATE_MIN_COVERAGE = 0.8;
// Bounds one comparison; a larger pair is kept rather than compared.
const SEAM_DUPLICATE_MAX_COMPARISON_UNITS = 1_000_000;
// Bounds one window's alignment with its timing anchor; a larger window keeps its times.
const ANCHOR_RETIMING_MAX_COMPARISON_UNITS = 1_000_000;
// The shortest segment a retimed window keeps.
const ANCHOR_RETIMING_MIN_SEGMENT_MS = 200;
// Only a window the preset heard early as a whole is retimed: its anchored edges'
// median shift (anchor minus preset time) is at least this much later.
export const LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS = 500;

export const LOCAL_SUBTITLE_POST_PROCESSING_POLICY = deepFreeze({
  schemaVersion: 3,
  cuePolicy: LOCAL_SUBTITLE_CUE_POLICY,
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

export type LocalSubtitleRootWindowPlan = {
  readonly schemaVersion: 1;
  readonly rootPlanId: string;
  readonly windows: readonly LocalSubtitlePostProcessingWindow[];
} | {
  readonly schemaVersion: 2;
  readonly rootPlanId: string;
  readonly windows: readonly LocalSubtitlePostProcessingWindow[];
  readonly planning: {
    readonly strategy: typeof LOCAL_SUBTITLE_PAUSE_POLICY.id;
    readonly totalFrames: number;
    readonly quietCandidates: readonly LocalSubtitleQuietCandidate[];
  };
};

export interface LocalSubtitlePostProcessingWindowAttempt {
  readonly window: LocalSubtitlePostProcessingWindow;
  readonly windowAttempt: number;
  readonly processEpoch: number;
  readonly requestGeneration: number;
  readonly response: LocalSubtitleServerInferenceResponse;
}

export interface LocalSubtitlePostProcessPolicy {
  readonly schemaVersion: 3;
  readonly cuePolicy: typeof LOCAL_SUBTITLE_CUE_POLICY;
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
  | "estimated_timing_used"
  | "segment_boundaries_preserved";

export interface LocalSubtitlePostProcessingWarning {
  readonly code: LocalSubtitlePostProcessingWarningCode;
  readonly count: number;
}

/** A clipped seam cue the other window already recognized; ids and times only, never text. */
export interface LocalSubtitleSeamDuplicate {
  readonly cueId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly seamMs: number;
  /** "start": the next window's cue starts at the seam; "end": the previous window's cue ends there. */
  readonly clippedEdge: "start" | "end";
  /** 1 minus edits per comparison character to the closest stretch across the seam. */
  readonly coverage: number;
  /** Cues across the seam that keep this speech and stay unchanged. */
  readonly keptCueIds: readonly string[];
  /**
   * The kept cue clipped to the same seam from the other side, whose edge goes
   * back toward its raw time once this copy is gone. The report gives the
   * furthest it may move; dropLocalSubtitleSeamDuplicates gives where it moved.
   */
  readonly restoredEdge?: LocalSubtitleRestoredSeamEdge;
  /**
   * The kept copy the far-end guard left, whose seam-side words repeat the whole
   * remaining cue beside it; they go and its edge moves to that cue. The report
   * gives the planned removal and the furthest the edge may move;
   * dropLocalSubtitleSeamDuplicates gives what it removed and where the edge moved.
   */
  readonly trimmedEdge?: LocalSubtitleTrimmedSeamEdge;
}

/** A kept cue's edge moved from the seam (fromMs) toward its raw time (toMs); never text. */
export interface LocalSubtitleRestoredSeamEdge {
  readonly cueId: string;
  readonly edge: "start" | "end";
  readonly fromMs: number;
  readonly toMs: number;
}

/** A kept cue lost removedChars characters at this edge, which moved from fromMs to toMs; never text. */
export interface LocalSubtitleTrimmedSeamEdge {
  readonly cueId: string;
  readonly edge: "start" | "end";
  readonly removedChars: number;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * How retimeLocalSubtitleSegmentsFromAnchor moved one window: "retimed" when an
 * edge took an anchor time; otherwise the window keeps its times because the
 * preset did not hear it early as a whole ("not_early"), no edge aligned or no
 * ordered timing fits ("unaligned"), the texts are too long to compare
 * ("oversized") or the anchor heard nothing ("empty").
 */
export type LocalSubtitleAnchorRetimingStatus = "retimed" | "not_early" | "unaligned" | "oversized" | "empty";

/** One preset window's timing anchor; counts and times only, never text. */
export interface LocalSubtitleAnchorRetiming {
  /** The window's place among the task's accepted windows in request order, and its source range. */
  readonly windowIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly anchorSegments: number;
  /** Segment edges that aligned with an anchor segment's edge, of all the window's segment edges. */
  readonly anchoredEdges: number;
  readonly totalEdges: number;
  /**
   * The median signed shift of the anchored edges (anchor minus preset time, later
   * is positive; the lower middle of an even count), which decides whether the
   * window is retimed, and the largest move of any edge either way, or of an
   * anchored edge for a window kept as not early.
   */
  readonly medianShiftMs: number;
  readonly maxShiftMs: number;
  /**
   * The retiming outcome, or why no anchor was used: its request failed, its audio
   * differed or its response failed the quality guard ("failed"), the retimed
   * window would fail that guard and keeps its times, though the counts and shifts
   * describe the retiming ("rejected"), or the window had no text and sent none
   * ("skipped").
   */
  readonly status: LocalSubtitleAnchorRetimingStatus | "failed" | "rejected" | "skipped";
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
  /** Reported only; the transcript keeps these cues until dropLocalSubtitleSeamDuplicates. */
  readonly seamDuplicates: readonly LocalSubtitleSeamDuplicate[];
  readonly splitSegmentCount: number;
  readonly shortCueMergeCount: number;
  readonly estimatedTimingSegmentCount: number;
  readonly preservedSegmentCount: number;
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
  // Duration-weighted mean over every raw observation folded into this segment.
  confidence: number;
  confidenceWeightMs: number;
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
  preservedSegmentCount: number;
}

interface SeamDuplicateDecision {
  readonly index: number;
  readonly seamMs: number;
  readonly clippedEdge: "start" | "end";
  readonly coverage: number;
  readonly keptIndices: readonly number[];
  readonly restoredEdge?: {
    readonly index: number;
    readonly edge: "start" | "end";
    readonly toMs: number;
  };
  /** Planned on times only; the report keeps it when the wording allows the cut. */
  readonly trimmedEdge?: {
    readonly index: number;
    readonly edge: "start" | "end";
    readonly neighbourIndex: number;
    readonly fromMs: number;
    readonly toMs: number;
  };
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
    (inference.cuePolicy !== undefined && inference.cuePolicy !== "sentence_readable_v2" && inference.cuePolicy !== LOCAL_SUBTITLE_CUE_POLICY) ||
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
    schemaVersion: 3,
    cuePolicy: LOCAL_SUBTITLE_CUE_POLICY,
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
  });
}

export function planLocalSubtitleRootWindows(input: {
  readonly rootPlanId: string;
  readonly totalFrames: number;
  readonly policy: LocalSubtitlePostProcessPolicy;
  readonly pauseCandidates?: readonly LocalSubtitleQuietCandidate[];
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
  if (input.pauseCandidates !== undefined) {
    let ranges;
    try { ranges = planLocalSubtitlePauseRanges(input.totalFrames, input.pauseCandidates); }
    catch { throw invalidConfiguration("The pause window candidates are invalid.", "coverage", "pause_candidates_invalid"); }
    const windows = ranges.map((range, index) => {
      const key = `w${String(index).padStart(6, "0")}`;
      return { ...range, windowKey: key, rootWindowKey: key, rootPlanId: input.rootPlanId, retryDepth: 0,
        startMs: framesToMilliseconds(range.startFrame, input.policy.pcmSampleRateHz),
        endMs: framesToMilliseconds(range.endFrame, input.policy.pcmSampleRateHz),
        coreStartMs: framesToMilliseconds(range.coreStartFrame, input.policy.pcmSampleRateHz),
        coreEndMs: framesToMilliseconds(range.coreEndFrame, input.policy.pcmSampleRateHz) };
    });
    return deepFreeze({ schemaVersion: 2, rootPlanId: input.rootPlanId, windows,
      planning: { strategy: LOCAL_SUBTITLE_PAUSE_POLICY.id, totalFrames: input.totalFrames,
        quietCandidates: input.pauseCandidates.map(c => ({ startFrame: c.startFrame, endFrame: c.endFrame })) } });
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
  const seamDuplicateDecisions = findSeamDuplicates(leaves, merged, input.policy);

  const shapingDiagnostics: ShapingDiagnostics = {
    splitSegmentCount: 0,
    shortCueMergeCount: 0,
    estimatedTimingSegmentCount: 0,
    preservedSegmentCount: 0,
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
      confidence: Math.round(segment.confidence * CONFIDENCE_SCALE) / CONFIDENCE_SCALE,
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
  if (shapingDiagnostics.preservedSegmentCount > 0) {
    warnings.push({ code: "segment_boundaries_preserved", count: shapingDiagnostics.preservedSegmentCount });
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
      // Canonical cues map one to one onto merged segments.
      seamDuplicates: seamDuplicateDecisions.map((decision) => {
        const cue = validated.data.segments[decision.index]!;
        const trim = decision.trimmedEdge;
        const trimmed = trim && trimRepeatedSeamEdge(validated.data.segments[trim.index]!.text,
          validated.data.segments[trim.neighbourIndex]!.text, trim.edge);
        return {
          cueId: cue.id,
          startMs: cue.startMs,
          endMs: cue.endMs,
          seamMs: decision.seamMs,
          clippedEdge: decision.clippedEdge,
          coverage: decision.coverage,
          keptCueIds: decision.keptIndices.map(
            (index) => validated.data.segments[index]!.id,
          ),
          ...(decision.restoredEdge === undefined
            ? {}
            : {
                restoredEdge: {
                  cueId: validated.data.segments[decision.restoredEdge.index]!.id,
                  edge: decision.restoredEdge.edge,
                  fromMs: decision.seamMs,
                  toMs: decision.restoredEdge.toMs,
                },
              }),
          ...(trim === undefined || trimmed === undefined
            ? {}
            : {
                trimmedEdge: {
                  cueId: validated.data.segments[trim.index]!.id,
                  edge: trim.edge,
                  removedChars: trimmed.removedChars,
                  fromMs: trim.fromMs,
                  toMs: trim.toMs,
                },
              }),
        };
      }),
      splitSegmentCount: shapingDiagnostics.splitSegmentCount,
      shortCueMergeCount: shapingDiagnostics.shortCueMergeCount,
      preservedSegmentCount: shapingDiagnostics.preservedSegmentCount,
      estimatedTimingSegmentCount:
        shapingDiagnostics.estimatedTimingSegmentCount,
      finalSegmentCount: validated.data.segments.length,
      firstFinalStartMs: validated.data.segments[0]!.startMs,
      lastFinalEndMs: validated.data.segments.at(-1)!.endMs,
    },
  });
}

/**
 * Removes reported seam duplicates whose cue and kept cues are still present
 * with their reported timing and wording (separators aside). A cue a later
 * repair replaced keeps that repair's decision, and a duplicate whose kept cue
 * would also go stays. A reported edge clipped to the same seam goes back
 * toward its raw time, never over the nearest remaining cue on that side. Kept
 * cues keep their wording except under a reported trim: a kept copy's seam-side
 * words go while they still repeat the whole reported neighbour and break off
 * at punctuation or whitespace, and that neighbour is still next to it and
 * unchanged; the copy's edge then moves out to the neighbour.
 */
export function dropLocalSubtitleSeamDuplicates<
  T extends Pick<LocalSubtitleSegment, "id" | "startMs" | "endMs" | "text">,
>(
  reported: readonly LocalSubtitleSegment[],
  duplicates: readonly LocalSubtitleSeamDuplicate[],
  current: readonly T[],
): Readonly<{
  segments: readonly T[];
  dropped: readonly LocalSubtitleSeamDuplicate[];
}> {
  const reportedById = new Map(reported.map((cue) => [cue.id, cue] as const));
  const currentById = new Map(current.map((cue) => [cue.id, cue] as const));
  const unchanged = (id: string): boolean => {
    const before = reportedById.get(id);
    const after = currentById.get(id);
    return (
      before !== undefined &&
      after !== undefined &&
      before.startMs === after.startMs &&
      before.endMs === after.endMs &&
      boundaryFingerprint(before.text) === boundaryFingerprint(after.text)
    );
  };
  const candidates = duplicates.filter(
    (duplicate) =>
      unchanged(duplicate.cueId) && duplicate.keptCueIds.every(unchanged),
  );
  const candidateIds = new Set(candidates.map((duplicate) => duplicate.cueId));
  const dropped = candidates.filter(
    (duplicate) => !duplicate.keptCueIds.some((id) => candidateIds.has(id)),
  );
  const droppedIds = new Set(dropped.map((duplicate) => duplicate.cueId));
  const segments = current.filter((cue) => !droppedIds.has(cue.id));
  const restore = (keptCueIds: readonly string[], restoredEdge: LocalSubtitleRestoredSeamEdge) => {
    const position = keptCueIds.includes(restoredEdge.cueId)
      ? segments.findIndex((cue) => cue.id === restoredEdge.cueId)
      : -1;
    const cue = segments[position];
    if (!cue) return undefined;
    const start = restoredEdge.edge === "start";
    const toMs = start
      ? Math.max(restoredEdge.toMs, segments[position - 1]?.endMs ?? restoredEdge.toMs)
      : Math.min(restoredEdge.toMs, segments[position + 1]?.startMs ?? restoredEdge.toMs);
    const fromMs = start ? cue.startMs : cue.endMs;
    if (fromMs !== restoredEdge.fromMs || (start ? toMs >= fromMs : toMs <= fromMs)) return undefined;
    segments[position] = Object.freeze(start ? { ...cue, startMs: toMs } : { ...cue, endMs: toMs });
    return Object.freeze({ ...restoredEdge, toMs });
  };
  // The report planned each trim against the cue next to the kept copy once
  // every reported duplicate is gone.
  const reportedIds = new Set(duplicates.map((duplicate) => duplicate.cueId));
  const reportedRemaining = reported.filter((cue) => !reportedIds.has(cue.id));
  const trim = (keptCueIds: readonly string[], trimmedEdge: LocalSubtitleTrimmedSeamEdge) => {
    const position = keptCueIds.includes(trimmedEdge.cueId)
      ? segments.findIndex((cue) => cue.id === trimmedEdge.cueId)
      : -1;
    const start = trimmedEdge.edge === "start";
    const reportedAt = reportedRemaining.findIndex((cue) => cue.id === trimmedEdge.cueId);
    const expected = reportedAt < 0 ? undefined : reportedRemaining[start ? reportedAt - 1 : reportedAt + 1];
    const cue = segments[position];
    const neighbour = segments[start ? position - 1 : position + 1];
    // The reported neighbour, still next to the copy and neither repaired nor moved here.
    if (
      !cue || !neighbour || neighbour.id !== expected?.id ||
      neighbour !== currentById.get(neighbour.id) || !unchanged(neighbour.id)
    ) {
      return undefined;
    }
    const trimmed = trimRepeatedSeamEdge(cue.text, neighbour.text, trimmedEdge.edge);
    if (!trimmed) return undefined;
    // The edge only moves out, never over the neighbour nor past the planned bound.
    const fromMs = start ? cue.startMs : cue.endMs;
    const toMs = start
      ? Math.min(fromMs, Math.max(trimmedEdge.toMs, neighbour.endMs))
      : Math.max(fromMs, Math.min(trimmedEdge.toMs, neighbour.startMs));
    segments[position] = Object.freeze(start
      ? { ...cue, text: trimmed.text, startMs: toMs }
      : { ...cue, text: trimmed.text, endMs: toMs });
    return Object.freeze({ ...trimmedEdge, removedChars: trimmed.removedChars, fromMs, toMs });
  };
  // Each entry lists the edge it restored here, then the edge it trimmed, if any.
  const applied = dropped.map(({ restoredEdge, trimmedEdge, ...duplicate }) => {
    const restoredTo = restoredEdge && restore(duplicate.keptCueIds, restoredEdge);
    const trimmedTo = trimmedEdge && trim(duplicate.keptCueIds, trimmedEdge);
    return Object.freeze({
      ...duplicate,
      ...(restoredTo ? { restoredEdge: restoredTo } : {}),
      ...(trimmedTo ? { trimmedEdge: trimmedTo } : {}),
    });
  });
  return Object.freeze({
    segments: Object.freeze(segments),
    dropped: Object.freeze(applied),
  });
}

/**
 * Moves a preset window's raw segments onto the times of the same audio
 * recognized with the standard request fields (window-relative milliseconds);
 * text and every other field stay. Both texts are compared as across seams
 * (NFKC, lowercase, without punctuation and whitespace) and paired character by
 * character along a longest common subsequence. A segment's start takes an
 * anchor segment's start when its first two characters pair with that anchor
 * segment's first two, and its end takes an anchor segment's end when its last
 * two pair with that segment's last two. Every other edge moves by the shift
 * interpolated, along the preset times, between the nearest anchored edges
 * before and after it in segment order, or by the nearest one's shift beyond
 * the outermost. Starts then stay at or after the previous end and segments
 * last at least the minimum, all within the window; where the window end leaves
 * a segment too short, it and those before it move earlier, though no anchored
 * edge does. Only a window the preset heard early as a whole moves: the median
 * of its anchored edges' shifts (anchor minus preset time) is at least
 * LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS. A window without an
 * anchored edge or such a fit keeps its segments, as does one not heard early.
 */
export function retimeLocalSubtitleSegmentsFromAnchor<
  T extends Pick<LocalSubtitleServerRawSegment, "startMs" | "endMs" | "text">,
>(
  preset: readonly T[],
  anchor: readonly Pick<LocalSubtitleServerRawSegment, "startMs" | "endMs" | "text">[],
  durationMs: number,
): Readonly<{
  segments: readonly T[];
  status: LocalSubtitleAnchorRetimingStatus;
  anchoredEdges: number;
  totalEdges: number;
  medianShiftMs: number;
  maxShiftMs: number;
}> {
  const totalEdges = preset.length * 2;
  const kept = (status: LocalSubtitleAnchorRetimingStatus) => Object.freeze({
    segments: preset, status, anchoredEdges: 0, totalEdges, medianShiftMs: 0, maxShiftMs: 0,
  });
  // Each comparison character with its segment and its place from either end.
  const characters = (segments: readonly Pick<LocalSubtitleServerRawSegment, "text">[]) =>
    segments.flatMap((segment, index) => {
      const units = isSafeUnicodeText(segment.text) ? createBoundaryComparisonMap(segment.text).units : [];
      return units.map((unit, position) => ({ unit, index, position, fromEnd: units.length - 1 - position }));
    });
  const presetCharacters = characters(preset);
  const anchorCharacters = characters(anchor);
  if (anchorCharacters.length === 0) return kept("empty");
  if (presetCharacters.length * anchorCharacters.length > ANCHOR_RETIMING_MAX_COMPARISON_UNITS) {
    return kept("oversized");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return kept("unaligned");

  const pairedWith = longestCommonSubsequence(
    presetCharacters.map((character) => character.unit),
    anchorCharacters.map((character) => character.unit),
  );
  // The anchor time of an edge whose two outermost characters, from `first` on,
  // pair with the two outermost characters at the same end of one anchor segment.
  const anchorTime = (first: number, edge: "start" | "end"): number | undefined => {
    const left = presetCharacters[first];
    const right = presetCharacters[first + 1];
    const pairedLeft = pairedWith[first] ?? -1;
    if (!left || !right || left.index !== right.index || pairedLeft < 0 || pairedWith[first + 1] !== pairedLeft + 1) {
      return undefined;
    }
    const anchorLeft = anchorCharacters[pairedLeft]!;
    const anchorRight = anchorCharacters[pairedLeft + 1]!;
    if (anchorLeft.index !== anchorRight.index) return undefined;
    if (edge === "start" ? anchorLeft.position !== 0 : anchorRight.fromEnd !== 0) return undefined;
    const segment = anchor[anchorLeft.index]!;
    return edge === "start" ? segment.startMs : segment.endMs;
  };
  // Edge 2k is segment k's start and edge 2k + 1 its end.
  const edges = preset.flatMap((segment) => [segment.startMs, segment.endMs]);
  const targets = new Array<number | undefined>(totalEdges).fill(undefined);
  presetCharacters.forEach((character, position) => {
    if (character.position === 0) targets[character.index * 2] = anchorTime(position, "start");
    if (character.fromEnd === 0) targets[character.index * 2 + 1] = anchorTime(position - 1, "end");
  });
  const anchoredEdges = targets.filter((target) => target !== undefined).length;
  if (anchoredEdges === 0) return kept("unaligned");
  const shiftOf = (edge: number) => targets[edge]! - edges[edge]!;
  // A decoder that missed some speech hears what follows early, so only a window
  // whose anchored edges mostly move later moves; smaller or earlier shifts are
  // mostly the anchor's own variation. The lower middle of an even count asks more
  // than half of them to move later by at least the minimum.
  const anchoredShifts = targets.flatMap((target, edge) => target === undefined ? [] : [shiftOf(edge)])
    .sort((left, right) => left - right);
  const medianShiftMs = anchoredShifts[(anchoredShifts.length - 1) >> 1]!;
  if (medianShiftMs < LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS) {
    return Object.freeze({
      segments: preset, status: "not_early" as const, anchoredEdges, totalEdges, medianShiftMs,
      maxShiftMs: anchoredShifts.reduce((maximum, shift) => Math.max(maximum, Math.abs(shift)), 0),
    });
  }

  // The nearest anchored edge at or before each edge in segment order, and at or after it.
  const before = new Array<number | undefined>(totalEdges);
  const after = new Array<number | undefined>(totalEdges);
  let nearest: number | undefined;
  for (let edge = 0; edge < totalEdges; edge += 1) {
    if (targets[edge] !== undefined) nearest = edge;
    before[edge] = nearest;
  }
  nearest = undefined;
  for (let edge = totalEdges - 1; edge >= 0; edge -= 1) {
    if (targets[edge] !== undefined) nearest = edge;
    after[edge] = nearest;
  }
  const moved = edges.map((timeMs, edge) => {
    const from = before[edge];
    const to = after[edge];
    if (from === undefined) return timeMs + shiftOf(to!);
    if (to === undefined || to === from) return timeMs + shiftOf(from);
    const fromMs = edges[from]!;
    const toMs = edges[to]!;
    const fraction = toMs > fromMs ? Math.min(1, Math.max(0, (timeMs - fromMs) / (toMs - fromMs))) : 0;
    return Math.round(timeMs + shiftOf(from) + (shiftOf(to) - shiftOf(from)) * fraction);
  });

  // Forward for order and the minimum length, then back from the window end,
  // which may move only edges that took no anchor time.
  const times = preset.map((_, index) => ({ startMs: moved[index * 2]!, endMs: moved[index * 2 + 1]! }));
  let previousEndMs = 0;
  for (const time of times) {
    time.startMs = Math.min(Math.max(time.startMs, previousEndMs), durationMs);
    time.endMs = Math.min(Math.max(time.endMs, time.startMs + ANCHOR_RETIMING_MIN_SEGMENT_MS), durationMs);
    previousEndMs = time.endMs;
  }
  let nextStartMs = durationMs;
  for (let index = times.length - 1; index >= 0; index -= 1) {
    const time = times[index]!;
    const endMs = Math.min(time.endMs, nextStartMs);
    const startMs = Math.min(time.startMs, endMs - ANCHOR_RETIMING_MIN_SEGMENT_MS);
    if ((endMs < time.endMs && targets[index * 2 + 1] !== undefined) ||
        (startMs < time.startMs && targets[index * 2] !== undefined)) {
      return kept("unaligned");
    }
    time.endMs = endMs;
    time.startMs = startMs;
    nextStartMs = startMs;
  }
  if (times[0]!.startMs < 0) return kept("unaligned");

  const shifts = times.flatMap((time, index) =>
    [time.startMs - preset[index]!.startMs, time.endMs - preset[index]!.endMs]);
  return Object.freeze({
    segments: Object.freeze(preset.map((segment, index) => {
      const { startMs, endMs } = times[index]!;
      return startMs === segment.startMs && endMs === segment.endMs
        ? segment
        : Object.freeze({ ...segment, startMs, endMs });
    })),
    status: "retimed" as const,
    anchoredEdges,
    totalEdges,
    medianShiftMs,
    maxShiftMs: shifts.reduce((maximum, shift) => Math.max(maximum, Math.abs(shift)), 0),
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
        // A clipped observation keeps its value and weighs only its owned part.
        confidence: rawSegmentConfidence(segment),
        confidenceWeightMs: endMs - startMs,
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
      absorbConfidence(previous, candidate);
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
          absorbConfidence(previous, candidate);
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
      candidate.confidenceWeightMs = candidate.endMs - candidate.startMs;
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
  let previousEndMs = -1;
  const planned = merged.map(segment => {
    if (segment.startMs < previousEndMs) {
      throw qualityFailure("shaping", "canonical_shaping_order_failed");
    }
    previousEndMs = segment.endMs;
    try {
      const cue = planLocalSubtitleSegmentCue({
        timelineDomain: "original_media",
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: flattenSubtitleText(segment.text),
      }, policy);
      if (cue.exceedsDisplayTarget) diagnostics.preservedSegmentCount += 1;
      return { ...segment, text: cue.text };
    } catch (error) {
      if (!(error instanceof LocalSubtitleCuePlanError)) throw error;
      if (error.reason === "limit_exceeded") {
        throw limitExceeded("A preserved subtitle cue exceeds the format limit.",
          "shaping", error.observed!, error.limit!);
      }
      throw qualityFailure("shaping", error.reason);
    }
  });
  diagnostics.estimatedTimingSegmentCount = planned.filter(segment => segment.estimatedTiming).length;
  return planned;
}

/**
 * A raw observation that straddled an overlapping seam was clipped to it. When
 * the other window already heard that speech (one stretch of the overlapping
 * raw observations across the seam differs from the clipped cue in at most a
 * fifth of its characters), the clipped copy is a duplicate; a short reply
 * whose characters only occur apart in a longer sentence there stays. The next
 * window's copy is judged first, so the previous window keeps speech it heard
 * in place; legal repetition heard at other times never overlaps and is never
 * compared. A clipped cue whose far end (away from the seam) carries words the
 * other window's copy stops short of is not a duplicate, so dropping never
 * loses words. A cue that keeps an earlier duplicate's speech goes only when that
 * duplicate stays covered without it, so every kept cue survives and drops
 * never cascade across consecutive seams. With its copy gone, a kept cue clipped
 * to the same seam from the other side no longer needs that cut: its edge may go
 * back toward its raw time, never past the copy's far edge nor beyond the
 * configured longest cue. A copy kept for its far-end words may still open (or
 * close) at the seam with the whole remaining cue beside it; the entry that
 * keeps it plans removing those words, its edge going out to that cue within
 * the longest cue.
 */
function findSeamDuplicates(
  leaves: readonly LocalSubtitlePostProcessingWindowAttempt[],
  merged: readonly WorkingSegment[],
  policy: LocalSubtitlePostProcessPolicy,
): SeamDuplicateDecision[] {
  let decisions: SeamDuplicateDecision[] = [];
  const dropped = new Set<number>();
  const farEndKept: { readonly index: number; readonly seamMs: number; readonly edge: "start" | "end" }[] = [];
  const covered = (index: number, clippedEdge: "start" | "end", keptIndices: readonly number[]) => {
    const coverage = seamDuplicateCoverage(
      merged[index]!.text,
      clippedEdge,
      keptIndices.map((other) => merged[other]!.text),
      policy,
    );
    return coverage === "far_end" || (coverage !== undefined && coverage >= SEAM_DUPLICATE_MIN_COVERAGE)
      ? coverage
      : undefined;
  };
  for (let order = 1; order < leaves.length; order += 1) {
    const left = leaves[order - 1]!.window;
    const right = leaves[order]!.window;
    const seamMs = left.coreEndMs;
    // A pause cut shares no audio, so no observation straddles it.
    if (right.startMs >= left.endMs) continue;
    // Merged segments are ordered and disjoint, so their ends ascend too.
    let first = 0;
    for (let last = merged.length; first < last; ) {
      const middle = (first + last) >> 1;
      if (merged[middle]!.endMs <= right.startMs) first = middle + 1;
      else last = middle;
    }
    const shared: number[] = [];
    for (let index = first; index < merged.length && merged[index]!.startMs < left.endMs; index += 1) {
      if (!dropped.has(index)) shared.push(index);
    }
    const clippedTo = (index: number, edge: "start" | "end") => {
      const segment = merged[index]!;
      return edge === "start"
        ? segment.sourceWindowKey === right.windowKey &&
          segment.startMs === seamMs && segment.rawObservationStartMs < seamMs
        : segment.sourceWindowKey === left.windowKey &&
          segment.endMs === seamMs && segment.rawObservationEndMs > seamMs;
    };
    const clipped = (["start", "end"] as const).flatMap((clippedEdge) =>
      shared.filter((index) => clippedTo(index, clippedEdge))
        .map((index) => ({ index, clippedEdge })));
    for (const { index, clippedEdge } of clipped) {
      const candidate = merged[index]!;
      const keptIndices = shared.filter((other) => {
        const segment = merged[other]!;
        return !dropped.has(other) &&
          (clippedEdge === "start" ? segment.startMs < seamMs : segment.startMs >= seamMs) &&
          Math.max(segment.rawObservationStartMs, candidate.rawObservationStartMs) <
            Math.min(segment.rawObservationEndMs, candidate.rawObservationEndMs);
      });
      const coverage = covered(index, clippedEdge, keptIndices);
      if (coverage === "far_end") farEndKept.push({ index, seamMs, edge: clippedEdge });
      if (typeof coverage !== "number") continue;
      // Earlier decisions that kept this cue are judged again without it; one
      // that no longer holds keeps this cue.
      const revised = decisions.flatMap((decision) => {
        if (!decision.keptIndices.includes(index)) return [decision];
        const remaining = decision.keptIndices.filter((other) => other !== index);
        const kept = covered(decision.index, decision.clippedEdge, remaining);
        return typeof kept !== "number" ? [] : [{
          ...decision,
          coverage: kept,
          keptIndices: remaining,
          restoredEdge: decision.restoredEdge?.index === index ? undefined : decision.restoredEdge,
        }];
      });
      if (revised.length < decisions.length) continue;
      dropped.add(index);
      const edge = clippedEdge === "start" ? "end" : "start";
      const restored = keptIndices.find((other) => clippedTo(other, edge));
      let restoredEdge: SeamDuplicateDecision["restoredEdge"];
      if (restored !== undefined) {
        const cue = merged[restored]!;
        // Seams go in time order, so a cue clipped at both its seams gets its start
        // back first; its end then stays within the longest cue from that start.
        const startMs = revised.find((decision) => decision.restoredEdge?.index === restored)
          ?.restoredEdge?.toMs ?? cue.startMs;
        const toMs = edge === "start"
          ? Math.max(cue.rawObservationStartMs, candidate.startMs,
            cue.endMs - policy.maxCueDurationMs)
          : Math.min(cue.rawObservationEndMs, candidate.endMs, startMs + policy.maxCueDurationMs);
        if (edge === "start" ? toMs < seamMs : toMs > seamMs) {
          restoredEdge = { index: restored, edge, toMs };
        }
      }
      decisions = [...revised, { index, seamMs, clippedEdge, coverage, keptIndices, restoredEdge }];
    }
  }
  const trims: NonNullable<SeamDuplicateDecision["trimmedEdge"]>[] = [];
  return decisions.map((decision) => {
    const copy = farEndKept.find((kept) => kept.seamMs === decision.seamMs &&
      kept.edge !== decision.clippedEdge && decision.keptIndices.includes(kept.index));
    if (copy === undefined) return decision;
    const step = copy.edge === "start" ? -1 : 1;
    let neighbourIndex = copy.index + step;
    while (dropped.has(neighbourIndex)) neighbourIndex += step;
    const neighbour = merged[neighbourIndex];
    if (neighbour === undefined) return decision;
    // Times as the restores and an earlier trim of the other edge leave them, so
    // both edges stay within the longest cue.
    const cue = merged[copy.index]!;
    const movedTo = (edge: "start" | "end") =>
      trims.find((trim) => trim.index === copy.index && trim.edge === edge)?.toMs ??
      decisions.find((other) => other.restoredEdge?.index === copy.index &&
        other.restoredEdge.edge === edge)?.restoredEdge?.toMs;
    const startMs = movedTo("start") ?? cue.startMs;
    const endMs = movedTo("end") ?? cue.endMs;
    const toMs = copy.edge === "start"
      ? Math.min(startMs, Math.max(neighbour.endMs, endMs - policy.maxCueDurationMs))
      : Math.max(endMs, Math.min(neighbour.startMs, startMs + policy.maxCueDurationMs));
    const trimmedEdge = { index: copy.index, edge: copy.edge, neighbourIndex,
      fromMs: copy.edge === "start" ? startMs : endMs, toMs };
    trims.push(trimmedEdge);
    return { ...decision, trimmedEdge };
  });
}

function seamDuplicateCoverage(
  text: string,
  clippedEdge: "start" | "end",
  across: readonly string[],
  policy: LocalSubtitlePostProcessPolicy,
): number | "far_end" | undefined {
  const units = createBoundaryComparisonMap(text).units;
  const acrossUnits = across.flatMap((value) => createBoundaryComparisonMap(value).units);
  const minimum = CJK_PATTERN.test(units.join(""))
    ? policy.boundaryTextMinCjkChars
    : policy.boundaryTextMinLatinChars;
  if (
    units.length < minimum ||
    acrossUnits.length === 0 ||
    units.length * acrossUnits.length > SEAM_DUPLICATE_MAX_COMPARISON_UNITS
  ) {
    return undefined;
  }
  // Read toward the far end, away from the seam: a next window's cue forward,
  // a previous window's cue backward.
  const edits = clippedEdge === "start"
    ? closestStretchEdits(units, acrossUnits)
    : closestStretchEdits([...units].reverse(), [...acrossUnits].reverse());
  // Words past where the other window's copy stops were heard only here.
  if (edits.unmatchedTail >= minimum) return "far_end";
  return (units.length - edits.count) / units.length;
}

/**
 * The text without its seam-side words (the start's or the end's) when, compared
 * as across seams, they are exactly the whole of `neighbour` and the text breaks
 * there at punctuation or whitespace, which goes with them; a lone word joiner
 * between letters or digits is no break. Undefined otherwise, or when fewer than
 * the minimum comparison characters would remain.
 */
function trimRepeatedSeamEdge(
  text: string,
  neighbour: string,
  edge: "start" | "end",
): { readonly text: string; readonly removedChars: number } | undefined {
  const repeated = createBoundaryComparisonMap(neighbour).units;
  const parts = graphemes(text);
  const units = parts.map((part) => Array.from(part
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(BOUNDARY_COMPARISON_IGNORED_PATTERN, "")));
  const all = units.flat();
  const restCount = all.length - repeated.length;
  if (repeated.length === 0 || restCount <= 0) return undefined;
  const seamSide = edge === "start" ? all.slice(0, repeated.length) : all.slice(restCount);
  const rest = edge === "start" ? all.slice(repeated.length) : all.slice(0, restCount);
  // The policy's minimums are these constants; the executor has no policy.
  const minimum = CJK_PATTERN.test(rest.join(""))
    ? LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinCjkChars
    : LOCAL_SUBTITLE_POST_PROCESSING_POLICY.boundaryTextMinLatinChars;
  if (rest.length < minimum || seamSide.join("") !== repeated.join("")) return undefined;
  // Walk from the seam side over whole graphemes to where the repeat ends; the
  // next one must be punctuation or whitespace, and that run goes too.
  const step = edge === "start" ? 1 : -1;
  let position = edge === "start" ? 0 : parts.length - 1;
  for (let matched = 0; matched < repeated.length; position += step) {
    matched += units[position]!.length;
    if (matched > repeated.length) return undefined;
  }
  if (units[position]?.length !== 0) return undefined;
  const cut = position;
  while (units[position]?.length === 0) position += step;
  if (
    position - cut === step && WORD_JOINER_PATTERN.test(parts[cut]!) &&
    WORD_CHARACTER_PATTERN.test(parts[cut - step]!) && WORD_CHARACTER_PATTERN.test(parts[position]!)
  ) {
    return undefined;
  }
  const kept = edge === "start" ? parts.slice(position) : parts.slice(0, position + 1);
  return { text: kept.join(""), removedChars: parts.length - kept.length };
}

/**
 * Fewest insertions, deletions and substitutions that turn `units` into one
 * contiguous stretch of `across`, so characters scattered through a longer
 * sentence never count as a match, and the trailing units that every such
 * edit leaves without any counterpart in `across`, matched or substituted.
 */
function closestStretchEdits(
  units: readonly string[],
  across: readonly string[],
): { readonly count: number; readonly unmatchedTail: number } {
  // A stretch may start anywhere, so matching no units yet costs nothing.
  const edits = new Array<number>(across.length + 1).fill(0);
  // A stretch may end anywhere too: for each prefix of units, the fewest
  // edits that still pair its last unit with a character of the stretch
  // (the empty prefix pairs nothing and costs nothing).
  const pairedEdits = [0];
  for (const unit of units) {
    let diagonal = edits[0]!;
    edits[0] = diagonal + 1;
    let paired = Infinity;
    for (let index = 0; index < across.length; index += 1) {
      const above = edits[index + 1]!;
      const pairing = diagonal + (unit === across[index] ? 0 : 1);
      edits[index + 1] = Math.min(pairing, above + 1, edits[index]! + 1);
      paired = Math.min(paired, pairing);
      diagonal = above;
    }
    pairedEdits.push(paired);
  }
  // Units after the last paired one each cost a deletion. Among the fewest
  // edits, the latest last pairing leaves only units past the end of `across`:
  // any earlier, substituting the next unit would cost no more.
  let count = units.length;
  let unmatchedTail = units.length;
  for (let prefix = 0; prefix <= units.length; prefix += 1) {
    const total = pairedEdits[prefix]! + units.length - prefix;
    if (total <= count) {
      count = total;
      unmatchedTail = units.length - prefix;
    }
  }
  return { count, unmatchedTail };
}

/**
 * For each unit of `left`, the index of the unit of `right` it pairs with along
 * one longest common subsequence, or -1. The caller's size cap keeps every
 * length below 16 bits.
 */
function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[],
): number[] {
  const width = right.length + 1;
  // lengths[row * width + column]: the longest common subsequence of left from
  // row on and right from column on.
  const lengths = new Uint16Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] = left[row] === right[column]
        ? lengths[(row + 1) * width + column + 1]! + 1
        : Math.max(lengths[(row + 1) * width + column]!, lengths[row * width + column + 1]!);
    }
  }
  const pairedWith = new Array<number>(left.length).fill(-1);
  for (let row = 0, column = 0; row < left.length && column < right.length; ) {
    if (left[row] === right[column]) {
      pairedWith[row] = column;
      row += 1;
      column += 1;
    } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return pairedWith;
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
    !hasOnlyKeys(plan, ["schemaVersion", "rootPlanId", "windows", ...(plan.schemaVersion === 2 ? ["planning"] : [])]) ||
    (plan.schemaVersion !== 1 && plan.schemaVersion !== 2) ||
    typeof plan.rootPlanId !== "string" ||
    !Array.isArray(plan.windows) ||
    plan.windows.length === 0
  ) {
    throw graphFailure("root_plan_invalid");
  }
  validateSafeId(plan.rootPlanId, "root_plan_id_invalid", "coverage");
  for (const window of plan.windows) validateWindowDescriptor(window, input.policy, "coverage");
  if (plan.schemaVersion === 2 && (!isRecord(plan.planning) ||
      !hasOnlyKeys(plan.planning, ["strategy", "totalFrames", "quietCandidates"]) ||
      plan.planning.strategy !== LOCAL_SUBTITLE_PAUSE_POLICY.id ||
      plan.planning.totalFrames !== input.source.totalFrames || !Array.isArray(plan.planning.quietCandidates))) {
    throw graphFailure("pause_plan_invalid");
  }
  const expected = planLocalSubtitleRootWindows({
    rootPlanId: plan.rootPlanId,
    totalFrames: input.source.totalFrames,
    policy: input.policy,
    ...(plan.schemaVersion === 2 ? { pauseCandidates: plan.planning.quietCandidates } : {}),
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

/**
 * Decoder evidence for review hints, never an accuracy claim. A positive
 * log probability is clamped so the product stays within 0-1.
 */
function rawSegmentConfidence(segment: LocalSubtitleServerRawSegment): number {
  return (
    Math.exp(Math.min(0, segment.averageLogProbability)) *
    (1 - segment.noSpeechProbability)
  );
}

function absorbConfidence(target: WorkingSegment, source: WorkingSegment): void {
  const weightMs = target.confidenceWeightMs + source.confidenceWeightMs;
  target.confidence =
    (target.confidence * target.confidenceWeightMs +
      source.confidence * source.confidenceWeightMs) /
    weightMs;
  target.confidenceWeightMs = weightMs;
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
    policy.schemaVersion !== 3 ||
    policy.cuePolicy !== LOCAL_SUBTITLE_CUE_POLICY ||
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
