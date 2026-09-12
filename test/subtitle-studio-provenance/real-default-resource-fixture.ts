// Maintenance-only real resources. Product code must never import this fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rmdir, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalSubtitleModelManager as LegacyModelManager } from '../../electron/main/local-subtitle/model-manager';
import { LocalSubtitleServerSupervisor as LegacySupervisor } from '../../electron/main/local-subtitle/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor as legacyAttestor } from '../../electron/main/local-subtitle/backend-attestor';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION as legacyCuda } from '../../electron/main/local-subtitle/accelerator-manager';
import { LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION as legacyVad } from '../../electron/main/local-subtitle/vad-manager';
import { LocalSubtitleModelManager as StudioModelManager } from '../../electron/main/subtitle-studio/transcription/native/model-manager';
import { LocalSubtitleServerSupervisor as StudioSupervisor } from '../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor as studioAttestor } from '../../electron/main/subtitle-studio/transcription/native/backend-attestor';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION as studioCuda } from '../../electron/main/subtitle-studio/transcription/native/accelerator-manager';
import { LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION as studioVad } from '../../electron/main/subtitle-studio/transcription/native/vad-manager';
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from '../../electron/main/subtitle-studio/transcription/native/model-manifest';
import type { DownloadLocalSubtitleResourceOptions } from '../../electron/main/subtitle-studio/transcription/native/resource-download';

type Side = 'legacy' | 'studio';
type SourceKind = 'model' | 'vad' | 'cudaArchive';
const OWNER = Object.freeze({ webContentsId: 808, ownerSessionId: 'real-default-resource-fixture' });
const MODEL = LOCAL_SUBTITLE_MODEL_MANIFEST.models.find(model => model.id === 'large-v3-q5_0')!;
const INSTALL_MS = 10 * 60_000;
const CLEANUP_MS = 45_000;
const CHUNK = 1024 * 1024;

export interface ResourceFileFingerprint {
  path: string; byteSize: number; sha256: string; dev: string; ino: string; mtimeNs: string;
}
interface SideRoots { userDataRoot: string; managedResourceRoot: string }
interface SideEvidence extends SideRoots {
  phase: string; installJobs: unknown[]; resourceEvents: unknown[];
  installedArtifacts: { resourceId: string; kind: string; file: ResourceFileFingerprint }[];
  observedProcessIds: number[]; preparationClosed?: boolean; processesExited?: boolean; cleanupPending?: boolean;
  cudaPackGeneration?: string; error?: string;
}
export interface ResourceCleanupEvidence {
  status: 'running' | 'passed' | 'failed';
  sides: Partial<Record<Side, { deletions: { resourceId: string; deleted: boolean }[]; managerClosed: boolean; rootRemoved: boolean; error?: string }>>;
  sourcesUnchanged?: boolean; error?: string;
  joined?: boolean; cleanupPending?: boolean; deadlineExceeded?: boolean;
  resourceRootRemoved?: boolean;
}
export interface RealDefaultResourceEvidence {
  schemaVersion: 1; status: 'preparing' | 'prepared' | 'failed';
  resourceRoot: { path: string; dev: string; ino: string };
  pathBudgets: ReturnType<typeof realDefaultResourceLayout>['pathBudgets'];
  sourcesBefore?: Record<SourceKind, ResourceFileFingerprint>;
  sourcesAfter?: Record<SourceKind, ResourceFileFingerprint>;
  sourcesUnchanged?: boolean; legacy: SideEvidence; studio: SideEvidence;
  cleanup?: ResourceCleanupEvidence; error?: string;
}
export interface PrepareRealDefaultResourcesOptions {
  projectRoot: string; runRoot: string; modelSourcePath: string;
  vadSourcePath?: string; cudaArchiveSourcePath?: string; signal?: AbortSignal;
  onProgress?: (evidence: RealDefaultResourceEvidence) => void | Promise<void>;
}

const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Include the unmodified production UUID, mkdtemp suffix, pack root and every actual leaf. */
export function realDefaultResourceLayout(resourceRoot: string) {
  const sideRoots = (side: Side): SideRoots => {
    const userDataRoot = path.join(resourceRoot, side === 'legacy' ? 'l' : 's');
    return { userDataRoot, managedResourceRoot: side === 'studio' ? path.join(userDataRoot, 'subtitle-studio', 'transcription') : path.join(userDataRoot, 'local-subtitle') };
  };
  const legacy = sideRoots('legacy'), studio = sideRoots('studio');
  const pathBudgets = (['legacy', 'studio'] as const).map(side => {
    const root = side === 'legacy' ? legacy : studio, pack = side === 'legacy' ? legacyCuda : studioCuda;
    const uuid = '00000000-0000-0000-0000-000000000000', vad = side === 'legacy' ? legacyVad : studioVad;
    const receipt = path.join(root.managedResourceRoot, 'accelerator-staging', `.install-${pack.resourceId}-${uuid}-XXXXXX`);
    const archive = path.join(receipt, pack.sourceArchive.fileName);
    const artifacts = pack.artifacts.map(artifact => path.join(receipt, 'pack', artifact.relativePath));
    const manifest = path.join(receipt, 'pack', pack.manifestRelativePath);
    const longestArtifact = artifacts.reduce((longest, file) => file.length > longest.length ? file : longest, '');
    const otherGeneratedPaths = [
      path.join(root.managedResourceRoot, 'accelerator-downloads', `${pack.resourceId}.part`),
      path.join(root.managedResourceRoot, 'accelerator-downloads', `${pack.resourceId}.part.json`),
      path.join(root.managedResourceRoot, 'accelerators', pack.resourceId, pack.manifestRelativePath),
      path.join(root.managedResourceRoot, 'model-staging', `.import-${uuid}-XXXXXX`, MODEL.fileName),
      path.join(root.managedResourceRoot, 'vad-staging', `.install-${vad.resourceId}-${uuid}-XXXXXX`, vad.fileName),
      path.join(root.managedResourceRoot, 'vad-staging', `.install-${vad.resourceId}-${uuid}-XXXXXX`, vad.manifestFileName),
      path.join(root.managedResourceRoot, 'resource-downloads', `${vad.resourceId}.part.json`),
    ];
    const otherGeneratedPathLength = Math.max(...otherGeneratedPaths.map(file => file.length));
    const otherGeneratedParentLength = Math.max(...otherGeneratedPaths.map(file => path.dirname(file).length));
    return { side, receiptLength: receipt.length, archiveLength: archive.length, longestArtifactLength: longestArtifact.length,
      longestArtifact, manifestLength: manifest.length, manifestParentLength: path.dirname(manifest).length,
      otherGeneratedPathLength, otherGeneratedParentLength,
      accepted: Math.max(receipt.length, archive.length, longestArtifact.length, path.dirname(manifest).length, otherGeneratedParentLength) <= 245
        && Math.max(manifest.length, otherGeneratedPathLength) < 260 };
  });
  return { legacy, studio, pathBudgets };
}
function alive(processId: number) {
  try { process.kill(processId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function within<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer!); }
}
async function closeAll(operations: (() => Promise<unknown>)[], label: string) {
  const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, label);
}
/** A timeout rejects the caller without releasing authority held by unfinished cleanup. */
export function createResourceCleanupGate<T>(operation: () => Promise<T>, milliseconds: number,
  onDeadline: (error: Error) => void = () => {}, onSettled: () => void = () => {}) {
  let inFlight: Promise<T> | undefined;
  return function run(): Promise<T> {
    if (inFlight) return inFlight;
    let settled = false, rejected = false;
    const work = Promise.resolve().then(operation);
    const clearRejected = () => { if (settled && rejected && inFlight === current) inFlight = undefined; };
    const complete = () => { settled = true; onSettled(); clearRejected(); };
    void work.then(complete, complete);
    const current = within(work, milliseconds, 'Resource cleanup exceeded its 45-second deadline').catch(error => {
      rejected = true;
      if (!settled) onDeadline(error as Error);
      clearRejected(); throw error;
    });
    inFlight = current;
    return current;
  };
}
function sameIdentity(a: ResourceFileFingerprint, b: ResourceFileFingerprint) {
  return samePath(a.path, b.path) && a.byteSize === b.byteSize && a.sha256 === b.sha256 && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;
}

/** Read a held file, refusing a changed path or bytes during the observation. */
export async function fingerprintResourceFile(file: string, signal?: AbortSignal): Promise<ResourceFileFingerprint> {
  signal?.throwIfAborted();
  const absolutePath = path.resolve(file), entry = await lstat(absolutePath, { bigint: true });
  assert(entry.isFile() && !entry.isSymbolicLink(), 'Resource source must be a regular file');
  assert(samePath(await realpath(absolutePath), absolutePath), 'Resource path may not traverse a link');
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    assert.equal(before.dev, entry.dev); assert.equal(before.ino, entry.ino);
    const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK); let total = 0;
    while (true) { signal?.throwIfAborted(); const result = await handle.read(buffer, 0, buffer.length, total); if (!result.bytesRead) break;
      total += result.bytesRead; hash.update(buffer.subarray(0, result.bytesRead)); }
    const after = await handle.stat({ bigint: true }), named = await lstat(absolutePath, { bigint: true });
    for (const observed of [after, named]) {
      assert.equal(observed.dev, before.dev); assert.equal(observed.ino, before.ino);
      assert.equal(observed.size, before.size); assert.equal(observed.mtimeNs, before.mtimeNs);
    }
    assert.equal(BigInt(total), before.size);
    return { path: absolutePath, byteSize: total, sha256: hash.digest('hex'), dev: before.dev.toString(), ino: before.ino.toString(), mtimeNs: before.mtimeNs.toString() };
  } finally { await handle.close(); }
}

/** Only transport is substituted: the production manager still verifies and publishes every resource. */
export function createPinnedResourceCopyTransport(managedRoot: string, sources: readonly { sourceUrl: string; file: ResourceFileFingerprint }[]) {
  return async (options: DownloadLocalSubtitleResourceOptions) => {
    options.signal.throwIfAborted();
    const source = sources.find(candidate => candidate.sourceUrl === options.sourceUrl);
    assert(source, 'The resource transport URL is not pinned');
    assert.equal(options.expectedBytes, source.file.byteSize, 'Unexpected resource byte size');
    assert(options.allowedHosts.includes(new URL(source.sourceUrl).hostname), 'Resource host is not allowlisted');
    const root = await realpath(managedRoot), destination = path.resolve(options.destinationPath);
    assert(samePath(root, path.resolve(managedRoot)) && isInside(root, destination), 'Resource destination escaped its managed root');
    assert(samePath(await realpath(path.dirname(destination)), path.dirname(destination)), 'Resource destination traverses a link');
    assert(sameIdentity(await fingerprintResourceFile(source.file.path, options.signal), source.file), 'Pinned resource source changed');
    await options.ensureCapacity(source.file.byteSize);
    options.signal.throwIfAborted();
    const input = await open(source.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let output: FileHandle | undefined, primaryFailure: unknown;
    try {
      const inputStat = await input.stat({ bigint: true });
      assert.equal(inputStat.dev.toString(), source.file.dev); assert.equal(inputStat.ino.toString(), source.file.ino);
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const buffer = Buffer.alloc(CHUNK), digest = createHash('sha256'); let position = 0;
      while (position < source.file.byteSize) {
        options.signal.throwIfAborted();
        const read = await input.read(buffer, 0, Math.min(buffer.length, source.file.byteSize - position), position);
        assert(read.bytesRead > 0, 'Pinned source ended early'); digest.update(buffer.subarray(0, read.bytesRead));
        let written = 0;
        while (written < read.bytesRead) { const result = await output.write(buffer, written, read.bytesRead - written, position + written); assert(result.bytesWritten > 0); written += result.bytesWritten; }
        position += read.bytesRead; options.onProgress?.(position, source.file.byteSize);
      }
      assert.equal(digest.digest('hex'), source.file.sha256, 'Pinned resource bytes changed during copy');
      const after = await input.stat({ bigint: true });
      assert.equal(after.size, BigInt(source.file.byteSize)); assert.equal(after.mtimeNs.toString(), source.file.mtimeNs);
      await output.sync(); options.signal.throwIfAborted();
      const copied = await output.stat({ bigint: true });
      assert(copied.dev.toString() !== source.file.dev || copied.ino.toString() !== source.file.ino, 'Resource must be copied, never hard linked');
      return { absolutePath: destination, byteSize: position, resumedBytes: 0, effectiveUrl: source.sourceUrl };
    } catch (error) { primaryFailure = error; throw error; }
    finally {
      try { await closeAll([() => input.close(), ...output ? [() => output!.close()] : []], 'Resource transport handles could not close'); }
      catch (error) { if (primaryFailure) throw new AggregateError([primaryFailure, error], 'Resource transport and handle cleanup failed'); throw error; }
    }
  };
}

/** After genuine manager deletion, remove directories only. A leftover file blocks cleanup. */
export async function removeEmptyResourceRoot(ownedParent: string, managedRoot: string) {
  const parent = await realpath(ownedParent), root = path.resolve(managedRoot);
  assert(isInside(parent, root), 'Cleanup escaped its owned parent');
  try { await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const directories: string[] = [];
  async function inspect(directory: string) {
    const stat = await lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(directory), directory), 'Cleanup refuses linked resource directories');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Production resource deletion left a file or link');
      await inspect(path.join(directory, entry.name));
    }
    directories.push(directory);
  }
  await inspect(root);
  for (const directory of directories) await rmdir(directory);
}

export async function prepareRealDefaultResources(options: PrepareRealDefaultResourcesOptions) {
  assert.equal(process.env.FUSIONKIT_REAL_ASR, '1', 'Real resource setup requires explicit FUSIONKIT_REAL_ASR=1');
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const projectRoot = await realpath(options.projectRoot), runRoot = path.resolve(options.runRoot);
  assert(isInside(path.join(projectRoot, 'test-results'), runRoot), 'Resource fixture must stay in repository test-results');
  await mkdir(runRoot, { recursive: true }); assert(samePath(await realpath(runRoot), runRoot), 'Run root traverses a link');
  const sourcePaths = { model: path.resolve(options.modelSourcePath),
    vad: path.resolve(options.vadSourcePath ?? path.join(projectRoot, 'test-results/studio-t08/inputs/for-tests-silero-v6.2.0-ggml.bin')),
    cudaArchive: path.resolve(options.cudaArchiveSourcePath ?? path.join(projectRoot, 'build/local-subtitle-resources/windows-v4-dev/downloads/whisper-cublas-12.4.0-bin-x64.zip')) };
  for (const file of Object.values(sourcePaths)) assert(isInside(projectRoot, file) && !isInside(runRoot, file), 'Sources must be independent repository cache files');
  const tempParent = await realpath(os.tmpdir());
  const preview = realDefaultResourceLayout(path.join(tempParent, 't8-XXXXXX'));
  assert(preview.pathBudgets.every(budget => budget.accepted), `The native resource temporary paths exceed their Windows budget: ${JSON.stringify(preview.pathBudgets)}`);
  const resourceRoot = await mkdtemp(path.join(tempParent, 't8-'));
  let rootStat: BigIntStats;
  try { rootStat = await lstat(resourceRoot, { bigint: true }); }
  catch (error) { await rmdir(resourceRoot); throw error; }
  const layout = realDefaultResourceLayout(resourceRoot);
  const sideRoots = (side: Side): SideRoots => layout[side];
  const evidenceSide = (side: Side): SideEvidence => ({ ...sideRoots(side), phase: 'new', installJobs: [], resourceEvents: [], installedArtifacts: [], observedProcessIds: [] });
  const evidence: RealDefaultResourceEvidence = { schemaVersion: 1, status: 'preparing',
    resourceRoot: { path: resourceRoot, dev: rootStat.dev.toString(), ino: rootStat.ino.toString() }, pathBudgets: layout.pathBudgets,
    legacy: evidenceSide('legacy'), studio: evidenceSide('studio') };
  const checkpoint = () => Promise.resolve(options.onProgress?.(evidence));
  const assertOwnedRoot = async () => {
    const current = await lstat(resourceRoot, { bigint: true });
    assert(current.isDirectory() && !current.isSymbolicLink(), 'Owned resource root was replaced');
    assert.equal(current.dev, rootStat.dev, 'Owned resource root device changed');
    assert.equal(current.ino, rootStat.ino, 'Owned resource root identity changed');
    assert(samePath(await realpath(resourceRoot), resourceRoot) && samePath(path.dirname(resourceRoot), tempParent), 'Owned resource root escaped its parent');
  };
  const fingerprints = async (signal?: AbortSignal) => {
    const observed = await Promise.allSettled(Object.entries(sourcePaths).map(async ([key, file]) => [key, await fingerprintResourceFile(file, signal)] as const));
    const failures = observed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Resource source observations failed');
    return Object.fromEntries(observed.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])) as Record<SourceKind, ResourceFileFingerprint>;
  };
  let sources!: Record<SourceKind, ResourceFileFingerprint>;
  const createdSides = new Set<Side>();

  function compose(side: Side) {
    const managedResourceRoot = evidence[side].managedResourceRoot;
    const transport = createPinnedResourceCopyTransport(managedResourceRoot, [
      { sourceUrl: studioVad.downloadUrl, file: sources.vad }, { sourceUrl: studioCuda.sourceArchive.downloadUrl, file: sources.cudaArchive }]);
    const environment = { mode: 'development', appRoot: projectRoot, platform: 'win32', arch: 'x64' } as const;
    if (side === 'legacy') {
      const supervisor = new LegacySupervisor({ managedResourceRoot, startupTimeoutMs: 120_000, dependencies: { verifyBackend: legacyAttestor().verifyBackend } });
      const manager = new LegacyModelManager({ managedResourceRoot, runtimeEnvironment: environment, supervisor,
        vadOptions: { downloadResource: transport }, acceleratorOptions: { downloadResource: transport } });
      return { manager, supervisor, cuda: legacyCuda, vad: legacyVad };
    }
    const supervisor = new StudioSupervisor({ managedResourceRoot, startupTimeoutMs: 120_000, dependencies: { verifyBackend: studioAttestor().verifyBackend } });
    const manager = new StudioModelManager({ managedResourceRoot, runtimeEnvironment: environment, supervisor,
      vadOptions: { downloadResource: transport }, acceleratorOptions: { downloadResource: transport } });
    return { manager, supervisor, cuda: studioCuda, vad: studioVad };
  }

  async function install(side: Side) {
    const record = evidence[side];
    await assertOwnedRoot();
    try { await lstat(record.managedResourceRoot); throw new Error('Resource fixture refuses an existing managed root'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(record.managedResourceRoot, { recursive: true }); createdSides.add(side);
    const { manager, supervisor, cuda, vad } = compose(side), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let closeOperation: Promise<void> | undefined, failure: unknown;
    const close = () => closeOperation ??= closeAll([() => manager.shutdown(), () => supervisor.shutdown('app_quit')], `${side} resource services could not close`);
    const onAbort = () => { void close().catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    const observe = () => { const pid = supervisor.snapshot.processId; if (pid && !record.observedProcessIds.includes(pid)) record.observedProcessIds.push(pid); };
    const timer = setInterval(observe, 100);
    const work = (async () => {
      signal.throwIfAborted(); await manager.initialize();
      const stopEvents = manager.onResourceEvent(OWNER, event => { if (record.resourceEvents.length < 500) record.resourceEvents.push(structuredClone(event)); });
      try {
        const phase = async (name: string) => { signal.throwIfAborted(); record.phase = name; observe(); await checkpoint(); };
        const completed = async (job: { jobId: string }) => {
          await manager.waitForIdle(); signal.throwIfAborted(); observe();
          const terminal = manager.getSessionSnapshot(OWNER).resourceJobs.find(value => value.jobId === job.jobId);
          record.installJobs.push(structuredClone(terminal));
          assert.equal(terminal?.status, 'completed', `${side} resource job failed: ${JSON.stringify(terminal)}`);
          await checkpoint();
        };
        await phase('model-copy-import');
        await completed(manager.importModel({ owner: OWNER, filePath: sources.model.path, modelId: MODEL.id, mode: 'copy' }));
        const model = await manager.resolveManagedModel(MODEL.id, signal), modelFile = await fingerprintResourceFile(model.absolutePath, signal);
        assert.equal(modelFile.sha256, sources.model.sha256); assert(isInside(record.managedResourceRoot, modelFile.path));
        assert(modelFile.dev !== sources.model.dev || modelFile.ino !== sources.model.ino, 'Model import reused the source identity');
        record.installedArtifacts.push({ resourceId: MODEL.id, kind: 'model', file: modelFile });
        await phase('vad-install-and-smoke'); await completed(manager.startResourceInstall(OWNER, vad.resourceId));
        const resolvedVad = await manager.resolveManagedVad(vad.resourceId, signal);
        const vadFile = await fingerprintResourceFile(resolvedVad.absolutePath, signal);
        assert.equal(vadFile.sha256, sources.vad.sha256); assert.equal(vadFile.byteSize, sources.vad.byteSize);
        record.installedArtifacts.push({ resourceId: vad.resourceId, kind: 'vad', file: vadFile });
        await phase('cuda-install-and-probe'); await completed(manager.startResourceInstall(OWNER, cuda.resourceId));
        const pack = await manager.resolveManagedAccelerator(cuda.resourceId, signal); record.cudaPackGeneration = pack.packGeneration;
        record.installedArtifacts.push({ resourceId: cuda.resourceId, kind: 'manifest', file: await fingerprintResourceFile(pack.manifest.absolutePath, signal) });
        for (const artifact of pack.artifacts) {
          const file = await fingerprintResourceFile(artifact.absolutePath, signal);
          assert.equal(file.sha256, artifact.sha256); assert.equal(file.byteSize, artifact.byteSize);
          record.installedArtifacts.push({ resourceId: cuda.resourceId, kind: artifact.kind, file });
        }
        await phase('prepared');
      } finally { stopEvents(); }
    })();
    const settled = work.then(() => undefined, () => undefined);
    try { await within(work, INSTALL_MS, `${side} resource preparation exceeded ten minutes`); }
    catch (error) { failure = error; record.error = errorText(error); }
    finally {
      controller.abort();
      let closeSettled = false;
      const closeWork = close().then(() => settled).then(() => {
        observe(); record.preparationClosed = supervisor.snapshot.state === 'disposed';
        record.processesExited = record.observedProcessIds.every(pid => !alive(pid));
        assert(record.preparationClosed && record.processesExited, `${side} native preparation cleanup is incomplete`);
      }).finally(() => { closeSettled = true; record.cleanupPending = false; });
      try { await within(closeWork, CLEANUP_MS, `${side} resource service cleanup exceeded 45 seconds`); }
      catch (error) { record.cleanupPending = !closeSettled; failure = failure ? new AggregateError([failure, error], 'Resource preparation and cleanup failed') : error; }
      clearInterval(timer); signal.removeEventListener('abort', onAbort);
      try { await checkpoint(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Resource checkpoint failed after cleanup') : error; }
    }
    if (failure) throw failure;
    assert(record.observedProcessIds.length > 0, `${side} real model/VAD smoke process was not observed`);
  }

  const cleanup = createResourceCleanupGate(async (): Promise<ResourceCleanupEvidence> => {
    const result: ResourceCleanupEvidence = { status: 'running', sides: {} }; evidence.cleanup = result;
    const work = (async () => {
      const failures: unknown[] = [];
      for (const side of ['legacy', 'studio'] as const) {
        if (!createdSides.has(side)) continue;
        const record = result.sides[side] = { deletions: [], managerClosed: false, rootRemoved: false } as NonNullable<ResourceCleanupEvidence['sides'][Side]>;
        try {
          await assertOwnedRoot();
          assert(evidence[side].preparationClosed && evidence[side].processesExited, 'Preparation must join before resource deletion');
          assert(evidence[side].observedProcessIds.every(pid => !alive(pid)), 'An owned preparation process remains live');
          const { manager, supervisor, cuda, vad } = compose(side); const deletionFailures: unknown[] = [];
          try {
            await manager.initialize();
            for (const resourceId of [vad.resourceId, cuda.resourceId, MODEL.id]) {
              try { await assertOwnedRoot(); const deleted = await manager.deleteManagedResource(OWNER, resourceId); record.deletions.push({ resourceId, deleted: deleted.deleted }); }
              catch (error) { deletionFailures.push(error); }
            }
          } finally {
            try { await closeAll([() => manager.shutdown(), () => supervisor.shutdown('app_quit')], `${side} deletion services could not close`); record.managerClosed = true; }
            catch (error) { deletionFailures.push(error); }
          }
          if (deletionFailures.length) throw new AggregateError(deletionFailures, `${side} production resource deletion failed`);
          await removeEmptyResourceRoot(evidence[side].userDataRoot, evidence[side].managedResourceRoot); record.rootRemoved = true;
        } catch (error) { record.error = errorText(error); failures.push(error); }
        try { await checkpoint(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 0) {
        try {
          await assertOwnedRoot();
          await removeEmptyResourceRoot(tempParent, resourceRoot); result.resourceRootRemoved = true;
        } catch (error) { result.resourceRootRemoved = false; failures.push(error); }
      }
      try {
        if (evidence.sourcesBefore) {
          evidence.sourcesAfter = await fingerprints(); evidence.sourcesUnchanged = (Object.keys(sources) as SourceKind[]).every(key => sameIdentity(sources[key], evidence.sourcesAfter![key]));
          result.sourcesUnchanged = evidence.sourcesUnchanged; assert(evidence.sourcesUnchanged, 'Original resource inputs changed');
        }
      } catch (error) { failures.push(error); }
      result.status = failures.length || result.deadlineExceeded ? 'failed' : 'passed';
      if (failures.length) { result.error = errorText(new AggregateError(failures, 'Real resource cleanup failed')); await checkpoint(); throw new AggregateError(failures, result.error); }
      await checkpoint(); return result;
    })();
    return work;
  }, CLEANUP_MS, error => {
    if (evidence.cleanup) Object.assign(evidence.cleanup, { status: 'failed', error: errorText(error), deadlineExceeded: true, joined: false, cleanupPending: true });
    Object.assign(error, { evidence, cleanupPending: true });
  }, () => {
    if (evidence.cleanup) {
      const preparationJoined = [...createdSides].every(side => evidence[side].preparationClosed && evidence[side].processesExited && !evidence[side].cleanupPending);
      evidence.cleanup.joined = preparationJoined; evidence.cleanup.cleanupPending = !preparationJoined;
    }
  });

  try {
    assert(layout.pathBudgets.every(budget => budget.accepted));
    assert(samePath(await realpath(resourceRoot), resourceRoot));
    sources = evidence.sourcesBefore = await fingerprints(options.signal);
    for (const [kind, expected] of [['model', MODEL], ['vad', studioVad], ['cudaArchive', studioCuda.sourceArchive]] as const) {
      assert.equal(sources[kind].byteSize, expected.byteSize, `${kind} size mismatch`); assert.equal(sources[kind].sha256, expected.sha256, `${kind} hash mismatch`);
    }
    assert.equal(legacyVad.sha256, studioVad.sha256); assert.equal(legacyCuda.sourceArchive.sha256, studioCuda.sourceArchive.sha256);
    await checkpoint(); await install('legacy'); await install('studio');
    const oldArtifacts = evidence.legacy.installedArtifacts.filter(item => ['server', 'dynamic_library'].includes(item.kind));
    const newArtifacts = evidence.studio.installedArtifacts.filter(item => ['server', 'dynamic_library'].includes(item.kind));
    assert.equal(oldArtifacts.length, 20); assert.equal(newArtifacts.length, 20);
    for (let i = 0; i < 20; i++) { assert.equal(oldArtifacts[i].file.sha256, newArtifacts[i].file.sha256); assert.notEqual(oldArtifacts[i].file.ino, newArtifacts[i].file.ino); }
    evidence.sourcesAfter = await fingerprints(); evidence.sourcesUnchanged = (Object.keys(sources) as SourceKind[]).every(key => sameIdentity(sources[key], evidence.sourcesAfter![key]));
    assert(evidence.sourcesUnchanged, 'Original resources changed during preparation');
    evidence.status = 'prepared'; await checkpoint();
    return { legacy: sideRoots('legacy'), studio: sideRoots('studio'), evidence, cleanup };
  } catch (error) {
    evidence.status = 'failed'; evidence.error = errorText(error);
    let failure = error;
    try { await cleanup(); } catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Resource preparation and uninstall failed'); }
    await checkpoint(); throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { evidence });
  }
}
