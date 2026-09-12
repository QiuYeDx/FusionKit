// Explicit maintenance evidence only. Never imported by product code or run by ordinary regression tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeechResourceService } from '../../../electron/main/speech-resources/service';
import { SPEECH_CUDA_RESOURCE_ID, SPEECH_CUDA_PACK_DEFINITION, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../../electron/main/speech-resources/catalog';
import { SPEECH_MIGRATION_RESOURCES } from '../../../electron/main/speech-resources/catalog-migration';
import { createLegacySharedResources, protectLegacyResourceAdmissions } from '../../../electron/main/local-subtitle/shared-resources';
import { createSpeechResourceSmoke } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import { createSharedResourceApplicationShutdown, createResourceConsumerLifecycle } from '../../../electron/main/app-shutdown';
import { extractLocalSubtitleAcceleratorArchive } from '../../../electron/main/speech-resources/engine/accelerator-archive';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION as legacyCuda } from '../../../electron/main/local-subtitle/accelerator-manager';
import legacyVadManifest from '../../../resources/local-subtitle/manifests/local-subtitle-vad.v1.json';
import { LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry,
  LocalSubtitleCapabilityLeaseCoordinator } from '../../../electron/main/local-subtitle/authorizations';
import { LocalSubtitleMediaNormalizer } from '../../../electron/main/local-subtitle/media-normalizer';
import { LocalSubtitleServerSupervisor } from '../../../electron/main/local-subtitle/server-supervisor';
import { createLocalSubtitleServerSession } from '../../../electron/main/local-subtitle/server-session';
import { LocalSubtitleSessionRegistry } from '../../../electron/main/local-subtitle/session-registry';
import { LocalSubtitleSessionLifecycle } from '../../../electron/main/local-subtitle/session-lifecycle';
import { LocalSubtitleBackendResolver } from '../../../electron/main/local-subtitle/backend-resolver';
import { LocalSubtitleJobManager } from '../../../electron/main/local-subtitle/job-manager';
import { LocalSubtitleProductionExecutor } from '../../../electron/main/local-subtitle/production-executor';
import { LocalSubtitleArtifactRegistry } from '../../../electron/main/local-subtitle/subtitle-artifact-registry';
import { LocalSubtitleExporter } from '../../../electron/main/local-subtitle/subtitle-exporter';
import { createLocalSubtitleProductionBackendAttestor as legacyAttestor } from '../../../electron/main/local-subtitle/backend-attestor';
import { verifyLocalSubtitleRuntimeBundle as verifyLegacyRuntime } from '../../../electron/main/local-subtitle/resource-path';
import { verifyLocalSubtitleRuntimeBundle as verifyStudioRuntime } from '../../../electron/main/subtitle-studio/transcription/native/resource-path';
import { LocalSubtitleMediaNormalizer as StudioMedia } from '../../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { LocalSubtitleServerSupervisor as StudioServer } from '../../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor as studioAttestor } from '../../../electron/main/subtitle-studio/transcription/native/backend-attestor';
import { createTranscriptionRuntime } from '../../../electron/main/subtitle-studio/transcription/runtime';
import { DocumentRepository } from '../../../electron/main/subtitle-studio/document-repository';
import { validateDocument } from '../../../src/subtitle-studio/domain';
import { LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION } from '../../../src/type/localSubtitle';
import { LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS, localSubtitleIpcSuccess } from '../../../src/type/localSubtitleIpc';
import type { LocalSubtitleIpcHandlerContext } from '../../../electron/main/local-subtitle/ipc';
import { REAL_DEFAULT_SAMPLES, realDefaultConfig, observeRealMethod, type RealDefaultChainEvidence } from '../../subtitle-studio-provenance/real-default-comparison-harness';
import { analyzeRealDefaultComparison } from '../../subtitle-studio-provenance/real-default-comparison-analysis';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODEL = SPEECH_MODEL_MANIFEST.models.find(model => model.id === 'large-v3-q5_0')!;
const SAMPLE = REAL_DEFAULT_SAMPLES[0];
export const REAL_SHARED_BUDGET = Object.freeze({ preparationMs: 10 * 60_000, caseMs: 15 * 60_000,
  cleanupMs: 45_000, overallMs: 75 * 60_000, startupMs: 120_000 });
export const realSharedMatrix = () => (['cpu', 'cuda'] as const).flatMap(backend => (['legacy', 'studio'] as const).map(side => ({ backend, side })));
type Fingerprint = { path: string; byteSize: number; sha256: string; dev: string; ino: string; mtimeNs: string };
type ErrorEvidence = { name: string; message: string; code?: string; stack?: string; errors?: ErrorEvidence[]; cause?: ErrorEvidence; truncated?: true };
type SharedChain = RealDefaultChainEvidence & { oldResourceDirectoriesAbsent?: boolean; sharedModel?: Fingerprint; rawEvidencePath?: string };
export interface RealSharedReport {
  schemaVersion: 1; evidenceKind: 'real-shared-speech-resources'; status: 'running' | 'completed' | 'failed';
  qualityStatus: 'requires_review'; outputRoot: string; startedAt: string; completedAt?: string;
  host: { version: string; versions: NodeJS.ProcessVersions; executable: string; platform: string; arch: string };
  budgets: typeof REAL_SHARED_BUDGET; scope: { sharedServiceInstances: 1; expectedRuns: 4; noNetworkTransport: true;
    noFixtureInference: true; rendererNotExercised: true; sessionIsolation: true; sharedResourceStatePersistsBetweenRuns: true };
  phase: string; resourceRoot?: string; sourcesBefore?: Fingerprint[]; sourcesAfter?: Fingerprint[]; sourcesUnchanged?: boolean;
  runtimeEvidence?: unknown; seededResources: Fingerprint[]; migratedResources: Fingerprint[]; migrationStatus?: unknown;
  migrationPreservedPayloadIdentity?: boolean; legacyResourceRootsRemoved?: boolean; chains: SharedChain[];
  shutdownTargets?: { target: string; status: 'joining' | 'joined' | 'failed'; error?: ErrorEvidence }[];
  finalRuntimeState?: unknown;
  comparisons: ReturnType<typeof analyzeRealDefaultComparison>[]; observerErrors: ErrorEvidence[];
  cleanup?: { joined: boolean; rootRemoved: boolean; serverDisposed: boolean; noObservedProcessAlive: boolean; error?: ErrorEvidence };
  error?: ErrorEvidence;
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'signal' || key === 'evidence' ? undefined :
  typeof item === 'bigint' ? item.toString() : item));
const object = (value: unknown) => value as Record<string, unknown>;
export function realSharedErrorEvidence(error: unknown, seen = new Set<unknown>(), depth = 0): ErrorEvidence {
  const value = error instanceof Error ? error : new Error(String(error));
  if (depth > 8 || seen.has(error)) return { name: value.name, message: value.message, truncated: true };
  seen.add(error);
  const code = (value as { localSubtitleCode?: string; code?: string }).localSubtitleCode ?? (value as { code?: string }).code;
  return { name: value.name, message: value.message, ...(typeof code === 'string' ? { code } : {}), ...(value.stack ? { stack: value.stack } : {}),
    ...(value instanceof AggregateError ? { errors: [...value.errors].slice(0, 64).map(child => realSharedErrorEvidence(child, new Set(seen), depth + 1)) } : {}),
    ...(value.cause !== undefined ? { cause: realSharedErrorEvidence(value.cause, new Set(seen), depth + 1) } : {}) };
}
const errorEvidence = realSharedErrorEvidence;
export function realSharedEnabled(environment: Record<string, string | undefined> = process.env) {
  return environment.FUSIONKIT_REAL_ASR === '1' && environment.FUSIONKIT_REAL_SHARED_ASR === '1';
}
function within<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })])
    .finally(() => clearTimeout(timer!));
}
async function fingerprint(file: string): Promise<Fingerprint> {
  const absolute = path.resolve(file), before = await lstat(absolute, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink());
  const hash = createHash('sha256'); for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  const after = await lstat(absolute, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeNs], [before.dev, before.ino, before.size, before.mtimeNs]);
  return { path: absolute, byteSize: Number(after.size), sha256: hash.digest('hex'), dev: String(after.dev), ino: String(after.ino), mtimeNs: String(after.mtimeNs) };
}
async function checkedFile(file: string, expected: { byteSize: number; sha256: string }) {
  const value = await fingerprint(file); assert.equal(value.byteSize, expected.byteSize); assert.equal(value.sha256, expected.sha256); return value;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }
function recordFor(side: 'legacy' | 'studio', backend: 'cpu' | 'cuda'): SharedChain {
  return { id: `${backend}-${side}-A`, sampleId: 'A', side, backend, repeat: false, status: 'pending', config: realDefaultConfig(backend),
    phase: 'pending', phases: [], rawAttempts: [], materializations: [], resolutions: [], backendProofs: [], observerErrors: [],
    serverSnapshots: [], observedProcessIds: [] };
}

function installTrace(record: SharedChain, checkpoint: () => Promise<void>) {
  const pending = new Set<Promise<void>>(), restores: (() => void)[] = [], taskLeases = new WeakSet<object>(), separatorLeases = new WeakSet<object>();
  const windows = new Map<string, unknown>();
  const onError = (error: unknown) => { record.observerErrors.push(errorEvidence(error)); };
  const changed = () => { const work = checkpoint().catch(onError); pending.add(work); void work.then(() => pending.delete(work)); };
  const media = record.side === 'legacy' ? LocalSubtitleMediaNormalizer.prototype : StudioMedia.prototype;
  const server = record.side === 'legacy' ? LocalSubtitleServerSupervisor.prototype : StudioServer.prototype;
  const observe = (target: object, method: string, begin: Parameters<typeof observeRealMethod>[0]['begin'], selectPromise?: (result: unknown) => unknown) =>
    restores.push(observeRealMethod({ target, method, begin, selectPromise, pending, onError }));
  try {
    observe(media, 'normalizeTask', () => ({ resolved(value) { record.normalized = json(value); record.windowPlan = { totalFrames: Number(object(value).totalFrames), windows: [] }; changed(); } }));
    observe(media, 'readQuietCandidates', () => ({ resolved(value) { assert.ok(record.windowPlan); record.windowPlan.quietCandidates = json(value) as NonNullable<SharedChain['windowPlan']>['quietCandidates']; changed(); } }));
    observe(media, 'materializeWindow', args => { const input = object(args[0]), descriptor = object(input.descriptor);
      const entry = { descriptor: json(descriptor), conditionQuietAudio: input.conditionQuietAudio === true } as Record<string, unknown>;
      record.materializations.push(entry); if (!record.windowPlan?.windows.some(window => window.windowKey === descriptor.windowKey)) record.windowPlan?.windows.push(json(descriptor));
      return { resolved(value) { entry.result = json(value); changed(); }, rejected(error) { entry.error = errorEvidence(error); changed(); } }; });
    observe(media, 'resolveWindow', args => { const entry: Record<string, unknown> = { window: json(args[0]), expected: json(args[1]) }; record.resolutions.push(entry);
      return { resolved(value) { entry.result = json(value); windows.set(String(object(value).filePath), json(args[0])); changed(); } }; });
    observe(server, 'acquirePinnedTaskLease', () => ({ resolved(value) { taskLeases.add(value as object); } }));
    observe(server, 'acquirePinnedSeparatorLease', () => ({ resolved(value) { separatorLeases.add(value as object); } }));
    observe(server, 'beginInference', args => {
      const request = json(object(args[1])); assert.ok(taskLeases.has(args[0] as object) || separatorLeases.has(args[0] as object));
      const attempt: SharedChain['rawAttempts'][number] = { ordinal: record.rawAttempts.length + 1, request,
        window: windows.get(String(request.filePath)), kind: separatorLeases.has(args[0] as object) ? 'separator' : request.temperature === 0 ? 'primary' : 'quality_recovery' };
      record.rawAttempts.push(attempt); changed();
      return { resolved(value) { attempt.response = json(value); changed(); }, rejected(error) { attempt.error = errorEvidence(error); changed(); } };
    }, result => object(result).result);
  } catch (error) { restores.reverse().forEach(restore => restore()); throw error; }
  let restored = false;
  return { async close() { if (restored) return;
    try { await within((async () => { while (pending.size) await Promise.all([...pending]); })(), REAL_SHARED_BUDGET.cleanupMs, 'Shared observer operations did not join'); }
    finally { restored = true; for (const restore of restores.reverse()) { try { restore(); } catch (error) { onError(error); } } }
  } };
}

function assertTrace(record: SharedChain) {
  assert.ok(record.rawAttempts.length && record.observedProcessIds.length && record.windowPlan?.totalFrames);
  assert.ok(record.rawAttempts.some(attempt => attempt.kind === 'primary'));
  for (const attempt of record.rawAttempts) {
    assert.equal(attempt.request.language, 'ja'); assert.equal(attempt.request.taskMode, 'transcribe');
    assert.equal(attempt.request.beamSize, 5); assert.equal(attempt.request.vadMinSilenceMs, 500); assert.equal(attempt.request.timingMode, undefined);
    if (attempt.kind === 'separator') { assert.equal(record.backend, 'cuda'); assert.equal(attempt.request.vadEnabled, false); assert.equal(attempt.request.temperature, 0); }
    else { assert.equal(attempt.request.vadEnabled, true); assert.equal(attempt.request.temperature, attempt.kind === 'quality_recovery' ? 0.2 : 0); }
  }
  assert.equal(record.canonicalTranscript?.source.durationMs, SAMPLE.durationMs);
  assert.equal(record.canonicalTranscript?.model.modelHash, MODEL.sha256);
  assert.equal(record.canonicalTranscript?.model.backend, record.backend);
  assert.ok(record.canonicalTranscript?.segments.length);
  if (record.backend === 'cuda') {
    assert.ok(record.backendProofs.length, 'Missing real exact-PID CUDA verification');
    for (const proof of record.backendProofs) { assert.equal(proof.verified, true); assert.equal(proof.backend, 'cuda');
      assert.ok(record.observedProcessIds.includes(Number(proof.processId))); assert.match(String(proof.acceleratorPackGeneration), /^[a-f0-9]{64}$/u); }
  }
}

/** One real shared service survives all four runs; only per-task observations change. */
export async function runRealSharedComparison(): Promise<RealSharedReport> {
  assert.ok(realSharedEnabled(), 'Set both FUSIONKIT_REAL_ASR=1 and FUSIONKIT_REAL_SHARED_ASR=1 explicitly');
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const evidenceParent = path.join(PROJECT, 'test-results', 'studio-t09'); await mkdir(evidenceParent, { recursive: true });
  const outputRoot = await realpath(await mkdtemp(path.join(evidenceParent, 'real-shared-')));
  const report: RealSharedReport = { schemaVersion: 1, evidenceKind: 'real-shared-speech-resources', status: 'running', qualityStatus: 'requires_review',
    outputRoot, startedAt: new Date().toISOString(), host: { version: process.version, versions: process.versions, executable: process.execPath, platform: process.platform, arch: process.arch },
    budgets: REAL_SHARED_BUDGET, scope: { sharedServiceInstances: 1, expectedRuns: 4, noNetworkTransport: true, noFixtureInference: true,
      rendererNotExercised: true, sessionIsolation: true, sharedResourceStatePersistsBetweenRuns: true }, phase: 'starting', seededResources: [], migratedResources: [], chains: [], comparisons: [], observerErrors: [] };
  let writes = Promise.resolve();
  const checkpoint = () => { const bytes = `${JSON.stringify(report, null, 2)}\n`; writes = writes.then(async () => {
    const pending = path.join(outputRoot, 'report.pending.json'); await writeFile(pending, bytes); await rename(pending, path.join(outputRoot, 'report.json')); }); return writes; };
  const phase = async (name: string) => { report.phase = name; console.log(`[T09 shared] ${name}`); await checkpoint(); };
  const controller = new AbortController(), overall = setTimeout(() => controller.abort(new Error('Shared comparison exceeded its overall deadline')), REAL_SHARED_BUDGET.overallMs);
  let resourceRoot: string | undefined, rootIdentity: { dev: bigint; ino: bigint } | undefined;
  let service: SpeechResourceService | undefined, smoke: ReturnType<typeof createSpeechResourceSmoke> | undefined;
  let application: ReturnType<typeof createSharedResourceApplicationShutdown> | undefined;
  let preparation: Promise<void> | undefined, activeTrace: ReturnType<typeof installTrace> | undefined;
  let studio: ReturnType<typeof createTranscriptionRuntime> | undefined, legacyServer: LocalSubtitleServerSupervisor | undefined;
  let activeRecord: SharedChain | undefined, sampling: ReturnType<typeof setInterval> | undefined;
  const allPids = new Set<number>();
  const sourcePaths = [process.env.FUSIONKIT_REAL_MODEL_PATH ?? path.join(PROJECT, 'docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/models/ggml-large-v3-q5_0.bin'),
    process.env.FUSIONKIT_REAL_VAD_PATH ?? path.join(PROJECT, 'test-results/studio-t08/inputs/for-tests-silero-v6.2.0-ggml.bin'),
    process.env.FUSIONKIT_REAL_CUDA_ARCHIVE_PATH ?? path.join(PROJECT, 'build/local-subtitle-resources/windows-v4-dev/downloads/whisper-cublas-12.4.0-bin-x64.zip'),
    path.join(PROJECT, 'test-results/subtitle-quality-review', SAMPLE.relativePath)];
  try {
    await phase('verify-fixed-read-only-inputs');
    report.sourcesBefore = await Promise.all([checkedFile(sourcePaths[0], MODEL), checkedFile(sourcePaths[1], SPEECH_VAD_MANIFEST.vad),
      checkedFile(sourcePaths[2], legacyCuda.sourceArchive), checkedFile(sourcePaths[3], SAMPLE)]);
    const environment = { mode: 'development', appRoot: PROJECT } as const;
    report.runtimeEvidence = { legacy: json(await verifyLegacyRuntime({ environment, scope: 'all' })), studio: json(await verifyStudioRuntime({ environment, scope: 'all' })) };
    resourceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 't9-'))); report.resourceRoot = resourceRoot;
    rootIdentity = await lstat(resourceRoot, { bigint: true });
    const userDataRoot = resourceRoot, oldRoot = path.join(userDataRoot, 'local-subtitle'), sharedRoot = path.join(userDataRoot, 'speech-resources');
    const selected = SPEECH_MIGRATION_RESOURCES.filter(resource => [MODEL.id, SPEECH_VAD_MANIFEST.vad.id, SPEECH_CUDA_RESOURCE_ID].includes(resource.id));
    const oldDirectories = selected.map(resource => { const source = resource.sources.find(value => value.root === 'local-subtitle')!; return path.join(oldRoot, source.relativeDirectory); });
    preparation = (async () => {
      await phase('copy-one-isolated-legacy-model-and-vad'); controller.signal.throwIfAborted();
      const modelDestination = path.join(oldRoot, 'models', MODEL.id, MODEL.fileName), vadDirectory = path.join(oldRoot, 'vad', SPEECH_VAD_MANIFEST.vad.id);
      await mkdir(path.dirname(modelDestination), { recursive: true }); await copyFile(sourcePaths[0], modelDestination, constants.COPYFILE_EXCL);
      await mkdir(vadDirectory, { recursive: true }); await copyFile(sourcePaths[1], path.join(vadDirectory, SPEECH_VAD_MANIFEST.vad.fileName), constants.COPYFILE_EXCL);
      await writeFile(path.join(vadDirectory, 'manifest.json'), `${JSON.stringify(legacyVadManifest, null, 2)}\n`, { flag: 'wx' });
      await phase('extract-fixed-cuda-archive-with-production-verifier');
      const packDirectory = path.join(oldRoot, 'accelerators', legacyCuda.resourceId); await mkdir(path.dirname(packDirectory), { recursive: true });
      await extractLocalSubtitleAcceleratorArchive({ archivePath: sourcePaths[2], destinationDirectory: packDirectory, contract: legacyCuda.archiveContract, signal: controller.signal });
      const manifest = path.join(packDirectory, legacyCuda.manifestRelativePath); await mkdir(path.dirname(manifest), { recursive: true }); await writeFile(manifest, legacyCuda.manifestBytes, { flag: 'wx' });
      for (const resource of selected) { const source = resource.sources.find(value => value.root === 'local-subtitle')!;
        for (const file of source.files) report.seededResources.push(await checkedFile(path.join(oldRoot, source.relativeDirectory, file.relativePath), file)); }
      assert.notEqual(report.seededResources.find(file => file.sha256 === MODEL.sha256)?.ino, report.sourcesBefore![0].ino);
      controller.signal.throwIfAborted(); await phase('migrate-once-into-shared-service');
      smoke = createSpeechResourceSmoke({ managedResourceRoot: sharedRoot, sessionRoot: path.join(userDataRoot, 'smoke'), environment });
      const noNetwork = async (): Promise<never> => { throw new Error('The real shared comparison forbids resource downloads'); };
      service = new SpeechResourceService({ userDataRoot, smokeModel: smoke.smokeModel, smokeVad: smoke.smokeVad,
        downloadResource: noNetwork, vadOptions: { downloadResource: noNetwork }, acceleratorOptions: { downloadResource: noNetwork } });
      await service.initialize(); report.migrationStatus = service.status(); assert.deepEqual(service.status().migrationIssues, []); assert.equal(service.status().cleanupPending, false);
      for (const resource of selected) for (const file of resource.files) report.migratedResources.push(await checkedFile(path.join(sharedRoot, resource.relativeDirectory, file.relativePath), file));
      const payloads = report.migratedResources.filter(file => !file.path.endsWith('.json'));
      for (const file of payloads) { const before = report.seededResources.find(candidate => candidate.sha256 === file.sha256)!;
        assert.ok(before); assert.deepEqual([file.dev, file.ino], [before.dev, before.ino]); }
      report.migrationPreservedPayloadIdentity = true;
      for (const directory of oldDirectories) assert.ok(await absent(directory));
      for (const leaf of ['models', 'vad', 'accelerators']) { const directory = path.join(oldRoot, leaf); assert.deepEqual(await readdir(directory), []); await rmdir(directory); }
      assert.deepEqual(await readdir(oldRoot), []); await rmdir(oldRoot); report.legacyResourceRootsRemoved = true;
    })();
    await within(preparation, REAL_SHARED_BUDGET.preparationMs, 'Shared resource preparation exceeded ten minutes');
    assert.ok(service && smoke); controller.signal.throwIfAborted(); await phase('compose-two-real-consumers');
    const inputs = new LocalSubtitleInputAuthorizationRegistry(), outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs), registry = new LocalSubtitleSessionRegistry(), artifacts = new LocalSubtitleArtifactRegistry();
    const media = new LocalSubtitleMediaNormalizer({ environment, managedResourceRoot: oldRoot, inputAuthorizations: inputs });
    const observeAttestation = <Context, Proof>(actual: (context: Context) => Promise<Proof>) => (context: Context) => {
      const target = activeRecord, promise = actual(context);
      void promise.then(proof => { try { assert.ok(target); target.backendProofs.push({ ...json(object(proof)), context: json(context) }); }
        catch (error) { report.observerErrors.push(errorEvidence(error)); } }, () => undefined); return promise;
    };
    const oldAttestor = legacyAttestor(); assert.ok(oldAttestor.supportedBackends.includes('cuda'));
    legacyServer = new LocalSubtitleServerSupervisor({ managedResourceRoot: sharedRoot, startupTimeoutMs: REAL_SHARED_BUDGET.startupMs,
      dependencies: { verifyBackend: observeAttestation(oldAttestor.verifyBackend), createSession: () => createLocalSubtitleServerSession(oldRoot) } });
    let jobs: LocalSubtitleJobManager | undefined;
    const legacyConsumer = createResourceConsumerLifecycle({ shutdown: reason => legacyLifecycle.shutdown(reason),
      isResourceBusy: id => Boolean(jobs?.isManagedModelBusy(id) || jobs?.isManagedVadBusy(id) || jobs?.isManagedAcceleratorBusy(id)
        || legacyServer?.isManagedAcceleratorBusy(id) || legacyServer?.snapshot.modelId === id || legacyServer?.snapshot.vadModelId === id) });
    const models = createLegacySharedResources({ service, registry, isResourceBusy: legacyConsumer.isResourceBusy });
    const resolveCudaAccelerator = (signal?: AbortSignal) => models.resolveManagedAccelerator(legacyCuda.resourceId, signal), realExporter = new LocalSubtitleExporter(artifacts);
    const executor = new LocalSubtitleProductionExecutor({ media, supervisor: legacyServer, inputs, outputs, runtimeEnvironment: environment, resolveCudaAccelerator,
      exporter: { supportsConflictPolicy: policy => realExporter.supportsConflictPolicy(policy), exportArtifacts: request => {
        assert.ok(activeRecord && activeRecord.side === 'legacy'); activeRecord.canonicalTranscript = json(request.transcript); return realExporter.exportArtifacts(request); } } });
    jobs = new LocalSubtitleJobManager({ registry, inputs, outputs, leases, runtimeVerifier: media, mediaSelections: media, modelResolver: models, executor, artifacts,
      backendResolver: new LocalSubtitleBackendResolver({ runtimeEnvironment: environment, resolveCudaAccelerator,
        cudaAttestationAvailable: oldAttestor.supportedBackends.includes('cuda'), metalAttestationAvailable: oldAttestor.supportedBackends.includes('metal') }) });
    const legacyLifecycle = new LocalSubtitleSessionLifecycle(jobs, models, media, legacyServer, registry);
    const documentRoot = path.join(outputRoot, 'documents'), repository = new DocumentRepository(documentRoot);
    const newAttestor = studioAttestor(); assert.ok(newAttestor.supportedBackends.includes('cuda'));
    studio = createTranscriptionRuntime({ userDataRoot, environment }, { sharedResources: service,
      server: { startupTimeoutMs: REAL_SHARED_BUDGET.startupMs, dependencies: { verifyBackend: observeAttestation(newAttestor.verifyBackend) } } }, repository);
    const observedShutdown = (target: string, operation: (reason: 'app_quit' | 'update' | 'fatal') => Promise<void>) => ({
      async shutdown(reason: 'app_quit' | 'update' | 'fatal') {
        const entry: NonNullable<RealSharedReport['shutdownTargets']>[number] = { target, status: 'joining' };
        (report.shutdownTargets ??= []).push(entry); await checkpoint();
        try { await operation(reason); entry.status = 'joined'; }
        catch (error) { entry.status = 'failed'; entry.error = errorEvidence(error); throw error; }
        finally { await checkpoint(); }
      },
    });
    application = createSharedResourceApplicationShutdown({
      resources: { fence: () => service!.fence(), ...observedShutdown('shared-resources', () => service!.shutdown()) },
      runtimes: [observedShutdown('legacy-consumer', reason => legacyConsumer.shutdown(reason)), observedShutdown('studio-consumer', reason => studio!.shutdown(reason))],
      smokeServer: observedShutdown('dedicated-smoke', reason => smoke!.shutdown(reason)),
    });
    await models.initialize(); await studio.initialize();
    const protectedHandlers = protectLegacyResourceAdmissions({ resources: models, registry,
      handlers: { [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]: async (request, context) => localSubtitleIpcSuccess(await jobs!.enqueue(context.owner, request as never, context.signal)) } });
    for (const item of realSharedMatrix()) {
      controller.signal.throwIfAborted(); const record = recordFor(item.side, item.backend); report.chains.push(record); activeRecord = record;
      const started = Date.now(); record.startedAt = new Date().toISOString(); record.status = 'running';
      record.managedRoot = sharedRoot; record.oldResourceDirectoriesAbsent = (await Promise.all(oldDirectories.map(absent))).every(Boolean); assert.ok(record.oldResourceDirectoriesAbsent);
      const owner = { webContentsId: item.side === 'legacy' ? 908 : 909, ownerSessionId: record.id };
      const snapshot = () => item.side === 'legacy' ? legacyServer!.snapshot : studio!.snapshot().server;
      let lastSnapshot = '';
      const sampleProcess = () => { const value = snapshot(); if (!value) return; if (value.processId) { allPids.add(value.processId); if (!record.observedProcessIds.includes(value.processId)) record.observedProcessIds.push(value.processId); }
        const key = JSON.stringify(value); if (key !== lastSnapshot) { lastSnapshot = key; record.serverSnapshots.push({ elapsedMs: Date.now() - started, snapshot: value }); } };
      sampleProcess(); sampling = setInterval(sampleProcess, 100); activeTrace = installTrace(record, checkpoint);
      const step = async (name: string) => { record.phase = name; record.phases.push({ phase: name, elapsedMs: Date.now() - started }); await phase(`${record.id}: ${name}`); controller.signal.throwIfAborted(); };
      try {
        await within((async () => {
          await step('resolve-shared-model-and-probe-original-audio');
          const model = item.side === 'legacy' ? await models.resolveManagedModel(MODEL.id, controller.signal) : await studio!.resources.resolveModel(owner, MODEL.id, controller.signal);
          record.sharedModel = await checkedFile(model.absolutePath, MODEL); assert.ok(model.absolutePath.startsWith(sharedRoot + path.sep));
          assert.equal(record.sharedModel.ino, report.migratedResources.find(file => file.sha256 === MODEL.sha256)!.ino);
          if (item.side === 'legacy') {
            const file = await inputs.authorize(owner, sourcePaths[3], ['probe', 'transcribe']);
            const probe = await media.probeDraft({ owner, fileToken: file.fileToken, signal: controller.signal }); record.probe = probe; assert.equal(probe.durationMs, SAMPLE.durationMs);
            const exportRoot = path.join(outputRoot, record.id, 'exports'); await mkdir(exportRoot, { recursive: true }); const output = await outputs.authorize(owner, exportRoot);
            await step('enqueue-real-production');
            const context = { owner, signal: controller.signal } as LocalSubtitleIpcHandlerContext;
            const result = await protectedHandlers[LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]!({ schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
              files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }], config: { ...record.config,
                output: { mode: 'custom', formats: ['SRT'], conflictPolicy: 'index', outputDirToken: output.outputDirToken }, postAction: { mode: 'export_only' } } }, context);
            assert.ok(result.ok); await jobs!.waitForIdle();
            const task = jobs!.getSessionSnapshot(owner).batches[0]?.tasks[0]; record.task = json(task); assert.equal(task?.status, 'completed', JSON.stringify(task?.error));
            record.exportFiles = await Promise.all((await readdir(exportRoot)).map(file => fingerprint(path.join(exportRoot, file)))); assert.ok(record.exportFiles.length);
          } else {
            const file = await studio!.media.authorizeInput(owner, sourcePaths[3]); const probe = await studio!.media.probe(owner, file.fileToken, controller.signal);
            record.probe = probe; assert.equal(probe.durationMs, SAMPLE.durationMs); await step('enqueue-real-production');
            await studio!.tasks.enqueue(owner, { files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }], config: record.config });
            await studio!.tasks.waitForIdle(); const task = studio!.tasks.list(owner)[0]; record.task = json(task);
            assert.equal(task?.status, 'completed', JSON.stringify(task?.error)); assert.equal(task.cleanupPending, undefined); assert.ok(task.documentId);
            const document = validateDocument(await repository.read(task.documentId)); assert.ok(document.schemaVersion === 2);
            record.canonicalTranscript = document.preservation.transcript; record.documentCues = document.cues.map(cue => ({ startMs: cue.timing.startMs, endMs: cue.timing.endMs, text: cue.source.plain }));
            record.document = { id: document.id, schemaVersion: 2, digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'), reopenedAfterShutdown: false, durability: task.documentDurability };
          }
          controller.signal.throwIfAborted(); sampleProcess(); assertTrace(record); record.status = 'completed'; await step('task-completed');
        })(), REAL_SHARED_BUDGET.caseMs, `${record.id} exceeded fifteen minutes`);
        await activeTrace.close(); activeTrace = undefined; assert.deepEqual(record.observerErrors, []);
        record.rawEvidencePath = path.join(outputRoot, `${record.id}.json`); await writeFile(record.rawEvidencePath, `${JSON.stringify(record, null, 2)}\n`);
      } catch (error) { record.status = 'failed'; record.error = errorEvidence(error); throw error; }
      finally { if (sampling) clearInterval(sampling); sampling = undefined; record.elapsedMs = Date.now() - started; await checkpoint(); }
    }
    report.status = 'completed';
  } catch (error) { report.status = 'failed'; report.error = errorEvidence(error); }
  finally {
    controller.abort(); clearTimeout(overall); if (sampling) clearInterval(sampling);
    let joined = false, removed = false, serverDisposed = false, noAlive = false;
    try {
      await phase('join-application-and-smoke');
      await within(preparation?.then(() => undefined, () => undefined) ?? Promise.resolve(), REAL_SHARED_BUDGET.cleanupMs, 'Resource preparation did not join');
      if (application) await within(application.shutdown('app_quit'), REAL_SHARED_BUDGET.cleanupMs, 'Shared application shutdown did not join');
      else { service?.fence(); await within(Promise.all([service?.shutdown(), smoke?.shutdown('app_quit')]), REAL_SHARED_BUDGET.cleanupMs, 'Partial shared service shutdown did not join'); }
      await activeTrace?.close(); activeTrace = undefined; joined = true;
      serverDisposed = (!legacyServer || legacyServer.snapshot.state === 'disposed') && (!studio || studio.snapshot().server?.state === 'disposed');
      noAlive = [...allPids].every(pid => !alive(pid)); assert.ok(serverDisposed && noAlive);
      for (const record of report.chains) { record.processChecks = record.observedProcessIds.map(processId => ({ processId, alive: alive(processId) }));
        record.cleanup = { joined: true, serverDisposed, noObservedProcessAlive: record.processChecks.every(value => !value.alive) };
        if (record.document) { const document = validateDocument(await new DocumentRepository(path.join(outputRoot, 'documents')).read(record.document.id)); assert.ok(document.schemaVersion === 2);
          assert.equal(createHash('sha256').update(JSON.stringify(document)).digest('hex'), record.document.digest); record.reopenedDocument = document; record.document.reopenedAfterShutdown = true; }
      }
      for (const backend of ['cpu', 'cuda'] as const) { const legacy = report.chains.find(record => record.side === 'legacy' && record.backend === backend), studioRecord = report.chains.find(record => record.side === 'studio' && record.backend === backend);
        if (legacy?.canonicalTranscript && studioRecord?.canonicalTranscript) { const comparison = analyzeRealDefaultComparison({ sampleId: 'A', backend,
          legacy: { canonicalTranscript: legacy.canonicalTranscript, rawAttempts: legacy.rawAttempts, windowPlan: legacy.windowPlan },
          studio: { canonicalTranscript: studioRecord.canonicalTranscript, document: studioRecord.reopenedDocument, documentCues: studioRecord.documentCues,
            rawAttempts: studioRecord.rawAttempts, windowPlan: studioRecord.windowPlan } }); report.comparisons.push(comparison);
          studioRecord.documentIntegrity = comparison.documents.studio;
          assert.ok(comparison.documents.studio.validDocument && comparison.documents.studio.canonicalEqual && comparison.documents.studio.mappingEqual && comparison.documents.studio.projectionEqual); }
      }
      assert.deepEqual(report.observerErrors, []);
      report.sourcesAfter = await Promise.all(sourcePaths.map(fingerprint)); assert.deepEqual(report.sourcesAfter, report.sourcesBefore); report.sourcesUnchanged = true;
      if (resourceRoot && rootIdentity) { const current = await lstat(resourceRoot, { bigint: true });
        assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.deepEqual([current.dev, current.ino], [rootIdentity.dev, rootIdentity.ino]);
        assert.equal(await realpath(resourceRoot), resourceRoot); assert.equal(path.dirname(resourceRoot).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
        assert.match(path.basename(resourceRoot), /^t9-[A-Za-z0-9]{6}$/u); await rm(resourceRoot, { recursive: true, force: false }); removed = true; }
      report.cleanup = { joined, rootRemoved: removed, serverDisposed, noObservedProcessAlive: noAlive };
    } catch (error) { report.status = 'failed'; report.cleanup = { joined, rootRemoved: removed, serverDisposed, noObservedProcessAlive: noAlive, error: errorEvidence(error) }; report.error ??= errorEvidence(error); }
    finally { if (activeTrace) { try { await activeTrace.close(); } catch (error) { report.observerErrors.push(errorEvidence(error)); } } }
    report.finalRuntimeState = { legacy: legacyServer?.snapshot, studio: studio?.snapshot(), smoke: smoke?.snapshot(), shared: service?.status(),
      processes: [...allPids].map(processId => ({ processId, alive: alive(processId) })) };
    report.completedAt = new Date().toISOString(); report.phase = report.status; await checkpoint(); await writes;
    console.log(`[T09 shared] ${report.status}: ${path.join(outputRoot, 'report.json')}`);
  }
  return report;
}
