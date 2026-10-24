import { z } from 'zod';
import { idSchema, type SubtitleDocument } from './domain';

/**
 * Quality review of transcribed cues: which lines are worth listening to again, and why.
 * The rules only mark cues; nothing here changes a document. design.md 方案 3 holds the
 * rule table these thresholds come from.
 */

/** Why a cue is worth hearing again, in the order reasons are listed everywhere. */
export const CUE_REVIEW_REASONS = ['low_confidence', 'phantom_phrase', 'repetition_loop', 'non_speech_only', 'abnormal_rate', 'duplicate_neighbor'] as const;
export type CueReviewReason = (typeof CUE_REVIEW_REASONS)[number];
export type CueReviewLanguage = 'ja' | 'zh' | 'en';

/**
 * design.md 方案 3, calibrated once on the large-v3 A/B run (records/T-ASRQ-09.md): confidence
 * 0.45 → 0.55, fast CJK 16 → 12 per second, slow 0.6 → 0.8 per second. The confidence threshold
 * is a hint against the decoder's own score, not an accuracy: whisper-server reports high average
 * log probabilities, and another model may need its own value.
 */
export const CUE_REVIEW_THRESHOLDS = {
  /** An unedited cue whose transcript confidence is below this. */
  lowConfidence: 0.55,
  /** A unit of 1–10 characters repeated at least 4 times in a row, covering 60% of the text. */
  repetitionMaxUnit: 10, repetitionMinRepeats: 4, repetitionMinCoverage: 0.6,
  /** Or, from 20 characters on, text that deflates better than 2.4 : 1 (Whisper's own loop test). */
  compressionMinChars: 20, compressionMaxRatio: 2.4,
  /** Characters per second: Han, kana and Hangul are read slower than alphabetic text. */
  cjkMaxRate: 12, otherMaxRate: 30,
  /** A long cue with almost no text may hide speech that was not recognized. */
  slowMinDurationMs: 10_000, slowMaxRate: 0.8,
  /** The same text as the cue before, at least this long and less than a second after it. */
  duplicateMinChars: 6, duplicateMaxGapMs: 1000,
  /**
   * Or, within that second, a near copy (R-ASRQ-14): the shorter text, from 5 characters, inside the
   * longer; or both from 6 characters and at least 80% alike by edit distance.
   */
  duplicateContainedMinChars: 5, duplicateSimilarMinChars: 6, duplicateMinSimilarity: 0.8,
} as const;
/** Flagged cues returned at most by one review; the counts always cover the whole document. */
export const CUE_REVIEW_LIMIT = 10_000;

/**
 * Lines Whisper is known to make up over silence, music or noise: video endings and subtitle
 * credits from its training data. FusionKit's own short list, matched anywhere in the
 * normalized text (`reviewText`: NFKC, lower case, letters and digits only). Lines people
 * really say on their own, such as おやすみなさい, ありがとう or 谢谢大家, are left out.
 */
export const CUE_REVIEW_PHANTOM_PHRASES: Record<CueReviewLanguage, readonly RegExp[]> = {
  ja: [/ご視聴(いただき)?(本当に|誠に|まことに)?ありがとうございま/u, /チャンネル登録/u, /この動画の字幕は/u, /高評価.{0,4}お願いします/u],
  zh: [/字幕由.{1,24}提供/u, /(感谢|谢谢|感謝|謝謝)(您的|大家的)?(观看|收看|觀看)/u, /请不吝点赞|請不吝點[贊讚]/u, /点赞订阅|點[贊讚]訂閱/u,
    /订阅我的频道|訂閱我的頻道/u, /明镜与点点|明鏡與點點/u, /字幕志[愿願]者/u],
  en: [/thanksforwatching/u, /thankyouforwatching/u, /subtitlesby/u, /amaraorg/u, /pleasesubscribe/u, /likeandsubscribe/u],
};

export const cueReviewRequestSchemas = {
  reviewCues: z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
};
/** One flagged cue. `confidence` is given for an unedited cue whose transcript segment has one. */
export type CueReviewEntry = { cueId: string; index: number; sourceRevision: number; reasons: CueReviewReason[]; confidence?: number };
/**
 * Flagged cues in document order, with how many cues each reason flags. `confidence` says
 * whether the transcript carries confidence at all: older documents are reviewed by text alone.
 */
export type CueReviewResult = { cues: CueReviewEntry[]; counts: Record<CueReviewReason, number>; total: number; truncated: boolean; confidence: boolean };

/** The deflated size of a text in bytes, as `zlib.deflateSync` gives it; the main process provides it. */
export type CueReviewCompressor = (text: string) => number;
export type CueReviewInput = {
  text: string; startMs: number; endMs: number | null;
  /** The transcript's confidence for this cue's segment, 0–1. */
  confidence?: number;
  /** The text was changed in the studio (`sourceRevision` > 1): confidence no longer describes it. */
  edited: boolean;
  /** The document's language, when known; the cue's own script is looked at as well. */
  language?: CueReviewLanguage;
  previous?: { text: string; startMs: number; endMs: number | null };
};

const BRACKETED = /\([^()]*\)|\[[^[\]]*\]|【[^【】]*】|〔[^〔〕]*〕/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SPOKEN = /[\p{L}\p{N}\p{M}]/u;

/** The text rules compare: NFKC, lower case, and only letters, marks and digits (no spaces, punctuation or symbols). */
export function reviewText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/** The language a text's script suggests: kana means Japanese, Han without kana Chinese, Latin letters English. */
export function scriptLanguage(text: string): CueReviewLanguage | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/\p{Script=Latin}/u.test(text)) return 'en';
  return undefined;
}

/** A language tag or Whisper language name, such as `ja`, `jpn` or `japanese`, as one of the reviewed languages. */
export function reviewLanguage(value: string | undefined): CueReviewLanguage | undefined {
  const tag = value?.trim().toLowerCase().split(/[-_]/)[0];
  if (tag === 'ja' || tag === 'jpn' || tag === 'japanese') return 'ja';
  if (tag === 'zh' || tag === 'zho' || tag === 'chi' || tag === 'cmn' || tag === 'yue' || tag === 'chinese' || tag === 'cantonese') return 'zh';
  if (tag === 'en' || tag === 'eng' || tag === 'english') return 'en';
  return undefined;
}

/** A run of one unit repeated: where it starts, the unit's length and how many times it occurs in a row. */
type Run = { start: number; unit: number; repeats: number };
/**
 * The run of repeated units covering the most characters, each unit at most `maxUnit` long and
 * repeated at least `minRepeats(unit)` times; on a tie the shorter unit wins.
 */
function longestRun(points: readonly string[], maxUnit: number, minRepeats: (unit: number) => number): Run | null {
  let best: Run | null = null;
  for (let unit = 1; unit <= Math.min(maxUnit, Math.floor(points.length / 2)); unit++) {
    // `same` counts how many characters in a row equal the one `unit` before them.
    let same = 0;
    for (let at = unit; at <= points.length; at++) {
      if (at < points.length && points[at] === points[at - unit]) { same++; continue; }
      const repeats = Math.floor((same + unit) / unit);
      if (repeats >= minRepeats(unit) && (!best || repeats * unit > best.repeats * best.unit)) best = { start: at - same - unit, unit, repeats };
      same = 0;
    }
  }
  return best;
}

function repetitionLoop(key: string, text: string, compressedSize?: CueReviewCompressor) {
  const limits = CUE_REVIEW_THRESHOLDS;
  const points = [...key];
  const run = longestRun(points, limits.repetitionMaxUnit, () => limits.repetitionMinRepeats);
  if (run && run.repeats * run.unit >= points.length * limits.repetitionMinCoverage) return true;
  if (!compressedSize || points.length < limits.compressionMinChars) return false;
  const bytes = new TextEncoder().encode(text).length;
  return bytes / Math.max(1, compressedSize(text)) > limits.compressionMaxRatio;
}

function abnormalRate(key: string, startMs: number, endMs: number | null) {
  const limits = CUE_REVIEW_THRESHOLDS;
  const points = [...key];
  // An end that is not known gives no rate; a cue with no spoken text is non_speech_only instead.
  if (endMs === null || !points.length) return false;
  const durationMs = endMs - startMs;
  if (durationMs <= 0) return true;
  const rate = points.length / (durationMs / 1000);
  const cjk = points.filter(point => CJK.test(point)).length * 2 >= points.length;
  if (rate > (cjk ? limits.cjkMaxRate : limits.otherMaxRate)) return true;
  return durationMs >= limits.slowMinDurationMs && rate < limits.slowMaxRate;
}

/**
 * Whether two texts are at least `minSimilarity` alike: one less their edit distance (characters
 * inserted, deleted or replaced) over the longer length. Stops at the first row of the distance
 * table that already rules it out.
 */
function alike(a: readonly string[], b: readonly string[], minSimilarity: number) {
  const longer = Math.max(a.length, b.length);
  const near = (distance: number) => 1 - distance / longer >= minSimilarity;
  if (!near(Math.abs(a.length - b.length))) return false;
  let row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      least = Math.min(least, next[j]);
    }
    if (!near(least)) return false;
    row = next;
  }
  return near(row[b.length]);
}

/**
 * Whether a cue's normalized text repeats the one before it. Overlapping windows can output a line
 * twice at their seam with a comma or a character changed, or joined to the next line (R-ASRQ-14).
 * The same text twice is held to its own length, so a short line said again stays unflagged.
 */
function duplicateNeighbor(key: string, previousKey: string) {
  const limits = CUE_REVIEW_THRESHOLDS;
  const [shorter, longer] = [[...key], [...previousKey]].sort((a, b) => a.length - b.length);
  if (key === previousKey) return shorter.length >= limits.duplicateMinChars;
  if (shorter.length >= limits.duplicateContainedMinChars && (key.includes(previousKey) || previousKey.includes(key))) return true;
  return shorter.length >= limits.duplicateSimilarMinChars && alike(shorter, longer, limits.duplicateMinSimilarity);
}

/** The reasons one cue is worth hearing again, in `CUE_REVIEW_REASONS` order; empty when it reads as ordinary speech. */
export function reviewCue(input: CueReviewInput, compressedSize?: CueReviewCompressor): CueReviewReason[] {
  const limits = CUE_REVIEW_THRESHOLDS;
  const text = input.text.normalize('NFKC').trim();
  const key = reviewText(text);
  // What is spoken: bracketed notes such as （笑）, 【音楽】 or [拍手] are not.
  const speech = reviewText(text.replace(BRACKETED, ''));
  const reasons: CueReviewReason[] = [];
  if (!input.edited && input.confidence !== undefined && input.confidence < limits.lowConfidence) reasons.push('low_confidence');
  const languages = new Set([input.language, scriptLanguage(text)].filter((value): value is CueReviewLanguage => !!value));
  if (key && [...languages].some(language => CUE_REVIEW_PHANTOM_PHRASES[language].some(pattern => pattern.test(key)))) reasons.push('phantom_phrase');
  if (speech && repetitionLoop(speech, text, compressedSize)) reasons.push('repetition_loop');
  // Only symbols, punctuation or bracketed notes, such as ♪～♪.
  if (text && !speech) reasons.push('non_speech_only');
  if (abnormalRate(speech, input.startMs, input.endMs)) reasons.push('abnormal_rate');
  const previous = input.previous;
  if (previous && input.startMs - (previous.endMs ?? previous.startMs) < limits.duplicateMaxGapMs
    && duplicateNeighbor(key, reviewText(previous.text))) reasons.push('duplicate_neighbor');
  return reasons;
}

/** The document's language: what the transcript detected or the audio track declares, else the script most cues are written in. */
export function documentReviewLanguage(doc: SubtitleDocument): CueReviewLanguage | undefined {
  const declared = doc.schemaVersion === 2 ? reviewLanguage(doc.preservation.transcript.detectedLanguage) ?? reviewLanguage(doc.origin.audioTrack?.language) : undefined;
  if (declared) return declared;
  const votes = new Map<CueReviewLanguage, number>();
  for (const cue of doc.cues) {
    const language = scriptLanguage(cue.source.plain);
    if (language) votes.set(language, (votes.get(language) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const noCounts = (): Record<CueReviewReason, number> => Object.fromEntries(CUE_REVIEW_REASONS.map(reason => [reason, 0])) as Record<CueReviewReason, number>;

/**
 * Reviews every cue of a document in order. Confidence comes from the transcript segment a
 * cue was made from, and only while the cue's text is the recognized one (`sourceRevision` 1):
 * a split or inserted cue shares its neighbour's segment but is always edited.
 */
export function reviewDocument(doc: SubtitleDocument, options: { compressedSize?: CueReviewCompressor; limit?: number } = {}): CueReviewResult {
  const limit = options.limit ?? CUE_REVIEW_LIMIT;
  const segments = doc.schemaVersion === 2 ? new Map(doc.preservation.transcript.segments.map(segment => [segment.id, segment.confidence])) : undefined;
  const language = documentReviewLanguage(doc);
  const counts = noCounts();
  const cues: CueReviewEntry[] = [];
  let total = 0;
  doc.cues.forEach((cue, index) => {
    const edited = cue.sourceRevision > 1;
    const confidence = !edited && 'segmentId' in cue && cue.segmentId ? segments?.get(cue.segmentId) : undefined;
    const previous = doc.cues[index - 1];
    const reasons = reviewCue({ text: cue.source.plain, startMs: cue.timing.startMs, endMs: cue.timing.endMs, edited, language,
      ...(confidence === undefined ? {} : { confidence }),
      ...(previous ? { previous: { text: previous.source.plain, startMs: previous.timing.startMs, endMs: previous.timing.endMs } } : {}) }, options.compressedSize);
    if (!reasons.length) return;
    total++;
    for (const reason of reasons) counts[reason]++;
    if (cues.length < limit) cues.push({ cueId: cue.id, index, sourceRevision: cue.sourceRevision, reasons, ...(confidence === undefined ? {} : { confidence }) });
  });
  const confidence = !!segments && [...segments.values()].some(value => value !== undefined);
  return { cues, counts, total, truncated: total > cues.length, confidence };
}

/** How an ignored flag is remembered: it comes back once the cue's text changes. */
export const cueReviewIgnoreKey = (entry: Pick<CueReviewEntry, 'cueId' | 'sourceRevision'>) => `${entry.cueId}:${entry.sourceRevision}`;

/** The review without the flags ignored on this computer, and only the cues with `reason` when one is chosen. */
export function visibleReview(result: CueReviewResult, ignored: ReadonlySet<string>, reason?: CueReviewReason): CueReviewResult {
  const counts = { ...result.counts };
  let total = result.total;
  const shown = result.cues.filter(entry => {
    if (!ignored.has(cueReviewIgnoreKey(entry))) return true;
    total--;
    for (const item of entry.reasons) counts[item]--;
    return false;
  });
  const cues = reason ? shown.filter(entry => entry.reasons.includes(reason)) : shown;
  return { ...result, cues, counts, total };
}

/** Where moving through flagged cues continues: the first at or after `anchor` (a cue index), else the first. */
export function reviewPosition(cues: readonly Pick<CueReviewEntry, 'index'>[], anchor: number): number {
  if (!cues.length) return -1;
  const next = cues.findIndex(entry => entry.index >= anchor);
  return next < 0 ? 0 : next;
}

/** One step through flagged cues, wrapping at either end, as the find bar moves through matches. */
export const reviewStep = (length: number, position: number, step: 1 | -1) => length ? ((position < 0 ? 0 : position + step) + length) % length : -1;

/**
 * The text with its longest repetition kept once: a short unit (up to 3 characters) repeated at
 * least 4 times, or a longer one (up to 50) at least twice. Punctuation and spaces between the
 * repeats go with them; what follows the run stays. Null when there is nothing to collapse.
 */
export function collapseRepetition(text: string): string | null {
  const points = [...text];
  const spoken = points.flatMap((point, at) => SPOKEN.test(point) ? [{ point: point.toLowerCase(), at }] : []);
  const run = longestRun(spoken.map(item => item.point), 50, unit => unit <= 3 ? CUE_REVIEW_THRESHOLDS.repetitionMinRepeats : 2);
  if (!run) return null;
  const unitEnd = spoken[run.start + run.unit - 1].at + 1, runEnd = spoken[run.start + run.unit * run.repeats - 1].at + 1;
  const collapsed = points.slice(0, unitEnd).join('') + points.slice(runEnd).join('');
  return collapsed !== text ? collapsed : null;
}
