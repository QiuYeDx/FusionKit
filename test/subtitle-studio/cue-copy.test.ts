import { describe, expect, it } from 'vitest';
import { buildCueCopyText } from '../../src/services/subtitle-studio/cue-copy';

const cue = { source: 'Original\nSecond line.', target: '译文\n第二行。', startMs: 1250, endMs: 3900 };

describe('explicit subtitle clipboard contents', () => {
  it('keeps source, selected translation and bilingual plain text distinct', () => {
    expect(buildCueCopyText(cue, 'source')).toBe('Original\nSecond line.');
    expect(buildCueCopyText(cue, 'target')).toBe('译文\n第二行。');
    expect(buildCueCopyText(cue, 'bilingual')).toBe('Original\nSecond line.\n译文\n第二行。');
  });
  it('includes only requested timing, preserving the exact known boundaries', () => {
    expect(buildCueCopyText(cue, 'source', true)).toBe('[00:00:01.250 → 00:00:03.900]\nOriginal\nSecond line.');
    expect(buildCueCopyText(cue, 'target', true)).toBe('[00:00:01.250 → 00:00:03.900]\n译文\n第二行。');
    expect(buildCueCopyText(cue, 'bilingual', true)).toBe('[00:00:01.250 → 00:00:03.900]\nOriginal\nSecond line.\n译文\n第二行。');
  });
  it('never invents an end time for LRC and preserves offset-adjusted negative times', () => {
    expect(buildCueCopyText({ ...cue, startMs: -1250, endMs: null }, 'source', true)).toBe('[-00:00:01.250]\nOriginal\nSecond line.');
    expect(buildCueCopyText({ ...cue, startMs: -1250, endMs: 0 }, 'target', true)).toBe('[-00:00:01.250 → 00:00:00.000]\n译文\n第二行。');
  });
  it('does not silently substitute source for unavailable target or bilingual copy', () => {
    for (const target of [undefined, '', ' \n ']) {
      expect(buildCueCopyText({ ...cue, target }, 'target')).toBeNull();
      expect(buildCueCopyText({ ...cue, target }, 'bilingual', true)).toBeNull();
      expect(buildCueCopyText({ ...cue, target }, 'source')).toBe(cue.source);
    }
  });
  it('preserves literal Unicode, markup-like text and whitespace instead of serializing subtitle styling', () => {
    const source = '  <i>literal</i> 🎵\n日本語\t';
    expect(buildCueCopyText({ ...cue, source }, 'source')).toBe(source);
    expect(buildCueCopyText({ ...cue, startMs: 360001234, endMs: null }, 'source', true)).toMatch(/^\[100:00:01.234\]/);
  });
});
