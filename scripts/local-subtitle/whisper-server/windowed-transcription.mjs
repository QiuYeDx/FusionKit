import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { planPcmWindows, writePcmWindow } from "./pcm-windowing.mjs";
import {
  TranscriptQualityError,
  analyzeTranscriptSegments,
  mergeWindowTranscripts,
  normalizeTranscriptText,
} from "./transcript-quality.mjs";

export async function transcribePcmInWindows(options) {
  if (typeof options.transcribeFile !== "function") {
    throw new Error("Windowed transcription requires a transcribeFile callback.");
  }
  await mkdir(options.workingDirectory, { recursive: true });
  const qualityOptions = {
    boundaryToleranceMs: options.boundaryToleranceMs ?? 100,
    repeatCueThreshold: options.repeatCueThreshold ?? 8,
    repeatDurationMs: options.repeatDurationMs ?? 15_000,
    maxSegmentDurationMs: options.maxSegmentDurationMs ?? 15_000,
  };
  const rootWindows = planPcmWindows(options.metadata, {
    windowMs: options.windowMs ?? 30_000,
    overlapMs: options.overlapMs ?? 5_000,
  });
  const successfulWindows = [];
  const attemptedWindows = [];
  const retryEvents = [];

  for (const window of rootWindows) {
    successfulWindows.push(...await transcribeWindowWithRetry({
      ...options,
      window,
      qualityOptions,
      attemptedWindows,
      retryEvents,
      maxRetryDepth: options.maxRetryDepth ?? 3,
      minRetryWindowMs: options.minRetryWindowMs ?? 4_000,
      retryOverlapMs: options.retryOverlapMs ?? 2_000,
    }));
  }

  successfulWindows.sort((left, right) =>
    left.window.coreStartFrame - right.window.coreStartFrame ||
    left.window.depth - right.window.depth
  );
  assertOwnedCoreCoverage(successfulWindows, options.metadata.totalFrames);
  const merged = mergeWindowTranscripts(successfulWindows, {
    durationMs: options.metadata.durationMs,
  });
  const mergedAnalysis = analyzeTranscriptSegments(merged.segments, {
    durationMs: options.metadata.durationMs,
    ...qualityOptions,
  });
  if (!mergedAnalysis.valid) {
    throw new TranscriptQualityError(
      "Merged window transcript failed the raw quality gate.",
      { stage: "merged", analysis: mergedAnalysis },
    );
  }

  const rawSegments = successfulWindows.flatMap(({ result }) => result.segments);
  const normalizedUniqueTexts = new Set(
    rawSegments.map((segment) => normalizeTranscriptText(segment.text)).filter(Boolean),
  );
  return {
    result: {
      text: merged.text,
      language: merged.language,
      durationMs: merged.durationMs,
      segments: merged.segments,
    },
    quality: {
      valid: true,
      strategy: "bounded_pcm_windows_with_owned_core_merge",
      rootWindowCount: rootWindows.length,
      successfulLeafWindowCount: successfulWindows.length,
      attemptedRequestCount: attemptedWindows.length,
      retryCount: retryEvents.length,
      windowExecutionCoverage: 1,
      rawSegmentCount: rawSegments.length,
      normalizedUniqueTextCount: normalizedUniqueTexts.size,
      mergedSegmentCount: merged.segments.length,
      longestConsecutiveRepeatCueCount:
        mergedAnalysis.longestConsecutiveRepeatCueCount,
      longestConsecutiveRepeatDurationMs:
        mergedAnalysis.longestConsecutiveRepeatDurationMs,
      invalidRawTimelineSegmentCount: successfulWindows.reduce(
        (sum, item) => sum + item.analysis.invalidTimelineSegmentCount,
        0,
      ),
      overlongRawSegmentCount: successfulWindows.reduce(
        (sum, item) => sum + item.analysis.overlongSegmentCount,
        0,
      ),
      longestMergedSegmentDurationMs: mergedAnalysis.longestSegmentDurationMs,
      emptyWindowCount: successfulWindows.filter(
        (item) => item.result.segments.length === 0,
      ).length,
      firstMergedStartMs: mergedAnalysis.firstStartMs,
      lastMergedEndMs: mergedAnalysis.lastEndMs,
      mergeDiagnostics: merged.mergeDiagnostics,
    },
    windows: successfulWindows.map(({ window, result, analysis }) => ({
      window,
      analysis,
      result,
    })),
    attempts: attemptedWindows,
    retryEvents,
  };
}

async function transcribeWindowWithRetry(options) {
  const windowFilePath = path.join(
    options.workingDirectory,
    `${options.window.key}-d${options.window.depth}.wav`,
  );
  await writePcmWindow({
    sourcePath: options.wavPath,
    outputPath: windowFilePath,
    metadata: options.metadata,
    window: options.window,
  });

  let result;
  const started = performance.now();
  try {
    result = await options.transcribeFile(windowFilePath, options.window);
  } finally {
    await rm(windowFilePath, { force: true }).catch(() => {});
  }
  const elapsedMs = Math.round(performance.now() - started);
  const analysis = analyzeTranscriptSegments(result.segments, {
    durationMs: options.window.durationMs,
    ...options.qualityOptions,
  });
  const attempt = {
    key: options.window.key,
    depth: options.window.depth,
    startMs: options.window.startMs,
    endMs: options.window.endMs,
    elapsedMs,
    segmentCount: result.segments.length,
    valid: analysis.valid,
    analysis,
  };
  options.attemptedWindows.push(attempt);
  options.onWindowComplete?.(attempt);
  if (analysis.valid) return [{ window: options.window, result, analysis }];

  const canSplit =
    options.window.depth < options.maxRetryDepth &&
    options.window.durationMs > options.minRetryWindowMs * 1.25;
  if (!canSplit) {
    throw new TranscriptQualityError(
      "A bounded inference window remained degenerate after controlled retries.",
      { stage: "window", window: summarizeWindow(options.window), analysis },
    );
  }

  const retryOverlapMs = Math.min(
    options.retryOverlapMs,
    Math.floor(options.window.durationMs / 4),
  );
  const retryWindowMs = Math.max(
    options.minRetryWindowMs,
    Math.ceil((options.window.durationMs + retryOverlapMs) / 2),
  );
  if (retryWindowMs >= options.window.durationMs) {
    throw new TranscriptQualityError(
      "A degenerate inference window could not be split safely.",
      { stage: "window", window: summarizeWindow(options.window), analysis },
    );
  }
  const childWindows = planPcmWindows(options.metadata, {
    rangeStartFrame: options.window.startFrame,
    rangeEndFrame: options.window.endFrame,
    ownedStartFrame: options.window.coreStartFrame,
    ownedEndFrame: options.window.coreEndFrame,
    windowMs: retryWindowMs,
    overlapMs: retryOverlapMs,
    depth: options.window.depth + 1,
    keyPrefix: `${options.window.key}r`,
  });
  options.retryEvents.push({
    parent: summarizeWindow(options.window),
    analysis,
    childWindowCount: childWindows.length,
    childWindowMs: retryWindowMs,
    childOverlapMs: retryOverlapMs,
  });

  const successful = [];
  for (const childWindow of childWindows) {
    successful.push(...await transcribeWindowWithRetry({
      ...options,
      window: childWindow,
    }));
  }
  return successful;
}

function assertOwnedCoreCoverage(windowResults, totalFrames) {
  let nextFrame = 0;
  for (const { window } of windowResults) {
    if (window.coreStartFrame !== nextFrame) {
      throw new TranscriptQualityError(
        "Successful inference windows do not provide continuous owned coverage.",
        {
          stage: "coverage",
          expectedStartFrame: nextFrame,
          actualStartFrame: window.coreStartFrame,
        },
      );
    }
    nextFrame = window.coreEndFrame;
  }
  if (nextFrame !== totalFrames) {
    throw new TranscriptQualityError(
      "Successful inference windows do not cover the media tail.",
      { stage: "coverage", expectedEndFrame: totalFrames, actualEndFrame: nextFrame },
    );
  }
}

function summarizeWindow(window) {
  return {
    key: window.key,
    depth: window.depth,
    startMs: window.startMs,
    endMs: window.endMs,
    coreStartMs: window.coreStartMs,
    coreEndMs: window.coreEndMs,
  };
}
