import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { captureProposal, captureRows, captureStatuses, CAPTURE_ROW_LIMIT } from '../../src/pages/TranslationKnowledge/capture';
import type { Entry } from '../../src/translation-knowledge/schemas';

const pair = { source: 'ja', target: 'zh-Hans' };
const roots: string[] = [];
const services: KnowledgeService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function library() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-capture-')); roots.push(root);
  const service = new KnowledgeService(root); services.push(service);
  const names = randomUUID(), places = randomUUID(), sourceId = randomUUID();
  const term = (collectionId: string, source: string, target: string): Entry => ({ id: randomUUID(), revision: 1, title: source, kind: 'term', collectionId, aboutSubjectIds: [], state: 'candidate',
    scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
    payload: { source, target, aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } });
  const before = await service.read();
  const seeded = await service.saveRecords({ generation: before.generation, items: [
    { group: 'collections', record: { id: names, revision: 1, archived: false, name: '绝区零 · 人物', description: '', aboutSubjectIds: [], defaultLanguagePair: pair } },
    { group: 'collections', record: { id: places, revision: 1, archived: false, name: '绝区零 · 地名', description: '', aboutSubjectIds: [], defaultLanguagePair: pair } },
    { group: 'entries', record: term(names, 'ホロウ', '空洞'), source: { id: sourceId, revision: 1, kind: 'user_note', title: 'Note', excerpt: 'seed' } },
    { group: 'entries', record: term(places, 'テイムフィールド家のお嬢様', '时间菲尔德家的大小姐') },
  ] });
  return { service, snapshot: seeded, names, places };
}
const wordings = [
  { source: 'テイムフィールド家のお嬢様', target: '泰姆菲尔德家的大小姐', note: '家族名' },
  { source: 'ホロウ', target: '空洞' },
  { source: ' ホロウ ', target: '空洞 ' },
  { source: '', target: '空' },
];

describe('keeping several wordings at once', () => {
  it('turns suggestions into distinct rows', () => {
    const rows = captureRows(wordings);
    expect(rows.map(row => [row.source, row.target, row.selected])).toEqual([['テイムフィールド家のお嬢様', '泰姆菲尔德家的大小姐', true], ['ホロウ', '空洞', true]]);
    expect(captureRows(Array.from({ length: 80 }, (_, index) => ({ source: `語${index}`, target: `词${index}` })))).toHaveLength(CAPTURE_ROW_LIMIT);
  });

  it('shows rows already in the collection and those another collection translates differently', async () => {
    const { snapshot, names } = await library();
    const rows = captureRows(wordings);
    expect(captureStatuses(rows, snapshot, { collectionId: names }, pair)).toEqual([
      { kind: 'conflict', collectionName: '绝区零 · 地名', target: '时间菲尔德家的大小姐' },
      { kind: 'exists' },
    ]);
    expect(captureStatuses([{ ...rows[0], target: '' }], snapshot, { collectionId: names }, pair)).toEqual([{ kind: 'invalid', reason: 'missing_target' }]);
  });

  it('saves the chosen rows enabled in one transaction, and creates a new collection with them', async () => {
    const { service, snapshot, names } = await library();
    const rows = captureRows(wordings).map((row, index) => ({ ...row, selected: index === 0 }));
    const proposal = captureProposal(rows, snapshot, { collectionId: names }, pair, { evidence: '应该是泰姆菲尔德家的大小姐' });
    const saved = await service.saveRecords(proposal.request(true, snapshot.generation));
    const entry = saved.data.entries.find(item => item.kind === 'term' && item.payload.target === '泰姆菲尔德家的大小姐')!;
    expect(entry).toMatchObject({ collectionId: names, state: 'ready', payload: { sense: '家族名' } });
    expect(saved.approvals[entry.id]).toMatchObject({ method: 'human' });
    expect(saved.data.sources.find(item => item.id === entry.evidence[0].sourceId)).toMatchObject({ kind: 'user_note', excerpt: '应该是泰姆菲尔德家的大小姐' });
    expect(saved.generation).toBe(snapshot.generation + 1);

    const fresh = captureProposal([{ key: 'a', source: 'エーテル', target: '以太', selected: true }], saved, { newCollectionName: '绝区零 · 术语' }, pair);
    const created = await service.saveRecords(fresh.request(false, saved.generation));
    const collection = created.data.collections.find(item => item.name === '绝区零 · 术语')!;
    expect(created.data.entries.find(item => item.kind === 'term' && item.payload.source === 'エーテル')).toMatchObject({ collectionId: collection.id, state: 'candidate' });
  });

  it('writes nothing when the library changed underneath, and reuses identities on retry', async () => {
    const { service, snapshot, names } = await library();
    const rows = captureRows(wordings.slice(0, 1));
    const first = captureProposal(rows, snapshot, { collectionId: names }, pair);
    const changed = await service.saveRecords({ generation: snapshot.generation, items: [{ group: 'subjects', record: { id: randomUUID(), revision: 1, archived: false, kind: 'domain', name: 'Other', aliases: [], tags: [], description: '' } }] });
    await expect(service.saveRecords(first.request(true, snapshot.generation))).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await service.read()).generation).toBe(changed.generation);
    const retry = captureProposal(rows, changed, { collectionId: names }, pair, { ids: first.ids });
    const saved = await service.saveRecords(retry.request(true, changed.generation));
    expect(saved.data.entries.find(item => item.id === first.request(true).items[0].record.id)).toBeDefined();
    expect(captureProposal(rows, saved, { collectionId: names }, pair, { ids: first.ids }).nothingToSave).toBe(true);
  });
});
