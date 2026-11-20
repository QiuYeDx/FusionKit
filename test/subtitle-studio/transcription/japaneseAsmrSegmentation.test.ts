import { describe, expect, it, vi } from 'vitest';
import { planJapaneseAsmrDecoding, scanJapaneseAsmrTiming } from '../../../electron/main/subtitle-studio/transcription/native/japanese-asmr-segmentation';

const samples = (ms: number) => 16 * ms;

describe('Japanese ASMR segmentation', () => {
  it('joins a speech interval across overlapped windows and trims the padded final frame', async () => {
    const totalFrames = samples(31_000) + 17;
    let windowStart = 0;
    const read = vi.fn(async (start: number, end: number) => { windowStart = start; return new Float32Array(end - start); });
    const infer = async (pcm: Float32Array) => Float32Array.from({ length: Math.ceil(pcm.length / 320) }, (_, frame) => {
      const position = windowStart + frame * 320;
      return position >= samples(27_000) ? 0.9 : 0;
    });
    const progress = vi.fn();
    const result = await scanJapaneseAsmrTiming({ totalFrames, read, infer, progress, signal: new AbortController().signal });
    expect(read.mock.calls).toEqual([[0, samples(30_000)], [samples(25_000), totalFrames]]);
    expect(result).toEqual([{ startFrame: samples(27_000), endFrame: totalFrames, decodeStartFrame: samples(26_880), decodeEndFrame: totalFrames, needsReview: false }]);
    expect(progress.mock.lastCall).toEqual([1]);
  });

  it('takes overlap predictions from the window whose interior contains that frame', async () => {
    let windowStart = 0;
    const totalFrames = samples(32_000);
    const read = async (start: number, end: number) => { windowStart = start; return new Float32Array(end - start); };
    const infer = async (pcm: Float32Array) => Float32Array.from({ length: Math.ceil(pcm.length / 320) }, (_, frame) => {
      const position = windowStart + frame * 320;
      return windowStart === 0 && position >= samples(28_000) ? 0.99 : 0;
    });
    expect(await scanJapaneseAsmrTiming({ totalFrames, read, infer, progress: vi.fn(), signal: new AbortController().signal })).toEqual([]);
  });

  it('pads only within surrounding gaps and flags unbroken speech beyond 20 seconds', () => {
    const first = { startFrame: samples(2_000), endFrame: samples(9_000) };
    const second = { startFrame: samples(9_120), endFrame: samples(11_000) };
    const long = { startFrame: samples(12_000), endFrame: samples(35_000) };
    const plan = planJapaneseAsmrDecoding([first, second, long], samples(38_000));
    expect(plan).toEqual([
      { ...first, decodeStartFrame: samples(1_880), decodeEndFrame: samples(9_060), needsReview: false },
      { ...second, decodeStartFrame: samples(9_060), decodeEndFrame: samples(11_120), needsReview: false },
      { ...long, decodeStartFrame: long.startFrame, decodeEndFrame: long.endFrame, needsReview: true },
    ]);
  });
});
