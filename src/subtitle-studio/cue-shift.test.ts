import { describe, expect, it } from 'vitest';
import { cueShiftRequestSchemas, shiftProblem, shiftStart } from './cue-shift';

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
