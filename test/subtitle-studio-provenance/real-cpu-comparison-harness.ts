// Maintenance-only real inference comparison. Never imported by product code.
// Both sides use their own unmodified production authorities, media and server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
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
import { verifyLocalSubtitleRuntimeBundle as verifyLegacyRuntime } from '../../electron/main/local-subtitle/resource-path';
import { verifyLocalSubtitleRuntimeBundle as verifyStudioRuntime } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateDocument } from '../../src/subtitle-studio/domain';
import { LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION, LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleTranscript } from '../../src/type/localSubtitle';
import type { EnqueueTranscriptionRequest } from '../../src/subtitle-studio/transcription/task-contract';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIO_RELATIVE = 'test-results/subtitle-quality-review/vad-baseline-isolated/A.wav';
const MODEL_RELATIVE = 'docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/models/ggml-large-v3-q5_0.bin';
const AUDIO_HASH = '196a524c3805cdc5cccd9711711220bc5591c04906be442c6fa00955874798c5';
const CHAIN_DEADLINE_MS = 10 * 60_000;
const CLEANUP_DEADLINE_MS = 45_000;
const OWNER = Object.freeze({ webContentsId: 707, ownerSessionId: 'real-cpu-comparison' });

export const REAL_CPU_COMPARISON_CONFIG: EnqueueTranscriptionRequest['config'] = Object.freeze({
  modelId: 'large-v3-q5_0', devicePreference: 'cpu', language: 'ja', taskMode: 'transcribe',
  vadEnabled: false, windowStrategy: 'fixed_v1', advanced: Object.freeze({
    beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7000,
    maxCueChars: 84, maxLineChars: 42,
  }),
});

type Fingerprint = { path: string; byteSize: number; sha256: string; mtimeNs: string; dev: string; ino: string };
type Cue = { startMs: number; endMs: number; text: string };
type ChainEvidence = {
  side: 'legacy' | 'studio'; startedAt?: string; elapsedMs?: number; phase: string;
  phases: { phase: string; elapsedMs: number }[];
  serverSnapshots: { elapsedMs: number; snapshot: LocalSubtitleServerSupervisorSnapshot }[];
  observedProcessIds: number[]; processChecks?: { processId: number; alive: boolean }[];
  managedRoot?: string; importedModel?: unknown; modelCopy?: Fingerprint;
  probe?: unknown; task?: unknown; transcript?: LocalSubtitleTranscript; cues?: Cue[];
  exportFiles?: { fileName: string; byteSize: number; sha256: string }[];
  document?: { id: string; schemaVersion: 2; reopenedAfterShutdown: boolean; digest: string; durability?: string };
  cleanup?: { joined: boolean; serverDisposed: boolean; noObservedProcessAlive: boolean; error?: string };
  error?: string;
};

export interface RealCpuComparisonReport {
  schemaVersion: 1; evidenceKind: 'real-production-cpu-comparison'; status: 'running' | 'passed' | 'failed';
  outputRoot: string; startedAt: string; completedAt?: string; config: typeof REAL_CPU_COMPARISON_CONFIG;
  scope: { audioSeconds: 30; vadEnabled: false; windowStrategy: 'fixed_v1'; defaultVadAcceptance: false;
    noFixtureInference: true; dependencyOverrides: readonly string[] };
  sourceBefore?: { audio: Fingerprint; model: Fingerprint };
  sourceAfter?: { audio: Fingerprint; model: Fingerprint }; sourcesUnchanged?: boolean;
  runtimes?: { legacy: unknown; studio: unknown };
  legacy: ChainEvidence; studio: ChainEvidence;
  comparison?: { equalCueTextAndTiming: boolean; legacyCueCount: number; studioCueCount: number;
    differences: { index: number; legacy: Cue | null; studio: Cue | null }[] };
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function fingerprint(file: string): Promise<Fingerprint> {
  const absolutePath = await realpath(file);
  const before = await lstat(absolutePath, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Real input must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  const after = await lstat(absolutePath, { bigint: true });
  assert.equal(after.size, before.size, 'Input changed during fingerprinting');
  assert.equal(after.mtimeNs, before.mtimeNs, 'Input changed during fingerprinting');
  assert.equal(after.dev, before.dev, 'Input identity changed during fingerprinting');
  assert.equal(after.ino, before.ino, 'Input identity changed during fingerprinting');
  assert.ok(after.size <= BigInt(Number.MAX_SAFE_INTEGER));
  return { path: absolutePath, byteSize: Number(after.size), sha256: hash.digest('hex'), mtimeNs: after.mtimeNs.toString(),
    dev: after.dev.toString(), ino: after.ino.toString() };
}

function alive(processId: number): boolean {
  try { process.kill(processId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function within<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function cues(transcript: LocalSubtitleTranscript): Cue[] {
  return transcript.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
}

function assertRealTranscript(transcript: LocalSubtitleTranscript) {
  assert.equal(transcript.source.durationMs, 30_000);
  assert.equal(transcript.model.modelId, REAL_CPU_COMPARISON_CONFIG.modelId);
  assert.equal(transcript.model.modelHash, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256);
  assert.equal(transcript.model.backend, 'cpu');
  assert.ok(transcript.segments.length > 0, 'Real speech input must produce a nonempty transcript');
}

function assertCopy(source: Fingerprint, copied: Fingerprint, managedRoot: string) {
  const relative = path.relative(managedRoot, copied.path);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Model copy escaped isolated managed root');
  assert.equal(copied.byteSize, source.byteSize);
  assert.equal(copied.sha256, source.sha256);
  assert.notEqual(copied.path.toLowerCase(), source.path.toLowerCase());
  assert.ok(copied.dev !== source.dev || copied.ino !== source.ino, 'Model import must copy rather than hard-link input');
}

async function runChain(options: {
  record: ChainEvidence; snapshot: () => LocalSubtitleServerSupervisorSnapshot | null;
  shutdown: () => Promise<void>; work: (signal: AbortSignal, phase: (name: string) => Promise<void>) => Promise<void>;
  checkpoint: () => Promise<void>;
}) {
  const { record } = options, started = Date.now(), controller = new AbortController();
  let lastSnapshot = '', shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= Promise.resolve().then(options.shutdown);
  const observe = () => {
    const snapshot = options.snapshot();
    if (!snapshot) return;
    if (snapshot.processId && !record.observedProcessIds.includes(snapshot.processId)) record.observedProcessIds.push(snapshot.processId);
    const key = JSON.stringify(snapshot);
    if (key !== lastSnapshot) { lastSnapshot = key; record.serverSnapshots.push({ elapsedMs: Date.now() - started, snapshot }); }
  };
  record.startedAt = new Date().toISOString();
  const interval = setInterval(observe, 100);
  const operation = Promise.resolve().then(() => options.work(controller.signal, async name => {
    controller.signal.throwIfAborted();
    record.phase = name; record.phases.push({ phase: name, elapsedMs: Date.now() - started });
    observe(); await options.checkpoint(); controller.signal.throwIfAborted();
  }));
  // Keep a rejection handler attached even if a deadline wins the race.
  const settled = operation.then(() => undefined, () => undefined);
  let failure: unknown;
  try { await within(operation, CHAIN_DEADLINE_MS, `${record.side} exceeded its ten-minute deadline`); }
  catch (error) { failure = error; record.error = errorText(error); controller.abort(error); }
  finally {
    controller.abort();
    try {
      await within(close(), CLEANUP_DEADLINE_MS, `${record.side} cleanup did not join`);
      await within(settled, 5000, `${record.side} work remained active after shutdown`);
      observe();
      record.processChecks = record.observedProcessIds.map(processId => ({ processId, alive: alive(processId) }));
      record.cleanup = { joined: true, serverDisposed: options.snapshot()?.state === 'disposed',
        noObservedProcessAlive: record.processChecks.every(value => !value.alive) };
      assert.ok(record.cleanup.serverDisposed && record.cleanup.noObservedProcessAlive, 'Native server cleanup is incomplete');
    } catch (error) {
      record.cleanup = { joined: false, serverDisposed: false, noObservedProcessAlive: false, error: errorText(error) };
      failure = failure ? new AggregateError([failure, error], 'Inference and cleanup failed') : error;
    }
    clearInterval(interval); record.elapsedMs = Date.now() - started;
    await options.checkpoint();
  }
  if (failure) throw failure;
  assert.ok(record.observedProcessIds.length, 'No real native server process was observed');
  assert.ok(record.serverSnapshots.some(value => value.snapshot.purpose === 'inference' && value.snapshot.activeRequest),
    'No real active inference was observed');
}

async function legacy(options: { appRoot: string; outputRoot: string; audio: Fingerprint; model: Fingerprint;
  record: ChainEvidence; checkpoint: () => Promise<void> }) {
  const managedRoot = path.join(options.outputRoot, 'legacy', 'user-data', 'local-subtitle');
  const exportRoot = path.join(options.outputRoot, 'legacy', 'exports');
  await mkdir(managedRoot, { recursive: true }); await mkdir(exportRoot, { recursive: true });
  options.record.managedRoot = managedRoot;
  const environment = { mode: 'development', appRoot: options.appRoot } as const;
  const inputs = new LocalSubtitleInputAuthorizationRegistry(), outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs), artifacts = new LocalSubtitleArtifactRegistry();
  const media = new LocalSubtitleMediaNormalizer({ environment, managedResourceRoot: managedRoot, inputAuthorizations: inputs });
  const server = new LocalSubtitleServerSupervisor({ managedResourceRoot: managedRoot, startupTimeoutMs: 120_000 });
  const registry = new LocalSubtitleSessionRegistry();
  const models = new LocalSubtitleModelManager({ managedResourceRoot: managedRoot, runtimeEnvironment: environment,
    supervisor: server, sessionRegistry: registry });
  const realExporter = new LocalSubtitleExporter(artifacts);
  const executor = new LocalSubtitleProductionExecutor({ media, supervisor: server, inputs, outputs, runtimeEnvironment: environment,
    exporter: {
      supportsConflictPolicy: policy => realExporter.supportsConflictPolicy(policy),
      exportArtifacts: async request => {
        // Observe the genuine domain transcript, then delegate the genuine write.
        options.record.transcript = structuredClone(request.transcript);
        return realExporter.exportArtifacts(request);
      },
    } });
  const jobs = new LocalSubtitleJobManager({ registry, inputs, outputs, leases, runtimeVerifier: media,
    backendResolver: new LocalSubtitleBackendResolver({ runtimeEnvironment: environment }),
    modelResolver: models, mediaSelections: media, executor, artifacts });
  const lifecycle = new LocalSubtitleSessionLifecycle(jobs, models, media, server, registry);
  await runChain({ record: options.record, snapshot: () => server.snapshot, checkpoint: options.checkpoint,
    shutdown: async () => {
      try { await lifecycle.shutdown('app_quit'); }
      finally { inputs.releaseOwner(OWNER); outputs.releaseOwner(OWNER); artifacts.releaseOwner(OWNER); }
    },
    work: async (signal, phase) => {
      await phase('initialize'); await models.initialize();
      await phase('copy-model-and-load-smoke');
      const job = models.importModel({ owner: OWNER, filePath: options.model.path, modelId: REAL_CPU_COMPARISON_CONFIG.modelId, mode: 'copy' });
      await models.waitForIdle(); signal.throwIfAborted();
      const imported = models.getSessionSnapshot(OWNER).resourceJobs.find(value => value.jobId === job.jobId);
      options.record.importedModel = imported;
      assert.equal(imported?.status, 'completed', JSON.stringify(imported));
      const model = await models.resolveManagedModel(REAL_CPU_COMPARISON_CONFIG.modelId, signal);
      options.record.modelCopy = await fingerprint(model.absolutePath); assertCopy(options.model, options.record.modelCopy, managedRoot);
      await phase('authorize-and-probe');
      const file = await inputs.authorize(OWNER, options.audio.path, ['probe', 'transcribe']);
      const probe = await media.probeDraft({ owner: OWNER, fileToken: file.fileToken, signal });
      options.record.probe = probe; assert.equal(probe.durationMs, 30_000); assert.equal(probe.audioTracks.length, 1);
      const output = await outputs.authorize(OWNER, exportRoot);
      await phase('enqueue-real-production');
      const batch = await jobs.enqueue(OWNER, { schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
        files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }],
        config: { ...REAL_CPU_COMPARISON_CONFIG, output: { mode: 'custom', formats: ['SRT'],
          conflictPolicy: 'index', outputDirToken: output.outputDirToken }, postAction: { mode: 'export_only' } } }, signal);
      await jobs.waitForIdle(); signal.throwIfAborted();
      const task = jobs.getSessionSnapshot(OWNER).batches.find(value => value.batchId === batch.batchId)?.tasks[0];
      options.record.task = task; assert.equal(task?.status, 'completed', JSON.stringify(task));
      assert.ok(options.record.transcript, 'Legacy exporter received no transcript'); assertRealTranscript(options.record.transcript);
      options.record.cues = cues(options.record.transcript);
      options.record.exportFiles = [];
      for (const fileName of await readdir(exportRoot)) {
        const result = await fingerprint(path.join(exportRoot, fileName));
        options.record.exportFiles.push({ fileName, byteSize: result.byteSize, sha256: result.sha256 });
      }
      assert.ok(options.record.exportFiles.some(file => file.fileName.endsWith('.srt')));
      await phase('completed');
    } });
}

async function studio(options: { appRoot: string; outputRoot: string; audio: Fingerprint; model: Fingerprint;
  record: ChainEvidence; checkpoint: () => Promise<void> }) {
  const userDataRoot = path.join(options.outputRoot, 'studio', 'user-data');
  const documentRoot = path.join(userDataRoot, 'subtitle-studio', 'documents');
  const repository = new DocumentRepository(documentRoot);
  const runtime = createTranscriptionRuntime({ userDataRoot,
    environment: { mode: 'development', appRoot: options.appRoot } }, { server: { startupTimeoutMs: 120_000 } }, repository);
  options.record.managedRoot = runtime.managedResourceRoot;
  await runChain({ record: options.record, snapshot: () => runtime.snapshot().server,
    checkpoint: options.checkpoint, shutdown: () => runtime.shutdown(),
    work: async (signal, phase) => {
      await phase('initialize'); await runtime.initialize();
      assert.equal((await runtime.inspectRuntime()).status, 'verified');
      await phase('copy-model-and-load-smoke');
      const job = runtime.resources.importModel({ owner: OWNER, filePath: options.model.path, modelId: REAL_CPU_COMPARISON_CONFIG.modelId });
      await runtime.resources.waitForIdle(); signal.throwIfAborted();
      const imported = runtime.resources.snapshot(OWNER).resourceJobs.find(value => value.jobId === job.jobId);
      options.record.importedModel = imported; assert.equal(imported?.status, 'completed', JSON.stringify(imported));
      const model = await runtime.resources.resolveModel(OWNER, REAL_CPU_COMPARISON_CONFIG.modelId, signal);
      options.record.modelCopy = await fingerprint(model.absolutePath); assertCopy(options.model, options.record.modelCopy, runtime.managedResourceRoot);
      await phase('authorize-and-probe');
      const file = await runtime.media.authorizeInput(OWNER, options.audio.path);
      const probe = await runtime.media.probe(OWNER, file.fileToken, signal);
      options.record.probe = probe; assert.equal(probe.durationMs, 30_000); assert.equal(probe.audioTracks.length, 1);
      await phase('enqueue-real-production');
      const batch = await runtime.tasks.enqueue(OWNER, { files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }],
        config: REAL_CPU_COMPARISON_CONFIG });
      await runtime.tasks.waitForIdle(); signal.throwIfAborted();
      const task = runtime.tasks.list(OWNER).find(value => value.batchId === batch.batchId);
      options.record.task = task; assert.equal(task?.status, 'completed', JSON.stringify(task));
      assert.equal(task?.cleanupPending, undefined); assert.ok(task?.documentId);
      const document = validateDocument(await repository.read(task.documentId));
      assert.equal(document.schemaVersion, 2); assert.ok(document.schemaVersion === 2);
      options.record.transcript = document.preservation.transcript; assertRealTranscript(document.preservation.transcript);
      options.record.cues = document.cues.map(cue => ({ startMs: cue.timing.startMs, endMs: cue.timing.endMs, text: cue.source.plain }));
      assert.deepEqual(options.record.cues, cues(document.preservation.transcript));
      options.record.document = { id: document.id, schemaVersion: 2, reopenedAfterShutdown: false,
        digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'), durability: task.documentDurability };
      await phase('completed');
    } });
  assert.ok(options.record.document);
  const reopened = validateDocument(await new DocumentRepository(documentRoot).read(options.record.document.id));
  assert.equal(reopened.schemaVersion, 2);
  assert.equal(createHash('sha256').update(JSON.stringify(reopened)).digest('hex'), options.record.document.digest);
  options.record.document.reopenedAfterShutdown = true;
  await options.checkpoint();
}

/** Explicit opt-in only. All artifacts stay under a new ignored workspace directory. */
export async function runRealCpuComparison(): Promise<RealCpuComparisonReport> {
  assert.equal(process.env.FUSIONKIT_REAL_ASR, '1', 'Real ASR requires explicit FUSIONKIT_REAL_ASR=1');
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const appRoot = await realpath(process.env.FUSIONKIT_REAL_ASR_APP_ROOT ?? REPOSITORY);
  const audioPath = path.resolve(process.env.FUSIONKIT_REAL_ASR_AUDIO ?? path.join(REPOSITORY, AUDIO_RELATIVE));
  const modelPath = path.resolve(process.env.FUSIONKIT_REAL_ASR_MODEL ?? path.join(REPOSITORY, MODEL_RELATIVE));
  const outputParent = path.join(REPOSITORY, 'test-results', 'studio-t07', 'real-cpu-comparison');
  await mkdir(outputParent, { recursive: true });
  const outputRoot = await mkdtemp(path.join(outputParent, 'run-'));
  const chain = (side: ChainEvidence['side']): ChainEvidence => ({ side, phase: 'not-started', phases: [], serverSnapshots: [], observedProcessIds: [] });
  const report: RealCpuComparisonReport = { schemaVersion: 1, evidenceKind: 'real-production-cpu-comparison', status: 'running',
    outputRoot, startedAt: new Date().toISOString(), config: REAL_CPU_COMPARISON_CONFIG,
    scope: { audioSeconds: 30, vadEnabled: false, windowStrategy: 'fixed_v1', defaultVadAcceptance: false,
      noFixtureInference: true, dependencyOverrides: ['server.startupTimeoutMs=120000', 'legacy exporter observes then delegates real export'] },
    legacy: chain('legacy'), studio: chain('studio') };
  const checkpoint = () => writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  try {
    const [audio, model] = await Promise.all([fingerprint(audioPath), fingerprint(modelPath)]);
    report.sourceBefore = { audio, model };
    assert.equal(audio.sha256, AUDIO_HASH, 'Only the recorded real A.wav sample is admitted'); assert.equal(audio.byteSize, 960078);
    assert.equal(model.sha256, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256); assert.equal(model.byteSize, 1081140203);
    const environment = { mode: 'development', appRoot } as const;
    const [legacyBundle, studioBundle] = await Promise.all([
      verifyLegacyRuntime({ environment, scope: 'all' }), verifyStudioRuntime({ environment, scope: 'all' }),
    ]);
    assert.notEqual(legacyBundle.root, studioBundle.root, 'Both sides must use their independent staged runtime namespaces');
    report.runtimes = { legacy: legacyBundle, studio: studioBundle }; await checkpoint();
    await legacy({ appRoot, outputRoot, audio, model, record: report.legacy, checkpoint });
    await studio({ appRoot, outputRoot, audio, model, record: report.studio, checkpoint });
    const previous = report.legacy.cues!, next = report.studio.cues!;
    const differences: NonNullable<RealCpuComparisonReport['comparison']>['differences'] = [];
    for (let index = 0; index < Math.max(previous.length, next.length); index++) {
      if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) differences.push({ index, legacy: previous[index] ?? null, studio: next[index] ?? null });
    }
    report.comparison = { equalCueTextAndTiming: differences.length === 0, legacyCueCount: previous.length, studioCueCount: next.length, differences };
    assert.equal(differences.length, 0, 'Real CPU transcript differs; inspect the bounded comparison evidence');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = errorText(error); }
  finally {
    if (report.sourceBefore) {
      try {
        report.sourceAfter = { audio: await fingerprint(audioPath), model: await fingerprint(modelPath) };
        report.sourcesUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
        assert.ok(report.sourcesUnchanged, 'Readonly source input or model changed');
      } catch (error) { report.status = 'failed'; report.error = [report.error, errorText(error)].filter(Boolean).join('; '); }
    }
    report.completedAt = new Date().toISOString(); await checkpoint();
  }
  return report;
}
