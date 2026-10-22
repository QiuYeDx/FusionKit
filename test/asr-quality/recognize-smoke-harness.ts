// Explicit maintenance evidence only (FUSIONKIT_ASR_AB=1). Product code and ordinary regression tests never import this.
// The recognize-only models hear existing cues again the way the Studio dialog has them heard: recognizeCue with the
// document repository, the cue's media and the bundled FFmpeg, then the production runtime's recognize.clip and
// whisper-server, with the downloaded models in a private copy of the resources. The cues are a standard large-v3
// transcription from an A/B comparison run.
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTranscriptionRuntime, type RecognizeClipRequest, type RecognizedClip } from '../../electron/main/subtitle-studio/transcription/runtime';
import { LocalSubtitleServerSupervisor as StudioServer } from '../../electron/main/subtitle-studio/transcription/native/server-supervisor';
import { createLocalSubtitleProductionBackendAttestor } from '../../electron/main/subtitle-studio/transcription/native/backend-attestor';
import { createLocalSubtitleServerInferenceFields } from '../../electron/main/subtitle-studio/transcription/native/server-contract';
import { verifyLocalSubtitleRuntimeBundle } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY } from '../../electron/main/subtitle-studio/transcription/native/accelerator-manager';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { CueMediaService } from '../../electron/main/subtitle-studio/cue-media-service';
import { CueAudioClipper } from '../../electron/main/subtitle-studio/cue-audio-clip';
import { recognizeCue } from '../../electron/main/subtitle-studio/cue-recognize-service';
import { SPEECH_CUDA_RESOURCE_ID, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../electron/main/speech-resources/catalog';
import { cueRecognizeRequestSchemas } from '../../src/subtitle-studio/cue-recognize-contract';
import { transcriptionModelProfile } from '../../src/subtitle-studio/transcription-model-profiles';
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from '../../src/subtitle-studio/transcription/preferences-contract';
import { ASR_AB_BUDGET, parseAsrAbSelection } from './ab-config';
import { REPOSITORY, alive, checkedResource, files, fingerprint, gpuDescription, identity, message, observeRealMethod,
  readOnlySpeechResources, sameIdentity, within, type Fingerprint, type Identity, type ResourceFile } from './ab-comparison-harness';
import { oddLead, renderRecognizeReport, type AsrRecognizeCue, type AsrRecognizeHeard, type AsrRecognizeModelRun,
  type AsrRecognizeReport, type AsrRecognizeRequest, type AsrRecognizeSample } from './recognize-report';

/** Which model hears which samples' cues; Belle only those that start in the first minute of the PV. */
export const ASR_RECOGNIZE_SMOKE: readonly { modelId: string; sampleIds: readonly string[]; startsBeforeMs?: number }[] = Object.freeze([
  { modelId: 'anime-whisper-q8_0', sampleIds: ['A', 'B', 'C'] },
  { modelId: 'belle-large-v3-turbo-zh', sampleIds: ['pv-zh'], startsBeforeMs: 60_000 },
]);

export interface AsrRecognizeSelection { resourceRoot: string; modelsRoot: string; cuesRun: string }
type Environment = Readonly<Record<string, string | undefined>>;
/** The installed VAD and CUDA pack as for the A/B comparison; the downloaded models and the cues' run by default where T-ASRQ-09 left them. */
export function parseAsrRecognizeSelection(environment: Environment = process.env): AsrRecognizeSelection {
  return { resourceRoot: parseAsrAbSelection(environment).resourceRoot,
    modelsRoot: path.resolve(environment.FUSIONKIT_ASR_AB_MODELS_ROOT || 'D:/fusionkit-asr-eval/models'),
    cuesRun: path.resolve(environment.FUSIONKIT_ASR_AB_CUES_RUN || path.join(REPOSITORY, 'test-results', 'asr-quality-ab', 'run-2512BY')) };
}
export interface AsrRecognizeRunResult { report: AsrRecognizeReport; outputRoot: string; failures: string[]; sourcesUnchanged?: boolean; workRemoved?: boolean }

type CueSource = AsrRecognizeSample & { file: Fingerprint; model: object; lines: { startMs: number; endMs: number; text: string; confidence?: number }[] };
type Resources = { root: string; models: ResourceFile[]; vad: ResourceFile; watched: Identity[] };
const object = (value: unknown) => (value ?? {}) as Record<string, unknown>;

/** A sample's standard transcription from the A/B run, checked against the file it was made from. */
async function cueSource(cuesRun: string, sampleId: string): Promise<CueSource> {
  const evidence = JSON.parse(await readFile(path.join(cuesRun, `${sampleId}.standard.json`), 'utf8')) as {
    status: string; sample: { language: string; path: string; sha256: string; durationMs: number };
    transcriptModel: object; cues: CueSource['lines'] };
  assert.equal(evidence.status, 'completed', `${sampleId} has no standard transcription in ${cuesRun}`);
  const file = await fingerprint(evidence.sample.path);
  assert.equal(file.sha256, evidence.sample.sha256, `${evidence.sample.path} is not the file ${cuesRun} transcribed`);
  return { id: sampleId, language: evidence.sample.language, path: evidence.sample.path, sha256: file.sha256, durationMs: evidence.sample.durationMs,
    cues: evidence.cues.length, file, model: evidence.transcriptModel, lines: evidence.cues };
}

/** The downloaded models, the installed VAD and the CUDA pack in one private root, since the server loads from one root. */
async function prepareResources(selection: AsrRecognizeSelection, workRoot: string): Promise<Resources> {
  const installed = (...parts: string[]) => path.join(selection.resourceRoot, ...parts), root = path.join(workRoot, 'resources');
  const vadEntry = SPEECH_VAD_MANIFEST.vad, vad = await checkedResource(installed('vad', vadEntry.id, vadEntry.fileName), vadEntry, 'VAD');
  const pack = await files(installed(LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID))
    .catch(error => { throw new Error(`The installed CUDA pack is missing under ${selection.resourceRoot}: ${message(error)}`); });
  const copyInto = async (from: Fingerprint, ...parts: string[]) => {
    const target = path.join(root, ...parts); await mkdir(path.dirname(target), { recursive: true }); await copyFile(from.path, target);
    const copy = await fingerprint(target); assert.equal(copy.sha256, from.sha256, `${target} differs from its source`); return copy;
  };
  const models: ResourceFile[] = [], sources: Identity[] = [];
  for (const { modelId } of ASR_RECOGNIZE_SMOKE) {
    const entry = SPEECH_MODEL_MANIFEST.models.find(model => model.id === modelId);
    assert.ok(entry, `${modelId} is not a catalog model`);
    const source = await checkedResource(path.join(selection.modelsRoot, entry.fileName), entry, 'model');
    sources.push(source); models.push({ ...await copyInto(source, 'models', entry.id, entry.fileName), id: entry.id });
  }
  const { acceleratorDirectoryName, stagingDirectoryName, downloadsDirectoryName } = LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY;
  await cp(installed(acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID), path.join(root, acceleratorDirectoryName, SPEECH_CUDA_RESOURCE_ID), { recursive: true, errorOnExist: true });
  for (const leaf of [stagingDirectoryName, downloadsDirectoryName]) await mkdir(path.join(root, leaf), { recursive: true });
  return { root, models, vad: { ...await copyInto(vad, 'vad', vadEntry.id, vadEntry.fileName), id: vadEntry.id },
    watched: [...sources, vad, ...await Promise.all(pack.map(identity))] };
}

const heardOf = (clip: RecognizedClip): AsrRecognizeHeard => ({ text: clip.text, language: clip.language, segments: clip.segments.map(segment =>
  ({ startMs: segment.startMs, endMs: segment.endMs, averageLogProbability: segment.averageLogProbability, noSpeechProbability: segment.noSpeechProbability })) });

/** One model in a fresh runtime and server: every selected cue as the dialog has it heard, then each clip again with timestamps. */
async function runModel(options: { smoke: typeof ASR_RECOGNIZE_SMOKE[number]; model: ResourceFile; sources: ReadonlyMap<string, CueSource>;
  service: ReturnType<typeof readOnlySpeechResources>; workRoot: string; outputRoot: string; environment: { mode: 'development'; appRoot: string } }) {
  const { smoke, model, environment } = options, devicePreference = DEFAULT_STUDIO_TRANSCRIPTION_CONFIG.devicePreference;
  const run: AsrRecognizeModelRun = { modelId: model.id, sha256: model.sha256, sampleIds: [...smoke.sampleIds], devicePreference,
    processIds: [], serverLoads: [], backendProofs: [], cues: [], observerErrors: [] };
  assert.equal(transcriptionModelProfile(model.id).role, 'recognize', `${model.id} is not a recognize-only model`);
  const caseRoot = await mkdtemp(path.join(options.workRoot, 'r-')), repository = new DocumentRepository(path.join(caseRoot, 'documents'));
  const workingDirectory = path.join(caseRoot, 'cue-audio'), clips = path.join(options.outputRoot, 'clips');
  await mkdir(workingDirectory, { recursive: true }); await mkdir(clips, { recursive: true });
  const media = new CueMediaService(repository), clipper = new CueAudioClipper({ environment, workingDirectory });
  const attestor = createLocalSubtitleProductionBackendAttestor();
  const runtime = createTranscriptionRuntime({ userDataRoot: path.join(caseRoot, 'user'), environment }, {
    sharedResources: options.service, server: { startupTimeoutMs: ASR_AB_BUDGET.startupMs, dependencies: { verifyBackend: context => {
      const operation = attestor.verifyBackend(context);
      void operation.then(proof => run.backendProofs.push({ processId: proof.processId, backend: proof.backend,
        ...(proof.acceleratorPackGeneration ? { acceleratorPackGeneration: proof.acceleratorPackGeneration } : {}) }), () => undefined);
      return operation;
    } } } }, repository);
  const owner = { webContentsId: 913, ownerSessionId: `asr-recognize-${model.id}` };
  const sampleServer = () => {
    const snapshot = runtime.snapshot().server; if (!snapshot) return;
    if (snapshot.processId && !run.processIds.includes(snapshot.processId)) run.processIds.push(snapshot.processId);
    const load = snapshot.purpose ? `${snapshot.purpose}/${snapshot.backend}/${snapshot.modelId}` : undefined;
    if (load && !run.serverLoads.includes(load)) run.serverLoads.push(load);
  };
  // The request being made: the server's load time and multipart fields belong to it.
  let current: AsrRecognizeRequest | undefined;
  const pending = new Set<Promise<void>>(), onError = (error: unknown) => { run.observerErrors.push(message(error)); };
  const restores = [
    observeRealMethod({ target: StudioServer.prototype, method: 'acquire', pending, onError, begin: () => {
      const started = Date.now(), request = current; return { resolved: () => { if (request) request.loadMs = Date.now() - started; } };
    } }),
    observeRealMethod({ target: StudioServer.prototype, method: 'beginInference', pending, onError, begin: args => {
      const { filePath: _file, signal: _signal, ...request } = object(args[1]);
      if (current) current.fields = { ...createLocalSubtitleServerInferenceFields(request as never) };
      return {};
    } }),
  ];
  const sampling = setInterval(sampleServer, 100);
  console.log(`[ASR recognize] ${model.id}: start`);
  const hear = async (entry: AsrRecognizeRequest, filePath: string, request: Omit<RecognizeClipRequest, 'filePath' | 'signal'>) => {
    const started = Date.now(), heard = await runtime.recognize.clip(owner, { ...request, filePath });
    entry.serverMs = Date.now() - started; entry.heard = heardOf(heard); sampleServer();
    return heard;
  };
  const work = (async () => {
    await runtime.initialize();
    for (const sampleId of smoke.sampleIds) {
      const source = options.sources.get(sampleId)!;
      const doc = transcriptToDocument({ schemaVersion: 1, source: { displayName: path.basename(source.path), durationMs: source.durationMs },
        model: source.model, detectedLanguage: source.language, segments: source.lines.map((line, index) => ({ id: `s${index + 1}`,
          startMs: line.startMs, endMs: line.endMs, text: line.text, ...(line.confidence === undefined ? {} : { confidence: line.confidence }) })) });
      await repository.create(doc, undefined, await captureSourceInput(source.path));
      for (const [index, cue] of doc.cues.entries()) {
        if (smoke.startsBeforeMs !== undefined && cue.timing.startMs >= smoke.startsBeforeMs) continue;
        const line = source.lines[index]!, entry: AsrRecognizeCue = { sampleId, index: index + 1, startMs: cue.timing.startMs, endMs: cue.timing.endMs!,
          original: { text: line.text, ...(line.confidence === undefined ? {} : { confidence: line.confidence }) } };
        run.cues.push(entry); current = entry;
        // As the dialog sends it with the default settings: the sample's language, no hint.
        const request = cueRecognizeRequestSchemas.recognizeCue.parse({ documentId: doc.id, cueId: cue.id, modelId: model.id,
          language: source.language, devicePreference });
        const started = Date.now();
        try {
          entry.result = await recognizeCue({ repository, media, clipper, workingDirectory, recognize: async clip => {
            const { filePath, signal: _signal, ...sent } = clip, bytes = await readFile(filePath);
            const copy = path.join(clips, `${model.id}.${sampleId}.${index + 1}.wav`);
            await writeFile(copy, bytes, { flag: 'wx' });
            Object.assign(entry, { request: sent, clip: path.relative(options.outputRoot, copy), clipMs: Math.round((bytes.length - 44) / 32) });
            return hear(entry, filePath, sent);
          } }, owner.webContentsId, request);
          entry.oddLead = oddLead(entry.result.text, line.text);
        } catch (error) { entry.error = message(error); }
        entry.elapsedMs = Date.now() - started;
        console.log(`[ASR recognize] ${model.id} ${sampleId} #${index + 1}: ${entry.error ?? JSON.stringify(entry.result?.text)}`);
      }
    }
    // Timestamps are what the profile leaves out: the same clips once more with them, after every cue was heard as the app hears it.
    for (const entry of run.cues) {
      if (!entry.clip || !entry.request) continue;
      const timed: AsrRecognizeRequest = entry.timed = {}, { noTimestamps: _untimed, ...request } = entry.request;
      current = timed;
      try { timed.oddLead = oddLead((await hear(timed, path.join(options.outputRoot, entry.clip), request)).text, entry.original.text); }
      catch (error) { timed.error = message(error); }
    }
    current = undefined;
  })();
  try { await within(work, ASR_AB_BUDGET.caseMs, `${model.id} exceeded ${ASR_AB_BUDGET.caseMs / 60_000} minutes`); }
  catch (error) { run.error = message(error); }
  finally {
    const cleanup: NonNullable<AsrRecognizeModelRun['cleanup']> = { joined: false, processesExited: false, killed: [], workRemoved: false };
    try {
      await within(runtime.shutdown('app_quit'), ASR_AB_BUDGET.cleanupMs, `${model.id} shutdown did not join`);
      await within(work.then(() => undefined, () => undefined), 5000, `${model.id} work did not settle after shutdown`);
      cleanup.joined = true; sampleServer();
    } catch (error) { cleanup.error = message(error); }
    clearInterval(sampling);
    try { await within((async () => { while (pending.size) await Promise.all([...pending]); })(), ASR_AB_BUDGET.cleanupMs, 'Observers did not settle'); }
    catch (error) { onError(error); }
    finally { for (const restore of restores.reverse()) { try { restore(); } catch (error) { onError(error); } } }
    // A server the shutdown left running is ended here, and the run fails.
    for (const pid of run.processIds.filter(alive)) { try { process.kill(pid); cleanup.killed.push(pid); } catch (error) { onError(error); } }
    cleanup.processesExited = !cleanup.killed.length && run.processIds.every(pid => !alive(pid));
    if (cleanup.joined && cleanup.processesExited) {
      try { await rm(caseRoot, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 }); cleanup.workRemoved = true; }
      catch (error) { cleanup.error = message(error); }
    }
    run.cleanup = cleanup;
    console.log(`[ASR recognize] ${model.id}: ${run.cues.filter(cue => cue.result).length}/${run.cues.length} cues, processes ${run.processIds.join(', ')}${run.error ? ` (${run.error})` : ''}`);
  }
  return run;
}

/** Each recognize-only model once, in its own runtime and server process, writing a JSON and a Markdown report. */
export async function runAsrRecognizeSmoke(selection: AsrRecognizeSelection, outputRoot: string): Promise<AsrRecognizeRunResult> {
  assert.equal(process.env.FUSIONKIT_ASR_AB, '1', 'Requires explicit FUSIONKIT_ASR_AB=1');
  const appRoot = await realpath(REPOSITORY), environment = { mode: 'development', appRoot } as const;
  const report: AsrRecognizeReport = { runId: path.basename(outputRoot), startedAt: new Date().toISOString(), cuesRun: selection.cuesRun,
    environment: [], samples: [], models: [] };
  const result: AsrRecognizeRunResult = { report, outputRoot, failures: [] };
  const write = async (name: string, text: string) => {
    const target = path.join(outputRoot, name), pending = `${target}.pending`;
    await writeFile(pending, text, 'utf8'); await rename(pending, target);
  };
  const checkpoint = async () => {
    await write('report.md', renderRecognizeReport(report)); await write('report.json', `${JSON.stringify(result, null, 2)}\n`);
  };
  const workRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'asrrr-'));
  const sources = new Map<string, CueSource>();
  let resources: Resources | undefined;
  try {
    const runtime = await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'all' });
    for (const sampleId of new Set(ASR_RECOGNIZE_SMOKE.flatMap(smoke => smoke.sampleIds))) sources.set(sampleId, await cueSource(selection.cuesRun, sampleId));
    report.samples = [...sources.values()].map(({ file: _file, model: _model, lines: _lines, ...sample }) => sample);
    resources = await within(prepareResources(selection, workRoot), ASR_AB_BUDGET.resourcesMs, 'Resource checks exceeded ten minutes');
    report.environment = [`主机：${os.type()} ${os.release()}，Node ${process.version}`, `GPU：${await gpuDescription()}`,
      `运行时：${path.relative(appRoot, runtime.root) || runtime.root}（${runtime.runtimeGeneration.slice(0, 12)}…）`,
      `资源：${selection.modelsRoot} 的下载模型与 ${selection.resourceRoot} 的 VAD、CUDA 包，复制到临时资源目录（只读使用原文件）`,
      '路径：Studio 重新识别（recognizeCue，设置为默认值：设备 auto、语言按样本、无提示词），每个模型一个新的运行时与服务进程'];
    await checkpoint();
    const service = readOnlySpeechResources(resources);
    for (const smoke of ASR_RECOGNIZE_SMOKE) {
      const run = await runModel({ smoke, model: resources.models.find(model => model.id === smoke.modelId)!, sources, service, workRoot, outputRoot, environment });
      report.models.push(run);
      if (run.error) result.failures.push(`${run.modelId}: ${run.error}`);
      for (const cue of run.cues) if (cue.error) result.failures.push(`${run.modelId} ${cue.sampleId} #${cue.index}: ${cue.error}`);
      if (run.observerErrors.length) result.failures.push(`${run.modelId}: ${run.observerErrors[0]}`);
      await checkpoint();
      if (!run.cleanup?.joined || !run.cleanup.processesExited) throw new Error(`${run.modelId} did not shut down its server; the remaining models were not started`);
    }
  } catch (error) { result.failures.push(message(error)); }
  finally {
    try {
      const changed: string[] = [];
      for (const source of sources.values()) if ((await fingerprint(source.file.path)).sha256 !== source.file.sha256) changed.push(source.file.path);
      for (const file of resources?.watched ?? []) if (!sameIdentity(file, await identity(file.path).catch(() => ({ ...file, ino: 'missing' })))) changed.push(file.path);
      result.sourcesUnchanged = changed.length === 0;
      if (changed.length) result.failures.push(`Read-only inputs changed: ${changed.join(', ')}`);
    } catch (error) { result.sourcesUnchanged = false; result.failures.push(message(error)); }
    if (report.models.every(run => run.cleanup?.joined && run.cleanup.processesExited)) {
      try { await rm(workRoot, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 }); result.workRemoved = true; }
      catch (error) { result.workRemoved = false; result.failures.push(`Work directory cleanup failed: ${message(error)}`); }
    } else { result.workRemoved = false; result.failures.push(`A server did not stop; ${workRoot} was kept`); }
    report.completedAt = new Date().toISOString(); await checkpoint();
    console.log(`[ASR recognize] ${result.failures.length ? 'failed' : 'completed'}: ${outputRoot}`);
  }
  return result;
}
