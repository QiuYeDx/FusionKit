import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { suggestCueSplit } from './cue-split';
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
