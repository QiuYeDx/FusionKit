import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCueAudioPlayer, FOLLOW_CHUNK_MS, pcmPeaks, type AudioContextLike, type AudioSourceLike, type CueAudioPlayerDependencies, type CueAudioSettings } from './cue-audio-player';
import type { CueAudioResult, CueAudioTempo, CueAudioUnavailable } from '@/subtitle-studio/cue-audio';
import type { StudioResult } from '@/subtitle-studio/ipc-contract';

const doc = '00000000-0000-4000-8000-000000000001';
const cue = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
/** A decoded stretch of `seconds` of output audio covering media from startMs. */
const clip = (startMs: number, endMs: number, tempo: CueAudioTempo = 1, revision = 1): StudioResult<CueAudioResult> => {
  const samples = Math.round((endMs - startMs) / 1000 / tempo * 48000);
  return { ok: true, value: { kind: 'clip', bytes: new Uint8Array(44 + samples * 2), mimeType: 'audio/wav', revision,
    startMs, endMs, clipStartMs: startMs, clipEndMs: endMs, truncated: false, tempo } };
};

class FakeContext implements AudioContextLike {
  currentTime = 0; destination = {}; outputLatency = 0; state = 'running';
  sources: (AudioSourceLike & { when?: number; stopped: boolean })[] = [];
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    const source = { buffer: null, loop: false, onended: null as (() => void) | null, stopped: false, when: undefined as number | undefined,
      connect: () => undefined, disconnect: () => undefined, start(when?: number) { source.when = when; }, stop() { source.stopped = true; } };
    this.sources.push(source);
    return source;
  }
  async resume() {}
}

function harness(read: CueAudioPlayerDependencies['read'] = async request => 'range' in request.target
  ? clip(request.target.range.startMs, request.target.range.endMs, request.tempo) : clip(1000, 3000, request.tempo)) {
  const context = new FakeContext();
  const frames: Array<() => void> = [];
  const settings: CueAudioSettings = { padMs: 300, tempo: 1, loop: false };
  const problems: string[] = [];
  const reader = vi.fn(read);
  const player = createCueAudioPlayer({ read: reader, settings: () => settings, createContext: () => context,
    frame: callback => frames.push(callback), cancelFrame: () => {}, onMediaProblem: id => problems.push(id) });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  /** Moves the audio clock and runs the frame callbacks queued so far. */
  const advance = async (seconds: number) => { context.currentTime += seconds; for (const run of frames.splice(0)) run(); await flush(); };
  return { player, context, frames, settings, problems, reader, flush, advance };
}
afterEach(() => { vi.useRealTimers(); });

describe('playing one stretch', () => {
  it('plays, reports progress and media position, ends, and stops on a second toggle', async () => {
    const h = harness();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1, rows: [cue(1)] });
    expect(h.player.snapshot()).toMatchObject({ key: 'a', mode: 'clip', phase: 'loading', rows: [cue(1)] });
    await h.flush();
    expect(h.reader).toHaveBeenCalledWith({ documentId: doc, target: { cueIds: [cue(1)] }, padMs: 300, tempo: 1 });
    expect(h.player.snapshot()).toMatchObject({ phase: 'playing' });
    expect(h.context.sources[0].when).toBeCloseTo(0.02);
    await h.advance(1.02);
    expect(h.player.snapshot()).toMatchObject({ progress: 0.5, positionMs: 2000 });
    expect(h.player.positionFor(doc)).toBe(2000);
    h.context.sources[0].onended!();
    expect(h.player.snapshot()).toBeNull();
    expect(h.player.positionFor(doc)).toBeNull();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    await h.flush();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    expect(h.player.snapshot()).toBeNull();
    expect(h.context.sources.at(-1)!.stopped).toBe(true);
  });

  it('converts a slowed stretch back to media time and subtracts the output delay', async () => {
    const h = harness();
    h.settings.tempo = 0.5; h.context.outputLatency = 0.1;
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } });
    await h.flush();
    expect(h.reader).toHaveBeenLastCalledWith(expect.objectContaining({ tempo: 0.5 }));
    // 1.12 s on the clock, 0.1 s still in the output: 1.0 s heard of a 4 s stretch at half speed = 0.5 s of media.
    await h.advance(1.12);
    expect(h.player.positionFor(doc)).toBe(1500);
    expect(h.player.snapshot()!.progress).toBeCloseTo(0.275, 2);
  });

  it('loops until stopped, and turns looping on and off while playing', async () => {
    const h = harness();
    h.settings.loop = true;
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } });
    await h.flush();
    expect(h.context.sources[0].loop).toBe(true);
    await h.advance(2.52);
    expect(h.player.positionFor(doc)).toBe(1500);
    h.settings.loop = false; h.player.applySettings();
    expect(h.context.sources[0].loop).toBe(false);
  });

  it('continues from the current position at a new speed', async () => {
    const h = harness();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } });
    await h.flush(); await h.advance(0.52);
    h.settings.tempo = 0.75; h.player.applySettings();
    await h.flush();
    expect(h.reader).toHaveBeenLastCalledWith({ documentId: doc, target: { range: { startMs: 1500, endMs: 3000 } }, padMs: 0, tempo: 0.75 });
    expect(h.player.snapshot()).toMatchObject({ key: 'a', phase: 'playing' });
    expect(h.context.sources[0].stopped).toBe(true);
  });

  it('switches to a newer request, ignores an earlier answer, and keeps six clips per revision and speed', async () => {
    let answer!: (value: StudioResult<CueAudioResult>) => void;
    const h = harness(vi.fn().mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockImplementation(async () => clip(0, 1000)));
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    h.player.toggle('b', { documentId: doc, target: { cueIds: [cue(2)] }, revision: 1 });
    await h.flush();
    answer(clip(0, 1000)); await h.flush();
    expect(h.player.snapshot()).toMatchObject({ key: 'b' });
    expect(h.context.sources).toHaveLength(1);
    for (let n = 3; n <= 10; n++) { h.player.toggle(`k${n}`, { documentId: doc, target: { cueIds: [cue(n)] }, revision: 1 }); await h.flush(); }
    expect(h.player.cachedClips()).toBe(6);
    const calls = h.reader.mock.calls.length;
    h.player.toggle('again', { documentId: doc, target: { cueIds: [cue(10)] }, revision: 1 }); await h.flush();
    expect(h.reader.mock.calls.length).toBe(calls);
    h.settings.tempo = 0.75;
    h.player.toggle('slow', { documentId: doc, target: { cueIds: [cue(10)] }, revision: 1 }); await h.flush();
    expect(h.reader.mock.calls.length).toBe(calls + 1);
    h.player.invalidate(doc);
    expect(h.player.cachedClips()).toBe(0);
  });

  it('shows why a stretch cannot play, then clears; missing media is reported', async () => {
    vi.useFakeTimers();
    const h = harness(async () => ({ ok: true, value: { kind: 'unavailable', reason: 'no_media' } }));
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } });
    await h.flush();
    expect(h.player.snapshot()).toMatchObject({ phase: 'error', reason: 'no_media' });
    expect(h.problems).toEqual([doc]);
    vi.advanceTimersByTime(4000);
    expect(h.player.snapshot()).toBeNull();
  });
});

describe('playing continuously', () => {
  it('joins stretches end to start, asks for the next one when the last starts, and ends at the media end', async () => {
    const h = harness();
    h.player.follow('follow', { documentId: doc, fromMs: 5000, endMs: 50000 });
    expect(h.player.snapshot()).toMatchObject({ mode: 'follow', phase: 'loading' });
    await h.advance(0);
    expect(h.reader).toHaveBeenCalledTimes(1);
    expect(h.reader).toHaveBeenLastCalledWith({ documentId: doc, target: { range: { startMs: 5000, endMs: 5000 + FOLLOW_CHUNK_MS } }, padMs: 0, tempo: 1 });
    expect(h.player.snapshot()).toMatchObject({ phase: 'playing' });
    // The first stretch starts at once, so the second is asked for and queued right behind it.
    await h.advance(0.03);
    expect(h.reader).toHaveBeenCalledTimes(2);
    const [first, second] = h.context.sources;
    expect(second.when).toBeCloseTo(first.when! + 20);
    // Not before the second starts is the third asked for.
    await h.advance(10);
    expect(h.reader).toHaveBeenCalledTimes(2);
    expect(h.player.snapshot()!.positionMs).toBe(15010);
    await h.advance(10);
    expect(h.reader).toHaveBeenCalledTimes(3);
    expect(h.reader).toHaveBeenLastCalledWith(expect.objectContaining({ target: { range: { startMs: 45000, endMs: 50000 } } }));
    const third = h.context.sources[2];
    expect(third.when).toBeCloseTo(second.when! + 20);
    // The media ends at 50 s: nothing more is asked for and playback ends after the last stretch.
    await h.advance(20);
    expect(h.reader).toHaveBeenCalledTimes(3);
    await h.advance(5);
    expect(h.player.snapshot()).toBeNull();
  });

  it('ends when the main process finds no more audio, and stops on the same key', async () => {
    const h = harness(async request => 'range' in request.target && request.target.range.startMs >= 20000
      ? { ok: true, value: { kind: 'unavailable', reason: 'no_audio' } } : clip(0, 20000));
    h.player.follow('follow', { documentId: doc, fromMs: 0 });
    await h.advance(0); await h.advance(0.03);
    expect(h.reader).toHaveBeenCalledTimes(2);
    expect(h.player.snapshot()).toMatchObject({ phase: 'playing' });
    await h.advance(20.1);
    expect(h.player.snapshot()).toBeNull();
    h.player.follow('follow', { documentId: doc, fromMs: 0 }); await h.advance(0);
    h.player.follow('follow', { documentId: doc, fromMs: 0 });
    expect(h.player.snapshot()).toBeNull();
  });

  it('waits for a late stretch, then goes on from where it stopped', async () => {
    let late!: (value: StudioResult<CueAudioResult>) => void;
    const h = harness(vi.fn().mockImplementationOnce(async () => clip(0, 20000))
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve; })).mockImplementation(async () => clip(40000, 60000)));
    h.player.follow('follow', { documentId: doc, fromMs: 0, endMs: 60000 });
    await h.advance(0); await h.advance(0.03);
    await h.advance(20.5);
    expect(h.player.snapshot()).toMatchObject({ phase: 'loading' });
    late(clip(20000, 40000)); await h.flush();
    const second = h.context.sources[1];
    expect(second.when).toBeCloseTo(h.context.currentTime + 0.02);
    await h.advance(0.03);
    expect(h.player.snapshot()).toMatchObject({ phase: 'playing' });
  });

  it('restarts from the current position at a new speed', async () => {
    const h = harness();
    h.player.follow('follow', { documentId: doc, fromMs: 0, endMs: 100000 });
    await h.advance(0); await h.advance(0.03); await h.advance(3);
    h.settings.tempo = 0.5; h.player.applySettings();
    await h.advance(0);
    expect(h.reader).toHaveBeenLastCalledWith(expect.objectContaining({ target: { range: { startMs: 3010, endMs: 23010 } }, tempo: 0.5 }));
    expect(h.context.sources.slice(0, 2).every(source => source.stopped)).toBe(true);
    expect(h.player.snapshot()).toMatchObject({ key: 'follow', mode: 'follow' });
  });
});

describe('waveforms', () => {
  it('folds sound and silence into peaks and asks beside playback', async () => {
    // 1 s: 0.5 s of a loud tone, then 0.5 s of silence.
    const samples = new Int16Array(48000).map((_, i) => i < 24000 ? Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 16000) : 0);
    const bytes = new Uint8Array(44 + samples.byteLength); bytes.set(new Uint8Array(samples.buffer), 44);
    const peaks = pcmPeaks(bytes, 10);
    expect(peaks[1]).toBeGreaterThan(0.45); expect(peaks[0]).toBeLessThan(-0.45);
    expect(peaks[19]).toBe(0); expect(peaks[18]).toBe(0);
    const h = harness(async () => ({ ok: true, value: { kind: 'clip', bytes, mimeType: 'audio/wav', revision: 1, startMs: 4000, endMs: 5000, clipStartMs: 4000, clipEndMs: 5000, truncated: false, tempo: 1 } }));
    const first = await h.player.peaks({ documentId: doc, revision: 1, startMs: 4000, endMs: 5000 }, 10);
    expect(h.reader).toHaveBeenCalledWith({ documentId: doc, target: { range: { startMs: 4000, endMs: 5000 } }, padMs: 0, tempo: 1, purpose: 'waveform' });
    expect(first).toMatchObject({ startMs: 4000, endMs: 5000 });
    await h.player.peaks({ documentId: doc, revision: 1, startMs: 4000, endMs: 5000 }, 10);
    expect(h.reader).toHaveBeenCalledTimes(1);
    // Asking for a waveform leaves what plays alone.
    expect(h.player.snapshot()).toBeNull();
  });

  it('hands back a kept waveform without reading, and reports media that went missing', async () => {
    const h = harness();
    const request = { documentId: doc, revision: 1, startMs: 4000, endMs: 5000 };
    expect(h.player.knownPeaks(request, 10)).toBeUndefined();
    const first = await h.player.peaks(request, 10);
    expect(h.player.knownPeaks(request, 10)).toBe(first);
    expect(h.player.knownPeaks({ ...request, revision: 2 }, 10)).toBeUndefined();
    h.player.invalidate(doc);
    expect(h.player.knownPeaks(request, 10)).toBeUndefined();
    expect(h.reader).toHaveBeenCalledTimes(1);

    const failing = (reason: CueAudioUnavailable) => harness(async () => ({ ok: true, value: { kind: 'unavailable', reason } }));
    const missing = failing('media_unavailable');
    expect(await missing.player.peaks(request, 10)).toBeNull();
    expect(missing.problems).toEqual([doc]);
    // A file that is there but does not decode keeps its status; the waveform is just not shown.
    const undecodable = failing('decode_failed');
    expect(await undecodable.player.peaks(request, 10)).toBeNull();
    expect(undecodable.problems).toEqual([]);
    expect(undecodable.player.knownPeaks(request, 10)).toBeUndefined();
  });
});
