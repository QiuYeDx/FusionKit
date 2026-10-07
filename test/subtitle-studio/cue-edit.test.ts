import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDocument, type SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { applyBilingual, hasBilingualCandidates } from '../../src/subtitle-studio/bilingual';
import { cueTextProblem, editedText, hasMixedStyle, normalizeCueText, type CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { LocalSubtitleTranscript } from '../../src/subtitle-studio/transcription/domain';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { planTranslation, sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const metadata = (format: 'lrc' | 'vtt' | 'srt') => ({ format, displayName: `edit-fixture.${format}`, encoding: 'utf-8' as const, digest: 'f'.repeat(64) });
const lrc = () => importSubtitleText('[00:01.00]First line\n[00:03.00]Second line\n[00:05.00]Third line\n[00:07.00]Fourth line\n', metadata('lrc'), randomUUID);
const vtt = () => importSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>First line</i>\n\n00:00:03.000 --> 00:00:04.000\nSecond <b>bold</b> line\n\n00:00:05.000 --> 00:00:06.000\nThird line\n', metadata('vtt'), randomUUID);
const config = (overrides: Partial<TranslationConfig> = {}): TranslationConfig => ({
  model: { profileId: 'edit-fixture', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
  language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1, ...overrides,
});
const exportOptions = (changes: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, ...changes });
const plain = (text: string) => ({ plain: text, spans: [{ text, marks: [] as ('b' | 'i' | 'u')[] }] });
type Payload = { context: { precedingSource: string[]; followingSource: string[] }; items: { id: string; text: string }[] };
const payload = (request: ModelRuntimeTextRequest): Payload => JSON.parse(request.messages[1].content);
let translationRun = 0;
const translate = async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => {
  const run = ++translationRun;
  return { apiFormat: 'chat_completions', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    content: JSON.stringify({ items: payload(request).items.map(item => ({ id: item.id, text: `T${run}:${item.text}` })) }) };
};

const roots: string[] = [];
const services: TranslationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(doc: SubtitleDocument = lrc(), send = translate) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-edit-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const translation = new TranslationService(repository, send);
  services.push(translation);
  const edits = new CueEditService(repository);
  const read = () => repository.readSnapshot(doc.id);
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).document.revision, operation);
  const translateAll = async (scope?: { cueIds: string[]; trackId?: string }, overrides: Partial<TranslationConfig> = {}) => {
    const revision = (await read()).document.revision;
    const plan = await translation.plan(7, doc.id, revision, config(overrides), () => {}, scope);
    const { taskId } = await translation.start(7, doc.id, revision, plan.planId, 'fixture-key');
    await translation.settled(taskId);
    return { plan, taskId, snapshot: await read() };
  };
  return { doc, repository, translation, edits, read, edit, translateAll };
}
const entryTexts = (snapshot: DocumentSnapshot, trackIndex = 0) => snapshot.document.cues.map(cue => snapshot.document.translationTracks[trackIndex]?.entries[cue.id]?.text.plain ?? null);

describe('cue text rules', () => {
  it('normalizes editor text and reports problems the protocol cannot carry', () => {
    expect(normalizeCueText('  first  \r\n\r\n second line \n\n')).toBe('first\n second line');
    expect(cueTextProblem(' \n ')).toBe('empty');
    expect(cueTextProblem('a <b> tag')).toBe('markup');
    expect(cueTextProblem('bell\u0007')).toBe('characters');
    expect(cueTextProblem('fine')).toBeNull();
  });

  it('keeps styling that covers the whole line and drops mixed styling', () => {
    const italic = { plain: 'Hello', spans: [{ text: 'Hello', marks: ['i' as const] }] };
    expect(editedText(italic, 'Hi')).toEqual({ plain: 'Hi', spans: [{ text: 'Hi', marks: ['i'] }] });
    const mixed = { plain: 'A bold word', spans: [{ text: 'A ', marks: [] }, { text: 'bold', marks: ['b' as const] }, { text: ' word', marks: [] }] };
    expect(hasMixedStyle(mixed)).toBe(true);
    expect(editedText(mixed, 'A word')).toEqual(plain('A word'));
    expect(editedText(mixed, mixed.plain)).toBe(mixed);
  });
});

describe('cue edits', () => {
  it('edits source text, marks translations stale and makes them current again on undo', async () => {
    const current = await fixture();
    const { snapshot } = await current.translateAll();
    const cue = snapshot.document.cues[1];
    const before = snapshot.document.translationTracks[0].entries[cue.id];
    const edited = await current.edit({ kind: 'source', cueId: cue.id, text: plain('Second line, edited') });
    const after = edited.snapshot.document;
    expect(after.cues[1]).toMatchObject({ source: plain('Second line, edited'), sourceRevision: cue.sourceRevision + 1 });
    expect(after.translationTracks[0].entries[cue.id].sourceRevision).not.toBe(after.cues[1].sourceRevision);
    expect(planSubtitleExport(after, exportOptions({ mode: 'target', trackId: after.translationTracks[0].id })).issues).toContainEqual(expect.objectContaining({ code: 'translation_stale', count: 1 }));
    expect(edited.undo).toEqual({ kind: 'source', cueId: cue.id, text: cue.source });

    const undone = await current.edit(edited.undo);
    const restored = undone.snapshot.document;
    expect(restored.cues[1].source).toEqual(cue.source);
    // Revisions only grow; the translation made for this exact text is current again.
    expect(restored.cues[1].sourceRevision).toBe(cue.sourceRevision + 2);
    expect(restored.translationTracks[0].entries[cue.id]).toEqual({ ...before, sourceRevision: restored.cues[1].sourceRevision });
    expect(planSubtitleExport(restored, exportOptions({ mode: 'target', format: 'lrc', trackId: restored.translationTracks[0].id })).issues.map(item => item.code)).not.toContain('translation_stale');
  });

  it('writes human translations, review marks and clears, each with an exact undo', async () => {
    const current = await fixture();
    const { snapshot } = await current.translateAll();
    const track = snapshot.document.translationTracks[0];
    const [first, second] = snapshot.document.cues;
    const ai = structuredClone(track.entries[first.id]);

    const written = await current.edit({ kind: 'target', trackId: track.id, cueId: first.id, text: plain('人工译文') });
    expect(written.snapshot.document.translationTracks[0].entries[first.id]).toEqual({ sourceRevision: first.sourceRevision, sourceHash: sourceDigest(first), text: plain('人工译文'), origin: 'human', reviewStatus: 'reviewed' });
    expect(written.snapshot.document.translationTracks[0].revision).toBe(track.revision + 1);
    expect((await current.edit(written.undo)).snapshot.document.translationTracks[0].entries[first.id]).toEqual(ai);

    const reviewed = await current.edit({ kind: 'review', trackId: track.id, cueIds: [first.id, second.id], reviewed: true });
    expect(reviewed.changed).toBe(2);
    const reviewedTrack = reviewed.snapshot.document.translationTracks[0];
    expect([reviewedTrack.entries[first.id].reviewStatus, reviewedTrack.entries[second.id].reviewStatus]).toEqual(['reviewed', 'reviewed']);
    // Review marks are not content.
    expect(reviewedTrack.revision).toBe(track.revision + 2);
    await current.edit(reviewed.undo);

    const cleared = await current.edit({ kind: 'clear', trackId: track.id, cueIds: [first.id, second.id] });
    expect(entryTexts(cleared.snapshot).slice(0, 2)).toEqual([null, null]);
    const back = await current.edit(cleared.undo);
    expect(back.snapshot.document.translationTracks[0].entries).toEqual(snapshot.document.translationTracks[0].entries);
  });

  it('refuses edits while a translation runs and stops paused tasks an edit invalidates', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const current = await fixture(lrc(), async request => {
      calls++;
      if (calls === 2) { await gate; throw Object.assign(new Error('offline'), { code: 'offline' }); }
      return translate(request);
    });
    const revision = (await current.read()).document.revision;
    const plan = await current.translation.plan(7, current.doc.id, revision, config(), () => {});
    const { taskId } = await current.translation.start(7, current.doc.id, revision, plan.planId, 'fixture-key');
    await expect.poll(async () => (await current.read()).tasks[0].translation?.inFlightBatchId).toBe('b2');
    await expect(current.edit({ kind: 'source', cueId: current.doc.cues[3].id, text: plain('Changed') })).rejects.toThrow('resource_busy');
    release();
    await current.translation.settled(taskId);
    expect((await current.read()).tasks[0].status).toBe('failed');

    const reviewed = await current.edit({ kind: 'review', trackId: (await current.read()).document.translationTracks[0].id, cueIds: [current.doc.cues[0].id], reviewed: true });
    expect(reviewed.stoppedTasks).toBe(0);
    const edited = await current.edit({ kind: 'source', cueId: current.doc.cues[3].id, text: plain('Changed') });
    expect(edited.stoppedTasks).toBe(1);
    expect(edited.snapshot.tasks[0]).toMatchObject({ status: 'cancelled', completedBatchIds: ['b1'] });
  });

  it('deletes cues from preserved exports and restores them exactly', async () => {
    const current = await fixture(vtt());
    const { snapshot } = await current.translateAll();
    const original = snapshot.document;
    const deleted = await current.edit({ kind: 'delete', cueIds: [original.cues[1].id] });
    const doc = deleted.snapshot.document;
    expect(doc.cues.map(cue => cue.source.plain)).toEqual(['First line', 'Third line']);
    expect(doc.schemaVersion === 1 && doc.preservation.removedNodeIds).toEqual([original.cues[1].nodeId]);
    const exported = planSubtitleExport(doc, exportOptions({ format: 'vtt' }));
    expect(exported.issues).toEqual([]);
    expect(exported.bytes?.toString()).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>First line</i>\n\n00:00:05.000 --> 00:00:06.000\nThird line\n');
    expect(planSubtitleExport(doc, exportOptions({ format: 'srt' })).bytes?.toString()).toBe('1\n00:00:01,000 --> 00:00:02,000\n<i>First line</i>\n\n2\n00:00:05,000 --> 00:00:06,000\nThird line\n\n');
    expect(entryTexts(deleted.snapshot)).toEqual([expect.stringMatching(/^T\d+:First line$/), expect.stringMatching(/^T\d+:Third line$/)]);

    const restored = await current.edit(deleted.undo);
    const back = restored.snapshot.document;
    expect(back.cues).toEqual(original.cues);
    expect(back.schemaVersion === 1 && back.preservation).toEqual(original.schemaVersion === 1 && original.preservation);
    expect(back.translationTracks[0].entries).toEqual(original.translationTracks[0].entries);
    expect(planSubtitleExport(back, exportOptions({ format: 'vtt' })).bytes?.toString()).toBe(planSubtitleExport(original, exportOptions({ format: 'vtt' })).bytes?.toString());
    expect(restored.undo).toEqual({ kind: 'delete', cueIds: [original.cues[1].id] });
  });

  it('keeps at least one cue and blocks bilingual separation after edits', async () => {
    const current = await fixture(importSubtitleText('[00:01.00]こんにちは\n[00:01.00]Hello\n[00:03.00]また明日\n[00:03.00]See you\n', metadata('lrc'), randomUUID));
    expect(hasBilingualCandidates((await current.read()).document)).toBe(true);
    await expect(current.edit({ kind: 'delete', cueIds: current.doc.cues.map(cue => cue.id) })).rejects.toThrow('invalid_input');
    const edited = await current.edit({ kind: 'source', cueId: current.doc.cues[0].id, text: plain('こんにちは！') });
    expect(hasBilingualCandidates(edited.snapshot.document)).toBe(false);
    expect(() => applyBilingual(edited.snapshot.document, { sourceSide: 'first', splitInline: false, overrides: [] }, randomUUID, sourceDigest)).toThrow('invalid_input');
  });

  it('drops the bilingual import when its last separated pair is deleted, and restores it on undo', async () => {
    const separated = applyBilingual(importSubtitleText('[00:01.00]こんにちは\n[00:01.00]Hello\n[00:03.00]Plain line\n', metadata('lrc'), randomUUID),
      { sourceSide: 'first', splitInline: false, overrides: [] }, randomUUID, sourceDigest);
    const current = await fixture(separated);
    const paired = separated.cues.find(cue => cue.importedPair)!;
    const deleted = await current.edit({ kind: 'delete', cueIds: [paired.id] });
    const doc = deleted.snapshot.document;
    expect(doc.bilingualImport).toBeUndefined();
    expect(doc.translationTracks[0].origin).toBeUndefined();
    expect(planSubtitleExport(doc, exportOptions({ format: 'lrc' })).bytes?.toString()).toBe('[00:03.000]Plain line\n');
    const restored = (await current.edit(deleted.undo)).snapshot.document;
    expect(restored.bilingualImport).toEqual(separated.bilingualImport);
    expect(restored.translationTracks[0]).toMatchObject({ origin: 'imported', entries: separated.translationTracks[0].entries });
    expect(restored.cues).toEqual(separated.cues);
  });

  it('edits and deletes transcription cues while keeping their segment mapping', async () => {
    const transcript: LocalSubtitleTranscript = {
      schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 9000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' },
      detectedLanguage: 'en', languageProbability: 0.9,
      segments: [1, 2, 3].map(index => ({ id: `segment-${index}`, startMs: index * 1000, endMs: index * 1000 + 500, text: `Segment ${index}` })),
    };
    const current = await fixture(transcriptToDocument(transcript));
    const [first, second] = current.doc.cues;
    await expect(current.edit({ kind: 'source', cueId: first.id, text: { plain: 'Bold', spans: [{ text: 'Bold', marks: ['b'] }] } })).rejects.toThrow('invalid_input');
    const edited = await current.edit({ kind: 'source', cueId: first.id, text: plain('Segment one, corrected') });
    expect(() => validateDocument(edited.snapshot.document)).not.toThrow();
    const deleted = await current.edit({ kind: 'delete', cueIds: [second.id] });
    expect(deleted.snapshot.document.cues.map(cue => cue.source.plain)).toEqual(['Segment one, corrected', 'Segment 3']);
    expect(planSubtitleExport(deleted.snapshot.document, { ...exportOptions(), incomplete: 'block' }).bytes?.toString()).toBe('1\n00:00:01,000 --> 00:00:01,500\nSegment one, corrected\n\n2\n00:00:03,000 --> 00:00:03,500\nSegment 3\n\n');
    const restored = await current.edit(deleted.undo);
    expect(restored.snapshot.document.cues.map(cue => cue.id)).toEqual(current.doc.cues.map(cue => cue.id));
  });
});

describe('translating a selection', () => {
  it('plans only the selected cues with context from their document neighbours', () => {
    const doc = lrc();
    const plan = planTranslation(doc, config({ maxBatchCues: 10 }), { cueIds: [doc.cues[2].id] });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].units.map(unit => unit.cueId)).toEqual([doc.cues[2].id]);
    expect(plan.batches[0].before).toEqual(['First line', 'Second line']);
    expect(plan.batches[0].after).toEqual(['Fourth line']);
    expect(() => planTranslation(doc, config(), { cueIds: [randomUUID()] })).toThrow('invalid_input');
  });

  it('retranslates selected cues into the current track and leaves the others alone', async () => {
    const current = await fixture();
    const first = await current.translateAll();
    const track = first.snapshot.document.translationTracks[0];
    const human = await current.edit({ kind: 'target', trackId: track.id, cueId: current.doc.cues[0].id, text: plain('人工') });
    const before = entryTexts(human.snapshot);
    const second = await current.translateAll({ cueIds: [current.doc.cues[1].id, current.doc.cues[3].id], trackId: track.id });
    const after = second.snapshot;
    expect(after.document.translationTracks).toHaveLength(1);
    const texts = entryTexts(after);
    expect(texts[0]).toBe('人工');
    expect(texts[2]).toBe(before[2]);
    expect(texts[1]).toMatch(/^T\d+:Second line$/);
    expect(texts[1]).not.toBe(before[1]);
    expect(texts[3]).not.toBe(before[3]);
    const recordOf = (snapshot: DocumentSnapshot, taskId: string) => {
      const checkpoint = snapshot.tasks.find(item => item.id === taskId)!.translation!.checkpoint!;
      return checkpoint.version === 2 ? checkpoint.executionRef.id : undefined;
    };
    expect(after.tasks.find(item => item.id === second.taskId)).toMatchObject({ status: 'completed', trackId: track.id, translation: { checkpoint: { partial: true } } });
    // The track's provenance follows the newest run.
    expect(after.document.translationTracks[0].executionRef?.id).toBe(recordOf(after, second.taskId));

    // A later selection run supersedes the earlier one; the full run keeps its record.
    const third = await current.translateAll({ cueIds: [current.doc.cues[1].id], trackId: track.id });
    expect(third.snapshot.tasks.map(item => item.id)).toEqual([first.taskId, third.taskId]);
    expect(Object.keys(third.snapshot.executionRecords ?? {}).sort()).toEqual([recordOf(third.snapshot, first.taskId), recordOf(third.snapshot, third.taskId)].sort());
    expect(third.snapshot.document.translationTracks[0].executionRef?.id).toBe(recordOf(third.snapshot, third.taskId));
  });

  it('creates a partial track for a selection and refuses another language for an existing track', async () => {
    const current = await fixture();
    const { snapshot } = await current.translateAll({ cueIds: [current.doc.cues[2].id] });
    expect(entryTexts(snapshot)).toEqual([null, null, expect.stringMatching(/Third line$/), null]);
    const revision = snapshot.document.revision;
    await expect(current.translation.plan(7, current.doc.id, revision, config({ language: 'ja' }), () => {}, { cueIds: [current.doc.cues[0].id], trackId: snapshot.document.translationTracks[0].id })).rejects.toThrow('invalid_input');
    // zh and zh-Hans name the same track language.
    await expect(current.translation.plan(7, current.doc.id, revision, config({ language: 'zh-Hans' }), () => {}, { cueIds: [current.doc.cues[0].id], trackId: snapshot.document.translationTracks[0].id })).resolves.toMatchObject({ cueCount: 1 });
  });

  it('resumes an interrupted selection over existing translations', async () => {
    let fail = false;
    const current = await fixture(lrc(), async request => {
      if (fail && payload(request).items[0].text === 'Fourth line') { fail = false; throw new Error('network'); }
      return translate(request);
    });
    const { snapshot } = await current.translateAll();
    const trackId = snapshot.document.translationTracks[0].id;
    fail = true;
    const partial = await current.translateAll({ cueIds: [current.doc.cues[1].id, current.doc.cues[3].id], trackId });
    const failed = partial.snapshot.tasks.find(task => task.id === partial.taskId)!;
    expect(failed.status).toBe('failed');
    expect(failed.completedBatchIds).toEqual(['b1']);
    await current.translation.resume(current.doc.id, partial.snapshot.document.revision, partial.taskId, config().model, 'fixture-key');
    await current.translation.settled(partial.taskId);
    const done = await current.read();
    expect(done.tasks.find(task => task.id === partial.taskId)?.status).toBe('completed');
    expect(entryTexts(done)[3]).not.toBe(entryTexts(snapshot)[3]);
  });
});
