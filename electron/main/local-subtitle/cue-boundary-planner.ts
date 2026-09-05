import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";

const SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });
const CLOSING = /^[\p{Pe}\p{Pf}。！？!?、，,；;：:…]/u;
const PUNCTUATION = /[。！？!?、，,；;：:…]$/u;

export class LocalSubtitleCuePlanError extends Error {
  readonly name = "LocalSubtitleCuePlanError";
  constructor(
    readonly reason: "invalid_source" | "limit_exceeded" | "text_coverage_mismatch",
    readonly observed?: number,
    readonly limit?: number,
  ) {
    super(`Subtitle cue planning failed: ${reason}`);
  }
}

export interface LocalSubtitleCueSource {
  readonly timelineDomain: "original_media";
  readonly startMs: number;
  readonly endMs: number;
  /** Normalized, single-line text from one accepted main-process observation. */
  readonly text: string;
}

export interface LocalSubtitleCueTargets {
  readonly maxCueDurationMs: number;
  readonly maxCueChars: number;
  readonly maxLineChars: number;
}

export interface LocalSubtitleSegmentCuePlan {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly sourceSpan: Readonly<{ startGrapheme: 0; endGrapheme: number }>;
  readonly lines: readonly Readonly<{ startGrapheme: number; endGrapheme: number }>[];
  readonly exceedsDisplayTarget: boolean;
}

/** Segment-only evidence cannot authorize an internal time cut or a semantic join. */
export function planLocalSubtitleSegmentCue(
  source: LocalSubtitleCueSource,
  targets: LocalSubtitleCueTargets,
): LocalSubtitleSegmentCuePlan {
  if (
    source.timelineDomain !== "original_media" ||
    !Number.isSafeInteger(source.startMs) || source.startMs < 0 ||
    !Number.isSafeInteger(source.endMs) || source.endMs <= source.startMs ||
    source.endMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs ||
    !source.text || source.text !== source.text.trim() || /[\r\n]/u.test(source.text) ||
    !Number.isSafeInteger(targets.maxCueDurationMs) || targets.maxCueDurationMs < 1 ||
    !Number.isSafeInteger(targets.maxCueChars) || targets.maxCueChars < 1 ||
    !Number.isSafeInteger(targets.maxLineChars) || targets.maxLineChars < 1
  ) throw new LocalSubtitleCuePlanError("invalid_source");
  if (source.text.length > LOCAL_SUBTITLE_LIMITS.maxCueTextChars) {
    throw new LocalSubtitleCuePlanError("limit_exceeded", source.text.length, LOCAL_SUBTITLE_LIMITS.maxCueTextChars);
  }

  const units = Array.from(SEGMENTER.segment(source.text), entry => entry.segment);
  const offsets = [0];
  for (const unit of units) offsets.push(offsets.at(-1)! + unit.length);
  const boundaries = [0];
  for (let end = 1; end < units.length; end += 1) {
    const left = units[end - 1]!;
    const right = units[end]!;
    const whitespace = /^\s+$/u.test(left);
    const punctuation = PUNCTUATION.test(left) &&
      !(/\p{N}$/u.test(units[end - 2] ?? "") && /^\p{N}/u.test(right));
    // Keep closing punctuation with its text, and do not create word spaces.
    if ((whitespace || punctuation) && !/^\s+$/u.test(right) && !CLOSING.test(right)) boundaries.push(end);
  }
  boundaries.push(units.length);

  let width = Math.min(LOCAL_SUBTITLE_LIMITS.maxLineChars,
    Math.max(targets.maxLineChars, Math.ceil(source.text.length / LOCAL_SUBTITLE_LIMITS.maxCueLines)));
  let lines: { startGrapheme: number; endGrapheme: number }[];
  for (;;) {
    lines = [];
    let cursor = 0;
    while (cursor < boundaries.length - 1) {
      const start = boundaries[cursor]!;
      let end = cursor + 1;
      while (end + 1 < boundaries.length &&
        offsets[boundaries[end + 1]!]! - offsets[start]! <= width) end += 1;
      lines.push({ startGrapheme: start, endGrapheme: boundaries[end]! });
      cursor = end;
    }
    if (lines.length <= LOCAL_SUBTITLE_LIMITS.maxCueLines && lines.every(line =>
      source.text.slice(offsets[line.startGrapheme], offsets[line.endGrapheme]).trim().length <= LOCAL_SUBTITLE_LIMITS.maxLineChars)) break;
    if (width === LOCAL_SUBTITLE_LIMITS.maxLineChars) {
      const longest = Math.max(...lines.map(line =>
        source.text.slice(offsets[line.startGrapheme], offsets[line.endGrapheme]).trim().length));
      throw new LocalSubtitleCuePlanError("limit_exceeded",
        longest > LOCAL_SUBTITLE_LIMITS.maxLineChars ? longest : lines.length,
        longest > LOCAL_SUBTITLE_LIMITS.maxLineChars ? LOCAL_SUBTITLE_LIMITS.maxLineChars : LOCAL_SUBTITLE_LIMITS.maxCueLines);
    }
    width = Math.min(LOCAL_SUBTITLE_LIMITS.maxLineChars, width * 2);
  }

  // Ranges consume the exact source once; only boundary whitespace is reflowed.
  const sourceParts = lines.map(line => source.text.slice(offsets[line.startGrapheme], offsets[line.endGrapheme]));
  if (sourceParts.join("") !== source.text) {
    throw new LocalSubtitleCuePlanError("text_coverage_mismatch");
  }
  const rendered = sourceParts.map(part => part.trim());
  if (rendered.some(part => !part)) throw new LocalSubtitleCuePlanError("invalid_source");
  return Object.freeze({
    startMs: source.startMs,
    endMs: source.endMs,
    text: rendered.join("\n"),
    sourceSpan: Object.freeze({ startGrapheme: 0 as const, endGrapheme: units.length }),
    lines: Object.freeze(lines.map(line => Object.freeze(line))),
    exceedsDisplayTarget: source.endMs - source.startMs > targets.maxCueDurationMs ||
      source.text.length > targets.maxCueChars || rendered.some(line => line.length > targets.maxLineChars),
  });
}
