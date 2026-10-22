import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';
import { LIMITS } from '../../src/subtitle-studio/domain';
import { editedText } from '../../src/subtitle-studio/cue-edit-contract';
import { CUE_REVIEW_REASONS, reviewPosition, reviewStep, visibleReview, cueReviewIgnoreKey, type CueReviewResult } from '../../src/subtitle-studio/transcription-review';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  ipcMain: { on: (channel: string, handler: Function) => adapter.listeners.set(channel, handler), handle: (channel: string, handler: Function) => adapter.handlers.set(channel, handler), removeAllListeners: (channel: string) => adapter.listeners.delete(channel), removeHandler: (channel: string) => adapter.handlers.delete(channel) },
}));
import { registerSubtitleStudio } from '../../electron/main/subtitle-studio';

let registration: ReturnType<typeof registerSubtitleStudio> | undefined;
let sequence = 0;
const rendererUrl = pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href;
function attach() {
  const client = Object.assign(new EventEmitter(), { id: ++sequence, mainFrame: { url: rendererUrl }, isDestroyed: () => false, send: vi.fn() });
  registration!.attach(client as never);
  const event = { sender: client, senderFrame: client.mainFrame, returnValue: null as unknown };
  adapter.listeners.get(STUDIO_CHANNELS.register)!(event, {});
  return { client, capability: event.returnValue, invoke: (method: string, payload: unknown) => adapter.handlers.get(method)!({ sender: client, senderFrame: client.mainFrame }, { capability: event.returnValue, payload }) };
}
afterEach(async () => {
  await registration?.dispose(); registration = undefined;
  if (adapter.directory) await rm(adapter.directory, { recursive: true, force: true });
});

/** 250 cues over three pages; the flagged ones sit on every page, at known places. */
const FLAGS: Record<number, { text: string; confidence: number; reasons: string[] }> = {
  3: { text: 'ご視聴ありがとうございました', confidence: 0.3, reasons: ['low_confidence', 'phantom_phrase'] },
  42: { text: '♪～♪', confidence: 0.8, reasons: ['non_speech_only'] },
  99: { text: '本当ですか', confidence: 0.2, reasons: ['low_confidence'] },
  100: { text: 'あああああああああああ', confidence: 0.6, reasons: ['repetition_loop'] },
  171: { text: 'あなたのことが好きです、ずっと前から'.repeat(3), confidence: 0.9, reasons: ['repetition_loop'] },
  230: { text: '第230句です', confidence: 0.9, reasons: ['duplicate_neighbor'] },
  249: { text: '本当にそう思います', confidence: 0.1, reasons: ['low_confidence'] },
};
function transcript() {
  return { schemaVersion: 1, source: { displayName: 'Paged.wav', durationMs: 1_500_000 },
    model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cuda' }, detectedLanguage: 'ja',
    segments: Array.from({ length: 250 }, (_, index) => {
      const flag = FLAGS[index];
      // Cue 229 says what 230 repeats, 400 ms before it; 171 is long enough not to read too fast.
      const text = flag?.text ?? (index === 229 ? '第230句です' : `第${index}句です`);
      const length = index === 171 ? 4500 : index === 229 ? 4600 : 1800;
      return { id: `s${index}`, startMs: index * 5000, endMs: index * 5000 + length, text, confidence: flag?.confidence ?? 0.9 };
    }) };
}

describe('the review query over the Studio IPC', () => {
  it('counts and orders flagged cues across pages, lands on each one\'s page and steps through them', async () => {
    adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-review-ipc-'));
    const repository = new DocumentRepository(path.join(adapter.directory, 'subtitle-studio/documents'));
    const doc = await repository.create(transcriptToDocument(transcript(), { newId: randomUUID }));
    registration = registerSubtitleStudio();
    const owner = attach();
    const request = { documentId: doc.id, revision: doc.revision };
    // Only a window that listed the document may review it, and only at its current revision.
    expect(isPublicStudioChannel(STUDIO_CHANNELS.reviewCues)).toBe(true);
    expect(await owner.invoke(STUDIO_CHANNELS.reviewCues, request)).toEqual({ ok: false, error: 'access_denied' });
    await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 });
    expect(await owner.invoke(STUDIO_CHANNELS.reviewCues, { ...request, revision: 2 })).toEqual({ ok: false, error: 'revision_conflict' });
    expect(await owner.invoke(STUDIO_CHANNELS.reviewCues, { ...request, field: 'source' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await attach().invoke(STUDIO_CHANNELS.reviewCues, request)).toEqual({ ok: false, error: 'access_denied' });

    // The preload method reaches the same handler.
    const api = createSubtitleStudioApi({ sendSync: () => owner.capability, on: vi.fn(), removeListener: vi.fn(),
      invoke: (channel: string, envelope: unknown) => adapter.handlers.get(channel)!({ sender: owner.client, senderFrame: owner.client.mainFrame }, envelope) });
    const reviewed = await api.reviewCues(request);
    expect(reviewed.ok).toBe(true);
    const result = (reviewed as { ok: true; value: CueReviewResult }).value;
    const indices = Object.keys(FLAGS).map(Number);
    expect(result.cues.map(entry => entry.index)).toEqual(indices);
    expect(result.cues.map(entry => entry.reasons)).toEqual(indices.map(index => FLAGS[index].reasons));
    expect(result.cues.map(entry => entry.cueId)).toEqual(indices.map(index => doc.cues[index].id));
    expect(result).toMatchObject({ total: 7, truncated: false, confidence: true,
      counts: { low_confidence: 3, phantom_phrase: 1, repetition_loop: 2, non_speech_only: 1, abnormal_rate: 0, duplicate_neighbor: 1 } });
    expect(Object.keys(result.counts)).toEqual([...CUE_REVIEW_REASONS]);

    // Going to a flagged cue reads the page it is on; it is there, at its place.
    for (const entry of result.cues) {
      const offset = Math.floor(entry.index / LIMITS.pageSize) * LIMITS.pageSize;
      const page = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset });
      expect(page.ok).toBe(true);
      expect(page.value.cues[entry.index - offset].id).toBe(entry.cueId);
    }
    // From the second page the bar starts at its first flagged cue; next and previous wrap across pages.
    const order = (from: number, step: 1 | -1, count: number) => {
      let at = reviewPosition(result.cues, from);
      const seen = [result.cues[at].index];
      for (let i = 1; i < count; i++) { at = reviewStep(result.cues.length, at, step); seen.push(result.cues[at].index); }
      return seen;
    };
    expect(order(100, 1, 7)).toEqual([100, 171, 230, 249, 3, 42, 99]);
    expect(order(100, -1, 4)).toEqual([100, 99, 42, 3]);
    expect(order(250, 1, 2)).toEqual([3, 42]);
    // The reason filter keeps document order.
    expect(visibleReview(result, new Set(), 'low_confidence').cues.map(entry => entry.index)).toEqual([3, 99, 249]);

    // Editing a low-confidence cue's text drops its confidence flag at the new revision; an ignore keyed to the old text no longer applies.
    const edited = await owner.invoke(STUDIO_CHANNELS.editCues, { ...request, operation: { kind: 'source', cueId: doc.cues[99].id, text: editedText(doc.cues[99].source, '本当ですか？') } });
    expect(edited.ok).toBe(true);
    const next = await owner.invoke(STUDIO_CHANNELS.reviewCues, { documentId: doc.id, revision: edited.value.summary.revision });
    expect(next.value.cues.map((entry: { index: number }) => entry.index)).toEqual([3, 42, 100, 171, 230, 249]);
    expect(next.value.counts.low_confidence).toBe(2);
    // The same revision asked again is answered from the last review, not reviewed twice.
    expect((await owner.invoke(STUDIO_CHANNELS.reviewCues, { documentId: doc.id, revision: edited.value.summary.revision })).value).toBe(next.value);
    const ignored = new Set([cueReviewIgnoreKey(result.cues[0]), `${doc.cues[99].id}:1`]);
    expect(visibleReview(next.value, ignored).cues.map(entry => entry.index)).toEqual([42, 100, 171, 230, 249]);
    // Reading never changes the document.
    expect((await repository.readSnapshot(doc.id)).document.revision).toBe(edited.value.summary.revision);
  }, 30_000);

  it('reviews an older transcript without confidence by its text alone', async () => {
    adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-review-ipc-'));
    const repository = new DocumentRepository(path.join(adapter.directory, 'subtitle-studio/documents'));
    const old = transcript();
    const doc = await repository.create(transcriptToDocument({ ...old, segments: old.segments.map(({ confidence: _, ...segment }) => segment) }, { newId: randomUUID }));
    registration = registerSubtitleStudio();
    const owner = attach();
    await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 });
    const result = await owner.invoke(STUDIO_CHANNELS.reviewCues, { documentId: doc.id, revision: doc.revision });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ confidence: false, total: 5, counts: { low_confidence: 0, phantom_phrase: 1, repetition_loop: 2, non_speech_only: 1, duplicate_neighbor: 1 } });
    expect(result.value.cues.map((entry: { index: number }) => entry.index)).toEqual([3, 42, 100, 171, 230]);
  }, 30_000);
});
