import { describe, expect, it } from 'vitest';
import { cueShiftRequestSchemas, cueStretchRatioSchema, decimalRatio, frameRateRatio, shiftProblem, shiftStart, stretchAnchor, stretchProblem, stretchTime } from './cue-shift';

const cue = (id: string, startMs: number, endMs: number | null) => ({ id, timing: { startMs, endMs } });
const cues = [cue('a', 1000, 2000), cue('b', 3000, 4000), cue('c', 5000, null)];

describe('shifting cues', () => {
  it('starts at the given cue or the first one', () => {
    expect(shiftStart(cues)).toBe(0);
    expect(shiftStart(cues, 'b')).toBe(1);
    expect(() => shiftStart(cues, 'missing')).toThrow('invalid_input');
  });

  it('says why the cues cannot move', () => {
    expect(shiftProblem(cues, 0, 1500)).toBeNull();
    expect(shiftProblem(cues, 0, -1000)).toBeNull();
    expect(shiftProblem(cues, 0, -1001)).toBe('negative');
    // A transcript keeps every line within its media, and every line has an end.
    expect(shiftProblem(cues.slice(0, 2), 0, 1000, 5000)).toBeNull();
    expect(shiftProblem(cues.slice(0, 2), 0, 1001, 5000)).toBe('beyond_media');
    expect(shiftProblem(cues, 0, 0, 9000)).toBe('beyond_media');
    // From a later cue it may not pass the start of the cue before it.
    expect(shiftProblem(cues, 1, -2000)).toBeNull();
    expect(shiftProblem(cues, 1, -2001)).toBe('before_previous');
  });

  it('allows a cue that already started before the one ahead of it to move further', () => {
    const unordered = [cue('a', 3000, 4000), cue('b', 1000, 2000)];
    expect(shiftProblem(unordered, 1, -500)).toBeNull();
  });

  it('accepts whole milliseconds up to a day, but not zero', () => {
    const id = '6f1c2e4a-8b3d-4c5e-9f7a-1b2c3d4e5f60';
    const request = { documentId: id, revision: 1, deltaMs: 1500 };
    expect(cueShiftRequestSchemas.previewCueShift.safeParse(request).success).toBe(true);
    expect(cueShiftRequestSchemas.previewCueShift.safeParse({ ...request, fromCueId: id }).success).toBe(true);
    for (const deltaMs of [0, 1.5, 86_400_001]) expect(cueShiftRequestSchemas.previewCueShift.safeParse({ ...request, deltaMs }).success).toBe(false);
    expect(cueShiftRequestSchemas.previewCueShift.safeParse({ ...request, extra: true }).success).toBe(false);
  });
});

describe('stretching cues', () => {
  it('converts frame rates with exact fractions', () => {
    expect(frameRateRatio('25', '23.976')).toEqual({ num: 1001, den: 960 });
    expect(frameRateRatio('23.976', '25')).toEqual({ num: 960, den: 1001 });
    // 29.97 = 30000/1001: 30000/1001 ÷ 25 = 1200/1001.
    expect(frameRateRatio('29.97', '25')).toEqual({ num: 1200, den: 1001 });
    expect(frameRateRatio('24', '25')).toEqual({ num: 24, den: 25 });
  });

  it('reads a typed ratio with up to six decimals', () => {
    expect(decimalRatio('1.0427')).toEqual({ num: 10427, den: 10000 });
    expect(decimalRatio(' 0.96 ')).toEqual({ num: 24, den: 25 });
    expect(decimalRatio('1.1234567')).toBeNull();
    expect(decimalRatio('abc')).toBeNull();
    expect(decimalRatio('0')).toBeNull();
  });

  it('accepts ratios between half and twice, never 1', () => {
    const ratio = cueStretchRatioSchema;
    expect(ratio.safeParse({ num: 1001, den: 960 }).success).toBe(true);
    expect(ratio.safeParse({ num: 1, den: 2 }).success).toBe(true);
    expect(ratio.safeParse({ num: 2, den: 1 }).success).toBe(true);
    expect(ratio.safeParse({ num: 2, den: 5 }).success).toBe(false);
    expect(ratio.safeParse({ num: 5, den: 2 }).success).toBe(false);
    expect(ratio.safeParse({ num: 7, den: 7 }).success).toBe(false);
  });

  it('stretches around an anchor and only stops a transcript past its media', () => {
    expect(stretchTime(10_000, 0, { num: 1001, den: 960 })).toBe(10_427);
    expect(stretchTime(3_600_000, 0, { num: 1001, den: 960 })).toBe(3_753_750);
    expect(stretchTime(3000, 3000, { num: 24, den: 25 })).toBe(3000);
    expect(stretchTime(5000, 3000, { num: 24, den: 25 })).toBe(4920);
    expect(stretchAnchor(cues, 0)).toBe(0);
    expect(stretchAnchor(cues, 1, 'b')).toBe(3000);
    expect(stretchProblem(cues, 0, { num: 2, den: 1 }, 0)).toBeNull();
    expect(stretchProblem(cues.slice(0, 2), 0, { num: 2, den: 1 }, 0, 8000)).toBeNull();
    expect(stretchProblem(cues.slice(0, 2), 0, { num: 2, den: 1 }, 0, 7999)).toBe('beyond_media');
  });
});
