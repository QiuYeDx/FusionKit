// Cross-domain integration: joins Studio translation and knowledge maintenance.
// Kept outside the standalone Studio dependency/deletion isolation test roots.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knowledgeFixture } from './fixtures';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { buildFrozenAutomaticKnowledge, type FrozenAutomaticKnowledge } from '../../src/translation-knowledge/automatic-snapshot-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { AutomaticTranslationIntent } from '../../src/subtitle-studio/automatic-translation-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import { StudioError } from '../../src/subtitle-studio/domain';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import { createAutomaticTranslationCoordinator } from '../../electron/main/subtitle-studio/automatic-translation';
import { KnowledgeTaskSerialGate } from '../../electron/main/translation-knowledge/task-gate';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { resolveExecutionRecord } from '../../electron/main/subtitle-studio/execution-records';
import * as records from '../../electron/main/subtitle-studio/execution-records';
import * as preparation from '../../electron/main/subtitle-studio/knowledge-translation';
import * as planner from '../../electron/main/subtitle-studio/translation-planner';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { automaticKnowledgeReportTrackIds, createAutomaticKnowledgeReport, readAutomaticKnowledgeReportPage, validateAutomaticKnowledgeReport,
  type AutomaticKnowledgePreparationReport } from '../../electron/main/subtitle-studio/automatic-knowledge-report';
import { AUTOMATIC_KNOWLEDGE_REPORT_LIMITS } from '../../src/subtitle-studio/automatic-knowledge-report-contract';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import type { KnowledgeIssue } from '../../src/translation-knowledge/execution-contract';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const reply = async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => ({ apiFormat: request.model.apiFormat,
  content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string }) => ({ id: item.id, text: `存档点 ${item.id}` })) }), finishReason: 'stop', rawStatus: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
async function fixture(options: { apiFormat?: TranslationConfig['model']['apiFormat']; language?: string; mutate?: (library: LibrarySnapshot) => void; damage?: (frozen: FrozenAutomaticKnowledge) => void; send?: typeof reply; fault?: (stage: CommitStage) => void } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'automatic-knowledge-'));
  const repository = new DocumentRepository(root, { fault: options.fault });
  const data = knowledgeFixture(), term = data.entries.find(entry => entry.kind === 'term')!;
  data.entries = [term]; data.recipes = []; data.styles = []; data.preferenceTemplates = [];
  term.state = 'ready'; term.scope.condition = { mode: 'none' }; term.scope.requiredSubjects = [{ subjectId: data.subjects[0].id, role: 'topic' }];
  if (term.kind === 'term') term.payload.strength = 'required';
  const library: LibrarySnapshot = { generation: 3, data, imports: [], approvals: {} };
  options.mutate?.(library);
  for (const entry of data.entries) library.approvals[entry.id] = { revision: entry.revision, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-09-15T00:00:00Z' };
  const frozen = buildFrozenAutomaticKnowledge(library, { knowledgeGeneration: 3,
    selection: { version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [term.collectionId], disabledEntryIds: [], instructions: undefined }, documentTopicIds: [data.subjects[0].id] });
  options.damage?.(frozen);
  const taskId = randomUUID();
  const intent: AutomaticTranslationIntent = { intentId: randomUUID(), sourceTaskId: taskId, generation: 1, state: 'pending', knowledge: frozen,
    config: { model: { profileId: 'p', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: options.apiFormat ?? 'chat_completions' },
      language: options.language ?? 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 2048, maxBatchCues: 20 } };
  const sink = createTranscriptionDocumentSink({ repository, owner: { webContentsId: 7, ownerSessionId: 'owner' }, taskId, generation: 1, assertActive: () => {}, automaticTranslation: intent });
  const gate = new KnowledgeTaskSerialGate(), send = vi.fn(options.send ?? reply), translation = new TranslationService(repository, send, new TranslationScheduler(1), gate);
  const coordinator = createAutomaticTranslationCoordinator({ repository, translation });
  cleanups.push(async () => { await coordinator.shutdown(); await translation.dispose(); await rm(root, { recursive: true, force: true }); });
  const publish = (count = 24) => sink.publish({ schemaVersion: 1, source: { displayName: 'synthetic.wav', durationMs: (count + 1) * 1000 },
    model: { engine: 'whisper_cpp', modelId: 'base', modelHash: 'a'.repeat(64), backend: 'cpu' },
    segments: Array.from({ length: count }, (_, index) => ({ id: `segment-${index}`, startMs: index * 1000, endMs: index * 1000 + 900, text: `The checkpoint ${index + 1}.` })) });
  return { root, repository, library, term, frozen, intent, sink, publish, gate, send, translation, coordinator };
}
const addConflict = (library: LibrarySnapshot) => {
  const conflicting = structuredClone(library.data.entries[0]); conflicting.id = randomUUID();
  if (conflicting.kind === 'term') conflicting.payload.target = 'Conflicting target';
  library.data.entries.push(conflicting);
};
async function failedFixture() {
  const f = await fixture({ mutate: addConflict }); await f.publish(24); await f.translation.initialize();
  const snapshot = await f.repository.readSnapshot(f.sink.documentId);
  return { ...f, snapshot, task: snapshot.tasks[0], report: snapshot.automaticTranslation!.preparationReport as AutomaticKnowledgePreparationReport };
}
async function rewriteCurrent(root: string, id: string, mutate: (snapshot: DocumentSnapshot) => void) {
  const directory = path.join(root, id), pointerPath = path.join(directory, 'current.json');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  const file = path.join(directory, `${pointer.generation}.json`);
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as DocumentSnapshot;
  mutate(snapshot);
  const json = JSON.stringify(snapshot);
  await writeFile(file, json); pointer.digest = createHash('sha256').update(json).digest('hex');
  await writeFile(pointerPath, JSON.stringify(pointer));
  return snapshot;
}

describe('automatic translation from frozen knowledge', () => {
  it.each(['chat_completions', 'responses'] as const)('checks the generated transcript and persists independent %s requests from pre-transcription material', async apiFormat => {
    const f = await fixture({ apiFormat }); await f.coordinator.initialize();
    const original = structuredClone(f.term);
    f.library.generation++; f.term.state = 'archived'; if (f.term.kind === 'term') f.term.payload.target = 'Changed live target'; f.library.approvals = {};
    await f.publish();
    const ordinary = vi.spyOn(planner, 'planTranslation');
    const started = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'SECRET_RUNTIME_KEY');
    await f.translation.settled(started.taskId);
    expect(ordinary).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(2);
    const snapshot = await f.repository.readSnapshot(f.sink.documentId), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.tasks[0].status).toBe('completed'); expect(snapshot.document.translationTracks[0].language).toBe('zh-Hans');
    expect(snapshot.automaticTranslation!.preparationReport).toBeUndefined();
    expect(readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId)).toEqual({ state: 'none' });
    expect(snapshot.automaticTranslation!.knowledge).toEqual(f.frozen);
    expect(record.knowledge!.data.entries[0]).toEqual(original);
    expect(record.plan.batches.flatMap(batch => batch.units.map(unit => unit.id))).toEqual(Array.from({ length: 24 }, (_, index) => `u${index + 1}`));
    for (const [index, [request]] of f.send.mock.calls.entries()) {
      expect(record.requests[`b${index + 1}`].httpBody).toBe(planner.serializeTranslationRequest(request));
      expect(request.messages[1].content).toContain('存档点'); expect(request.messages[1].content).not.toContain('Changed live target');
    }
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET_RUNTIME_KEY|apiKey|"signal"|"proxy"/);
    await f.repository.removeTask(snapshot.document.id, snapshot.document.revision, started.taskId);
    expect((await f.repository.readSnapshot(snapshot.document.id)).executionRecords).toHaveProperty(record.id);
    await expect(f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key')).rejects.toMatchObject({ code: 'interrupted' });
  });

  it('recovers a durable pending intent without live knowledge or provider calls, then resumes the frozen record', async () => {
    const f = await fixture(); await f.publish(2);
    f.library.data.entries = []; f.library.generation++;
    const restarted = new TranslationService(f.repository, f.send, new TranslationScheduler(1), f.gate);
    try {
      await restarted.initialize();
      const snapshot = await f.repository.readSnapshot(f.sink.documentId), task = snapshot.tasks[0], frozen = resolveExecutionRecord(snapshot, task.id);
      expect(task.status).toBe('needs_configuration'); expect(f.send).not.toHaveBeenCalled();
      expect(frozen.knowledge!.data.entries[0]).toEqual(f.frozen.data.entries[0]);
      vi.spyOn(preparation, 'prepareKnowledgeTranslation').mockRejectedValue(new Error('must never recompile a record'));
      const result = await restarted.resume(snapshot.document.id, snapshot.document.revision, task.id, task.translation!.config.model, 'key');
      await restarted.settled(result.taskId);
      const record = resolveExecutionRecord(await f.repository.readSnapshot(snapshot.document.id), task.id);
      expect(record.baseRequests).toEqual(frozen.baseRequests); expect(record.knowledge).toEqual(frozen.knowledge);
    } finally { await restarted.dispose(); }
  });

  it('keeps a post-transcription required-term conflict visible and never falls back to ordinary translation', async () => {
    const f = await fixture({ mutate: library => {
      const conflicting = structuredClone(library.data.entries[0]); conflicting.id = randomUUID();
      if (conflicting.kind === 'term') conflicting.payload.target = 'Conflicting target'; library.data.entries.push(conflicting);
    } });
    await f.publish(); const ordinary = vi.spyOn(planner, 'planTranslation');
    const result = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key');
    const snapshot = await f.repository.readSnapshot(f.sink.documentId);
    expect(snapshot.document.cues).toHaveLength(24); expect(snapshot.automaticTranslation!.knowledge).toEqual(f.frozen);
    expect(snapshot.tasks[0]).toMatchObject({ id: result.taskId, status: 'failed', translation: { error: 'knowledge_check_failed' } });
    expect(snapshot.tasks[0].translation!.checkpoint).toBeUndefined(); expect(snapshot.executionRecords).toBeUndefined();
    expect(ordinary).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    const report = readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId);
    expect(report).toMatchObject({ state: 'available', documentRevision: snapshot.document.revision, stale: false, sourceChanged: false,
      error: 'knowledge_check_failed', issues: expect.arrayContaining([expect.objectContaining({ code: 'term_conflict', severity: 'error',
        entries: expect.arrayContaining([expect.objectContaining({ entryId: f.term.id, title: f.term.title })]),
        cues: expect.arrayContaining([expect.objectContaining({ cueId: snapshot.document.cues[0].id, number: 1, text: 'The checkpoint 1.' })]) })]),
      seed: { documentId: snapshot.document.id, taskId: result.taskId, selection: { bindings: [], confirmations: [] } } });
    expect(JSON.stringify(report)).not.toMatch(/"data"|"approvals"|"payload"|"apiKey"|"httpBody"/);
    expect(await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key')).toEqual(result);
  });

  it.each(['digest', 'policy', 'missing_source'] as const)('materializes damaged %s knowledge as failure instead of blocking initialization or dropping knowledge', async damage => {
    const f = await fixture({ damage: frozen => {
      if (damage === 'digest') frozen.digest = '0'.repeat(64);
      if (damage === 'policy') frozen.policyVersion = 'automatic-knowledge-preparation/99';
      if (damage === 'missing_source') frozen.data.sources = [];
      if (damage !== 'digest') { const { digest: _digest, ...base } = frozen; frozen.digest = sha256Canonical(base); }
    } });
    await f.publish(1);
    expect((await f.repository.inspectKnowledgeReferences()).unknownDocuments).toBe(1);
    await f.translation.initialize(); await f.translation.initialize();
    const snapshot = await f.repository.readSnapshot(f.sink.documentId);
    expect(snapshot.tasks).toHaveLength(1); expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', translation: { error: 'knowledge_check_failed' } });
    expect(snapshot.automaticTranslation!.knowledge).toEqual(f.frozen); expect(snapshot.document.cues).toHaveLength(1);
    expect(snapshot.executionRecords).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
    expect(readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId)).toMatchObject({ state: 'available', seed: null, error: 'knowledge_check_failed', issues: [] });
    expect((await f.repository.inspectKnowledgeReferences()).unknownDocuments).toBe(1);
  });

  it('reports an inconsistent durable target language as knowledge failure without hiding the source document', async () => {
    const f = await fixture({ language: 'ja' }); await f.publish(1); await f.translation.initialize();
    const snapshot = await f.repository.readSnapshot(f.sink.documentId);
    expect(snapshot.document.cues).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', translation: { error: 'knowledge_check_failed' } });
    expect(snapshot.executionRecords).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
    expect(readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId)).toMatchObject({ state: 'available', error: 'knowledge_check_failed', issues: [] });
  });

  it('blocks actual permanent clearing when a pending knowledge snapshot cannot be verified', async () => {
    const f = await fixture({ damage: frozen => { frozen.digest = '0'.repeat(64); } }); await f.publish(1);
    const knowledgeRoot = await mkdtemp(path.join(tmpdir(), 'damaged-automatic-maintenance-'));
    const service = new KnowledgeService(knowledgeRoot, {}, { gate: f.gate, inspect: () => f.repository.inspectKnowledgeReferences() });
    try {
      const imported = await service.planImport('owner', JSON.stringify(f.library.data));
      await service.commitImport('owner', { planId: imported.planId, decisions: [], adoptReady: false });
      const targets = [{ group: 'entries' as const, id: f.term.id }];
      const archive = await service.planMaintenance('owner', { generation: (await service.read()).generation, action: 'archive', targets });
      await service.commitMaintenance('owner', { planId: archive.planId });
      const before = await service.read();
      const purge = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets });
      expect(purge).toMatchObject({ canCommit: false, tasks: { total: 0, unknownDocuments: 1 } });
      expect(purge.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PURGE_TASK_SCAN_INCOMPLETE' })]));
      await expect(service.commitMaintenance('owner', { planId: purge.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'import_conflict' });
      expect(await service.read()).toEqual(before);
    } finally { await service.dispose(); await rm(knowledgeRoot, { recursive: true, force: true }); }
  });

  it('retains the frozen intent and source when future request capacity cannot fit', async () => {
    const f = await fixture(); await f.publish(1);
    vi.spyOn(records, 'assertKnowledgeExecutionCapacity').mockImplementation(() => { throw new StudioError('limit_exceeded'); });
    await f.translation.initialize();
    const snapshot = await f.repository.readSnapshot(f.sink.documentId);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', translation: { error: 'limit_exceeded' } });
    expect(readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId)).toMatchObject({ state: 'available', error: 'limit_exceeded', issues: [] });
    expect(snapshot.automaticTranslation!.knowledge).toEqual(f.frozen); expect(snapshot.document.cues).toHaveLength(1);
    expect(snapshot.executionRecords).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
  });

  it('preserves failed request bytes and never recompiles on explicit resume or repeated automatic handoff', async () => {
    let calls = 0;
    const f = await fixture({ send: async request => { if (++calls === 2) throw new Error('controlled provider failure'); return reply(request); } });
    await f.publish(); const started = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key'); await f.translation.settled(started.taskId);
    const current = await f.repository.readSnapshot(f.sink.documentId), saved = resolveExecutionRecord(current, started.taskId);
    expect(current.tasks[0].status).toBe('failed');
    expect(current.automaticTranslation!.preparationReport).toBeUndefined();
    expect(await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key')).toEqual(started); expect(calls).toBe(2);
    vi.spyOn(preparation, 'prepareKnowledgeTranslation').mockRejectedValue(new Error('must never recompile'));
    const resumed = await f.translation.resume(current.document.id, current.document.revision, started.taskId, current.tasks[0].translation!.config.model, 'next-key');
    await f.translation.settled(resumed.taskId);
    expect(planner.serializeTranslationRequest(f.send.mock.calls[2][0])).toBe(saved.requests.b2.httpBody);
    expect(resolveExecutionRecord(await f.repository.readSnapshot(current.document.id), started.taskId).knowledge).toEqual(saved.knowledge);
  });

  it('does not wait for an active provider while checking other operations through the knowledge gate', async () => {
    let release!: (value: ModelRuntimeTextResult) => void;
    const pending = new Promise<ModelRuntimeTextResult>(resolve => { release = resolve; });
    let request!: ModelRuntimeTextRequest;
    const f = await fixture({ send: async value => { request = value; return pending; } });
    try {
      await f.coordinator.initialize(); await f.publish(1);
      const task = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key');
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect(await f.gate.run(async () => 'available')).toBe('available');
      expect(f.translation.activeKnowledgeReferences()).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: task.taskId })]));
      release(await reply(request)); await f.translation.settled(task.taskId);
    } finally { if (request) release(await reply(request)); }
  });
});

describe('automatic knowledge preparation reports', () => {
  it('reads a saved report without initialization, preparation, mutation or provider work and retains identity after task removal', async () => {
    const f = await failedFixture();
    const original = JSON.stringify(f.snapshot);
    const prepare = vi.spyOn(preparation, 'prepareKnowledgeTranslation').mockRejectedValue(new Error('must not recompile'));
    const initialize = vi.spyOn(f.translation, 'initialize');
    const page = readAutomaticKnowledgeReportPage(f.snapshot, f.task.trackId);
    expect(JSON.stringify(f.snapshot)).toBe(original); expect(prepare).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(automaticKnowledgeReportTrackIds(f.snapshot)).toEqual([f.task.trackId]);
    await f.repository.removeTask(f.snapshot.document.id, f.snapshot.document.revision, f.task.id);
    const reopened = await new DocumentRepository(f.root).readSnapshot(f.snapshot.document.id);
    expect(reopened.tasks).toEqual([]); expect(reopened.automaticTranslation!.preparationReport).toEqual(f.report);
    expect(readAutomaticKnowledgeReportPage(reopened, f.task.trackId)).toEqual(page);
    expect(automaticKnowledgeReportTrackIds(reopened)).toEqual([f.task.trackId]);
  });

  it('marks source, timing and configuration changes stale while preserving original excerpts and ignoring unrelated revision increments', async () => {
    const f = await failedFixture();
    const copy = structuredClone(f.snapshot); copy.document.revision += 10;
    expect(readAutomaticKnowledgeReportPage(copy, f.task.trackId)).toMatchObject({ state: 'available', stale: false, sourceChanged: false });
    copy.document.cues[0].timing.startMs++;
    expect(readAutomaticKnowledgeReportPage(copy, f.task.trackId)).toMatchObject({ state: 'available', stale: true, sourceChanged: false });
    copy.document.cues[0].source.plain = 'CURRENT SOURCE'; copy.document.cues[0].sourceRevision++;
    const sourcePage = readAutomaticKnowledgeReportPage(copy, f.task.trackId);
    expect(sourcePage).toMatchObject({ state: 'available', stale: true, sourceChanged: true });
    expect(JSON.stringify(sourcePage)).not.toContain('CURRENT SOURCE'); expect(JSON.stringify(sourcePage)).toContain('The checkpoint 1.');
    const configCopy = structuredClone(f.snapshot); configCopy.tasks[0].translation!.config.instructions = 'NEW CONFIG';
    expect(readAutomaticKnowledgeReportPage(configCopy, f.task.trackId)).toMatchObject({ state: 'available', stale: true, sourceChanged: false });
  });

  it('returns legacy choices without reconstructing diagnostics and does not attach reports to unrelated tracks', async () => {
    const f = await failedFixture(), copy = structuredClone(f.snapshot);
    delete copy.automaticTranslation!.preparationReport;
    expect(readAutomaticKnowledgeReportPage(copy, f.task.trackId)).toMatchObject({ state: 'legacy', seed: {
      documentId: copy.document.id, trackId: f.task.trackId, intentId: f.intent.intentId, taskId: f.task.id,
      config: f.intent.config, selection: { ...f.frozen.selection, bindings: [], confirmations: [] }, documentTopicIds: f.frozen.documentTopicIds } });
    const trackId = randomUUID(); copy.document.translationTracks.push({ id: trackId, revision: 1, language: 'ja', entries: {} });
    expect(readAutomaticKnowledgeReportPage(copy, trackId)).toEqual({ state: 'none' });
    expect(() => readAutomaticKnowledgeReportPage(copy, randomUUID())).toThrow('revision_conflict');
    copy.automaticTranslation = undefined;
    expect(readAutomaticKnowledgeReportPage(copy, f.task.trackId)).toEqual({ state: 'none' });
  });

  it.each(['version', 'digest', 'taskId', 'trackId', 'documentId', 'entry', 'cue', 'freeText'] as const)('reports %s corruption as unavailable without rolling back current state or blocking unrelated edits', async defect => {
    const f = await failedFixture();
    const corrupted = await rewriteCurrent(f.root, f.snapshot.document.id, snapshot => {
      const report = snapshot.automaticTranslation!.preparationReport as AutomaticKnowledgePreparationReport;
      if (defect === 'version') Object.assign(report, { version: 99 });
      else if (defect === 'digest') report.digest = '0'.repeat(64);
      else if (defect === 'taskId' || defect === 'trackId' || defect === 'documentId') report[defect] = randomUUID();
      else if (defect === 'entry') report.issues.find(issue => issue.entries.length)!.entries[0].entryId = randomUUID();
      else if (defect === 'cue') report.issues.find(issue => issue.cues.length)!.cues[0].cueId = randomUUID();
      else Object.assign(report, { providerMessage: 'SECRET_PROVIDER_BODY' });
      if (defect !== 'digest') { const { digest: _digest, ...base } = report; report.digest = sha256Canonical(base); }
      snapshot.document.revision += 5;
    });
    const reopened = await new DocumentRepository(f.root).readSnapshot(f.snapshot.document.id);
    expect(reopened).toEqual(corrupted); expect(reopened.document.revision).toBe(f.snapshot.document.revision + 5);
    expect(readAutomaticKnowledgeReportPage(reopened, f.task.trackId)).toEqual({ state: 'unavailable' });
    expect(automaticKnowledgeReportTrackIds(reopened)).toEqual([f.task.trackId]);
    const edited = await f.repository.transact(reopened.document.id, reopened.document.revision, value => { value.document.translationTracks[0].revision++; });
    expect(edited.automaticTranslation!.preparationReport).toEqual(corrupted.automaticTranslation!.preparationReport);
    expect(edited.document.revision).toBe(corrupted.document.revision + 1);
    expect(readAutomaticKnowledgeReportPage(edited, f.task.trackId)).toEqual({ state: 'unavailable' });
  });

  it('makes published reports immutable and rejects new malformed report writes', async () => {
    const f = await failedFixture();
    for (const mutate of [(snapshot: DocumentSnapshot) => { delete snapshot.automaticTranslation!.preparationReport; },
      (snapshot: DocumentSnapshot) => { snapshot.automaticTranslation!.preparationReport = { ...f.report, error: 'interrupted' }; }]) {
      await expect(f.repository.transact(f.snapshot.document.id, f.snapshot.document.revision, mutate)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const pending = await fixture(); await pending.publish(1);
    const before = await pending.repository.readSnapshot(pending.sink.documentId);
    await expect(pending.repository.transact(before.document.id, before.document.revision, value => { value.automaticTranslation!.preparationReport = { message: 'secret' }; })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await pending.repository.readSnapshot(before.document.id)).automaticTranslation!.preparationReport).toBeUndefined();
    const changed = structuredClone(f.report); changed.issues[0].entries = [{ entryId: randomUUID(), title: 'invented' }];
    const { digest: _digest, ...base } = changed; changed.digest = sha256Canonical(base);
    expect(() => validateAutomaticKnowledgeReport(changed, f.snapshot)).toThrow('invalid_input');
  });

  it('atomically saves failure and report across publication interruption, and retries from the pending intent', async () => {
    let failing = false;
    const f = await fixture({ mutate: addConflict, fault: stage => { if (failing && stage === 'current-publish') throw new Error('controlled publication failure'); } });
    await f.publish(1); failing = true;
    await expect(f.translation.initialize()).rejects.toThrow('controlled publication failure');
    const interrupted = await f.repository.readSnapshot(f.sink.documentId);
    expect(interrupted.automaticTranslation!.state).toBe('pending'); expect(interrupted.tasks).toEqual([]);
    expect(interrupted.automaticTranslation!.preparationReport).toBeUndefined();
    failing = false; await f.translation.initialize();
    const saved = await f.repository.readSnapshot(f.sink.documentId);
    expect(saved.tasks).toHaveLength(1); expect(saved.tasks[0].status).toBe('failed');
    expect(readAutomaticKnowledgeReportPage(saved, saved.tasks[0].trackId)).toMatchObject({ state: 'available', stale: false });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('omits provider free text and downgrades unverifiable issue details to a fixed generic diagnostic', async () => {
    const f = await fixture(); await f.publish(1);
    vi.spyOn(preparation, 'prepareKnowledgeTranslation').mockRejectedValue(new Error('SECRET_PROVIDER_BODY'));
    await f.translation.initialize();
    const snapshot = await f.repository.readSnapshot(f.sink.documentId), page = readAutomaticKnowledgeReportPage(snapshot, snapshot.tasks[0].trackId);
    expect(page).toMatchObject({ state: 'available', error: 'knowledge_check_failed', issues: [] });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_PROVIDER_BODY');
    vi.restoreAllMocks();
    const invalidDetails = await fixture(); await invalidDetails.publish(1);
    vi.spyOn(preparation, 'prepareKnowledgeTranslation').mockResolvedValue({ displayName: 'ignored', bytes: 0,
      preview: { documentId: invalidDetails.sink.documentId, revision: 1, canRun: false, cueCount: 1, batchCount: 0,
        estimatedInputTokens: 0, outputTokenReserve: 0, knowledgeDigest: '', resourceCount: 0, includedEntryCount: 0,
        issues: [{ code: 'selection_invalid', severity: 'error', entryIds: [randomUUID()], cueIds: [] }] } });
    await invalidDetails.translation.initialize();
    const saved = await invalidDetails.repository.readSnapshot(invalidDetails.sink.documentId);
    expect(saved.tasks[0].status).toBe('failed');
    expect(readAutomaticKnowledgeReportPage(saved, saved.tasks[0].trackId)).toMatchObject({ state: 'available', error: 'knowledge_check_failed', issues: [] });
  });

  it.each(['knowledge', 'config'] as const)('still admits a visible failure when legacy %s contains unhashable UTF-16', async field => {
    const f = await fixture(); await f.publish(1);
    await rewriteCurrent(f.root, f.sink.documentId, snapshot => {
      if (field === 'knowledge') snapshot.automaticTranslation!.knowledge!.selection.instructions = '\uD800';
      else snapshot.automaticTranslation!.config.instructions = '\uD800';
    });
    await f.translation.initialize(); await f.translation.initialize();
    const saved = await f.repository.readSnapshot(f.sink.documentId);
    expect(saved.tasks).toHaveLength(1); expect(saved.tasks[0].status).toBe('failed');
    expect(saved.automaticTranslation!.state).toBe('admitted'); expect(saved.automaticTranslation!.preparationReport).toBeUndefined();
    expect(automaticKnowledgeReportTrackIds(saved)).toEqual([saved.tasks[0].trackId]);
    expect(readAutomaticKnowledgeReportPage(saved, saved.tasks[0].trackId)).toEqual({ state: 'legacy', seed: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('disables reuse of an oversized selection instead of silently truncating choices', async () => {
    const f = await failedFixture(), library = structuredClone(f.library);
    const collection = library.data.collections[0];
    library.data.collections.push(...Array.from({ length: 7000 }, () => ({ ...collection, id: randomUUID() })));
    const selection = { ...f.frozen.selection, collectionIds: library.data.collections.map(item => item.id) };
    const frozen = buildFrozenAutomaticKnowledge(library, { knowledgeGeneration: library.generation, selection, documentTopicIds: f.frozen.documentTopicIds });
    const snapshot = structuredClone(f.snapshot); snapshot.automaticTranslation!.knowledge = frozen;
    delete snapshot.automaticTranslation!.preparationReport;
    expect(Buffer.byteLength(JSON.stringify(selection))).toBeGreaterThan(AUTOMATIC_KNOWLEDGE_REPORT_LIMITS.seedBytes);
    expect(readAutomaticKnowledgeReportPage(snapshot, f.task.trackId)).toEqual({ state: 'legacy', seed: null });
    const report = createAutomaticKnowledgeReport(snapshot, f.task.id, 'knowledge_check_failed');
    expect(report.material.collectionCount).toBe(7001); expect(report.material.collections).toHaveLength(20);
  });

  it('bounds issue counts, references, names, excerpts and total UTF-8 bytes without claiming a truncated report is complete', async () => {
    const f = await failedFixture(), snapshot = structuredClone(f.snapshot), intent = snapshot.automaticTranslation!;
    const entry = intent.knowledge!.data.entries[0]; entry.title = '界'.repeat(500);
    intent.knowledge!.data.entries = Array.from({ length: 25 }, () => ({ ...structuredClone(entry), id: randomUUID() }));
    for (const cue of snapshot.document.cues) cue.source.plain = '界'.repeat(1000);
    const issue: KnowledgeIssue = { code: 'term_conflict', severity: 'error', entryIds: intent.knowledge!.data.entries.map(item => item.id), cueIds: snapshot.document.cues.map(cue => cue.id) };
    const report = createAutomaticKnowledgeReport(snapshot, f.task.id, 'knowledge_check_failed', Array.from({ length: 101 }, () => issue));
    expect(report.issueCount).toBe(101); expect(report.issuesTruncated).toBe(true);
    expect(report.issues.length).toBeGreaterThan(0); expect(report.issues.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(AUTOMATIC_KNOWLEDGE_REPORT_LIMITS.bytes);
    expect(report.issues[0]).toMatchObject({ entryCount: 25, cueCount: 24 });
    expect(report.issues[0].entries).toHaveLength(20); expect(report.issues[0].cues).toHaveLength(20);
    expect(report.issues[0].entries.every(entry => entry.title.length <= 160)).toBe(true);
    expect(report.issues[0].cues.every(cue => cue.text.length <= 240)).toBe(true);
    expect(() => createAutomaticKnowledgeReport(snapshot, f.task.id, 'knowledge_check_failed', [{ ...issue, entryIds: [randomUUID()] }])).toThrow('invalid_input');
    expect(() => createAutomaticKnowledgeReport(snapshot, f.task.id, 'knowledge_check_failed', [{ ...issue, cueIds: [randomUUID()] }])).toThrow('invalid_input');
  });
});
