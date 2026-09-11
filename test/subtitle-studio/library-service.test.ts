import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { selectLibrary } from '../../electron/main/subtitle-studio/library-service';
import { requestSchemas } from '../../src/subtitle-studio/ipc-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-library-')); roots.push(root);
  const repository = new DocumentRepository(root);
  const documents = [];
  for (const [index, name] of ['Episode 10.lrc', 'Episode 2.lrc', 'Different.srt', 'Episode 1.lrc'].entries()) {
    const format = name.endsWith('.srt') ? 'srt' : 'lrc';
    const doc = importSubtitleText(format === 'srt' ? '1\n00:00:01,000 --> 00:00:02,000\nSubtitle\n' : '[00:01]Subtitle\n', { format, displayName: name, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
    await repository.create(doc); documents.push(doc);
    await utimes(path.join(root, doc.id, 'current.json'), new Date(100000 + index * 1000), new Date(100000 + index * 1000));
  }
  return { repository, documents };
}
describe('querying the persisted document library', () => {
  it('searches and sorts the whole library before paging with stable global totals', async () => {
    const { repository } = await fixture(); const snapshot = await repository.listSnapshot();
    const first = selectLibrary(snapshot, { offset: 0, pageSize: 2, query: 'EPISODE', format: 'lrc', sort: 'name-asc' });
    const next = selectLibrary(snapshot, { offset: 2, pageSize: 2, query: 'episode', format: 'lrc', sort: 'name-asc' });
    expect(first).toMatchObject({ total: 3, allTotal: 4 });
    expect([...first.documents, ...next.documents].map(doc => doc.origin.displayName)).toEqual(['Episode 1.lrc', 'Episode 2.lrc', 'Episode 10.lrc']);
    expect(selectLibrary(snapshot, { offset: 0, sort: 'recent' }).documents.map(doc => doc.origin.displayName)).toEqual(['Episode 1.lrc', 'Different.srt', 'Episode 2.lrc', 'Episode 10.lrc']);
    expect(selectLibrary(snapshot, { offset: 4 }).documents).toEqual([]);
  });
  it('derives task and translation filters from persisted snapshots without returning checkpoint contents', async () => {
    const { repository, documents } = await fixture();
    const doc = documents[0]; const trackId = randomUUID();
    await repository.transact(doc.id, 1, value => {
      value.document.translationTracks.push({ id: trackId, language: 'zh', revision: 1, entries: { [doc.cues[0].id]: { sourceRevision: 1, sourceHash: 'a', text: { plain: '你好', spans: [{ text: '你好', marks: [] }] }, origin: 'ai', reviewStatus: 'unreviewed' } } });
      value.tasks.push({ id: randomUUID(), trackId, generation: 1, status: 'interrupted', completedBatchIds: [], uncertainBatchIds: [], attempts: 0 });
    });
    const snapshot = await repository.listSnapshot();
    const translated = selectLibrary(snapshot, { offset: 0, status: 'translated' });
    expect(translated.documents).toHaveLength(1);
    expect(translated.documents[0]).toMatchObject({ translationStatus: 'complete', translationTracks: [{ id: trackId, language: 'zh' }], task: { status: 'interrupted' } });
    expect(selectLibrary(snapshot, { offset: 0, status: 'untranslated' }).total).toBe(3);
    expect(selectLibrary(snapshot, { offset: 0, status: 'attention' }).documents.map(doc => doc.id)).toEqual([doc.id]);
    expect(selectLibrary(snapshot, { offset: 0, status: 'active' }).total).toBe(0);
    expect(JSON.stringify(translated)).not.toContain('checkpoint');
  });
  it('rejects unbounded and forged list queries at the IPC contract', () => {
    for (const request of [{ offset: 0, pageSize: 101 }, { offset: 0, pageSize: 0 }, { offset: 0, query: 'x'.repeat(501) }, { offset: 0, status: 'anything' }, { offset: 0, path: 'C:\\outside' }]) expect(requestSchemas.listDocuments.safeParse(request).success).toBe(false);
  });
});
