import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpeechResourceService } from '../../../electron/main/speech-resources/service';
import { SPEECH_MODEL_MANIFEST } from '../../../electron/main/speech-resources/catalog';
import { LocalSubtitleSessionRegistry } from '../../../electron/main/local-subtitle/session-registry';
import { createLegacySharedResources, protectLegacyResourceAdmissions } from '../../../electron/main/local-subtitle/shared-resources';
import { createStudioSharedResources } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import { LOCAL_SUBTITLE_LIMITS } from '../../../src/type/localSubtitle';
import { LocalSubtitleModelManagerError } from '../../../electron/main/local-subtitle/model-manager';
import { LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS as channels, localSubtitleIpcSuccess } from '../../../src/type/localSubtitleIpc';
import type { LocalSubtitleIpcHandlerContext } from '../../../electron/main/local-subtitle/ipc';

const oldOwner = { webContentsId: 1, ownerSessionId: 'legacy-test' };
const studioOwner = { webContentsId: 1, ownerSessionId: 'studio-test' };

async function fixture(smoke?: (signal: AbortSignal) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sr-int-')));
  const entry = SPEECH_MODEL_MANIFEST.models[0];
  // Synthetic GGML header verifies adapter/storage behavior only; no model or inference process runs.
  const bytes = Buffer.alloc(304, 0x5a); Buffer.from(entry.ggml.magicHex, 'hex').copy(bytes);
  entry.ggml.headerInt32Le.forEach((value, index) => bytes.writeInt32LE(value, 4 + index * 4));
  const model = { ...entry, id: 'adapter-fixture-model', fileName: 'adapter-fixture.bin', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const source = path.join(root, 'source.bin'); await writeFile(source, bytes);
  const service = new SpeechResourceService({ userDataRoot: root, migrationResources: [], modelCatalog: [model],
    vadManager: false, acceleratorManager: false, availableBytes: async () => Number.MAX_SAFE_INTEGER,
    smokeModel: async input => { await smoke?.(input.signal); }, smokeVad: async () => undefined });
  try { await service.initialize(); } catch (error) { await service.shutdown(); await rm(root, { recursive: true, force: true }); throw error; }
  const registry = new LocalSubtitleSessionRegistry(); let studioBusy = false;
  const legacy = createLegacySharedResources({ service, registry, isResourceBusy: () => false });
  const studio = createStudioSharedResources({ service, isResourceBusy: id => studioBusy && id === model.id });
  return { root, source, model, service, registry, legacy, studio, setBusy(value: boolean) { studioBusy = value; },
    async cleanup() { studioBusy = false; service.fence(); await Promise.all([legacy.shutdown(), studio.shutdown()]);
      await service.shutdown(); await registry.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

describe('production shared resource adapters', () => {
  it('mirrors global jobs into the old revision stream and keeps jobs alive when their page owner leaves', async () => {
    let entered!: () => void; const smokeEntered = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(signal => new Promise<void>((_resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(new Error('cancelled fixture smoke')), { once: true });
    }));
    try {
      const revisions: number[] = []; f.legacy.onResourceEvent(oldOwner, event => revisions.push(event.revision));
      const now = new Date().toISOString();
      for (let index = 0; index < LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs; index++) f.registry.upsertResourceJob(oldOwner, {
        jobId: `prior-global-job-${index}`, resourceId: f.model.id, resourceType: 'model',
        status: 'completed', progress: 100, bytesCompleted: f.model.byteSize, bytesTotal: f.model.byteSize,
        createdAt: now, updatedAt: now,
      });
      const job = f.legacy.importModel({ owner: oldOwner, filePath: f.source, modelId: f.model.id, mode: 'copy' });
      await smokeEntered;
      expect(f.registry.getSnapshot(oldOwner).resourceJobs).toHaveLength(1);
      expect(f.registry.getSnapshot(oldOwner).resourceJobs[0].jobId).toBe(job.jobId);
      expect(f.studio.getSessionSnapshot(studioOwner).resourceJobs[0].jobId).toBe(job.jobId);
      const importAgain = () => f.legacy.importModel({ owner: oldOwner, filePath: f.source, modelId: f.model.id, mode: 'copy' });
      for (const operation of [importAgain, () => f.legacy.startResourceInstall(oldOwner, f.model.id)])
        expect(operation).toThrow(expect.objectContaining({ localSubtitleCode: 'resource_busy', name: 'LocalSubtitleModelManagerError' }));
      await expect(f.legacy.resolveManagedModel(f.model.id)).rejects.toBeInstanceOf(LocalSubtitleModelManagerError);
      const guarded = protectLegacyResourceAdmissions({ resources: f.legacy, registry: f.registry,
        handlers: { [channels.enqueue]: () => localSubtitleIpcSuccess({}), [channels.previewBackend]: () => localSubtitleIpcSuccess({}) } });
      const context = { owner: oldOwner } as LocalSubtitleIpcHandlerContext;
      expect(() => guarded[channels.previewBackend]!({ modelId: f.model.id, devicePreference: 'cpu' }, context)).toThrow(LocalSubtitleModelManagerError);
      expect(() => guarded[channels.enqueue]!({ schemaVersion: 1, files: [{ fileToken: 'fixture-file' }], config: {
        modelId: f.model.id, devicePreference: 'cpu', language: 'ja', taskMode: 'transcribe', vadEnabled: false,
        advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 },
        output: { mode: 'source', formats: ['SRT'], conflictPolicy: 'index' }, postAction: { mode: 'export_only' },
      } }, context)).toThrow(LocalSubtitleModelManagerError);
      f.legacy.releaseOwner(oldOwner);
      expect(() => f.legacy.cancelResourceJob(oldOwner, job.jobId)).toThrow(expect.objectContaining({ localSubtitleCode: 'owner_released' }));
      expect(f.studio.getSessionSnapshot(studioOwner).resourceJobs[0].status).not.toBe('cancelled');
      f.studio.cancelResourceJob(studioOwner, job.jobId); await f.studio.waitForIdle();
      expect(f.studio.getSessionSnapshot(studioOwner).resourceJobs[0].status).toBe('cancelled');
      const reopened = { ...oldOwner, ownerSessionId: 'new-legacy-owner' };
      expect(f.legacy.getSessionSnapshot(reopened).resourceJobs[0]).toMatchObject({ jobId: job.jobId, status: 'cancelled' });
      expect(revisions.length).toBeGreaterThan(1);
      expect(revisions.every((value, index) => index === 0 || value > revisions[index - 1])).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('resolves one installed file in both domains and rejects deletion during a sibling use lease or task', async () => {
    const f = await fixture();
    try {
      f.legacy.importModel({ owner: oldOwner, filePath: f.source, modelId: f.model.id, mode: 'copy' }); await f.legacy.waitForIdle();
      const oldModel = await f.legacy.resolveManagedModel(f.model.id), studioModel = await f.studio.resolveManagedModel(f.model.id);
      expect(studioModel).toEqual(oldModel); expect(oldModel.absolutePath.startsWith(f.service.managedResourceRoot + path.sep)).toBe(true);
      const use = f.studio.reserveUse([f.model.id]);
      await expect(f.legacy.deleteManagedResource(oldOwner, f.model.id)).rejects.toMatchObject({ localSubtitleCode: 'resource_busy' });
      await expect(f.legacy.deleteManagedResource(oldOwner, f.model.id)).rejects.toBeInstanceOf(LocalSubtitleModelManagerError);
      use.release(); f.setBusy(true);
      await expect(f.legacy.deleteManagedResource(oldOwner, f.model.id)).rejects.toMatchObject({ localSubtitleCode: 'resource_busy' });
      f.setBusy(false); await f.legacy.shutdown();
      expect((await f.studio.resolveManagedModel(f.model.id)).absolutePath).toBe(oldModel.absolutePath);
      await f.studio.deleteManagedResource(studioOwner, f.model.id);
      expect((await f.studio.listManagedResources(studioOwner))[0].status).not.toBe('installed');
    } finally { await f.cleanup(); }
  });
});
