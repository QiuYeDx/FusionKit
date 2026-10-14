import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { suggestCueSplit, defaultInsertTiming, insertTimeProblem, splitHalves, splitOffsetAt } from './cue-split';
import { importSubtitleText } from './formats/import';
import type { SubtitleText } from './domain';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const transcript = (words = true) => transcriptToDocument({ schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 10000 },
  model: { engine: 'whisper_cpp', modelId: 'm', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
  segments: [{ id: 's0', startMs: 1000, endMs: 4000, text: 'Hello there world',
    ...(words ? { words: [{ text: ' Hello', startMs: 1000, endMs: 1500 }, { text: ' there', startMs: 1600, endMs: 2400 }, { text: ' world', startMs: 2600, endMs: 4000 }] } : {}) }] },
{ newId: randomUUID });

describe('suggesting where to split a cue', () => {
  it('splits an untouched transcript cue at the start of the word after the split', () => {
    const doc = transcript();
    const cue = doc.cues[0];
    // "Hello |there world" and "Hello| there world" both start the second half with "there".
    expect(suggestCueSplit(doc, cue.id, 6)).toEqual({ splitMs: 1600, basis: 'words' });
    expect(suggestCueSplit(doc, cue.id, 5)).toEqual({ splitMs: 1600, basis: 'words' });
    expect(suggestCueSplit(doc, cue.id, 12)).toEqual({ splitMs: 2600, basis: 'words' });
  });

  it('falls back to the share of the text before the split', () => {
    const doc = transcript();
    // Inside the first word: its start is the cue's start, so the text share decides.
    expect(suggestCueSplit(doc, doc.cues[0].id, 2)).toEqual({ splitMs: 1350, basis: 'proportional' });
    const plain = transcript(false);
    expect(suggestCueSplit(plain, plain.cues[0].id, 6)).toEqual({ splitMs: 2060, basis: 'proportional' });
    // An edited cue no longer matches its words; one edited and changed back (as by undo) does again.
    const edited = transcript();
    const cue = edited.cues[0] as { sourceRevision: number; source: SubtitleText };
    cue.sourceRevision = 3;
    expect(suggestCueSplit(edited, edited.cues[0].id, 6).basis).toBe('words');
    cue.source = { plain: 'Hello there, world', spans: [{ text: 'Hello there, world', marks: [] }] };
    expect(suggestCueSplit(edited, edited.cues[0].id, 6).basis).toBe('proportional');
  });

  it('uses the next start, or five seconds, for a cue without an end, and refuses splits at either end', () => {
    const lrc = importSubtitleText('[00:01.00]First line\n[00:03.00]Second line\n', { format: 'lrc', displayName: 'a.lrc', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
    expect(lrc.cues[0].timing.endMs).toBeNull();
    expect(suggestCueSplit(lrc, lrc.cues[0].id, 5)).toEqual({ splitMs: 2000, basis: 'proportional' });
    expect(suggestCueSplit(lrc, lrc.cues[1].id, 6)).toEqual({ splitMs: 3000 + Math.round(5000 * 6 / 11 / 10) * 10, basis: 'proportional' });
    // "First line" has ten characters: a split needs text on both sides.
    for (const offset of [0, 10]) expect(() => suggestCueSplit(lrc, lrc.cues[0].id, offset)).toThrow('invalid_input');
    expect(() => suggestCueSplit(lrc, randomUUID(), 3)).toThrow('invalid_input');
  });
});

describe('splitting at words and inserting beside a cue', () => {
  it('finds where the second part starts', () => {
    expect(splitOffsetAt('甲。乙。', '乙')).toBe(2);
    expect(splitOffsetAt('a b a b', 'a')).toBeNull();
    expect(splitOffsetAt('a b a b', 'a', 2)).toBe(4);
    expect(splitOffsetAt('a b a b', 'a', 3)).toBeNull();
    expect(splitOffsetAt('first second', 'first')).toBeNull();
    expect(splitOffsetAt('first second', 'missing')).toBeNull();
    expect(splitHalves('first  second', 6)).toEqual(['first', 'second']);
  });

  it('fills the gap beside a cue and checks inserted times by the main process rules', () => {
    const cues = [{ timing: { startMs: 1000, endMs: 2000 } }, { timing: { startMs: 6000, endMs: 7000 } }];
    expect(defaultInsertTiming(cues, 0, 'after')).toEqual({ startMs: 2000, endMs: 4000 });
    expect(defaultInsertTiming(cues, 1, 'before')).toEqual({ startMs: 4000, endMs: 6000 });
    expect(defaultInsertTiming([{ timing: { startMs: 500, endMs: 900 } }], 0, 'before')).toEqual({ startMs: 0, endMs: 500 });
    const rule = { previousStartMs: 1000, nextStartMs: 6000, allowUnknownEnd: false };
    expect(insertTimeProblem({ ...rule, startMs: 2000, endMs: 3000 })).toBeNull();
    expect(insertTimeProblem({ ...rule, startMs: 500, endMs: 3000 })).toBe('before_previous');
    expect(insertTimeProblem({ ...rule, startMs: 6500, endMs: 7000 })).toBe('after_next');
    expect(insertTimeProblem({ ...rule, startMs: 3000, endMs: 2000 })).toBe('end_before_start');
    expect(insertTimeProblem({ ...rule, startMs: 3000, endMs: null })).toBe('end_required');
    expect(insertTimeProblem({ ...rule, allowUnknownEnd: true, startMs: 3000, endMs: null })).toBeNull();
    expect(insertTimeProblem({ ...rule, startMs: 3000, endMs: 9000, mediaDurationMs: 8000 })).toBe('beyond_media');
  });
});
