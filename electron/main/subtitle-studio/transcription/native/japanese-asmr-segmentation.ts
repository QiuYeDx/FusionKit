import { createLocalSubtitleError, LOCAL_SUBTITLE_LIMITS } from '../../../../../src/subtitle-studio/transcription/domain';
import type { JapaneseAsmrSpeechInterval } from '../../../../../src/subtitle-studio/transcription/japanese-asmr-contract';

const SAMPLES_PER_FRAME = 320;
const WINDOW = 480_000;
const OVERLAP = 80_000;
const STEP = WINDOW - OVERLAP;
const CUT = OVERLAP / 2;
const TARGET_SAMPLES = 8 * 16_000;
const MAX_DECODE_SAMPLES = 20 * 16_000;
const MERGE_GAP = 480 * 16;
const CONTEXT = 120 * 16;

export interface JapaneseAsmrDecodeInterval extends JapaneseAsmrSpeechInterval {
  readonly decodeStartFrame: number;
  readonly decodeEndFrame: number;
  readonly needsReview: boolean;
}

/** All returned boundaries are integer PCM samples on the normalized playback timeline. */
export async function scanJapaneseAsmrTiming(input: {
  totalFrames: number;
  read: (start: number, end: number) => Promise<Float32Array>;
  infer: (samples: Float32Array) => Promise<Float32Array>;
  signal: AbortSignal;
  progress: (fraction: number) => void;
}): Promise<JapaneseAsmrDecodeInterval[]> {
  const { totalFrames, signal } = input;
  const intervals: JapaneseAsmrSpeechInterval[] = [];
  let startFrame: number | undefined;
  let lastSpeechEnd = 0;
  function close() {
    if (startFrame === undefined) return;
    if (lastSpeechEnd - startFrame >= 100 * 16) {
      if (intervals.length >= LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments)
        throw createLocalSubtitleError('limit_exceeded', 'Too many ASMR speech intervals.', { stage: 'transcribing' });
      intervals.push({ startFrame, endFrame: lastSpeechEnd });
    }
    startFrame = undefined;
  }
  for (let start = 0; start < totalFrames; start += STEP) {
    signal.throwIfAborted();
    const end = Math.min(totalFrames, start + WINDOW);
    const probabilities = await input.infer(await input.read(start, end));
    signal.throwIfAborted();
    if (probabilities.length !== Math.ceil((end - start) / SAMPLES_PER_FRAME))
      throw createLocalSubtitleError('transcription_failed', 'Unexpected ASMR timing response.', { stage: 'transcribing' });
    const begin = start ? CUT / SAMPLES_PER_FRAME : 0;
    const stop = end === totalFrames ? probabilities.length : (WINDOW - CUT) / SAMPLES_PER_FRAME;
    for (let i = begin; i < stop; i++) {
      const frame = start + i * SAMPLES_PER_FRAME;
      const probability = probabilities[i]!;
      if (startFrame === undefined && probability >= 0.5) startFrame = frame;
      if (startFrame === undefined) continue;
      if (probability >= 0.35) lastSpeechEnd = Math.min(totalFrames, frame + SAMPLES_PER_FRAME);
      else if (frame + SAMPLES_PER_FRAME - lastSpeechEnd >= 180 * 16) close();
    }
    input.progress(Math.min(1, (start + stop * SAMPLES_PER_FRAME) / totalFrames));
    if (end === totalFrames) break;
  }
  close();
  return planJapaneseAsmrDecoding(intervals, totalFrames);
}

export function planJapaneseAsmrDecoding(intervals: readonly JapaneseAsmrSpeechInterval[], totalFrames: number): JapaneseAsmrDecodeInterval[] {
  const lines: JapaneseAsmrSpeechInterval[] = [];
  for (const interval of intervals) {
    const previous = lines.at(-1);
    if (previous && interval.startFrame - previous.endFrame < MERGE_GAP && interval.endFrame - previous.startFrame <= TARGET_SAMPLES) {
      lines[lines.length - 1] = { startFrame: previous.startFrame, endFrame: interval.endFrame };
    } else lines.push(interval);
  }
  return lines.map((line, index) => {
    // Cap extra audio at the midpoint of each gap so neighbouring decodes cannot overlap.
    const left = index === 0 ? 0 : Math.ceil((lines[index - 1]!.endFrame + line.startFrame) / 2);
    const right = index + 1 === lines.length ? totalFrames : Math.ceil((line.endFrame + lines[index + 1]!.startFrame) / 2);
    const spare = MAX_DECODE_SAMPLES - (line.endFrame - line.startFrame);
    const leftPad = Math.max(0, Math.min(CONTEXT, Math.floor(spare / 2), line.startFrame - left));
    const rightPad = Math.max(0, Math.min(CONTEXT, spare - leftPad, right - line.endFrame));
    return { ...line, decodeStartFrame: line.startFrame - leftPad, decodeEndFrame: line.endFrame + rightPad, needsReview: spare < 0 };
  });
}
