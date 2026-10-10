import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDocument, type SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { interpretBilingualImport } from '../../src/subtitle-studio/bilingual';
import type { CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import { mergeOperation } from '../../src/subtitle-studio/cue-structure';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import type { LocalSubtitleTranscript } from '../../src/subtitle-studio/transcription/domain';
import { CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const metadata = (format: 'lrc' | 'vtt' | 'srt') => ({ format, displayName: `structure.${format}`, encoding: 'utf-8' as const, digest: 'f'.repeat(64) });
const exportOptions = (changes: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'next-start', finalDurationMs: 2000 }, ...changes });
const text = (doc: SubtitleDocument, options: Partial<ExportOptions> = {}) => planSubtitleExport(doc, exportOptions(options)).bytes?.toString();
/** The user's reported passage, as a bilingual LRC. */
const reported = () => interpretBilingualImport(importSubtitleText([
  '[00:22.770]私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '[00:22.770]我认识的人里，同族的居民白鸽和麻雀当中，',
  '[00:26.780]先輩みたいに朝から眠そうにしてる方、', '[00:26.780]像前辈这样一大早就犯困的，',
  '[00:27.500]先輩みたいに朝から眠そうにしてる方', '[00:27.500]像前辈这样一大早就犯困的',
  '[00:29.860]いますもん', '[00:29.860]也是有的。',
].join('\n') + '\n', metadata('lrc'), randomUUID), randomUUID, sourceDigest);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(doc: SubtitleDocument) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-structure-')); roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const edits = new CueEditService(repository);
  const read = async () => (await repository.readSnapshot(doc.id)).document;
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).revision, operation);
  return { doc, read, edit };
}
const sources = (doc: SubtitleDocument) => doc.cues.map(cue => cue.source.plain);
const targets = (doc: SubtitleDocument) => doc.cues.map(cue => doc.translationTracks[0]?.entries[cue.id]?.text.plain ?? null);

describe('merging cues', () => {
  it('merges the reported repetition into one cue, translation included, and undoes it exactly', async () => {
    const current = await fixture(reported());
    expect(current.doc.cues).toHaveLength(4);
    const [, first, second] = current.doc.cues;
    const track = current.doc.translationTracks[0];
    const merged = await current.edit(mergeOperation([first, second], track));
    const doc = merged.snapshot.document;
    expect(merged.changed).toBe(2);
    expect(sources(doc)).toEqual(['私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '先輩みたいに朝から眠そうにしてる方、', 'いますもん']);
    expect(targets(doc)).toEqual(['我认识的人里，同族的居民白鸽和麻雀当中，', '像前辈这样一大早就犯困的，', '也是有的。']);
    expect(doc.cues[1]).toMatchObject({ id: first.id, timing: { startMs: 26780, endMs: null } });
    expect(doc.translationTracks[0].entries[first.id]).toMatchObject({ origin: 'human', reviewStatus: 'reviewed', sourceRevision: doc.cues[1].sourceRevision });
    // Exported once, at the first start, in both languages.
    expect(text(doc, { mode: 'bilingual', format: 'lrc', trackId: track.id })).toBe(['[00:22.770]私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '[00:22.770]我认识的人里，同族的居民白鸽和麻雀当中，',
      '[00:26.780]先輩みたいに朝から眠そうにしてる方、', '[00:26.780]像前辈这样一大早就犯困的，', '[00:29.860]いますもん', '[00:29.860]也是有的。'].join('\n') + '\n');
    const undone = (await current.edit(merged.undo)).snapshot.document;
    expect(undone.cues).toEqual(current.doc.cues.map(cue => expect.objectContaining({ id: cue.id, timing: cue.timing, source: cue.source })));
    expect(undone.translationTracks[0].entries).toEqual(current.doc.translationTracks[0].entries);
    expect(undone.preservation).toEqual(current.doc.preservation);
    expect(undone.bilingualImport).toEqual(current.doc.bilingualImport);
  });

  it('takes the last end, refuses non-consecutive cues and works on transcripts', async () => {
    const srt = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,500 --> 00:00:04,000\nworld\n\n3\n00:00:05,000 --> 00:00:06,000\nAgain\n', metadata('srt'), randomUUID);
    const current = await fixture(srt);
    const [a, b, c] = current.doc.cues;
    await expect(current.edit({ ...mergeOperation([a, c]), cueIds: [a.id, c.id] })).rejects.toThrow('invalid_input');
    const merged = (await current.edit(mergeOperation([a, b]))).snapshot.document;
    expect(merged.cues[0]).toMatchObject({ source: { plain: 'Hello world' }, timing: { startMs: 1000, endMs: 4000 } });
    expect(text(merged)).toBe('1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,000 --> 00:00:06,000\nAgain\n\n');

    const transcript: LocalSubtitleTranscript = {
      schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 9000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' },
      detectedLanguage: 'ja', languageProbability: 0.9,
      segments: [['先輩みたいに', 1000, 2000], ['先輩みたいに', 2000, 2600], ['いますもん', 3000, 3500]].map(([value, start, end], index) => ({ id: `segment-${index}`, startMs: start as number, endMs: end as number, text: value as string })),
    };
    const media = await fixture(transcriptToDocument(transcript));
    const [one, two] = media.doc.cues;
    const done = await media.edit(mergeOperation([one, two]));
    expect(done.snapshot.document.cues.map(cue => [cue.source.plain, cue.timing.startMs, cue.timing.endMs])).toEqual([['先輩みたいに', 1000, 2600], ['いますもん', 3000, 3500]]);
    expect(() => validateDocument(done.snapshot.document)).not.toThrow();
    expect((await media.edit(done.undo)).snapshot.document.cues).toEqual(media.doc.cues.map(cue => expect.objectContaining({ id: cue.id, timing: cue.timing })));
  });
});

describe('editing times', () => {
  it('changes times with an exact undo and keeps the cues in order', async () => {
    const srt = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n\n3\n00:00:05,000 --> 00:00:06,000\nThree\n', metadata('srt'), randomUUID);
    const current = await fixture(srt);
    const [one, two, three] = current.doc.cues;
    const edited = await current.edit({ kind: 'timing', changes: { [one.id]: { startMs: 1000, endMs: 5000 } } });
    expect(edited.snapshot.document.cues[0]).toMatchObject({ timing: { startMs: 1000, endMs: 5000 }, timingRevision: 2 });
    expect(text(edited.snapshot.document)).toContain('00:00:01,000 --> 00:00:05,000\nOne');
    expect((await current.edit(edited.undo)).snapshot.document.cues[0].timing).toEqual(one.timing);
    // End before start; a start past the next cue's start.
    await expect(current.edit({ kind: 'timing', changes: { [two.id]: { startMs: 3000, endMs: 2000 } } })).rejects.toThrow('invalid_input');
    await expect(current.edit({ kind: 'timing', changes: { [two.id]: { startMs: 5500, endMs: 5800 } } })).rejects.toThrow('invalid_input');
    // Shifting together moves past positions the group itself held.
    const shifted = await current.edit({ kind: 'timing', changes: { [two.id]: { startMs: 3500, endMs: 4500 }, [three.id]: { startMs: 5500, endMs: 6500 } } });
    expect(shifted.snapshot.document.cues.map(cue => cue.timing.startMs)).toEqual([1000, 3500, 5500]);
  });

  it('allows an unknown end only where the format has none, and keeps transcripts within the media', async () => {
    const lrc = importSubtitleText('[00:01.00]One\n[00:03.00]Two\n', metadata('lrc'), randomUUID);
    const current = await fixture(lrc);
    const [first] = current.doc.cues;
    const ended = await current.edit({ kind: 'timing', changes: { [first.id]: { startMs: 1000, endMs: 2500 } } });
    expect(ended.snapshot.document.cues[0].timing).toMatchObject({ startMs: 1000, endMs: 2500 });
    await current.edit({ kind: 'timing', changes: { [first.id]: { startMs: 1000, endMs: null } } });
    const transcript: LocalSubtitleTranscript = {
      schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 9000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en', languageProbability: 0.9,
      segments: [{ id: 's1', startMs: 1000, endMs: 2000, text: 'One' }],
    };
    const media = await fixture(transcriptToDocument(transcript));
    const [cue] = media.doc.cues;
    await expect(media.edit({ kind: 'timing', changes: { [cue.id]: { startMs: 1000, endMs: null } } })).rejects.toThrow('invalid_input');
    await expect(media.edit({ kind: 'timing', changes: { [cue.id]: { startMs: 1000, endMs: 9500 } } })).rejects.toThrow('invalid_input');
    expect((await media.edit({ kind: 'timing', changes: { [cue.id]: { startMs: 1200, endMs: 2400 } } })).snapshot.document.cues[0].timing).toMatchObject({ startMs: 1200, endMs: 2400 });
  });

  it('writes a retimed VTT anew instead of patching the original', async () => {
    const vtt = importSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>First line</i>\n\n00:00:03.000 --> 00:00:04.000\nSecond line\n', metadata('vtt'), randomUUID);
    const current = await fixture(vtt);
    const [first] = current.doc.cues;
    const edited = (await current.edit({ kind: 'timing', changes: { [first.id]: { startMs: 1000, endMs: 2500 } } })).snapshot.document;
    const plan = planSubtitleExport(edited, exportOptions({ format: 'vtt' }));
    expect(plan.issues.filter(issue => issue.blocking)).toEqual([]);
    expect(plan.bytes?.toString()).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>First line</i>\n\n00:00:03.000 --> 00:00:04.000\nSecond line\n\n');
  });
});

describe('several edits as one', () => {
  it('applies a batch in order and undoes it backwards', async () => {
    const srt = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:02,000 --> 00:00:03,000\nOne\n\n3\n00:00:04,000 --> 00:00:05,000\nNoise\n\n4\n00:00:06,000 --> 00:00:07,000\nFour\n', metadata('srt'), randomUUID);
    const current = await fixture(srt);
    const [one, again, noise, four] = current.doc.cues;
    const plainText = (value: string) => ({ plain: value, spans: [{ text: value, marks: [] as ('b' | 'i' | 'u')[] }] });
    const batch = await current.edit({ kind: 'batch', operations: [
      { kind: 'revise', sources: { [four.id]: plainText('Four, fixed') } },
      mergeOperation([one, again]),
      { kind: 'delete', cueIds: [noise.id] },
    ] });
    expect(sources(batch.snapshot.document)).toEqual(['One', 'Four, fixed']);
    expect(batch.changed).toBe(4);
    expect(batch.undo.kind).toBe('batch');
    const undone = (await current.edit(batch.undo)).snapshot.document;
    expect(undone.cues).toEqual(current.doc.cues.map(cue => expect.objectContaining({ id: cue.id, timing: cue.timing, source: cue.source })));
    expect(undone.preservation).toEqual(current.doc.preservation);
  });
});
