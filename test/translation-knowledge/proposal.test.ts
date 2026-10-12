import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { emptyPackage } from '../../electron/main/translation-knowledge/repository';
import { buildKnowledgeProposal, normalizeLanguageTag, type ProposalInput } from '../../src/translation-knowledge/proposal';
import type { Entry } from '../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

const pair = { source: 'ja', target: 'zh-Hans' };
const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const zzz: ProposalInput = {
  languagePair: pair,
  collections: [{ ref: 'zzz', name: '绝区零' }],
  entries: [{ action: 'create', collection: { ref: 'zzz' }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated', evidence: '应该是泰姆菲尔德家的大小姐' }],
};

function library(entries: (collectionId: string) => Entry[] = () => []) {
  const data = emptyPackage();
  const collectionId = randomUUID(), otherId = randomUUID();
  data.collections = [
    { id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物', description: '', languagePair: pair },
    { id: otherId, revision: 1, archived: false, name: '通用称谓', description: '', languagePair: pair },
  ];
  data.entries = entries(collectionId).map(entry => entry.collectionId === 'other' ? { ...entry, collectionId: otherId } : entry);
  return { snapshot: { generation: 4, data } satisfies LibrarySnapshot, collectionId, otherId };
}
function term(collectionId: string, source: string, target: string, extra: Partial<Entry> = {}): Entry {
  return { id: randomUUID(), revision: 1, kind: 'term', collectionId, enabled: true,
    payload: { source, target, aliases: [], note: '', strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } }, ...extra } as Entry;
}

describe('knowledge change proposals', () => {
  it('creates a collection and a user-stated term that takes effect when saved', () => {
    const { snapshot } = library();
    const proposal = buildKnowledgeProposal(zzz, snapshot);
    expect(proposal.saveable).toBe(true);
    expect(proposal.counts).toEqual({ collections: 1, created: 1, updated: 0, disabled: 0, enabled: 0, existing: 0 });
    const request = proposal.request();
    expect(request.generation).toBe(4);
    const [collection, entry] = request.items;
    expect(collection).toMatchObject({ group: 'collections', record: { name: '绝区零', languagePair: pair, archived: false } });
    expect(entry).toMatchObject({ group: 'entries', record: { kind: 'term', enabled: true, collectionId: collection.record.id,
      origin: { kind: 'manual', note: '应该是泰姆菲尔德家的大小姐' }, payload: { source: SOURCE, target: TARGET, strength: 'preferred' } } });
    expect(proposal.items.find(item => item.group === 'entries')).toMatchObject({ status: 'new', aiSourced: false, source: SOURCE, target: TARGET, collectionName: '绝区零' });
    expect(proposal.collectionIds).toEqual([collection.record.id]);
    expect(JSON.stringify(request)).not.toMatch(/adopt|candidate|subject|state/);
  });

  it('reuses the same ids when rebuilt against a newer library', () => {
    const { snapshot } = library();
    const first = buildKnowledgeProposal(zzz, snapshot);
    const again = buildKnowledgeProposal(zzz, { ...snapshot, generation: 5 }, { ids: first.ids });
    expect(again.request().items.map(item => item.record.id)).toEqual(first.request().items.map(item => item.record.id));
    expect(again.request().generation).toBe(5);
  });

  it('skips wording that already exists, enabled or not, and reports when nothing is left to save', () => {
    const { snapshot, collectionId } = library(id => [term(id, SOURCE, TARGET, { enabled: false })]);
    const proposal = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, source: SOURCE, target: TARGET, basis: 'user_stated' }] }, snapshot);
    expect(proposal.items[0].status).toBe('exists');
    expect(proposal.nothingToSave).toBe(true);
    expect(proposal.saveable).toBe(false);
    expect(proposal.request().items).toEqual([]);
  });

  it('warns about a different enabled target for the same source in another collection without blocking', () => {
    const { snapshot, collectionId } = library(() => [term('other', SOURCE, '泰姆菲尔德小姐'), term('other', SOURCE, '旧译', { enabled: false })]);
    const proposal = buildKnowledgeProposal({ entries: [{ action: 'create', collection: { id: collectionId }, source: SOURCE, target: TARGET, basis: 'user_stated' }] }, snapshot);
    expect(proposal.items[0].warnings).toEqual([{ code: 'term_conflict', collectionName: '通用称谓', target: '泰姆菲尔德小姐' }]);
    expect(proposal.saveable).toBe(true);
  });

  it('marks AI-inferred and web wording and records where it came from', () => {
    const { snapshot, collectionId } = library();
    const proposal = buildKnowledgeProposal({ entries: [
      { action: 'create', collection: { id: collectionId }, source: 'A', target: '甲', basis: 'agent_inferred' },
      { action: 'create', collection: { id: collectionId }, source: 'B', target: '乙', basis: 'web', url: 'https://www.example.com/wiki/B', urlTitle: 'B - Example', accessedAt: '2026-10-12T01:02:03Z' },
      { action: 'create', collection: { id: collectionId }, source: 'C', target: '丙', basis: 'web', url: 'https://example.com/c' },
    ] }, snapshot);
    expect(proposal.items.map(item => [item.aiSourced, item.status, item.reason])).toEqual([[true, 'new', undefined], [true, 'new', undefined], [true, 'invalid', 'page_not_read']]);
    expect(proposal.items[1].sourceSite).toBe('example.com');
    const fixed = buildKnowledgeProposal({ entries: proposal.items.slice(0, 2).map((_, index) => [
      { action: 'create' as const, collection: { id: collectionId }, source: 'A', target: '甲', basis: 'agent_inferred' as const },
      { action: 'create' as const, collection: { id: collectionId }, source: 'B', target: '乙', basis: 'web' as const, url: 'https://www.example.com/wiki/B', urlTitle: 'B - Example', accessedAt: '2026-10-12T01:02:03Z' },
    ][index]) }, snapshot);
    expect(fixed.request().items.map(item => (item.record as Entry).origin)).toEqual([
      { kind: 'agent' }, { kind: 'web', url: 'https://www.example.com/wiki/B', title: 'B - Example', at: '2026-10-12T01:02:03Z' },
    ]);
  });

  it('marks invalid references, languages and missing wording with stable reasons', () => {
    const { snapshot, collectionId } = library();
    const archived = { ...snapshot, data: { ...snapshot.data, collections: snapshot.data.collections.map(item => item.id === collectionId ? { ...item, archived: true } : item) } };
    const reasons = (input: ProposalInput, value: LibrarySnapshot = snapshot) => buildKnowledgeProposal(input, value).items.map(item => item.reason);
    expect(reasons({ entries: [{ action: 'create', source: 'A', target: '甲' }] })).toEqual(['missing_collection']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: randomUUID() }, source: 'A', target: '甲' }] })).toEqual(['unknown_collection']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, source: 'A', target: '甲' }] }, archived)).toEqual(['archived_collection']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, source: '', target: '甲' }] })).toEqual(['missing_source']);
    expect(reasons({ entries: [{ action: 'create', collection: { id: collectionId }, kind: 'rule', text: ' ' }] })).toEqual(['missing_text']);
    expect(reasons({ collections: [{ ref: 'x', name: '新资料集' }] })).toEqual(['missing_language']);
    expect(reasons({ collections: [{ ref: 'x', name: '新资料集', languagePair: { source: 'auto', target: 'zh' } }] })).toEqual(['invalid_language']);
    expect(reasons({ collections: [{ ref: 'x', name: '' }] })).toEqual(['missing_name']);
  });

  it('reuses a live collection of the same name and direction instead of creating a duplicate', () => {
    const { snapshot, collectionId } = library();
    const proposal = buildKnowledgeProposal({ languagePair: pair, collections: [{ ref: 'x', name: ' 绝区零 · 人物 ' }],
      entries: [{ action: 'create', collection: { ref: 'x' }, source: 'A', target: '甲', basis: 'user_stated' }] }, snapshot);
    expect(proposal.items[0].status).toBe('exists');
    expect(proposal.request().items).toEqual([expect.objectContaining({ group: 'entries', record: expect.objectContaining({ collectionId }) })]);
    const otherDirection = buildKnowledgeProposal({ collections: [{ ref: 'x', name: '绝区零 · 人物', languagePair: { source: 'en', target: 'zh-Hans' } }] }, snapshot);
    expect(otherDirection.items[0].status).toBe('new');
  });

  it('normalizes Chinese tags to an explicit script', () => {
    expect(normalizeLanguageTag('zh')).toBe('zh-Hans');
    expect(normalizeLanguageTag('zh-TW')).toBe('zh-Hant');
    expect(normalizeLanguageTag('zh-Hant-HK')).toBe('zh-Hant');
    expect(normalizeLanguageTag('ja')).toBe('ja');
    expect(normalizeLanguageTag('auto')).toBeUndefined();
  });

  it('edits, disables and enables by revision and rejects stale proposals', () => {
    const existing = term('placeholder', SOURCE, '旧译');
    const { snapshot, collectionId } = library(id => [{ ...existing, collectionId: id }]);
    const current = snapshot.data.entries[0];
    const update = buildKnowledgeProposal({ entries: [{ action: 'update', entryId: current.id, revision: 1, target: TARGET, strength: 'required', basis: 'user_revision' }] }, snapshot);
    expect(update.items[0]).toMatchObject({ status: 'update', target: TARGET });
    expect(update.request().items[0].record).toMatchObject({ id: current.id, revision: 1, enabled: true, origin: { kind: 'revision' }, payload: { target: TARGET, strength: 'required' } });
    const disable = buildKnowledgeProposal({ entries: [{ action: 'disable', entryId: current.id, revision: 1 }] }, snapshot);
    expect(disable.request().items[0].record).toMatchObject({ enabled: false, payload: current.payload });
    expect(buildKnowledgeProposal({ entries: [{ action: 'enable', entryId: current.id, revision: 1 }] }, snapshot).items[0].status).toBe('exists');
    const stale = buildKnowledgeProposal({ entries: [{ action: 'update', entryId: current.id, revision: 2, target: TARGET }] }, snapshot);
    expect(stale.items[0]).toMatchObject({ status: 'invalid', reason: 'stale_revision' });
    expect(stale.saveable).toBe(false);
    expect(collectionId).toBe(current.collectionId);
  });
});

describe('proposals saved by the knowledge service', () => {
  const roots: string[] = [];
  const services: KnowledgeService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.dispose()));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function service() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fk-knowledge-proposal-')); roots.push(root);
    const value = new KnowledgeService(root); services.push(value);
    return value;
  }

  it('saves the confirmed proposal as enabled entries in one transaction', async () => {
    const knowledge = await service();
    const snapshot = await knowledge.read();
    const proposal = buildKnowledgeProposal(zzz, snapshot);
    const saved = await knowledge.saveRecords(proposal.request());
    expect(saved.data.collections).toEqual([proposal.request().items[0].record]);
    expect(saved.data.entries).toEqual([expect.objectContaining({ enabled: true, payload: expect.objectContaining({ source: SOURCE, target: TARGET }) })]);
  });

  it('rebuilds after an unrelated change and saves the same records once', async () => {
    const knowledge = await service();
    const first = buildKnowledgeProposal(zzz, await knowledge.read());
    const other = await knowledge.saveRecords({ generation: 0, items: [{ group: 'collections', record: { id: randomUUID(), revision: 1, name: 'Other', description: '', languagePair: pair, archived: false } }] });
    const rebuilt = buildKnowledgeProposal(zzz, other, { ids: first.ids });
    const saved = await knowledge.saveRecords(rebuilt.request());
    expect(saved.data.entries.map(entry => entry.id)).toEqual([first.ids['entry:0']]);
    const retried = buildKnowledgeProposal(zzz, saved, { ids: first.ids });
    expect(retried.nothingToSave).toBe(true);
  });
});
