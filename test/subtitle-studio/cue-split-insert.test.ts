import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { SubtitleDocument, SubtitleText } from '../../src/subtitle-studio/domain';
import type { CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { applyCueEdit, CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const plain = (text: string): SubtitleText => ({ plain: text, spans: [{ text, marks: [] }] });
const metadata = (format: 'srt' | 'vtt' | 'lrc') => ({ format, displayName: `split.${format}`, encoding: 'utf-8' as const, digest: 'f'.repeat(64) });
const srt = () => importSubtitleText('1\n00:00:01,000 --> 00:00:04,000\n甲。乙。\n\n2\n00:00:05,000 --> 00:00:06,000\n丙。\n\n3\n00:00:08,000 --> 00:00:09,000\n丁。\n', metadata('srt'), randomUUID);
const vtt = () => importSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<i>First half second half</i>\n\n00:00:05.000 --> 00:00:06.000\nNext line\n', metadata('vtt'), randomUUID);
const lrc = () => importSubtitleText('[00:01.00]First line\n[00:03.00]Second line\n', metadata('lrc'), randomUUID);
const talk = () => transcriptToDocument({ schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 10000 },
  model: { engine: 'whisper_cpp', modelId: 'm', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
  segments: [{ id: 's0', startMs: 1000, endMs: 4000, text: 'Hello there world' }, { id: 's1', startMs: 5000, endMs: 6000, text: 'Again' }] }, { newId: randomUUID });
const exportOptions = (format: ExportOptions['format']): ExportOptions => ({ mode: 'source', format, order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(doc: SubtitleDocument) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-split-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const edits = new CueEditService(repository);
  const read = async () => (await repository.readSnapshot(doc.id)).document;
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).revision, operation);
  return { doc, read, edit };
}
const lines = (doc: SubtitleDocument) => doc.cues.map(cue => [cue.source.plain, cue.timing.startMs, cue.timing.endMs]);

describe('splitting a cue', () => {
  it('splits an SRT cue at a time, exports both, undoes to one and redoes the same two', async () => {
    const current = await fixture(srt());
    const before = await current.read();
    const first = before.cues[0];
    const split = await current.edit({ kind: 'split', cueId: first.id, sources: [plain('甲。'), plain('乙。')], splitMs: 2500 });
    const doc = split.snapshot.document;
    expect(lines(doc).slice(0, 2)).toEqual([['甲。', 1000, 2500], ['乙。', 2500, 4000]]);
    expect(doc.cues[0].id).toBe(first.id);
    const added = doc.cues[1].id;
    expect(planSubtitleExport(doc, exportOptions('srt')).bytes?.toString()).toContain('00:00:01,000 --> 00:00:02,500\n甲。\n\n2\n00:00:02,500 --> 00:00:04,000\n乙。');
    const undone = await current.edit(split.undo);
    expect(lines(undone.snapshot.document)).toEqual(lines(before));
    const redone = await current.edit(undone.undo);
    expect(redone.snapshot.document.cues[1].id).toBe(added);
    expect(lines(redone.snapshot.document)).toEqual(lines(doc));
  });

  it('splits a preserved VTT cue, which is then written anew', async () => {
    const current = await fixture(vtt());
    const doc = (await current.edit({ kind: 'split', cueId: (await current.read()).cues[0].id,
      sources: [{ plain: 'First half', spans: [{ text: 'First half', marks: ['i'] }] }, { plain: 'second half', spans: [{ text: 'second half', marks: ['i'] }] }], splitMs: 2000 })).snapshot.document;
    if (doc.schemaVersion !== 1) throw new Error('text document expected');
    expect(doc.preservation.nodes.find(node => node.cueIds.length === 2)).toBeDefined();
    const exported = planSubtitleExport(doc, exportOptions('vtt'));
    expect(exported.issues.filter(issue => issue.blocking)).toEqual([]);
    expect(exported.bytes?.toString()).toContain('00:00:01.000 --> 00:00:02.000\n<i>First half</i>\n\n00:00:02.000 --> 00:00:04.000\n<i>second half</i>');
  });

  it('splits a transcript cue, so that two cues share its segment', async () => {
    const current = await fixture(talk());
    const split = await current.edit({ kind: 'split', cueId: (await current.read()).cues[0].id, sources: [plain('Hello'), plain('there world')], splitMs: 1600 });
    const doc = split.snapshot.document;
    expect(lines(doc)).toEqual([['Hello', 1000, 1600], ['there world', 1600, 4000], ['Again', 5000, 6000]]);
    expect(doc.cues.map(cue => 'segmentId' in cue && cue.segmentId)).toEqual(['s0', 's0', 's1']);
    expect(planSubtitleExport(doc, exportOptions('srt')).bytes?.toString()).toContain('2\n00:00:01,600 --> 00:00:04,000\nthere world');
    expect(lines((await current.edit(split.undo)).snapshot.document)).toEqual([['Hello there world', 1000, 4000], ['Again', 5000, 6000]]);
  });

  it('refuses a split outside the cue or with an empty half, and changes nothing', async () => {
    const current = await fixture(srt());
    const before = await current.read();
    const cueId = before.cues[0].id;
    for (const splitMs of [1000, 4000, 500]) await expect(current.edit({ kind: 'split', cueId, sources: [plain('甲。'), plain('乙。')], splitMs })).rejects.toThrow('invalid_input');
    await expect(current.edit({ kind: 'split', cueId, sources: [plain('甲。乙。'), plain('')], splitMs: 2500 })).rejects.toThrow('invalid_input');
    const after = await current.read();
    expect(after.revision).toBe(before.revision);
    expect(lines(after)).toEqual(lines(before));
  });

  it('keeps the translation on the first half, or splits it too', async () => {
    const doc = srt();
    const trackId = randomUUID(), cue = doc.cues[0];
    const entry = { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), text: plain('A. B.'), origin: 'ai' as const, reviewStatus: 'unreviewed' as const };
    doc.translationTracks.push({ id: trackId, language: 'en', revision: 1, entries: { [cue.id]: entry } });
    const current = await fixture(doc);
    const kept = await current.edit({ kind: 'split', cueId: cue.id, sources: [plain('甲。'), plain('乙。')], splitMs: 2500 });
    const track = kept.snapshot.document.translationTracks[0];
    const [first, second] = kept.snapshot.document.cues;
    // The first keeps its translation, which was made for the whole text.
    expect(track.entries[first.id]?.text.plain).toBe('A. B.');
    expect(track.entries[first.id]!.sourceRevision).toBeLessThan(first.sourceRevision);
    expect(track.entries[second.id]).toBeUndefined();
    const undone = await current.edit(kept.undo);
    expect(undone.snapshot.document.translationTracks[0].entries[cue.id]).toMatchObject({ text: plain('A. B.'), origin: 'ai' });
    const both = await current.edit({ kind: 'split', cueId: cue.id, sources: [plain('甲。'), plain('乙。')], splitMs: 2500, trackId, targets: [plain('A.'), plain('B.')] });
    const entries = both.snapshot.document.translationTracks[0].entries;
    const [one, two] = both.snapshot.document.cues;
    expect([entries[one.id], entries[two.id]]).toMatchObject([{ text: plain('A.'), origin: 'human', reviewStatus: 'reviewed', sourceRevision: one.sourceRevision },
      { text: plain('B.'), origin: 'human', reviewStatus: 'reviewed', sourceRevision: two.sourceRevision }]);
    const back = (await current.edit(both.undo)).snapshot.document;
    expect(back.cues).toHaveLength(3);
    expect(back.translationTracks[0].entries[cue.id]).toMatchObject({ text: plain('A. B.'), origin: 'ai', reviewStatus: 'unreviewed' });
  });
});

describe('inserting a cue', () => {
  it('inserts after a cue, exports it, undoes and redoes the same cue', async () => {
    const current = await fixture(srt());
    const before = await current.read();
    const inserted = await current.edit({ kind: 'insert', cueId: before.cues[1].id, position: 'after', timing: { startMs: 6000, endMs: 7500 }, source: plain('补上的一句') });
    const doc = inserted.snapshot.document;
    expect(lines(doc)[2]).toEqual(['补上的一句', 6000, 7500]);
    expect(planSubtitleExport(doc, exportOptions('srt')).bytes?.toString()).toContain('3\n00:00:06,000 --> 00:00:07,500\n补上的一句');
    const id = doc.cues[2].id;
    const undone = await current.edit(inserted.undo);
    expect(lines(undone.snapshot.document)).toEqual(lines(before));
    expect((await current.edit(undone.undo)).snapshot.document.cues[2].id).toBe(id);
  });

  it('inserts before a cue, with an unknown end where the format allows one, and in transcripts within the media', async () => {
    const lyrics = await fixture(lrc());
    const first = (await lyrics.read()).cues[0];
    const doc = (await lyrics.edit({ kind: 'insert', cueId: first.id, position: 'before', timing: { startMs: 0, endMs: null }, source: plain('Intro') })).snapshot.document;
    expect(lines(doc)[0]).toEqual(['Intro', 0, null]);
    const spoken = await fixture(talk());
    const talkDoc = await spoken.read();
    const inserted = (await spoken.edit({ kind: 'insert', cueId: talkDoc.cues[0].id, position: 'after', timing: { startMs: 4200, endMs: 4800 }, source: plain('Um') })).snapshot.document;
    expect(inserted.cues.map(cue => 'segmentId' in cue && cue.segmentId)).toEqual(['s0', 's0', 's1']);
    await expect(spoken.edit({ kind: 'insert', cueId: talkDoc.cues[1].id, position: 'after', timing: { startMs: 7000, endMs: 10001 }, source: plain('Late') })).rejects.toThrow('invalid_input');
    await expect(spoken.edit({ kind: 'insert', cueId: talkDoc.cues[1].id, position: 'after', timing: { startMs: 7000, endMs: null }, source: plain('Late') })).rejects.toThrow('invalid_input');
  });

  it('refuses a cue out of order, ending before it starts or without text, and changes nothing', async () => {
    const current = await fixture(srt());
    const before = await current.read();
    const second = before.cues[1].id;
    for (const timing of [{ startMs: 4000, endMs: 4500 }, { startMs: 8500, endMs: 9000 }, { startMs: 6500, endMs: 6000 }]) {
      await expect(current.edit({ kind: 'insert', cueId: second, position: 'after', timing, source: plain('x') })).rejects.toThrow('invalid_input');
    }
    await expect(current.edit({ kind: 'insert', cueId: second, position: 'after', timing: { startMs: 6000, endMs: 7000 }, source: plain(' ') })).rejects.toThrow('invalid_input');
    expect((await current.read()).revision).toBe(before.revision);
  });

  it('writes a human translation with it, and refuses while a translation runs', async () => {
    const doc = srt();
    const trackId = randomUUID();
    doc.translationTracks.push({ id: trackId, language: 'en', revision: 1, entries: {} });
    const current = await fixture(doc);
    const inserted = (await current.edit({ kind: 'insert', cueId: doc.cues[0].id, position: 'after', timing: { startMs: 4000, endMs: 4500 }, source: plain('新'), trackId, target: plain('New') })).snapshot.document;
    expect(inserted.translationTracks[0].entries[inserted.cues[1].id]).toMatchObject({ text: plain('New'), origin: 'human', reviewStatus: 'reviewed' });
    const document = await current.read();
    const busy = { schemaVersion: 1, document, tasks: [{ status: 'running' }] } as unknown as Parameters<typeof applyCueEdit>[0];
    expect(() => applyCueEdit(busy, { kind: 'insert', cueId: document.cues[0].id, position: 'after', timing: { startMs: 4000, endMs: 4100 }, source: plain('x') })).toThrow('resource_busy');
  });
});
