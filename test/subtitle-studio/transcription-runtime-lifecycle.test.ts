import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { LocalSubtitleSessionLifecycle } from '../../electron/main/subtitle-studio/transcription/native/session-lifecycle';
import { LocalSubtitleModelManager } from '../../electron/main/subtitle-studio/transcription/native/model-manager';
import { LocalSubtitleMediaNormalizer } from '../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { LocalSubtitleServerSupervisor } from '../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { LocalSubtitleSessionRegistry } from '../../electron/main/subtitle-studio/transcription/native/session-registry';
import { LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry,
  LocalSubtitleImportTokenRegistry } from '../../electron/main/subtitle-studio/transcription/native/authorizations';
import { LocalSubtitleArtifactRegistry } from '../../electron/main/subtitle-studio/transcription/native/subtitle-artifact-registry';
import { runtimeFixture, eventually } from './helpers/transcription-runtime';

const taskFactory = vi.hoisted(() => vi.fn());
vi.mock('../../electron/main/subtitle-studio/transcription/task-service', () => ({ createTranscriptionTaskService: taskFactory }));

const OWNER = { webContentsId: 91, ownerSessionId: 'lifecycle-owner' };
const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
const runtimes: ReturnType<typeof createTranscriptionRuntime>[] = [];
const unblock: (() => void)[] = [];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  unblock.push(resolve);
  return { promise, resolve };
}

async function fixture() {
  // Only the task queue is controlled. Storage, capabilities and native lifecycle
  // services use the real composition with the isolated synthetic-host adapters.
  const tasks = {
    releaseOwner: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
    confirmCleanup: vi.fn(), isResourceBusy: vi.fn(() => false), list: vi.fn(() => []),
    waitForIdle: vi.fn(async () => {}),
  };
  taskFactory.mockReturnValue(tasks);
  const item = await runtimeFixture(); fixtures.push(item);
  const repository = new DocumentRepository(path.join(item.userDataRoot, 'subtitle-studio', 'documents'));
  const create = () => {
    const value = createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters, repository);
    runtimes.push(value); return value;
  };
  const runtime = create();
  await runtime.initialize();
  return { ...item, runtime, tasks, create };
}

afterEach(async () => {
  for (const resolve of unblock.splice(0)) resolve();
  const results = await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.shutdown('fatal')));
  results.push(...await Promise.allSettled(fixtures.splice(0).map(item => item.cleanup())));
  vi.restoreAllMocks(); taskFactory.mockReset();
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Document runtime fixture cleanup failed.');
});

describe('document transcription runtime lifecycle joins', () => {
  it('joins an owner task before native owner release and concurrent shutdown cleanup', async () => {
    const item = await fixture();
    await item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    const held = gate();
    item.tasks.releaseOwner.mockImplementationOnce(() => held.promise);
    const ownerRelease = vi.spyOn(LocalSubtitleSessionLifecycle.prototype, 'releaseOwner');
    const nativeShutdown = vi.spyOn(LocalSubtitleSessionLifecycle.prototype, 'shutdown');
    const mediaShutdown = vi.spyOn(LocalSubtitleMediaNormalizer.prototype, 'shutdown');
    const closingOwner = item.runtime.releaseOwner(OWNER);
    expect(() => item.runtime.tasks.list(OWNER)).toThrowError(expect.objectContaining({ code: 'owner_released' }));
    await eventually(() => item.tasks.releaseOwner.mock.calls.length === 1);
    expect(ownerRelease).not.toHaveBeenCalled();

    const closingRuntime = item.runtime.shutdown();
    await eventually(() => item.tasks.shutdown.mock.calls.length === 1);
    expect(ownerRelease).not.toHaveBeenCalled();
    expect(nativeShutdown).not.toHaveBeenCalled();
    expect(mediaShutdown).not.toHaveBeenCalled();
    expect(item.tasks.confirmCleanup).not.toHaveBeenCalled();
    const rival = item.create();
    await expect(rival.initialize()).rejects.toMatchObject({ code: 'runtime_busy' });

    held.resolve(); await closingOwner; await closingRuntime;
    expect(ownerRelease).toHaveBeenCalledOnce();
    expect(ownerRelease).toHaveBeenCalledWith(OWNER);
    expect(nativeShutdown).toHaveBeenCalledOnce();
    expect(mediaShutdown).toHaveBeenCalledOnce();
    expect(ownerRelease.mock.invocationCallOrder[0]).toBeLessThan(nativeShutdown.mock.invocationCallOrder[0]);
    expect(mediaShutdown.mock.invocationCallOrder[0]).toBeLessThan(item.tasks.confirmCleanup.mock.invocationCallOrder[0]);
    expect(item.runtime.snapshot().phase).toBe('closed');
  });

  it('runs every native phase after task shutdown failure and retains the root until successful retry', async () => {
    const item = await fixture();
    const authorize = vi.spyOn(LocalSubtitleInputAuthorizationRegistry.prototype, 'authorize');
    const token = await item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    const issuer = authorize.mock.contexts[0]!;
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).resolves.toBeDefined();
    const failure = new Error('Injected task cleanup failure.');
    item.tasks.shutdown.mockRejectedValueOnce(failure);
    const models = vi.spyOn(LocalSubtitleModelManager.prototype, 'shutdown');
    const media = vi.spyOn(LocalSubtitleMediaNormalizer.prototype, 'shutdown');
    const server = vi.spyOn(LocalSubtitleServerSupervisor.prototype, 'shutdown');
    const registry = vi.spyOn(LocalSubtitleSessionRegistry.prototype, 'shutdown');
    const inputs = vi.spyOn(LocalSubtitleInputAuthorizationRegistry.prototype, 'releaseOwner');
    const outputs = vi.spyOn(LocalSubtitleOutputDirectoryAuthorizationRegistry.prototype, 'releaseOwner');
    const artifacts = vi.spyOn(LocalSubtitleArtifactRegistry.prototype, 'releaseOwner');
    const imports = vi.spyOn(LocalSubtitleImportTokenRegistry.prototype, 'releaseOwner');

    const rejected = await item.runtime.shutdown().catch(error => error);
    expect(rejected).toBeInstanceOf(AggregateError);
    expect(rejected.errors).toContain(failure);
    for (const phase of [models, media, server, registry]) expect(phase).toHaveBeenCalledOnce();
    for (const capability of [inputs, outputs, artifacts, imports]) expect(capability).toHaveBeenCalledWith(OWNER);
    expect(models.mock.invocationCallOrder[0]).toBeLessThan(media.mock.invocationCallOrder[0]);
    expect(server.mock.invocationCallOrder[0]).toBeLessThan(registry.mock.invocationCallOrder[0]);
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).rejects.toBeDefined();
    expect(item.tasks.confirmCleanup).not.toHaveBeenCalled();
    expect(item.runtime.snapshot().phase).toBe('failed');
    const rival = item.create();
    await expect(rival.initialize()).rejects.toMatchObject({ code: 'runtime_busy' });

    await item.runtime.shutdown();
    expect(item.tasks.shutdown).toHaveBeenCalledTimes(2);
    expect(item.tasks.confirmCleanup).toHaveBeenCalledOnce();
    expect(item.runtime.snapshot().phase).toBe('closed');
    const reopened = item.create(); await reopened.initialize();
    expect(reopened.snapshot().phase).toBe('initialized');
  });

  it('publishes one owner release promise before synchronous abort reentry', async () => {
    const item = await fixture();
    const held = gate();
    item.tasks.releaseOwner.mockImplementationOnce(() => held.promise);
    let reentrant: Promise<void> | undefined;
    vi.spyOn(LocalSubtitleModelManager.prototype, 'listManagedResources').mockImplementationOnce((_owner, signal) =>
      new Promise(resolve => signal!.addEventListener('abort', () => {
        reentrant = item.runtime.releaseOwner(OWNER); resolve([]);
      }, { once: true })));
    const ownerRelease = vi.spyOn(LocalSubtitleSessionLifecycle.prototype, 'releaseOwner');
    const pending = item.runtime.resources.list(OWNER).catch(error => error);
    const operation = item.runtime.releaseOwner(OWNER);
    expect(reentrant).toBe(operation);
    expect(item.runtime.releaseOwner(OWNER)).toBe(operation);
    await eventually(() => item.tasks.releaseOwner.mock.calls.length === 1);
    expect(ownerRelease).not.toHaveBeenCalled();
    held.resolve(); await operation;
    expect(item.tasks.releaseOwner).toHaveBeenCalledOnce();
    expect(ownerRelease).toHaveBeenCalledOnce();
    expect(ownerRelease).toHaveBeenCalledWith(OWNER);
    expect(await pending).toMatchObject({ code: 'owner_released' });
  });

  it('joins synchronous task release failure, still releases native owners, and permits retry', async () => {
    const item = await fixture();
    await item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    const failure = new Error('Injected synchronous owner-release failure.');
    item.tasks.releaseOwner.mockImplementationOnce(() => { throw failure; });
    const nativeRelease = vi.spyOn(LocalSubtitleSessionLifecycle.prototype, 'releaseOwner');
    let operation!: Promise<void>;
    expect(() => { operation = item.runtime.releaseOwner(OWNER); }).not.toThrow();
    const rejected = await operation.catch(error => error);
    expect(rejected).toBeInstanceOf(AggregateError);
    expect(rejected.errors).toContain(failure);
    expect(nativeRelease).toHaveBeenCalledOnce();
    expect(nativeRelease).toHaveBeenCalledWith(OWNER);
    await item.runtime.releaseOwner(OWNER);
    expect(item.tasks.releaseOwner).toHaveBeenCalledTimes(2);
    expect(nativeRelease).toHaveBeenCalledTimes(2);
  });
});
