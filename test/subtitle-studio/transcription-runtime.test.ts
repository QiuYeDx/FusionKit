import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry,
  LocalSubtitleImportTokenRegistry } from '../../electron/main/subtitle-studio/transcription/native/authorizations';
import { LocalSubtitleArtifactRegistry } from '../../electron/main/subtitle-studio/transcription/native/subtitle-artifact-registry';
import { runtimeFixture, eventually } from './helpers/transcription-runtime';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { LocalSubtitleModelManager } from '../../electron/main/subtitle-studio/transcription/native/model-manager';

const OWNER = { webContentsId: 51, ownerSessionId: 'runtime-owner' };
const OTHER = { webContentsId: 52, ownerSessionId: 'runtime-other' };
const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
const extraRuntimes: ReturnType<typeof createTranscriptionRuntime>[] = [];
async function fixture(...args: Parameters<typeof runtimeFixture>) { const value = await runtimeFixture(...args); fixtures.push(value); return value; }

afterEach(async () => {
  const results = await Promise.allSettled(extraRuntimes.splice(0).map(runtime => runtime.shutdown('fatal')));
  results.push(...await Promise.allSettled(fixtures.splice(0).map(item => item.cleanup())));
  const failures = results.filter(result => result.status === 'rejected');
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime fixtures failed cleanup.');
});

describe('independent transcription runtime composition', () => {
  it('composes document tasks lazily against the supplied private repository', async () => {
    const item = await fixture();
    const repository = new DocumentRepository(path.join(item.userDataRoot, 'subtitle-studio', 'documents'));
    const runtime = createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters, repository);
    extraRuntimes.push(runtime);
    expect(() => runtime.tasks.list(OWNER)).toThrowError(expect.objectContaining({ code: 'not_initialized' }));
    expect(await readdir(item.userDataRoot)).toEqual([]);
    await runtime.initialize();
    expect(runtime.tasks.list(OWNER)).toEqual([]);
    await runtime.tasks.waitForIdle();
    expect(item.spawnProcess).not.toHaveBeenCalled();
    expect(item.mediaRunner).not.toHaveBeenCalled();
    await runtime.releaseOwner(OWNER);
    expect(() => runtime.tasks.list(OWNER)).toThrowError(expect.objectContaining({ code: 'owner_released' }));
    expect(runtime.tasks.list(OTHER)).toEqual([]);
    await runtime.shutdown();
    expect(runtime.snapshot().phase).toBe('closed');
  });

  it('rejects an untrusted repository object and never exposes tasks from resource-only hosts', async () => {
    const item = await fixture();
    expect(() => createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters, {} as never))
      .toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));
    await item.runtime.initialize();
    expect(() => item.runtime.tasks.list(OWNER)).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));
    expect(item.spawnProcess).not.toHaveBeenCalled();
  });

  it('issues only read/transcribe authority and exposes owner-bound idempotent draft revocation', async () => {
    const authorization = vi.spyOn(LocalSubtitleInputAuthorizationRegistry.prototype, 'authorize');
    const item = await fixture(); await item.runtime.initialize();
    const token = await item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    const issuer = authorization.mock.contexts[0]!;
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'transcribe')).resolves.toBeDefined();
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'derive_source_output')).rejects.toBeDefined();
    expect(item.runtime.media.revokeInput(OTHER, token.fileToken)).toBe(false);
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).resolves.toBeDefined();
    expect(item.runtime.media.revokeInput(OWNER, token.fileToken)).toBe(true);
    expect(item.runtime.media.revokeInput(OWNER, token.fileToken)).toBe(false);
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).rejects.toBeDefined();
  });

  it('publishes the one shutdown promise before synchronous owner abort callbacks', async () => {
    const item = await fixture(); await item.runtime.initialize();
    let reentrant: Promise<void> | undefined;
    vi.spyOn(LocalSubtitleModelManager.prototype, 'listManagedResources').mockImplementationOnce((_owner, signal) =>
      new Promise(resolve => signal!.addEventListener('abort', () => {
        reentrant = item.runtime.shutdown(); resolve([]);
      }, { once: true })));
    const pending = item.runtime.resources.list(OWNER).catch(error => error);
    const closing = item.runtime.shutdown();
    expect(reentrant).toBe(closing);
    expect(item.runtime.shutdown()).toBe(closing);
    await closing;
    expect(await pending).toMatchObject({ code: 'runtime_closed' });
  });

  it('rejects invalid options and mismatched targets before creating directories', async () => {
    const item = await fixture();
    const options = { userDataRoot: item.userDataRoot, environment: item.bundle.environment };
    for (const invalid of [null, { ...options, userDataRoot: 'relative' }, { ...options, userDataRoot: '/bad\0path' },
      { ...options, environment: {} }, { ...options, environment: { mode: 'development', appRoot: 'relative' } },
      { ...options, environment: { ...item.bundle.environment, platform: 'linux' } },
      { ...options, environment: { ...item.bundle.environment, arch: item.bundle.environment.platform === 'win32' ? 'arm64' : 'x64' } },
      { ...options, managedResourceRoot: '/arbitrary' }]) {
      expect(() => createTranscriptionRuntime(invalid as never)).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));
    }
    expect(await readdir(item.userDataRoot)).toEqual([]);
  });
  it('constructs without I/O and explicitly initializes only its own managed root', async () => {
    const item = await fixture();
    const legacy = path.join(item.userDataRoot, 'local-subtitle');
    await mkdir(legacy); await writeFile(path.join(legacy, 'sentinel'), 'preserve');
    expect(item.runtime.snapshot()).toEqual({ phase: 'new', server: null });
    expect(await readdir(item.userDataRoot)).toEqual(['local-subtitle']);
    expect(() => item.runtime.resources.list(OWNER)).toThrowError(expect.objectContaining({ code: 'not_initialized' }));
    const first = item.runtime.initialize(); expect(item.runtime.initialize()).toBe(first); await first;
    expect(item.runtime.snapshot()).toMatchObject({ phase: 'initialized', server: { state: 'unloaded', leaseCount: 0, runtimePinCount: 0 } });
    expect((await item.runtime.resources.list(OWNER)).every(resource => resource.status === 'not_installed')).toBe(true);
    expect(await readFile(path.join(legacy, 'sentinel'), 'utf8')).toBe('preserve');
    expect(item.spawnProcess).not.toHaveBeenCalled(); expect(item.reservePort).not.toHaveBeenCalled();
    expect(item.mediaRunner).not.toHaveBeenCalled(); expect(item.downloadResource).not.toHaveBeenCalled();
    expect(item.runtime).not.toHaveProperty('models'); expect(item.runtime).not.toHaveProperty('modelManager');
    const closing = item.runtime.shutdown(); expect(item.runtime.shutdown()).toBe(closing); await closing;
    await expect(item.runtime.initialize()).rejects.toMatchObject({ code: 'runtime_closed' });
  });

  it('claims canonical userData roots once and releases the claim only after successful close', async () => {
    const item = await fixture();
    await item.runtime.initialize();
    const aliasParent = path.join(item.bundle.tempRoot, 'alias');
    await symlink(item.bundle.tempRoot, aliasParent, 'dir');
    const alias = createTranscriptionRuntime({ userDataRoot: path.join(aliasParent, 'user-data'), environment: item.bundle.environment }, item.adapters);
    extraRuntimes.push(alias);
    await expect(alias.initialize()).rejects.toMatchObject({ code: 'runtime_busy' });
    await item.runtime.shutdown();
    const fresh = createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters);
    extraRuntimes.push(fresh); await fresh.initialize();
    expect(fresh.snapshot().phase).toBe('initialized');
  });

  it('does not follow a managed-root symlink into adjacent data', async () => {
    const item = await fixture();
    const legacy = path.join(item.userDataRoot, 'legacy-data'); await mkdir(legacy);
    await writeFile(path.join(legacy, 'sentinel'), 'untouched');
    await symlink(legacy, path.join(item.userDataRoot, 'subtitle-studio'), 'dir');
    await expect(item.runtime.initialize()).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(await readdir(legacy)).toEqual(['sentinel']);
  });

  it('reports missing and tampered new runtime resources without probing adjacent old resources', async () => {
    const item = await fixture(); await item.runtime.initialize();
    expect(await item.runtime.inspectRuntime()).toMatchObject({ status: 'verified', target: item.bundle.manifest.target });
    const oldRoot = path.join(item.bundle.tempRoot, 'runtime', 'local-subtitle');
    await mkdir(path.dirname(oldRoot), { recursive: true });
    await rename(item.bundle.runtimeRoot, oldRoot);
    expect(await item.runtime.inspectRuntime()).toMatchObject({ status: 'missing' });
    await rename(oldRoot, item.bundle.runtimeRoot);
    const artifact = Object.values(item.bundle.artifactPaths)[0]!;
    await writeFile(artifact, Buffer.alloc(8));
    expect(await item.runtime.inspectRuntime()).toMatchObject({ status: 'invalid' });
    expect(item.spawnProcess).not.toHaveBeenCalled(); expect(item.mediaRunner).not.toHaveBeenCalled();
  });

  it('isolates equal owner identifiers and input credentials across runtime instances', async () => {
    const a = await fixture(), b = await fixture(); await Promise.all([a.runtime.initialize(), b.runtime.initialize()]);
    const token = await a.runtime.media.authorizeInput(OWNER, a.sourcePath);
    await expect(b.runtime.media.probe(OWNER, token.fileToken)).rejects.toBeDefined();
    expect(b.mediaRunner).not.toHaveBeenCalled();
    a.runtime.releaseOwner(OWNER);
    expect(() => a.runtime.resources.snapshot(OWNER)).toThrowError(expect.objectContaining({ code: 'owner_released' }));
    expect(b.runtime.resources.snapshot(OWNER)).toMatchObject({ resourceJobs: [] });
    expect(a.runtime.resources.snapshot(OTHER)).toMatchObject({ resourceJobs: [] });
    await a.runtime.shutdown();
    expect(b.runtime.resources.snapshot(OWNER)).toMatchObject({ resourceJobs: [] });
  });

  it('does not return async authorization or resource results after the owner is released', async () => {
    const item = await fixture(); await item.runtime.initialize();
    const authorization = item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    item.runtime.releaseOwner(OWNER);
    await expect(authorization).rejects.toBeDefined();
    const listing = item.runtime.resources.list(OTHER);
    item.runtime.releaseOwner(OTHER);
    await expect(listing).rejects.toBeDefined();
  });

  it('revokes actual input authority and still visits every capability registry when one revocation fails', async () => {
    const authorizations = vi.spyOn(LocalSubtitleInputAuthorizationRegistry.prototype, 'authorize');
    const inputRelease = vi.spyOn(LocalSubtitleInputAuthorizationRegistry.prototype, 'releaseOwner');
    const outputRelease = vi.spyOn(LocalSubtitleOutputDirectoryAuthorizationRegistry.prototype, 'releaseOwner');
    const artifactRelease = vi.spyOn(LocalSubtitleArtifactRegistry.prototype, 'releaseOwner');
    const importRelease = vi.spyOn(LocalSubtitleImportTokenRegistry.prototype, 'releaseOwner');
    const item = await fixture(); await item.runtime.initialize();
    const token = await item.runtime.media.authorizeInput(OWNER, item.sourcePath);
    const issuer = authorizations.mock.contexts[0]!;
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).resolves.toMatchObject({ filePath: await realpath(item.sourcePath) });
    inputRelease.mockImplementationOnce(() => { throw new Error('Injected capability revocation failure.'); });
    expect(() => item.runtime.releaseOwner(OWNER)).toThrow('owner release failed');
    expect(outputRelease).toHaveBeenCalledWith(OWNER);
    expect(artifactRelease).toHaveBeenCalledWith(OWNER);
    expect(importRelease).toHaveBeenCalledWith(OWNER);
    item.runtime.releaseOwner(OWNER);
    await expect(issuer.resolveDraft(OWNER, token.fileToken, 'probe')).rejects.toBeDefined();
  });

  it('copies and validates a small GGML model, preserves its source, and survives source deletion', async () => {
    const item = await fixture(); await item.runtime.initialize();
    const before = await stat(item.sourcePath);
    const job = item.runtime.resources.importModel({ owner: OWNER, filePath: item.sourcePath, modelId: item.model.id });
    await item.runtime.resources.waitForIdle();
    expect(item.runtime.resources.snapshot(OWNER).resourceJobs.find(value => value.jobId === job.jobId)).toMatchObject({ status: 'completed' });
    expect(await readFile(item.sourcePath)).toEqual(item.bytes);
    const managed = await item.runtime.resources.resolveModel(OWNER, item.model.id);
    expect(managed.absolutePath.startsWith(path.join(item.runtime.managedResourceRoot, 'models') + path.sep)).toBe(true);
    expect(await readFile(managed.absolutePath)).toEqual(item.bytes);
    expect((await stat(managed.absolutePath)).ino).not.toBe(before.ino);
    expect((await stat(item.sourcePath)).ino).toBe(before.ino);
    expect(item.spawnProcess).toHaveBeenCalledOnce();
    expect(item.spawnProcess.mock.calls[0][1]).toContain('--no-gpu');
    await rm(item.sourcePath);
    expect((await item.runtime.resources.resolveModel(OWNER, item.model.id)).sha256).toBe(item.model.sha256);
    expect((await item.runtime.resources.list(OWNER)).find(value => value.resourceId === item.model.id)?.status).toBe('ready');
    await item.runtime.shutdown();
    expect(item.children[0].closed).toBe(true);
    expect(item.events.indexOf('child-closed')).toBeLessThan(item.events.indexOf('cleanup-session'));
    for (const session of item.sessions) await expect(lstat(session)).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters);
    extraRuntimes.push(reopened); await reopened.initialize();
    expect((await reopened.resources.resolveModel(OWNER, item.model.id)).sha256).toBe(item.model.sha256);
  });

  it('rejects move, unknown fields and unlisted model identity before opening a source', async () => {
    const item = await fixture(); await item.runtime.initialize();
    const request = { owner: OWNER, filePath: item.sourcePath, modelId: item.model.id };
    expect(() => item.runtime.resources.importModel({ ...request, mode: 'move' } as never)).toThrow();
    expect(() => item.runtime.resources.importModel({ ...request, extra: true } as never)).toThrow();
    expect(() => item.runtime.resources.importModel({ ...request, modelId: 'unknown-model' })).toThrow();
    expect(() => item.runtime.resources.install(OWNER, 'unknown-model')).toThrow();
    expect(item.runtime.resources.snapshot(OWNER).resourceJobs).toEqual([]);
    expect(await readFile(item.sourcePath)).toEqual(item.bytes); expect(item.spawnProcess).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'release', 'shutdown'] as const)('quiesces an active resource smoke during %s and cleans only its process', async action => {
    const item = await fixture(), sibling = await fixture();
    await Promise.all([item.runtime.initialize(), sibling.runtime.initialize()]);
    item.controls.holdReadiness = true;
    const job = item.runtime.resources.importModel({ owner: OWNER, filePath: item.sourcePath, modelId: item.model.id });
    await eventually(() => item.readiness.mock.calls.length > 0);
    await expect(item.runtime.resources.delete(OWNER, item.model.id)).rejects.toMatchObject({ localSubtitleCode: 'resource_busy' });
    if (action === 'cancel') item.runtime.resources.cancel(OWNER, job.jobId);
    if (action === 'release') item.runtime.releaseOwner(OWNER);
    if (action === 'shutdown') await item.runtime.shutdown();
    else { await item.runtime.resources.waitForIdle(); await item.runtime.shutdown(); }
    expect(item.events).toContain('readiness-aborted');
    expect(item.children.every(child => child.closed)).toBe(true);
    expect(item.runtime.snapshot()).toMatchObject({ phase: 'closed', server: { leaseCount: 0, runtimePinCount: 0, activeRequest: false } });
    expect(sibling.runtime.resources.snapshot(OWNER)).toMatchObject({ resourceJobs: [] });
    expect(sibling.spawnProcess).not.toHaveBeenCalled();
    expect(await readFile(item.sourcePath)).toEqual(item.bytes);
    for (const session of item.sessions) await expect(lstat(session)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves initialization failure and joins close while initialization is pending', async () => {
    const failure = new Error('startup cleanup denied');
    const failed = await fixture({ startupCleanup: async () => { throw failure; } });
    const operation = failed.runtime.initialize();
    await expect(operation).rejects.toBe(failure); expect(failed.runtime.initialize()).toBe(operation);
    expect(failed.spawnProcess).not.toHaveBeenCalled(); await failed.runtime.shutdown();
    let unblock!: () => void;
    const pending = await fixture({ startupCleanup: async () => { await new Promise<void>(resolve => { unblock = resolve; }); return { removedDownloads: 0 } as never; } });
    const opening = pending.runtime.initialize(); const observed = opening.catch(error => error);
    await eventually(() => Boolean(unblock));
    const closing = pending.runtime.shutdown(); expect(pending.runtime.shutdown()).toBe(closing);
    unblock(); expect(await observed).toMatchObject({ code: 'runtime_closed' }); await closing;
    expect(pending.runtime.snapshot()).toEqual({ phase: 'closed', server: null });
  });

  it('retains the root claim after cleanup fails and permits an explicit cleanup retry', async () => {
    const item = await fixture(); await item.runtime.initialize();
    item.controls.holdReadiness = true;
    item.runtime.resources.importModel({ owner: OWNER, filePath: item.sourcePath, modelId: item.model.id });
    await eventually(() => item.readiness.mock.calls.length > 0);
    item.controls.cleanupFailures = 20;
    await expect(item.runtime.shutdown()).rejects.toThrow('cleanup failed');
    expect(item.children.every(child => child.closed)).toBe(true);
    const rival = createTranscriptionRuntime({ userDataRoot: item.userDataRoot, environment: item.bundle.environment }, item.adapters);
    extraRuntimes.push(rival); await expect(rival.initialize()).rejects.toMatchObject({ code: 'runtime_busy' });
    item.controls.cleanupFailures = 0;
    await item.runtime.shutdown();
    expect(item.runtime.snapshot().phase).toBe('closed');
  });
});
