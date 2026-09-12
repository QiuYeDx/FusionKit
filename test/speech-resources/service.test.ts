import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, lstat, readFile, utimes, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechResourceService, type SpeechResourceServiceOptions } from '../../electron/main/speech-resources/service';
import { SPEECH_MODEL_MANIFEST } from '../../electron/main/speech-resources/catalog';
import { verifyLocalSubtitleGgmlModelFile } from '../../electron/main/speech-resources/engine/ggml-model';
import { LOCAL_SUBTITLE_LIMITS } from '../../src/speech-resources/contracts';

const OWNER_A = { webContentsId: 81, ownerSessionId: 'legacy-page' };
const OWNER_B = { webContentsId: 81, ownerSessionId: 'studio-page' };
const busyError = expect.objectContaining({ localSubtitleCode: 'resource_busy' });
const fixtures: Array<{ root: string; service: SpeechResourceService; busy: { legacy: boolean; studio: boolean } }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.busy.legacy = f.busy.studio = false;
    await f.service.shutdown();
    // Only the absolute, exclusively-created fixture root is removed.
    expect(path.dirname(f.root)).toBe(await realpath(os.tmpdir()));
    expect(path.basename(f.root).startsWith('fk-shared-')).toBe(true);
    await rm(f.root, { recursive: true, force: true });
  }
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(overrides: Partial<SpeechResourceServiceOptions> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fk-shared-')));
  const base = SPEECH_MODEL_MANIFEST.models[0];
  const bytes = Buffer.alloc(256, 0x5a);
  Buffer.from(base.ggml.magicHex, 'hex').copy(bytes);
  base.ggml.headerInt32Le.forEach((value, index) => bytes.writeInt32LE(value, 4 + index * 4));
  const model = { ...base, id: 'shared-test-model', fileName: 'shared-test.bin', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const options: SpeechResourceServiceOptions = { userDataRoot: root, migrationResources: [],
    modelCatalog: [model], vadManager: false, acceleratorManager: false,
    smokeModel: async () => undefined, smokeVad: async () => undefined,
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    downloadResource: async input => { await writeFile(input.destinationPath, bytes); return {}; }, ...overrides };
  const service = new SpeechResourceService(options);
  const busy = { legacy: false, studio: false };
  const legacy = service.createClient({ id: 'legacy', isResourceBusy: () => busy.legacy });
  const studio = service.createClient({ id: 'studio', isResourceBusy: () => busy.studio });
  const f = { root, bytes, model, options, service, legacy, studio, busy };
  fixtures.push(f);
  await service.initialize();
  return f;
}
async function install(f: Awaited<ReturnType<typeof fixture>>) {
  const job = f.legacy.startResourceInstall(OWNER_A, f.model.id);
  await f.legacy.waitForIdle();
  expect(f.studio.getSessionSnapshot(OWNER_B).resourceJobs.find(j => j.jobId === job.jobId)?.status).toBe('completed');
  return job;
}

describe('application speech resource ownership', () => {
  it('gives both tools the same verified file and shares deletion without downloading again', async () => {
    const f = await fixture(); await install(f);
    const a = await f.legacy.resolveManagedModel(f.model.id);
    const b = await f.studio.resolveManagedModel(f.model.id);
    expect(a).toEqual(b);
    expect(a.absolutePath).toBe(path.join(f.root, 'speech-resources', 'models', f.model.id, f.model.fileName));
    expect(await readFile(a.absolutePath)).toEqual(f.bytes);
    expect(await f.studio.listManagedResources(OWNER_B)).toMatchObject([{ status: 'ready' }]);
    await expect(f.studio.deleteManagedResource(OWNER_B, f.model.id)).resolves.toEqual({ deleted: true });
    expect(await f.legacy.listManagedResources(OWNER_A)).toMatchObject([{ status: 'not_installed' }]);
  });

  it('keeps application downloads alive after the originating page closes and lets the other page cancel', async () => {
    const entered = gate(); let signal!: AbortSignal;
    const f = await fixture({ downloadResource: async input => {
      signal = input.signal!; entered.release();
      await new Promise<void>((_, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
    } });
    const eventsA = vi.fn(); const eventsB = vi.fn();
    f.legacy.onResourceEvent(OWNER_A, eventsA); f.studio.onResourceEvent(OWNER_B, eventsB);
    const job = f.legacy.startResourceInstall(OWNER_A, f.model.id);
    await entered.promise;
    expect(await f.studio.listManagedResources(OWNER_B)).toMatchObject([{ status: 'installing' }]);
    f.legacy.releaseOwner(OWNER_A); await f.legacy.shutdown();
    const count = eventsA.mock.calls.length;
    expect(signal.aborted).toBe(false);
    expect(f.studio.getSessionSnapshot(OWNER_B).resourceJobs[0].jobId).toBe(job.jobId);
    expect(f.studio.cancelResourceJob(OWNER_B, job.jobId)).toEqual({ cancelled: true });
    await f.studio.waitForIdle();
    expect(f.studio.getSessionSnapshot(OWNER_B).resourceJobs[0].status).toBe('cancelled');
    expect(eventsA).toHaveBeenCalledTimes(count);
    expect(eventsB.mock.calls.at(-1)?.[0].event.job.status).toBe('cancelled');
  });

  it('reserves before admission awaits and preserves busy ownership through both consumers', async () => {
    const f = await fixture(); await install(f);
    const lease = f.studio.reserveUse([f.model.id, f.model.id]);
    await expect(f.legacy.deleteManagedResource(OWNER_A, f.model.id)).rejects.toEqual(busyError);
    expect(() => f.legacy.startResourceInstall(OWNER_A, f.model.id)).toThrow(busyError);
    f.busy.studio = true; lease.release(); lease.release();
    await expect(f.legacy.deleteManagedResource(OWNER_A, f.model.id)).rejects.toEqual(busyError);
    f.busy.studio = false; f.busy.legacy = true;
    await expect(f.studio.deleteManagedResource(OWNER_B, f.model.id)).rejects.toEqual(busyError);
    f.busy.legacy = false;
    await expect(f.studio.deleteManagedResource(OWNER_B, f.model.id)).resolves.toEqual({ deleted: true });
  });

  it('takes multi-resource leases atomically and rejects catalog/path injection', async () => {
    const f = await fixture();
    expect(() => f.studio.reserveUse([f.model.id, '../not-a-resource'])).toThrow();
    expect(f.service.status().busyResourceIds).toEqual([]);
    expect(() => f.legacy.startResourceInstall(OWNER_A, '../model')).toThrow();
    expect(() => f.legacy.importModel({ owner: OWNER_A, filePath: 'arbitrary', mode: 'copy' })).toThrow();
  });

  it('holds file verification leases until the actual read settles, and shutdown fences synchronously', async () => {
    const entered = gate(); const finish = gate();
    const f = await fixture(); await install(f);
    const read = f.studio.withResourceRead(f.model.id, async () => { entered.release(); await finish.promise; return 7; });
    await entered.promise;
    await expect(f.legacy.deleteManagedResource(OWNER_A, f.model.id)).rejects.toEqual(busyError);
    let shutdownSettled = false;
    const shutdown = f.service.shutdown().then(() => { shutdownSettled = true; });
    expect(() => f.studio.reserveUse([f.model.id])).toThrow(expect.objectContaining({ localSubtitleCode: 'owner_released' }));
    await Promise.resolve(); expect(shutdownSettled).toBe(false);
    finish.release(); expect(await read).toBe(7); await shutdown;
  });

  it('protects catalog observations from cross-tool deletion while allowing install progress snapshots', async () => {
    let pause = false; const entered = gate(); const finish = gate();
    const f = await fixture({ verifyModelFile: async (...args) => {
      if (pause) { entered.release(); await finish.promise; }
      return verifyLocalSubtitleGgmlModelFile(...args);
    } });
    await install(f);
    const identity = await f.studio.resolveManagedModel(f.model.id);
    // Change mtime to invalidate the cached observation without changing the valid payload.
    await utimes(identity.absolutePath, new Date(), new Date(Date.now() + 1000));
    pause = true;
    const read = f.studio.listManagedResources(OWNER_B);
    await entered.promise;
    await expect(f.legacy.deleteManagedResource(OWNER_A, f.model.id)).rejects.toEqual(busyError);
    finish.release(); await expect(read).resolves.toMatchObject([{ status: 'ready' }]);
  });

  it('prevents two service owners from running startup/migration against one physical root', async () => {
    const f = await fixture();
    const migrate = vi.fn(async () => ({ resources: [], issues: [], cleanupPending: false }));
    const second = new SpeechResourceService({ ...f.options, migration: migrate });
    await expect(second.initialize()).rejects.toEqual(busyError);
    expect(migrate).not.toHaveBeenCalled();
    await second.shutdown();
    await f.service.shutdown();
    const third = new SpeechResourceService(f.options); await third.initialize(); await third.shutdown();
  });

  it('retains ownership after failed native cleanup and permits shutdown retry only after consumers settle', async () => {
    const f = await fixture(); f.busy.studio = true;
    const first = f.service.shutdown(); expect(f.service.shutdown()).toBe(first);
    await expect(first).rejects.toEqual(busyError);
    const second = new SpeechResourceService(f.options);
    await expect(second.initialize()).rejects.toEqual(busyError); await second.shutdown();
    f.busy.studio = false; await f.service.shutdown();
    const third = new SpeechResourceService(f.options); await third.initialize(); await third.shutdown();
  });

  it('keeps install locks after terminal events until staging cleanup joins', async () => {
    const entered = gate(); const cleanup = gate();
    const f = await fixture({ removeStagingDirectory: async dir => {
      entered.release(); await cleanup.promise; await rm(dir, { recursive: true, force: true });
    } });
    f.legacy.startResourceInstall(OWNER_A, f.model.id); await entered.promise;
    expect(f.service.status().mutationResourceId).toBe(f.model.id);
    expect(() => f.studio.reserveUse([f.model.id])).toThrow(busyError);
    await expect(f.studio.deleteManagedResource(OWNER_B, f.model.id)).rejects.toEqual(busyError);
    cleanup.release(); await f.legacy.waitForIdle();
    expect(f.service.status().mutationResourceId).toBeUndefined();
  });

  it('retains only bounded application job history and continues accepting work', async () => {
    const f = await fixture({ downloadResource: async () => { throw new Error('transport unavailable'); } });
    const removed = vi.fn(); f.studio.onResourceEvent(OWNER_B, envelope => { if (envelope.event.type === 'resource-job-removed') removed(); });
    for (let i = 0; i < LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs + 2; i++) {
      f.legacy.startResourceInstall(OWNER_A, f.model.id); await f.legacy.waitForIdle();
    }
    expect(f.studio.getSessionSnapshot(OWNER_B).resourceJobs).toHaveLength(LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs);
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it('preserves a deletion cleanup lock after failure and recovers it on resource refresh', async () => {
    let fail = false;
    const f = await fixture({ removeStagingDirectory: async dir => {
      if (fail) throw Object.assign(new Error('file is locked'), { code: 'EBUSY' });
      await rm(dir, { recursive: true, force: true });
    } });
    await install(f); fail = true;
    try {
      await expect(f.studio.deleteManagedResource(OWNER_B, f.model.id)).rejects.toMatchObject({ localSubtitleCode: 'cancel_failed' });
      expect(f.service.status()).toMatchObject({ cleanupPending: true, mutationResourceId: f.model.id });
      expect(() => f.legacy.startResourceInstall(OWNER_A, f.model.id)).toThrow(busyError);
      expect(() => f.studio.reserveUse([f.model.id])).toThrow(busyError);
    } finally { fail = false; }
    expect(await f.legacy.listManagedResources(OWNER_A)).toMatchObject([{ status: 'not_installed' }]);
    expect(f.service.status()).toMatchObject({ cleanupPending: false, mutationResourceId: undefined });
    await install(f);
  });

  it('shares reentrant shutdown from cancellation observers without admitting new work', async () => {
    const entered = gate();
    const f = await fixture({ downloadResource: async input => {
      entered.release(); await new Promise<void>((_, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
    } });
    f.legacy.startResourceInstall(OWNER_A, f.model.id); await entered.promise;
    let observed: Promise<void> | undefined;
    f.studio.onResourceEvent(OWNER_B, event => { if (event.event.type === 'resource-job-updated' && event.event.job.status === 'cancelling') observed = f.service.shutdown(); });
    const operation = f.service.shutdown();
    expect(observed).toBe(operation);
    expect(() => f.legacy.startResourceInstall(OWNER_A, f.model.id)).toThrow();
    await operation;
  });

  it('retains copy/move source semantics across the shared client boundary', async () => {
    const f = await fixture(); const source = path.join(f.root, 'selected.bin');
    await writeFile(source, f.bytes);
    f.legacy.importModel({ owner: OWNER_A, filePath: source, modelId: f.model.id, mode: 'copy' });
    await f.legacy.waitForIdle(); expect((await lstat(source)).isFile()).toBe(true);
    await f.studio.deleteManagedResource(OWNER_B, f.model.id);
    f.legacy.importModel({ owner: OWNER_A, filePath: source, modelId: f.model.id, mode: 'move' });
    await f.legacy.waitForIdle(); await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.studio.listManagedResources(OWNER_B)).toMatchObject([{ status: 'ready' }]);
  });
});
