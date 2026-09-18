import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { emptyPackage, type RepositoryOptions, type PublicationStage } from '../../electron/main/translation-knowledge/repository';
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas';
import type { MaintenanceRequest, RecordTarget } from '../../src/translation-knowledge/maintenance-contract';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';

const fixtureRoots: string[] = [], services: KnowledgeService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options: RepositoryOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-maintenance-')); fixtureRoots.push(root);
  const service = new KnowledgeService(root, options); services.push(service); await service.read();
  return { root, service };
}
function data(): KnowledgePackage {
  const result = emptyPackage();
  const subjectId = randomUUID(), collectionId = randomUUID(), sourceId = randomUUID();
  result.subjects = [{ id: subjectId, revision: 1, kind: 'work', name: 'Work', description: '', archived: false, aliases: [], tags: [] }];
  result.collections = [{ id: collectionId, revision: 1, name: 'Collection', description: '', aboutSubjectIds: [subjectId], archived: false }];
  result.sources = [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Evidence', excerpt: 'PRIVATE-MAINTENANCE-EVIDENCE-6142' }];
  result.entries = [{ id: randomUUID(), revision: 1, kind: 'term', title: 'Term', collectionId, aboutSubjectIds: [subjectId], scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } }, state: 'ready', evidence: [{ sourceId, support: 'direct' }], derivedFrom: [], payload: { source: 'Council', target: '议会', aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'preferred' } }];
  return result;
}
async function imported(service: KnowledgeService, content = data(), adoptReady = true) {
  const preview = await service.planImport('owner', JSON.stringify(content));
  const request = { planId: preview.planId, decisions: [], adoptReady };
  const receipt = await service.commitImport('owner', request);
  return { content, receipt, request };
}
async function maintenance(service: KnowledgeService, request: Omit<Extract<MaintenanceRequest, { action: 'archive' | 'restore' | 'purge' }>, 'generation'>) {
  const current = await service.read();
  const preview = await service.planMaintenance('owner', { ...request, generation: current.generation });
  const receipt = await service.commitMaintenance('owner', { planId: preview.planId, ...(request.action === 'purge' ? { confirmHistoryRemoval: true } : {}) });
  return { preview, receipt };
}
async function archiveEntries(service: KnowledgeService, content: KnowledgePackage) {
  return maintenance(service, { action: 'archive', targets: content.entries.map(entry => ({ group: 'entries', id: entry.id })) });
}
const bytesDigest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('knowledge maintenance', () => {
  it('previews dependent pauses and restores catalogs without reviving approvals', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    const archived = await maintenance(service, { action: 'archive', targets: [{ group: 'collections', id: content.collections[0].id }] });
    expect(archived.preview.taskTracking).toBe('not_connected');
    expect(archived.preview.items).toContainEqual(expect.objectContaining({ id: content.entries[0].id, effect: 'review', reason: 'dependency' }));
    let current = await service.read();
    expect(current.data.entries[0]).toMatchObject({ state: 'needs_review', revision: 2 }); expect(current.approvals).toEqual({});
    await maintenance(service, { action: 'restore', targets: [{ group: 'collections', id: content.collections[0].id }] });
    current = await service.read(); expect(current.data.collections[0]).toMatchObject({ archived: false, revision: 3 }); expect(current.approvals).toEqual({});
  });

  it('archives display-only subjects without pausing their entries and restores entries for review', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    await maintenance(service, { action: 'archive', targets: [{ group: 'subjects', id: content.subjects[0].id }] });
    expect((await service.read()).approvals[content.entries[0].id]).toBeDefined();
    await archiveEntries(service, content);
    await maintenance(service, { action: 'restore', targets: [{ group: 'entries', id: content.entries[0].id }] });
    const current = await service.read(); expect(current.data.entries[0]).toMatchObject({ state: 'needs_review', revision: 3 }); expect(current.approvals).toEqual({});
  });

  it('retains all import changes and undoes them using compensation revisions without replay resurrection', async () => {
    const { service, root } = await fixture(); const { content, receipt, request } = await imported(service);
    let current = await service.read(); expect(current.maintenance?.undoableImportIds).toEqual([receipt.id]);
    const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: receipt.id });
    expect(preview.canCommit).toBe(true); expect(preview.items).toContainEqual(expect.objectContaining({ group: 'sources', effect: 'retain', reason: 'retained_source' }));
    const undoRequest = { planId: preview.planId };
    const undone = await service.commitMaintenance('owner', undoRequest);
    expect(await service.commitMaintenance('owner', undoRequest)).toEqual(undone);
    expect(await service.commitImport('owner', request)).toEqual(receipt);
    current = await service.read();
    expect(current.data.entries[0]).toMatchObject({ id: content.entries[0].id, state: 'archived', revision: 2 });
    expect(current.data.collections[0].archived).toBe(true); expect(current.data.sources).toEqual(content.sources); expect(current.approvals).toEqual({});
    expect(current.maintenance?.undoneImportIds).toEqual([receipt.id]);
    await service.dispose(); const restarted = new KnowledgeService(root); services.push(restarted);
    expect(await restarted.commitMaintenance('owner', undoRequest)).toEqual(undone);
    await expect(restarted.commitMaintenance('another-owner', undoRequest)).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('blocks undo after a later content edit or an approval-only change', async () => {
    for (const mode of ['content', 'approval'] as const) {
      const { service } = await fixture(); const { receipt } = await imported(service, data(), false);
      let current = await service.read();
      await service.saveRecord({ generation: current.generation, group: 'entries', record: mode === 'content' ? { ...current.data.entries[0], title: 'Later correction' } : current.data.entries[0], ...(mode === 'approval' ? { adopt: true } : {}) });
      current = await service.read();
      const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: receipt.id });
      expect(preview.canCommit).toBe(false); expect(preview.items.some(item => item.reason === 'later_edit')).toBe(true);
      await expect(service.commitMaintenance('owner', { planId: preview.planId })).rejects.toMatchObject({ code: 'import_conflict' });
      expect(await service.read()).toEqual(current);
    }
  });

  it('blocks undo when a new recipe references imported knowledge and preserves unrelated edits', async () => {
    const { service } = await fixture(); const { content, receipt } = await imported(service);
    let current = await service.read();
    await service.saveRecord({ generation: current.generation, group: 'recipes', record: { id: randomUUID(), revision: 1, name: 'Later recipe', description: '', archived: false, languagePair: { source: 'en', target: 'zh-Hans' }, readCollectionIds: [content.collections[0].id], subjectSuggestions: [], modifierStyleIds: [], instructions: '', context: '', inheritGlobalPreferences: true, learningSuggestion: 'off' } });
    current = await service.read();
    const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: receipt.id });
    expect(preview.items.some(item => item.reason === 'new_reference')).toBe(true); expect(preview.canCommit).toBe(false);
    expect((await service.read()).data.recipes[0].name).toBe('Later recipe');
  });

  it('restores updated records at a new revision and never restores old human trust', async () => {
    const { service } = await fixture(); const first = await imported(service);
    const incoming = structuredClone(first.content); incoming.entries[0].title = 'Updated externally'; incoming.entries[0].revision = 5;
    const preview = await service.planImport('owner', JSON.stringify(incoming));
    const importedUpdate = await service.commitImport('owner', { planId: preview.planId, decisions: [{ id: incoming.entries[0].id, action: 'replace' }], adoptReady: false });
    const current = await service.read(); expect(current.data.entries[0].revision).toBe(6);
    const undo = await service.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: importedUpdate.id });
    expect(undo.canCommit).toBe(true); await service.commitMaintenance('owner', { planId: undo.planId });
    const after = await service.read(); expect(after.data.entries[0]).toMatchObject({ title: first.content.entries[0].title, revision: 7, state: 'needs_review' }); expect(after.approvals).toEqual({});
  });

  it('includes evidence-driven invalidation in undo and preserves a later unrelated record', async () => {
    const { service } = await fixture(); const first = await imported(service);
    const incoming = structuredClone(first.content); incoming.sources[0].revision = 2; incoming.sources[0].excerpt = 'Changed evidence';
    const importPreview = await service.planImport('owner', JSON.stringify(incoming));
    const update = await service.commitImport('owner', { planId: importPreview.planId, decisions: [{ id: incoming.sources[0].id, action: 'replace' }], adoptReady: false });
    let current = await service.read(); expect(current.data.entries[0].state).toBe('needs_review');
    await service.saveRecord({ generation: current.generation, group: 'preferenceTemplates', record: { id: randomUUID(), revision: 1, name: 'Unrelated later record', instructions: 'Leave this in place.', archived: false } });
    current = await service.read();
    const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: update.id });
    expect(preview.canCommit).toBe(true); expect(preview.items.some(item => item.id === incoming.entries[0].id && item.effect === 'restore')).toBe(true);
    await service.commitMaintenance('owner', { planId: preview.planId });
    const after = await service.read(); expect(after.data.sources[0]).toMatchObject({ excerpt: first.content.sources[0].excerpt, revision: 4 });
    expect(after.data.entries[0]).toMatchObject({ state: 'needs_review', revision: 3 }); expect(after.data.preferenceTemplates[0].name).toBe('Unrelated later record'); expect(after.approvals).toEqual({});
  });

  it('distinguishes legacy imports whose undo evidence was never persisted', async () => {
    const { service, root } = await fixture(); const { receipt } = await imported(service); await service.dispose();
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    const stored = JSON.parse(await readFile(path.join(root, pointer.file), 'utf8'));
    stored.format = 1; delete stored.importChanges; delete stored.maintenanceCommits; delete stored.undoneImportIds; delete stored.cleanupPending;
    const bytes = JSON.stringify(stored); pointer.digest = bytesDigest(bytes); await writeFile(path.join(root, pointer.file), bytes); await writeFile(path.join(root, 'current.json'), JSON.stringify(pointer));
    const restarted = new KnowledgeService(root); services.push(restarted);
    const current = await restarted.read(); expect(current.maintenance?.undoableImportIds).toEqual([]);
    const preview = await restarted.planMaintenance('owner', { generation: current.generation, action: 'undo_import', importId: receipt.id });
    expect(preview.canCommit).toBe(false); expect(preview.blockers[0].code).toBe('LEGACY_IMPORT_NO_UNDO');
  });

  it('purges selected archived records and every historical copy while preserving other current knowledge', async () => {
    const { service, root } = await fixture(); const { content, request, receipt } = await imported(service);
    let current = await service.read();
    await service.saveRecord({ generation: current.generation, group: 'preferenceTemplates', record: { id: randomUUID(), revision: 1, name: 'Keep me', instructions: 'Preserve current unrelated knowledge.', archived: false } });
    await archiveEntries(service, content);
    const targets: RecordTarget[] = [{ group: 'entries', id: content.entries[0].id }, { group: 'sources', id: content.sources[0].id }];
    current = await service.read(); const keptMetadata = structuredClone(current.data.extensions); const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets });
    expect(preview.canCommit).toBe(true); expect(preview.history).toMatchObject({ scope: 'all', importsLosingUndo: 1 }); expect(preview.history.snapshots).toBeGreaterThan(2);
    await expect(service.commitMaintenance('owner', { planId: preview.planId })).rejects.toMatchObject({ code: 'invalid_input' });
    const purgeRequest = { planId: preview.planId, confirmHistoryRemoval: true };
    const purged = await service.commitMaintenance('owner', purgeRequest); expect(purged.cleanupPending).toBe(false);
    expect(await service.commitMaintenance('owner', purgeRequest)).toEqual(purged);
    expect(await service.commitImport('owner', request)).toEqual(receipt);
    current = await service.read(); expect(current.data.entries).toEqual([]); expect(current.data.sources).toEqual([]); expect(current.data.preferenceTemplates[0].name).toBe('Keep me'); expect(current.maintenance?.undoableImportIds).toEqual([]); expect(current.data.extensions).toEqual(keptMetadata);
    const files = await readdir(root); expect(files.filter(name => name.startsWith('generation-'))).toHaveLength(1);
    for (const name of files) expect(await readFile(path.join(root, name), 'utf8')).not.toContain('PRIVATE-MAINTENANCE-EVIDENCE-6142');
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')); expect(pointer.previous).toBeUndefined();
  });

  it('refuses active targets and referenced records, and shows independently retained sources', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    let current = await service.read();
    let preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    expect(preview.blockers.some(item => item.code === 'PURGE_ARCHIVE_FIRST')).toBe(true);
    preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'sources', id: content.sources[0].id }] });
    expect(preview.blockers.some(item => item.code === 'PURGE_REFERENCED')).toBe(true);
    await archiveEntries(service, content); current = await service.read();
    preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    expect(preview.items).toContainEqual(expect.objectContaining({ id: content.sources[0].id, effect: 'retain', reason: 'retained_source' }));
  });

  it('directly deletes an empty active collection only after explicit history confirmation', async () => {
    const { service } = await fixture(); const content = data(); content.entries = [];
    await imported(service, content);
    const before = await service.read();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'collections', id: content.collections[0].id }], includeCollectionContents: true });
    expect(preview.canCommit).toBe(true);
    expect(preview.items.filter(item => item.effect === 'purge')).toEqual([expect.objectContaining({ group: 'collections', id: content.collections[0].id })]);
    expect(await service.read()).toEqual(before);
    await expect(service.commitMaintenance('owner', { planId: preview.planId })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await service.read()).toEqual(before);
    await service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true });
    const after = await service.read();
    expect(after.data.collections).toEqual([]); expect(after.data.sources).toEqual(content.sources);
  });

  it('expands all collection entry states atomically and retains sources and unrelated current knowledge', async () => {
    const { service, root } = await fixture(); const content = data();
    content.entries = (['ready', 'candidate', 'needs_review', 'rejected', 'archived'] as const).map(state => ({ ...structuredClone(content.entries[0]), id: randomUUID(), title: state, state }));
    const keptCollection = { ...structuredClone(content.collections[0]), id: randomUUID(), name: 'Keep collection' };
    const keptEntry = { ...structuredClone(content.entries[0]), id: randomUUID(), collectionId: keptCollection.id, title: 'Keep entry' };
    content.collections.push(keptCollection); content.entries.push(keptEntry);
    await imported(service, content);
    const before = await service.read();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'collections', id: content.collections[0].id }], includeCollectionContents: true });
    expect(preview.canCommit).toBe(true);
    expect(preview.items.filter(item => item.effect === 'purge')).toHaveLength(6);
    expect(preview.items).toContainEqual(expect.objectContaining({ group: 'sources', id: content.sources[0].id, effect: 'retain', reason: 'retained_source' }));
    expect(await service.read()).toEqual(before);
    const request = { planId: preview.planId, confirmHistoryRemoval: true };
    const receipt = await service.commitMaintenance('owner', request);
    expect(receipt).toMatchObject({ changed: 6, cleanupPending: false });
    expect(await service.commitMaintenance('owner', request)).toEqual(receipt);
    const after = await service.read();
    expect(after.data.collections).toEqual([keptCollection]); expect(after.data.entries).toEqual([keptEntry]);
    expect(after.data.sources).toEqual(content.sources); expect(after.data.subjects).toEqual(content.subjects);
    expect(Object.keys(after.approvals)).toEqual([keptEntry.id]);
    expect(after.maintenance?.undoableImportIds).toEqual([]);
    await service.dispose(); const restarted = new KnowledgeService(root); services.push(restarted);
    expect(await restarted.commitMaintenance('owner', request)).toEqual(receipt);
  });

  it.each(['recipe', 'derived_entry'] as const)('blocks collection deletion with an external %s reference without changing any archive or approval state', async reference => {
    const { service } = await fixture(); const content = data();
    if (reference === 'recipe') content.recipes.push({ id: randomUUID(), revision: 1, name: 'Saved settings', description: '', archived: false, languagePair: { source: 'en', target: 'zh-Hans' }, readCollectionIds: [content.collections[0].id], subjectSuggestions: [], modifierStyleIds: [], instructions: '', context: '', inheritGlobalPreferences: true, learningSuggestion: 'off' });
    else {
      const otherCollection = { ...structuredClone(content.collections[0]), id: randomUUID(), name: 'Other collection' };
      content.collections.push(otherCollection);
      content.entries.push({ ...structuredClone(content.entries[0]), id: randomUUID(), collectionId: otherCollection.id, derivedFrom: [{ entryId: content.entries[0].id, revision: 1, digest: sha256Canonical(content.entries[0]), evidenceSourceId: content.sources[0].id }] });
    }
    await imported(service, content);
    const before = await service.read();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'collections', id: content.collections[0].id }], includeCollectionContents: true });
    expect(preview.canCommit).toBe(false); expect(preview.blockers.some(item => item.code === 'PURGE_REFERENCED')).toBe(true);
    await expect(service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'import_conflict' });
    expect(await service.read()).toEqual(before);
  });

  it('expires collection deletion after its member content changes', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    const before = await service.read();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'collections', id: content.collections[0].id }], includeCollectionContents: true });
    const added = { ...structuredClone(content.entries[0]), id: randomUUID(), title: 'Added after preview' };
    await service.saveRecord({ generation: before.generation, group: 'entries', record: added, adopt: true });
    const afterAdd = await service.read();
    await expect(service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'plan_expired' });
    expect(await service.read()).toEqual(afterAdd);
  });

  it('restricts collection-content deletion to explicit collection roots and preserves ordinary purge rules', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    const generation = (await service.read()).generation;
    await expect(service.planMaintenance('owner', { generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }], includeCollectionContents: true })).rejects.toMatchObject({ code: 'invalid_input' });
    const preview = await service.planMaintenance('owner', { generation, action: 'purge', targets: [{ group: 'collections', id: content.collections[0].id }, { group: 'entries', id: content.entries[0].id }] });
    expect(preview.canCommit).toBe(false); expect(preview.blockers.filter(item => item.code === 'PURGE_ARCHIVE_FIRST')).toHaveLength(2);
  });

  it.each<PublicationStage>(['generation_synced', 'purge_journal_synced', 'before_pointer_rename'])('leaves all prior history untouched when purge fails at %s', async stageToFail => {
    let fail = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (fail && stage === stageToFail) throw new Error('Injected publish fault'); } });
    const { content } = await imported(service); await archiveEntries(service, content);
    const before = await service.read(), beforeFiles = (await readdir(root)).sort();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    fail = true;
    await expect(service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'write_failed' });
    expect(await service.read()).toEqual(before); expect((await readdir(root)).sort()).toEqual(beforeFiles);
  });

  it('reports partial cleanup, fences writes and continues the same purge after restart', async () => {
    let failCleanup = false, unlinked = 0;
    const options: RepositoryOptions = { publicationHook: stage => { if (stage === 'before_history_unlink' && failCleanup && unlinked > 0) throw new Error('Locked file'); if (stage === 'history_unlinked') unlinked++; } };
    const { service, root } = await fixture(options); const { content } = await imported(service); await archiveEntries(service, content);
    const current = await service.read();
    const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }, { group: 'sources', id: content.sources[0].id }] });
    const request = { planId: preview.planId, confirmHistoryRemoval: true }; failCleanup = true;
    const receipt = await service.commitMaintenance('owner', request); expect(receipt.cleanupPending).toBe(true);
    const pending = await service.read(); expect(pending.maintenance?.cleanupPending).toBe(true); expect(pending.data.entries).toEqual([]);
    await expect(service.saveRecord({ generation: pending.generation, group: 'subjects', record: { ...pending.data.subjects[0], name: 'Blocked edit' } })).rejects.toMatchObject({ code: 'write_failed' });
    const journal = (await readdir(root)).find(name => name.startsWith('purge-'))!;
    expect(await readFile(path.join(root, journal), 'utf8')).not.toContain('PRIVATE-MAINTENANCE');
    await service.dispose(); const restarted = new KnowledgeService(root, options); services.push(restarted);
    expect((await restarted.read()).maintenance?.cleanupPending).toBe(true);
    failCleanup = false;
    expect((await restarted.read()).maintenance?.cleanupPending).toBe(false);
    const done = await restarted.commitMaintenance('owner', request); expect(done).toEqual({ ...receipt, cleanupPending: false });
    expect((await readdir(root)).filter(name => name.startsWith('generation-'))).toHaveLength(1);
  });

  it('retains cleanup authority after owner release once the sanitized pointer is published', async () => {
    let releaseAtPublication = false, service!: KnowledgeService;
    const f = await fixture({ publicationHook: stage => { if (releaseAtPublication && stage === 'pointer_renamed') service.releaseOwner('owner'); } }); service = f.service;
    const { content } = await imported(service); await archiveEntries(service, content);
    const current = await service.read(); const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    releaseAtPublication = true;
    const result = await service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true });
    expect(result.cleanupPending).toBe(false); expect((await service.read()).data.entries).toEqual([]);
    expect((await readdir(f.root)).filter(name => name.startsWith('generation-'))).toHaveLength(1);
  });

  it('recovers published purge identity after late directory-sync failure and never returns to old content', async () => {
    let failAfterPublication = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (failAfterPublication && stage === 'pointer_renamed') throw new Error('Late directory-sync failure'); } });
    const { content } = await imported(service); await archiveEntries(service, content);
    const current = await service.read(); const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }, { group: 'sources', id: content.sources[0].id }] });
    const request = { planId: preview.planId, confirmHistoryRemoval: true }; failAfterPublication = true;
    await expect(service.commitMaintenance('owner', request)).rejects.toMatchObject({ code: 'write_failed', diagnostics: [expect.objectContaining({ code: 'PUBLICATION_UNCERTAIN' })] });
    await service.dispose();
    const restarted = new KnowledgeService(root); services.push(restarted);
    const recovered = await restarted.read(); expect(recovered.data.entries).toEqual([]); expect(recovered.maintenance?.cleanupPending).toBe(false);
    const result = await restarted.commitMaintenance('owner', request); expect(result.generation).toBe(current.generation + 1); expect(result.cleanupPending).toBe(false);
    expect((await readdir(root)).filter(name => name.startsWith('generation-'))).toHaveLength(1);
  });

  it('discards an unpublished purge staging journal after restart without deleting any old history', async () => {
    const { service, root } = await fixture(); const { content } = await imported(service); await archiveEntries(service, content);
    const before = await service.read(); await service.dispose();
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    const oldFiles = await readdir(root);
    const target = { name: `generation-${before.generation + 1}-${randomUUID()}.json`, digest: '' };
    const staged = JSON.parse(await readFile(path.join(root, pointer.file), 'utf8'));
    staged.generation++; staged.data.entries = []; staged.data.sources = [];
    const bytes = JSON.stringify(staged); target.digest = bytesDigest(bytes); await writeFile(path.join(root, target.name), bytes);
    const purgeId = randomUUID();
    const oldHistory = await Promise.all(oldFiles.filter(name => name.startsWith('generation-')).map(async name => ({ name, digest: bytesDigest(await readFile(path.join(root, name), 'utf8')) })));
    await writeFile(path.join(root, `purge-${purgeId}.json`), JSON.stringify({ format: 1, id: purgeId, generation: before.generation + 1, target, files: oldHistory }));
    const restarted = new KnowledgeService(root); services.push(restarted);
    expect(await restarted.read()).toEqual(before); expect((await readdir(root)).sort()).toEqual(oldFiles.sort());
  });

  it('does not clear history if the final owner guard is revoked before pointer publication', async () => {
    let revoke = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (revoke && stage === 'before_pointer_rename') service.releaseOwner('owner'); } });
    const { content } = await imported(service); await archiveEntries(service, content);
    const before = await service.read(); const files = (await readdir(root)).sort();
    const preview = await service.planMaintenance('owner', { generation: before.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    revoke = true;
    await expect(service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true })).rejects.toMatchObject({ code: 'access_denied' });
    expect(await service.read()).toEqual(before); expect((await readdir(root)).sort()).toEqual(files);
  });

  it('fences revoked and stale maintenance plans before publication', async () => {
    const { service } = await fixture(); const { content } = await imported(service);
    const current = await service.read();
    const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'archive', targets: [{ group: 'entries', id: content.entries[0].id }] });
    await expect(service.commitMaintenance('other-owner', { planId: preview.planId })).rejects.toMatchObject({ code: 'access_denied' });
    await service.saveRecord({ generation: current.generation, group: 'subjects', record: { ...current.data.subjects[0], name: 'Edited' } });
    await expect(service.commitMaintenance('owner', { planId: preview.planId })).rejects.toMatchObject({ code: 'plan_expired' });
    const after = await service.read(); const another = await service.planMaintenance('owner', { generation: after.generation, action: 'archive', targets: [{ group: 'entries', id: content.entries[0].id }] });
    service.releaseOwner('owner'); await expect(service.commitMaintenance('owner', { planId: another.planId })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('never deletes a substituted symlink in a history cleanup manifest', async () => {
    let stopCleanup = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (stopCleanup && stage === 'before_history_unlink') throw new Error('Stop cleanup'); } });
    const { content } = await imported(service); await archiveEntries(service, content);
    const current = await service.read(); const preview = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: content.entries[0].id }] });
    stopCleanup = true; await service.commitMaintenance('owner', { planId: preview.planId, confirmHistoryRemoval: true });
    const journal = JSON.parse(await readFile(path.join(root, (await readdir(root)).find(name => name.startsWith('purge-'))!), 'utf8'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fk-purge-outside-')); fixtureRoots.push(outside);
    const outsideFile = path.join(outside, 'keep.txt'); await writeFile(outsideFile, 'Unrelated file');
    const replaced = path.join(root, journal.files[0].name); await rm(replaced); await symlink(outsideFile, replaced);
    stopCleanup = false; expect((await service.read()).maintenance?.cleanupPending).toBe(true);
    expect(await readFile(outsideFile, 'utf8')).toBe('Unrelated file'); expect((await lstat(replaced)).isSymbolicLink()).toBe(true);
  });
});
