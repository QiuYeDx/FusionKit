import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCueAudioPlayer, type CueAudioPlayerDependencies } from './cue-audio-player';
import type { CueAudioResult } from '@/subtitle-studio/cue-audio';
import type { StudioResult } from '@/subtitle-studio/ipc-contract';

const doc = '00000000-0000-4000-8000-000000000001';
const cue = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const clip = (revision = 1): StudioResult<CueAudioResult> => ({ ok: true, value: { kind: 'clip', bytes: new Uint8Array(48), mimeType: 'audio/wav', revision,
  startMs: 0, endMs: 1000, clipStartMs: 0, clipEndMs: 1000, truncated: false } });

function harness(read: CueAudioPlayerDependencies['read'] = async () => clip()) {
  const audio = { src: '', currentTime: 0, duration: 2, play: vi.fn(async () => {}), pause: vi.fn(), listeners: new Map<string, () => void>(),
    addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); } };
  const frames: Array<() => void> = [];
  const urls: string[] = [], revoked: string[] = [];
  const problems: string[] = [];
  const reader = vi.fn(read);
  const player = createCueAudioPlayer({ read: reader, padMs: () => 300, createAudio: () => audio as never,
    createUrl: () => { urls.push(`blob:${urls.length}`); return urls.at(-1)!; }, revokeUrl: url => { revoked.push(url); },
    frame: callback => frames.push(callback), cancelFrame: () => {}, onMediaProblem: id => problems.push(id) });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { player, audio, frames, urls, revoked, problems, reader, flush };
}
afterEach(() => { vi.useRealTimers(); });

describe('the cue audio player', () => {
  it('loads, plays with progress, ends, and stops on a second toggle', async () => {
    const h = harness();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1, rows: [cue(1)] });
    expect(h.player.snapshot()).toMatchObject({ key: 'a', phase: 'loading', rows: [cue(1)] });
    await h.flush();
    expect(h.reader).toHaveBeenCalledWith({ documentId: doc, target: { cueIds: [cue(1)] }, padMs: 300 });
    expect(h.player.snapshot()).toMatchObject({ phase: 'playing', progress: 0 });
    h.audio.currentTime = 1; h.frames.shift()!();
    expect(h.player.snapshot()?.progress).toBe(0.5);
    h.audio.listeners.get('ended')!();
    expect(h.player.snapshot()).toBeNull();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    await h.flush();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    expect(h.player.snapshot()).toBeNull();
    expect(h.audio.pause).toHaveBeenCalled();
  });

  it('switches to a newer clip and ignores the answer to an earlier one', async () => {
    let answer!: (value: StudioResult<CueAudioResult>) => void;
    const h = harness(vi.fn().mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockImplementation(async () => clip()));
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    h.player.toggle('b', { documentId: doc, target: { cueIds: [cue(2)] }, revision: 1 });
    await h.flush();
    expect(h.player.snapshot()).toMatchObject({ key: 'b', phase: 'playing' });
    answer(clip()); await h.flush();
    expect(h.player.snapshot()).toMatchObject({ key: 'b' });
    expect(h.audio.play).toHaveBeenCalledTimes(1);
  });

  it('keeps six clips, releases older ones, and asks again for a new revision or media', async () => {
    const h = harness();
    for (let n = 1; n <= 10; n++) { h.player.toggle(`k${n}`, { documentId: doc, target: { cueIds: [cue(n)] }, revision: 1 }); await h.flush(); }
    expect(h.player.cachedClips()).toBe(6);
    expect(h.revoked).toEqual(['blob:0', 'blob:1', 'blob:2', 'blob:3']);
    h.player.toggle('again', { documentId: doc, target: { cueIds: [cue(10)] }, revision: 1 }); await h.flush();
    expect(h.reader).toHaveBeenCalledTimes(10);
    h.player.toggle('edited', { documentId: doc, target: { cueIds: [cue(10)] }, revision: 2 }); await h.flush();
    expect(h.reader).toHaveBeenCalledTimes(11);
    h.player.invalidate(doc);
    expect(h.player.cachedClips()).toBe(0);
    // Callers that do not know the revision never reuse or keep a clip.
    h.player.toggle('other', { documentId: doc, target: { cueIds: [cue(3)] } }); await h.flush();
    h.player.toggle('other2', { documentId: doc, target: { cueIds: [cue(3)] } }); await h.flush();
    expect(h.player.cachedClips()).toBe(0);
    expect(h.revoked).toContain(h.urls.at(-2));
  });

  it('shows why a clip cannot play, then clears; missing media is reported for a fresh status', async () => {
    vi.useFakeTimers();
    const h = harness(async () => ({ ok: true, value: { kind: 'unavailable', reason: 'no_media' } }));
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] }, revision: 1 });
    await h.flush();
    expect(h.player.snapshot()).toMatchObject({ phase: 'error', reason: 'no_media' });
    expect(h.problems).toEqual([doc]);
    vi.advanceTimersByTime(4000);
    expect(h.player.snapshot()).toBeNull();
    const failing = harness(async () => ({ ok: false, error: 'access_denied' }));
    failing.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } }); await failing.flush();
    expect(failing.player.snapshot()).toMatchObject({ phase: 'error', reason: 'failed' });
    // An error retries on the next toggle instead of stopping.
    failing.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } });
    expect(failing.player.snapshot()).toMatchObject({ phase: 'loading' });
  });

  it('stops only for the given document', async () => {
    const h = harness();
    h.player.toggle('a', { documentId: doc, target: { cueIds: [cue(1)] } }); await h.flush();
    h.player.stopFor('00000000-0000-4000-8000-000000000999');
    expect(h.player.snapshot()).not.toBeNull();
    h.player.stopFor(doc);
    expect(h.player.snapshot()).toBeNull();
  });
});
