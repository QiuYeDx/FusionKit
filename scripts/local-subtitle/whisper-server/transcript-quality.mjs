const DEFAULT_BOUNDARY_TOLERANCE_MS = 100;
const DEFAULT_REPEAT_CUE_THRESHOLD = 8;
const DEFAULT_REPEAT_DURATION_MS = 15_000;
const DEFAULT_MAX_SEGMENT_DURATION_MS = 15_000;

export class TranscriptQualityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "TranscriptQualityError";
    this.code = "transcript_quality_failed";
    this.details = details;
  }
}

export function normalizeTranscriptText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

export function analyzeTranscriptSegments(segments, options = {}) {
  const durationMs = options.durationMs;
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error("Transcript analysis requires a positive integer durationMs.");
  }
  const boundaryToleranceMs = options.boundaryToleranceMs ??
    DEFAULT_BOUNDARY_TOLERANCE_MS;
  const repeatCueThreshold = options.repeatCueThreshold ??
    DEFAULT_REPEAT_CUE_THRESHOLD;
  const repeatDurationMs = options.repeatDurationMs ??
    DEFAULT_REPEAT_DURATION_MS;
  const maxSegmentDurationMs = options.maxSegmentDurationMs ??
    DEFAULT_MAX_SEGMENT_DURATION_MS;
  const values = Array.isArray(segments) ? segments : [];
  const uniqueTexts = new Set();
  const counts = {
    emptyText: 0,
    zeroOrNegativeDuration: 0,
    reverseOrder: 0,
    overlap: 0,
    outOfBounds: 0,
    overlong: 0,
  };
  let firstStartMs;
  let lastEndMs;
  let previous;
  let currentRun;
  let longestRun = { cueCount: 0, durationMs: 0 };

  for (const segment of values) {
    const startMs = segment?.startMs;
    const endMs = segment?.endMs;
    const normalizedText = normalizeTranscriptText(segment?.text);
    if (!normalizedText) counts.emptyText += 1;
    else uniqueTexts.add(normalizedText);

    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) {
      counts.zeroOrNegativeDuration += 1;
    }
    if (
      Number.isInteger(startMs) &&
      Number.isInteger(endMs) &&
      endMs - startMs > maxSegmentDurationMs
    ) {
      counts.overlong += 1;
    }
    if (
      Number.isInteger(startMs) &&
      Number.isInteger(endMs) &&
      (startMs < -boundaryToleranceMs || endMs > durationMs + boundaryToleranceMs)
    ) {
      counts.outOfBounds += 1;
    }
    if (previous && Number.isInteger(startMs)) {
      if (startMs < previous.startMs - boundaryToleranceMs) {
        counts.reverseOrder += 1;
      }
      if (startMs < previous.endMs - boundaryToleranceMs) {
        counts.overlap += 1;
      }
    }
    if (Number.isInteger(startMs)) {
      firstStartMs = firstStartMs === undefined
        ? startMs
        : Math.min(firstStartMs, startMs);
    }
    if (Number.isInteger(endMs)) {
      lastEndMs = lastEndMs === undefined ? endMs : Math.max(lastEndMs, endMs);
    }

    if (normalizedText && currentRun?.normalizedText === normalizedText) {
      currentRun.cueCount += 1;
      if (Number.isInteger(endMs)) currentRun.endMs = endMs;
    } else if (normalizedText) {
      currentRun = {
        normalizedText,
        cueCount: 1,
        startMs: Number.isInteger(startMs) ? startMs : 0,
        endMs: Number.isInteger(endMs) ? endMs : 0,
      };
    } else {
      currentRun = undefined;
    }
    if (currentRun) {
      const candidate = {
        cueCount: currentRun.cueCount,
        durationMs: currentRun.cueCount > 1
          ? Math.max(0, currentRun.endMs - currentRun.startMs)
          : 0,
      };
      if (
        candidate.cueCount > longestRun.cueCount ||
        (candidate.cueCount === longestRun.cueCount &&
          candidate.durationMs > longestRun.durationMs)
      ) {
        longestRun = candidate;
      }
    }

    if (Number.isInteger(startMs) && Number.isInteger(endMs)) {
      previous = { startMs, endMs };
    }
  }

  const repetitionDegenerate =
    longestRun.cueCount >= repeatCueThreshold &&
    longestRun.durationMs >= repeatDurationMs;
  const invalidTimelineSegmentCount =
    counts.zeroOrNegativeDuration +
    counts.reverseOrder +
    counts.overlap +
    counts.outOfBounds;
  const longestSegmentDurationMs = values.reduce((maximum, segment) =>
    Number.isInteger(segment?.startMs) && Number.isInteger(segment?.endMs)
      ? Math.max(maximum, segment.endMs - segment.startMs)
      : maximum, 0);
  const valid =
    counts.emptyText === 0 &&
    counts.overlong === 0 &&
    invalidTimelineSegmentCount === 0 &&
    !repetitionDegenerate;

  return {
    valid,
    rawSegmentCount: values.length,
    normalizedUniqueTextCount: uniqueTexts.size,
    longestConsecutiveRepeatCueCount: longestRun.cueCount,
    longestConsecutiveRepeatDurationMs: longestRun.durationMs,
    repetitionDegenerate,
    emptyTextSegmentCount: counts.emptyText,
    zeroOrNegativeDurationSegmentCount: counts.zeroOrNegativeDuration,
    reverseOrderSegmentCount: counts.reverseOrder,
    overlappingSegmentCount: counts.overlap,
    outOfBoundsSegmentCount: counts.outOfBounds,
    overlongSegmentCount: counts.overlong,
    longestSegmentDurationMs,
    invalidTimelineSegmentCount,
    firstStartMs,
    lastEndMs,
  };
}

export function mergeWindowTranscripts(windowResults, options = {}) {
  const durationMs = options.durationMs;
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error("Window merge requires a positive integer durationMs.");
  }
  const projected = windowResults.flatMap(({ window, result }) =>
    result.segments.flatMap((segment) => projectSegmentToOwnedCore(segment, window))
  );
  const wordTimelineFallbackCount = projected.filter(
    (segment) => segment.wordTimelineFallback,
  ).length;
  projected.sort((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.sourceWindowDepth - right.sourceWindowDepth ||
    left.sourceWindowKey.localeCompare(right.sourceWindowKey)
  );

  const segments = [];
  let duplicateBoundarySegmentCount = 0;
  let trimmedBoundaryPrefixCount = 0;
  let punctuationOnlyBoundarySegmentCount = 0;
  for (const candidate of projected) {
    if (!normalizeTranscriptText(candidate.text)) {
      punctuationOnlyBoundarySegmentCount += 1;
      continue;
    }
    const previous = segments.at(-1);
    if (
      previous &&
      previous.sourceWindowKey !== candidate.sourceWindowKey &&
      normalizeTranscriptText(previous.text) === normalizeTranscriptText(candidate.text) &&
      candidate.startMs <= previous.endMs
    ) {
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
      previous.words = mergeWords(previous.words, candidate.words);
      duplicateBoundarySegmentCount += 1;
      continue;
    }
    if (
      previous &&
      previous.sourceWindowKey !== candidate.sourceWindowKey &&
      candidate.startMs >= previous.endMs &&
      candidate.startMs - previous.endMs <= 500
    ) {
      const overlapLength = findBoundaryTextOverlap(previous.text, candidate.text);
      if (overlapLength > 0) {
        candidate.text = trimNormalizedPrefix(candidate.text, overlapLength);
        candidate.words = undefined;
        trimmedBoundaryPrefixCount += 1;
        if (!candidate.text) {
          previous.endMs = Math.max(previous.endMs, candidate.endMs);
          continue;
        }
      }
    }
    segments.push(candidate);
  }

  const reconciled = reconcileTimeline(segments);
  const publicSegments = reconciled.segments.map((segment, index) => ({
    id: index,
    startMs: Math.max(0, segment.startMs),
    endMs: Math.min(durationMs, segment.endMs),
    text: segment.text,
    ...(segment.words?.length ? { words: segment.words } : {}),
  }));
  return {
    text: publicSegments.map((segment) => segment.text).join(" ").trim(),
    language: windowResults.find(({ result }) => result.language)?.result.language,
    durationMs,
    segments: publicSegments,
    mergeDiagnostics: {
      projectedSegmentCount: projected.length,
      mergedSegmentCount: publicSegments.length,
      duplicateBoundarySegmentCount,
      trimmedBoundaryPrefixCount,
      punctuationOnlyBoundarySegmentCount,
      overlapAdjustmentCount: reconciled.overlapAdjustmentCount,
      wordTimelineFallbackCount,
    },
  };
}

function projectSegmentToOwnedCore(segment, window) {
  const absoluteStartMs = window.startMs + segment.startMs;
  const absoluteEndMs = window.startMs + segment.endMs;
  const hasWordTimestamps = Array.isArray(segment.words) && segment.words.length > 0;
  const wordTimelineValid = hasWordTimestamps && isWordTimelineWithinSegment(segment);
  const words = wordTimelineValid
    ? segment.words.flatMap((word) => {
      const startMs = window.startMs + word.startMs;
      const endMs = window.startMs + word.endMs;
      const midpoint = startMs + (endMs - startMs) / 2;
      if (!ownsMidpoint(window, midpoint)) return [];
      return [{
        ...word,
        startMs: Math.max(window.coreStartMs, startMs),
        endMs: Math.min(window.coreEndMs, endMs),
      }];
    })
    : [];

  if (words.length > 0) {
    const startMs = Math.min(...words.map((word) => word.startMs));
    const endMs = Math.max(...words.map((word) => word.endMs));
    const text = normalizeDisplayText(words.map((word) => word.text).join(""));
    if (text && endMs > startMs) {
      return [{
        startMs,
        endMs,
        text,
        words,
        sourceWindowKey: window.key,
        sourceWindowDepth: window.depth,
        wordTimelineFallback: false,
      }];
    }
    return [];
  }

  const midpoint = absoluteStartMs + (absoluteEndMs - absoluteStartMs) / 2;
  const text = normalizeDisplayText(segment.text);
  const startMs = Math.max(window.coreStartMs, absoluteStartMs);
  const endMs = Math.min(window.coreEndMs, absoluteEndMs);
  if (!text || !ownsMidpoint(window, midpoint) || endMs <= startMs) return [];
  return [{
    startMs,
    endMs,
    text,
    sourceWindowKey: window.key,
    sourceWindowDepth: window.depth,
    wordTimelineFallback: hasWordTimestamps && !wordTimelineValid,
  }];
}

function isWordTimelineWithinSegment(segment) {
  const toleranceMs = 100;
  let previousStartMs;
  for (const word of segment.words) {
    if (
      !Number.isInteger(word?.startMs) ||
      !Number.isInteger(word?.endMs) ||
      word.endMs < word.startMs ||
      word.startMs < segment.startMs - toleranceMs ||
      word.endMs > segment.endMs + toleranceMs ||
      (previousStartMs !== undefined && word.startMs < previousStartMs - toleranceMs)
    ) {
      return false;
    }
    previousStartMs = word.startMs;
  }
  return true;
}

function ownsMidpoint(window, midpoint) {
  const isFinalCore = window.coreEndFrame === window.endFrame;
  return midpoint >= window.coreStartMs &&
    (midpoint < window.coreEndMs || (isFinalCore && midpoint <= window.coreEndMs));
}

function normalizeDisplayText(value) {
  return String(value ?? "")
    .replace(/\r\n?|\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function mergeWords(left = [], right = []) {
  return [...left, ...right].sort((a, b) =>
    (a.startMs ?? 0) - (b.startMs ?? 0) ||
    (a.endMs ?? 0) - (b.endMs ?? 0)
  );
}

function reconcileTimeline(segments) {
  const reconciled = [];
  let overlapAdjustmentCount = 0;
  for (const source of segments) {
    const candidate = { ...source };
    const previous = reconciled.at(-1);
    if (previous && candidate.startMs < previous.endMs) {
      let boundary = Math.round((candidate.startMs + previous.endMs) / 2);
      boundary = Math.max(previous.startMs + 1, boundary);
      boundary = Math.min(candidate.endMs - 1, boundary);
      if (boundary <= previous.startMs || boundary >= candidate.endMs) {
        previous.text = normalizeDisplayText(`${previous.text} ${candidate.text}`);
        previous.endMs = Math.max(previous.endMs, candidate.endMs);
        previous.words = mergeWords(previous.words, candidate.words);
        overlapAdjustmentCount += 1;
        continue;
      }
      previous.endMs = boundary;
      previous.words = clipWords(previous.words, previous.startMs, previous.endMs);
      candidate.startMs = boundary;
      candidate.words = clipWords(candidate.words, candidate.startMs, candidate.endMs);
      overlapAdjustmentCount += 1;
    }
    reconciled.push(candidate);
  }
  return { segments: reconciled, overlapAdjustmentCount };
}

function clipWords(words, startMs, endMs) {
  if (!Array.isArray(words)) return words;
  return words.flatMap((word) => {
    const clippedStart = Math.max(startMs, word.startMs);
    const clippedEnd = Math.min(endMs, word.endMs);
    return clippedEnd >= clippedStart
      ? [{ ...word, startMs: clippedStart, endMs: clippedEnd }]
      : [];
  });
}

function findBoundaryTextOverlap(left, right) {
  const normalizedLeft = normalizeTranscriptText(left);
  const normalizedRight = normalizeTranscriptText(right);
  const maximum = Math.min(normalizedLeft.length, normalizedRight.length);
  for (let length = maximum; length >= 2; length -= 1) {
    const suffix = normalizedLeft.slice(-length);
    if (!normalizedRight.startsWith(suffix)) continue;
    const minimum = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
      .test(suffix)
      ? 2
      : 4;
    if (length >= minimum) return length;
  }
  return 0;
}

function trimNormalizedPrefix(value, normalizedLength) {
  const characters = [...String(value ?? "")];
  let consumed = 0;
  let index = 0;
  while (index < characters.length && consumed < normalizedLength) {
    consumed += normalizeTranscriptText(characters[index]).length;
    index += 1;
  }
  return normalizeDisplayText(characters.slice(index).join(""))
    .replace(/^[\p{P}\p{S}\s]+/gu, "")
    .trim();
}
