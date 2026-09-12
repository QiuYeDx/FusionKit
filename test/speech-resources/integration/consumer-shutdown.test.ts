import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createResourceConsumerLifecycle } from '../../../electron/main/app-shutdown';
import { SpeechResourceService } from '../../../electron/main/speech-resources/service';
import { LocalSubtitleJobManager, type LocalSubtitleJobBatchRuntime } from '../../../electron/main/local-subtitle/job-manager';
import { LocalSubtitleSessionRegistry } from '../../../electron/main/local-subtitle/session-registry';
import { LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry, LocalSubtitleCapabilityLeaseCoordinator } from '../../../electron/main/local-subtitle/authorizations';
import { LocalSubtitleBackendResolver } from '../../../electron/main/local-subtitle/backend-resolver';
import { verifyLocalSubtitleRuntimeBundle } from '../../../electron/main/local-subtitle/resource-path';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../../src/type/localSubtitle';
import { createRuntimeFixture } from '../../local-subtitle/runtimeFixture';

it('retires a real completed JobManager busy predicate only after every consumer cleanup succeeds', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sr-join-'))), nativeFixture = await createRuntimeFixture();
  const registry = new LocalSubtitleSessionRegistry(), inputs = new LocalSubtitleInputAuthorizationRegistry(), outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const owner = { webContentsId: 1, ownerSessionId: 'shutdown-real-job-manager' }, modelId = LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id;
  const service = new SpeechResourceService({ userDataRoot: root, migrationResources: [], smokeModel: async () => undefined, smokeVad: async () => undefined });
  let jobs: LocalSubtitleJobManager | undefined, consumer: ReturnType<typeof createResourceConsumerLifecycle> | undefined, cleanupFails = true;
  try {
    await service.initialize();
    const verified = await verifyLocalSubtitleRuntimeBundle({ environment: nativeFixture.environment, scope: 'server', signatureVerifier: async () => true });
    const filePath = path.join(root, 'fixture.wav'); await writeFile(filePath, 'no real audio inference in this regression'); const file = await inputs.authorize(owner, filePath);
    jobs = new LocalSubtitleJobManager({ registry, inputs, outputs, leases: new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs),
      runtimeVerifier: { verifyRuntime: async () => ({ runtimeGeneration: verified.runtimeGeneration }) },
      backendResolver: new LocalSubtitleBackendResolver({ verifyServerRuntime: async () => verified }),
      modelResolver: { resolveManagedModel: async () => ({ storage: 'managed', id: modelId, absolutePath: path.join(root, 'fixture-model.bin'),
        byteSize: 100, sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256 }),
        resolveManagedVad: async () => { throw new Error('VAD is disabled in this regression'); } },
      mediaSelections: { bindTaskMediaSelection() {}, releaseTaskMediaSelection() {} },
      // The actual manager reaches completed state using a synthetic executor; no server process starts.
      executor: { supportsOutputConflictPolicy: () => true, beginBatchSlice: () => ({} as LocalSubtitleJobBatchRuntime), endBatchSlice() {},
        async execute(context) {
          for (const [index, status] of (['preparing_media', 'loading_model', 'transcribing', 'post_processing', 'exporting'] as const).entries())
            context.update({ status, progress: { stage: status, stageProgress: 100, overallProgress: index * 20 }, durationMs: 1000 });
          return { status: 'completed', durationMs: 1000, artifactResults: [{ status: 'committed', format: 'SRT',
            artifact: { artifactRef: 'fixture-result', displayName: 'fixture.srt', format: 'SRT', expiresAt: Date.now() + 60000 } }] };
        } },
    });
    consumer = createResourceConsumerLifecycle({ isResourceBusy: id => jobs!.isManagedModelBusy(id), async shutdown(reason) {
      await jobs!.shutdown(reason);
      // A real consumer must also join its media/server cleanup after the manager's fenced records settle.
      if (cleanupFails) throw new Error('media cleanup still pending');
    } });
    service.createClient({ id: 'legacy', isResourceBusy: consumer.isResourceBusy });
    await jobs.enqueue(owner, { schemaVersion: 1, files: [{ fileToken: file.fileToken }], config: { modelId, devicePreference: 'cpu', language: 'ja', taskMode: 'transcribe', vadEnabled: false,
      advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 },
      output: { mode: 'source', formats: ['SRT'], conflictPolicy: 'index' }, postAction: { mode: 'export_only' } } });
    await jobs.waitForIdle(); expect(jobs.getSessionSnapshot(owner).batches[0].tasks[0].status).toBe('completed');
    expect(jobs.isManagedModelBusy(modelId)).toBe(false);
    await expect(consumer.shutdown('app_quit')).rejects.toThrow('media cleanup still pending');
    // This is the frozen manager's actual behavior that caused the real four-chain shutdown failure.
    expect(jobs.isManagedModelBusy(modelId)).toBe(true); expect(consumer.isResourceBusy(modelId)).toBe(true);
    await expect(service.shutdown()).rejects.toMatchObject({ localSubtitleCode: 'resource_busy' });
    cleanupFails = false; await consumer.shutdown('app_quit');
    expect(jobs.isManagedModelBusy(modelId)).toBe(true); expect(consumer.isResourceBusy(modelId)).toBe(false);
    await expect(service.shutdown()).resolves.toBeUndefined();
  } finally { cleanupFails = false; await (consumer ? consumer.shutdown('app_quit') : jobs?.shutdown()); await service.shutdown(); await registry.shutdown(); inputs.releaseOwner(owner); outputs.releaseOwner(owner);
    await nativeFixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
