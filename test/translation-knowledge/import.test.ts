import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas';
import { knowledgeFixture } from './fixtures';

const roots: string[] = [];
const services: KnowledgeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function service() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-knowledge-import-')); roots.push(root);
  const value = new KnowledgeService(root); services.push(value);
  await value.read();
  return value;
}
const text = (data: KnowledgePackage) => JSON.stringify(data);
async function importAll(target: KnowledgeService, data = knowledgeFixture()) {
  const preview = await target.planImport('owner', text(data));
  return target.commitImport('owner', { planId: preview.planId, collections: [], conflict: 'keep_local', presets: 'add' });
}

describe('knowledge import', () => {
  it('previews new collections with their entry counts and imports them with their identities', async () => {
    const target = await service();
    const data = knowledgeFixture();
    const preview = await target.planImport('owner', text(data));
    expect(preview.packageName).toBe(data.package.name);
    expect(preview.collections).toEqual(data.collections.map(collection => {
      const count = data.entries.filter(entry => entry.collectionId === collection.id).length;
      return { id: collection.id, name: collection.name, languagePair: collection.languagePair, status: 'new', entries: count, added: count, changed: 0, unchanged: 0 };
    }));
    expect(preview.presets).toEqual([{ id: data.presets[0].id, name: data.presets[0].name, status: 'new' }]);
    const receipt = await target.commitImport('owner', { planId: preview.planId, collections: [], conflict: 'keep_local', presets: 'add' });
    expect(receipt).toMatchObject({ collectionIds: data.collections.map(item => item.id), added: data.entries.length, updated: 0, skipped: 0, generation: 1 });
    const library = await target.read();
    expect(library.data.collections).toEqual(data.collections);
    expect(library.data.entries).toEqual(data.entries);
    expect(library.data.presets).toEqual(data.presets);
  });

  it('merges into an existing collection, keeping local changes or using the incoming ones', async () => {
    for (const conflict of ['keep_local', 'use_incoming'] as const) {
      const target = await service();
      await importAll(target);
      const local = await target.read();
      const [game] = local.data.collections;
      const localEntry = local.data.entries.find(entry => entry.collectionId === game.id && entry.kind === 'term')!;
      const edited = await target.saveRecords({ generation: local.generation, items: [{ group: 'entries', record: { ...localEntry, enabled: false } }] });
      const incoming = knowledgeFixture();
      const added = { ...incoming.entries[0], id: randomUUID(), payload: { ...incoming.entries[0].payload, source: 'campfire', target: '篝火' } } as KnowledgePackage['entries'][number];
      incoming.entries.push(added);
      const preview = await target.planImport('owner', text(incoming));
      expect(preview.collections[0]).toMatchObject({ id: game.id, status: 'existing', added: 1, changed: 1 });
      const receipt = await target.commitImport('owner', { planId: preview.planId, collections: [{ id: game.id, action: 'merge' }, ...preview.collections.slice(1).map(item => ({ id: item.id, action: 'skip' as const }))], conflict, presets: 'skip' });
      const after = await target.read();
      expect(after.data.entries.find(entry => entry.id === added.id)).toMatchObject({ collectionId: game.id, revision: 1 });
      const merged = after.data.entries.find(entry => entry.id === localEntry.id)!;
      if (conflict === 'keep_local') { expect(merged).toEqual(edited.data.entries.find(entry => entry.id === localEntry.id)); expect(receipt.updated).toBe(0); }
      else { expect(merged).toMatchObject({ enabled: true, revision: 3 }); expect(receipt.updated).toBe(1); }
      await target.dispose(); services.splice(services.indexOf(target), 1);
    }
  });

  it('imports a collection as a copy with new identities and rewritten preset references', async () => {
    const target = await service();
    await importAll(target);
    const data = knowledgeFixture();
    const preview = await target.planImport('owner', text(data));
    const receipt = await target.commitImport('owner', { planId: preview.planId, collections: preview.collections.map(item => ({ id: item.id, action: 'copy' as const })), conflict: 'keep_local', presets: 'add' });
    const library = await target.read();
    expect(library.data.collections).toHaveLength(data.collections.length * 2);
    expect(receipt.collectionIds.every(id => !data.collections.some(item => item.id === id))).toBe(true);
    expect(library.data.entries).toHaveLength(data.entries.length * 2);
    expect(library.data.presets).toEqual(data.presets);
  });

  it('skips collections the user does not want and rejects decisions outside the preview', async () => {
    const target = await service();
    const data = knowledgeFixture();
    const preview = await target.planImport('owner', text(data));
    await expect(target.commitImport('owner', { planId: preview.planId, collections: [{ id: randomUUID(), action: 'skip' }], conflict: 'keep_local', presets: 'skip' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(target.commitImport('owner', { planId: preview.planId, collections: [{ id: data.collections[0].id, action: 'merge' }], conflict: 'keep_local', presets: 'skip' })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'IMPORT_ACTION' })] });
    const receipt = await target.commitImport('owner', { planId: preview.planId, collections: data.collections.map(item => ({ id: item.id, action: 'skip' as const })), conflict: 'keep_local', presets: 'skip' });
    expect(receipt).toMatchObject({ added: 0, skipped: data.entries.length, collectionIds: [] });
    expect((await target.read()).data.collections).toEqual([]);
  });

  it('returns the same receipt for a repeated commit and rejects changed decisions', async () => {
    const target = await service();
    const preview = await target.planImport('owner', text(knowledgeFixture()));
    const request = { planId: preview.planId, collections: [], conflict: 'keep_local' as const, presets: 'add' as const };
    const first = await target.commitImport('owner', request);
    expect(await target.commitImport('owner', request)).toEqual(first);
    await expect(target.commitImport('owner', { ...request, presets: 'skip' })).rejects.toMatchObject({ code: 'import_conflict' });
    expect((await target.read()).generation).toBe(1);
  });

  it('expires plans when the library changes, after 15 minutes, or for another owner', async () => {
    const target = await service();
    const preview = await target.planImport('owner', text(knowledgeFixture()));
    await expect(target.commitImport('other', { planId: preview.planId, collections: [], conflict: 'keep_local', presets: 'add' })).rejects.toMatchObject({ code: 'access_denied' });
    const library = await target.read();
    await target.saveRecords({ generation: library.generation, items: [{ group: 'collections', record: { id: randomUUID(), revision: 1, name: 'Other', description: '', languagePair: { source: 'ja', target: 'zh-Hans' }, archived: false } }] });
    await expect(target.commitImport('owner', { planId: preview.planId, collections: [], conflict: 'keep_local', presets: 'add' })).rejects.toMatchObject({ code: 'plan_expired' });
    target.releaseOwner('owner');
    await expect(target.planImport('owner', text(knowledgeFixture()))).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('rejects other schema versions and malformed files without changing the library', async () => {
    const target = await service();
    await expect(target.planImport('owner', text({ ...knowledgeFixture(), schemaVersion: 1 } as unknown as KnowledgePackage))).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA_VERSION' })] });
    await expect(target.planImport('owner', '{"format":')).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'JSON_SYNTAX' })] });
    expect((await target.read()).generation).toBe(0);
  });
});
