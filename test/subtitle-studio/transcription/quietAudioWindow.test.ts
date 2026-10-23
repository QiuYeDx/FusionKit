import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalSubtitleCapabilityLeaseCoordinator, LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry } from '../../../electron/main/subtitle-studio/transcription/native/authorizations';
import { LocalSubtitleMediaNormalizer, type LocalSubtitleMediaStructuralWindow,
  type MaterializeLocalSubtitlePcmWindowOptions } from '../../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { createLocalSubtitlePcm16WavHeader, inspectLocalSubtitlePcm16Wav,
  writeLocalSubtitlePcmWindow } from '../../../electron/main/subtitle-studio/transcription/native/pcm-window';
import { conditionWhisperPcm16 } from '../../../electron/main/subtitle-studio/transcription/native/quiet-audio';
import { MODERATE_SIGNAL, TRANSIENT_SIGNAL, WHISPER_SIGNAL, quietSignal, type QuietSignalPart } from './quietAudioSignals';
import { createRuntimeFixture } from './runtimeFixture';

const SIGNALS = { whisper: [WHISPER_SIGNAL, -90], moderate: [MODERATE_SIGNAL, -75], transient: [TRANSIENT_SIGNAL, -80] } as const;
/** Window file hashes written by the pre-T-ASRQ-03 implementation (68ffd05) for the same signals. */
const STANDARD_WINDOW_SHA256 = {
  whisper: { plain: '50cae1b4b6d65a6af4c83e85af63b3c68eef80c1adfb76fd6af91108b9d2563b', conditioned: '50cae1b4b6d65a6af4c83e85af63b3c68eef80c1adfb76fd6af91108b9d2563b' },
  moderate: { plain: 'b1ef45f967f8f94aa081654f0ddc991bd60c25b15d7966fa48c9595dceb32207', conditioned: '3396505aa126afc9efecd85128cd21ca92dbfa6c341d630afb27bde7da1c5585' },
  transient: { plain: 'e0f87ba04d684a3787bc44a1902a9acd77855dc160b806e0a4296496d05dcffd', conditioned: 'e0f87ba04d684a3787bc44a1902a9acd77855dc160b806e0a4296496d05dcffd' },
} as const;

const owner = { webContentsId: 92, ownerSessionId: 'gated-quiet-audio-test' };
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const wav = (pcm: Buffer) => Buffer.concat([createLocalSubtitlePcm16WavHeader(pcm.length), pcm]);
const signal = (name: keyof typeof SIGNALS) => quietSignal(SIGNALS[name][0] as readonly QuietSignalPart[], SIGNALS[name][1]).pcm;

async function sourceWindow(pcm: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-gated-window-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.wav');
  await writeFile(sourcePath, wav(pcm));
  const metadata = await inspectLocalSubtitlePcm16Wav(sourcePath);
  let count = 0;
  return (options: { conditionQuietAudio?: boolean; quietAudioMode?: string }) => {
    const outputPath = path.join(root, `window-${count++}.wav`);
    return { outputPath, written: writeLocalSubtitlePcmWindow({ sourcePath, sourceIdentity: metadata.fileIdentity, metadata,
      startFrame: 0, endFrame: metadata.totalFrames, outputPath, ...options } as Parameters<typeof writeLocalSubtitlePcmWindow>[0]) };
  };
}

describe('Studio PCM windows with gated quiet audio', () => {
  it.each(Object.keys(SIGNALS) as (keyof typeof SIGNALS)[])('keeps standard %s windows byte-identical to the previous implementation', async name => {
    const write = await sourceWindow(signal(name));
    const plain = await write({}).written, unconditioned = await write({ conditionQuietAudio: false }).written;
    const conditioned = await write({ conditionQuietAudio: true }).written;
    expect([plain.sha256, unconditioned.sha256]).toEqual([STANDARD_WINDOW_SHA256[name].plain, STANDARD_WINDOW_SHA256[name].plain]);
    expect(conditioned.sha256).toBe(STANDARD_WINDOW_SHA256[name].conditioned);
    expect(conditioned.quietAudioGainDb).toBe(name === 'moderate' ? 12 : undefined);
    expect(plain).not.toHaveProperty('quietAudioGainDb');
  });

  it('writes the gated gain into the window and reports it, or leaves a normal-level window untouched', async () => {
    const input = signal('transient');
    const expected = conditionWhisperPcm16(input);
    const gated = (await sourceWindow(input))({ conditionQuietAudio: true, quietAudioMode: 'gated_v1' });
    const written = await gated.written;
    const bytes = await readFile(gated.outputPath);
    expect(expected.gainDb).toBeGreaterThan(15);
    expect(written.quietAudioGainDb).toBe(expected.gainDb);
    expect(bytes.equals(wav(expected.pcm))).toBe(true);
    expect(written.sha256).toBe(sha256(bytes));
    expect(written.metadata.totalFrames).toBe(input.length / 2);

    const normal = quietSignal(MODERATE_SIGNAL.map(part => 'rmsDb' in part ? { ...part, rmsDb: -20 } : part), -55).pcm;
    const untouched = (await sourceWindow(normal))({ conditionQuietAudio: true, quietAudioMode: 'gated_v1' });
    expect(await untouched.written).not.toHaveProperty('quietAudioGainDb');
    expect((await readFile(untouched.outputPath)).equals(wav(normal))).toBe(true);
  });

  it('rejects an unknown mode or a mode without conditioning before creating the window', async () => {
    const write = await sourceWindow(signal('whisper'));
    for (const options of [{ conditionQuietAudio: true, quietAudioMode: 'gated_v2' }, { quietAudioMode: 'gated_v1' },
      { conditionQuietAudio: false, quietAudioMode: 'gated_v1' }]) {
      const attempt = write(options);
      await expect(attempt.written).rejects.toMatchObject({ reason: 'invalid_configuration' });
      await expect(access(attempt.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('Studio media normalizer with gated quiet audio', () => {
  it('brands gated windows with their gain while standard windows keep their previous bytes', async () => {
    const input = signal('whisper');
    const { normalizer, normalized } = await normalizedFixture(input);
    const descriptor = structuralWindow(0, input.length / 2);
    const materialize = (options: Partial<MaterializeLocalSubtitlePcmWindowOptions>) =>
      normalizer.materializeWindow({ normalized, descriptor, ...options });
    for (const options of [{}, { conditionQuietAudio: true }]) {
      const window = await materialize(options);
      expect(window.sha256).toBe(STANDARD_WINDOW_SHA256.whisper.plain);
      expect(window).not.toHaveProperty('quietAudioGainDb');
      await normalizer.disposeWindow(window);
    }
    const window = await materialize({ conditionQuietAudio: true, quietAudioMode: 'gated_v1' });
    const resolved = await normalizer.resolveWindow(window, { taskId: 'task-quiet', taskGeneration: 1, descriptor });
    expect(window.quietAudioGainDb).toBe(30);
    expect(resolved).toMatchObject({ quietAudioGainDb: 30, sha256: window.sha256 });
    expect((await readFile(resolved.filePath)).equals(wav(conditionWhisperPcm16(input).pcm))).toBe(true);
    await normalizer.disposeWindow(window);
  });

  it('rejects an invalid conditioning mode without faulting the normalized media', async () => {
    const input = signal('whisper');
    const { normalizer, normalized } = await normalizedFixture(input);
    const descriptor = structuralWindow(0, input.length / 2);
    for (const options of [{ conditionQuietAudio: true, quietAudioMode: 'gated_v2' }, { quietAudioMode: 'gated_v1' }]) {
      await expect(normalizer.materializeWindow({ normalized, descriptor, ...options } as MaterializeLocalSubtitlePcmWindowOptions))
        .rejects.toMatchObject({ code: 'invalid_configuration' });
    }
    const window = await normalizer.materializeWindow({ normalized, descriptor, conditionQuietAudio: true, quietAudioMode: 'gated_v1' });
    expect(window.quietAudioGainDb).toBe(30);
    await normalizer.disposeWindow(window);
  });
});

async function normalizedFixture(pcm: Buffer) {
  const runtime = await createRuntimeFixture({ platform: process.platform === 'win32' ? 'win32' : 'darwin' });
  disposals.push(runtime.cleanup);
  const inputPath = path.join(runtime.tempRoot, 'quiet source.wav');
  await writeFile(inputPath, Buffer.from('quiet source bytes'));
  const inputs = new LocalSubtitleInputAuthorizationRegistry();
  const input = await inputs.authorize(owner, inputPath, ['probe', 'transcribe', 'derive_source_output']);
  const duration = (pcm.length / 32_000).toFixed(3);
  const normalizer = new LocalSubtitleMediaNormalizer({
    environment: runtime.environment, managedResourceRoot: path.join(runtime.tempRoot, 'managed'),
    inputAuthorizations: inputs, signatureVerifier: async () => true, availableBytes: async () => Number.MAX_SAFE_INTEGER,
    processRunner: async request => {
      let stdout = Buffer.alloc(0);
      if (request.args.includes('-version')) {
        const tool = request.command === runtime.artifactPaths[runtime.manifest.artifacts.find(a => a.kind === 'ffmpeg')!.id] ? 'ffmpeg' : 'ffprobe';
        stdout = Buffer.from(`${tool} version ${runtime.manifest.artifacts.find(a => a.kind === tool)!.version}\n`);
      } else if (request.args.includes('-show_entries')) {
        stdout = Buffer.from(JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1,
          sample_rate: '16000', duration, disposition: { default: 1 }, tags: {} }], format: { duration } }));
      } else if (request.args.includes('-progress')) {
        await writeFile(request.args.at(-1)!, wav(pcm), { mode: 0o600 });
        request.onStdoutChunk?.(Buffer.from('progress=end\n'));
      } else throw new Error('Unexpected process request');
      return { status: 'closed', spawned: true, exitCode: 0, signalCode: null, stdout, stderr: Buffer.alloc(0),
        aborted: false, timedOut: false, outputExceeded: false, closeConfirmed: Promise.resolve() };
    },
  });
  disposals.push(() => normalizer.shutdown('app_quit'));
  const reservation = await new LocalSubtitleCapabilityLeaseCoordinator(inputs, new LocalSubtitleOutputDirectoryAuthorizationRegistry())
    .reserveBatch({ owner, batchId: 'batch-quiet', inputs: [{ fileToken: input.fileToken, taskId: 'task-quiet' }] });
  reservation.commit();
  const normalized = await normalizer.normalizeTask({ owner, fileToken: input.fileToken, taskId: 'task-quiet', taskGeneration: 1 });
  return { normalizer, normalized };
}

function structuralWindow(startFrame: number, endFrame: number): LocalSubtitleMediaStructuralWindow {
  const startMs = Math.round(startFrame / 16), endMs = Math.round(endFrame / 16);
  return Object.freeze({ windowKey: `window-${startFrame}-${endFrame}`, rootPlanId: 'root-plan-1', rootWindowKey: 'root-window-1',
    retryDepth: 0, startFrame, endFrame, coreStartFrame: startFrame, coreEndFrame: endFrame, startMs, endMs,
    coreStartMs: startMs, coreEndMs: endMs });
}
