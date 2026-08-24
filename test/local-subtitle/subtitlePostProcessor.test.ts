import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleInferenceSnapshot,
} from "../../src/type/localSubtitle";
import { validateLocalSubtitleTranscript } from "../../src/type/localSubtitleIpc";
import type {
  LocalSubtitleServerInferenceResponse,
  LocalSubtitleServerInferenceResult,
  LocalSubtitleServerRawSegment,
} from "../../electron/main/local-subtitle/server-contract";
import { parseLocalSubtitleServerVerboseJson } from "../../electron/main/local-subtitle/server-contract";
import {
  LOCAL_SUBTITLE_POST_PROCESSING_POLICY,
  LocalSubtitlePostProcessorError,
  assessLocalSubtitleRawWindow,
  createSubtitlePostProcessPolicy,
  decideLocalSubtitleWindowRetry,
  planLocalSubtitleRetryChildren,
  planLocalSubtitleRootWindows,
  postProcessLocalSubtitleTranscript,
  type LocalSubtitlePostProcessPolicy,
  type LocalSubtitlePostProcessingRequest,
  type LocalSubtitlePostProcessingWindow,
  type LocalSubtitlePostProcessingWindowAttempt,
  type LocalSubtitleRootWindowPlan,
} from "../../electron/main/local-subtitle/subtitle-post-processor";

const FRAMES_PER_MILLISECOND = 16;
const MODEL = Object.freeze({
  engine: "whisper_cpp" as const,
  modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
  backend: "cpu" as const,
});

describe("local subtitle post-processing policy", () => {
  it("freezes named production thresholds without retaining prompt content", () => {
    const policy = policyFrom({
      initialPrompt: "private prompt that must not survive",
    });

    expect(policy).toMatchObject({
      schemaVersion: 1,
      wordTimelineMode: "segment_only_v1",
      qualityFingerprint:
        "nfkc-lowercase-without-punctuation-symbols-whitespace",
      boundaryFingerprint: "nfkc-lowercase-without-punctuation-whitespace",
      pcmSampleRateHz: 16_000,
      maxWindowDurationMs: 30_000,
      rootWindowOverlapMs: 5_000,
      boundaryToleranceMs: 100,
      maxRawSegmentDurationMs: 15_000,
      repeatedCueThreshold: 8,
      repeatedCoverageMs: 15_000,
      maxRetryDepth: 3,
      minRetryWindowMs: 4_000,
      retryOverlapMs: 2_000,
      minRetrySplitRatio: 1.25,
      boundaryTextGapMs: 500,
      boundaryTextMinCjkChars: 2,
      boundaryTextMinLatinChars: 4,
      shortCueMergeGapMs: 300,
    });
    expect(JSON.stringify(policy)).not.toContain("private prompt");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(LOCAL_SUBTITLE_POST_PROCESSING_POLICY)).toBe(true);
  });

  it("rejects a drifted raw gate or a copied mutable policy", () => {
    const inference = inferenceSnapshot();
    const drifted = structuredClone(inference) as MutableInferenceSnapshot;
    drifted.rawQualityGate.maxRetryDepth = 2 as 3;
    expect(() => createSubtitlePostProcessPolicy(drifted)).toThrow(
      LocalSubtitlePostProcessorError,
    );

    const policy = policyFrom();
    const copied = { ...policy, boundaryToleranceMs: 101 };
    expect(() =>
      assessLocalSubtitleRawWindow({
        window: oneWindow(),
        result: serverResult([], 30_000),
        policy: copied,
      }),
    ).toThrow(/policy is invalid/u);
  });
});

describe("raw transcript quality gate", () => {
  it("accepts the exact segment, overlap, and window boundary limits", () => {
    const assessment = assess([
      rawSegment(0, 15_000, "first", 0),
      rawSegment(14_900, 20_000, "second", 1),
      rawSegment(20_000, 30_100, "tail", 2),
    ]);

    expect(assessment.valid).toBe(true);
    expect(assessment.overlappingSegmentCount).toBe(0);
    expect(assessment.outOfWindowSegmentCount).toBe(0);
    expect(assessment.overlongSegmentCount).toBe(0);
    expect(assessment.longestSegmentDurationMs).toBe(15_000);
  });

  it.each([
    {
      label: "non-positive duration",
      segments: [rawSegment(1_000, 1_000, "zero")],
      issue: "non_positive_duration",
    },
    {
      label: "reverse order",
      segments: [
        rawSegment(1_000, 2_000, "first", 0),
        rawSegment(800, 1_200, "second", 1),
      ],
      issue: "reverse_order",
    },
    {
      label: "101 ms overlap",
      segments: [
        rawSegment(0, 1_000, "first", 0),
        rawSegment(899, 1_500, "second", 1),
      ],
      issue: "overlap",
    },
    {
      label: "101 ms outside window",
      segments: [rawSegment(29_000, 30_101, "outside")],
      issue: "out_of_window",
    },
  ])("rejects $label before formatting", ({ segments, issue }) => {
    const assessment = assess(segments);
    expect(assessment.valid).toBe(false);
    expect(assessment.issues).toContain(issue);
  });

  it("records a long sparse-speech segment without rejecting shapeable text", () => {
    const window = oneWindow();
    const segments = [
      rawSegment(
        1_000,
        23_000,
        "これはゆっくり話された有効な字幕なので、表示用の短い字幕へ安全に分割します。",
      ),
    ];
    const assessment = assess(segments);
    const attempt = leaf(window, segments);

    expect(assessment).toMatchObject({
      valid: true,
      issues: [],
      overlongSegmentCount: 1,
      longestSegmentDurationMs: 22_000,
    });
    expect(
      decideLocalSubtitleWindowRetry({
        attempt,
        assessment,
        policy: policyFrom(),
      }),
    ).toMatchObject({ action: "accept", outcome: "speech" });

    const result = process({ durationMs: 30_000, leaves: [attempt] });
    expect(result.report.overlongRawSegmentCount).toBe(1);
    expect(result.transcript.segments.length).toBeGreaterThan(1);
    expect(
      result.transcript.segments.every(
        (segment) => segment.endMs - segment.startMs <= 7_000,
      ),
    ).toBe(true);
  });

  it("shortens a sparse raw timeline instead of duplicating text or failing", () => {
    const attempt = leaf(oneWindow(), [rawSegment(1_000, 23_000, "うん")]);

    const result = process({ durationMs: 30_000, leaves: [attempt] });

    expect(result.transcript.segments).toEqual([
      expect.objectContaining({
        startMs: 1_000,
        endMs: 8_000,
        text: "うん",
        estimatedTiming: true,
      }),
    ]);
    expect(result.report.overlongRawSegmentCount).toBe(1);
    expect(result.report.estimatedTimingSegmentCount).toBe(1);
    expect(result.warnings).toContainEqual({
      code: "estimated_timing_used",
      count: 1,
    });
  });

  it("requires both repetition thresholds after NFKC/case/punctuation folding", () => {
    expect(assess(repeatedSegments(7, 15_000)).valid).toBe(true);
    expect(assess(repeatedSegments(8, 14_999)).valid).toBe(true);

    const degenerate = assess(repeatedSegments(8, 15_000));
    expect(degenerate.valid).toBe(false);
    expect(degenerate.issues).toContain("degenerate_repetition");
    expect(degenerate.longestConsecutiveRepeatCueCount).toBe(8);
    expect(degenerate.longestConsecutiveRepeatSpanMs).toBe(15_000);
    expect(degenerate.normalizedUniqueTextCount).toBe(1);
  });

  it("measures repeated decoder runs by PRE-004 wall-clock span including gaps", () => {
    const below = assess(gappedRepeatedSegments(8, 14_999));
    expect(below.valid).toBe(true);
    expect(below.longestConsecutiveRepeatSpanMs).toBe(14_999);

    const degenerate = assess(gappedRepeatedSegments(8, 15_000));
    expect(degenerate.valid).toBe(false);
    expect(degenerate.issues).toContain("degenerate_repetition");
    expect(degenerate.longestConsecutiveRepeatSpanMs).toBe(15_000);
    expect(assess(gappedRepeatedSegments(7, 15_000)).valid).toBe(true);
  });

  it("does not hide a degenerate run behind a later run with more short cues", () => {
    const qualifying = gappedRepeatedSegments(8, 15_000);
    const later = gappedRepeatedSegments(9, 1_000).map((segment, index) => ({
      ...segment,
      id: index + qualifying.length,
      startMs: segment.startMs + 16_000,
      endMs: segment.endMs + 16_000,
      text: "different loop",
    }));
    const assessment = assess([...qualifying, ...later]);
    expect(assessment.valid).toBe(false);
    expect(assessment.issues).toContain("degenerate_repetition");
  });

  it("accepts exactly 100 ms of negative head rounding and rejects 101 ms", () => {
    expect(assess([rawSegment(-100, 100, "head")]).valid).toBe(true);
    const outside = assess([rawSegment(-101, 100, "head")]);
    expect(outside.valid).toBe(false);
    expect(outside.issues).toContain("out_of_window");
  });

  it("requires full-duration, text-consistent evidence before accepting no speech", () => {
    const window = oneWindow();
    const policy = policyFrom();
    const zeroDuration = assessLocalSubtitleRawWindow({
      window,
      result: serverResult([], 0),
      policy,
    });
    expect(zeroDuration.contractValid).toBe(false);

    const verified = assessLocalSubtitleRawWindow({
      window,
      result: serverResult([], 30_000),
      policy,
    });
    expect(verified).toMatchObject({
      valid: true,
      outcome: "no_speech",
      outcomeEvidence: "empty_full_duration_server_response",
    });

    for (const result of [
      serverResult([], 30_000, "unsegmented speech"),
      serverResult([rawSegment(0, 1_000, "speech")], 30_000, ""),
    ]) {
      expect(
        assessLocalSubtitleRawWindow({ window, result, policy }).contractValid,
      ).toBe(false);
    }
  });

  it("binds the segment-only word timeline status to the frozen VAD policy", () => {
    const window = oneWindow();
    const segment = rawSegment(1_000, 2_000, "speech");
    expect(
      assessLocalSubtitleRawWindow({
        window,
        result: serverResult([segment], 30_000, undefined, "not_requested"),
        policy: policyFrom(),
      }).contractValid,
    ).toBe(false);
    expect(
      assessLocalSubtitleRawWindow({
        window,
        result: serverResult([segment], 30_000, undefined, "not_requested"),
        policy: policyWithVad(false),
      }).contractValid,
    ).toBe(true);
  });

  it("keeps partial blank segments but classifies an all-blank window as no speech", () => {
    const partial = assess([
      rawSegment(0, 500, " \r\n ", 0),
      rawSegment(500, 1_500, "spoken", 1),
    ]);
    expect(partial.valid).toBe(true);
    expect(partial.outcome).toBe("speech");
    expect(partial.emptyTextSegmentCount).toBe(1);

    const empty = assess([
      rawSegment(0, 500, " \t ", 0),
      rawSegment(500, 1_000, "\r\n", 1),
    ]);
    expect(empty.valid).toBe(true);
    expect(empty.outcome).toBe("no_speech");
  });

  it("classifies unsafe upstream text as a contract failure without echoing it", () => {
    const window = oneWindow();
    const attempt = leaf(window, [rawSegment(0, 1_000, "secret\u0000text")]);
    const assessment = assessLocalSubtitleRawWindow({
      window,
      result: attempt.response.result,
      policy: policyFrom(),
    });
    const decision = decideLocalSubtitleWindowRetry({
      attempt,
      assessment,
      policy: policyFrom(),
    });

    expect(assessment.contractValid).toBe(false);
    expect(decision).toMatchObject({ action: "fail", reason: "contract_invalid" });
    expect(JSON.stringify({ assessment, decision })).not.toContain("secret");
  });

  it.each(["bad\u0085text", "bad\ud800text", "bad\ud800", "bad\udc00text"])(
    "rejects C1 controls and unpaired surrogates as invalid upstream contracts",
    (text) => {
      const window = oneWindow();
      const assessment = assessLocalSubtitleRawWindow({
        window,
        result: serverResult([rawSegment(0, 1_000, text)], 30_000),
        policy: policyFrom(),
      });

      expect(assessment).toMatchObject({
        valid: false,
        contractValid: false,
        issues: ["invalid_contract"],
      });
    },
  );
});

describe("bounded window retry decisions", () => {
  it("returns a deterministic smaller-window policy without doing I/O", () => {
    const window = oneWindow();
    const policy = policyFrom();
    const attempt = leaf(window, repeatedSegments(8, 15_000));
    const assessment = assessLocalSubtitleRawWindow({
      window,
      result: attempt.response.result,
      policy,
    });

    const decision = decideLocalSubtitleWindowRetry({ attempt, assessment, policy });
    expect(decision).toMatchObject({
      action: "split",
      reason: "degenerate_repetition",
      nextDepth: 1,
      splitPolicy: { windowMs: 16_000, overlapMs: 2_000 },
    });
    expect(decision.action === "split" && decision.children).toHaveLength(2);
  });

  it("fails closed when retry depth is exhausted or a window is unsplittable", () => {
    const policy = policyFrom();
    const exhausted = {
      ...oneWindow(),
      windowKey: "w000000.c000.c000.c000",
      rootWindowKey: "w000000",
      parentWindowKey: "w000000.c000.c000",
      retryDepth: 3,
    };
    const exhaustedAttempt = leaf(exhausted, repeatedSegments(8, 15_000));
    const exhaustedAssessment = assessLocalSubtitleRawWindow({
      window: exhausted,
      result: exhaustedAttempt.response.result,
      policy,
    });
    expect(
      decideLocalSubtitleWindowRetry({
        attempt: exhaustedAttempt,
        assessment: exhaustedAssessment,
        policy,
      }),
    ).toMatchObject({ action: "fail", reason: "retry_exhausted" });

    const short = makeWindow({
      key: "short",
      startMs: 0,
      endMs: 5_000,
      coreStartMs: 0,
      coreEndMs: 5_000,
    });
    const shortAssessment = assessLocalSubtitleRawWindow({
      window: short,
      result: serverResult([rawSegment(1_000, 1_000, "zero")], 5_000),
      policy,
    });
    const shortAttempt = leaf(short, [rawSegment(1_000, 1_000, "zero")]);
    expect(
      decideLocalSubtitleWindowRetry({
        attempt: shortAttempt,
        assessment: shortAssessment,
        policy,
      }),
    ).toMatchObject({ action: "fail", reason: "unsplittable" });
  });

  it("preserves stable lineage and applies retry threshold boundaries", () => {
    const policy = policyFrom();
    const evaluate = (
      durationMs: number,
      options: { readonly retryDepth?: number } = {},
    ) => {
      const root = makeWindow({
        key: `short-${durationMs}`,
        startMs: 0,
        endMs: durationMs,
        coreStartMs: 0,
        coreEndMs: durationMs,
      });
      const window =
        options.retryDepth === undefined
          ? root
          : {
              ...root,
              windowKey: `${root.windowKey}.c000.c000`,
              rootWindowKey: root.windowKey,
              parentWindowKey: `${root.windowKey}.c000`,
              retryDepth: options.retryDepth,
            };
      const attempt = leaf(window, [rawSegment(100, 100, "invalid")], {
        windowAttempt: 13,
        processEpoch: 7,
        requestGeneration: 9,
      });
      const assessment = assessLocalSubtitleRawWindow({
        window,
        result: attempt.response.result,
        policy,
      });
      return decideLocalSubtitleWindowRetry({ attempt, assessment, policy });
    };

    expect(evaluate(5_000)).toMatchObject({
      action: "fail",
      reason: "unsplittable",
    });
    expect(evaluate(5_001)).toMatchObject({
      action: "split",
      splitPolicy: { windowMs: 4_000, overlapMs: 1_250 },
      retryTarget: {
        rootPlanId: "plan-001",
        rootWindowKey: "short-5001",
        windowKey: "short-5001",
        windowAttempt: 13,
        processEpoch: 7,
        requestGeneration: 9,
      },
    });
    expect(evaluate(8_001)).toMatchObject({
      action: "split",
      splitPolicy: { overlapMs: 2_000 },
    });
    expect(evaluate(8_001, { retryDepth: 2 })).toMatchObject({
      action: "split",
      nextDepth: 3,
    });
  });

  it("validates exact retry children when the owned midpoint falls on half a millisecond", () => {
    const durationMs = 5_004;
    const policy = policyFrom({ maxCueDurationMs: 15_000 });
    const root = rootPlan(durationMs, policy).windows[0]!;
    const failed = leaf(root, [rawSegment(100, 100, "invalid")], {
      windowAttempt: 1,
      processEpoch: 1,
      requestGeneration: 1,
    });
    const assessment = assessLocalSubtitleRawWindow({
      window: root,
      result: failed.response.result,
      policy,
    });
    const decision = decideLocalSubtitleWindowRetry({
      attempt: failed,
      assessment,
      policy,
    });

    expect(decision).toMatchObject({
      action: "split",
      splitPolicy: { windowMs: 4_000, overlapMs: 1_251 },
    });
    if (decision.action !== "split") throw new Error("Expected retry split.");
    expect(decision.children[0].coreEndFrame % FRAMES_PER_MILLISECOND).toBe(8);
    expect(decision.children[0].coreEndMs).toBe(3_375);
    expect(decision.children[1].coreStartMs).toBe(3_375);

    const children = decision.children.map((window, index) => {
      const startMs = window.coreStartMs - window.startMs + 100;
      return leaf(window, [rawSegment(startMs, startMs + 500, `child-${index}!`)], {
        windowAttempt: index + 2,
        processEpoch: 2,
        requestGeneration: index + 2,
      });
    });
    const result = process({
      durationMs,
      policy,
      leaves: [failed, ...children],
    });
    expect(result.report).toMatchObject({
      attemptedWindowCount: 3,
      acceptedLeafWindowCount: 2,
      retryReplacementCount: 1,
      windowExecutionCoverage: 1,
    });
  });
});

describe("window attempt lineage and exact retry replacement", () => {
  it("accepts an exact retry graph and remains deterministic when attempts shuffle", () => {
    const { policy, attempts } = buildRetryAttemptGraph(0);
    const forward = process({ durationMs: 30_000, policy, leaves: attempts });
    const shuffled = process({
      durationMs: 30_000,
      policy,
      leaves: [attempts[2]!, attempts[0]!, attempts[1]!],
    });

    expect(shuffled).toEqual(forward);
    expect(forward.report).toMatchObject({
      attemptedWindowCount: 3,
      acceptedLeafWindowCount: 2,
      retryReplacementCount: 1,
      processEpochCount: 2,
      maximumRetryDepth: 1,
      windowExecutionCoverage: 1,
    });
  });

  it("accepts recursive exact replacements and rejects an exhausted depth-3 leaf", () => {
    const recursive = buildRetryAttemptGraph(1);
    const result = process({
      durationMs: 30_000,
      policy: recursive.policy,
      leaves: recursive.attempts,
    });
    expect(result.report).toMatchObject({
      attemptedWindowCount: 5,
      acceptedLeafWindowCount: 3,
      retryReplacementCount: 2,
      maximumRetryDepth: 2,
    });

    const exhausted = buildRetryAttemptGraph(3);
    const forward = capturePostProcessorError(() =>
      process({
        durationMs: 30_000,
        policy: exhausted.policy,
        leaves: exhausted.attempts,
      }),
    );
    const reversed = capturePostProcessorError(() =>
      process({
        durationMs: 30_000,
        policy: exhausted.policy,
        leaves: [...exhausted.attempts].reverse(),
      }),
    );
    expect(forward).toMatchObject({
      code: "transcript_quality_failed",
      localSubtitleCode: "transcript_quality_failed",
      stage: "window",
      details: {
        reason: "retry_exhausted",
        retryDepth: 3,
        processEpoch: expect.any(Number),
        requestGeneration: expect.any(Number),
      },
    });
    expect(reversed.details).toEqual(forward.details);
  });

  it("rejects missing, extra, or geometrically forged retry children", () => {
    const { policy, attempts } = buildRetryAttemptGraph(0);
    const missing = attempts.slice(0, 2);
    const extraWindow = {
      ...attempts[1]!.window,
      windowKey: `${attempts[0]!.window.windowKey}.c999`,
      parentWindowKey: attempts[0]!.window.windowKey,
    };
    const extra = [
      ...attempts,
      leaf(extraWindow, [rawSegment(100, 500, "extra!")], {
        windowAttempt: 99,
        processEpoch: 99,
        requestGeneration: 99,
      }),
    ];
    const forged = structuredClone(attempts);
    forged[1] = {
      ...forged[1]!,
      window: {
        ...forged[1]!.window,
        startFrame: forged[1]!.window.startFrame + FRAMES_PER_MILLISECOND,
        startMs: forged[1]!.window.startMs + 1,
      },
    };

    for (const candidate of [missing, extra, forged]) {
      const error = capturePostProcessorError(() =>
        process({ durationMs: 30_000, policy, leaves: candidate }),
      );
      expect(error).toMatchObject({
        code: "invalid_configuration",
        localSubtitleCode: "runtime_protocol_mismatch",
        stage: "coverage",
      });
    }
  });

  it("rejects duplicate attempt ids and copied Supervisor response generations", () => {
    const [first, second] = boundaryPrefixLeaves();
    const duplicateAttempt = {
      ...second,
      windowAttempt: first!.windowAttempt,
    };
    const copiedResponse = {
      ...second,
      requestGeneration: first!.requestGeneration,
      response: first!.response,
    };

    const attemptError = capturePostProcessorError(() =>
      process({ durationMs: 55_000, leaves: [first!, duplicateAttempt] }),
    );
    expect(attemptError.details?.reason).toBe("duplicate_window_attempt_number");

    const generationError = capturePostProcessorError(() =>
      process({ durationMs: 55_000, leaves: [first!, copiedResponse] }),
    );
    expect(generationError.details?.reason).toBe("duplicate_execution_generation");
  });

  it("rejects swapped same-duration sibling responses before timeline projection", () => {
    const { policy, attempts } = buildRetryAttemptGraph(0);
    const swapped = structuredClone(attempts);
    const leftResponse = swapped[1]!.response;
    swapped[1]!.response = swapped[2]!.response;
    swapped[2]!.response = leftResponse;

    const error = capturePostProcessorError(() =>
      process({ durationMs: 30_000, policy, leaves: swapped }),
    );
    expect(error).toMatchObject({
      code: "invalid_configuration",
      localSubtitleCode: "runtime_protocol_mismatch",
      stage: "coverage",
      details: { reason: "window_attempt_identity_invalid" },
    });
  });

  it("rejects mixed plans, orphan parents, and children attached to an accepted parent", () => {
    const acceptedRoot = leaf(oneWindow(), [rawSegment(1_000, 2_000, "root!")]);
    const splitPolicy = { windowMs: 16_000, overlapMs: 2_000 } as const;
    const children = planLocalSubtitleRetryChildren({
      parent: acceptedRoot.window,
      splitPolicy,
      policy: policyFrom(),
    });
    const attachedChild = leaf(children[0], [rawSegment(100, 500, "child!")], {
      windowAttempt: 2,
      requestGeneration: 2,
    });
    expect(
      capturePostProcessorError(() =>
        process({ durationMs: 30_000, leaves: [acceptedRoot, attachedChild] }),
      ).details?.reason,
    ).toBe("accepted_attempt_has_children");

    const mixedPlan = structuredClone(acceptedRoot);
    mixedPlan.window = { ...mixedPlan.window, rootPlanId: "another-plan" };
    expect(
      capturePostProcessorError(() =>
        process({ durationMs: 30_000, leaves: [mixedPlan] }),
      ).details?.reason,
    ).toBe("attempt_outside_root_plan");

    const orphan = structuredClone(attachedChild);
    orphan.window = { ...orphan.window, parentWindowKey: "missing-parent" };
    expect(
      capturePostProcessorError(() =>
        process({ durationMs: 30_000, leaves: [acceptedRoot, orphan] }),
      ).details?.reason,
    ).toBe("child_lineage_invalid");
  });

  it("binds every normalized response task to the committed task mode", () => {
    const translated = leaf(oneWindow(), [rawSegment(1_000, 2_000, "hello!")], {
      task: "translate",
    });
    expect(
      capturePostProcessorError(() =>
        process({ durationMs: 30_000, leaves: [translated] }),
      ).details?.reason,
    ).toBe("attempt_task_mode_mismatch");

    const result = process({
      durationMs: 30_000,
      taskMode: "translate_to_english",
      leaves: [translated],
    });
    expect(result.transcript.segments[0]!.text).toBe("hello!");
  });
});

describe("owned-core merge and coverage", () => {
  it("is deterministic for unordered leaves and does not mutate input", () => {
    const policy = policyFrom({ maxCueDurationMs: 15_000 });
    const leaves = boundaryPrefixLeaves();
    const original = structuredClone(leaves);
    const forward = process({
      durationMs: 55_000,
      policy,
      leaves,
    });
    const reversed = process({
      durationMs: 55_000,
      policy,
      leaves: [...leaves].reverse(),
    });

    expect(reversed).toEqual(forward);
    expect(leaves).toEqual(original);
    expect(forward.report.trimmedBoundaryPrefixCount).toBe(1);
    expect(forward.report.windowExecutionCoverage).toBe(1);
    expect(forward.report.invalidRawTimelineSegmentCount).toBe(0);
    expect(forward.report.overlongRawSegmentCount).toBe(0);
    expect(
      forward.transcript.segments.map((segment) => segment.text).join(""),
    ).toBe("そういえばさお風呂どうする?");
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.transcript)).toBe(true);
    expect(Object.isFrozen(forward.transcript.segments)).toBe(true);
    expect(Object.isFrozen(forward.report)).toBe(true);
  });

  it("deduplicates only adjacent cross-window observations", () => {
    const [firstWindow, secondWindow] = twoWindows();
    const duplicated = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(26_000, 27_600, "repeat")]),
        leaf(secondWindow, [rawSegment(2_400, 4_000, "REPEAT!")]),
      ],
    });
    expect(duplicated.report.duplicateBoundarySegmentCount).toBe(1);
    expect(duplicated.transcript.segments).toHaveLength(1);

    const distant = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(1_000, 2_000, "repeat")]),
        leaf(secondWindow, [rawSegment(5_000, 6_000, "repeat")]),
      ],
    });
    expect(distant.report.duplicateBoundarySegmentCount).toBe(0);
    expect(distant.transcript.segments).toHaveLength(2);

    const sameWindow = process({
      durationMs: 30_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(oneWindow(), [
          rawSegment(1_000, 2_000, "repeat", 0),
          rawSegment(3_000, 4_000, "repeat", 1),
        ]),
      ],
    });
    expect(sameWindow.transcript.segments).toHaveLength(2);
  });

  it("keeps equal adjacent text when raw observations do not overlap", () => {
    const [firstWindow, secondWindow] = twoWindows();
    const result = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(25_000, 27_400, "repeat!")]),
        leaf(secondWindow, [rawSegment(2_500, 4_000, "REPEAT!")]),
      ],
    });

    expect(result.report.duplicateBoundarySegmentCount).toBe(0);
    expect(result.transcript.segments).toHaveLength(2);
  });

  it("keeps a legal adjacent prefix when raw observations do not overlap", () => {
    const [firstWindow, secondWindow] = twoWindows();
    const result = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(26_000, 27_400, "谢谢!")]),
        leaf(secondWindow, [rawSegment(2_500, 4_000, "谢谢你")]),
      ],
    });

    expect(result.report.trimmedBoundaryPrefixCount).toBe(0);
    expect(result.transcript.segments.map((segment) => segment.text)).toContain(
      "谢谢你",
    );
  });

  it("does not drop both boundary observations when their midpoint ownership crosses", () => {
    const [firstWindow, secondWindow] = twoWindows();
    const result = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(26_800, 28_400, "boundary line!")]),
        leaf(secondWindow, [rawSegment(1_600, 3_200, "BOUNDARY LINE!")]),
      ],
    });

    expect(result.report.projectedSegmentCount).toBe(2);
    expect(result.report.duplicateBoundarySegmentCount).toBe(1);
    expect(result.transcript.segments).toHaveLength(1);
    expect(result.transcript.segments[0]!.text).toBe("boundary line!");
  });

  it.each([
    {
      label: "exact duplicate",
      left: "谢谢!",
      repeated: "谢谢!",
      next: "谢谢你",
    },
    {
      label: "empty prefix fragment",
      left: "どうもありがとう!",
      repeated: "ありがとう",
      next: "ありがとうね",
    },
  ])("advances provenance after absorbing an $label", ({ left, repeated, next }) => {
    const [firstWindow, secondWindow] = twoWindows();
    const result = process({
      durationMs: 55_000,
      policy: policyFrom({ maxCueDurationMs: 15_000 }),
      leaves: [
        leaf(firstWindow, [rawSegment(26_000, 28_100, left)]),
        leaf(secondWindow, [
          rawSegment(2_400, 3_000, repeated, 0),
          rawSegment(3_000, 4_000, next, 1),
        ]),
      ],
    });

    expect(result.transcript.segments.map((segment) => segment.text)).toContain(next);
  });

  it("applies exact boundary gap and CJK/Latin prefix thresholds", () => {
    expect(boundaryPrefixResult("test!", "test next", 500).report).toMatchObject({
      trimmedBoundaryPrefixCount: 1,
    });
    expect(boundaryPrefixResult("test!", "test next", 501).report).toMatchObject({
      trimmedBoundaryPrefixCount: 0,
    });
    expect(boundaryPrefixResult("甲!", "甲后", 0).report).toMatchObject({
      trimmedBoundaryPrefixCount: 0,
    });
    expect(boundaryPrefixResult("甲乙!", "甲乙后", 0).report).toMatchObject({
      trimmedBoundaryPrefixCount: 1,
    });
    expect(boundaryPrefixResult("abc!", "abc next", 0).report).toMatchObject({
      trimmedBoundaryPrefixCount: 0,
    });
    expect(boundaryPrefixResult("test!", "test next", 0).report).toMatchObject({
      trimmedBoundaryPrefixCount: 1,
    });
  });

  it("trims NFKC expansions only at complete source-grapheme boundaries", () => {
    const partial = boundaryPrefixResult("アパ!", "㌀へ", 0);
    expect(partial.report.trimmedBoundaryPrefixCount).toBe(0);
    expect(partial.transcript.segments.map((segment) => segment.text)).toContain(
      "㌀へ",
    );

    const complete = boundaryPrefixResult("アパート!", "㌀へ", 0);
    expect(complete.report.trimmedBoundaryPrefixCount).toBe(1);
    expect(complete.transcript.segments.map((segment) => segment.text)).toContain(
      "へ",
    );
    expect(JSON.stringify(complete.transcript)).not.toContain("㌀");
  });

  it("preserves boundary symbols instead of using the raw-loop fingerprint destructively", () => {
    const result = boundaryPrefixResult("music ♪!", "music!", 0);
    expect(result.report.duplicateBoundarySegmentCount).toBe(0);
    expect(result.report.trimmedBoundaryPrefixCount).toBe(0);
    expect(result.transcript.segments.map((segment) => segment.text)).toContain(
      "music ♪!",
    );
  });

  it.each([
    {
      label: "one-frame gap",
      mutate: (leaves: LocalSubtitlePostProcessingWindowAttempt[]) => {
        leaves[1] = {
          ...leaves[1]!,
          window: {
            ...leaves[1]!.window,
            coreStartFrame: leaves[1]!.window.coreStartFrame + 1,
          },
        };
      },
    },
    {
      label: "one-frame overlap",
      mutate: (leaves: LocalSubtitlePostProcessingWindowAttempt[]) => {
        leaves[1] = {
          ...leaves[1]!,
          window: {
            ...leaves[1]!.window,
            coreStartFrame: leaves[1]!.window.coreStartFrame - 1,
          },
        };
      },
    },
    {
      label: "duplicate leaf key",
      mutate: (leaves: LocalSubtitlePostProcessingWindowAttempt[]) => {
        leaves[1] = {
          ...leaves[1]!,
          window: {
            ...leaves[1]!.window,
            windowKey: leaves[0]!.window.windowKey,
          },
        };
      },
    },
  ])("rejects $label before merge", ({ mutate }) => {
    const leaves = boundaryPrefixLeaves();
    mutate(leaves);
    expectPostProcessorCode(
      () => process({ durationMs: 55_000, leaves }),
      "invalid_configuration",
      "coverage",
    );
  });

  it("rejects a missing media tail even when every supplied window passed", () => {
    const leaves = boundaryPrefixLeaves().slice(0, 1);
    const error = capturePostProcessorError(() =>
      process({ durationMs: 55_000, leaves }),
    );
    expect(error).toMatchObject({
      code: "invalid_configuration",
      stage: "coverage",
      details: {
        reason: "root_attempt_missing",
        rootPlanId: "plan-001",
        rootWindowKey: "w000001",
        windowKey: "w000001",
      },
    });
    expect(error.details).not.toHaveProperty("windowAttempt");
    expect(error.details).not.toHaveProperty("processEpoch");
    expect(error.details).not.toHaveProperty("requestGeneration");
  });

  it("rejects a frame/millisecond descriptor mismatch before projection", () => {
    const leaves = boundaryPrefixLeaves();
    leaves[1] = {
      ...leaves[1]!,
      window: {
        ...leaves[1]!.window,
        startFrame: leaves[1]!.window.startFrame + 1,
      },
    };
    expectPostProcessorCode(
      () => process({ durationMs: 55_000, leaves }),
      "invalid_configuration",
      "coverage",
    );
  });

  it("clamps only the 100 ms source boundary tolerance and records a warning", () => {
    const result = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [rawSegment(29_000, 30_100, "tail")]),
      ],
    });
    expect(result.transcript.segments[0]).toMatchObject({
      startMs: 29_000,
      endMs: 30_000,
      text: "tail",
    });
    expect(result.warnings).toContainEqual({
      code: "timeline_boundary_clamped",
      count: 1,
    });

    expectPostProcessorCode(
      () =>
        process({
          durationMs: 30_000,
          leaves: [
            leaf(oneWindow(), [rawSegment(29_000, 30_101, "outside")]),
          ],
        }),
      "invalid_configuration",
      "coverage",
    );
  });

  it.each([
    { startMs: -100, endMs: 0, label: "head" },
    { startMs: 30_000, endMs: 30_100, label: "tail" },
  ])("rejects a non-empty $label segment erased by source clamping", ({ startMs, endMs }) => {
    const error = capturePostProcessorError(() =>
      process({
        durationMs: 30_000,
        leaves: [
          leaf(oneWindow(), [rawSegment(startMs, endMs, "boundary speech")]),
        ],
      }),
    );
    expect(error).toMatchObject({
      code: "transcript_quality_failed",
      localSubtitleCode: "transcript_quality_failed",
      stage: "merge",
      details: { reason: "timeline_boundary_clamp_non_positive" },
    });
  });

  it("repairs exactly 100 ms of raw overlap and retries at 101 ms", () => {
    const repaired = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 1_000, "first!", 0),
          rawSegment(900, 1_500, "second.", 1),
        ]),
      ],
    });
    expect(repaired.report.timelineOverlapAdjustmentCount).toBe(1);
    expect(repaired.transcript.segments[0]!.endMs).toBe(
      repaired.transcript.segments[1]!.startMs,
    );

    expectPostProcessorCode(
      () =>
        process({
          durationMs: 30_000,
          leaves: [
            leaf(oneWindow(), [
              rawSegment(0, 1_000, "first!", 0),
              rawSegment(899, 1_500, "second.", 1),
            ]),
          ],
        }),
      "invalid_configuration",
      "coverage",
    );
  });

  it("uses the mapped segment after the trusted parser discards VAD words", () => {
    const parsed = parseLocalSubtitleServerVerboseJson(
      {
        task: "transcribe",
        language: "japanese",
        duration: 30,
        text: "mapped segment",
        segments: [
          {
            id: 0,
            start: 13.7,
            end: 17.28,
            text: "mapped segment",
            words: [
              {
                word: "compressed",
                start: 0,
                end: 0.44,
                probability: 0.9,
              },
            ],
            temperature: 0,
            avg_logprob: -0.25,
            no_speech_prob: 0.01,
          },
        ],
      },
      { taskMode: "transcribe", vadEnabled: true },
    );
    expect(parsed.segments[0]).not.toHaveProperty("words");
    expect(parsed.wordTimelineStatus).toBe("discarded_vad_compressed_timeline");
    const result = process({
      durationMs: 30_000,
      leaves: [leafFromResult(oneWindow(), parsed)],
    });

    expect(result.transcript.segments[0]).toMatchObject({
      startMs: 13_700,
      endMs: 17_280,
      text: "mapped segment",
    });
    expect(result.transcript.segments[0]).not.toHaveProperty("words");
  });
});

describe("canonical subtitle shaping", () => {
  it("drops punctuation fragments but preserves legal symbol-only Unicode cues", () => {
    const result = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 100, "...!?", 0),
          rawSegment(1_000, 1_500, "♪", 1),
          rawSegment(2_000, 2_500, "👩‍💻", 2),
        ]),
      ],
    });

    expect(result.report.droppedBoundaryFragmentCount).toBe(1);
    expect(result.transcript.segments.map((segment) => segment.text)).toEqual([
      "♪",
      "👩‍💻",
    ]);
  });

  it("normalizes CRLF/CR, splits CJK and Latin at grapheme-safe boundaries, and marks estimates", () => {
    const policy = policyFrom({
      maxCueDurationMs: 3_000,
      maxCueChars: 20,
      maxLineChars: 10,
    });
    const sourceText =
      "第一句很长，需要切分。\r\nSecond sentence is also long! 👩‍💻é";
    const result = process({
      durationMs: 30_000,
      policy,
      leaves: [
        leaf(oneWindow(), [rawSegment(1_000, 10_000, sourceText)]),
      ],
    });

    expect(result.transcript.segments.length).toBeGreaterThanOrEqual(3);
    for (const segment of result.transcript.segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(3_000);
      expect(segment.estimatedTiming).toBe(true);
      expect(segment.text).not.toMatch(/\r/u);
      expect(segment.text.split("\n").length).toBeLessThanOrEqual(4);
      expect(segment.text.split("\n").every((line) => line.length <= 10)).toBe(
        true,
      );
    }
    expect(
      compactText(
        result.transcript.segments.map((segment) => segment.text).join(""),
      ),
    ).toBe(compactText(sourceText));
    expect(result.warnings).toContainEqual({
      code: "estimated_timing_used",
      count: result.transcript.segments.length,
    });
    expect(validateLocalSubtitleTranscript(result.transcript).ok).toBe(true);
  });

  it("normalizes Unicode line and paragraph separators without leaking them to canonical text", () => {
    const sourceText = "first\u2028second\u2029third";
    const result = process({
      durationMs: 30_000,
      leaves: [leaf(oneWindow(), [rawSegment(1_000, 2_000, sourceText)])],
    });
    const text = result.transcript.segments[0]!.text;

    expect(text).not.toMatch(/[\r\u2028\u2029]/u);
    expect(compactText(text)).toBe("firstsecondthird");
    expect(validateLocalSubtitleTranscript(result.transcript).ok).toBe(true);
  });

  it("merges nearby continuation cues but keeps sentence-final cues separate", () => {
    const merged = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 1_000, "Hello", 0),
          rawSegment(1_200, 2_000, "world.", 1),
        ]),
      ],
    });
    expect(merged.transcript.segments).toHaveLength(1);
    expect(merged.transcript.segments[0]!.text).toBe("Hello world.");
    expect(merged.report.shortCueMergeCount).toBe(1);

    const separate = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 1_000, "Done!", 0),
          rawSegment(1_200, 2_000, "Next.", 1),
        ]),
      ],
    });
    expect(separate.transcript.segments).toHaveLength(2);
  });

  it("uses the versioned 300 ms short-cue merge boundary", () => {
    const atLimit = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 1_000, "Hello", 0),
          rawSegment(1_300, 2_000, "world.", 1),
        ]),
      ],
    });
    const outside = process({
      durationMs: 30_000,
      leaves: [
        leaf(oneWindow(), [
          rawSegment(0, 1_000, "Hello", 0),
          rawSegment(1_301, 2_000, "world.", 1),
        ]),
      ],
    });
    expect(atLimit.report.shortCueMergeCount).toBe(1);
    expect(atLimit.transcript.segments).toHaveLength(1);
    expect(outside.report.shortCueMergeCount).toBe(0);
    expect(outside.transcript.segments).toHaveLength(2);
  });

  it("does not split emoji ZWJ or combining grapheme sequences", () => {
    const policy = policyFrom({
      maxCueDurationMs: 3_000,
      maxCueChars: 20,
      maxLineChars: 10,
    });
    const text = "👩‍💻é👩‍💻é👩‍💻é👩‍💻é";
    const result = process({
      durationMs: 30_000,
      policy,
      leaves: [leaf(oneWindow(), [rawSegment(0, 6_000, text)])],
    });

    expect(
      result.transcript.segments
        .map((segment) => segment.text.replaceAll("\n", ""))
        .join(""),
    ).toBe(text);
    expect(JSON.stringify(result.transcript)).not.toContain("�");
  });

  it("keeps variation selectors and regional-indicator flags intact", () => {
    const policy = policyFrom({
      maxCueDurationMs: 2_000,
      maxCueChars: 20,
      maxLineChars: 10,
    });
    const text = "✈️🇨🇳✈️🇨🇳✈️🇨🇳✈️🇨🇳";
    const result = process({
      durationMs: 30_000,
      policy,
      leaves: [leaf(oneWindow(), [rawSegment(0, 6_000, text)])],
    });
    expect(
      result.transcript.segments
        .map((segment) => segment.text.replaceAll("\n", ""))
        .join(""),
    ).toBe(text);
    expect(JSON.stringify(result.transcript)).not.toContain("�");
  });

  it("maps all-blank accepted leaves to no_speech_detected", () => {
    expectPostProcessorCode(
      () =>
        process({
          durationMs: 30_000,
          leaves: [
            leaf(oneWindow(), [
              rawSegment(0, 500, " ", 0),
              rawSegment(500, 1_000, "\r\n", 1),
            ]),
          ],
        }),
      "no_speech_detected",
      "canonical",
    );
  });

  it("keeps rich reports private and errors free of transcript text and paths", () => {
    const secret = "never-log-this-transcript";
    let error: LocalSubtitlePostProcessorError | undefined;
    try {
      process({
        durationMs: 30_000,
        leaves: [
          leaf(
            oneWindow(),
            Array.from({ length: 8 }, (_, index) =>
              rawSegment(index * 2_000, (index + 1) * 2_000, secret, index),
            ),
          ),
        ],
      });
    } catch (caught) {
      if (caught instanceof LocalSubtitlePostProcessorError) error = caught;
    }

    expect(error).toBeDefined();
    expect(JSON.stringify(error?.details)).not.toContain(secret);
    expect(JSON.stringify(error?.details)).not.toContain("/private/");
    expect(error?.details?.assessment).toMatchObject({
      longestConsecutiveRepeatCueCount: 8,
    });
  });

  it("rejects media beyond the canonical duration limit before processing", () => {
    expectPostProcessorCode(
      () =>
        process({
          durationMs: LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1,
          leaves: [leaf(oneWindow(), [rawSegment(0, 1_000, "speech")])],
        }),
      "limit_exceeded",
      "coverage",
    );
  });

  it.each([59_999, 3_600_001, LOCAL_SUBTITLE_LIMITS.maxDurationMs])(
    "accepts canonical source duration %i ms",
    (durationMs) => {
      const policy = policyFrom({ maxCueDurationMs: 15_000 });
      const plan = rootPlan(durationMs, policy);
      const leaves = plan.windows.map((window, index) =>
        index === 0
          ? leaf(window, [rawSegment(0, Math.min(1_000, window.endMs), "speech!")])
          : leaf(window, []),
      );
      const result = process({ durationMs, policy, leaves });
      expect(result.transcript.source.durationMs).toBe(durationMs);
      expect(result.report.acceptedLeafWindowCount).toBe(plan.windows.length);
    },
  );

  it("rejects zero duration and structurally limits each planned window to 30 seconds", () => {
    const policy = policyFrom();
    const zeroRequest: LocalSubtitlePostProcessingRequest = {
      source: {
        displayName: "empty.wav",
        durationMs: 0,
        totalFrames: 0,
        sampleRateHz: 16_000,
      },
      model: MODEL,
      taskMode: "transcribe",
      policy,
      rootPlan: { schemaVersion: 1, rootPlanId: "plan-001", windows: [] },
      attempts: [],
    };
    expectPostProcessorCode(
      () => postProcessLocalSubtitleTranscript(zeroRequest),
      "invalid_configuration",
      "canonical",
    );

    const planned = rootPlan(30_001, policy);
    expect(planned.windows).toHaveLength(2);
    expect(
      planned.windows.every(
        (window) => window.endMs - window.startMs <= 30_000,
      ),
    ).toBe(true);
    expect(() =>
      assessLocalSubtitleRawWindow({
        window: makeWindow({
          key: "too-long",
          startMs: 0,
          endMs: 30_001,
          coreStartMs: 0,
          coreEndMs: 30_001,
        }),
        result: serverResult([], 30_001),
        policy,
      }),
    ).toThrow(LocalSubtitlePostProcessorError);
  });

  it("caps root planning by rounded canonical duration before allocating windows", () => {
    const policy = policyFrom();
    const maximum = planLocalSubtitleRootWindows({
      rootPlanId: "plan-max",
      totalFrames: frames(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
      policy,
    });
    expect(maximum.windows.at(-1)?.endFrame).toBe(
      frames(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    );

    const error = capturePostProcessorError(() =>
      planLocalSubtitleRootWindows({
        rootPlanId: "plan-over-limit",
        totalFrames: frames(LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1),
        policy,
      }),
    );
    expect(error).toMatchObject({
      code: "limit_exceeded",
      localSubtitleCode: "limit_exceeded",
      stage: "coverage",
      details: {
        observed: LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1,
        limit: LOCAL_SUBTITLE_LIMITS.maxDurationMs,
      },
    });
  });

  it("keeps exact PCM frame authority when the media tail is not millisecond-aligned", () => {
    const policy = policyFrom();
    const totalFrames = 16_001;
    const plan = planLocalSubtitleRootWindows({
      rootPlanId: "plan-001",
      totalFrames,
      policy,
    });
    const request: LocalSubtitlePostProcessingRequest = {
      source: {
        displayName: "fractional-tail.wav",
        durationMs: 1_000,
        totalFrames,
        sampleRateHz: 16_000,
      },
      model: MODEL,
      taskMode: "transcribe",
      policy,
      rootPlan: plan,
      attempts: [
        leaf(plan.windows[0]!, [rawSegment(0, 500, "speech!")]),
      ],
    };
    const result = postProcessLocalSubtitleTranscript(request);
    expect(result.transcript.source.durationMs).toBe(1_000);
    expect(plan.windows[0]!.endFrame).toBe(totalFrames);
  });
});

function assess(segments: readonly LocalSubtitleServerRawSegment[]) {
  return assessLocalSubtitleRawWindow({
    window: oneWindow(),
    result: serverResult(segments, 30_000),
    policy: policyFrom(),
  });
}

function process(options: {
  readonly durationMs: number;
  readonly leaves: readonly LocalSubtitlePostProcessingWindowAttempt[];
  readonly policy?: LocalSubtitlePostProcessPolicy;
  readonly taskMode?: "transcribe" | "translate_to_english";
}) {
  const policy = options.policy ?? policyFrom();
  const request: LocalSubtitlePostProcessingRequest = {
    source: {
      displayName: "sample.wav",
      durationMs: options.durationMs,
      totalFrames: frames(options.durationMs),
      sampleRateHz: 16_000,
    },
    model: MODEL,
    taskMode: options.taskMode ?? "transcribe",
    detectedLanguage: "ja",
    languageProbability: 0.98,
    policy,
    rootPlan: rootPlan(options.durationMs, policy),
    attempts: options.leaves,
  };
  return postProcessLocalSubtitleTranscript(request);
}

function policyFrom(
  advanced: Partial<LocalSubtitleInferenceSnapshot["advanced"]> = {},
): LocalSubtitlePostProcessPolicy {
  return createSubtitlePostProcessPolicy(inferenceSnapshot(advanced));
}

function policyWithVad(enabled: boolean): LocalSubtitlePostProcessPolicy {
  const inference = structuredClone(inferenceSnapshot()) as MutableInferenceSnapshot;
  inference.vad.enabled = enabled;
  return createSubtitlePostProcessPolicy(inference);
}

function inferenceSnapshot(
  advanced: Partial<LocalSubtitleInferenceSnapshot["advanced"]> = {},
): LocalSubtitleInferenceSnapshot {
  return {
    advanced: {
      initialPrompt: advanced.initialPrompt,
      beamSize: 5,
      temperature: 0,
      vadMinSilenceMs: 500,
      maxCueDurationMs: advanced.maxCueDurationMs ?? 7_000,
      maxCueChars: advanced.maxCueChars ?? 84,
      maxLineChars: advanced.maxLineChars ?? 42,
    },
    vad: {
      enabled: true,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
      tokenTimestamps: false,
      timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
    },
    rawQualityGate: {
      maxSegmentDurationMs:
        LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
      repeatedCueThreshold:
        LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
      repeatedCoverageMs:
        LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
      maxRetryDepth:
        LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
    },
  };
}

function oneWindow(): LocalSubtitlePostProcessingWindow {
  return rootPlan(30_000).windows[0]!;
}

function twoWindows(): readonly [
  LocalSubtitlePostProcessingWindow,
  LocalSubtitlePostProcessingWindow,
] {
  const windows = rootPlan(55_000).windows;
  return [windows[0]!, windows[1]!];
}

function makeWindow(options: {
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly coreStartMs: number;
  readonly coreEndMs: number;
  readonly retryDepth?: number;
}): LocalSubtitlePostProcessingWindow {
  return {
    windowKey: options.key,
    rootPlanId: "plan-001",
    rootWindowKey: options.key,
    retryDepth: options.retryDepth ?? 0,
    startFrame: frames(options.startMs),
    endFrame: frames(options.endMs),
    coreStartFrame: frames(options.coreStartMs),
    coreEndFrame: frames(options.coreEndMs),
    startMs: options.startMs,
    endMs: options.endMs,
    coreStartMs: options.coreStartMs,
    coreEndMs: options.coreEndMs,
  };
}

function boundaryPrefixLeaves(): LocalSubtitlePostProcessingWindowAttempt[] {
  const [first, second] = twoWindows();
  return [
    leaf(first, [rawSegment(20_000, 28_000, "そういえばさ")]),
    leaf(second, [
      rawSegment(2_400, 8_000, "えばさ、お風呂どうする?"),
    ]),
  ];
}

function boundaryPrefixResult(leftText: string, rightText: string, gapMs: number) {
  const [first, second] = twoWindows();
  const leftEndMs = 27_500 - gapMs;
  const rightStartMs = leftEndMs - 100 - second.startMs;
  return process({
    durationMs: 55_000,
    policy: policyFrom({ maxCueDurationMs: 15_000 }),
    leaves: [
      leaf(first, [rawSegment(26_000, leftEndMs, leftText)]),
      leaf(second, [rawSegment(rightStartMs, 4_000, rightText)]),
    ],
  });
}

function leaf(
  window: LocalSubtitlePostProcessingWindow,
  segments: readonly LocalSubtitleServerRawSegment[],
  options: {
    readonly windowAttempt?: number;
    readonly processEpoch?: number;
    readonly requestGeneration?: number;
    readonly durationMs?: number;
    readonly text?: string;
    readonly task?: LocalSubtitleServerInferenceResult["task"];
    readonly wordTimelineStatus?: LocalSubtitleServerInferenceResult["wordTimelineStatus"];
  } = {},
): LocalSubtitlePostProcessingWindowAttempt {
  const windowAttempt = options.windowAttempt ?? defaultWindowAttempt(window.windowKey);
  return {
    window,
    windowAttempt,
    processEpoch: options.processEpoch ?? 1,
    requestGeneration: options.requestGeneration ?? windowAttempt,
    response: serverResponse(
      serverResult(
        segments,
        options.durationMs ?? window.endMs - window.startMs,
        options.text,
        options.wordTimelineStatus,
        options.task,
      ),
      options.requestGeneration ?? windowAttempt,
    ),
  };
}

function leafFromResult(
  window: LocalSubtitlePostProcessingWindow,
  result: LocalSubtitleServerInferenceResult,
  options: {
    readonly windowAttempt?: number;
    readonly processEpoch?: number;
    readonly requestGeneration?: number;
  } = {},
): LocalSubtitlePostProcessingWindowAttempt {
  const windowAttempt = options.windowAttempt ?? defaultWindowAttempt(window.windowKey);
  return {
    window,
    windowAttempt,
    processEpoch: options.processEpoch ?? 1,
    requestGeneration: options.requestGeneration ?? windowAttempt,
    response: serverResponse(
      result,
      options.requestGeneration ?? windowAttempt,
    ),
  };
}

function serverResponse(
  result: LocalSubtitleServerInferenceResult,
  requestGeneration: number,
): LocalSubtitleServerInferenceResponse {
  return {
    requestGeneration,
    sessionDisposition: "reusable",
    result,
  };
}

function serverResult(
  segments: readonly LocalSubtitleServerRawSegment[],
  durationMs: number,
  text?: string,
  wordTimelineStatus: LocalSubtitleServerInferenceResult["wordTimelineStatus"] =
    "discarded_vad_compressed_timeline",
  task: LocalSubtitleServerInferenceResult["task"] = "transcribe",
): LocalSubtitleServerInferenceResult {
  return {
    contractVersion: 1,
    task,
    language: "japanese",
    durationMs,
    text: text ?? segments.map((segment) => segment.text).join(" ").trim(),
    segments,
    wordTimelineStatus,
  };
}

function rootPlan(
  durationMs: number,
  policy = policyFrom(),
): LocalSubtitleRootWindowPlan {
  return planLocalSubtitleRootWindows({
    rootPlanId: "plan-001",
    totalFrames: frames(durationMs),
    policy,
  });
}

function defaultWindowAttempt(windowKey: string): number {
  const rootMatch = /^w(\d{6})$/u.exec(windowKey);
  if (rootMatch) return Number(rootMatch[1]) + 1;
  return (
    Array.from(windowKey).reduce(
      (hash, character) => (hash * 33 + character.codePointAt(0)!) % 1_000_000,
      0,
    ) + 10_000
  );
}

function rawSegment(
  startMs: number,
  endMs: number,
  text: string,
  id = 0,
): LocalSubtitleServerRawSegment {
  return {
    id,
    startMs,
    endMs,
    text,
    temperature: 0,
    averageLogProbability: -0.25,
    noSpeechProbability: 0.01,
  };
}

function repeatedSegments(
  cueCount: number,
  coverageMs: number,
): LocalSubtitleServerRawSegment[] {
  let startMs = 0;
  return Array.from({ length: cueCount }, (_, index) => {
    const endMs = Math.round(((index + 1) * coverageMs) / cueCount);
    const segment = rawSegment(
      startMs,
      endMs,
      index % 2 === 0 ? "ＬＯＯＰ！" : "loop",
      index,
    );
    startMs = endMs;
    return segment;
  });
}

function gappedRepeatedSegments(
  cueCount: number,
  spanMs: number,
): LocalSubtitleServerRawSegment[] {
  const cueDurationMs = 100;
  return Array.from({ length: cueCount }, (_, index) => {
    const startMs = Math.round(
      (index * (spanMs - cueDurationMs)) / Math.max(1, cueCount - 1),
    );
    return rawSegment(
      startMs,
      startMs + cueDurationMs,
      index % 2 === 0 ? "ＬＯＯＰ！" : "loop",
      index,
    );
  });
}

function buildRetryAttemptGraph(splitThroughDepth: number): {
  readonly policy: LocalSubtitlePostProcessPolicy;
  readonly attempts: LocalSubtitlePostProcessingWindowAttempt[];
} {
  const policy = policyFrom({ maxCueDurationMs: 15_000 });
  const attempts: LocalSubtitlePostProcessingWindowAttempt[] = [];
  let nextAttempt = 1;
  const createInvalid = (
    window: LocalSubtitlePostProcessingWindow,
  ): LocalSubtitlePostProcessingWindowAttempt =>
    leaf(window, [rawSegment(100, 100, "invalid")], {
      windowAttempt: nextAttempt,
      processEpoch: Math.ceil(nextAttempt / 2),
      requestGeneration: nextAttempt++,
    });
  const createValid = (
    window: LocalSubtitlePostProcessingWindow,
  ): LocalSubtitlePostProcessingWindowAttempt => {
    const coreStart = window.coreStartMs - window.startMs;
    const coreEnd = window.coreEndMs - window.startMs;
    const startMs = Math.min(coreEnd - 1, coreStart + 100);
    const endMs = Math.min(coreEnd, startMs + 500);
    return leaf(
      window,
      [rawSegment(startMs, endMs, `ok-${window.windowKey}!`)],
      {
        windowAttempt: nextAttempt,
        processEpoch: Math.ceil(nextAttempt / 2),
        requestGeneration: nextAttempt++,
      },
    );
  };

  let current = createInvalid(oneWindow());
  attempts.push(current);
  for (;;) {
    const assessment = assessLocalSubtitleRawWindow({
      window: current.window,
      result: current.response.result,
      policy,
    });
    const decision = decideLocalSubtitleWindowRetry({
      attempt: current,
      assessment,
      policy,
    });
    if (decision.action !== "split") break;
    const continueRetry = decision.children[0].retryDepth <= splitThroughDepth;
    const first = continueRetry
      ? createInvalid(decision.children[0])
      : createValid(decision.children[0]);
    const second = createValid(decision.children[1]);
    attempts.push(first, second);
    if (!continueRetry) break;
    current = first;
  }
  return { policy, attempts };
}

function capturePostProcessorError(operation: () => unknown): LocalSubtitlePostProcessorError {
  try {
    operation();
  } catch (error) {
    if (error instanceof LocalSubtitlePostProcessorError) return error;
    throw error;
  }
  throw new Error("Expected LocalSubtitlePostProcessorError.");
}

function compactText(value: string): string {
  return value.replace(/\s+/gu, "");
}

function frames(milliseconds: number): number {
  return milliseconds * FRAMES_PER_MILLISECOND;
}

function expectPostProcessorCode(
  operation: () => unknown,
  code: string,
  stage: string,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitlePostProcessorError);
    expect(error).toMatchObject({ code, stage });
    return;
  }
  throw new Error(`Expected ${code} at ${stage}.`);
}

type MutableInferenceSnapshot = {
  -readonly [K in keyof LocalSubtitleInferenceSnapshot]:
    LocalSubtitleInferenceSnapshot[K] extends object
      ? {
          -readonly [P in keyof LocalSubtitleInferenceSnapshot[K]]:
            LocalSubtitleInferenceSnapshot[K][P];
        }
      : LocalSubtitleInferenceSnapshot[K];
};
