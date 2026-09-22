import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { LocalSubtitleCapabilityLeaseCoordinator, LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry } from '../../../electron/main/subtitle-studio/transcription/native/authorizations';
import { LocalSubtitleMediaNormalizer } from '../../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { localSubtitleFileIdentityForPath } from '../../../electron/main/subtitle-studio/transcription/native/filesystem-object-identity';
import { createLocalSubtitlePcm16WavHeader } from '../../../electron/main/subtitle-studio/transcription/native/pcm-window';
import { createRuntimeFixture } from './runtimeFixture';
import { touchSourceMetadata } from '../helpers/source-metadata';

const owner = { webContentsId: 91, ownerSessionId: 'source-metadata-test' };
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture(options: { mutateSnapshot?: boolean; mutateSource?: boolean } = {}) {
  const runtime = await createRuntimeFixture({ platform: process.platform === 'win32' ? 'win32' : 'darwin' });
  disposals.push(runtime.cleanup);
  const inputPath = path.join(runtime.tempRoot, '用户 视频.wav');
  const bytes = Buffer.from('original source bytes'); await writeFile(inputPath, bytes);
  const inputs = new LocalSubtitleInputAuthorizationRegistry();
  const input = await inputs.authorize(owner, inputPath, ['probe', 'transcribe', 'derive_source_output']);
  const decoded: Buffer[] = [];
  const normalizer = new LocalSubtitleMediaNormalizer({
    environment: runtime.environment, managedResourceRoot: path.join(runtime.tempRoot, 'managed'),
    inputAuthorizations: inputs, signatureVerifier: async () => true, availableBytes: async () => Number.MAX_SAFE_INTEGER,
    processRunner: async request => {
      let stdout = Buffer.alloc(0);
      if (request.args.includes('-version')) {
        const tool = request.command === runtime.artifactPaths[runtime.manifest.artifacts.find(a => a.kind === 'ffmpeg')!.id] ? 'ffmpeg' : 'ffprobe';
        stdout = Buffer.from(`${tool} version ${runtime.manifest.artifacts.find(a => a.kind === tool)!.version}\n`);
      } else if (request.args.includes('-show_entries')) {
        const probedPath = request.args.at(-1)!;
        if (path.basename(probedPath) !== 'source.snapshot') touchSourceMetadata(inputPath);
        if (options.mutateSnapshot && path.basename(probedPath) === 'source.snapshot') touchSourceMetadata(probedPath);
        stdout = Buffer.from(JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1,
          sample_rate: '16000', duration: '1.000', disposition: { default: 1 }, tags: {} }], format: { duration: '1.000' } }));
      } else if (request.args.includes('-progress')) {
        decoded.push(await readFile(request.args[request.args.indexOf('-i') + 1]));
        const pcm = Buffer.alloc(32_000, 0x2a);
        await writeFile(request.args.at(-1)!, Buffer.concat([createLocalSubtitlePcm16WavHeader(pcm.length), pcm]), { mode: 0o600 });
        if (options.mutateSource) await writeFile(inputPath, 'actually edited source');
        else touchSourceMetadata(inputPath);
        request.onStdoutChunk?.(Buffer.from('progress=end\n'));
      } else throw new Error('Unexpected process request');
      return { status: 'closed', spawned: true, exitCode: 0, signalCode: null, stdout, stderr: Buffer.alloc(0),
        aborted: false, timedOut: false, outputExceeded: false, closeConfirmed: Promise.resolve() };
    },
  });
  disposals.push(() => normalizer.shutdown('app_quit'));
  const commit = async () => {
    const reservation = await new LocalSubtitleCapabilityLeaseCoordinator(inputs, new LocalSubtitleOutputDirectoryAuthorizationRegistry())
      .reserveBatch({ owner, batchId: 'batch-metadata', inputs: [{ fileToken: input.fileToken, taskId: 'task-metadata' }] });
    reservation.commit();
  };
  return { inputPath, inputs, input, normalizer, commit, bytes, decoded };
}

it('keeps a selected audio stream and private copy valid when source metadata changes before and during normalization', async () => {
  const f = await fixture();
  touchSourceMetadata(f.inputPath);
  const probe = await f.normalizer.probeDraft({ owner, fileToken: f.input.fileToken });
  touchSourceMetadata(f.inputPath);
  // A fresh observation and the stored probe describe the same source despite ctime drift.
  f.normalizer.bindTaskMediaSelection({ owner, fileToken: f.input.fileToken, taskId: 'task-metadata',
    audioStreamId: probe.autoSelectedStreamId!, inputIdentity: await localSubtitleFileIdentityForPath(f.inputPath),
    runtimeGeneration: (await f.normalizer.verifyRuntime({ owner })).runtimeGeneration });
  await f.commit();
  let changedDuringCopy = false;
  const result = await f.normalizer.normalizeTask({ owner, fileToken: f.input.fileToken, taskId: 'task-metadata', taskGeneration: 1,
    audioStreamId: probe.autoSelectedStreamId!, onProgress: value => {
      if (!changedDuringCopy && value > 0) { changedDuringCopy = true; touchSourceMetadata(f.inputPath); }
    } });
  expect(changedDuringCopy).toBe(true);
  expect(result.totalFrames).toBe(16_000);
  expect(f.decoded).toEqual([f.bytes]);
  await expect(f.inputs.resolveTaskSourceOutputDirectory(owner, 'task-metadata', f.input.fileToken)).resolves.toBeDefined();
});

it.each(['snapshot', 'source'] as const)('still rejects changes to %s integrity during normalization', async kind => {
  const f = await fixture({ mutateSnapshot: kind === 'snapshot', mutateSource: kind === 'source' });
  await f.commit();
  await expect(f.normalizer.normalizeTask({ owner, fileToken: f.input.fileToken, taskId: 'task-metadata', taskGeneration: 1 }))
    .rejects.toMatchObject({ code: 'media_changed' });
});
