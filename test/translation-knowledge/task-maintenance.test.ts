import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { emptyPackage, type RepositoryOptions } from '../../electron/main/translation-knowledge/repository';
import { KnowledgeTaskSerialGate } from '../../electron/main/translation-knowledge/task-gate';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { KnowledgeReferenceInventory, KnowledgeTaskReference } from '../../src/translation-knowledge/task-reference-contract';

const roots: string[] = [], services: KnowledgeService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(options: RepositoryOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-task-maintenance-')); roots.push(root);
  const gate = new KnowledgeTaskSerialGate();
  const inventory: Omit<KnowledgeReferenceInventory, 'digest'> = { references: [], unknownDocuments: 0 };
  const inspect = vi.fn(async () => ({ ...structuredClone(inventory), digest: sha256Canonical(inventory) }));
  const service = new KnowledgeService(root, options, { gate, inspect }); services.push(service);
  const data = emptyPackage(), collectionId = randomUUID(), sourceId = randomUUID();
  data.collections.push({ id: collectionId, revision: 1, name: 'Collection', archived: false, description: '', aboutSubjectIds: [] });
  data.sources.push({ id: sourceId, revision: 1, kind: 'user_note', title: 'Source', excerpt: 'Evidence' });
  data.entries.push({ id: randomUUID(), revision: 1, kind: 'term', title: 'Name', collectionId, state: 'ready', aboutSubjectIds: [],
    scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
    payload: { source: 'Council', target: '议会', aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'preferred' } });
  const imported = await service.planImport('owner', JSON.stringify(data));
  await service.commitImport('owner', { planId: imported.planId, decisions: [], adoptReady: false });
  const targets = [{ group: 'entries' as const, id: data.entries[0].id }];
  const plan = async (action: 'archive' | 'purge') => service.planMaintenance('owner', { action, targets, generation: (await service.read()).generation });
  const archive = await plan('archive'); await service.commitMaintenance('owner', { planId: archive.planId });
  const reference = (status: KnowledgeTaskReference['status'] = 'retained'): KnowledgeTaskReference => ({
    documentId: randomUUID(), taskId: randomUUID(), trackId: randomUUID(), recordId: randomUUID(), displayName: 'Sample.srt', status,
    resources: [{ group: 'entries', id: data.entries[0].id, revision: 1, digest: sha256Canonical(data.entries[0]) }],
  });
  const planCollectionDeletion = async () => service.planMaintenance('owner', { action: 'purge', targets: [{ group: 'collections', id: collectionId }], includeCollectionContents: true, generation: (await service.read()).generation });
  return { root, gate, service, inventory, inspect, plan, planCollectionDeletion, reference, targets };
}

describe('knowledge maintenance with durable task references', () => {
  it('keeps queued captures distinct and blocks clearing before any document or execution exists', async () => {
    const f = await fixture();
    for (let index = 0; index < 2; index++) f.inventory.references.push({ kind: 'automatic_preparation', preparationId: randomUUID(),
      displayName: '', status: 'active', resources: f.reference().resources });
    const preview = await f.plan('purge');
    expect(preview).toMatchObject({ canCommit: false, tasks: { total: 2, unknownDocuments: 0 } });
    expect(preview.tasks!.items.every(ref => ref.kind === 'automatic_preparation')).toBe(true);
    await expect(f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'import_conflict' });
  });
  it.each(['active', 'retained'] as const)('blocks purging a %s record referencing an older entity revision', async status => {
    const f = await fixture(); f.inventory.references.push(f.reference(status));
    const before = await f.service.read(), preview = await f.plan('purge');
    expect(before.data.entries[0].revision).toBe(2);
    expect(preview).toMatchObject({ taskTracking: 'connected', canCommit: false, tasks: { total: 1, unknownDocuments: 0 } });
    expect(preview.blockers.some(item => item.code === 'PURGE_TASK_REFERENCED')).toBe(true);
    await expect(f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'import_conflict' });
    expect(await f.service.read()).toEqual(before);
  });

  it.each(['active', 'retained'] as const)('blocks deleting a collection when a %s task references only an expanded child entry', async status => {
    const f = await fixture(); f.inventory.references.push(f.reference(status));
    const before = await f.service.read(), preview = await f.planCollectionDeletion();
    expect(preview).toMatchObject({ canCommit: false, tasks: { total: 1, unknownDocuments: 0 } });
    expect(preview.items.filter(item => item.effect === 'purge')).toHaveLength(2);
    expect(preview.tasks!.items[0].resources).toEqual(f.inventory.references[0].resources);
    expect(preview.blockers.some(item => item.code === 'PURGE_TASK_REFERENCED')).toBe(true);
    await expect(f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'import_conflict' });
    expect(await f.service.read()).toEqual(before);
  });

  it('expires collection deletion when a child-only task is admitted after preview', async () => {
    const f = await fixture(), preview = await f.planCollectionDeletion();
    expect(preview.canCommit).toBe(true);
    await f.gate.run(async () => { f.inventory.references.push(f.reference()); });
    await expect(f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'plan_expired' });
    expect((await f.service.read()).data.collections).toHaveLength(1);
    expect((await f.service.read()).data.entries).toHaveLength(1);
  });

  it('blocks collection deletion when retained task inventory is incomplete', async () => {
    const f = await fixture(); f.inventory.unknownDocuments = 1;
    const preview = await f.planCollectionDeletion();
    expect(preview.canCommit).toBe(false);
    expect(preview.blockers.some(item => item.code === 'PURGE_TASK_SCAN_INCOMPLETE')).toBe(true);
  });

  it('shows at most 50 unique records with an exact total and preserves active status when inventories overlap', async () => {
    const f = await fixture(); f.inventory.references.push(...Array.from({ length: 60 }, () => f.reference()));
    f.inventory.references.push({ ...structuredClone(f.inventory.references[0]), status: 'active' });
    const preview = await f.plan('archive');
    expect(preview.canCommit).toBe(true); expect(preview.tasks?.total).toBe(60); expect(preview.tasks?.items).toHaveLength(50);
    const committed = await f.service.commitMaintenance('owner', { planId: preview.planId });
    expect(committed.action).toBe('archive'); expect(f.inventory.references).toHaveLength(61);
  });

  it('allows unrelated task references and blocks incomplete inventories or scanner failures', async () => {
    const f = await fixture(); const unrelated = f.reference(); unrelated.resources[0].id = randomUUID(); f.inventory.references.push(unrelated);
    expect((await f.plan('purge')).canCommit).toBe(true);
    f.inventory.unknownDocuments = 1;
    const incomplete = await f.plan('purge');
    expect(incomplete).toMatchObject({ canCommit: false, tasks: { total: 0, unknownDocuments: 1 } });
    expect(incomplete.blockers.some(item => item.code === 'PURGE_TASK_SCAN_INCOMPLETE')).toBe(true);
    f.inspect.mockRejectedValue(new Error('Unavailable document root'));
    expect((await f.plan('purge')).canCommit).toBe(false);
    const archive = await f.plan('archive'); expect(archive.canCommit).toBe(true);
    await f.service.commitMaintenance('owner', { planId: archive.planId });
  });

  it('expires an old purge preview when a task is admitted through the shared gate', async () => {
    const f = await fixture(), preview = await f.plan('purge');
    const hold = deferred(), entered = deferred();
    const admission = f.gate.run(async () => { entered.resolve(); await hold.promise; f.inventory.references.push(f.reference()); });
    await entered.promise;
    const commit = f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true });
    hold.resolve(); await admission;
    await expect(commit).rejects.toMatchObject({ code: 'plan_expired' });
    expect((await f.service.read()).data.entries).toHaveLength(1);
  });

  it('holds the gate until purge publication completes, so a new admission sees the cleared library', async () => {
    const hold = deferred(), entered = deferred(); let armed = false;
    const f = await fixture({ publicationHook: async stage => { if (armed && stage === 'before_pointer_rename') { entered.resolve(); await hold.promise; } } });
    const preview = await f.plan('purge'); armed = true;
    const commit = f.service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true });
    await entered.promise;
    let admissionStarted = false;
    const admission = f.gate.run(async () => { admissionStarted = true; return (await f.service.read()).data.entries.length; });
    await Promise.resolve(); expect(admissionStarted).toBe(false);
    hold.resolve(); await expect(commit).resolves.toMatchObject({ action: 'purge' });
    await expect(admission).resolves.toBe(0);
  });

  it('replays committed receipts before consulting a now-unavailable task store, including after restart', async () => {
    const f = await fixture(), preview = await f.plan('purge');
    const request = { planId: preview.planId, confirmHistoryRemoval: true };
    const receipt = await f.service.commitMaintenance('owner', request); f.inspect.mockClear().mockRejectedValue(new Error('offline'));
    expect(await f.service.commitMaintenance('owner', request)).toEqual(receipt); expect(f.inspect).not.toHaveBeenCalled();
    await f.service.dispose();
    const inspect = vi.fn(async (): Promise<KnowledgeReferenceInventory> => { throw new Error('offline'); });
    const reopened = new KnowledgeService(f.root, {}, { gate: new KnowledgeTaskSerialGate(), inspect }); services.push(reopened);
    expect(await reopened.commitMaintenance('owner', request)).toEqual(receipt); expect(inspect).not.toHaveBeenCalled();
  });

  it('does not poison the gate after a rejected operation', async () => {
    const gate = new KnowledgeTaskSerialGate();
    await expect(gate.run(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
