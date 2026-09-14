import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { emptyPackage, type PublicationStage, type RepositoryOptions } from '../../electron/main/translation-knowledge/repository';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { validatePackage } from '../../src/translation-knowledge/validation';
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas';

const roots: string[] = [];
const services: KnowledgeService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: RepositoryOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-knowledge-')); roots.push(root);
  const service = new KnowledgeService(root, options); services.push(service);
  await service.read();
  return { service, root };
}
function example(): KnowledgePackage {
  const data = emptyPackage();
  const subjectId = randomUUID(), collectionId = randomUUID(), sourceId = randomUUID();
  const languagePair = { source: 'en', target: 'zh-Hans' };
  data.subjects = [{ id: subjectId, revision: 1, kind: 'work', name: 'Example', aliases: [], tags: [], description: '', archived: false }];
  data.collections = [{ id: collectionId, revision: 1, name: 'Example collection', description: '', aboutSubjectIds: [subjectId], archived: false, defaultLanguagePair: languagePair }];
  data.sources = [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Editorial note', excerpt: 'Reviewed wording for this example.' }];
  const base = { revision: 1, title: 'Example', collectionId, aboutSubjectIds: [subjectId], scope: { languagePair, requiredSubjects: [{ subjectId, role: 'topic' as const }], condition: { mode: 'none' as const } }, state: 'ready' as const, evidence: [{ sourceId, support: 'direct' as const }], derivedFrom: [] };
  data.entries = [
    { ...base, id: randomUUID(), kind: 'term', payload: { source: 'Council', target: '议会', aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'preferred' } },
    { ...base, id: randomUUID(), kind: 'context', payload: { text: 'The council meets in winter.', assertion: 'reported', core: false } },
    { ...base, id: randomUUID(), kind: 'expression', payload: { sourcePhrase: 'the long winter', interpretation: 'a difficult period', targetExamples: ['漫长寒冬'], mustNotInventOccurrences: true } },
    { ...base, id: randomUUID(), kind: 'memory', payload: { source: 'Winter has come.', target: '冬天到了。', alignment: 'one_to_one', directReuseAllowed: false } },
    { ...base, id: randomUUID(), kind: 'rule', payload: { dimension: 'register', text: 'Use concise spoken language.', strength: 'preferred' } },
  ];
  data.styles = [{ id: randomUUID(), revision: 1, name: 'Concise', description: '', archived: false, languagePair, ruleEntryIds: [data.entries[4].id] }];
  data.recipes = [{ id: randomUUID(), revision: 1, name: 'Winter', description: '', archived: false, languagePair, readCollectionIds: [collectionId], subjectSuggestions: [{ subjectId, role: 'topic' }], baseStyleId: data.styles[0].id, modifierStyleIds: [], instructions: '', context: '', inheritGlobalPreferences: true, learningSuggestion: 'save_reviewed', suggestedDestinationCollectionId: collectionId }];
  data.preferenceTemplates = [{ id: randomUUID(), revision: 1, archived: true, name: 'Example preference', instructions: 'Keep punctuation consistent.' }];
  data.extensions = { 'org.example.metadata': { verified: false, labels: ['portable'] } };
  data.entries[0].extensions = { 'org.example.editorial': { color: 'blue' } };
  expect(validatePackage(data).errors).toEqual([]);
  return data;
}
async function importData(service: KnowledgeService, data = example(), adoptReady = false, owner = 'owner-a') {
  const preview = await service.planImport(owner, JSON.stringify(data));
  const request = { planId: preview.planId, decisions: [], adoptReady };
  const receipt = await service.commitImport(owner, request);
  return { data, preview, request, receipt };
}

describe('translation knowledge service', () => {
  it('round-trips every v1 entity, status, reference and inert extension without exporting approval credentials', async () => {
    const first = await fixture(), second = await fixture();
    const data = example(); data.entries[1].state = 'candidate'; data.entries[2].state = 'archived';
    await importData(first.service, data, true);
    const original = await first.service.read();
    expect(Object.keys(original.approvals)).toHaveLength(3);
    const backup = await first.service.exportPackage({ generation: original.generation, purpose: 'backup', collectionIds: [], includeMemories: false });
    expect(backup).not.toHaveProperty('approvals');
    expect(backup.entries).toEqual(data.entries);
    expect(backup.extensions).toMatchObject(data.extensions!);
    await importData(second.service, backup);
    const restored = await second.service.read();
    for (const group of ['subjects', 'collections', 'sources', 'entries', 'styles', 'recipes', 'preferenceTemplates'] as const) expect(restored.data[group]).toEqual(original.data[group]);
    expect(restored.approvals).toEqual({});
  });

  it('persists one import receipt across concurrent retries and restart; owner and decisions remain bound', async () => {
    const { service, root } = await fixture();
    const preview = await service.planImport('owner-a', JSON.stringify(example()));
    const request = { planId: preview.planId, decisions: [], adoptReady: true };
    const results = await Promise.all([service.commitImport('owner-a', request), service.commitImport('owner-a', request)]);
    expect(results[0]).toEqual(results[1]); expect((await service.read()).generation).toBe(1);
    await service.dispose();
    const restarted = new KnowledgeService(root); services.push(restarted);
    expect(await restarted.commitImport('owner-a', request)).toEqual(results[0]);
    await expect(restarted.commitImport('other-owner', request)).rejects.toMatchObject({ code: 'access_denied' });
    await expect(restarted.commitImport('owner-a', { ...request, adoptReady: false })).rejects.toMatchObject({ code: 'import_conflict' });
    expect((await restarted.read()).imports).toHaveLength(1);
  });

  it('does not trust candidates, strong rules, or core facts through bulk import acceptance', async () => {
    const { service } = await fixture(); const data = example();
    data.entries[0].state = 'candidate';
    if (data.entries[1].kind === 'context') data.entries[1].payload.core = true;
    if (data.entries[4].kind === 'rule') data.entries[4].payload.strength = 'required';
    await importData(service, data, true);
    const current = await service.read();
    expect(Object.keys(current.approvals).sort()).toEqual([data.entries[2].id, data.entries[3].id].sort());
    await expect(service.reviewEntries({ generation: current.generation, ids: [data.entries[0].id, data.entries[1].id], action: 'adopt' })).rejects.toMatchObject({ code: 'import_conflict' });
    const reviewed = await service.reviewEntries({ generation: current.generation, ids: [data.entries[0].id], action: 'adopt' });
    expect(reviewed.approvals[data.entries[0].id].method).toBe('human');
    expect(reviewed.data.entries[0].revision).toBe(2);
  });

  it('shares only selected trusted ready entries and their evidence; memories require explicit opt-in', async () => {
    const { service } = await fixture(); const { data } = await importData(service, example(), true);
    const current = await service.read();
    const shared = await service.exportPackage({ generation: current.generation, purpose: 'share', collectionIds: [data.collections[0].id], includeMemories: false });
    expect(shared.entries).toHaveLength(4); expect(shared.entries.some(entry => entry.kind === 'memory')).toBe(false);
    expect(shared.styles).toEqual([]); expect(shared.recipes).toEqual([]); expect(shared.preferenceTemplates).toEqual([]);
    expect(validatePackage(shared).valid).toBe(true);
    const including = await service.exportPackage({ generation: current.generation, purpose: 'share', collectionIds: [data.collections[0].id], includeMemories: true });
    expect(including.entries).toHaveLength(5); expect((await service.read()).generation).toBe(current.generation);
  });

  it('preserves local conflicts by default, rejects same-revision overwrite, and advances explicitly replaced revisions', async () => {
    const { service } = await fixture(); const { data } = await importData(service, example(), true);
    const external = structuredClone(data); external.entries[0].title = 'External title';
    let preview = await service.planImport('owner-a', JSON.stringify(external));
    expect(preview.counts.conflicts).toBe(1);
    await expect(service.commitImport('owner-a', { planId: preview.planId, decisions: [{ id: external.entries[0].id, action: 'replace' }], adoptReady: true })).rejects.toMatchObject({ code: 'import_conflict' });
    await service.commitImport('owner-a', { planId: preview.planId, decisions: [], adoptReady: true });
    expect((await service.read()).data.entries[0].title).toBe(data.entries[0].title);
    external.entries[0].revision = 7;
    preview = await service.planImport('owner-a', JSON.stringify(external));
    await service.commitImport('owner-a', { planId: preview.planId, decisions: [{ id: external.entries[0].id, action: 'replace' }], adoptReady: true });
    const current = await service.read();
    expect(current.data.entries[0].revision).toBe(8); expect(current.data.entries[0].title).toBe('External title');
    expect(current.approvals[external.entries[0].id]).toBeUndefined();
  });

  it('copies the entire selected dependency graph with new identities and correct derived parent digests', async () => {
    const { service } = await fixture(); const data = example();
    data.entries[1].derivedFrom = [{ entryId: data.entries[0].id, revision: 1, digest: sha256Canonical(data.entries[0]), evidenceSourceId: data.sources[0].id }];
    await importData(service, data);
    const preview = await service.planImport('owner-a', JSON.stringify(data));
    const receipt = await service.commitImport('owner-a', { planId: preview.planId, decisions: preview.items.map(item => ({ id: item.id, action: 'copy' })), adoptReady: false });
    expect(receipt.added).toBe(preview.items.length);
    const current = await service.read(); expect(validatePackage(current.data).errors).toEqual([]);
    const copied = current.data.entries.filter(entry => !data.entries.some(original => original.id === entry.id));
    expect(copied).toHaveLength(5); expect(copied.every(entry => entry.collectionId !== data.collections[0].id)).toBe(true);
    const child = copied.find(entry => entry.kind === 'context')!;
    const parent = copied.find(entry => entry.kind === 'term')!;
    expect(child.derivedFrom[0]).toMatchObject({ entryId: parent.id, revision: parent.revision, digest: sha256Canonical(parent) });
    expect(current.data.recipes[1].baseStyleId).toBe(current.data.styles[1].id);
  });

  it('rejects skipped dependencies as one transaction without silently filling from the network', async () => {
    const { service } = await fixture(); const data = example();
    const preview = await service.planImport('owner-a', JSON.stringify(data));
    await expect(service.commitImport('owner-a', { planId: preview.planId, decisions: [{ id: data.sources[0].id, action: 'skip' }], adoptReady: false })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await service.read()).generation).toBe(0);
  });

  it('uses optimistic generations and revisions for atomic evidence creation and manual approval', async () => {
    const { service } = await fixture(); const { data } = await importData(service);
    let current = await service.read();
    const entry = structuredClone(current.data.entries[0]);
    const source = { ...data.sources[0], id: randomUUID(), title: 'My explicit correction' };
    entry.evidence = [{ sourceId: source.id, support: 'direct' }];
    current = await service.saveRecord({ generation: current.generation, group: 'entries', record: entry, source, adopt: true });
    expect(current.data.entries[0].revision).toBe(2); expect(current.approvals[entry.id].digest).toBe(sha256Canonical(current.data.entries[0]));
    expect(current).toEqual(await service.read());
    await expect(service.saveRecord({ generation: current.generation, group: 'entries', record: entry })).rejects.toMatchObject({ code: 'revision_conflict' });
    const updated = structuredClone(current.data.entries[0]); updated.title = 'Edited again';
    const requests = [service.saveRecord({ generation: current.generation, group: 'entries', record: updated }), service.saveRecord({ generation: current.generation, group: 'entries', record: updated })];
    const results = await Promise.allSettled(requests); expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((await service.read()).approvals[entry.id]).toBeUndefined();
  });

  it('keeps an unchanged save fully idempotent, including exact trust, revisions and generation', async () => {
    const { service } = await fixture(); await importData(service, example(), true);
    const before = await service.read();
    expect(await service.saveRecord({ generation: before.generation, group: 'sources', record: before.data.sources[0] })).toEqual(before);
    expect(await service.saveRecord({ generation: before.generation, group: 'entries', record: before.data.entries[0] })).toEqual(before);
    expect(await service.read()).toEqual(before);
  });

  it('allows identical terms with different meanings in separate collections and subject scopes', async () => {
    const { service } = await fixture(); const data = example();
    const alternativeSubject = { ...data.subjects[0], id: randomUUID(), name: 'A different work' };
    const alternativeCollection = { ...data.collections[0], id: randomUUID(), name: 'A different translation', aboutSubjectIds: [alternativeSubject.id] };
    data.subjects.push(alternativeSubject); data.collections.push(alternativeCollection);
    const term = structuredClone(data.entries[0]);
    term.id = randomUUID(); term.collectionId = alternativeCollection.id; term.aboutSubjectIds = [alternativeSubject.id]; term.scope.requiredSubjects = [{ subjectId: alternativeSubject.id, role: 'topic' }];
    if (term.kind === 'term') term.payload.target = '理事会';
    data.entries.push(term);
    const result = await importData(service, data, true);
    expect(result.preview.warnings.some(item => item.code === 'TERM_TRANSLATION_CONFLICT')).toBe(true);
    let current = await service.read();
    expect(current.approvals[data.entries[0].id]).toBeDefined(); expect(current.approvals[term.id]).toBeDefined();
    current = await service.reviewEntries({ generation: current.generation, ids: [data.entries[0].id, term.id], action: 'adopt' });
    expect(current.approvals[data.entries[0].id]).toBeDefined(); expect(current.approvals[term.id]).toBeDefined();
  });

  it('does not let an archived display-only subject change an entry’s applicability', async () => {
    const { service } = await fixture(); const data = example();
    data.subjects[0].archived = true;
    data.entries.forEach(entry => { entry.scope.requiredSubjects = []; });
    await importData(service, data, true);
    const current = await service.read(); expect(Object.keys(current.approvals)).toHaveLength(5);
    const shared = await service.exportPackage({ generation: current.generation, purpose: 'share', collectionIds: [data.collections[0].id], includeMemories: true });
    expect(shared.entries).toHaveLength(5); expect(shared.subjects[0].archived).toBe(true);
  });

  it('publishes a new revision when a new imported entry changes through copied dependencies', async () => {
    const { service } = await fixture(); const { data } = await importData(service);
    const incoming = structuredClone(data);
    incoming.entries = [{ ...structuredClone(data.entries[0]), id: randomUUID(), title: 'New term in copied collection' }];
    incoming.styles = []; incoming.recipes = [];
    const preview = await service.planImport('owner-a', JSON.stringify(incoming));
    await service.commitImport('owner-a', { planId: preview.planId, decisions: [{ id: data.collections[0].id, action: 'copy' }], adoptReady: false });
    const inserted = (await service.read()).data.entries.find(entry => entry.id === incoming.entries[0].id)!;
    expect(inserted.collectionId).not.toBe(incoming.entries[0].collectionId);
    expect(inserted.revision).toBe(incoming.entries[0].revision + 1);
  });

  it('retains author, sharing and package-extension claims as inert package provenance across backup restore', async () => {
    const first = await fixture(), second = await fixture(); const data = example();
    data.package.author = 'A declared author'; data.package.sharingNote = 'Use with attribution'; data.package.extensions = { 'org.example.rights': { license: 'example' } };
    await importData(first.service, data);
    const current = await first.service.read();
    const backup = await first.service.exportPackage({ generation: current.generation, purpose: 'backup', collectionIds: [], includeMemories: true });
    expect(backup.package.author).toBeUndefined();
    expect(backup.extensions?.['org.fusionkit.package-provenance']).toMatchObject({ version: 1, packages: expect.arrayContaining([data.package]) });
    await importData(second.service, backup);
    expect((await second.service.read()).data.extensions?.['org.fusionkit.package-provenance']).toMatchObject({ packages: expect.arrayContaining([data.package]) });
    expect((await second.service.read()).approvals).toEqual({});
  });

  it('shows conflicting root extension values in preview and never silently overwrites or discards them', async () => {
    const { service } = await fixture(); const { data } = await importData(service);
    const changed = structuredClone(data); changed.extensions = { 'org.example.metadata': { verified: true } };
    const before = await service.read();
    const preview = await service.planImport('owner-a', JSON.stringify(changed));
    expect(preview.warnings.some(item => item.code === 'IMPORT_METADATA_CONFLICT')).toBe(true);
    await expect(service.commitImport('owner-a', { planId: preview.planId, decisions: [], adoptReady: false })).rejects.toMatchObject({ code: 'import_conflict' });
    expect(await service.read()).toEqual(before);
  });

  it('revokes source-dependent and derived trust when evidence changes, while preserving archive state', async () => {
    const { service } = await fixture(); const data = example();
    data.entries[1].derivedFrom = [{ entryId: data.entries[0].id, revision: 1, digest: sha256Canonical(data.entries[0]), evidenceSourceId: data.sources[0].id }];
    data.entries[2].state = 'archived';
    await importData(service, data, true);
    const current = await service.read();
    const changed = await service.saveRecord({ generation: current.generation, group: 'sources', record: { ...data.sources[0], excerpt: 'Corrected supporting evidence.' } });
    expect(changed.approvals).toEqual({});
    expect(changed.data.entries[0]).toMatchObject({ state: 'needs_review', revision: 2 });
    expect(changed.data.entries[1]).toMatchObject({ state: 'needs_review', revision: 2 });
    expect(changed.data.entries[2]).toMatchObject({ state: 'archived', revision: 1 });
  });

  it('does not revive an archived local entry by importing its older ready declaration', async () => {
    const { service } = await fixture(); const { data } = await importData(service, example(), true);
    const current = await service.read();
    await service.reviewEntries({ generation: current.generation, ids: [data.entries[0].id], action: 'archive' });
    await importData(service, data, true);
    const after = await service.read(); expect(after.data.entries[0].state).toBe('archived'); expect(after.approvals[data.entries[0].id]).toBeUndefined();
  });

  it('expires stale and superseded plans and fences released owners immediately before publication', async () => {
    let blocked = false, reached!: () => void, release!: () => void;
    const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const { service } = await fixture({ publicationHook: async stage => { if (blocked && stage === 'before_pointer_rename') { reached(); await wait; } } });
    const data = example();
    const old = await service.planImport('owner-a', JSON.stringify(data));
    const preview = await service.planImport('owner-a', JSON.stringify(data));
    await expect(service.commitImport('owner-a', { planId: old.planId, decisions: [], adoptReady: false })).rejects.toMatchObject({ code: 'plan_expired' });
    blocked = true;
    const pending = service.commitImport('owner-a', { planId: preview.planId, decisions: [], adoptReady: false });
    await reachedPromise; service.releaseOwner('owner-a'); release();
    await expect(pending).rejects.toMatchObject({ code: 'access_denied' });
    expect((await service.read()).generation).toBe(0);
  });

  it.each<PublicationStage>(['generation_synced', 'generation_directory_synced', 'before_pointer_rename'])('preserves the complete old generation after a %s failure', async stageToFail => {
    let fail = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (fail && stage === stageToFail) throw Object.assign(new Error('Injected disk failure'), { code: 'ENOSPC' }); } });
    const before = await readFile(path.join(root, 'current.json'), 'utf8');
    const preview = await service.planImport('owner-a', JSON.stringify(example()));
    const request = { planId: preview.planId, decisions: [], adoptReady: true }; fail = true;
    await expect(service.commitImport('owner-a', request)).rejects.toMatchObject({ code: 'write_failed' });
    expect(await readFile(path.join(root, 'current.json'), 'utf8')).toBe(before);
    expect((await service.read()).data.entries).toEqual([]);
    fail = false; await service.commitImport('owner-a', request); expect((await service.read()).generation).toBe(1);
  });

  it('preserves a published receipt after late sync failure and reconciles it after restart', async () => {
    let fail = false;
    const { service, root } = await fixture({ publicationHook: stage => { if (fail && stage === 'pointer_renamed') throw new Error('Injected directory fsync failure'); } });
    const preview = await service.planImport('owner-a', JSON.stringify(example()));
    const request = { planId: preview.planId, decisions: [], adoptReady: true }; fail = true;
    await expect(service.commitImport('owner-a', request)).rejects.toMatchObject({ code: 'write_failed', diagnostics: [expect.objectContaining({ code: 'PUBLICATION_UNCERTAIN' })] });
    expect((await service.read()).generation).toBe(1); await service.dispose();
    const restarted = new KnowledgeService(root); services.push(restarted);
    const receipt = await restarted.commitImport('owner-a', request); expect(receipt.generation).toBe(1);
    expect((await restarted.read()).imports).toEqual([receipt]);
    expect((await readdir(root)).filter(name => name.startsWith('generation-'))).toHaveLength(2);
  });

  it('fails closed on corrupt persisted data, retaining all generations', async () => {
    const { service, root } = await fixture(); await importData(service);
    const current = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')) as { file: string };
    await writeFile(path.join(root, current.file), '{"corrupt":true}');
    await expect(service.read()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await readdir(root)).filter(name => name.startsWith('generation-'))).toHaveLength(2);
  });

  it('blocks identifiable private paths during export without rewriting local records', async () => {
    const { service } = await fixture(); const data = example(); data.sources[0].attribution = '/Users/example/private/subtitles.srt';
    await importData(service, data);
    const current = await service.read();
    await expect(service.exportPackage({ generation: current.generation, purpose: 'backup', collectionIds: [], includeMemories: true })).rejects.toMatchObject({ code: 'invalid_input', diagnostics: [expect.objectContaining({ code: 'EXPORT_PRIVATE_CONTENT' })] });
    expect((await service.read()).data.sources).toEqual(data.sources);
  });

  it('rejects two active repository owners and allows a new owner after disposal', async () => {
    const { service, root } = await fixture();
    const second = new KnowledgeService(root); services.push(second);
    await expect(second.read()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await service.dispose(); expect((await second.read()).generation).toBe(0);
  });
});
