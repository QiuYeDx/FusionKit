import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { readSubtitleWithSource } from '../../electron/main/subtitle-studio/input-service';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { CueMediaService } from '../../electron/main/subtitle-studio/cue-media-service';
import { CueAudioClipper } from '../../electron/main/subtitle-studio/cue-audio-clip';
import { cueRecognizeClipRange, cueRecognizePadBounds, recognizeCue, segmentBelongsToCue, segmentHearsOtherCue } from '../../electron/main/subtitle-studio/cue-recognize-service';
import { transcriptionIpcError } from '../../electron/main/subtitle-studio/transcription-ipc';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION, type LocalSubtitleServerInferenceRequest, type LocalSubtitleServerRawSegment } from '../../electron/main/subtitle-studio/transcription/native/server-contract';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../src/subtitle-studio/transcription/domain';
import type { SpeechResourceService } from '../../electron/main/speech-resources/service';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { cueRecognizeRequestSchemas } from '../../src/subtitle-studio/cue-recognize-contract';
import type { LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { runtimeFixture } from './helpers/transcription-runtime';
import { createTranscriptionRuntime, type RecognizeClipRequest } from '../../electron/main/subtitle-studio/transcription/runtime';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const OWNER = { webContentsId: 61, ownerSessionId: 'recognize-owner' };
const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
let root: string;

/** A WAV of `seconds` at `rate`: a tone at about -24 dBFS, or `amplitude` for a quieter one. */
async function tone(file: string, seconds: number, rate = 48000, amplitude = 3000) {
  const samples = new Int16Array(rate * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * amplitude));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, rate, 1), new Uint8Array(samples.buffer)]));
  return file;
}
function services() {
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const workingDirectory = path.join(root, 'work');
  return { repository, workingDirectory, media: new CueMediaService(repository), clipper: new CueAudioClipper({ environment, workingDirectory }) };
}
async function transcribed(s: ReturnType<typeof services>, file: string, durationMs: number, segments: [number, number][], texts: string[] = []) {
  const doc = transcriptToDocument({ schemaVersion: 1, source: { displayName: path.basename(file), durationMs },
    model: { engine: 'whisper_cpp', modelId: 'm', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
    segments: segments.map(([startMs, endMs], index) => ({ id: `s${index}`, startMs, endMs, text: texts[index] ?? `line ${index}` })) }, { newId: randomUUID });
  await s.repository.create(doc, undefined, await captureSourceInput(file));
  return doc;
}
/** A segment as the server contract gives it, in clip time; its confidence is exp(avg) × (1 − no-speech). */
const segment = (startMs: number, endMs: number, text: string, averageLogProbability = -0.05, noSpeechProbability = 0) =>
  ({ id: 0, startMs, endMs, text, temperature: 0, averageLogProbability, noSpeechProbability });
/** The model's answer: the segments' text, as whisper-server joins them. */
const heard = (...segments: ReturnType<typeof segment>[]) => ({ text: segments.map(item => item.text).join(''), language: 'japanese', segments });
/** RMS of a 16-bit WAV's samples in dBFS. */
const levelDb = (bytes: Buffer) => {
  let energy = 0;
  for (let offset = 44; offset < bytes.length; offset += 2) energy += (bytes.readInt16LE(offset) / 32768) ** 2;
  return 10 * Math.log10(energy / ((bytes.length - 44) / 2));
};

beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-cue-recognize-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('recognizing a cue again', () => {
  it('hands the model a 16 kHz clip of the cue with a second of context on each side, then removes it', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'media', 'talk.wav'), 12), 12000, [[500, 1500], [9500, 10500], [11500, 12000]]);
    await mkdir(s.workingDirectory, { recursive: true });
    const seen: { file: string; header: Buffer; size: number; request: object }[] = [];
    const recognize = vi.fn(async (request: RecognizeClipRequest) => {
      const bytes = await readFile(request.filePath);
      seen.push({ file: request.filePath, header: bytes.subarray(0, 44), size: bytes.length, request });
      return heard(segment(1000, 2000, '先輩、おはようございます。'));
    });
    const result = await recognizeCue({ ...s, recognize }, 1,
      { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'large-v3-q5_0', language: 'ja', devicePreference: 'cpu', initialPrompt: '先輩' });
    expect(result).toEqual({ text: '先輩、おはようございます。', language: 'japanese', confidence: 0.951, reasons: [] });
    expect(seen[0].request).toEqual({ modelId: 'large-v3-q5_0', language: 'ja', devicePreference: 'cpu', initialPrompt: '先輩', filePath: seen[0].file });
    // 9.5–10.5 s plus 1 s on each side, mono 16-bit at 16 kHz.
    expect(seen[0].header.readUInt32LE(24)).toBe(16000);
    expect(seen[0].header.readUInt16LE(22)).toBe(1);
    expect((seen[0].size - 44) / 32000).toBeCloseTo(3, 2);
    expect(path.dirname(seen[0].file)).toBe(s.workingDirectory);
    expect(await readdir(s.workingDirectory)).toEqual([]);
    // Near the start and the end of the media the context is shorter: 0–2.5 s and 10.5–12 s.
    await recognizeCue({ ...s, recognize }, 1, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'large-v3-q5_0', language: 'ja' });
    await recognizeCue({ ...s, recognize }, 1, { documentId: doc.id, cueId: doc.cues[2].id, modelId: 'large-v3-q5_0', language: 'ja' });
    expect(seen.slice(1).map(item => (item.size - 44) / 32000)).toEqual([2.5, 1.5]);
    // Context and cue together stay within the 30 s the server takes.
    expect(cueRecognizeClipRange({ startMs: 5000, endMs: 34_000 }, 1000, 60_000)).toEqual({ clipStartMs: 4500, clipEndMs: 34_500 });
    expect(cueRecognizeClipRange({ startMs: 0, endMs: 29_500 }, 1000)).toEqual({ clipStartMs: 0, clipEndMs: 30_000 });
    expect(cueRecognizeClipRange({ startMs: 0, endMs: 30_000 }, 200)).toEqual({ clipStartMs: 0, clipEndMs: 30_000 });
    // Padding stops at the cues around it: none before an abutting cue, 100 ms before one that starts 100 ms later.
    expect(cueRecognizeClipRange({ startMs: 2000, endMs: 3000 }, 200, 60_000, { notBeforeMs: 2000, notAfterMs: 3100 })).toEqual({ clipStartMs: 2000, clipEndMs: 3100 });
    expect(cueRecognizeClipRange({ startMs: 2000, endMs: 3000 }, 200, 60_000, { notBeforeMs: 1500 })).toEqual({ clipStartMs: 1800, clipEndMs: 3200 });
    expect(cueRecognizePadBounds({ startMs: 2000, endMs: 3000 }, [{ startMs: 1000, endMs: 2000 }, { startMs: 3100, endMs: 4000 }, { startMs: 2500, endMs: 3500 }]))
      .toEqual({ notBeforeMs: 2000, notAfterMs: 3100 });
    expect(cueRecognizePadBounds({ startMs: 2000, endMs: 3000 }, [])).toEqual({});
  }, 30_000);

  it('keeps only the segments over the cue: the context around it, or a neighbour heard with it, does not become its text', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'context', 'talk.wav'), 8), 8000, [[1000, 2400], [2500, 3500], [3600, 6000]],
      ['まだ朝なのに。', 'ん?なんですか?', '君は白鸽だから?']);
    // The clip is 1.5–4.5 s; the cue is 1.0–2.0 s in it.
    const answers = [
      // The neighbours on both sides, one reaching into the cue's margin: only the cue's own segment counts.
      heard(segment(0, 1150, 'まだ朝なのに。'), segment(1180, 1950, 'ん？なんですか？'), segment(2050, 3000, '君は')),
      // Two segments over the cue are joined without a space in Japanese; one off by 300 ms still counts,
      // reaching 200 ms into the line before.
      heard(segment(700, 1500, 'ん？'), segment(1500, 2100, 'なんですか？')),
      // A segment that spans the cue and the line before cannot be split: the cue is heard again
      // alone, 2.3–3.7 s, and all of that counts.
      heard(segment(0, 2000, '朝なのに。ん？なんですか？')), heard(segment(0, 1400, 'ん？なんですか？')),
      // Text without segments to choose from is heard again alone too.
      { text: 'まだ朝なのに。ん？なんですか？', language: 'japanese', segments: [] }, heard(segment(150, 1250, 'ん？なんですか？')),
      // Only context: nothing over the cue is no speech.
      heard(segment(0, 900, 'まだ朝なのに。'), segment(2300, 3000, '君は')),
    ];
    const seconds: number[] = [];
    const recognize = vi.fn(async (request: RecognizeClipRequest) => {
      seconds.push(Math.round(((await readFile(request.filePath)).length - 44) / 3200) / 10);
      return answers.shift()!;
    });
    const texts: string[] = [];
    for (let index = 0; index < 5; index++)
      texts.push((await recognizeCue({ ...s, recognize }, 2, { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'large-v3', language: 'ja' })).text);
    expect(texts).toEqual(['ん？なんですか？', 'ん？なんですか？', 'ん？なんですか？', 'ん？なんですか？', '']);
    // Heard again alone, the padding stops at the cues around it: 2.4–3.6 s, not 2.3–3.7 s.
    expect(seconds).toEqual([3, 3, 3, 1.2, 3, 1.2, 3]);
    expect(segmentBelongsToCue({ startMs: 0, endMs: 1150 }, { startMs: 1000, endMs: 2000 })).toBe(false);
    expect(segmentBelongsToCue({ startMs: 800, endMs: 1000 }, { startMs: 1000, endMs: 2000 })).toBe(true);
    expect(segmentBelongsToCue({ startMs: 1900, endMs: 1900 }, { startMs: 1000, endMs: 2000 })).toBe(true);
    expect(segmentBelongsToCue({ startMs: 2300, endMs: 2300 }, { startMs: 1000, endMs: 2000 })).toBe(false);
    // Reaching into another cue by its edge is timing; by more, that cue was heard too.
    expect(segmentHearsOtherCue({ startMs: 2200, endMs: 3000 }, [{ startMs: 1000, endMs: 2400 }])).toBe(false);
    expect(segmentHearsOtherCue({ startMs: 2150, endMs: 3000 }, [{ startMs: 1000, endMs: 2400 }, { startMs: 3600, endMs: 6000 }])).toBe(true);
    // Words in scripts with spaces keep one between segments.
    const english = vi.fn(async () => heard(segment(1000, 1500, 'Good'), segment(1500, 2000, 'morning.')));
    expect((await recognizeCue({ ...s, recognize: english }, 2, { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'large-v3', language: 'en' })).text).toBe('Good morning.');
  }, 30_000);

  it('follows the model profile: a text-only model hears the cue alone, in its language and without a prompt', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'anime', 'talk.wav'), 12), 12000, [[1000, 2000], [9500, 10500]]);
    const requests: { request: RecognizeClipRequest; size: number }[] = [];
    const recognize = vi.fn(async (request: RecognizeClipRequest) => {
      requests.push({ request, size: (await readFile(request.filePath)).length });
      // No timestamps: the segment spans the clip, and all of it is the cue's.
      return heard(segment(0, 1400, 'こら、おい、リズム取るな'));
    });
    const result = await recognizeCue({ ...s, recognize }, 3,
      { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'anime-whisper-q8_0', language: 'auto', initialPrompt: '先輩' });
    expect(result.text).toBe('こら、おい、リズム取るな');
    expect(requests[0].request).toEqual({ modelId: 'anime-whisper-q8_0', devicePreference: 'auto', language: 'ja', noTimestamps: true, filePath: requests[0].request.filePath });
    // 9.5–10.5 s plus 0.2 s on each side.
    expect((requests[0].size - 44) / 32000).toBeCloseTo(1.4, 2);
    // Belle is locked to Chinese and may be given a prompt.
    await recognizeCue({ ...s, recognize }, 3, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'belle-large-v3-turbo-zh', language: 'ja', initialPrompt: '泰姆菲尔德' });
    expect(requests[1].request).toMatchObject({ modelId: 'belle-large-v3-turbo-zh', language: 'zh', initialPrompt: '泰姆菲尔德', noTimestamps: true });
    // A model this version does not know keeps everything it was asked.
    await recognizeCue({ ...s, recognize }, 3, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'some-new-model', language: 'ko', initialPrompt: 'x' });
    expect(requests[2].request).toMatchObject({ language: 'ko', initialPrompt: 'x' });
    expect(requests[2].request).not.toHaveProperty('noTimestamps');
  }, 30_000);

  it('keeps a text-only model\'s padding off the cues around the cue, so their words do not join its text', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'abutting', 'talk.wav'), 6), 6000, [[1000, 2000], [2000, 3000], [3100, 4000]]);
    const sizes: number[] = [];
    const recognize = vi.fn(async (request: RecognizeClipRequest) => {
      sizes.push((await readFile(request.filePath)).length);
      return heard(segment(0, 1100, 'あのね'));
    });
    await recognizeCue({ ...s, recognize }, 3, { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'anime-whisper-q8_0', language: 'ja' });
    // 2.0–3.0 s: nothing before the abutting cue, 0.1 s up to the next one.
    expect((sizes[0] - 44) / 32000).toBeCloseTo(1.1, 2);
  }, 30_000);

  it('gains a quiet clip and sends it with voice padding, as a gained transcription window', async () => {
    const s = services();
    // About -44 dBFS: in the quiet range transcription gains by 12 dB.
    const doc = await transcribed(s, await tone(path.join(root, 'quiet', 'talk.wav'), 6, 48000, 300), 6000, [[2000, 3500]]);
    const loud = await transcribed(s, await tone(path.join(root, 'loud', 'talk.wav'), 6), 6000, [[2000, 3500]]);
    const seen: { request: RecognizeClipRequest; levelDb: number }[] = [];
    const recognize = vi.fn(async (request: RecognizeClipRequest) => {
      seen.push({ request, levelDb: levelDb(await readFile(request.filePath)) });
      return heard(segment(1000, 2500, 'ちょっとすべすべでしょ'));
    });
    await recognizeCue({ ...s, recognize }, 4, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'large-v3', language: 'ja' });
    await recognizeCue({ ...s, recognize }, 4, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'anime-whisper-q8_0', language: 'ja' });
    await recognizeCue({ ...s, recognize }, 4, { documentId: loud.id, cueId: loud.cues[0].id, modelId: 'large-v3', language: 'ja' });
    expect(seen[0].levelDb).toBeCloseTo(-43.8 + 12, 0);
    expect(seen[0].request.vadSpeechPadMs).toBe(1000);
    // The text-only model hears the gained clip whole, without voice detection.
    expect(seen[1].levelDb).toBeCloseTo(-43.8 + 12, 0);
    expect(seen[1].request).not.toHaveProperty('vadSpeechPadMs');
    // An ordinary level is sent as it is.
    expect(seen[2].levelDb).toBeCloseTo(-23.8, 0);
    expect(seen[2].request).not.toHaveProperty('vadSpeechPadMs');
  }, 30_000);

  it('rates the result as the transcript is rated and names the review rules it trips', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'rated', 'talk.wav'), 12), 12000, [[1000, 2000], [3000, 6000], [6500, 8000]],
      ['先輩、おはようございます。', 'まだ朝なのに。', 'って、もう眠そうじゃないですか。']);
    const answers = [
      // Weighted by length: (2000 × e^-0.2 + 1000 × e^-1.5 × 0.9) / 3000.
      heard(segment(1000, 3000, 'まだ朝なのに。', -0.2), segment(3000, 4000, 'ねえ', -1.5, 0.1)),
      heard(segment(1000, 4000, 'ご視聴ありがとうございました', -0.1)),
      heard(segment(1000, 2500, 'まだ朝なのに。', -0.05)),
      heard(segment(1000, 4000, 'あああああああああああ', -0.9)),
    ];
    const recognize = vi.fn(async () => answers.shift()!);
    const run = (cue: number) => recognizeCue({ ...s, recognize }, 5, { documentId: doc.id, cueId: doc.cues[cue].id, modelId: 'large-v3', language: 'ja' });
    const first = await run(1);
    expect(first.confidence).toBe(Math.round((2000 * Math.exp(-0.2) + 1000 * Math.exp(-1.5) * 0.9) / 3000 * 1000) / 1000);
    expect(first.reasons).toEqual([]);
    expect((await run(1)).reasons).toEqual(['phantom_phrase']);
    // The previous cue's text again, right after it.
    expect((await run(2)).reasons).toEqual(['duplicate_neighbor']);
    const loop = await run(1);
    expect(loop.confidence).toBe(0.407);
    expect(loop.reasons).toEqual(['low_confidence', 'repetition_loop']);
  }, 30_000);

  it('refuses long cues and missing media, and removes the clip when the model fails or is stopped', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'long', 'long.wav'), 3), 40000, [[0, 1000], [2000, 37000]]);
    const recognize = vi.fn(async () => ({ text: 'x', language: 'en' }));
    await expect(recognizeCue({ ...s, recognize }, 2, { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'm', language: 'auto' }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    const folder = path.join(root, 'notes'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'notes.srt'), '1\n00:00:01,000 --> 00:00:02,000\nhello\n');
    const read = await readSubtitleWithSource(path.join(folder, 'notes.srt'), 'utf-8');
    await s.repository.create(read.document, undefined, read.sourceLocation);
    await expect(recognizeCue({ ...s, recognize }, 2, { documentId: read.document.id, cueId: read.document.cues[0].id, modelId: 'm', language: 'auto' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    expect(recognize).not.toHaveBeenCalled();

    const busy = vi.fn(async () => { throw Object.assign(new Error('busy'), { localSubtitleCode: 'resource_busy' }); });
    const failure = await recognizeCue({ ...s, recognize: busy }, 2, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'm', language: 'auto' }).catch(error => error);
    expect(transcriptionIpcError(failure)).toBe('resource_busy');
    expect(await readdir(s.workingDirectory)).toEqual([]);

    const controller = new AbortController();
    const waiting = vi.fn((request: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'cancelled' })), { once: true });
      controller.abort();
    }));
    const stopped = await recognizeCue({ ...s, recognize: waiting }, 2, { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'm', language: 'auto' }, () => {}, controller.signal).catch(error => error);
    expect(transcriptionIpcError(stopped)).toBe('interrupted');
    expect(await readdir(s.workingDirectory)).toEqual([]);
  }, 30_000);

  it('accepts known languages, device settings and short plain prompts only', () => {
    const base = { documentId: randomUUID(), cueId: randomUUID(), modelId: 'large-v3-q5_0', language: 'ja' };
    const ok = (value: object) => cueRecognizeRequestSchemas.recognizeCue.safeParse({ ...base, ...value }).success;
    expect(ok({})).toBe(true);
    expect(ok({ language: 'zh-Hant', devicePreference: 'cuda', initialPrompt: '人名：法厄同' })).toBe(true);
    expect(ok({ language: 'Japanese' })).toBe(false);
    expect(ok({ devicePreference: 'gpu' })).toBe(false);
    expect(ok({ initialPrompt: 'x'.repeat(201) })).toBe(false);
    expect(ok({ initialPrompt: 'line\nbreak' })).toBe(false);
    expect(ok({ modelId: '../model' })).toBe(false);
  });
});

/** A server that answers every clip with the same text, keeping the requests it was sent. */
function answeringServer(requests: LocalSubtitleServerInferenceRequest[], segments: LocalSubtitleServerRawSegment[] = []) {
  return { dependencies: { createHttpClient: () => ({ sessionDisposition: 'reusable' as const,
    probeReadiness: async () => ({ sessionDisposition: 'reusable' as const }), health: async () => ({ sessionDisposition: 'reusable' as const }),
    inference: async (request: LocalSubtitleServerInferenceRequest) => {
      requests.push(request);
      return { requestGeneration: request.requestGeneration, sessionDisposition: 'reusable' as const, result: { contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
        task: 'transcribe' as const, language: 'en', durationMs: 1400, text: '  Hello there.  ', segments, wordTimelineStatus: 'not_requested' as const } };
    } }) } };
}

/** The app's shared resources reduced to two installed files, a model and the pinned VAD, as the A/B harness reduces them. */
async function installedResources(root: string) {
  const file = async (relative: string, bytes: Buffer) => {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return target;
  };
  const model = Object.freeze({ storage: 'managed' as const, id: 'recognize-model', absolutePath: await file('models/recognize-model/model.bin', Buffer.alloc(64, 1)),
    byteSize: 64, sha256: 'b'.repeat(64) });
  const vad = Object.freeze({ storage: 'managed' as const, id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, absolutePath: await file('vad/vad.bin', Buffer.alloc(64, 2)),
    byteSize: 64, sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256 });
  const reserved: string[][] = [];
  const resolve = (expected: typeof model | typeof vad) => async (id: string) => { expect(id).toBe(expected.id); return expected; };
  const use = Object.freeze({ release() {} });
  const reserveUse = (ids: readonly string[]) => { reserved.push([...ids]); return use; };
  const client = Object.freeze({ initialize: async () => undefined, listManagedResources: async () => Object.freeze([]),
    resolveManagedModel: resolve(model), resolveManagedVad: resolve(vad), withResourceRead: <T>(_id: string, read: () => Promise<T>) => read(), reserveUse,
    status: () => Object.freeze({ revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false }),
    onResourceEvent: () => () => undefined, releaseOwner: () => undefined, waitForIdle: async () => undefined, shutdown: async () => undefined });
  return { model, reserved, service: Object.freeze({ managedResourceRoot: root, initialize: async () => undefined, reserveUse, createClient: () => client }) as unknown as SpeechResourceService };
}

describe('the runtime recognizes a clip outside the task queue', () => {
  it('leases the server for an installed model, sends the clip without VAD, and reuses the warm process', async () => {
    const requests: LocalSubtitleServerInferenceRequest[] = [];
    const item = await runtimeFixture({ server: answeringServer(requests) });
    try {
      await item.runtime.initialize();
      // Not installed yet: the model cannot be used.
      const clip = await tone(path.join(item.userDataRoot, 'clip.wav'), 1, 16000);
      await expect(item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'en', filePath: clip })).rejects.toBeDefined();
      item.runtime.resources.importModel({ owner: OWNER, filePath: item.sourcePath, modelId: item.model.id });
      await item.runtime.resources.waitForIdle();
      const spawned = item.spawnProcess.mock.calls.length;
      const first = await item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'en', initialPrompt: 'Phaethon', filePath: clip });
      expect(first).toEqual({ text: 'Hello there.', language: 'en', segments: [] });
      expect(requests[0]).toMatchObject({ filePath: clip, language: 'en', taskMode: 'transcribe', vadEnabled: false, beamSize: 5, temperature: 0, initialPrompt: 'Phaethon' });
      expect(requests[0]).not.toHaveProperty('noTimestamps');
      await item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'auto', filePath: clip });
      expect(requests[1]).toMatchObject({ language: 'auto' });
      expect(requests[1]).not.toHaveProperty('initialPrompt');
      // Text only reaches the server's request; padding asked for without an installed VAD leaves voice detection off.
      await item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'ja', noTimestamps: true, vadSpeechPadMs: 1000, filePath: clip });
      expect(requests[2]).toMatchObject({ language: 'ja', noTimestamps: true, vadEnabled: false });
      expect(requests[2]).not.toHaveProperty('vadSpeechPadMs');
      // One server process for all three: the lease was released and the warm process reused.
      expect(item.spawnProcess.mock.calls.length - spawned).toBe(1);
    } finally { await item.cleanup(); }
  }, 30_000);

  it('pads a gained clip with the installed VAD, reloading the server for it, and returns the segments in clip time', async () => {
    const requests: LocalSubtitleServerInferenceRequest[] = [];
    const segments = [{ id: 0, startMs: 120, endMs: 1300, text: 'Hello there.', temperature: 0, averageLogProbability: -0.1, noSpeechProbability: 0.01 }];
    const item = await runtimeFixture({ server: answeringServer(requests, segments) });
    const shared = await installedResources(path.join(item.bundle.tempRoot, 'shared-resources'));
    const runtime = createTranscriptionRuntime({ userDataRoot: path.join(item.bundle.tempRoot, 'shared-user-data'), environment: item.bundle.environment },
      { ...item.adapters, sharedResources: shared.service });
    try {
      await runtime.initialize();
      const clip = await tone(path.join(item.bundle.tempRoot, 'gained.wav'), 1, 16000);
      const spawned = item.spawnProcess.mock.calls.length;
      const plain = await runtime.recognize.clip(OWNER, { modelId: shared.model.id, devicePreference: 'cpu', language: 'en', filePath: clip });
      const padded = await runtime.recognize.clip(OWNER, { modelId: shared.model.id, devicePreference: 'cpu', language: 'en', vadSpeechPadMs: 1000, filePath: clip });
      expect(plain.segments).toEqual(segments);
      expect(padded).toEqual({ text: 'Hello there.', language: 'en', segments });
      expect(requests[0]).toMatchObject({ vadEnabled: false });
      expect(requests[1]).toMatchObject({ vadEnabled: true, vadSpeechPadMs: 1000, vadMinSilenceMs: 500 });
      // The VAD is reserved with the model, and loading it needs another server process.
      expect(shared.reserved.at(-1)).toEqual([shared.model.id, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id]);
      const launches = item.spawnProcess.mock.calls.slice(spawned).map(call => call[1] as readonly string[]);
      expect(launches.map(args => args.includes('--vad-model'))).toEqual([false, true]);
    } finally { await runtime.shutdown('fatal'); await item.cleanup(); }
  }, 30_000);
});

/**
 * Opt-in: FUSIONKIT_REAL_RECOGNIZE=1 (Windows, speech synthesis and the model in FUSIONKIT_REAL_RECOGNIZE_MODEL,
 * default the installed large-v3-q5_0). Speaks a sentence, makes it a transcribed document, and recognizes the
 * cue with the real server on the CPU. Copies the model into a temporary root, so it is slow.
 */
describe.runIf(process.env.FUSIONKIT_REAL_RECOGNIZE === '1')('recognizing a cue with a real local model', () => {
  it('hears a spoken English sentence', async () => {
    const sentence = 'The quick brown fox jumps over the lazy dog.';
    const speech = path.join(root, 'real', 'speech.wav');
    await mkdir(path.dirname(speech), { recursive: true });
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}'); $s.Speak('${sentence}'); $s.Dispose()`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const s = services();
    // The synthesized sentence lasts about three seconds.
    const doc = await transcribed(s, speech, 3500, [[0, 3300]]);
    const modelPath = process.env.FUSIONKIT_REAL_RECOGNIZE_MODEL ?? path.join(process.env.APPDATA!, 'FusionKit', 'speech-resources', 'models', 'large-v3-q5_0', 'ggml-large-v3-q5_0.bin');
    const userDataRoot = path.join(root, 'real', 'user-data'); await mkdir(userDataRoot, { recursive: true });
    const runtime = createTranscriptionRuntime({ userDataRoot, environment: { mode: 'development', appRoot: process.cwd() } }, { server: { startupTimeoutMs: 120_000 } });
    try {
      await runtime.initialize();
      runtime.resources.importModel({ owner: OWNER, filePath: modelPath, modelId: 'large-v3-q5_0' });
      await runtime.resources.waitForIdle();
      const started = performance.now();
      const result = await recognizeCue({ ...s, recognize: clip => runtime.recognize.clip(OWNER, clip) }, 3,
        { documentId: doc.id, cueId: doc.cues[0].id, modelId: 'large-v3-q5_0', language: 'en', devicePreference: 'cpu' });
      console.info(`[cue-recognize] real large-v3-q5_0 on CPU heard "${result.text}" in ${Math.round(performance.now() - started)} ms`);
      const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
      const heard = new Set(words(result.text));
      expect(words(sentence).filter(word => heard.has(word)).length).toBeGreaterThanOrEqual(7);
      // The server names the language ("english"), not its code.
      expect(result.language).toMatch(/^en/);
    } finally { await runtime.shutdown('fatal'); }
  }, 600_000);
});
