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
import { recognizeCue } from '../../electron/main/subtitle-studio/cue-recognize-service';
import { transcriptionIpcError } from '../../electron/main/subtitle-studio/transcription-ipc';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION, type LocalSubtitleServerInferenceRequest } from '../../electron/main/subtitle-studio/transcription/native/server-contract';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { cueRecognizeRequestSchemas } from '../../src/subtitle-studio/cue-recognize-contract';
import type { LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { runtimeFixture } from './helpers/transcription-runtime';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const OWNER = { webContentsId: 61, ownerSessionId: 'recognize-owner' };
const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
let root: string;

/** A WAV of `seconds` at `rate`, quiet tone. */
async function tone(file: string, seconds: number, rate = 48000) {
  const samples = new Int16Array(rate * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 3000));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, rate, 1), new Uint8Array(samples.buffer)]));
  return file;
}
function services() {
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const workingDirectory = path.join(root, 'work');
  return { repository, workingDirectory, media: new CueMediaService(repository), clipper: new CueAudioClipper({ environment, workingDirectory }) };
}
async function transcribed(s: ReturnType<typeof services>, file: string, durationMs: number, segments: [number, number][]) {
  const doc = transcriptToDocument({ schemaVersion: 1, source: { displayName: path.basename(file), durationMs },
    model: { engine: 'whisper_cpp', modelId: 'm', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
    segments: segments.map(([startMs, endMs], index) => ({ id: `s${index}`, startMs, endMs, text: `line ${index}` })) }, { newId: randomUUID });
  await s.repository.create(doc, undefined, await captureSourceInput(file));
  return doc;
}

beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-cue-recognize-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('recognizing a cue again', () => {
  it('hands the model a 16 kHz clip of the cue with a little on each side, then removes it', async () => {
    const s = services();
    const doc = await transcribed(s, await tone(path.join(root, 'media', 'talk.wav'), 12), 12000, [[1000, 2000], [9500, 10500]]);
    await mkdir(s.workingDirectory, { recursive: true });
    const seen: { file: string; header: Buffer; size: number; request: object }[] = [];
    const recognize = vi.fn(async (request: { filePath: string }) => {
      const bytes = await readFile(request.filePath);
      seen.push({ file: request.filePath, header: bytes.subarray(0, 44), size: bytes.length, request });
      return { text: '先輩、おはようございます。', language: 'ja' };
    });
    const result = await recognizeCue({ ...s, recognize }, 1,
      { documentId: doc.id, cueId: doc.cues[1].id, modelId: 'large-v3-q5_0', language: 'ja', devicePreference: 'cpu', initialPrompt: '先輩' });
    expect(result).toEqual({ text: '先輩、おはようございます。', language: 'ja' });
    expect(seen[0].request).toMatchObject({ modelId: 'large-v3-q5_0', language: 'ja', devicePreference: 'cpu', initialPrompt: '先輩' });
    // 9.5–10.5 s plus 0.2 s on each side, mono 16-bit at 16 kHz.
    expect(seen[0].header.readUInt32LE(24)).toBe(16000);
    expect(seen[0].header.readUInt16LE(22)).toBe(1);
    expect((seen[0].size - 44) / 32000).toBeCloseTo(1.4, 2);
    expect(path.dirname(seen[0].file)).toBe(s.workingDirectory);
    expect(await readdir(s.workingDirectory)).toEqual([]);
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

describe('the runtime recognizes a clip outside the task queue', () => {
  it('leases the server for an installed model, sends the clip without VAD, and reuses the warm process', async () => {
    const requests: LocalSubtitleServerInferenceRequest[] = [];
    const item = await runtimeFixture({ server: { dependencies: { createHttpClient: () => ({ sessionDisposition: 'reusable',
      probeReadiness: async () => ({ sessionDisposition: 'reusable' as const }), health: async () => ({ sessionDisposition: 'reusable' as const }),
      inference: async (request: LocalSubtitleServerInferenceRequest) => {
        requests.push(request);
        return { requestGeneration: request.requestGeneration, sessionDisposition: 'reusable' as const, result: { contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
          task: 'transcribe' as const, language: 'en', durationMs: 1400, text: '  Hello there.  ', segments: [], wordTimelineStatus: 'not_requested' as const } };
      } }) } } });
    try {
      await item.runtime.initialize();
      // Not installed yet: the model cannot be used.
      const clip = await tone(path.join(item.userDataRoot, 'clip.wav'), 1, 16000);
      await expect(item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'en', filePath: clip })).rejects.toBeDefined();
      item.runtime.resources.importModel({ owner: OWNER, filePath: item.sourcePath, modelId: item.model.id });
      await item.runtime.resources.waitForIdle();
      const spawned = item.spawnProcess.mock.calls.length;
      const first = await item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'en', initialPrompt: 'Phaethon', filePath: clip });
      expect(first).toEqual({ text: 'Hello there.', language: 'en' });
      expect(requests[0]).toMatchObject({ filePath: clip, language: 'en', taskMode: 'transcribe', vadEnabled: false, beamSize: 5, temperature: 0, initialPrompt: 'Phaethon' });
      await item.runtime.recognize.clip(OWNER, { modelId: item.model.id, devicePreference: 'cpu', language: 'auto', filePath: clip });
      expect(requests[1]).toMatchObject({ language: 'auto' });
      expect(requests[1]).not.toHaveProperty('initialPrompt');
      // One server process for both: the lease was released and the warm process reused.
      expect(item.spawnProcess.mock.calls.length - spawned).toBe(1);
    } finally { await item.cleanup(); }
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
