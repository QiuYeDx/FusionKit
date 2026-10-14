import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import type { CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import { searchDocument } from '../../src/subtitle-studio/cue-find';
import { applyCueEdit, CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { searchCuesInDocument } from '../../electron/main/subtitle-studio/cue-find-worker';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';

const time = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
/** Lines 3, 120 and 240 mention 法尔童 (line 120 twice); the rest are numbered. */
const srt = (count = 250, mention = (index: number) => [2, 119, 239].includes(index)) => importSubtitleText(Array.from({ length: count }, (_, index) =>
  `${index + 1}\n${time(index * 1000)} --> ${time(index * 1000 + 500)}\n${mention(index) ? (index === 119 ? '法尔童和法尔童' : '这是法尔童') : `第 ${index + 1} 句`}\n`).join('\n'),
{ format: 'srt', displayName: 'find.srt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(doc: SubtitleDocument) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-find-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const edits = new CueEditService(repository);
  const read = async () => (await repository.readSnapshot(doc.id)).document;
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).revision, operation);
  return { read, edit };
}
const sources = (doc: SubtitleDocument) => doc.cues.map(cue => cue.source.plain);

describe('replacing text in cues', () => {
  it('replaces every match on every page, and undoes all of it at once', async () => {
    const current = await fixture(srt());
    const before = await current.read();
    const replaced = await current.edit({ kind: 'replace', query: '法尔童', replacement: '法厄同', matchCase: true, field: 'source' });
    const doc = replaced.snapshot.document;
    expect(replaced.changed).toBe(3);
    expect([doc.cues[2], doc.cues[119], doc.cues[239]].map(cue => cue.source.plain)).toEqual(['这是法厄同', '法厄同和法厄同', '这是法厄同']);
    expect(searchDocument(doc, { query: '法尔童', field: 'both', matchCase: true }).cues).toEqual([]);
    const undone = await current.edit(replaced.undo);
    expect(sources(undone.snapshot.document)).toEqual(sources(before));
  });

  it('replaces only the given cues', async () => {
    const current = await fixture(srt());
    const doc = await current.read();
    const replaced = await current.edit({ kind: 'replace', query: '法尔童', replacement: '法厄同', matchCase: true, field: 'source', cueIds: [doc.cues[119].id] });
    expect(replaced.changed).toBe(1);
    expect(sources(replaced.snapshot.document)[119]).toBe('法厄同和法厄同');
    expect(sources(replaced.snapshot.document)[2]).toBe('这是法尔童');
  });

  it('replaces translations as human ones, and both fields together', async () => {
    const doc = srt(5);
    const trackId = randomUUID();
    const entry = (index: number, value: string) => ({ sourceRevision: 1, sourceHash: sourceDigest(doc.cues[index]), text: { plain: value, spans: [{ text: value, marks: [] }] }, origin: 'ai' as const, reviewStatus: 'unreviewed' as const });
    doc.translationTracks.push({ id: trackId, language: 'en', revision: 1, entries: { [doc.cues[2].id]: entry(2, 'This is Faertong') } });
    const current = await fixture(doc);
    const target = await current.edit({ kind: 'replace', query: 'faertong', replacement: 'Phaethon', matchCase: false, field: 'target', trackId });
    expect(target.snapshot.document.translationTracks[0].entries[doc.cues[2].id]).toMatchObject({ text: { plain: 'This is Phaethon' }, origin: 'human', reviewStatus: 'reviewed' });
    expect(sources(target.snapshot.document)[2]).toBe('这是法尔童');
    const undone = (await current.edit(target.undo)).snapshot.document;
    expect(undone.translationTracks[0].entries[doc.cues[2].id]).toMatchObject({ text: { plain: 'This is Faertong' }, origin: 'ai', reviewStatus: 'unreviewed' });
    // Both: only fields with a match change; a translation left as it was is then out of date,
    // while one replaced along with its source is current.
    const both = (await current.edit({ kind: 'replace', query: '法尔童', replacement: 'Faertong', matchCase: true, field: 'both', trackId })).snapshot.document;
    const cue = both.cues[2];
    expect(cue.source.plain).toBe('这是Faertong');
    expect(both.translationTracks[0].entries[cue.id]!.sourceRevision).toBe(cue.sourceRevision - 1);
    const twice = (await current.edit({ kind: 'replace', query: 'Faertong', replacement: 'Phaethon', matchCase: true, field: 'both', trackId })).snapshot.document;
    expect(twice.cues[2].source.plain).toBe('这是Phaethon');
    expect(twice.translationTracks[0].entries[cue.id]).toMatchObject({ text: { plain: 'This is Phaethon' }, sourceRevision: twice.cues[2].sourceRevision, origin: 'human' });
  });

  it('refuses an empty result, markup in the replacement, more than 1000 cues or a running translation, and changes nothing', async () => {
    const current = await fixture(srt(5, index => index === 1));
    const before = await current.read();
    await expect(current.edit({ kind: 'replace', query: '第 1 句', replacement: '', matchCase: true, field: 'source' })).rejects.toThrow('invalid_input');
    await expect(current.edit({ kind: 'replace', query: '法尔童', replacement: '<i>x</i>', matchCase: true, field: 'source' })).rejects.toThrow('invalid_input');
    expect((await current.read()).revision).toBe(before.revision);
    const many = await fixture(srt(1001, () => true));
    await expect(many.edit({ kind: 'replace', query: '法尔童', replacement: '法厄同', matchCase: true, field: 'source' })).rejects.toThrow('limit_exceeded');
    const document = await current.read();
    const busy = { schemaVersion: 1, document, tasks: [{ status: 'running' }] } as unknown as Parameters<typeof applyCueEdit>[0];
    expect(() => applyCueEdit(busy, { kind: 'replace', query: '法尔童', replacement: 'x', matchCase: true, field: 'source' })).toThrow('resource_busy');
  });
});

describe('regular expression and whole word replace', () => {
  it('replaces with capture groups through the worker, and undoes it', async () => {
    const current = await fixture(srt(30, index => index === 4 || index === 20));
    const before = await current.read();
    const replaced = await current.edit({ kind: 'replace', query: String.raw`(法)(尔)童`, replacement: '$1厄$2', matchCase: true, regex: true, field: 'source' });
    expect(replaced.changed).toBe(2);
    expect(replaced.snapshot.document.cues[4].source.plain).toBe('这是法厄尔');
    const undone = await current.edit(replaced.undo);
    expect(sources(undone.snapshot.document)).toEqual(sources(before));
  });

  it('refuses an invalid pattern, an empty result and markup from an expansion, leaving the document as it was', async () => {
    const current = await fixture(srt(10, index => index === 3));
    const before = await current.read();
    await expect(current.edit({ kind: 'replace', query: '(法尔童', replacement: 'x', matchCase: true, regex: true, field: 'source' })).rejects.toMatchObject({ code: 'invalid_pattern' });
    await expect(current.edit({ kind: 'replace', query: String.raw`^.*$`, replacement: '', matchCase: true, regex: true, field: 'source' })).rejects.toBeTruthy();
    expect(sources(await current.read())).toEqual(sources(before));
    expect((await current.read()).revision).toBe(before.revision);
  });

  it('matches whole words without a regular expression', async () => {
    const doc = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\na cat and a category\n', { format: 'srt', displayName: 'cat.srt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
    const current = await fixture(doc);
    const replaced = await current.edit({ kind: 'replace', query: 'cat', replacement: 'dog', matchCase: true, wholeWord: true, field: 'source' });
    expect(replaced.snapshot.document.cues[0].source.plain).toBe('a dog and a category');
  });

  it('stops a pattern that backtracks badly and reports it, without blocking or editing', async () => {
    const doc = importSubtitleText(Array.from({ length: 200 }, (_, index) => `${index + 1}\n${time(index * 1000)} --> ${time(index * 1000 + 500)}\n${'a'.repeat(40)}!\n`).join('\n'),
      { format: 'srt', displayName: 'slow.srt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
    const current = await fixture(doc);
    const before = await current.read();
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 50);
    await expect(searchCuesInDocument(before, { query: '(a+)+$', field: 'source', matchCase: true, regex: true }, 500)).rejects.toMatchObject({ code: 'pattern_too_slow' });
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(3000);
    // The main thread kept running while the worker searched.
    expect(ticks).toBeGreaterThan(3);
    expect((await current.read()).revision).toBe(before.revision);
  });

  it('counts regular expression matches in the worker like the search in process', async () => {
    const doc = srt();
    const viaWorker = await searchCuesInDocument(doc, { query: '法尔童', field: 'source', matchCase: true, regex: true });
    expect(viaWorker).toEqual(searchDocument(doc, { query: '法尔童', field: 'source', matchCase: true }));
    await expect(searchCuesInDocument(doc, { query: '(', field: 'source', matchCase: true, regex: true })).rejects.toMatchObject({ code: 'invalid_pattern' });
  });
});
