import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { pcm16WavHeader, resolveCueAudioRange } from '../../../src/subtitle-studio/cue-audio';
import { CUE_RECOGNIZE_LIMITS, type CueRecognizeRequest, type CueRecognizeResult } from '../../../src/subtitle-studio/cue-recognize-contract';
import { transcriptionModelProfile, transcriptionModelSpeaks } from '../../../src/subtitle-studio/transcription-model-profiles';
import { documentReviewLanguage, reviewCue, reviewLanguage } from '../../../src/subtitle-studio/transcription-review';
import { LOCAL_SUBTITLE_QUIET_AUDIO_POLICY, conditionQuietPcm16, conditionWhisperPcm16 } from './transcription/native/quiet-audio';
import { compressedSize } from './cue-review';
import type { DocumentRepository } from './document-repository';
import type { CueMediaService } from './cue-media-service';
import type { CueAudioClipper } from './cue-audio-clip';
import type { RecognizeClipRequest, RecognizedClip } from './transcription/runtime';

export type CueRecognizeDependencies = {
  repository: DocumentRepository; media: CueMediaService; clipper: CueAudioClipper;
  /** Where the clip is written for the server, then removed. */
  workingDirectory: string;
  recognize: (request: RecognizeClipRequest) => Promise<RecognizedClip>;
};

type Segment = RecognizedClip['segments'][number];
type Range = { startMs: number; endMs: number };
const WAV_HEADER_BYTES = 44;
/** Scripts written without spaces between words, with their punctuation and full-width forms. */
const UNSPACED_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]$/u;
const UNSPACED_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * The stretch decoded for a cue: `contextMs` on each side, less where the media starts or ends,
 * and never longer than the server takes (`maxMs`, context included). `bounds` stops the stretch
 * at the cues around it (`notBeforeMs`: where the one before ends; `notAfterMs`: where the next starts).
 */
export function cueRecognizeClipRange(range: Range, contextMs: number, durationMs?: number,
  bounds: { readonly notBeforeMs?: number; readonly notAfterMs?: number } = {}) {
  const room = Math.max(0, CUE_RECOGNIZE_LIMITS.maxMs - (range.endMs - range.startMs));
  const reachBefore = bounds.notBeforeMs === undefined ? contextMs : Math.max(0, Math.min(contextMs, range.startMs - bounds.notBeforeMs));
  const reachAfter = bounds.notAfterMs === undefined ? contextMs : Math.max(0, Math.min(contextMs, bounds.notAfterMs - range.endMs));
  const before = Math.min(reachBefore, range.startMs, Math.floor(room / 2));
  const after = Math.min(reachAfter, room - before, durationMs === undefined ? contextMs : Math.max(0, durationMs - range.endMs));
  return { clipStartMs: range.startMs - before, clipEndMs: range.endMs + after };
}

/** Where padding around a cue must stop: the end of a cue just before it and the start of one just after it. */
export function cueRecognizePadBounds(range: Range, others: readonly Range[]) {
  const before = others.filter(other => other.endMs <= range.startMs).map(other => other.endMs);
  const after = others.filter(other => other.startMs >= range.endMs).map(other => other.startMs);
  return { ...(before.length ? { notBeforeMs: Math.max(...before) } : {}), ...(after.length ? { notAfterMs: Math.min(...after) } : {}) };
}

const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * Whether a segment heard in the clip is the cue's (both in media time): most of it lies within the
 * cue widened by `overlapMs`, or it covers most of the cue. A neighbour's segment that only reaches
 * into that margin is not, so the context heard around the cue does not become its text.
 */
export function segmentBelongsToCue(segment: Range, cue: Range) {
  const margin = CUE_RECOGNIZE_LIMITS.overlapMs, length = segment.endMs - segment.startMs;
  if (length <= 0) return segment.startMs >= cue.startMs - margin && segment.startMs <= cue.endMs + margin;
  return overlap(segment, { startMs: cue.startMs - margin, endMs: cue.endMs + margin }) * 2 > length || overlap(segment, cue) * 2 > cue.endMs - cue.startMs;
}

/**
 * Whether a segment kept for the cue heard another cue too: it reaches more than `overlapMs` into
 * one. Whisper sometimes hears neighbouring lines as one segment, and no timestamp splits it.
 */
export function segmentHearsOtherCue(segment: Range, others: readonly Range[]) {
  return others.some(other => overlap(segment, other) > CUE_RECOGNIZE_LIMITS.overlapMs);
}

/** The segments' text in order, with a space between them only where the script uses spaces. */
function joinSegments(segments: readonly Segment[]) {
  return segments.reduce((text, segment) => !text ? segment.text
    : `${text}${UNSPACED_END.test(text) || UNSPACED_START.test(segment.text) ? '' : ' '}${segment.text}`, '');
}

/** The transcript's confidence (design 方案 3), averaged over the segments by their length, to three decimals. */
function segmentConfidence(segments: readonly Segment[]) {
  let weight = 0, sum = 0;
  for (const segment of segments) {
    const ms = Math.max(1, segment.endMs - segment.startMs);
    weight += ms; sum += ms * Math.exp(Math.min(0, segment.averageLogProbability)) * (1 - segment.noSpeechProbability);
  }
  return weight ? Math.round(sum / weight * 1000) / 1000 : undefined;
}

/**
 * A quiet clip gained as transcription gains its windows: the whole clip when its level is in the
 * quiet range, else the gated gain when its speech is quiet among louder sounds. Positions never move.
 */
function gainQuietClip(wav: Uint8Array): { bytes: Uint8Array; gained: boolean } {
  const pcm = Buffer.from(wav.buffer, wav.byteOffset + WAV_HEADER_BYTES, wav.byteLength - WAV_HEADER_BYTES);
  if (!pcm.length || pcm.length % 2 || pcm.length > LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.maxPcmBytes) return { bytes: wav, gained: false };
  const whole = conditionQuietPcm16(pcm);
  const conditioned = whole.gainDb > 0 ? whole : conditionWhisperPcm16(pcm);
  if (!(conditioned.gainDb > 0)) return { bytes: wav, gained: false };
  return { bytes: Buffer.concat([pcm16WavHeader(conditioned.pcm.length, CUE_RECOGNIZE_LIMITS.sampleRate, 1), conditioned.pcm]), gained: true };
}

/**
 * Recognizes one cue again: its original audio is decoded at 16 kHz into a private file, which the
 * local transcription model reads; the file is removed afterwards whatever happens. The model's
 * profile decides the rest. One with timestamps hears a second of context on each side and only the
 * segments over the cue count; when the context came with the cue's words (a kept segment heard
 * another cue too, or there are no segments to choose from), the cue is heard again with only its
 * padding. One without timestamps (anime-whisper, Belle) hears the cue alone and all of its text
 * counts. A locked language is used and a forbidden prompt left out. The result is reviewed by the
 * transcription rules as the cue's new text, so the dialog can say when to listen first.
 */
export async function recognizeCue(deps: CueRecognizeDependencies, owner: number, request: CueRecognizeRequest,
  guard: () => void = () => {}, signal?: AbortSignal): Promise<CueRecognizeResult> {
  const lane = `${owner}:recognize`;
  const ticket = deps.clipper.claim(lane);
  const abort = () => deps.clipper.cancel(lane);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const doc = (await deps.repository.readSnapshot(request.documentId)).document; guard();
    const range = resolveCueAudioRange(doc, { cueIds: [request.cueId] });
    if (range.truncated || range.endMs - range.startMs > CUE_RECOGNIZE_LIMITS.maxMs) throw new StudioError('limit_exceeded');
    const profile = transcriptionModelProfile(request.modelId), timed = profile.timestamps === 'model';
    const resolved = await deps.media.resolve(request.documentId, guard);
    if (!resolved.media) throw new StudioError('document_unavailable');
    const media = resolved.media;
    const language = transcriptionModelSpeaks(profile, request.language) ? request.language : (profile.languages as readonly string[])[0]!;
    /** The model's answer for the cue heard with `contextMs` on each side (up to `bounds`): its segments with text, in media time. */
    const hear = async (contextMs: number, bounds?: ReturnType<typeof cueRecognizePadBounds>) => {
      const { clipStartMs, clipEndMs } = cueRecognizeClipRange(range, contextMs, doc.origin.format === 'media' ? doc.origin.durationMs : undefined, bounds);
      const decoded = await deps.clipper.decode(lane, ticket, media.path, clipStartMs, clipEndMs, 1, CUE_RECOGNIZE_LIMITS.sampleRate, media.audioOrdinal); guard();
      if (signal?.aborted) throw new StudioError('interrupted');
      if (decoded.kind !== 'wav') throw new StudioError(decoded.reason === 'cancelled' ? 'interrupted' : 'transcription_failed');
      const clip = gainQuietClip(decoded.bytes);
      const file = path.join(deps.workingDirectory, `recognize-${randomUUID()}.wav`);
      try {
        await writeFile(file, clip.bytes, { mode: 0o600, flag: 'wx' }); guard();
        const result = await deps.recognize({ modelId: request.modelId, devicePreference: request.devicePreference ?? 'auto', language,
          ...(request.initialPrompt && profile.prompt === 'allow' ? { initialPrompt: request.initialPrompt } : {}),
          // A gained clip keeps voice padding, as a gained window does; a text-only model hears the clip whole.
          ...(clip.gained && timed ? { vadSpeechPadMs: LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.vadSpeechPadMs } : {}),
          ...(timed ? {} : { noTimestamps: true as const }), filePath: file, ...(signal ? { signal } : {}) });
        guard();
        return { ...result, segments: result.segments.filter(segment => segment.text)
          .map(segment => ({ ...segment, startMs: segment.startMs + clipStartMs, endMs: segment.endMs + clipStartMs })) };
      } finally { await rm(file, { force: true }).catch(() => undefined); }
    };
    /** Where the other cues near it are heard, as they are played; a cue of no length is heard nowhere. */
    const others = doc.cues.filter(cue => cue.id !== request.cueId && cue.timing.startMs < range.endMs + CUE_RECOGNIZE_LIMITS.contextMs
      && (cue.timing.endMs ?? Infinity) > range.startMs - CUE_RECOGNIZE_LIMITS.contextMs)
      .flatMap(cue => { try { return [resolveCueAudioRange(doc, { cueIds: [cue.id] })]; } catch { return []; } });
    // Where all that is heard counts, padding stops at a cue that ends just before this one or starts
    // just after it, or a short neighbour's words would begin or end this cue's text.
    const padBounds = cueRecognizePadBounds(range, others);
    let result = timed ? await hear(CUE_RECOGNIZE_LIMITS.contextMs) : await hear(CUE_RECOGNIZE_LIMITS.padMs, padBounds);
    let kept = timed ? result.segments.filter(segment => segmentBelongsToCue(segment, range)) : result.segments;
    // Context that came with the cue's words cannot be split off: the cue is heard again with only
    // its padding, which stops at the cues around it, and all of that counts.
    if (timed && (result.segments.length ? kept.some(segment => segmentHearsOtherCue(segment, others)) : result.text)) {
      result = await hear(CUE_RECOGNIZE_LIMITS.padMs, padBounds);
      kept = result.segments;
    }
    const text = result.segments.length ? joinSegments(kept) : result.text;
    const confidence = segmentConfidence(kept);
    const index = doc.cues.findIndex(cue => cue.id === request.cueId), cue = doc.cues[index]!, previous = doc.cues[index - 1];
    const reasons = text ? reviewCue({ text, startMs: cue.timing.startMs, endMs: cue.timing.endMs, edited: false,
      language: reviewLanguage(result.language) ?? documentReviewLanguage(doc), ...(confidence === undefined ? {} : { confidence }),
      ...(previous ? { previous: { text: previous.source.plain, startMs: previous.timing.startMs, endMs: previous.timing.endMs } } : {}) }, compressedSize) : [];
    return { text, ...(result.language ? { language: result.language } : {}), ...(confidence === undefined ? {} : { confidence }), reasons };
  } finally { signal?.removeEventListener('abort', abort); }
}
