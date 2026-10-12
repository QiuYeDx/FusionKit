import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import type { Collection, Entry, Preset } from '../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

const roots: string[] = [];
const services: KnowledgeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
export async function knowledgeService() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-knowledge-')); roots.push(root);
  const service = new KnowledgeService(root); services.push(service);
  return { service, root, snapshot: await service.read() };
}
const pair = { source: 'en', target: 'zh-Hans' };
export const collection = (name = 'Game X', overrides: Partial<Collection> = {}): Collection => ({ id: randomUUID(), revision: 1, name, description: '', languagePair: pair, archived: false, ...overrides });
export const term = (collectionId: string, source = 'checkpoint', target = '存档点'): Entry => ({ id: randomUUID(), revision: 1, collectionId, enabled: true, kind: 'term', payload: { source, target, aliases: [], note: '', strength: 'preferred', match: { mode: 'whole_term', caseSensitive: false } } });
export const rule = (collectionId: string, text = 'Keep it short.'): Entry => ({ id: randomUUID(), revision: 1, collectionId, enabled: true, kind: 'rule', payload: { text, required: false } });
export const preset = (collectionIds: string[], name = 'Daily'): Preset => ({ id: randomUUID(), revision: 1, name, languagePair: pair, collectionIds, instructions: '', context: '' });
async function seeded() {
  const fixture = await knowledgeService();
  const game = collection('Game X'), common = collection('Common');
  const entries = [term(game.id), rule(game.id), term(common.id, 'boss', '首领')];
  const daily = preset([game.id, common.id]);
  const snapshot = await fixture.service.saveRecords({ generation: fixture.snapshot.generation, items: [
    { group: 'collections', record: game }, { group: 'collections', record: common },
    ...entries.map(record => ({ group: 'entries' as const, record })), { group: 'presets', record: daily },
  ] });
  return { ...fixture, snapshot, game, common, entries, daily };
}
const find = (snapshot: LibrarySnapshot, id: string) => [...snapshot.data.collections, ...snapshot.data.entries, ...snapshot.data.presets].find(item => item.id === id);

describe('knowledge service records', () => {
  it('saves collections, entries and presets in one transaction and keeps them as sent', async () => {
    const { snapshot, game, entries, daily } = await seeded();
    expect(snapshot.generation).toBe(1);
    expect(snapshot.data.collections.map(item => item.id)).toContain(game.id);
    expect(snapshot.data.entries).toEqual(entries);
    expect(snapshot.data.presets).toEqual([daily]);
    expect(Object.keys(snapshot)).toEqual(['generation', 'data']);
  });

  it('saves disabled entries as disabled and never queues manual content for review', async () => {
    const { service, snapshot, game } = await seeded();
    const disabled = { ...term(game.id, 'relic', '遗物'), enabled: false };
    const next = await service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: disabled }] });
    expect(find(next, disabled.id)).toEqual(disabled);
  });

  it('requires the current revision, increments it on change and ignores identical saves', async () => {
    const { service, snapshot, entries } = await seeded();
    const edited = { ...entries[0], payload: { ...entries[0].payload, target: '检查点' } } as Entry;
    const next = await service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: edited }] });
    expect(find(next, edited.id)).toMatchObject({ revision: 2, payload: { target: '检查点' } });
    const same = await service.saveRecords({ generation: next.generation, items: [{ group: 'entries', record: find(next, edited.id) as Entry }] });
    expect(same.generation).toBe(next.generation);
    await expect(service.saveRecords({ generation: next.generation, items: [{ group: 'entries', record: edited }] })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: find(next, edited.id) as Entry }] })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(service.saveRecords({ generation: next.generation, items: [{ group: 'entries', record: { ...term(entries[0].collectionId), revision: 2 } }] })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'NEW_RECORD_REVISION' })] });
  });

  it('writes nothing when any item in a batch is invalid and reports its index', async () => {
    const { service, snapshot, game } = await seeded();
    const good = term(game.id, 'boss', '头目');
    const orphan = term(randomUUID());
    await expect(service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: good }, { group: 'entries', record: orphan }] })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'MISSING_REFERENCE' })] });
    await expect(service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: good }, { group: 'entries', record: { ...good, kind: 'memory' } as never }] })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ path: expect.stringMatching(/^\/items\/1\/record/) })] });
    await expect(service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: good }, { group: 'entries', record: good }] })).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'DUPLICATE_BATCH_RECORD' })] });
    await expect(service.saveRecords({ generation: snapshot.generation, items: Array.from({ length: 201 }, () => ({ group: 'entries' as const, record: term(game.id) })) })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await service.read()).generation).toBe(snapshot.generation);
  });

  it('deletes a collection with its entries and its place in presets, returning everything for undo', async () => {
    const { service, snapshot, game, common, entries, daily } = await seeded();
    const result = await service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'collections', id: game.id }] });
    expect(result.snapshot.data.collections.map(item => item.id)).toEqual([common.id]);
    expect(result.snapshot.data.entries.map(item => item.id)).toEqual([entries[2].id]);
    expect(result.snapshot.data.presets[0]).toMatchObject({ id: daily.id, collectionIds: [common.id], revision: 2 });
    expect(result.deleted).toEqual({ collections: [game], entries: [entries[0], entries[1]], presets: [daily] });

    const restored = await service.restoreRecords({ generation: result.snapshot.generation, records: result.deleted });
    expect(find(restored, game.id)).toEqual(game);
    expect(restored.data.entries).toEqual(expect.arrayContaining([entries[0], entries[1]]));
    expect(find(restored, daily.id)).toEqual({ ...daily, revision: 3 });
  });

  it('deletes and restores individual entries and presets', async () => {
    const { service, snapshot, entries, daily } = await seeded();
    const result = await service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'entries', id: entries[0].id }, { group: 'presets', id: daily.id }] });
    expect(find(result.snapshot, entries[0].id)).toBeUndefined();
    expect(result.snapshot.data.presets).toEqual([]);
    const restored = await service.restoreRecords({ generation: result.snapshot.generation, records: result.deleted });
    expect(find(restored, entries[0].id)).toEqual(entries[0]);
    expect(find(restored, daily.id)).toEqual(daily);
  });

  it('refuses unknown deletions and undo that would collide or orphan entries', async () => {
    const { service, snapshot, game, entries } = await seeded();
    await expect(service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'collections', id: entries[0].id }] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'entries', id: randomUUID() }] })).rejects.toMatchObject({ code: 'not_found' });
    const result = await service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'entries', id: entries[0].id }] });
    const recreated = await service.saveRecords({ generation: result.snapshot.generation, items: [{ group: 'entries', record: entries[0] }] });
    await expect(service.restoreRecords({ generation: recreated.generation, records: result.deleted })).rejects.toMatchObject({ code: 'import_conflict', diagnostics: [expect.objectContaining({ code: 'RESTORE_ID_EXISTS' })] });
    const removed = await service.deleteRecords({ generation: recreated.generation, items: [{ group: 'collections', id: game.id }] });
    await expect(service.restoreRecords({ generation: removed.snapshot.generation, records: { collections: [], entries: removed.deleted.entries, presets: [] } })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'MISSING_REFERENCE' })]) });
    expect((await service.read()).generation).toBe(removed.snapshot.generation);
  });

  it('rejects stale generations for every write', async () => {
    const { service, snapshot, game, entries } = await seeded();
    await service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: rule(game.id, 'New') }] });
    await expect(service.saveRecords({ generation: snapshot.generation, items: [{ group: 'entries', record: rule(game.id) }] })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(service.deleteRecords({ generation: snapshot.generation, items: [{ group: 'entries', id: entries[0].id }] })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(service.restoreRecords({ generation: snapshot.generation, records: { collections: [], entries: [rule(game.id)], presets: [] } })).rejects.toMatchObject({ code: 'revision_conflict' });
  });
});
