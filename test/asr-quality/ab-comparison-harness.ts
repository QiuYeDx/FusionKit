// Explicit maintenance evidence only (FUSIONKIT_ASR_AB=1). Product code and ordinary regression tests never import this.
// Each sample × variant is one real Studio transcription task: the production runtime, task service and
// TranscriptionExecutor, the bundled FFmpeg and whisper-server, and the installed model, VAD and CUDA pack.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { LocalSubtitleMediaNormalizer as StudioMedia } from '../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { LocalSubtitleServerSupervisor as StudioServer } from '../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor } from '../../electron/main/subtitle-studio/transcription/native/backend-attestor';
import { createLocalSubtitleServerInferenceFields } from '../../electron/main/subtitle-studio/transcription/native/server-contract';
import { verifyLocalSubtitleRuntimeBundle } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY } from '../../electron/main/subtitle-studio/transcription/native/accelerator-manager';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { SPEECH_CUDA_RESOURCE_ID, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../electron/main/speech-resources/catalog';
import type { SpeechResourceService } from '../../electron/main/speech-resources/service';
import { validateDocument } from '../../src/subtitle-studio/domain';
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from '../../src/subtitle-studio/transcription/preferences-contract';
import { transcriptionTaskConfigSchema, type EnqueueTranscriptionRequest } from '../../src/subtitle-studio/transcription/task-contract';
import { ASR_AB_BUDGET, ASR_AB_SAMPLES, type AsrAbSampleDefinition, type AsrAbSelection, type AsrAbVariant } from './ab-config';
import { cueChars, formatSrt, renderDiff, renderListening, renderSummary, summarizeRequestFields,
  type AsrAbCase, type AsrAbReport, type AsrAbRequest, type AsrAbSample } from './ab-report';

export const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REVIEW_ROOT = path.join(REPOSITORY, 'test-results', 'subtitle-quality-review');
export type Fingerprint = { path: string; byteSize: number; sha256: string; mtimeNs: string; dev: string; ino: string };
export type Identity = Omit<Fingerprint, 'sha256'>;
export type ResourceFile = Fingerprint & { id: string };
type Sample = AsrAbSample & { definition: AsrAbSampleDefinition; file?: Fingerprint };
type Resources = { root: string; model: ResourceFile; vad: ResourceFile; source: string; watched: Identity[] };
/** Everything a case observed; the shared report columns plus the evidence behind them. */
export interface AsrAbCaseEvidence extends AsrAbCase {
  schemaVersion: 1; sample: { id: string; language: string; path?: string; byteSize?: number; sha256?: string; durationMs?: number };
  config: EnqueueTranscriptionRequest['config']; profileAccepted: boolean; probeMs?: number;
  task?: unknown; document?: { id: string; cues: number }; transcriptModel?: unknown;
  requestSummary: ReturnType<typeof summarizeRequestFields>; processIds: number[]; serverLoads: string[];
  backendProofs: { processId: number; backend: string; acceleratorPackGeneration?: string }[]; observerErrors: string[];
  cleanup?: { joined: boolean; processesExited: boolean; workRemoved: boolean; error?: string };
}
export interface AsrAbRunResult {
  report: Omit<AsrAbReport, 'cases'> & { cases: AsrAbCaseEvidence[] }; outputRoot: string; failures: string[];
  sourcesUnchanged?: boolean; workRemoved?: boolean;
}

export const message = (error: unknown) => {
  const value = error as { name?: string; message?: string; localSubtitleCode?: string; code?: string } | null;
  const code = value?.localSubtitleCode ?? value?.code;
  return `${value?.name ?? 'Error'}${typeof code === 'string' ? ` [${code}]` : ''}: ${value?.message ?? String(error)}`;
};
const object = (value: unknown) => (value ?? {}) as Record<string, unknown>;
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
export function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })])
    .finally(() => clearTimeout(timer));
}
export async function identity(file: string): Promise<Identity> {
  const stat = await lstat(file, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${file} is not a regular file`);
  return { path: file, byteSize: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), dev: stat.dev.toString(), ino: stat.ino.toString() };
}
export const sameIdentity = (a: Identity, b: Identity) => a.byteSize === b.byteSize && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;
export async function fingerprint(file: string): Promise<Fingerprint> {
  const before = await identity(file), hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.ok(sameIdentity(before, await identity(file)), `${file} changed while hashing`);
  return { ...before, sha256: hash.digest('hex') };
}
export async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

/** Copied from the T08 harness: the original sync return, including a ticket/result pair, is never replaced. */
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

/** Request fields exactly as the HTTP client sends them, timings, and what each window returned. */
function observeCase(record: AsrAbCaseEvidence) {
  const pending = new Set<Promise<void>>(), restores: (() => void)[] = [];
  const conditioning = new WeakMap<object, string>(), windows = new Map<string, NonNullable<AsrAbRequest['window']>>();
  const separatorLeases = new WeakSet<object>();
  const onError = (error: unknown) => { record.observerErrors.push(message(error)); };
  const observe = (target: object, method: string, begin: Parameters<typeof observeRealMethod>[0]['begin'], selectPromise?: (result: unknown) => unknown) =>
    restores.push(observeRealMethod({ target, method, begin, selectPromise, pending, onError }));
  const timed = (add: (ms: number) => void) => () => { const started = Date.now(); return { resolved: () => add(Date.now() - started) }; };
  try {
    observe(StudioMedia.prototype, 'normalizeTask', timed(ms => { record.timings.normalizeMs = ms; }));
    observe(StudioMedia.prototype, 'materializeWindow', args => ({ resolved: brand => {
      const input = object(args[0]);
      conditioning.set(brand as object, typeof input.quietAudioMode === 'string' ? input.quietAudioMode : input.conditionQuietAudio === true ? 'whole_window' : 'off');
    } }));
    observe(StudioMedia.prototype, 'resolveWindow', args => ({ resolved: value => {
      const brand = object(args[0]), descriptor = object(brand.descriptor), resolved = object(value);
      windows.set(String(resolved.filePath), { startMs: Number(descriptor.startMs), endMs: Number(descriptor.endMs),
        ...(typeof resolved.quietAudioGainDb === 'number' ? { quietAudioGainDb: resolved.quietAudioGainDb } : {}),
        ...(conditioning.has(args[0] as object) ? { conditioning: conditioning.get(args[0] as object)! } : {}) });
    } }));
    // The batch pin starts the process; a task or separator lease may start another one.
    const addLoad = (ms: number) => { record.timings.loadMs = (record.timings.loadMs ?? 0) + ms; };
    observe(StudioServer.prototype, 'acquireBatchRuntimePin', timed(addLoad));
    observe(StudioServer.prototype, 'acquirePinnedTaskLease', timed(addLoad));
    observe(StudioServer.prototype, 'acquirePinnedSeparatorLease', () => {
      const started = Date.now();
      return { resolved: lease => { separatorLeases.add(lease as object); addLoad(Date.now() - started); } };
    });
    observe(StudioServer.prototype, 'beginInference', args => {
      const { filePath, signal: _signal, ...request } = object(args[1]), started = Date.now();
      let fields: Record<string, string> = {}, fieldError: string | undefined;
      try { fields = { ...createLocalSubtitleServerInferenceFields(request as never) }; } catch (error) { fieldError = message(error); }
      // As in the T08 harness: separator leases are DTW candidates; a raised temperature is the one quality replay.
      const entry: AsrAbRequest = { ordinal: record.requests.length + 1, fields,
        kind: separatorLeases.has(args[0] as object) ? 'separator' : request.temperature === 0 ? 'primary' : 'quality_recovery',
        ...(windows.has(String(filePath)) ? { window: windows.get(String(filePath))! } : {}), ...(fieldError ? { error: fieldError } : {}) };
      record.requests.push(entry);
      return { resolved: value => {
        const result = object(object(object(value).response).result);
        record.timings.inferenceMs = (record.timings.inferenceMs ?? 0) + (entry.elapsedMs = Date.now() - started);
        Object.assign(entry, { language: String(result.language), segments: Array.isArray(result.segments) ? result.segments.length : 0,
          textChars: cueChars(String(result.text ?? '')) });
      }, rejected: error => { entry.elapsedMs = Date.now() - started; entry.error = message(error); } };
    }, result => object(result).result);
  } catch (error) { for (const restore of restores.reverse()) restore(); throw error; }
  return { async close() {
    try { await within((async () => { while (pending.size) await Promise.all([...pending]); })(), ASR_AB_BUDGET.cleanupMs, 'A/B observers did not settle'); }
    finally { for (const restore of restores.reverse()) { try { restore(); } catch (error) { onError(error); } } }
  } };
}

export async function checkedResource(file: string, expected: { id: string; byteSize: number; sha256: string }, label: string): Promise<ResourceFile> {
  let value: Fingerprint;
  try { value = await fingerprint(file); }
  catch (error) { throw new Error(`The installed ${label} ${expected.id} is missing or unreadable at ${file}: ${message(error)}`); }
  assert.equal(value.byteSize, expected.byteSize, `${label} ${expected.id} size differs from the catalog`);
  assert.equal(value.sha256, expected.sha256, `${label} ${expected.id} hash differs from the catalog`);
  return { ...value, id: expected.id };
}

/** Installed files are only read. A downloaded model gets a private root, since the server loads from one root. */
async function prepareResources(selection: AsrAbSelection, workRoot: string): Promise<Resources> {
  const installed = (...parts: string[]) => path.join(selection.resourceRoot, ...parts);
  const vadEntry = SPEECH_VAD_MANIFEST.vad, catalogModel = SPEECH_MODEL_MANIFEST.models.find(model => model.id === selection.modelId);
  const vad = await checkedResource(installed('vad', vadEntry.id, vadEntry.fileName), vadEntry, 'VAD');
  const pack = selection.device === 'cuda' ? await files(installed(LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID))
    .catch(error => { throw new Error(`The installed CUDA pack is missing under ${selection.resourceRoot}: ${message(error)}`); }) : [];
  const packIdentities = await Promise.all(pack.map(identity));
  if (!selection.modelPath) {
    assert.ok(catalogModel, `${selection.modelId} is not an installable catalog model; set FUSIONKIT_ASR_AB_MODEL_PATH for a downloaded file`);
    const model = await checkedResource(installed('models', catalogModel.id, catalogModel.fileName), catalogModel, 'model');
    return { root: selection.resourceRoot, model, vad, source: `已安装（只读，${selection.resourceRoot}）`, watched: [model, vad, ...packIdentities] };
  }
  const source = await fingerprint(selection.modelPath);
  if (catalogModel) assert.equal(source.sha256, catalogModel.sha256, `${selection.modelPath} is not the catalog's ${catalogModel.id}`);
  const root = path.join(workRoot, 'resources'), copyInto = async (from: Fingerprint, ...parts: string[]) => {
    const target = path.join(root, ...parts); await mkdir(path.dirname(target), { recursive: true }); await copyFile(from.path, target);
    const copy = await fingerprint(target); assert.equal(copy.sha256, from.sha256, `${target} differs from its source`); return copy;
  };
  const model = { ...await copyInto(source, 'models', selection.modelId, path.basename(selection.modelPath)), id: selection.modelId };
  const vadCopy = { ...await copyInto(vad, 'vad', vadEntry.id, vadEntry.fileName), id: vadEntry.id };
  if (pack.length) {
    const { acceleratorDirectoryName, stagingDirectoryName, downloadsDirectoryName } = LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY;
    await cp(installed(acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID), path.join(root, acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID), { recursive: true, errorOnExist: true });
    for (const leaf of [stagingDirectoryName, downloadsDirectoryName]) await mkdir(path.join(root, leaf), { recursive: true });
  }
  return { root, model, vad: vadCopy, source: `下载文件 ${selection.modelPath}（复制到临时资源目录）`, watched: [source, vad, ...packIdentities] };
}

/** The app's shared resource service reduced to lookups of fixed files: nothing is installed, imported or deleted. */
export function readOnlySpeechResources(resources: { root: string; models: readonly ResourceFile[]; vad: ResourceFile }): SpeechResourceService {
  const refused = (): never => { throw new Error('The A/B comparison never changes speech resources.'); };
  const resolve = (expected: readonly ResourceFile[]) => async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const file = expected.find(value => value.id === id);
    assert.ok(file, `Unexpected resource ${id}`);
    assert.ok(sameIdentity(file, await identity(file.path)), `${file.path} changed during the comparison`);
    return Object.freeze({ storage: 'managed' as const, id, absolutePath: file.path, byteSize: file.byteSize, sha256: file.sha256 });
  };
  const use = Object.freeze({ release() {} });
  const client = Object.freeze({
    initialize: async () => undefined, listManagedResources: async () => Object.freeze([]), importModel: refused, startResourceInstall: refused,
    cancelResourceJob: () => Object.freeze({ cancelled: false }), deleteManagedResource: async () => refused(), getSessionSnapshot: refused,
    onResourceEvent: () => () => undefined, resolveManagedModel: resolve(resources.models), resolveManagedVad: resolve([resources.vad]),
    withResourceRead: <T>(_id: string, callback: () => Promise<T>) => callback(), reserveUse: () => use,
    status: () => Object.freeze({ revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false }),
    releaseOwner: () => undefined, waitForIdle: async () => undefined, shutdown: async () => undefined,
  });
  return Object.freeze({ managedResourceRoot: resources.root, initialize: async () => undefined, reserveUse: () => use,
    createClient: () => client }) as unknown as SpeechResourceService;
}

async function resolveSample(definition: AsrAbSampleDefinition, selection: AsrAbSelection): Promise<Sample> {
  const base = { id: definition.id, language: definition.language, description: definition.description, definition };
  let file: string;
  if (definition.kind === 'review') file = path.join(REVIEW_ROOT, definition.relativePath);
  else {
    const names = await readdir(selection.externalRoot).catch(() => undefined);
    if (!names) return { ...base, status: 'missing', reason: `${selection.externalRoot} 不存在或不可读` };
    const matches = names.filter(definition.matches);
    if (matches.length !== 1) return { ...base, status: 'missing', reason: `${selection.externalRoot} 中匹配到 ${matches.length} 个文件` };
    file = path.join(selection.externalRoot, matches[0]!);
  }
  const value = await fingerprint(file).catch(() => undefined);
  if (!value) return { ...base, status: 'missing', path: file, reason: `${file} 不存在或不可读` };
  if (definition.kind === 'review' && (value.byteSize !== definition.byteSize || value.sha256 !== definition.sha256))
    return { ...base, status: 'changed', path: file, file: value, reason: '字节与固定哈希不一致' };
  return { ...base, status: 'present', path: file, file: value };
}

function taskConfig(sample: Sample, variant: AsrAbVariant, selection: AsrAbSelection): EnqueueTranscriptionRequest['config'] {
  const { advanced, ...defaults } = DEFAULT_STUDIO_TRANSCRIPTION_CONFIG;
  // The app's defaults with a fixed model, device and language; a variant only adds its audio type.
  return { ...defaults, modelId: selection.modelId, devicePreference: selection.device, language: sample.language,
    advanced: { ...advanced, ...(variant === 'standard' ? {} : { audioProfile: variant }) } } as unknown as EnqueueTranscriptionRequest['config'];
}

async function runCase(options: { sample: Sample; variant: AsrAbVariant; selection: AsrAbSelection; service: SpeechResourceService;
  workRoot: string; ordinal: number; environment: { mode: 'development'; appRoot: string } }): Promise<AsrAbCaseEvidence> {
  const { sample, variant } = options, config = taskConfig(sample, variant, options.selection);
  const profileAccepted = transcriptionTaskConfigSchema.safeParse(config).success;
  const record: AsrAbCaseEvidence = { schemaVersion: 1, sampleId: sample.id, variant, status: 'failed', cues: [], requests: [], timings: {},
    sample: { id: sample.id, language: sample.language, path: sample.path, byteSize: sample.file?.byteSize, sha256: sample.file?.sha256 },
    config, profileAccepted, requestSummary: {}, processIds: [], serverLoads: [], backendProofs: [], observerErrors: [] };
  if (!profileAccepted) {
    record.status = variant === 'standard' ? 'failed' : 'not_implemented';
    record.error = variant === 'standard' ? 'The standard task configuration was rejected.' : '任务配置不接受 advanced.audioProfile'; return record;
  }
  const caseRoot = await mkdtemp(path.join(options.workRoot, 'c-')), repository = new DocumentRepository(path.join(caseRoot, 'documents'));
  const attestor = createLocalSubtitleProductionBackendAttestor();
  const runtime = createTranscriptionRuntime({ userDataRoot: path.join(caseRoot, 'user'), environment: options.environment }, {
    sharedResources: options.service, server: { startupTimeoutMs: ASR_AB_BUDGET.startupMs, dependencies: { verifyBackend: context => {
      const operation = attestor.verifyBackend(context);
      void operation.then(proof => record.backendProofs.push({ processId: proof.processId, backend: proof.backend,
        ...(proof.acceleratorPackGeneration ? { acceleratorPackGeneration: proof.acceleratorPackGeneration } : {}) }), () => undefined);
      return operation;
    } } } }, repository);
  const owner = { webContentsId: 912, ownerSessionId: `asr-ab-${options.ordinal}` };
  const sampleServer = () => {
    const snapshot = runtime.snapshot().server; if (!snapshot) return;
    if (snapshot.processId && !record.processIds.includes(snapshot.processId)) record.processIds.push(snapshot.processId);
    const load = snapshot.purpose ? `${snapshot.purpose}/${snapshot.backend}/${snapshot.modelId}` : undefined;
    if (load && !record.serverLoads.includes(load)) record.serverLoads.push(load);
  };
  const observer = observeCase(record), sampling = setInterval(sampleServer, 100);
  console.log(`[ASR A/B] ${sample.id} / ${variant}: start`);
  let failure: string | undefined;
  const work = (async () => {
    await runtime.initialize();
    const probeStarted = Date.now(), file = await runtime.media.authorizeInput(owner, sample.path!);
    const probe = await runtime.media.probe(owner, file.fileToken);
    record.probeMs = Date.now() - probeStarted; sample.durationMs ??= probe.durationMs; record.sample.durationMs = probe.durationMs;
    const started = Date.now();
    const admission = await runtime.tasks.enqueue(owner, { files: [{ fileToken: file.fileToken, audioStreamId: probe.autoSelectedStreamId }], config });
    await runtime.tasks.waitForIdle(); record.timings.totalMs = Date.now() - started;
    const task = runtime.tasks.list(owner).find(value => value.batchId === admission.batchId);
    record.task = task; record.status = task?.status === 'completed' || task?.status === 'no_content' || task?.status === 'cancelled' ? task.status : 'failed';
    if (task?.error || !task) record.error = task?.error?.code ?? 'The task summary is missing.';
    if (task?.status === 'completed') {
      assert.ok(task.documentId, 'A completed task has no document');
      const document = validateDocument(await repository.read(task.documentId)); assert.ok(document.schemaVersion === 2);
      const transcript = document.preservation.transcript;
      assert.equal(document.cues.length, transcript.segments.length, 'A fresh document must keep one cue per transcript segment');
      record.cues = transcript.segments.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text,
        ...(typeof segment.confidence === 'number' ? { confidence: segment.confidence } : {}) }));
      record.document = { id: document.id, cues: document.cues.length }; record.transcriptModel = transcript.model;
      assert.equal(transcript.model.backend, options.selection.device, 'The task did not run on the requested backend');
    }
  })();
  try { await within(work, ASR_AB_BUDGET.caseMs, `${sample.id} / ${variant} exceeded ${ASR_AB_BUDGET.caseMs / 60_000} minutes`); }
  catch (error) { failure = message(error); }
  finally {
    const cleanup: NonNullable<AsrAbCaseEvidence['cleanup']> = { joined: false, processesExited: false, workRemoved: false };
    try {
      await within(runtime.shutdown('app_quit'), ASR_AB_BUDGET.cleanupMs, `${sample.id} / ${variant} shutdown did not join`);
      // Work cut off by the deadline settles once shutdown aborts it; it may not overwrite the verdict.
      await within(work.then(() => undefined, () => undefined), 5000, `${sample.id} / ${variant} work did not settle after shutdown`);
      cleanup.joined = true; sampleServer();
    } catch (error) { cleanup.error = message(error); }
    if (failure) { record.status = 'failed'; record.error = failure; }
    clearInterval(sampling);
    try { await observer.close(); } catch (error) { record.observerErrors.push(message(error)); }
    cleanup.processesExited = record.processIds.every(pid => !alive(pid));
    if (cleanup.joined && cleanup.processesExited) {
      try { await rm(caseRoot, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 }); cleanup.workRemoved = true; }
      catch (error) { cleanup.error = message(error); }
    }
    record.cleanup = cleanup; record.requestSummary = summarizeRequestFields(record.requests);
    record.profileApplied = record.requests.some(request => request.kind !== 'separator' && 'vad_threshold' in request.fields);
    if (record.observerErrors.length && record.status !== 'failed') { record.status = 'failed'; record.error ??= record.observerErrors[0]; }
    console.log(`[ASR A/B] ${sample.id} / ${variant}: ${record.status}${record.error ? ` (${record.error})` : ''}, ${record.cues.length} cues, ${record.requests.length} requests`);
  }
  return record;
}

const execFileAsync = promisify(execFile);
export async function gpuDescription() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], { timeout: 10_000, windowsHide: true });
    return stdout.trim().split(/\r?\n/u).join('; ');
  } catch { return '未知（nvidia-smi 不可用）'; }
}

/** Runs every selected sample × variant once, each in a fresh runtime and server process, writing text reports only. */
export async function runAsrAbComparison(selection: AsrAbSelection, outputRoot: string): Promise<AsrAbRunResult> {
  assert.equal(process.env.FUSIONKIT_ASR_AB, '1', 'Requires explicit FUSIONKIT_ASR_AB=1');
  const appRoot = await realpath(REPOSITORY), environment = { mode: 'development', appRoot } as const;
  const report: AsrAbRunResult['report'] = { runId: path.basename(outputRoot), startedAt: new Date().toISOString(),
    model: { id: selection.modelId, source: '' }, device: selection.device, environment: [], samples: [], variants: selection.variants, cases: [] };
  const result: AsrAbRunResult = { report, outputRoot, failures: [] };
  const write = async (name: string, text: string) => {
    const target = path.join(outputRoot, name), pending = `${target}.pending`;
    await writeFile(pending, text, 'utf8'); await rename(pending, target);
  };
  const checkpoint = async () => {
    await write('summary.md', renderSummary(report)); await write('diff.md', renderDiff(report)); await write('listening.md', renderListening(report));
    await write('report.json', `${JSON.stringify({ ...result, report: { ...report, cases: report.cases.map(({ requests: _requests, ...value }) => value) } }, null, 2)}\n`);
  };
  const workRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'asrab-'));
  let samples: Sample[] = [], resources: Resources | undefined;
  try {
    const runtime = await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'all' });
    samples = await Promise.all(selection.sampleIds.map(id => resolveSample(ASR_AB_SAMPLES.find(sample => sample.id === id)!, selection)));
    report.samples = samples;
    resources = await within(prepareResources(selection, workRoot), ASR_AB_BUDGET.resourcesMs, 'A/B resource checks exceeded ten minutes');
    report.model = { id: resources.model.id, sha256: resources.model.sha256, source: resources.source };
    report.environment = [`主机：${os.type()} ${os.release()}，Node ${process.version}`, `GPU：${await gpuDescription()}`,
      `运行时：${path.relative(appRoot, runtime.root) || runtime.root}（${runtime.runtimeGeneration.slice(0, 12)}…）`,
      '任务配置：Studio 默认（VAD 开、按停顿切窗、束宽 5、温度 0、最短静音 500 ms），语言按样本固定；每个样本 × 变体一个新的运行时与服务进程'];
    for (const sample of samples.filter(value => value.status === 'changed')) result.failures.push(`${sample.id}: ${sample.reason}`);
    await checkpoint();
    const service = readOnlySpeechResources({ ...resources, models: [resources.model] });
    let ordinal = 0;
    for (const sample of samples.filter(value => value.status === 'present')) for (const variant of selection.variants) {
      const record = await runCase({ sample, variant, selection, service, workRoot, ordinal: ++ordinal, environment });
      report.cases.push(record);
      const base = `${sample.id}.${variant}`;
      await write(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
      if (record.status === 'completed' || record.status === 'no_content') await write(`${base}.srt`, formatSrt(record.cues));
      if (record.status === 'failed' || record.status === 'cancelled') result.failures.push(`${base}: ${record.error ?? record.status}`);
      await checkpoint();
      if (record.cleanup && !(record.cleanup.joined && record.cleanup.processesExited))
        throw new Error(`${base} did not shut down its server; the remaining cases were not started`);
    }
  } catch (error) { result.failures.push(message(error)); }
  finally {
    try {
      const changed: string[] = [];
      for (const sample of samples) if (sample.file && (await fingerprint(sample.file.path)).sha256 !== sample.file.sha256) changed.push(sample.file.path);
      for (const file of resources?.watched ?? []) if (!sameIdentity(file, await identity(file.path).catch(() => ({ ...file, ino: 'missing' })))) changed.push(file.path);
      result.sourcesUnchanged = changed.length === 0;
      if (changed.length) result.failures.push(`Read-only inputs changed: ${changed.join(', ')}`);
    } catch (error) { result.sourcesUnchanged = false; result.failures.push(message(error)); }
    const joined = report.cases.every(value => !value.cleanup || (value.cleanup.joined && value.cleanup.processesExited));
    if (joined) {
      try { await rm(workRoot, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 }); result.workRemoved = true; }
      catch (error) { result.workRemoved = false; result.failures.push(`Work directory cleanup failed: ${message(error)}`); }
    } else { result.workRemoved = false; result.failures.push(`A server did not stop; ${workRoot} was kept`); }
    report.completedAt = new Date().toISOString(); await checkpoint();
    console.log(`[ASR A/B] ${result.failures.length ? 'failed' : 'completed'}: ${outputRoot}`);
  }
  return result;
}
