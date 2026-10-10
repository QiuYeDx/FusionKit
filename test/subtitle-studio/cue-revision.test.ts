import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import { buildCueLocateMessages, buildCueRevisionMessages, mentionsTerm, parseCueLocateResponse, parseCueRevisionResponse, type CueLocateRequest, type CueRevisionItem, type CueRevisionRequest } from '../../src/subtitle-studio/cue-revision-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import { diffText } from '../../src/services/subtitle-studio/text-diff';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { CueRevisionService } from '../../electron/main/subtitle-studio/cue-revision-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';

const metadata = { format: 'lrc' as const, displayName: 'revise-fixture.lrc', encoding: 'utf-8' as const, digest: 'e'.repeat(64) };
const lrc = (lines: string[]) => importSubtitleText(lines.map((line, index) => `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.00]${line}\n`).join(''), metadata, randomUUID);
const plain = (text: string) => ({ plain: text, spans: [{ text, marks: [] as ('b' | 'i' | 'u')[] }] });
const model = { profileId: 'revise-fixture', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const };
const config: TranslationConfig = { model, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 10 };
type Context = { source: string; target?: string };
type Payload = { request: string; editableFields: string[]; targetLanguage?: string; lineCount?: number; sample?: string[]; items: { id: string; source: string; target?: string; before?: Context; after?: Context }[] };
const payload = (request: ModelRuntimeTextRequest): Payload => JSON.parse(request.messages[1].content);
const reply = (content: unknown, finishReason = 'stop'): ModelRuntimeTextResult => ({ apiFormat: 'chat_completions', finishReason, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, content: typeof content === 'string' ? content : JSON.stringify(content) });
const translate = async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => {
  const items = (JSON.parse(request.messages[1].content) as { items: { id: string; text: string }[] }).items;
  return reply({ items: items.map(item => ({ id: item.id, text: `译:${item.text}` })) });
};

const roots: string[] = [];
const services: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(doc: SubtitleDocument, send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>, readKnowledge?: () => Promise<LibrarySnapshot>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-revision-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const translation = new TranslationService(repository, translate);
  const revisions = new CueRevisionService(repository, send, readKnowledge);
  services.push(translation, revisions);
  const edits = new CueEditService(repository);
  const read = () => repository.readSnapshot(doc.id);
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).document.revision, operation);
  const translateAll = async () => {
    const revision = (await read()).document.revision;
    const plan = await translation.plan(7, doc.id, revision, config, () => {});
    const { taskId } = await translation.start(7, doc.id, revision, plan.planId, 'fixture-key');
    await translation.settled(taskId);
    return read();
  };
  const revise = async (changes: Partial<CueRevisionRequest> = {}) => {
    const snapshot = await read();
    return revisions.revise(7, { documentId: doc.id, revision: snapshot.document.revision, requestId: randomUUID(), cueIds: snapshot.document.cues.map(cue => cue.id),
      fields: 'source', instructions: 'fix it', model, maxOutputTokens: 1024, apiKey: 'fixture-key', ...changes });
  };
  const locate = async (changes: Partial<CueLocateRequest> = {}) => {
    const snapshot = await read();
    return revisions.locate(7, { documentId: doc.id, revision: snapshot.document.revision, requestId: randomUUID(),
      fields: 'source', instructions: 'fix it', model, maxOutputTokens: 1024, apiKey: 'fixture-key', ...changes });
  };
  return { read, edit, translateAll, revise, locate, revisions };
}

describe('cue revision protocol', () => {
  const items: CueRevisionItem[] = [
    { id: 'c1', cueId: 'cue-a', source: 'Deep sea is great', target: '深海很棒' },
    { id: 'c2', cueId: 'cue-b', source: 'Second line' },
  ];

  it('lists the editable fields and the items with their read-only neighbours', () => {
    const messages = buildCueRevisionMessages({ instructions: '"Deep sea" is DeepSeek', fields: 'both', targetLanguage: 'zh', items: [{ ...items[0], before: { source: 'Before' } }, items[1]] });
    expect(messages[0].role).toBe('system');
    expect(JSON.parse(messages[1].content)).toEqual({
      request: '"Deep sea" is DeepSeek', editableFields: ['source', 'target'], targetLanguage: 'zh',
      items: [{ id: 'c1', source: 'Deep sea is great', target: '深海很棒', before: { source: 'Before' } }, { id: 'c2', source: 'Second line' }],
    });
    expect(JSON.parse(buildCueLocateMessages({ instructions: 'x', fields: 'target', cueCount: 3, sample: ['a'] })[1].content)).toEqual({ request: 'x', editableFields: ['target'], lineCount: 3, sample: ['a'] });
  });

  it('reads search plans and falls back to checking every line', () => {
    expect(parseCueLocateResponse(JSON.stringify({ strategy: 'terms', terms: [' 法尔童 ', '法尔童', '', 7, '法而童'], note: '查找误写' }), 10)).toEqual({ strategy: 'terms', terms: ['法尔童', '法而童'], note: '查找误写' });
    expect(parseCueLocateResponse(JSON.stringify({ strategy: 'lines', lines: [12, 3, 3, 0, 2.5] }), 20)).toEqual({ strategy: 'lines', lines: [3, 12] });
    expect(parseCueLocateResponse(JSON.stringify({ strategy: 'lines', lines: [99] }), 20)).toEqual({ strategy: 'all' });
    expect(parseCueLocateResponse(JSON.stringify({ strategy: 'terms', terms: [] }), 20)).toEqual({ strategy: 'all' });
    expect(() => parseCueLocateResponse(JSON.stringify({ strategy: 'guess' }), 20)).toThrow('translation_protocol_invalid');
  });

  it('matches terms exactly and near misses of long enough terms', () => {
    expect(mentionsTerm('我们看到了法尔童的马车', ['法尔童'])).toBe(true);
    // One wrong character in a three-character name is a likely mis-transcription.
    expect(mentionsTerm('我们看到了法而童的马车', ['法尔童'])).toBe(true);
    expect(mentionsTerm('我们看到了马车', ['法尔童'])).toBe(false);
    // Two-character terms match exactly only.
    expect(mentionsTerm('天空很蓝', ['天气'])).toBe(false);
    expect(mentionsTerm('PHAETHON drove the chariot', ['Phaethon'])).toBe(true);
    expect(mentionsTerm('Phaeton drove the chariot', ['Phaethon'])).toBe(true);
    expect(mentionsTerm('Python drove the chariot', ['Phaethon'])).toBe(false);
  });

  it('keeps changed fields, ignores the rest and counts texts that cannot be saved', () => {
    const parsed = parseCueRevisionResponse('```json\n' + JSON.stringify({
      items: [
        { id: 'c1', source: ' DeepSeek is great \r\n', target: 'DeepSeek 很棒' },
        { id: 'c1', source: 'repeated' },
        { id: 'c9', source: 'unknown' },
        { id: 'c2', source: 'Second <i>line</i>' },
      ],
      note: '  Fixed the name.  ',
    }) + '\n```', items, 'source');
    // Translation edits are not allowed here and are ignored.
    expect([...parsed.proposals]).toEqual([['cue-a', { source: 'DeepSeek is great' }]]);
    expect(parsed).toMatchObject({ note: 'Fixed the name.', rejected: 1 });
    expect(parseCueRevisionResponse(JSON.stringify({ items: [{ id: 'c1', source: 'Deep sea is great', target: '深海很棒' }] }), items, 'both').proposals.size).toBe(0);
    expect(() => parseCueRevisionResponse('{"changes":[]}', items, 'both')).toThrow('translation_protocol_invalid');
    expect(() => parseCueRevisionResponse('not json', items, 'both')).toThrow('translation_protocol_invalid');
  });

  it('diffs words and CJK characters', () => {
    expect(diffText('Deep sea is great', 'DeepSeek is great')).toEqual([{ kind: 'removed', text: 'Deep sea' }, { kind: 'added', text: 'DeepSeek' }, { kind: 'same', text: ' is great' }]);
    expect(diffText('深度求锁发布了模型', '深度求索发布了模型')).toEqual([{ kind: 'same', text: '深度求' }, { kind: 'removed', text: '锁' }, { kind: 'added', text: '索' }, { kind: 'same', text: '发布了模型' }]);
    expect(diffText('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
    // A rewrite sharing only scraps shows the old text, then the new one.
    expect(diffText('译 Deep sea says it is open', 'DeepSeek 表示它是开源的')).toEqual([{ kind: 'removed', text: '译 Deep sea says it is open' }, { kind: 'added', text: 'DeepSeek 表示它是开源的' }]);
  });
});

describe('cue revision service', () => {
  it('proposes source revisions with neighbouring context and keeps a current translation that still fits', async () => {
    const requests: Payload[] = [];
    const current = await fixture(lrc(['Hello', 'Deep sea released a model', 'It is open', 'Bye']), async request => {
      const body = payload(request); requests.push(body);
      return reply({ items: [{ id: body.items[0].id, source: 'DeepSeek released a model' }], note: 'Corrected the company name.' });
    });
    const snapshot = await current.translateAll();
    const [, second] = snapshot.document.cues;
    const result = await current.revise({ cueIds: [second.id], fields: 'both', trackId: snapshot.document.translationTracks[0].id, instructions: '"Deep sea" is DeepSeek' });
    expect(requests[0]).toMatchObject({
      request: '"Deep sea" is DeepSeek', editableFields: ['source', 'target'], targetLanguage: 'zh',
      items: [{ id: 'c1', source: 'Deep sea released a model', target: '译:Deep sea released a model', before: { source: 'Hello', target: '译:Hello' }, after: { source: 'It is open', target: '译:It is open' } }],
    });
    expect(result).toMatchObject({ revision: snapshot.document.revision, notes: ['Corrected the company name.'], rejected: 0, usage: { totalTokens: 15 } });
    expect(result.proposals).toEqual([{ cueId: second.id, index: 1, current: { source: second.source, target: snapshot.document.translationTracks[0].entries[second.id].text }, source: 'DeepSeek released a model', target: '译:Deep sea released a model', keptTarget: true }]);
    // Nothing is written until the proposals are applied.
    expect((await current.read()).document.revision).toBe(snapshot.document.revision);
  });

  it('splits a large selection into concurrent requests and merges them in document order', async () => {
    const lines = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`);
    let calls = 0;
    const current = await fixture(lrc(lines), async request => {
      calls++;
      const body = payload(request);
      return reply({ items: body.items.filter(item => item.source.endsWith('0')).map(item => ({ id: item.id, source: item.source.toUpperCase() })) });
    });
    const result = await current.revise();
    expect(calls).toBe(3);
    expect(result.proposals.map(item => item.source)).toEqual(['LINE 10', 'LINE 20', 'LINE 30', 'LINE 40', 'LINE 50', 'LINE 60', 'LINE 70', 'LINE 80', 'LINE 90']);
    expect(result.usage.totalTokens).toBe(45);
  });

  it('locates a document-wide request by wording, line numbers or every line', async () => {
    const lines = ['法尔童驾着太阳车', '天空很亮', '法而童失去了控制', '宙斯出手了', '', '法厄同坠落了'];
    let plan: unknown = { strategy: 'terms', terms: ['法尔童'], note: '查找相近写法' };
    const requests: Payload[] = [];
    const current = await fixture(lrc(lines), async request => { requests.push(payload(request)); return reply(plan); });
    const cues = (await current.read()).document.cues;
    const found = await current.locate({ instructions: '文中的法尔童应为法厄同' });
    expect(requests[0]).toMatchObject({ request: '文中的法尔童应为法厄同', lineCount: cues.length, sample: lines.filter(Boolean) });
    expect(found).toMatchObject({ plan: { strategy: 'terms', terms: ['法尔童'] }, total: cues.length, usage: { totalTokens: 15 } });
    expect(found.cueIds).toEqual([cues[0].id, cues[2].id]);
    plan = { strategy: 'lines', lines: [4] };
    expect((await current.locate()).cueIds).toEqual([cues[3].id]);
    plan = { strategy: 'all' };
    // Blank lines have nothing to revise.
    expect((await current.locate()).cueIds).toEqual(cues.filter(cue => cue.source.plain.trim()).map(cue => cue.id));
    await expect(current.locate({ revision: 99 })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('finds cues by wording or number without a model', async () => {
    let calls = 0;
    const current = await fixture(lrc(['法尔童驾车', '天空', '法而童失控', '法厄同坠落']), async () => { calls++; return reply({ items: [] }); });
    const snapshot = await current.translateAll();
    const [first, , third, fourth] = snapshot.document.cues;
    const trackId = snapshot.document.translationTracks[0].id;
    const base = { documentId: snapshot.document.id, revision: snapshot.document.revision };
    const found = await current.revisions.find({ ...base, trackId, terms: ['法尔童'], limit: 1 });
    expect(found).toMatchObject({ total: 2, cueIds: [first.id, third.id], matches: [{ cueId: first.id, index: 0, source: '法尔童驾车', target: '译:法尔童驾车' }] });
    // Translations are searched too.
    expect((await current.revisions.find({ ...base, trackId, terms: ['译:法厄同'] })).cueIds).toEqual([fourth.id]);
    expect((await current.revisions.find({ ...base, lines: [4, 1, 4, 99] })).cueIds).toEqual([first.id, fourth.id]);
    expect(calls).toBe(0);
    await expect(current.revisions.find({ ...base, revision: 99, lines: [1] })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(current.revisions.find({ ...base, lines: [1], terms: ['x'] })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('gives each scattered line its own neighbours', async () => {
    const requests: Payload[] = [];
    const current = await fixture(lrc(['A', 'B', 'C', 'D', 'E']), async request => { requests.push(payload(request)); return reply({ items: [] }); });
    const cues = (await current.read()).document.cues;
    await current.revise({ cueIds: [cues[3].id, cues[1].id, cues[2].id] });
    expect(requests[0].items).toEqual([
      { id: 'c1', source: 'B', before: { source: 'A' } },
      { id: 'c2', source: 'C' },
      { id: 'c3', source: 'D', after: { source: 'E' } },
    ]);
  });

  it('reports stale revisions, output limits and cancellation', async () => {
    let release!: () => void;
    const current = await fixture(lrc(['One', 'Two']), async request => {
      if (payload(request).request === 'wait') {
        await new Promise<void>(resolve => { release = resolve; request.signal!.addEventListener('abort', () => resolve()); });
        throw Object.assign(new Error('aborted'), { code: 'aborted' });
      }
      return reply('{"items":[', 'length');
    });
    await expect(current.revise({ revision: 99 })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(current.revise()).rejects.toMatchObject({ code: 'translation_output_limit' });
    const requestId = randomUUID();
    const pending = current.revise({ requestId, instructions: 'wait' });
    await new Promise(resolve => setTimeout(resolve, 20));
    current.revisions.cancel(7, requestId);
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
    release?.();
  });
});

describe('revise edits', () => {
  it('applies sources and translations as one edit whose undo and redo are exact', async () => {
    const current = await fixture(lrc(['Hello', 'Deep sea', 'Bye']), async () => reply({ items: [] }));
    const snapshot = await current.translateAll();
    const track = snapshot.document.translationTracks[0];
    const [first, second, third] = snapshot.document.cues;
    const revised = await current.edit({ kind: 'revise', sources: { [second.id]: plain('DeepSeek'), [third.id]: third.source }, trackId: track.id,
      targets: { [first.id]: track.entries[first.id].text, [second.id]: plain('深度求索') } });
    expect(revised.changed).toBe(1);
    const after = revised.snapshot.document;
    expect(after.cues[1]).toMatchObject({ source: plain('DeepSeek'), sourceRevision: second.sourceRevision + 1 });
    expect(after.cues[2]).toEqual(third);
    expect(after.translationTracks[0].entries[second.id]).toEqual({ sourceRevision: second.sourceRevision + 1, sourceHash: sourceDigest(after.cues[1]), text: plain('深度求索'), origin: 'ai', reviewStatus: 'reviewed' });
    // An unchanged current translation is not a change.
    expect(after.translationTracks[0].entries[first.id]).toEqual(track.entries[first.id]);
    expect(after.translationTracks[0].revision).toBe(track.revision + 1);

    const undone = await current.edit(revised.undo);
    const restored = undone.snapshot.document;
    expect(restored.cues[1].source).toEqual(second.source);
    expect(restored.translationTracks[0].entries[second.id]).toEqual({ ...track.entries[second.id], sourceRevision: restored.cues[1].sourceRevision });

    const redone = await current.edit(undone.undo);
    expect(redone.snapshot.document.cues[1].source).toEqual(plain('DeepSeek'));
    expect(redone.snapshot.document.translationTracks[0].entries[second.id]).toMatchObject({ text: plain('深度求索'), sourceRevision: redone.snapshot.document.cues[1].sourceRevision, origin: 'ai' });
  });

  it('keeps a confirmed translation current and leaves an unrevised one stale', async () => {
    const current = await fixture(lrc(['Hello', 'Deep sea']), async () => reply({ items: [] }));
    const snapshot = await current.translateAll();
    const track = snapshot.document.translationTracks[0];
    const [first, second] = snapshot.document.cues;
    const revised = await current.edit({ kind: 'revise', sources: { [first.id]: plain('Hello there'), [second.id]: plain('DeepSeek') }, trackId: track.id,
      targets: { [first.id]: track.entries[first.id].text } });
    const after = revised.snapshot.document;
    expect(revised.changed).toBe(2);
    expect(after.translationTracks[0].entries[first.id]).toEqual({ ...track.entries[first.id], sourceRevision: after.cues[0].sourceRevision, sourceHash: sourceDigest(after.cues[0]) });
    expect(after.translationTracks[0].entries[second.id].sourceRevision).not.toBe(after.cues[1].sourceRevision);
    const restored = (await current.edit(revised.undo)).snapshot.document;
    expect(restored.cues.map(cue => cue.source)).toEqual([first.source, second.source]);
    for (const cue of restored.cues) expect(restored.translationTracks[0].entries[cue.id]).toEqual({ ...track.entries[cue.id], sourceRevision: cue.sourceRevision });
  });

  it('rejects translations without a track and text that cannot be stored', async () => {
    const current = await fixture(lrc(['Hello']), async () => reply({ items: [] }));
    const [cue] = (await current.read()).document.cues;
    await expect(current.edit({ kind: 'revise', sources: {}, targets: { [cue.id]: plain('你好') } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(current.edit({ kind: 'revise', sources: { [cue.id]: plain(' ') } })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await current.edit({ kind: 'revise', sources: { [cue.id]: cue.source } })).changed).toBe(0);
  });
});

describe('cue revisions and translation materials', () => {
  const SOURCE = 'テイムフィールド家のお嬢様';
  const TARGET = '泰姆菲尔德家的大小姐';
  const collectionId = '30000000-0000-4000-8000-000000000001';
  function library(): LibrarySnapshot {
    const data: LibrarySnapshot['data'] = { format: 'fusionkit.translation-knowledge', schemaVersion: 1,
      package: { id: '30000000-0000-4000-8000-000000000009', revision: 1, name: 'Fixture', description: '', purpose: 'backup', createdAt: '2026-10-10T00:00:00.000Z', generator: { name: 'FusionKit' } },
      subjects: [], collections: [], sources: [], entries: [], styles: [], recipes: [], preferenceTemplates: [] };
    const sourceId = '30000000-0000-4000-8000-000000000002';
    data.collections = [{ id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物', description: '', aboutSubjectIds: [], defaultLanguagePair: { source: 'ja', target: 'zh-Hans' } }];
    data.sources = [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Note', excerpt: 'note' }];
    const entry: Entry = { id: '30000000-0000-4000-8000-000000000003', revision: 1, title: SOURCE, kind: 'term', collectionId, aboutSubjectIds: [], state: 'ready',
      scope: { languagePair: { source: 'ja', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
      payload: { source: SOURCE, target: TARGET, aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } };
    data.entries = [entry];
    return { generation: 3, data, approvals: { [entry.id]: { revision: 1, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-10-10T00:00:00.000Z' } }, imports: [] };
  }
  const selection = { version: 1 as const, languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: [collectionId], bindings: [], confirmations: [], disabledEntryIds: [] };
  const lines = [`${SOURCE}がお見えです。`, 'こんにちは。', `${SOURCE}、こちらへ。`];

  it('sends only the materials that apply to each line and keeps the wordings the texts bear out', async () => {
    const requests: ModelRuntimeTextRequest[] = [];
    let reads = 0;
    const current = await fixture(lrc(lines), async request => {
      requests.push(request);
      const body = payload(request);
      return reply({ items: body.items.filter(item => item.source.includes(SOURCE)).map(item => ({ id: item.id, target: `${TARGET}来了` })),
        knowledge: [{ source: SOURCE, target: TARGET, note: '家族名' }, { source: '存在しない', target: '不存在' }, { source: SOURCE, target: '没有出现的译法' }, { source: 'a<b', target: 'x' }],
        note: '统一了家族名。' });
    }, async () => { reads++; return library(); });
    const snapshot = await current.translateAll();
    const trackId = snapshot.document.translationTracks[0].id;
    const [first, , third] = snapshot.document.cues;
    const result = await current.revise({ fields: 'target', trackId, knowledge: selection, instructions: '应该是泰姆菲尔德家的大小姐' });
    expect(reads).toBe(1);
    const body = JSON.parse(requests.at(-1)!.messages[1].content);
    expect(body.translationKnowledge.items).toEqual([expect.objectContaining({ kind: 'term', applicableItemIds: ['c1', 'c3'] })]);
    expect(requests.at(-1)!.messages[0].content).toContain('translationKnowledge and translationRequirements');
    expect(requests.at(-1)!.messages[0].content).toContain('"knowledge"');
    expect(result.knowledgeItems).toBe(1);
    expect(result.knowledgeHints).toEqual([{ source: SOURCE, target: TARGET, note: '家族名', cueIds: [first.id, third.id] }]);
  });

  it('merges a wording suggested by several requests', async () => {
    const many = Array.from({ length: 45 }, (_, index) => index % 2 ? `${SOURCE} ${index}` : `line ${index}`);
    const current = await fixture(lrc(many), async request => {
      const body = payload(request);
      return reply({ items: body.items.filter(item => item.source.includes(SOURCE)).map(item => ({ id: item.id, target: `${TARGET} ${item.id}` })),
        knowledge: [{ source: SOURCE, target: TARGET }] });
    });
    const snapshot = await current.translateAll();
    const result = await current.revise({ fields: 'target', trackId: snapshot.document.translationTracks[0].id, instructions: 'unify' });
    expect(result.knowledgeHints).toHaveLength(1);
    expect(result.knowledgeHints![0].cueIds).toHaveLength(22);
    // No materials were chosen: requests carry none.
    expect(result.knowledgeItems).toBeUndefined();
  });

  it('asks for nothing extra when only the source may change, and reads no library without materials chosen', async () => {
    const requests: ModelRuntimeTextRequest[] = [];
    let reads = 0;
    const current = await fixture(lrc(lines), async request => {
      requests.push(request);
      return reply({ items: [], knowledge: [{ source: SOURCE, target: TARGET }], note: 'ok' });
    }, async () => { reads++; return library(); });
    const snapshot = await current.translateAll();
    const result = await current.revise({ fields: 'source', knowledge: selection });
    expect(reads).toBe(0);
    expect(requests.at(-1)!.messages[0].content).not.toContain('"knowledge"');
    expect(JSON.parse(requests.at(-1)!.messages[1].content).translationKnowledge).toBeUndefined();
    expect(result.knowledgeHints).toBeUndefined();
    const noMaterials = await current.revise({ fields: 'target', trackId: snapshot.document.translationTracks[0].id, knowledge: { ...selection, collectionIds: [] } });
    expect(reads).toBe(0);
    expect(noMaterials.knowledgeHints).toEqual([]);
  });

  it('revises without materials when the library cannot be read', async () => {
    const requests: ModelRuntimeTextRequest[] = [];
    const current = await fixture(lrc(lines), async request => { requests.push(request); return reply({ items: [], note: 'ok' }); }, async () => { throw new Error('locked'); });
    const snapshot = await current.translateAll();
    const result = await current.revise({ fields: 'target', trackId: snapshot.document.translationTracks[0].id, knowledge: selection });
    expect(JSON.parse(requests.at(-1)!.messages[1].content).translationKnowledge).toBeUndefined();
    expect(result.notes).toEqual(['ok']);
  });
});
