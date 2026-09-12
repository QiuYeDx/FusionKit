// Maintenance-only T08 evidence. T07 and both production implementations remain unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry,
  LocalSubtitleCapabilityLeaseCoordinator } from '../../electron/main/local-subtitle/authorizations';
import { LocalSubtitleMediaNormalizer } from '../../electron/main/local-subtitle/media-normalizer';
import { LocalSubtitleModelManager } from '../../electron/main/local-subtitle/model-manager';
import { LocalSubtitleServerSupervisor, type LocalSubtitleServerSupervisorSnapshot } from '../../electron/main/local-subtitle/server-supervisor';
import { LocalSubtitleSessionRegistry } from '../../electron/main/local-subtitle/session-registry';
import { LocalSubtitleSessionLifecycle } from '../../electron/main/local-subtitle/session-lifecycle';
import { LocalSubtitleBackendResolver } from '../../electron/main/local-subtitle/backend-resolver';
import { LocalSubtitleJobManager } from '../../electron/main/local-subtitle/job-manager';
import { LocalSubtitleProductionExecutor } from '../../electron/main/local-subtitle/production-executor';
import { LocalSubtitleArtifactRegistry } from '../../electron/main/local-subtitle/subtitle-artifact-registry';
import { LocalSubtitleExporter } from '../../electron/main/local-subtitle/subtitle-exporter';
import { createLocalSubtitleProductionBackendAttestor as legacyAttestor } from '../../electron/main/local-subtitle/backend-attestor';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION as legacyCuda } from '../../electron/main/local-subtitle/accelerator-manager';
import { verifyLocalSubtitleRuntimeBundle as verifyLegacyRuntime } from '../../electron/main/local-subtitle/resource-path';
import { verifyLocalSubtitleRuntimeBundle as verifyStudioRuntime } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { LocalSubtitleMediaNormalizer as StudioMedia } from '../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { LocalSubtitleServerSupervisor as StudioServer } from '../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor as studioAttestor } from '../../electron/main/subtitle-studio/transcription/native/backend-attestor';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateDocument, type MediaSubtitleDocument } from '../../src/subtitle-studio/domain';
import { LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION, LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleTranscript } from '../../src/type/localSubtitle';
import type { EnqueueTranscriptionRequest } from '../../src/subtitle-studio/transcription/task-contract';
import { prepareRealDefaultResources } from './real-default-resource-fixture';
import { analyzeRealDefaultComparison } from './real-default-comparison-analysis';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_RELATIVE = 'docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/models/ggml-large-v3-q5_0.bin';
const SAMPLE_ROOT = 'test-results/subtitle-quality-review/';
export const REAL_DEFAULT_BUDGET = Object.freeze({ sampleMs: 15 * 60_000, cleanupMs: 45_000,
  resourcesMs: 10 * 60_000, overallMs: 90 * 60_000, startupMs: 120_000 });
export const REAL_DEFAULT_SAMPLES = Object.freeze([
  { id: 'A', relativePath: 'vad-baseline-isolated/A.wav', byteSize: 960078, durationMs: 30000, sha256: '196a524c3805cdc5cccd9711711220bc5591c04906be442c6fa00955874798c5' },
  { id: 'B', relativePath: 'vad-baseline-isolated/B.wav', byteSize: 960078, durationMs: 30000, sha256: '43e4541f77f7c9e0b9351431da61ff6912814f963159b17d5a51b1ba3b14bd93' },
  { id: 'C', relativePath: 'vad-baseline-isolated/C.wav', byteSize: 960078, durationMs: 30000, sha256: 'e57ad65505ebb1e8042939cb71023807d6761810c112fdcefc2653c54433b8b7' },
  { id: 'B-noise', relativePath: 'annotation-followup/B-noise.wav', byteSize: 576078, durationMs: 18000, sha256: '2f979f0bbb50c3a3896cee437e9b9ea7bd7745bb55bbd4b6decf24280da0d510' },
  { id: 'independent', relativePath: 'phase12/final-separators-production/app-inputs-isolated/independent.wav', byteSize: 5631844, durationMs: 175993, sha256: '9c80350769700f72edc5bd7e7428122f42b1c8eede81967dbe723e5fb7c4fc10' },
  { id: 'full', relativePath: 'phase12/final-separators-production/app-inputs-isolated/full.wav', byteSize: 83025744, durationMs: 216000, sha256: '9ae30957514dd75faa08464f3aeee6025cb2d9bdb98ae98bd703649451ded527' },
] as const);
type Sample = typeof REAL_DEFAULT_SAMPLES[number];
type Backend = 'cpu' | 'cuda';
type Side = 'legacy' | 'studio';
type Fingerprint = { path: string; byteSize: number; sha256: string; mtimeNs: string; dev: string; ino: string };
type ErrorEvidence = { name: string; code?: string; message: string };
type Cue = { startMs: number; endMs: number; text: string };
type RawAttempt = { ordinal: number; window?: unknown; request: Record<string, unknown>;
  kind?: 'primary' | 'quality_recovery' | 'separator'; response?: unknown; error?: ErrorEvidence };
type WindowPlan = { totalFrames: number; quietCandidates?: readonly { startFrame: number; endFrame: number }[];
  windows: Record<string, unknown>[] };
export type RealDefaultChainEvidence = {
  id: string; sampleId: string; side: Side; backend: Backend; repeat: boolean;
  status: 'pending' | 'running' | 'completed' | 'no_speech_detected' | 'failed';
  config: EnqueueTranscriptionRequest['config']; phase: string; startedAt?: string; elapsedMs?: number;
  phases: { phase: string; elapsedMs: number }[]; managedRoot?: string; modelCopy?: Fingerprint;
  probe?: unknown; task?: unknown; canonicalTranscript?: LocalSubtitleTranscript; documentCues?: Cue[];
  rawAttempts: RawAttempt[]; windowPlan?: WindowPlan; normalized?: unknown;
  materializations: Record<string, unknown>[]; resolutions: Record<string, unknown>[];
  backendProofs: Record<string, unknown>[]; observerErrors: ErrorEvidence[];
  serverSnapshots: { elapsedMs: number; snapshot: LocalSubtitleServerSupervisorSnapshot }[];
  observedProcessIds: number[]; processChecks?: { processId: number; alive: boolean }[];
  document?: { id: string; schemaVersion: 2; digest: string; reopenedAfterShutdown: boolean; durability?: string };
  reopenedDocument?: MediaSubtitleDocument;
  documentIntegrity?: ReturnType<typeof analyzeRealDefaultComparison>['documents']['studio'];
  documentCount?: number; exportFiles?: Fingerprint[];
  cleanup?: { joined: boolean; serverDisposed: boolean; noObservedProcessAlive: boolean; error?: ErrorEvidence };
  error?: ErrorEvidence;
};
type ResourceFixture = Awaited<ReturnType<typeof prepareRealDefaultResources>>;
export interface RealDefaultComparisonReport {
  schemaVersion: 1; evidenceKind: 'real-production-default-vad-device-comparison';
  status: 'running' | 'completed' | 'failed'; qualityStatus: 'requires_review';
  outputRoot: string; startedAt: string; completedAt?: string; budgets: typeof REAL_DEFAULT_BUDGET;
  host: { executable: string; version: string; versions: NodeJS.ProcessVersions; platform: string; arch: string };
  scope: { noFixtureInference: true; noQualityPassClaim: true; expectedSideRuns: 26; dependencyOverrides: string[] };
  sourceBefore?: { model: Fingerprint; samples: Fingerprint[] };
  sourceAfter?: { model: Fingerprint; samples: Fingerprint[] }; sourcesUnchanged?: boolean;
  runtimes?: { legacy: unknown; studio: unknown }; resources?: ResourceFixture['evidence'];
  chains: RealDefaultChainEvidence[]; comparisons: ReturnType<typeof analyzeRealDefaultComparison>[];
  repeatComparisons: ReturnType<typeof analyzeRealDefaultComparison>[];
  pairedOutcomes: { sampleId: string; backend: Backend; repeat: boolean; legacy: RealDefaultChainEvidence['status'];
    studio: RealDefaultChainEvidence['status']; outcomeMismatch: boolean; canonicalComparable: boolean }[];
  integrityErrors: ErrorEvidence[]; error?: ErrorEvidence; resourceCleanup?: unknown;
}

export function realDefaultConfig(backend: Backend): EnqueueTranscriptionRequest['config'] {
  return { modelId: 'large-v3-q5_0', devicePreference: backend, language: 'ja', taskMode: 'transcribe',
    vadEnabled: true, windowStrategy: 'acoustic_quiet_v1', advanced: { beamSize: 5, temperature: 0,
      vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 } };
}
export function realDefaultMatrix() {
  const matrix: { sample: Sample; backend: Backend; side: Side; repeat: boolean }[] = [];
  for (const backend of ['cpu', 'cuda'] as const) for (const sample of REAL_DEFAULT_SAMPLES)
    for (const side of ['legacy', 'studio'] as const) matrix.push({ sample, backend, side, repeat: false });
  for (const side of ['legacy', 'studio'] as const) matrix.push({ sample: REAL_DEFAULT_SAMPLES[0], backend: 'cuda', side, repeat: true });
  return matrix;
}
function errorEvidence(error: unknown): ErrorEvidence {
  const value = error as { name?: unknown; localSubtitleCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = value?.localSubtitleCode ?? value?.code;
  return { name: typeof value?.name === 'string' ? value.name : 'Error',
    ...(typeof code === 'string' ? { code } : {}), message: typeof value?.message === 'string' ? value.message : String(error) };
}
function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'signal' || key === 'evidence' ? undefined :
    typeof item === 'bigint' ? item.toString() : item)) as T;
}
function object(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }
async function fingerprint(file: string): Promise<Fingerprint> {
  const absolutePath = await realpath(file), before = await lstat(absolutePath, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink());
  const hash = createHash('sha256'); for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  const after = await lstat(absolutePath, { bigint: true });
  for (const key of ['size', 'mtimeNs', 'dev', 'ino'] as const) assert.equal(after[key], before[key], 'Source changed while hashing');
  assert.ok(after.size <= BigInt(Number.MAX_SAFE_INTEGER));
  return { path: absolutePath, byteSize: Number(after.size), sha256: hash.digest('hex'),
    mtimeNs: after.mtimeNs.toString(), dev: after.dev.toString(), ino: after.ino.toString() };
}
function assertCopy(source: Fingerprint, copy: Fingerprint, managedRoot: string) {
  const relative = path.relative(managedRoot, copy.path);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(copy.sha256, source.sha256); assert.equal(copy.byteSize, source.byteSize);
  assert.ok(copy.dev !== source.dev || copy.ino !== source.ino, 'Managed model must be a distinct copy');
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The original sync return, including a ticket/result pair, is never replaced. */
export function observeRealMethod(options: {
  target: object; method: string; begin: (args: readonly unknown[]) => { resolved?: (value: unknown) => void; rejected?: (error: unknown) => void };
  onError: (error: unknown) => void; pending: Set<Promise<void>>; selectPromise?: (result: unknown) => unknown;
}) {
  const descriptor = Object.getOwnPropertyDescriptor(options.target, options.method);
  assert.ok(descriptor && typeof descriptor.value === 'function', `Missing observed method ${options.method}`);
  const original = descriptor.value as (...args: unknown[]) => unknown;
  const reportError = (error: unknown) => { try { options.onError(error); } catch { /* Observers cannot change production control flow. */ } };
  const safe = (callback: () => void) => { try { callback(); } catch (error) { reportError(error); } };
  const replacement = function(this: unknown, ...args: unknown[]) {
    let observer: ReturnType<typeof options.begin> = {};
    safe(() => { observer = options.begin(args); });
    let result: unknown;
    try { result = original.apply(this, args); }
    catch (error) { safe(() => observer.rejected?.(error)); throw error; }
    let watched = result;
    safe(() => { watched = options.selectPromise ? options.selectPromise(result) : result; });
    if (watched instanceof Promise) {
      const pending = watched.then(value => safe(() => observer.resolved?.(value)), error => safe(() => observer.rejected?.(error)));
      options.pending.add(pending);
      void pending.then(() => options.pending.delete(pending), error => { options.pending.delete(pending); reportError(error); });
    } else safe(() => observer.resolved?.(watched));
    return result;
  };
  Object.defineProperty(options.target, options.method, { ...descriptor, value: replacement });
  return () => {
    const current = Object.getOwnPropertyDescriptor(options.target, options.method);
    Object.defineProperty(options.target, options.method, descriptor);
    assert.equal(current?.value, replacement, `Observed method ${options.method} changed concurrently`);
  };
}

function installObservers(record: RealDefaultChainEvidence, checkpoint: () => Promise<void>) {
  const pending = new Set<Promise<void>>(), restores: (() => void)[] = [];
  const windowsByPath = new Map<string, unknown>(), separatorLeases = new WeakSet<object>(), taskLeases = new WeakSet<object>();
  const onError = (error: unknown) => { record.observerErrors.push(errorEvidence(error)); };
  const changed = () => { const job = checkpoint().catch(onError); pending.add(job); void job.then(() => pending.delete(job)); };
  const mediaPrototype = record.side === 'legacy' ? LocalSubtitleMediaNormalizer.prototype : StudioMedia.prototype;
  const serverPrototype = record.side === 'legacy' ? LocalSubtitleServerSupervisor.prototype : StudioServer.prototype;
  const observe = (target: object, method: string, begin: Parameters<typeof observeRealMethod>[0]['begin'],
    selectPromise?: (result: unknown) => unknown) => restores.push(observeRealMethod({ target, method, begin, selectPromise, pending, onError }));
  try {
    observe(mediaPrototype, 'normalizeTask', () => ({ resolved: value => {
      record.normalized = jsonValue(value); record.windowPlan = { totalFrames: Number(object(value).totalFrames), windows: [] }; changed();
    } }));
    observe(mediaPrototype, 'readQuietCandidates', () => ({ resolved: value => {
      assert.ok(record.windowPlan); record.windowPlan.quietCandidates = jsonValue(value) as WindowPlan['quietCandidates']; changed();
    } }));
    observe(mediaPrototype, 'materializeWindow', args => {
      const options = object(args[0]), entry: Record<string, unknown> = { descriptor: jsonValue(options.descriptor),
        conditionQuietAudio: options.conditionQuietAudio === true };
      record.materializations.push(entry);
      const descriptor = object(options.descriptor);
      if (!record.windowPlan?.windows.some(value => value.windowKey === descriptor.windowKey)) record.windowPlan?.windows.push(jsonValue(descriptor));
      return { resolved: value => { entry.result = jsonValue(value); changed(); }, rejected: error => { entry.error = errorEvidence(error); changed(); } };
    });
    observe(mediaPrototype, 'resolveWindow', args => {
      const entry: Record<string, unknown> = { window: jsonValue(args[0]), expected: jsonValue(args[1]) };
      record.resolutions.push(entry);
      return { resolved: value => { entry.result = jsonValue(value); windowsByPath.set(String(object(value).filePath), jsonValue(args[0])); changed(); },
        rejected: error => { entry.error = errorEvidence(error); changed(); } };
    });
    observe(serverPrototype, 'acquirePinnedTaskLease', () => ({ resolved: value => { taskLeases.add(value as object); } }));
    observe(serverPrototype, 'acquirePinnedSeparatorLease', () => ({ resolved: value => { separatorLeases.add(value as object); } }));
    observe(serverPrototype, 'beginInference', args => {
      const request = jsonValue(object(args[1]));
      assert.ok(separatorLeases.has(args[0] as object) || taskLeases.has(args[0] as object), 'Inference lease acquisition was not observed');
      const attempt: RawAttempt = { ordinal: record.rawAttempts.length + 1, request,
        kind: separatorLeases.has(args[0] as object) ? 'separator' : request.temperature === 0 ? 'primary' : 'quality_recovery',
        window: windowsByPath.get(String(request.filePath)) };
      record.rawAttempts.push(attempt); changed();
      return { resolved: value => { attempt.response = jsonValue(value); changed(); }, rejected: error => { attempt.error = errorEvidence(error); changed(); } };
    }, result => object(result).result);
  } catch (error) { for (const restore of restores.reverse()) restore(); throw error; }
  return { async close() {
    try { await within((async () => { while (pending.size) await Promise.all([...pending]); })(),
      REAL_DEFAULT_BUDGET.cleanupMs, 'Real observer operations did not settle'); }
    finally { for (const restore of restores.reverse()) { try { restore(); } catch (error) { onError(error); } } }
  } };
}
function observedAttestor<Context, Proof>(actual: { supportedBackends: readonly string[];
  verifyBackend: (context: Context) => Promise<Proof> }, record: RealDefaultChainEvidence) {
  if (record.backend === 'cuda') assert.ok(actual.supportedBackends.includes('cuda'), 'This host has no real CUDA attestor');
  return (context: Context) => {
    const operation = actual.verifyBackend(context);
    // Observe without replacing the actual attestation Promise or its verdict.
    void operation.then(result => { try { record.backendProofs.push({ ...jsonValue(object(result)), context: jsonValue(context) }); }
      catch (error) { record.observerErrors.push(errorEvidence(error)); } }, () => undefined);
    return operation;
  };
}
function assertTrace(record: RealDefaultChainEvidence, sample: Sample) {
  assert.ok(record.rawAttempts.length > 0, 'No real inference request was observed');
  assert.ok(record.observedProcessIds.length > 0, 'No native server process was observed');
  assert.ok(record.serverSnapshots.some(value => value.snapshot.purpose === 'inference' && value.snapshot.backend === record.backend));
  for (const attempt of record.rawAttempts) {
    assert.equal(attempt.request.language, 'ja'); assert.equal(attempt.request.taskMode, 'transcribe');
    assert.equal(attempt.request.beamSize, 5); assert.equal(attempt.request.vadMinSilenceMs, 500);
    if (attempt.kind === 'separator') {
      assert.equal(record.backend, 'cuda'); assert.equal(attempt.request.vadEnabled, false); assert.equal(attempt.request.temperature, 0);
    } else {
      assert.equal(attempt.request.vadEnabled, true);
      // The frozen executor permits one quality replay at a 0.2 temperature step.
      assert.equal(attempt.request.temperature, attempt.kind === 'quality_recovery' ? 0.2 : 0);
    }
    assert.equal(attempt.request.timingMode, undefined, 'VAD must not request token timestamps');
  }
  assert.ok(record.rawAttempts.some(attempt => attempt.kind === 'primary'), 'No primary VAD request was observed');
  assert.ok(record.windowPlan && record.windowPlan.totalFrames > 0);
  if (sample.durationMs > 30000) {
    assert.ok(record.windowPlan.quietCandidates !== undefined, 'Long sample did not execute acoustic pause scanning');
    assert.ok(record.windowPlan.windows.length > 1, 'Long sample did not execute multiple windows');
  }
  if (record.backend === 'cuda') {
    assert.ok(record.backendProofs.length > 0, 'CUDA requires the real exact-PID VRAM attestor');
    for (const proof of record.backendProofs) {
      assert.equal(proof.verified, true); assert.equal(proof.backend, 'cuda');
      assert.ok(record.observedProcessIds.includes(Number(proof.processId)));
      assert.match(String(proof.acceleratorPackGeneration), /^[a-f0-9]{64}$/u);
    }
  }
}
function assertTranscript(record: RealDefaultChainEvidence, sample: Sample) {
  const transcript = record.canonicalTranscript; assert.ok(transcript);
  assert.equal(transcript.source.durationMs, sample.durationMs);
  assert.equal(transcript.model.modelId, 'large-v3-q5_0');
  assert.equal(transcript.model.modelHash, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256);
  assert.equal(transcript.model.backend, record.backend); assert.ok(transcript.segments.length > 0);
}
function taskResult(record: RealDefaultChainEvidence, task: unknown) {
  record.task = jsonValue(task);
  const value = object(task ?? {});
  if (value.status === 'completed') { record.status = 'completed'; return; }
  const error = object(value.error ?? {}), code = error.code;
  record.error = { name: 'ProductionTaskFailure', ...(typeof code === 'string' ? { code } : {}), message: `Production task ended with ${String(value.status)}` };
  record.status = code === 'no_speech_detected' ? 'no_speech_detected' : 'failed';
}

async function runChain(options: {
  record: RealDefaultChainEvidence; sample: Sample; signal: AbortSignal; checkpoint: () => Promise<void>;
  snapshot: () => LocalSubtitleServerSupervisorSnapshot | null; shutdown: () => Promise<void>;
  work: (signal: AbortSignal, phase: (name: string) => Promise<void>) => Promise<void>;
}) {
  const record = options.record, started = Date.now(), controller = new AbortController();
  let lastSnapshot = ''; const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort();
  const observe = () => {
    const snapshot = options.snapshot(); if (!snapshot) return;
    if (snapshot.processId && !record.observedProcessIds.includes(snapshot.processId)) record.observedProcessIds.push(snapshot.processId);
    const key = JSON.stringify(snapshot); if (key !== lastSnapshot) { lastSnapshot = key;
      record.serverSnapshots.push({ elapsedMs: Date.now() - started, snapshot }); }
  };
  record.startedAt = new Date().toISOString(); record.status = 'running';
  const observer = installObservers(record, options.checkpoint), interval = setInterval(observe, 100);
  const phase = async (name: string) => {
    controller.signal.throwIfAborted(); record.phase = name; record.phases.push({ phase: name, elapsedMs: Date.now() - started });
    observe(); console.log(`[T08] ${record.id}: ${name}`); await options.checkpoint(); controller.signal.throwIfAborted();
  };
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => { abortListener = () => reject(controller.signal.reason ?? new Error('Cancelled'));
    controller.signal.addEventListener('abort', abortListener, { once: true }); if (controller.signal.aborted) abortListener(); });
  const work = Promise.resolve().then(() => options.work(controller.signal, phase));
  const settled = work.then(() => undefined, () => undefined);
  try {
    await within(Promise.race([work, interrupted]), REAL_DEFAULT_BUDGET.sampleMs, `${record.id} exceeded its fifteen-minute deadline`);
    observe(); assertTrace(record, options.sample);
    if ((record as RealDefaultChainEvidence).status === 'completed') assertTranscript(record, options.sample);
  } catch (error) { record.status = 'failed'; record.error = errorEvidence(error); }
  finally {
    controller.abort(); options.signal.removeEventListener('abort', abort);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    try {
      await within(options.shutdown(), REAL_DEFAULT_BUDGET.cleanupMs, `${record.id} shutdown did not join`);
      await within(settled, 5000, `${record.id} work did not settle after shutdown`);
      observe(); record.processChecks = record.observedProcessIds.map(processId => ({ processId, alive: alive(processId) }));
      record.cleanup = { joined: true, serverDisposed: options.snapshot()?.state === 'disposed',
        noObservedProcessAlive: record.processChecks.every(value => !value.alive) };
      assert.ok(record.cleanup.serverDisposed && record.cleanup.noObservedProcessAlive, 'Owned server cleanup is incomplete');
    } catch (error) { record.status = 'failed'; record.cleanup = { joined: false, serverDisposed: false,
      noObservedProcessAlive: false, error: errorEvidence(error) }; }
    clearInterval(interval);
    try { await observer.close(); }
    catch (error) { record.observerErrors.push(errorEvidence(error));
      record.cleanup = { joined: false, serverDisposed: record.cleanup?.serverDisposed ?? false,
        noObservedProcessAlive: record.cleanup?.noObservedProcessAlive ?? false, error: errorEvidence(error) }; }
    if (record.observerErrors.length) { record.status = 'failed'; record.error ??= record.observerErrors[0]; }
    record.elapsedMs = Date.now() - started; await options.checkpoint();
    console.log(`[T08] ${record.id}: ${record.status}, ${(record.elapsedMs / 1000).toFixed(1)}s`);
  }
}

type ChainOptions = { appRoot: string; caseRoot: string; resources: ResourceFixture; audio: Fingerprint;
  model: Fingerprint; sample: Sample; record: RealDefaultChainEvidence; signal: AbortSignal; checkpoint: () => Promise<void> };
async function runLegacy(options: ChainOptions) {
  const { record } = options, managedRoot = options.resources.legacy.managedResourceRoot;
  const exportRoot = path.join(options.caseRoot, 'exports'); await mkdir(exportRoot, { recursive: true }); record.managedRoot = managedRoot;
  const owner = { webContentsId: 808, ownerSessionId: record.id }, environment = { mode: 'development', appRoot: options.appRoot } as const;
  const inputs = new LocalSubtitleInputAuthorizationRegistry(), outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs), artifacts = new LocalSubtitleArtifactRegistry();
  const media = new LocalSubtitleMediaNormalizer({ environment, managedResourceRoot: managedRoot, inputAuthorizations: inputs });
  const attestor = legacyAttestor(), server = new LocalSubtitleServerSupervisor({ managedResourceRoot: managedRoot,
    startupTimeoutMs: REAL_DEFAULT_BUDGET.startupMs, dependencies: { verifyBackend: observedAttestor(attestor, record) } });
  const registry = new LocalSubtitleSessionRegistry(), models = new LocalSubtitleModelManager({ managedResourceRoot: managedRoot,
    runtimeEnvironment: environment, supervisor: server, sessionRegistry: registry });
  const resolveCudaAccelerator = (signal?: AbortSignal) => models.resolveManagedAccelerator(legacyCuda.resourceId, signal);
  const realExporter = new LocalSubtitleExporter(artifacts);
  const executor = new LocalSubtitleProductionExecutor({ media, supervisor: server, inputs, outputs, runtimeEnvironment: environment,
    resolveCudaAccelerator, exporter: { supportsConflictPolicy: policy => realExporter.supportsConflictPolicy(policy),
      exportArtifacts: request => { record.canonicalTranscript = structuredClone(request.transcript); return realExporter.exportArtifacts(request); } } });
  const jobs = new LocalSubtitleJobManager({ registry, inputs, outputs, leases, runtimeVerifier: media,
    backendResolver: new LocalSubtitleBackendResolver({ runtimeEnvironment: environment, resolveCudaAccelerator,
      cudaAttestationAvailable: attestor.supportedBackends.includes('cuda'), metalAttestationAvailable: attestor.supportedBackends.includes('metal') }),
    modelResolver: models, mediaSelections: media, executor, artifacts });
  const lifecycle = new LocalSubtitleSessionLifecycle(jobs, models, media, server, registry);
  await runChain({ ...options, snapshot: () => server.snapshot, shutdown: async () => {
    try { await lifecycle.shutdown('app_quit'); } finally { inputs.releaseOwner(owner); outputs.releaseOwner(owner); artifacts.releaseOwner(owner); }
  }, work: async (signal, phase) => {
    await phase('initialize-and-reverify-resources'); await models.initialize();
    const model = await models.resolveManagedModel('large-v3-q5_0', signal);
    record.modelCopy = await fingerprint(model.absolutePath); assertCopy(options.model, record.modelCopy, managedRoot);
    await phase('authorize-and-probe'); const file = await inputs.authorize(owner, options.audio.path, ['probe', 'transcribe']);
    const probe = await media.probeDraft({ owner, fileToken: file.fileToken, signal }); record.probe = probe;
    assert.equal(probe.durationMs, options.sample.durationMs); assert.equal(probe.audioTracks.length, 1);
    const output = await outputs.authorize(owner, exportRoot); await phase('enqueue-real-production');
    const batch = await jobs.enqueue(owner, { schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
      files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }], config: { ...record.config,
        output: { mode: 'custom', formats: ['SRT'], conflictPolicy: 'index', outputDirToken: output.outputDirToken },
        postAction: { mode: 'export_only' } } }, signal);
    await jobs.waitForIdle(); signal.throwIfAborted();
    taskResult(record, jobs.getSessionSnapshot(owner).batches.find(value => value.batchId === batch.batchId)?.tasks[0]);
    record.exportFiles = []; for (const fileName of await readdir(exportRoot)) record.exportFiles.push(await fingerprint(path.join(exportRoot, fileName)));
    if (record.status === 'completed') assert.ok(record.exportFiles.some(file => file.path.endsWith('.srt')));
    else { assert.equal(record.canonicalTranscript, undefined); assert.equal(record.exportFiles.length, 0); }
    await phase('task-terminal');
  } });
}
async function runStudio(options: ChainOptions) {
  const { record } = options, documentRoot = path.join(options.caseRoot, 'documents'), repository = new DocumentRepository(documentRoot);
  const owner = { webContentsId: 809, ownerSessionId: record.id };
  const runtime = createTranscriptionRuntime({ userDataRoot: options.resources.studio.userDataRoot,
    environment: { mode: 'development', appRoot: options.appRoot } }, { server: { startupTimeoutMs: REAL_DEFAULT_BUDGET.startupMs,
      dependencies: { verifyBackend: observedAttestor(studioAttestor(), record) } } }, repository);
  record.managedRoot = runtime.managedResourceRoot;
  assert.equal(runtime.managedResourceRoot, options.resources.studio.managedResourceRoot);
  await runChain({ ...options, snapshot: () => runtime.snapshot().server, shutdown: () => runtime.shutdown(), work: async (signal, phase) => {
    await phase('initialize-and-reverify-resources'); await runtime.initialize(); assert.equal((await runtime.inspectRuntime()).status, 'verified');
    const model = await runtime.resources.resolveModel(owner, 'large-v3-q5_0', signal);
    record.modelCopy = await fingerprint(model.absolutePath); assertCopy(options.model, record.modelCopy, runtime.managedResourceRoot);
    await phase('authorize-and-probe'); const file = await runtime.media.authorizeInput(owner, options.audio.path);
    const probe = await runtime.media.probe(owner, file.fileToken, signal); record.probe = probe;
    assert.equal(probe.durationMs, options.sample.durationMs); assert.equal(probe.audioTracks.length, 1);
    await phase('enqueue-real-production'); const batch = await runtime.tasks.enqueue(owner,
      { files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }], config: record.config });
    await runtime.tasks.waitForIdle(); signal.throwIfAborted(); const task = runtime.tasks.list(owner).find(value => value.batchId === batch.batchId);
    taskResult(record, task); assert.equal(task?.cleanupPending, undefined); record.documentCount = (await repository.list()).length;
    if (record.status === 'completed') {
      assert.ok(task?.documentId); assert.equal(record.documentCount, 1); const document = validateDocument(await repository.read(task.documentId));
      assert.equal(document.schemaVersion, 2); assert.ok(document.schemaVersion === 2);
      record.canonicalTranscript = document.preservation.transcript;
      record.documentCues = document.cues.map(cue => ({ startMs: cue.timing.startMs, endMs: cue.timing.endMs, text: cue.source.plain }));
      assert.deepEqual(record.documentCues, record.canonicalTranscript.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })));
      record.document = { id: document.id, schemaVersion: 2, digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        reopenedAfterShutdown: false, durability: task.documentDurability };
    } else { assert.equal(task?.documentId, undefined); assert.equal(record.documentCount, 0); }
    await phase('task-terminal');
  } });
  if (record.document && record.cleanup?.joined) {
    const reopened = validateDocument(await new DocumentRepository(documentRoot).read(record.document.id));
    assert.equal(reopened.schemaVersion, 2); assert.ok(reopened.schemaVersion === 2);
    assert.equal(createHash('sha256').update(JSON.stringify(reopened)).digest('hex'), record.document.digest);
    record.reopenedDocument = reopened; record.document.reopenedAfterShutdown = true; await options.checkpoint();
    assert.ok(record.canonicalTranscript);
    const documentCheck = analyzeRealDefaultComparison({ sampleId: record.sampleId, backend: record.backend,
      legacy: { canonicalTranscript: record.canonicalTranscript },
      studio: { canonicalTranscript: record.canonicalTranscript, document: reopened, documentCues: record.documentCues } });
    record.documentIntegrity = documentCheck.documents.studio;
    assert.equal(record.documentIntegrity.validDocument, true); assert.equal(record.documentIntegrity.canonicalEqual, true);
    assert.equal(record.documentIntegrity.mappingEqual, true); assert.equal(record.documentIntegrity.projectionEqual, true);
    await options.checkpoint();
  }
}

/** Explicit gate; this function is never run by ordinary regression tests. */
export async function runRealDefaultComparison(): Promise<RealDefaultComparisonReport> {
  assert.equal(process.env.FUSIONKIT_REAL_DEFAULT_ASR, '1', 'Requires explicit FUSIONKIT_REAL_DEFAULT_ASR=1');
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const appRoot = await realpath(REPOSITORY), parent = path.join(REPOSITORY, 'test-results', 'studio-t08', 'real-default-comparison');
  await mkdir(parent, { recursive: true }); const outputRoot = await mkdtemp(path.join(parent, 'run-'));
  const report: RealDefaultComparisonReport = { schemaVersion: 1, evidenceKind: 'real-production-default-vad-device-comparison',
    status: 'running', qualityStatus: 'requires_review', outputRoot, startedAt: new Date().toISOString(), budgets: REAL_DEFAULT_BUDGET,
    host: { executable: process.execPath, version: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch },
    scope: { noFixtureInference: true, noQualityPassClaim: true, expectedSideRuns: 26,
      dependencyOverrides: ['server.startupTimeoutMs=120000', 'call-through real media/server/backend observation',
        'legacy exporter observes then delegates real export', 'resource fixture transports pinned actual bytes'] },
    chains: [], comparisons: [], repeatComparisons: [], pairedOutcomes: [], integrityErrors: [] };
  let writes = Promise.resolve();
  const checkpoint = () => {
    const serialized = JSON.stringify(report, null, 2);
    const next = writes.then(async () => {
      const pending = path.join(outputRoot, 'report.pending.json');
      await writeFile(pending, serialized, { mode: 0o600 });
      await rename(pending, path.join(outputRoot, 'report.json'));
    });
    writes = next.catch(error => { report.integrityErrors.push(errorEvidence(error)); }); return next;
  };
  console.log(`[T08] Evidence: ${outputRoot}`); await checkpoint();
  const overall = new AbortController(), overallTimer = setTimeout(() => overall.abort(new Error('T08 ninety-minute deadline exceeded')), REAL_DEFAULT_BUDGET.overallMs);
  let resources: ResourceFixture | undefined;
  const readSources = async () => ({ model: await fingerprint(path.join(REPOSITORY, MODEL_RELATIVE)),
    samples: await Promise.all(REAL_DEFAULT_SAMPLES.map(sample => fingerprint(path.join(REPOSITORY, SAMPLE_ROOT, sample.relativePath)))) });
  try {
    report.sourceBefore = await readSources(); const { model, samples } = report.sourceBefore;
    assert.equal(model.sha256, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256); assert.equal(model.byteSize, 1081140203);
    for (let index = 0; index < REAL_DEFAULT_SAMPLES.length; index++) {
      assert.equal(samples[index]!.sha256, REAL_DEFAULT_SAMPLES[index]!.sha256); assert.equal(samples[index]!.byteSize, REAL_DEFAULT_SAMPLES[index]!.byteSize);
    }
    const environment = { mode: 'development', appRoot } as const;
    const [legacy, studio] = await Promise.all([verifyLegacyRuntime({ environment, scope: 'all' }), verifyStudioRuntime({ environment, scope: 'all' })]);
    assert.notEqual(legacy.root, studio.root); report.runtimes = { legacy, studio }; await checkpoint();
    const resourceController = new AbortController(), abortResources = () => resourceController.abort(overall.signal.reason);
    overall.signal.addEventListener('abort', abortResources, { once: true });
    const resourceTimer = setTimeout(() => resourceController.abort(new Error('T08 resource ten-minute deadline exceeded')), REAL_DEFAULT_BUDGET.resourcesMs);
    const preparation = prepareRealDefaultResources({ projectRoot: appRoot, runRoot: outputRoot, modelSourcePath: model.path,
      signal: resourceController.signal, onProgress: async evidence => { report.resources = evidence; await checkpoint(); } });
    try { resources = await preparation; report.resources = resources.evidence; resourceController.signal.throwIfAborted(); }
    catch (error) { if (object(error).evidence) report.resources = object(error).evidence as ResourceFixture['evidence']; throw error; }
    finally { clearTimeout(resourceTimer); overall.signal.removeEventListener('abort', abortResources); }
    overall.signal.throwIfAborted();
    for (const item of realDefaultMatrix()) {
      overall.signal.throwIfAborted();
      const id = `${item.backend}-${item.sample.id}-${item.side}${item.repeat ? '-repeat' : ''}`;
      const record: RealDefaultChainEvidence = { id, sampleId: item.sample.id, backend: item.backend, side: item.side, repeat: item.repeat,
        status: 'pending', config: realDefaultConfig(item.backend), phase: 'not-started', phases: [], rawAttempts: [], materializations: [],
        resolutions: [], backendProofs: [], observerErrors: [], serverSnapshots: [], observedProcessIds: [] };
      report.chains.push(record); await checkpoint();
      try { await (item.side === 'legacy' ? runLegacy : runStudio)({ appRoot, caseRoot: path.join(outputRoot, 'cases', id), resources,
        sample: item.sample, record, signal: overall.signal, checkpoint, model,
        audio: samples[REAL_DEFAULT_SAMPLES.indexOf(item.sample)]! }); }
      catch (error) { record.status = 'failed'; record.error = errorEvidence(error); }
      if (record.status === 'failed') report.integrityErrors.push(record.error ?? { name: 'ChainFailure', message: id });
      await checkpoint();
      if (!record.cleanup?.joined || !record.cleanup.noObservedProcessAlive || record.observerErrors.length)
        throw new Error(`${id} did not safely finish; remaining matrix was not started`);
      if (item.side === 'studio') {
        const previous = report.chains.find(value => value.sampleId === item.sample.id && value.backend === item.backend && value.side === 'legacy' && value.repeat === item.repeat)!;
        report.pairedOutcomes.push({ sampleId: item.sample.id, backend: item.backend, repeat: item.repeat,
          legacy: previous.status, studio: record.status, outcomeMismatch: previous.status !== record.status,
          canonicalComparable: Boolean(previous.canonicalTranscript && record.canonicalTranscript) });
        if (previous.canonicalTranscript && record.canonicalTranscript) report.comparisons.push(analyzeRealDefaultComparison({
          sampleId: item.repeat ? `${item.sample.id}-repeat` : item.sample.id, backend: item.backend,
          legacy: { ...previous, document: previous.reopenedDocument, canonicalTranscript: previous.canonicalTranscript },
          studio: { ...record, document: record.reopenedDocument, canonicalTranscript: record.canonicalTranscript } }));
      }
      if (item.repeat && record.canonicalTranscript) {
        const baseline = report.chains.find(value => value.sampleId === 'A' && value.backend === 'cuda' && value.side === item.side && !value.repeat)!;
        if (baseline.canonicalTranscript) report.repeatComparisons.push(analyzeRealDefaultComparison({ sampleId: `A-${item.side}-first-vs-repeat`, backend: 'cuda',
          comparisonKind: item.side === 'legacy' ? 'legacy_repeat' : 'studio_repeat',
          legacy: { ...baseline, document: baseline.reopenedDocument, canonicalTranscript: baseline.canonicalTranscript },
          studio: { ...record, document: record.reopenedDocument, canonicalTranscript: record.canonicalTranscript } }));
      }
      await checkpoint();
    }
    report.status = report.integrityErrors.length ? 'failed' : 'completed';
  } catch (error) { report.status = 'failed'; report.error = errorEvidence(error); }
  finally {
    try { if (resources) {
      if (report.chains.every(chain => chain.cleanup?.joined && chain.cleanup.serverDisposed && chain.cleanup.noObservedProcessAlive)) {
        report.resourceCleanup = await within(resources.cleanup(), REAL_DEFAULT_BUDGET.cleanupMs + 5000, 'T08 resource cleanup did not join');
        report.resources = resources.evidence;
      } else { report.resourceCleanup = { skipped: true, reason: 'A chain or its observer did not join; installed resources remain owned by this isolated run.' };
        report.status = 'failed'; }
    } }
    catch (error) { report.status = 'failed'; report.integrityErrors.push(errorEvidence(error)); }
    try { if (report.sourceBefore) { report.sourceAfter = await readSources(); report.sourcesUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
      assert.ok(report.sourcesUnchanged, 'Read-only sources changed'); } }
    catch (error) { report.status = 'failed'; report.integrityErrors.push(errorEvidence(error)); }
    clearTimeout(overallTimer); if (overall.signal.aborted) { report.status = 'failed'; report.error ??= errorEvidence(overall.signal.reason); }
    report.completedAt = new Date().toISOString(); await checkpoint(); await writes;
  }
  return report;
}
