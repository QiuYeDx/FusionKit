import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomaticKnowledgeService, AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS } from '../../electron/main/subtitle-studio/automatic-knowledge';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { knowledgeFixture } from '../translation-knowledge/fixtures';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { AutomaticKnowledgeRequest } from '../../src/translation-knowledge/automatic-snapshot-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
  const library: LibrarySnapshot = { generation: 7, data: knowledgeFixture() };
  const request: AutomaticKnowledgeRequest = { knowledgeGeneration: 7, selection: {
    version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [library.data.collections[0].id], disabledEntryIds: [],
  } };
  const service = new AutomaticKnowledgeService(async () => library);
  return { library, request, service };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('automatic knowledge capture ownership', () => {
  it('captures independent, deeply frozen material that later library edits cannot change', async () => {
    const f = fixture(), first = await f.service.capture(f.request), second = await f.service.capture(f.request);
    expect(first.snapshot).not.toBe(second.snapshot); expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.data.collections.map(item => item.id)).toEqual([f.library.data.collections[0].id]);
    expect(Object.isFrozen(first.snapshot)).toBe(true); expect(Object.isFrozen(first.snapshot.data.entries[0].payload)).toBe(true);
    const original = structuredClone(first.snapshot);
    f.library.data.entries[0].enabled = false;
    f.library.data.collections.splice(0, 1);
    expect(first.snapshot).toEqual(original);
    expect(() => { (first.snapshot.data.entries[0] as { enabled: boolean }).enabled = false; }).toThrow(TypeError);
    first.release(); second.release();
  });
  it('rejects stale library generations and closed or revoked captures', async () => {
    const f = fixture(); f.library.generation++;
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'revision_conflict' });
    f.library.generation--;
    await expect(f.service.capture(f.request, () => { throw new Error('owner gone'); })).rejects.toThrow('owner gone');
    f.service.close(); await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'interrupted' });
  });
  it('fences a shutdown that happens while the library is being read', async () => {
    const f = fixture(), beforeRead = deferred(), next = deferred();
    const closing = new AutomaticKnowledgeService(async () => { beforeRead.resolve(); await next.promise; return f.library; });
    const pending = closing.capture(f.request); await beforeRead.promise; closing.close(); next.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
    let owner = true;
    const revoked = new AutomaticKnowledgeService(async () => { owner = false; return f.library; });
    await expect(revoked.capture(f.request, () => { if (!owner) throw new Error('owner gone'); })).rejects.toThrow('owner gone');
  });
  it('bounds concurrent captures, releases a lease only once and permits admission again afterwards', async () => {
    const f = fixture(), leases = [];
    for (let n = 0; n < AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures; n++) leases.push(await f.service.capture(f.request));
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'limit_exceeded' });
    const released = leases.shift()!; released.release(); released.release();
    leases.push(await f.service.capture(f.request));
    // A repeated release must not free a slot held by another capture.
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'limit_exceeded' });
    leases.forEach(lease => lease.release());
    leases.splice(0);
    for (let n = 0; n < AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures; n++) leases.push(await f.service.capture(f.request));
    leases.forEach(lease => lease.release());
  });
  it('bounds the total bytes that pending captures may hold', async () => {
    const f = fixture(), collectionId = f.library.data.collections[0].id;
    f.library.data.entries.push(...Array.from({ length: 115 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`, revision: 1, collectionId, enabled: true, kind: 'context' as const,
      payload: { text: '中'.repeat(10_000), required: false },
    })));
    const first = await f.service.capture(f.request), size = Buffer.byteLength(JSON.stringify(first.snapshot), 'utf8');
    const fit = Math.floor(AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.bytes / size);
    expect(fit).toBeLessThan(AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures);
    const leases = [first];
    for (let n = 1; n < fit; n++) leases.push(await f.service.capture(f.request));
    await expect(f.service.capture(f.request)).rejects.toMatchObject({ code: 'limit_exceeded' });
    leases.pop()!.release(); leases.push(await f.service.capture(f.request));
    leases.forEach(lease => lease.release());
  });
  it('transfers frozen material to a durable pending intent that outlives the released capture', async () => {
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
    const snapshot = structuredClone(lease.snapshot);
    lease.release();
    f.library.data.collections = []; f.library.data.entries = []; f.library.generation++;
    const saved = await new DocumentRepository(root).readSnapshot(sink.documentId);
    expect(saved.automaticTranslation).toMatchObject({ intentId, state: 'pending' });
    expect(saved.automaticTranslation!.knowledge).toEqual(snapshot);
  });
});
