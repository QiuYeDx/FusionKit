import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { canRevertBilingual, interpretBilingualImport } from '../../src/subtitle-studio/bilingual';
import { STUDIO_CHANNELS, summarizeDocument } from '../../src/subtitle-studio/ipc-contract';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { applyCueEdit } from '../../electron/main/subtitle-studio/cue-edit-service';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '', open: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: adapter.open, showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  ipcMain: { on: (channel: string, handler: Function) => adapter.listeners.set(channel, handler), handle: (channel: string, handler: Function) => adapter.handlers.set(channel, handler), removeAllListeners: (channel: string) => adapter.listeners.delete(channel), removeHandler: (channel: string) => adapter.handlers.delete(channel) },
}));
import { registerSubtitleStudio } from '../../electron/main/subtitle-studio';

/** The opening of the user's file: each timestamp holds a Japanese line, then its Chinese translation. */
const PAIRS: [string, string, string][] = [
  ['00:02.420', '先輩、おはようございます。', '前辈，早上好。'],
  ['00:08.020', 'って、もう眠そうじゃないですか。', '话说，你看起来已经很困了嘛。'],
  ['00:11.020', 'まだ朝なのに。', '明明还是早上。'],
  ['00:13.020', 'ん?なんですか?', '嗯？怎么了？'],
  ['00:15.970', '君は白鸽だから?', '因为你是白鸽吗？'],
  ['00:18.770', '朝元気なだけ?', '只是早上比较有精神？'],
  ['00:20.770', 'そんなことないです。', '才不是那样。'],
  ['00:22.770', '私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '我认识的人里，同族的居民白鸽和麻雀当中，'],
  ['00:26.780', '先輩みたいに朝から眠そうにしてる方、', '像前辈这样一大早就犯困的，'],
  ['00:27.500', '先輩みたいに朝から眠そうにしてる方', '像前辈这样一大早就犯困的'],
  ['00:29.860', 'いますもん', '也是有的。'],
  // A Japanese line written in kanji only reads as Chinese: a pair to review, still paired.
  ['00:31.000', '先輩', '前辈'],
];
const lrc = (order: 'source-first' | 'target-first') => PAIRS.map(([time, ja, zh]) => order === 'source-first' ? `[${time}]${ja}\n[${time}]${zh}\n` : `[${time}]${zh}\n[${time}]${ja}\n`).join('');
const origin = (displayName: string, format: 'lrc' | 'srt' = 'lrc') => ({ format, displayName, encoding: 'utf-8' as const, digest: 'f'.repeat(64) });
const interpret = (text: string, name = 'pairs.lrc') => interpretBilingualImport(importSubtitleText(text, origin(name), randomUUID), randomUUID, sourceDigest);
const sources = (doc: SubtitleDocument) => doc.cues.map(cue => cue.source.plain);
const targets = (doc: SubtitleDocument) => doc.cues.map(cue => doc.translationTracks[0]?.entries[cue.id]?.text.plain);

describe('bilingual files at import', () => {
  it('separates a clearly bilingual LRC into Japanese source and its Chinese translation', () => {
    const doc = interpret(lrc('source-first'));
    expect(doc.cues).toHaveLength(PAIRS.length);
    expect(sources(doc)).toEqual(PAIRS.map(pair => pair[1]));
    expect(targets(doc)).toEqual(PAIRS.map(pair => pair[2]));
    expect(doc.bilingualImport).toEqual({ sourceSide: 'first', sourceLanguage: 'ja', targetLanguage: 'zh' });
    expect(doc.translationTracks).toEqual([expect.objectContaining({ origin: 'imported', language: 'zh' })]);
    expect(Object.values(doc.translationTracks[0].entries).every(entry => entry.origin === 'imported' && entry.reviewStatus === 'unreviewed')).toBe(true);
    expect(summarizeDocument(doc)).toMatchObject({ cueCount: PAIRS.length, bilingualImport: { sourceLanguage: 'ja', targetLanguage: 'zh' }, bilingualRevertible: true, translationStatus: 'complete' });
  });

  it('takes the Chinese side as the translation when it comes first', () => {
    const doc = interpret(lrc('target-first'));
    expect(doc.bilingualImport).toEqual({ sourceSide: 'second', sourceLanguage: 'ja', targetLanguage: 'zh' });
    expect(sources(doc)).toEqual(PAIRS.map(pair => pair[1]));
    expect(targets(doc)).toEqual(PAIRS.map(pair => pair[2]));
  });

  it('keeps single-language and unclear files as imported', () => {
    const mono = interpret(PAIRS.map(([time, ja]) => `[${time}]${ja}\n`).join(''));
    expect(mono.translationTracks).toEqual([]);
    expect(mono.bilingualImport).toBeUndefined();
    // Two pairs among many single lines: below the recommendation threshold.
    const sparse = interpret(PAIRS.slice(0, 2).map(([time, ja, zh]) => `[${time}]${ja}\n[${time}]${zh}\n`).join('') + PAIRS.slice(2).map(([time, ja]) => `[${time}]${ja}\n`).join(''));
    expect(sparse.translationTracks).toEqual([]);
    expect(sparse.cues).toHaveLength(PAIRS.length + 2);
    expect(summarizeDocument(sparse).bilingualAvailable).toBe(true);
  });
});

describe('importing again as it was', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function stored(doc: SubtitleDocument) {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-bilingual-import-')); roots.push(root);
    const repository = new DocumentRepository(root);
    await repository.create(doc);
    return { repository, service: new BilingualService(repository) };
  }

  it('rebuilds the flat document from the original text', async () => {
    const doc = interpret(lrc('source-first'));
    const { repository, service } = await stored(doc);
    const reverted = await service.revert(doc.id, doc.revision);
    expect(reverted).toMatchObject({ id: doc.id, revision: doc.revision + 1, translationTracks: [] });
    expect(reverted.bilingualImport).toBeUndefined();
    expect(sources(reverted)).toEqual(PAIRS.flatMap(pair => [pair[1], pair[2]]));
    expect(summarizeDocument(reverted)).toMatchObject({ bilingualAvailable: true, bilingualRecommended: true });
    expect(await repository.read(doc.id)).toEqual(reverted);
  });

  it('refuses once anything was edited after the separation', async () => {
    const doc = interpret(lrc('source-first'));
    const { repository, service } = await stored(doc);
    await repository.transact(doc.id, doc.revision, snapshot => { applyCueEdit(snapshot, { kind: 'review', trackId: snapshot.document.translationTracks[0].id, cueIds: [snapshot.document.cues[0].id], reviewed: true }); });
    const edited = await repository.read(doc.id);
    expect(canRevertBilingual(edited)).toBe(false);
    expect(summarizeDocument(edited).bilingualRevertible).toBeUndefined();
    await expect(service.revert(doc.id, edited.revision)).rejects.toMatchObject({ code: 'revision_conflict' });
    const deleted = interpret(lrc('source-first'));
    const second = await stored(deleted);
    await second.repository.transact(deleted.id, 1, snapshot => { applyCueEdit(snapshot, { kind: 'delete', cueIds: [snapshot.document.cues[0].id] }); });
    expect(canRevertBilingual(await second.repository.read(deleted.id))).toBe(false);
  });
});

describe('every import entry point', () => {
  let registration: ReturnType<typeof registerSubtitleStudio> | undefined;
  afterEach(async () => {
    await registration?.dispose(); registration = undefined;
    if (adapter.directory) await rm(adapter.directory, { recursive: true, force: true });
    adapter.open.mockReset();
  });

  it('separates bilingual files picked together with single-language ones, and reverts over IPC', async () => {
    adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-bilingual-ipc-'));
    const bilingual = path.join(adapter.directory, '01 双语.lrc');
    const mono = path.join(adapter.directory, '02 单语.srt');
    await writeFile(bilingual, lrc('source-first'));
    await writeFile(mono, '1\n00:00:01,000 --> 00:00:02,000\nこんにちは。\n\n2\n00:00:03,000 --> 00:00:04,000\nまたね。\n');
    adapter.open.mockResolvedValue({ canceled: false, filePaths: [bilingual, mono] });
    registration = registerSubtitleStudio();
    const client = Object.assign(new EventEmitter(), { id: 1, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false, send: vi.fn() });
    registration.attach(client as never);
    const event = { sender: client, senderFrame: client.mainFrame, returnValue: null as unknown };
    adapter.listeners.get(STUDIO_CHANNELS.register)!(event, {});
    const invoke = (channel: string, payload: unknown) => adapter.handlers.get(channel)!({ sender: client, senderFrame: client.mainFrame }, { capability: event.returnValue, payload });
    const imported = await invoke(STUDIO_CHANNELS.importSubtitles, { encoding: 'utf-8' });
    expect(imported.ok).toBe(true);
    const [first, second] = imported.value.items;
    expect(first.document).toMatchObject({ cueCount: PAIRS.length, bilingualImport: { sourceLanguage: 'ja', targetLanguage: 'zh' }, bilingualRevertible: true });
    expect(second.document).toMatchObject({ cueCount: 2, translationTracks: [] });
    expect(second.document.bilingualImport).toBeUndefined();
    // Typed paths, as the assistant imports, go the same way.
    const typed = await invoke(STUDIO_CHANNELS.importSubtitlePaths, { encoding: 'utf-8', paths: [bilingual] });
    expect(typed.value.items[0].document).toMatchObject({ cueCount: PAIRS.length, bilingualRevertible: true });
    const reverted = await invoke(STUDIO_CHANNELS.revertBilingual, { documentId: first.document.id, revision: first.document.revision });
    expect(reverted).toMatchObject({ ok: true, value: { cueCount: PAIRS.length * 2, translationTracks: [], bilingualAvailable: true } });
    expect(await invoke(STUDIO_CHANNELS.revertBilingual, { documentId: first.document.id, revision: reverted.value.revision })).toEqual({ ok: false, error: 'revision_conflict' });
  });
});
