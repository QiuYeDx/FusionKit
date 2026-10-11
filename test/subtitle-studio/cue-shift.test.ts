import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import type { CueEditOperation } from '../../src/subtitle-studio/cue-edit-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { shiftProblem, shiftStart } from '../../src/subtitle-studio/cue-shift';
import { applyCueEdit, CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const time = (ms: number) => new Date(ms).toISOString().slice(11, 23);
/** 250 cues, two seconds apart, each one second long; the last one has no end in LRC. */
const vtt = (count = 250) => importSubtitleText(`WEBVTT\n\n${Array.from({ length: count }, (_, index) =>
  `${time(1000 + index * 2000)} --> ${time(2000 + index * 2000)}\nLine ${index + 1}\n`).join('\n')}`,
{ format: 'vtt', displayName: 'shift.vtt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
const lrc = () => importSubtitleText('[00:01.00]First\n[00:03.00]Second\n[00:05.00]Third\n', { format: 'lrc', displayName: 'shift.lrc', encoding: 'utf-8', digest: 'e'.repeat(64) }, randomUUID);
const exportOptions = (changes: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'vtt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, ...changes });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(doc: SubtitleDocument) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cue-shift-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const edits = new CueEditService(repository);
  const read = () => repository.readSnapshot(doc.id);
  const edit = async (operation: CueEditOperation) => edits.apply(doc.id, (await read()).document.revision, operation);
  return { doc, read, edit };
}
const timings = (doc: SubtitleDocument) => doc.cues.map(cue => [cue.timing.startMs, cue.timing.endMs]);
const preview = (doc: SubtitleDocument, deltaMs: number, fromCueId?: string) => {
  const from = shiftStart(doc.cues, fromCueId);
  const problem = shiftProblem(doc.cues, from, deltaMs, doc.schemaVersion === 2 ? doc.origin.durationMs : undefined);
  return { count: doc.cues.length - from, ...(problem ? { problem } : {}) };
};

describe('shifting a whole document', () => {
  it('moves every cue, beyond the first page, and undoes exactly', async () => {
    const current = await fixture(vtt());
    const before = (await current.read()).document;
    const shifted = await current.edit({ kind: 'shift', deltaMs: 1500 });
    const doc = shifted.snapshot.document;
    expect(shifted.changed).toBe(250);
    expect(shifted.undo).toEqual({ kind: 'shift', deltaMs: -1500 });
    expect(timings(doc)).toEqual(timings(before).map(([start, end]) => [start! + 1500, end === null ? null : end + 1500]));
    expect(doc.cues.every((cue, index) => cue.timingRevision === before.cues[index].timingRevision + 1)).toBe(true);
    // Retimed cues of a preserved format are written with their new times.
    expect(planSubtitleExport(doc, exportOptions()).bytes?.toString()).toContain('00:08:20.500 --> 00:08:21.500\nLine 250');
    const undone = await current.edit(shifted.undo);
    expect(timings(undone.snapshot.document)).toEqual(timings(before));
  });

  it('keeps unknown ends unknown', async () => {
    const current = await fixture(lrc());
    const before = (await current.read()).document;
    const doc = (await current.edit({ kind: 'shift', deltaMs: -500 })).snapshot.document;
    expect(timings(doc)).toEqual(timings(before).map(([start, end]) => [start! - 500, end === null ? null : end - 500]));
    expect(doc.cues.at(-1)?.timing.endMs).toBeNull();
  });

  it('moves the cues from one cue to the end only', async () => {
    const current = await fixture(vtt());
    const before = (await current.read()).document;
    const from = before.cues[119];
    expect(preview(before, -800, from.id)).toEqual({ count: 131 });
    const shifted = await current.edit({ kind: 'shift', deltaMs: -800, fromCueId: from.id });
    expect(shifted.changed).toBe(131);
    expect(shifted.undo).toEqual({ kind: 'shift', deltaMs: 800, fromCueId: from.id });
    const after = timings(shifted.snapshot.document);
    expect(after.slice(0, 119)).toEqual(timings(before).slice(0, 119));
    expect(after[119]).toEqual([before.cues[119].timing.startMs - 800, before.cues[119].timing.endMs! - 800]);
  });

  it('refuses a shift that would go below zero, before the previous cue or past the media, and changes nothing', async () => {
    const current = await fixture(vtt());
    const before = (await current.read()).document;
    expect(preview(before, -1001)).toEqual({ count: 250, problem: 'negative' });
    await expect(current.edit({ kind: 'shift', deltaMs: -1001 })).rejects.toThrow('invalid_input');
    // Cue 120 starts 2 s after cue 119.
    expect(preview(before, -2001, before.cues[119].id)).toEqual({ count: 131, problem: 'before_previous' });
    await expect(current.edit({ kind: 'shift', deltaMs: -2001, fromCueId: before.cues[119].id })).rejects.toThrow('invalid_input');
    await expect(current.edit({ kind: 'shift', deltaMs: 1000, fromCueId: randomUUID() })).rejects.toThrow('invalid_input');
    const unchanged = (await current.read()).document;
    expect(unchanged.revision).toBe(before.revision);
    expect(timings(unchanged)).toEqual(timings(before));

    const transcript = await fixture(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'talk.wav', durationMs: 9000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en', languageProbability: 0.9,
      segments: [1, 2, 3].map(index => ({ id: `segment-${index}`, startMs: index * 2000, endMs: index * 2000 + 1000, text: `Segment ${index}` })) }, { newId: randomUUID }));
    const talk = (await transcript.read()).document;
    expect(preview(talk, 2000)).toEqual({ count: 3 });
    expect(preview(talk, 2001)).toEqual({ count: 3, problem: 'beyond_media' });
    await expect(transcript.edit({ kind: 'shift', deltaMs: 2001 })).rejects.toThrow('invalid_input');
    expect((await transcript.edit({ kind: 'shift', deltaMs: 2000 })).snapshot.document.cues.at(-1)?.timing).toMatchObject({ startMs: 8000, endMs: 9000 });
  });

  it('joins other edits in a batch and refuses while a translation runs', async () => {
    const current = await fixture(vtt(3));
    const before = (await current.read()).document;
    const result = await current.edit({ kind: 'batch', operations: [{ kind: 'shift', deltaMs: 500 }, { kind: 'source', cueId: before.cues[0].id, text: { plain: 'Changed', spans: [{ text: 'Changed', marks: [] }] } }] });
    expect(result.undo).toMatchObject({ kind: 'batch', operations: [{ kind: 'source' }, { kind: 'shift', deltaMs: -500 }] });
    const snapshot = structuredClone(await current.read());
    (snapshot.tasks as unknown[]).push({ status: 'running' });
    expect(() => applyCueEdit(snapshot, { kind: 'shift', deltaMs: 500 })).toThrow('resource_busy');
  });
});
