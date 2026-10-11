import { describe, expect, it } from 'vitest';
import type { SubtitleDocument } from './domain';
import { CUE_AUDIO_LIMITS, cueAudioRequestSchemas, isCueMediaFileName, matchSiblingMedia, paddedCueAudioRange, pcm16WavHeader, resolveCueAudioRange } from './cue-audio';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
const textDoc = (timings: [number, number | null][]) => ({
  schemaVersion: 1, id: id(99), revision: 3, origin: { format: 'lrc', displayName: 'a.lrc', encoding: 'utf-8', digest: '0'.repeat(64) },
  cues: timings.map(([startMs, endMs], index) => ({ id: id(index + 1), sourceRevision: 1, timingRevision: 1, timing: { startMs, endMs, provenance: 'lrc_offset' }, source: text(`line ${index}`), nodeId: id(index + 50) })),
}) as unknown as SubtitleDocument;
const mediaDoc = (timings: [number, number][], durationMs: number) => ({
  schemaVersion: 2, id: id(98), revision: 1, origin: { format: 'media', displayName: 'a.mkv', durationMs, transcriptDigest: '0'.repeat(64) },
  cues: timings.map(([startMs, endMs], index) => ({ id: id(index + 1), sourceRevision: 1, timingRevision: 1, timing: { startMs, endMs, provenance: 'transcription' }, source: text(`line ${index}`), segmentId: `s${index}` })),
}) as unknown as SubtitleDocument;

describe('finding media beside a subtitle', () => {
  it('matches the same name, then the name without language or version tags', () => {
    expect(matchSiblingMedia('Show.S01E01.srt', ['Show.S01E01.mkv', 'Show.S01E01.srt', 'notes.txt'])).toBe('Show.S01E01.mkv');
    expect(matchSiblingMedia('Show.S01E01.en.srt', ['Show.S01E01.mkv'])).toBe('Show.S01E01.mkv');
    expect(matchSiblingMedia('Show.S01E01.zh-CN.forced.ass', ['Show.S01E01.mp4'])).toBe('Show.S01E01.mp4');
    expect(matchSiblingMedia('Movie.chs.lrc', ['movie.FLAC'])).toBe('movie.FLAC');
  });
  it('prefers the closer name and refuses to guess between equal ones', () => {
    expect(matchSiblingMedia('Song.en.lrc', ['Song.en.mp3', 'Song.mp3'])).toBe('Song.en.mp3');
    expect(matchSiblingMedia('Show.en.srt', ['Show.mkv', 'Show.mp4'])).toBeNull();
    // Three tags are too many to be sure the remaining name is the media's.
    expect(matchSiblingMedia('Show.en.sdh.forced.srt', ['Show.mkv'])).toBeNull();
  });
  it('does not treat episode marks as tags or other files as media', () => {
    expect(matchSiblingMedia('Show.S01E02.srt', ['Show.mkv', 'Show.S01E01.mkv'])).toBeNull();
    expect(matchSiblingMedia('Talk.srt', ['Talk.txt', 'Talk.srt', 'Talk.mkv.part'])).toBeNull();
    expect(isCueMediaFileName('a.WMA')).toBe(true);
    expect(isCueMediaFileName('wav')).toBe(false);
  });
  it('gives up in very large folders', () => {
    const entries = Array.from({ length: CUE_AUDIO_LIMITS.siblingEntries + 1 }, (_, index) => `${index}.mp3`);
    expect(matchSiblingMedia('1.srt', entries)).toBeNull();
  });
});

describe('the stretch a request plays', () => {
  it('plays a cue, and several cues as one stretch', () => {
    const doc = textDoc([[1000, 2500], [3000, 4000], [3500, 3900], [9000, 9500]]);
    expect(resolveCueAudioRange(doc, { cueIds: [id(1)] })).toEqual({ startMs: 1000, endMs: 2500, truncated: false });
    expect(resolveCueAudioRange(doc, { cueIds: [id(1), id(3)] })).toEqual({ startMs: 1000, endMs: 4000, truncated: false });
    // Given last first, the stretch still runs in document order.
    expect(resolveCueAudioRange(doc, { cueIds: [id(4), id(2)] })).toEqual({ startMs: 3000, endMs: 9500, truncated: false });
  });
  it('plays a cue without an end until a later cue starts, or for five seconds', () => {
    const doc = textDoc([[1000, null], [1000, null], [4000, null]]);
    expect(resolveCueAudioRange(doc, { cueIds: [id(1)] }).endMs).toBe(4000);
    expect(resolveCueAudioRange(doc, { cueIds: [id(3)] }).endMs).toBe(4000 + CUE_AUDIO_LIMITS.unknownEndMs);
  });
  it('keeps within the media and the clip limit', () => {
    const doc = mediaDoc([[0, 2000], [5000, 400000]], 300000);
    expect(resolveCueAudioRange(doc, { range: { startMs: 299000, endMs: 310000 } })).toEqual({ startMs: 299000, endMs: 300000, truncated: false });
    expect(resolveCueAudioRange(doc, { cueIds: [id(2)] })).toEqual({ startMs: 5000, endMs: 5000 + CUE_AUDIO_LIMITS.clipMs, truncated: true });
    expect(() => resolveCueAudioRange(doc, { range: { startMs: 300000, endMs: 301000 } })).toThrow('invalid_input');
  });
  it('starts negative times at zero and rejects unknown cues', () => {
    const doc = textDoc([[-500, 800]]);
    expect(resolveCueAudioRange(doc, { cueIds: [id(1)] })).toMatchObject({ startMs: 0, endMs: 800 });
    expect(() => resolveCueAudioRange(doc, { cueIds: [id(7)] })).toThrow('invalid_input');
  });
  it('pads both sides without going before the start', () => {
    expect(paddedCueAudioRange({ startMs: 200, endMs: 1200, truncated: false }, 300)).toEqual({ clipStartMs: 0, clipEndMs: 1500 });
    expect(paddedCueAudioRange({ startMs: 5000, endMs: 6000, truncated: false }, 1000)).toEqual({ clipStartMs: 4000, clipEndMs: 7000 });
  });
});

describe('requests and the wave header', () => {
  it('accepts one or two cues or a forward range, and known paddings only', () => {
    const parse = (value: unknown) => cueAudioRequestSchemas.readCueAudio.safeParse(value).success;
    expect(parse({ documentId: id(1), target: { cueIds: [id(2)] }, padMs: 300 })).toBe(true);
    expect(parse({ documentId: id(1), target: { cueIds: [id(2), id(3)] }, padMs: 0 })).toBe(true);
    expect(parse({ documentId: id(1), target: { cueIds: [id(2), id(3), id(4)] }, padMs: 0 })).toBe(false);
    expect(parse({ documentId: id(1), target: { range: { startMs: 10, endMs: 10 } }, padMs: 0 })).toBe(false);
    expect(parse({ documentId: id(1), target: { range: { startMs: 10, endMs: 20.5 } }, padMs: 0 })).toBe(false);
    expect(parse({ documentId: id(1), target: { cueIds: [id(2)] }, padMs: 500 })).toBe(false);
  });
  it('describes 16-bit PCM', () => {
    const view = new DataView(pcm16WavHeader(96000, 48000, 1).buffer);
    expect(view.getUint32(4, true)).toBe(96036);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000);
    expect(view.getUint32(40, true)).toBe(96000);
  });
});
