import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { emptyPackage } from '../../electron/main/translation-knowledge/repository';
import { buildKnowledgeProposal, normalizeLanguageTag, type ProposalInput } from '../../src/translation-knowledge/proposal';
import type { Entry, KnowledgePackage } from '../../src/translation-knowledge/schemas';

const pair = { source: 'ja', target: 'zh-Hans' };
const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const zzz: ProposalInput = {
  languagePair: pair,
  subjects: [{ ref: 'zzz', name: '绝区零', kind: 'work', aliases: ['ZZZ', 'ゼンレスゾーンゼロ'] }],
  collections: [{ ref: 'names', name: '绝区零 · 人物与称谓', subjects: [{ ref: 'zzz' }] }],
  entries: [{ action: 'create', collection: { ref: 'names' }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated', evidence: '应该是泰姆菲尔德家的大小姐' }],
};

function library(entries: (collectionId: string, sourceId: string) => Entry[] = () => []) {
  const data = emptyPackage();
  const collectionId = randomUUID(), otherId = randomUUID(), sourceId = randomUUID();
  data.collections = [
    { id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物', description: '', aboutSubjectIds: [], defaultLanguagePair: pair },
    { id: otherId, revision: 1, archived: false, name: '通用称谓', description: '', aboutSubjectIds: [], defaultLanguagePair: pair },
  ];
  data.sources = [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Note', excerpt: 'note' }];
  data.entries = entries(collectionId, sourceId).map(entry => entry.collectionId === 'other' ? { ...entry, collectionId: otherId } : entry);
  return { snapshot: { generation: 4, data, approvals: {}, imports: [] }, collectionId, otherId, sourceId };
}
function term(collectionId: string, sourceId: string, source: string, target: string, extra: Partial<Entry> = {}): Entry {
  return { id: randomUUID(), revision: 1, title: source, kind: 'term', collectionId, aboutSubjectIds: [], state: 'ready',
    scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
    payload: { source, target, aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' }, ...extra } as Entry;
}

describe('knowledge change proposals', () => {
  it('creates a work, its collection and a user-stated term that is enabled by default', () => {
    const { snapshot } = library();
    const proposal = buildKnowledgeProposal(zzz, snapshot);
    expect(proposal.saveable).toBe(true);
    expect(proposal.items.map(item => [item.group, item.status])).toEqual([['subjects', 'new'], ['collections', 'new'], ['entries', 'new']]);
    expect(proposal.counts).toMatchObject({ subjects: 1, collections: 1, created: 1 });
    expect(proposal.adoptDefault).toBe(true);
    const enabled = proposal.request(true);
    expect(enabled.generation).toBe(4);
    expect(enabled.items.map(item => item.group)).toEqual(['subjects', 'collections', 'entries']);
    const [subject, collection, entry] = enabled.items;
    expect(collection.record).toMatchObject({ aboutSubjectIds: [subject.record.id], defaultLanguagePair: pair });
    expect(entry).toMatchObject({ adopt: true, source: { kind: 'user_note', excerpt: '应该是泰姆菲尔德家的大小姐' },
      record: { state: 'ready', collectionId: collection.record.id, aboutSubjectIds: [subject.record.id],
        scope: { languagePair: pair, requiredSubjects: [] }, payload: { source: SOURCE, target: TARGET, match: { mode: 'literal_phrase', caseSensitive: false } } } });
    expect((entry.record as Entry).evidence).toEqual([{ sourceId: entry.source!.id, support: 'direct' }]);
    const review = proposal.request(false);
    expect(review.items[2]).toMatchObject({ record: { state: 'candidate' } });
    expect(review.items[2].adopt).toBeUndefined();
  });

  it('reuses the same ids when rebuilt against a newer library', () => {
    const { snapshot } = library();
    const first = buildKnowledgeProposal(zzz, snapshot);
    const again = buildKnowledgeProposal(zzz, { ...snapshot, generation: 9 }, { ids: first.ids });
    expect(again.request(true, 9).items.map(item => [item.record.id, item.source?.id])).toEqual(first.request(true).items.map(item => [item.record.id, item.source?.id]));
  });

  it('skips terms that already exist and reports when nothing is left to save', () => {
    const { snapshot, collectionId } = library((collection, source) => [term(collection, source, SOURCE, TARGET)]);
    const proposal = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: ` ${SOURCE}`, target: TARGET, basis: 'user_stated' }] }, snapshot);
    expect(proposal.items[0].status).toBe('exists');
    expect(proposal.nothingToSave).toBe(true);
    expect(proposal.saveable).toBe(false);
    // The same term twice in one proposal is saved once.
    const twice = buildKnowledgeProposal({ entries: [0, 1].map(() => ({ action: 'create' as const, collection: { id: collectionId }, kind: 'term' as const, source: 'ゼンゼロ', target: '绝区零', basis: 'user_stated' as const })) }, snapshot);
    expect(twice.items.map(item => item.status)).toEqual(['new', 'exists']);
    expect(twice.request(true).items).toHaveLength(1);
  });

  it('warns about a different target for the same source in another collection', () => {
    const { snapshot, collectionId } = library((_collection, source) => [term('other', source, SOURCE, '时间菲尔德家的大小姐')]);
    const proposal = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated' }] }, snapshot);
    expect(proposal.saveable).toBe(true);
    expect(proposal.items[0].warnings).toEqual([{ code: 'term_conflict', collectionName: '通用称谓', target: '时间菲尔德家的大小姐' }]);
    const required = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: 'ホロウ', target: '空洞', strength: 'required', basis: 'user_stated' }] }, snapshot);
    expect(required.items[0].warnings).toEqual([{ code: 'individual_review' }]);
  });

  it('marks invalid references, languages and missing wording with stable reasons', () => {
    const { snapshot, collectionId } = library();
    const reasons = (input: ProposalInput) => buildKnowledgeProposal(input, snapshot).items.map(item => item.reason);
    expect(reasons({ entries: [{ action: 'create', collection: { id: randomUUID() }, kind: 'term', source: 'a', target: 'b' }] })).toEqual(['unknown_collection']);
    expect(reasons({ entries: [{ action: 'create', collection: { ref: 'missing' }, kind: 'term', source: 'a', target: 'b' }] })).toEqual(['unknown_collection']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: 'a', target: '' }] })).toEqual(['missing_target']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: '', target: 'b' }] })).toEqual(['missing_source']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'rule', text: ' ' }] })).toEqual(['missing_text']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: 'a', target: 'b', languagePair: { source: 'ja', target: 'not a tag!' } }] })).toEqual(['invalid_language']);
    expect(reasons({ collections: [{ ref: 'c', name: 'C', subjects: [{ ref: 'nobody' }] }] })).toEqual(['unknown_subject']);
    expect(reasons({ entries: [{ action: 'update', entryId: randomUUID(), revision: 1, target: 'x' }] })).toEqual(['unknown_entry']);
    expect(buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: 'a', target: '' }] }, snapshot).saveable).toBe(false);
  });

  it('reuses a live work and collection of the same name instead of creating duplicates', () => {
    const { snapshot, collectionId } = library();
    snapshot.data.subjects = [{ id: randomUUID(), revision: 1, archived: false, kind: 'work', name: '绝区零', aliases: [], tags: [], description: '' }];
    const proposal = buildKnowledgeProposal({ ...zzz, collections: [{ ref: 'names', name: ' 绝区零 · 人物 ', subjects: [{ ref: 'zzz' }] }] }, snapshot);
    expect(proposal.items.map(item => item.status)).toEqual(['exists', 'exists', 'new']);
    const request = proposal.request(true);
    expect(request.items.map(item => item.group)).toEqual(['entries']);
    expect(request.items[0].record).toMatchObject({ collectionId });
    // A different kind of subject with the same name is a different subject.
    const person = buildKnowledgeProposal({ subjects: [{ ref: 'p', name: '绝区零', kind: 'person' }] }, snapshot);
    expect(person.items[0].status).toBe('new');
  });

  it('normalizes Chinese tags to an explicit script', () => {
    expect(normalizeLanguageTag('zh')).toBe('zh-Hans');
    expect(normalizeLanguageTag('zh-CN')).toBe('zh-Hans');
    expect(normalizeLanguageTag('zh-TW')).toBe('zh-Hant');
    expect(normalizeLanguageTag('zh-Hant-HK')).toBe('zh-Hant');
    expect(normalizeLanguageTag('JA')).toBe('ja');
    expect(normalizeLanguageTag('auto')).toBeUndefined();
    const { snapshot, collectionId } = library();
    const proposal = buildKnowledgeProposal({ languagePair: { source: 'ja', target: 'zh' }, entries: [{ action: 'create', collection: { id: collectionId }, kind: 'term', source: 'a', target: 'b' }] }, snapshot);
    expect((proposal.request(false).items[0].record as Entry).scope.languagePair).toEqual(pair);
  });

  it('edits and archives by revision; inferred wording is evidence-marked and not enabled by default', () => {
    const existing: Entry[] = [];
    const { snapshot } = library((collection, source) => { existing.push(term(collection, source, SOURCE, '时间菲尔德家的大小姐'), term(collection, source, 'ホロウ', '空洞')); return existing; });
    const proposal = buildKnowledgeProposal({ entries: [
      { action: 'update', entryId: existing[0].id, revision: 1, target: TARGET, basis: 'document', evidence: '第 12 行' },
      { action: 'archive', entryId: existing[1].id, revision: 1 },
    ] }, snapshot);
    expect(proposal.items.map(item => item.status)).toEqual(['update', 'archive']);
    expect(proposal.adoptDefault).toBe(false);
    const [update, archive] = proposal.request(false).items;
    expect(update.record).toMatchObject({ id: existing[0].id, revision: 1, state: 'candidate', payload: { target: TARGET } });
    expect(update.source).toMatchObject({ kind: 'ai_proposal', excerpt: '第 12 行' });
    expect((update.record as Entry).evidence.at(-1)).toEqual({ sourceId: update.source!.id, support: 'inferred' });
    expect(archive).toEqual({ group: 'entries', record: expect.objectContaining({ id: existing[1].id, state: 'archived' }) });
    expect(buildKnowledgeProposal({ entries: [{ action: 'update', entryId: existing[0].id, revision: 3, target: TARGET }] }, snapshot).items[0].reason).toBe('stale_revision');
  });
});

describe('proposals saved by the knowledge service', () => {
  const roots: string[] = [];
  const services: KnowledgeService[] = [];
  afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function service() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fk-proposal-')); roots.push(root);
    const value = new KnowledgeService(root); services.push(value);
    return value;
  }

  it('saves an enabled proposal as trusted entries and a review proposal as candidates', async () => {
    const knowledge = await service();
    const before = await knowledge.read();
    const proposal = buildKnowledgeProposal(zzz, before);
    const saved = await knowledge.saveRecords(proposal.request(true));
    const entry = saved.data.entries[0];
    expect(saved.generation).toBe(before.generation + 1);
    expect(entry).toMatchObject({ state: 'ready', payload: { source: SOURCE, target: TARGET } });
    expect(saved.approvals[entry.id]).toMatchObject({ method: 'human', revision: entry.revision });

    const review = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: entry.collectionId }, kind: 'term', source: 'ホロウ', target: '空洞', basis: 'agent_inferred' }] }, saved);
    expect(review.adoptDefault).toBe(false);
    const after = await knowledge.saveRecords(review.request(false));
    const candidate = after.data.entries.find(item => item.kind === 'term' && item.payload.source === 'ホロウ')!;
    expect(candidate.state).toBe('candidate');
    expect(after.approvals[candidate.id]).toBeUndefined();
    expect(after.data.sources.find(item => item.id === candidate.evidence[0].sourceId)).toMatchObject({ kind: 'ai_proposal' });
  });

  it('rebuilds after an unrelated change and saves the same records once', async () => {
    const knowledge = await service();
    const before = await knowledge.read();
    const proposal = buildKnowledgeProposal(zzz, before);
    const unrelated = await knowledge.saveRecords({ generation: before.generation, items: [{ group: 'subjects', record: { id: randomUUID(), revision: 1, archived: false, kind: 'domain', name: 'Other', aliases: [], tags: [], description: '' } }] });
    const rebuilt = buildKnowledgeProposal(zzz, unrelated, { ids: proposal.ids });
    const saved = await knowledge.saveRecords(rebuilt.request(true));
    expect(saved.data.entries.map(entry => entry.id)).toEqual([proposal.request(true).items[2].record.id]);
    const replay = buildKnowledgeProposal(zzz, saved, { ids: proposal.ids });
    expect(replay.items.find(item => item.group === 'entries')?.status).toBe('exists');
    expect(replay.nothingToSave).toBe(true);
    const data: KnowledgePackage = saved.data;
    expect(data.collections).toHaveLength(1);
  });
});
