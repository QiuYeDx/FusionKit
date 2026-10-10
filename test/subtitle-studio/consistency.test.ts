import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { buildConsistencyGroups, buildConsistencyMessages, joinSpellings, mergeConsistencyTerms, parseConsistencyResponse, type ConsistencyLine } from '../../src/subtitle-studio/consistency-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { ConsistencyService } from '../../electron/main/subtitle-studio/consistency-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';

const SOURCE = 'テイムフィールド家のお嬢様';
const RIGHT = '泰姆菲尔德家的大小姐';
const WRONG = '时间菲尔德家的大小姐';
const line = (index: number, source: string, target?: string, documentId = 'doc-a'): ConsistencyLine => ({ documentId, cueId: `${documentId}-${index}`, index, source, ...(target ? { target } : {}) });

describe('consistency protocol and counting', () => {
  it('sends the lines with ids and reads terms leniently', () => {
    const messages = buildConsistencyMessages({ focus: '人名', targetLanguage: 'zh', lines: [{ id: 'l1', source: SOURCE, target: RIGHT }] });
    expect(JSON.parse(messages[1].content)).toEqual({ focus: '人名', targetLanguage: 'zh', lines: [{ id: 'l1', source: SOURCE, target: RIGHT }] });
    expect(messages[0].content).toContain('"sourceVariants"');
    const terms = parseConsistencyResponse('```json\n' + JSON.stringify({ terms: [
      { source: ` ${SOURCE} `, targets: [RIGHT, WRONG, RIGHT, ''], sourceVariants: ['テームフィールド家のお嬢様', SOURCE] },
      { source: '' }, 'junk', { source: 'x'.repeat(200), targets: [] },
    ] }) + '\n```');
    expect(terms).toEqual([{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: ['テームフィールド家のお嬢様'] }]);
    expect(() => parseConsistencyResponse('{"items":[]}')).toThrow('translation_protocol_invalid');
    expect(mergeConsistencyTerms([{ source: SOURCE, targets: [RIGHT], sourceVariants: [] }, { source: SOURCE, targets: [WRONG, RIGHT], sourceVariants: ['テームフィールド'] }]))
      .toEqual([{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: ['テームフィールド'] }]);
  });

  it('groups a source translated two ways, recommending the most frequent, with every place it occurs', () => {
    const lines = [line(0, `${SOURCE}です`, `${RIGHT}来了`), line(1, `${SOURCE}、どうぞ`, `${RIGHT}，请`), line(2, `${SOURCE}！`, `${WRONG}！`), line(3, 'こんにちは', '你好'),
      line(0, `${SOURCE}ね`, `${RIGHT}呢`, 'doc-b')];
    const [group, ...rest] = buildConsistencyGroups(lines, [{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: [] }]);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ kind: 'translation', source: SOURCE, recommended: RIGHT });
    expect(group.variants.map(item => [item.text, item.count])).toEqual([[RIGHT, 3], [WRONG, 1]]);
    expect(group.variants[0].occurrences).toEqual([{ documentId: 'doc-a', cueId: 'doc-a-0', index: 0, source: `${SOURCE}です`, target: `${RIGHT}来了` }, { documentId: 'doc-a', cueId: 'doc-a-1', index: 1, source: `${SOURCE}、どうぞ`, target: `${RIGHT}，请` }, { documentId: 'doc-b', cueId: 'doc-b-0', index: 0, source: `${SOURCE}ね`, target: `${RIGHT}呢` }]);
  });

  it('keeps nothing the lines do not bear out', () => {
    const lines = [line(0, `${SOURCE}です`, `${RIGHT}来了`), line(1, `${SOURCE}、どうぞ`, `${RIGHT}，请`)];
    // One rendering in use, a rendering no line uses, and a source no line has.
    expect(buildConsistencyGroups(lines, [{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: [] }, { source: 'ホロウ', targets: ['空洞', '虚空'], sourceVariants: [] }])).toEqual([]);
  });

  it('finds source spellings of the same name, and follows the materials', () => {
    const lines = [line(0, `${SOURCE}です`, `${RIGHT}来了`), line(1, `テームフィールド家のお嬢様です`, `泰姆菲尔德家的大小姐来了`), line(2, 'ホロウへ', '去虚空'), line(3, 'ホロウだ', '是空洞'), line(4, '新エリー都', '新艾利都')];
    const groups = buildConsistencyGroups(lines, [{ source: SOURCE, targets: [RIGHT], sourceVariants: ['テームフィールド家のお嬢様'] }],
      [{ source: 'ホロウ', aliases: [], target: '空洞' }, { source: '新エリー都', aliases: [], target: '新艾利都' }]);
    const source = groups.find(item => item.source === SOURCE)!;
    expect(source).toMatchObject({ kind: 'source', recommended: RIGHT });
    expect(source.spellings.map(item => [item.text, item.count])).toEqual([[SOURCE, 1], ['テームフィールド家のお嬢様', 1]]);
    const hollow = groups.find(item => item.source === 'ホロウ')!;
    expect(hollow).toMatchObject({ kind: 'knowledge', knowledgeTarget: '空洞', recommended: '空洞' });
    expect(hollow.variants.map(item => [item.text, item.count])).toEqual([['空洞', 1], ['', 1]]);
    // A term every line already follows is no finding.
    expect(groups.some(item => item.source === '新エリー都')).toBe(false);
  });

  it('makes one group of a name reported several times with overlapping spellings', () => {
    // As reported in a real check: センパイ (also 先輩) and 先輩 (also せんぱい) offered opposite fixes.
    expect(joinSpellings([
      { source: 'センパイ', targets: [], sourceVariants: ['先輩'] },
      { source: '先輩', targets: ['前辈'], sourceVariants: ['せんぱい'] },
      { source: 'シロバトさん', targets: [], sourceVariants: ['白鴿'] },
      { source: 'ハトさん', targets: [], sourceVariants: ['白鴿'] },
      { source: '郵便局', targets: [], sourceVariants: ['用品局'] },
    ])).toEqual([
      { source: 'センパイ', targets: ['前辈'], sourceVariants: ['先輩', 'せんぱい'] },
      { source: 'シロバトさん', targets: [], sourceVariants: ['白鴿', 'ハトさん'] },
      { source: '郵便局', targets: [], sourceVariants: ['用品局'] },
    ]);
    const lines = [...Array.from({ length: 5 }, (_, index) => line(index, `先輩、おはよう${index}`)), line(5, 'せんぱい！'), line(6, '郵便局へ'), line(7, '用品局へ'), line(8, '郵便局だ')];
    const groups = buildConsistencyGroups(lines, [{ source: 'センパイ', targets: [], sourceVariants: ['先輩'] }, { source: '先輩', targets: [], sourceVariants: ['せんぱい'] },
      { source: '郵便局', targets: [], sourceVariants: ['用品局'] }]);
    expect(groups.map(group => [group.kind, group.source, group.spellings.map(item => [item.text, item.count])])).toEqual([
      // センパイ appears in no line, so it is neither the headword nor a choice.
      ['source', '先輩', [['先輩', 5], ['せんぱい', 1]]],
      ['source', '郵便局', [['郵便局', 2], ['用品局', 1]]],
    ]);
  });

  it('counts a line under the longest spelling it contains', () => {
    const lines = [line(0, 'シロバトさん、こっち'), line(1, 'バトさんだ'), line(2, 'シロバトさんが来た')];
    const [group] = buildConsistencyGroups(lines, [{ source: 'バトさん', targets: [], sourceVariants: ['シロバトさん'] }]);
    expect(group.spellings.map(item => [item.text, item.count])).toEqual([['シロバトさん', 2], ['バトさん', 1]]);
  });
});

const metadata = { format: 'lrc' as const, displayName: 'consistency.lrc', encoding: 'utf-8' as const, digest: 'f'.repeat(64) };
const lrc = (lines: string[], name = 'consistency.lrc') => importSubtitleText(lines.map((text, index) => `[00:${String(index).padStart(2, '0')}.00]${text}\n`).join(''), { ...metadata, displayName: name }, randomUUID);
const model = { profileId: 'consistency', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const };
const config: TranslationConfig = { model, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 10 };
const reply = (content: unknown): ModelRuntimeTextResult => ({ apiFormat: 'chat_completions', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, content: JSON.stringify(content) });

describe('consistency service', () => {
  const roots: string[] = [];
  const services: { dispose(): unknown }[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.dispose();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(docs: SubtitleDocument[], send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>, readKnowledge?: () => Promise<LibrarySnapshot>) {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-consistency-')); roots.push(root);
    const repository = new DocumentRepository(path.join(root, 'documents'));
    for (const doc of docs) await repository.create(doc);
    const translation = new TranslationService(repository, async request => {
      const items = (JSON.parse(request.messages[1].content) as { items: { id: string; text: string }[] }).items;
      return reply({ items: items.map(item => ({ id: item.id, text: item.text.replace(SOURCE, item.text.includes('！') ? WRONG : RIGHT) })) });
    });
    const service = new ConsistencyService(repository, send, readKnowledge);
    services.push(translation, service);
    const translate = async (doc: SubtitleDocument) => {
      const revision = (await repository.readSnapshot(doc.id)).document.revision;
      const plan = await translation.plan(7, doc.id, revision, config, () => {});
      const { taskId } = await translation.start(7, doc.id, revision, plan.planId, 'key');
      await translation.settled(taskId);
      return (await repository.readSnapshot(doc.id)).document;
    };
    return { service, translate, repository };
  }
  const request = (documents: SubtitleDocument[], extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), documents: documents.map(doc => ({ documentId: doc.id, revision: doc.revision })),
    model, maxOutputTokens: 1024, apiKey: 'key', ...extra });

  it('checks several documents and counts every place across them', async () => {
    const first = lrc([`${SOURCE}です`, `${SOURCE}！`], '第一集.lrc'), second = lrc([`${SOURCE}、どうぞ`, 'こんにちは'], '第二集.lrc');
    const sent: ModelRuntimeTextRequest[] = [];
    const { service, translate } = await fixture([first, second], async message => { sent.push(message); return reply({ terms: [{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: [] }] }); });
    const docs = [await translate(first), await translate(second)];
    const result = await service.check(7, request(docs, { focus: '人名' }));
    const body = JSON.parse(sent[0].messages[1].content);
    expect(body).toMatchObject({ focus: '人名', targetLanguage: 'zh' });
    expect(body.lines[0]).toEqual({ id: 'l1', source: `${SOURCE}です`, target: `${RIGHT}です` });
    expect(body.lines).toHaveLength(4);
    expect(result.checkedLines).toBe(4);
    expect(result.documents.map(item => item.name)).toEqual(['第一集.lrc', '第二集.lrc']);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].variants.map(item => [item.text, item.count, item.occurrences.map(place => place.documentId)])).toEqual([[RIGHT, 2, [docs[0].id, docs[1].id]], [WRONG, 1, [docs[0].id]]]);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('follows the chosen materials, refuses stale or oversized requests and reports bad responses', async () => {
    const doc = lrc(['ホロウへ', 'ホロウだ']);
    const library = (): LibrarySnapshot => {
      const collectionId = '40000000-0000-4000-8000-000000000001', sourceId = '40000000-0000-4000-8000-000000000002';
      const entry: Entry = { id: '40000000-0000-4000-8000-000000000003', revision: 1, title: 'ホロウ', kind: 'term', collectionId, aboutSubjectIds: [], state: 'ready',
        scope: { languagePair: { source: 'ja', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
        payload: { source: 'ホロウ', target: '空洞', aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } };
      return { generation: 1, imports: [], approvals: { [entry.id]: { revision: 1, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-10-10T00:00:00.000Z' } },
        data: { format: 'fusionkit.translation-knowledge', schemaVersion: 1, package: { id: '40000000-0000-4000-8000-000000000009', revision: 1, name: 'F', description: '', purpose: 'backup', createdAt: '2026-10-10T00:00:00.000Z', generator: { name: 'F' } },
          subjects: [], collections: [{ id: collectionId, revision: 1, archived: false, name: 'C', description: '', aboutSubjectIds: [] }], sources: [], entries: [entry], styles: [], recipes: [], preferenceTemplates: [] } };
    };
    let content: unknown = { terms: [] };
    const { service, translate } = await fixture([doc], async () => reply(content), async () => library());
    const translated = await translate(doc);
    const selection = { version: 1 as const, languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: ['40000000-0000-4000-8000-000000000001'], bindings: [], confirmations: [], disabledEntryIds: [] };
    const result = await service.check(7, request([translated], { knowledge: selection }));
    expect(result.groups).toEqual([expect.objectContaining({ kind: 'knowledge', source: 'ホロウ', recommended: '空洞' })]);
    await expect(service.check(7, request([{ ...translated, revision: translated.revision + 1 }]))).rejects.toMatchObject({ code: 'revision_conflict' });
    content = { nothing: true };
    await expect(service.check(7, request([translated]))).rejects.toMatchObject({ code: 'translation_protocol_invalid' });
    await expect(service.check(7, { ...request([translated]), documents: Array.from({ length: 21 }, () => ({ documentId: randomUUID(), revision: 1 })) })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is cancelled by its owner', async () => {
    const doc = lrc(['a', 'b']);
    let release!: () => void;
    const { service } = await fixture([doc], () => new Promise((_resolve, reject) => { release = () => reject(new Error('aborted')); }));
    const pending = service.check(7, request([doc], { requestId: '50000000-0000-4000-8000-000000000001' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    service.cancel(8, '50000000-0000-4000-8000-000000000001');
    service.cancel(7, '50000000-0000-4000-8000-000000000001');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
  });
});
