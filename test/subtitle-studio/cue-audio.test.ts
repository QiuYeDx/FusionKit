import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { readSubtitleWithSource } from '../../electron/main/subtitle-studio/input-service';
import { captureSourceDirectory, captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { CueMediaService, CUE_MEDIA_FILE } from '../../electron/main/subtitle-studio/cue-media-service';
import { CueAudioClipper, readCueAudio, selectCueAudioFfmpeg } from '../../electron/main/subtitle-studio/cue-audio-clip';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import type { CueAudioClip, CueAudioResult } from '../../src/subtitle-studio/cue-audio';

const run = promisify(execFile);
const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
let root: string, media: string, ffmpeg: string;

/** Runs the bundled ffmpeg to build fixtures; the code under test finds it on its own. */
async function make(output: string, ...args: string[]) {
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args, output], { windowsHide: true });
  return output;
}
/** 0–10 s at 440 Hz, then 10–20 s at 880 Hz. */
const twoTones = (output: string, ...codec: string[]) => make(output, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10:sample_rate=48000', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', ...codec);

/** Zero crossings per second, about twice the frequency of a sine. */
function frequency(clip: CueAudioClip, fromMs: number, toMs: number) {
  const samples = new Int16Array(clip.bytes.slice(44).buffer);
  const from = Math.round(fromMs * 48), to = Math.round(toMs * 48);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / ((to - from) / 48000) / 2;
}
const seconds = (clip: CueAudioResult) => clip.kind === 'clip' ? (clip.bytes.length - 44) / 96000 : NaN;
const clip = (value: CueAudioResult) => { if (value.kind !== 'clip') throw new Error(`no clip: ${value.reason}`); return value; };

function services(repositoryRoot = path.join(root, 'documents'), options: Partial<ConstructorParameters<typeof CueAudioClipper>[0]> = {}) {
  const repository = new DocumentRepository(repositoryRoot);
  const mediaService = new CueMediaService(repository);
  const clipper = new CueAudioClipper({ environment, workingDirectory: path.join(root, 'work'), ...options });
  return { repository, media: mediaService, clipper, read: (documentId: string, target: Parameters<typeof readCueAudio>[2]['target'], padMs: 0 | 300 | 1000 = 0, owner = 1) =>
    readCueAudio({ repository, media: mediaService, clipper }, owner, { documentId, target, padMs }) };
}
async function transcribed(s: ReturnType<typeof services>, file: string, durationMs = 20000, segments = [[0, 2000], [9500, 10500], [12000, 14000]]) {
  const doc = transcriptToDocument({ schemaVersion: 1, source: { displayName: path.basename(file), durationMs },
    model: { engine: 'whisper_cpp', modelId: 'm', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
    segments: segments.map(([startMs, endMs], index) => ({ id: `s${index}`, startMs, endMs, text: `line ${index}` })) }, { newId: randomUUID });
  await s.repository.create(doc, undefined, await captureSourceInput(file));
  return doc;
}
async function imported(s: ReturnType<typeof services>, directory: string, name: string, raw: string) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, raw);
  const { document, sourceLocation } = await readSubtitleWithSource(file, 'utf-8');
  await s.repository.create(document, undefined, sourceLocation);
  return document;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-cue-audio-')));
  ffmpeg = selectCueAudioFfmpeg(await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }));
  media = path.join(root, 'media'); await mkdir(media);
  await twoTones(path.join(media, 'tones.wav'));
  await twoTones(path.join(media, 'tones.mkv'), '-c:a', 'aac');
  await twoTones(path.join(media, 'tones.mp3'), '-c:a', 'libmp3lame');
}, 60_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('decoding the original audio of cues', () => {
  it.each(['tones.wav', 'tones.mkv', 'tones.mp3'])('cuts the exact stretch from %s', async name => {
    const s = services();
    const doc = await transcribed(s, path.join(media, name));
    expect(await s.media.status(doc.id)).toEqual({ status: 'ready', via: 'transcription', name });
    // 9.5–10.5 s crosses from the low tone to the high one at its middle.
    const result = clip(await s.read(doc.id, { cueIds: [doc.cues[1].id] }));
    expect(result).toMatchObject({ startMs: 9500, endMs: 10500, clipStartMs: 9500, clipEndMs: 10500, truncated: false, revision: doc.revision });
    expect(seconds(result)).toBeCloseTo(1, 1);
    expect(frequency(result, 50, 450)).toBeGreaterThan(400);
    expect(frequency(result, 50, 450)).toBeLessThan(480);
    expect(frequency(result, 550, 950)).toBeGreaterThan(820);
  }, 30_000);

  it('pads both sides, never before the start, and plays several cues as one stretch', async () => {
    const s = services();
    const doc = await transcribed(s, path.join(media, 'tones.wav'));
    const first = clip(await s.read(doc.id, { cueIds: [doc.cues[0].id] }, 300));
    expect(first).toMatchObject({ clipStartMs: 0, clipEndMs: 2300 });
    expect(seconds(first)).toBeCloseTo(2.3, 2);
    const padded = clip(await s.read(doc.id, { cueIds: [doc.cues[1].id] }, 300));
    expect(seconds(padded)).toBeCloseTo(1.6, 2);
    const span = clip(await s.read(doc.id, { cueIds: [doc.cues[1].id, doc.cues[2].id] }));
    expect(span).toMatchObject({ startMs: 9500, endMs: 14000 });
    expect(seconds(span)).toBeCloseTo(4.5, 2);
    const proposed = clip(await s.read(doc.id, { range: { startMs: 15000, endMs: 15250 } }));
    expect(seconds(proposed)).toBeCloseTo(0.25, 2);
  }, 30_000);

  it.each([0.75, 0.5] as const)('slows a stretch to %sx without changing its pitch', async tempo => {
    const s = services();
    const doc = await transcribed(s, path.join(media, 'tones.mkv'));
    const slow = clip(await readCueAudio({ repository: s.repository, media: s.media, clipper: s.clipper }, 1,
      { documentId: doc.id, target: { cueIds: [doc.cues[1].id] }, padMs: 0, tempo }));
    // 9.5–10.5 s of media plays 1 / tempo seconds; the media read is limited, not the output.
    expect(slow).toMatchObject({ startMs: 9500, endMs: 10500, tempo });
    expect(seconds(slow)).toBeCloseTo(1 / tempo, 1);
    const length = seconds(slow) * 1000;
    expect(frequency(slow, 30, length / 2 - 60)).toBeGreaterThan(400);
    expect(frequency(slow, 30, length / 2 - 60)).toBeLessThan(480);
    expect(frequency(slow, length / 2 + 60, length - 30)).toBeGreaterThan(820);
  }, 30_000);

  it('cuts 4.5 s from 25 minutes into a long file quickly', async () => {
    const s = services();
    const long = await make(path.join(media, 'long.mp3'), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1500', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', '-c:a', 'libmp3lame');
    const doc = await transcribed(s, long, 1510000, [[0, 1000], [1500250, 1504750]]);
    await s.read(doc.id, { cueIds: [doc.cues[0].id] });
    const started = performance.now();
    const result = clip(await s.read(doc.id, { cueIds: [doc.cues[1].id] }));
    const elapsed = performance.now() - started;
    expect(seconds(result)).toBeCloseTo(4.5, 2);
    expect(frequency(result, 100, 4400)).toBeGreaterThan(840);
    expect(elapsed).toBeLessThan(3000);
    console.info(`[cue-audio] 4.5 s at 25:00.250 of a 25-minute MP3 decoded in ${Math.round(elapsed)} ms`);
  }, 60_000);
});

describe('finding the media of a document', () => {
  it('matches the same-named media beside an imported LRC and plays cues without an end until the next one', async () => {
    const s = services(), folder = path.join(root, 'lyrics');
    await mkdir(folder);
    await twoTones(path.join(folder, 'Song.mkv'), '-c:a', 'aac');
    const doc = await imported(s, folder, 'Song.en.lrc', '[00:01.00]first\n[00:04.00]second\n');
    expect(await s.media.status(doc.id)).toEqual({ status: 'ready', via: 'matched', name: 'Song.mkv' });
    const first = clip(await s.read(doc.id, { cueIds: [doc.cues[0].id] }));
    expect(first).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(seconds(first)).toBeCloseTo(3, 1);
    expect(clip(await s.read(doc.id, { cueIds: [doc.cues[1].id] }))).toMatchObject({ startMs: 4000, endMs: 9000 });
  }, 30_000);

  it('does not guess between equally named files, and reports a missing media', async () => {
    const s = services(), folder = path.join(root, 'two');
    await mkdir(folder);
    await writeFile(path.join(folder, 'Show.mkv'), 'x'); await writeFile(path.join(folder, 'Show.mp4'), 'x');
    const doc = await imported(s, folder, 'Show.en.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
    expect(await s.media.status(doc.id)).toEqual({ status: 'missing' });
    expect(await s.read(doc.id, { cueIds: [doc.cues[0].id] })).toEqual({ kind: 'unavailable', reason: 'no_media' });
  });

  it('keeps a chosen file across restarts, prefers it, and falls back when the choice is cleared', async () => {
    const s = services(), folder = path.join(root, 'chosen');
    await mkdir(folder);
    await twoTones(path.join(folder, 'Talk.wav'));
    const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
    const chosen = await twoTones(path.join(elsewhere, 'Recording 1.flac'), '-c:a', 'flac');
    const doc = await imported(s, folder, 'Talk.srt', '1\n00:00:09,500 --> 00:00:10,500\nHello\n');
    expect(await s.media.status(doc.id)).toMatchObject({ via: 'matched', name: 'Talk.wav' });
    expect(await s.media.link(doc.id, chosen)).toEqual({ status: 'ready', via: 'linked', name: 'Recording 1.flac' });
    const reopened = services();
    expect(await reopened.media.status(doc.id)).toEqual({ status: 'ready', via: 'linked', name: 'Recording 1.flac' });
    expect(frequency(clip(await reopened.read(doc.id, { cueIds: [doc.cues[0].id] })), 550, 950)).toBeGreaterThan(820);
    expect(await reopened.media.clear(doc.id)).toMatchObject({ status: 'ready', via: 'matched' });
    await expect(readdir(path.join(root, 'documents', doc.id))).resolves.not.toContain(CUE_MEDIA_FILE);
  }, 30_000);

  it('reports moved or changed media as unavailable instead of playing another file', async () => {
    const s = services(), folder = path.join(root, 'moving');
    await mkdir(folder);
    const file = await twoTones(path.join(folder, 'moving.wav'));
    const doc = await transcribed(s, file);
    await rename(file, `${file}.bak`);
    expect(await s.media.status(doc.id)).toEqual({ status: 'unavailable', via: 'transcription', name: 'moving.wav' });
    expect(await s.read(doc.id, { cueIds: [doc.cues[0].id] })).toEqual({ kind: 'unavailable', reason: 'media_unavailable' });
    const linked = await twoTones(path.join(folder, 'linked.wav'));
    await s.media.link(doc.id, linked);
    await writeFile(linked, 'changed');
    expect(await s.media.status(doc.id)).toEqual({ status: 'unavailable', via: 'linked', name: 'linked.wav' });
  }, 30_000);

  it('keeps the transcribed media when another export folder replaces the source receipt', async () => {
    const s = services(), folder = path.join(root, 'receipt');
    await mkdir(folder);
    const doc = await transcribed(s, await twoTones(path.join(folder, 'kept.wav')));
    await s.media.keepTranscribedMedia(doc.id);
    await s.repository.setSourceLocation(doc.id, await captureSourceDirectory(root));
    expect(await s.media.status(doc.id)).toEqual({ status: 'ready', via: 'linked', name: 'kept.wav' });
  }, 30_000);
});

describe('failures and cancellation', () => {
  it('tells apart media without audio, undecodable files and a missing runtime', async () => {
    const s = services(), folder = path.join(root, 'broken');
    await mkdir(folder);
    const silent = await make(path.join(folder, 'video.mkv'), '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=3:r=10', '-c:v', 'mpeg4');
    const noAudio = await transcribed(s, silent, 3000, [[0, 1000]]);
    expect(await s.read(noAudio.id, { cueIds: [noAudio.cues[0].id] })).toEqual({ kind: 'unavailable', reason: 'no_audio' });
    const corrupt = path.join(folder, 'corrupt.mp3');
    await writeFile(corrupt, Buffer.alloc(4096, 7));
    const broken = await transcribed(s, corrupt, 3000, [[0, 1000]]);
    expect(await s.read(broken.id, { cueIds: [broken.cues[0].id] })).toEqual({ kind: 'unavailable', reason: 'decode_failed' });
    const missingRuntime = services(undefined, { verifyRuntime: async () => { throw new Error('missing'); } });
    const doc = await transcribed(missingRuntime, path.join(media, 'tones.wav'));
    expect(await missingRuntime.read(doc.id, { cueIds: [doc.cues[0].id] })).toEqual({ kind: 'unavailable', reason: 'runtime_unavailable' });
  }, 30_000);

  it('stops an earlier decode for the same window and leaves no files behind', async () => {
    const s = services();
    const doc = await transcribed(s, path.join(media, 'tones.mkv'));
    const earlier = s.read(doc.id, { range: { startMs: 0, endMs: 20000 } }, 0, 7);
    const later = s.read(doc.id, { cueIds: [doc.cues[2].id] }, 0, 7);
    const other = s.read(doc.id, { cueIds: [doc.cues[0].id] }, 0, 8);
    expect(await earlier).toEqual({ kind: 'unavailable', reason: 'cancelled' });
    expect(seconds(await later)).toBeCloseTo(2, 1);
    expect(seconds(await other)).toBeCloseTo(2, 1);
    expect(await readdir(path.join(root, 'work'))).toEqual([]);
  }, 30_000);

  it('decodes a waveform beside playback without stopping it', async () => {
    const s = services();
    const doc = await transcribed(s, path.join(media, 'tones.mkv'));
    const deps = { repository: s.repository, media: s.media, clipper: s.clipper };
    const playing = readCueAudio(deps, 9, { documentId: doc.id, target: { range: { startMs: 0, endMs: 20000 } }, padMs: 0 });
    const waveform = readCueAudio(deps, 9, { documentId: doc.id, target: { cueIds: [doc.cues[1].id] }, padMs: 0, purpose: 'waveform' });
    expect(seconds(await playing)).toBeCloseTo(20, 1);
    expect(seconds(await waveform)).toBeCloseTo(1, 1);
  }, 30_000);

  it('kills a running decode when the window asks for another stretch', async () => {
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const exits: Array<{ aborted: boolean; exitCode: number | null }> = [];
    const { runLocalSubtitleMediaProcess } = await import('../../electron/main/subtitle-studio/transcription/native/media-process');
    const s = services(undefined, { runProcess: async request => {
      started();
      const result = await runLocalSubtitleMediaProcess({ ...request, args: request.args.map(arg => arg === '-ss' ? '-re' : arg).filter((arg, index, all) => all[index - 1] !== '-re') });
      exits.push({ aborted: result.aborted, exitCode: result.exitCode });
      return result;
    } });
    // -re decodes at playback speed, so the first decode is still running when the second request comes.
    const doc = await transcribed(s, path.join(media, 'tones.wav'));
    const earlier = s.read(doc.id, { range: { startMs: 0, endMs: 20000 } });
    await running;
    const later = s.read(doc.id, { range: { startMs: 0, endMs: 100 } });
    expect(await earlier).toEqual({ kind: 'unavailable', reason: 'cancelled' });
    expect((await later).kind).toBe('clip');
    expect(exits[0]).toMatchObject({ aborted: true });
  }, 30_000);
});
