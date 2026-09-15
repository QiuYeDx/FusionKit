import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomaticKnowledgeService, AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS } from '../../electron/main/subtitle-studio/automatic-knowledge';
import { KnowledgeTaskSerialGate } from '../../electron/main/translation-knowledge/task-gate';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { knowledgeFixture } from '../translation-knowledge/fixtures';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { AutomaticKnowledgeRequest } from '../../src/translation-knowledge/automatic-snapshot-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
  const library: LibrarySnapshot = { generation: 7, data: knowledgeFixture(), approvals: {}, imports: [] };
  const request: AutomaticKnowledgeRequest = { knowledgeGeneration: 7, documentTopicIds: [], selection: {
    version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [library.data.collections[0].id], disabledEntryIds: [],
  } };
  const gate = new KnowledgeTaskSerialGate(), service = new AutomaticKnowledgeService(async () => library, gate);
  return { library, request, gate, service };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('automatic knowledge capture ownership', () => {
  it('captures independent frozen material and releases a unique reference idempotently', async () => {
    const f = fixture(), first = await f.service.capture(f.request), second = await f.service.capture(f.request);
    const references = f.service.activeKnowledgeReferences();
    expect(references).toHaveLength(2); expect(references[0].preparationId).not.toBe(references[1].preparationId);
    expect(references[0]).toMatchObject({ kind: 'automatic_preparation', status: 'active' });
    expect(references[0]).not.toHaveProperty('recordId'); expect(references[0]).not.toHaveProperty('documentId');
    const original = structuredClone(first.snapshot);
    f.library.data.entries[0].title = 'Changed after capture';
    expect(first.snapshot).toEqual(original);
    references[0].resources.splice(0); expect(f.service.activeKnowledgeReferences()[0].resources.length).toBeGreaterThan(0);
    first.release(); first.release(); expect(f.service.activeKnowledgeReferences()).toHaveLength(1);
    second.release(); expect(f.service.activeKnowledgeReferences()).toEqual([]);
  });
  it('rejects stale library generations and closed or revoked captures without a reference', async () => {
    const f = fixture(); f.library.generation++;
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'revision_conflict' });
    f.library.generation--;
    await expect(f.service.capture(f.request, () => { throw new Error('owner gone'); })).rejects.toThrow('owner gone');
    f.service.close(); await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'interrupted' });
    expect(f.service.activeKnowledgeReferences()).toEqual([]);
  });
  it('holds the clearing gate through capture publication and fences an in-flight shutdown', async () => {
    const f = fixture(), entered = deferred(), hold = deferred();
    const service = new AutomaticKnowledgeService(async () => { entered.resolve(); await hold.promise; return f.library; }, f.gate);
    const capture = service.capture(f.request); await entered.promise;
    let inspected = false;
    const inspect = f.gate.run(async () => { inspected = true; return service.activeKnowledgeReferences(); });
    await Promise.resolve(); expect(inspected).toBe(false);
    hold.resolve(); const lease = await capture;
    expect(await inspect).toHaveLength(1); lease.release();
    const beforeRead = deferred(), next = deferred();
    const closing = new AutomaticKnowledgeService(async () => { beforeRead.resolve(); await next.promise; return f.library; }, f.gate);
    const pending = closing.capture(f.request); await beforeRead.promise; closing.close(); next.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' }); expect(closing.activeKnowledgeReferences()).toEqual([]);
  });
  it('bounds concurrent captures and permits admission again after one lease is released', async () => {
    const f = fixture(), leases = [];
    for (let n = 0; n < AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures; n++) leases.push(await f.service.capture(f.request));
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'limit_exceeded' });
    leases.shift()!.release(); leases.push(await f.service.capture(f.request));
    f.service.close(); expect(f.service.activeKnowledgeReferences()).toHaveLength(leases.length);
    leases.forEach(lease => lease.release()); expect(f.service.activeKnowledgeReferences()).toEqual([]);
  });
  it('transfers to a durable pending intent and retains references in previous after the current intent is cleared', async () => {
    const f = fixture(), lease = await f.service.capture(f.request);
    const root = await mkdtemp(path.join(tmpdir(), 'studio-auto-capture-')); roots.push(root);
    const repository = new DocumentRepository(root), taskId = randomUUID(), intentId = randomUUID();
    const sink = createTranscriptionDocumentSink({ repository, owner: { webContentsId: 1, ownerSessionId: 'fixture' }, taskId, generation: 1, assertActive: () => {},
      automaticTranslation: { intentId, sourceTaskId: taskId, generation: 1, state: 'pending', knowledge: lease.snapshot,
        config: { model: { profileId: 'fixture', modelKey: 'fixture', endpoint: 'http://localhost:9999/v1', apiFormat: 'chat_completions' },
          language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20 } } });
    await sink.publish({ schemaVersion: 1, source: { displayName: 'source.wav', durationMs: 4000 },
      model: { engine: 'whisper_cpp', modelId: 'base', modelHash: 'a'.repeat(64), backend: 'cpu' },
      segments: [{ id: 'one', startMs: 100, endMs: 1500, text: 'Hello.' }] });
    const pending = await repository.inspectKnowledgeReferences();
    expect(pending).toMatchObject({ unknownDocuments: 0, references: [{ kind: 'automatic_preparation', preparationId: intentId, documentId: sink.documentId, status: 'active' }] });
    lease.release(); expect(f.service.activeKnowledgeReferences()).toEqual([]);
    expect(await new DocumentRepository(root).inspectKnowledgeReferences()).toEqual(pending);
    const doc = await repository.read(sink.documentId);
    await repository.transact(doc.id, doc.revision, value => { delete value.automaticTranslation; });
    expect(await repository.inspectKnowledgeReferences()).toMatchObject({ unknownDocuments: 0, references: [{ status: 'retained', preparationId: intentId }] });
    const next = await repository.read(doc.id);
    await repository.transact(doc.id, next.revision, () => {});
    expect(await repository.inspectKnowledgeReferences()).toMatchObject({ unknownDocuments: 0, references: [] });
  });
});
