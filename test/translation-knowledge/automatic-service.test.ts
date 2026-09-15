// Cross-domain integration: joins Studio translation and knowledge maintenance.
// Kept outside the standalone Studio dependency/deletion isolation test roots.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
    expect((await f.repository.inspectKnowledgeReferences()).unknownDocuments).toBe(1);
  });

  it('reports an inconsistent durable target language as knowledge failure without hiding the source document', async () => {
    const f = await fixture({ language: 'ja' }); await f.publish(1); await f.translation.initialize();
    const snapshot = await f.repository.readSnapshot(f.sink.documentId);
    expect(snapshot.document.cues).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', translation: { error: 'knowledge_check_failed' } });
    expect(snapshot.executionRecords).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
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
    expect(snapshot.automaticTranslation!.knowledge).toEqual(f.frozen); expect(snapshot.document.cues).toHaveLength(1);
    expect(snapshot.executionRecords).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
  });

  it('preserves failed request bytes and never recompiles on explicit resume or repeated automatic handoff', async () => {
    let calls = 0;
    const f = await fixture({ send: async request => { if (++calls === 2) throw new Error('controlled provider failure'); return reply(request); } });
    await f.publish(); const started = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key'); await f.translation.settled(started.taskId);
    const current = await f.repository.readSnapshot(f.sink.documentId), saved = resolveExecutionRecord(current, started.taskId);
    expect(current.tasks[0].status).toBe('failed');
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
