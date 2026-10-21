import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { DocumentRepository, type CommitStage, type RepositoryEvent } from '../../electron/main/subtitle-studio/document-repository';
import { StudioError } from '../../src/subtitle-studio/domain';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import { sourceBytes } from '../../electron/main/subtitle-studio/export-service';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-repository-')); roots.push(root);
  const raw = '[00:01.00]Hello\n[00:02.00]World\n';
  const doc = importSubtitleText(raw, { format: 'lrc', displayName: 'sample.lrc', encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex') }, randomUUID);
  const directory = path.join(root, 'documents');
  const repo = new DocumentRepository(directory);
  await repo.create(doc);
  return { root, directory, repo, doc, raw };
}
function translated(snapshot: DocumentSnapshot) {
  const trackId = randomUUID();
  snapshot.document.translationTracks.push({ id: trackId, language: 'zh', revision: 1, entries: { [snapshot.document.cues[0].id]: { sourceRevision: 1, sourceHash: 'source-hash', text: { plain: 'Translated', spans: [{ text: 'Translated', marks: [] }] }, origin: 'ai', reviewStatus: 'unreviewed' } } });
  snapshot.tasks.push({ id: randomUUID(), generation: 1, trackId, status: 'completed', completedBatchIds: ['b1'], uncertainBatchIds: [], attempts: 1 });
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('document generations and lifecycle', () => {
  it('still reports a repository-wide storage failure instead of returning an empty library', async () => {
    const { root } = await fixture();
    const blocked = path.join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    await expect(new DocumentRepository(blocked).listSnapshot()).rejects.toThrow();
    expect(await readFile(blocked, 'utf8')).toBe('not a directory');
  });
  it.each<CommitStage>(['generation-write', 'generation-sync', 'generation-ready', 'previous-ready', 'current-write', 'current-sync', 'current-publish'])('keeps the previous complete commit after %s fails', async stage => {
    const { directory, repo, doc, raw } = await fixture();
    await repo.transact(doc.id, 1, translated);
    const failing = new DocumentRepository(directory, { fault: point => { if (point === stage) throw Object.assign(new Error('locked'), { code: 'EPERM' }); } });
    await expect(failing.transact(doc.id, 2, snapshot => {
      snapshot.document.translationTracks[0].entries[doc.cues[0].id].text = { plain: 'Uncommitted', spans: [{ text: 'Uncommitted', marks: [] }] };
      snapshot.tasks[0].completedBatchIds.push('b2');
    })).rejects.toThrow();
    const restored = await new DocumentRepository(directory).readSnapshot(doc.id);
    expect(restored.document.revision).toBe(2);
    expect(restored.tasks[0].completedBatchIds).toEqual(['b1']);
    expect(restored.document.translationTracks[0].entries[doc.cues[0].id].text.plain).toBe('Translated');
    expect(sourceBytes(restored.document).toString()).toBe(raw);
  });
  it('restores the previous published generation when current pointer or generation is corrupt; ignores index', async () => {
    const { directory, repo, doc } = await fixture();
    await repo.transact(doc.id, 1, translated);
    const folder = path.join(directory, doc.id);
    const pointer = JSON.parse(await readFile(path.join(folder, 'current.json'), 'utf8'));
    await writeFile(path.join(folder, `${pointer.generation}.json`), 'corrupt');
    await writeFile(path.join(directory, 'index.json'), 'corrupt index');
    const restarted = new DocumentRepository(directory);
    expect((await restarted.read(doc.id)).revision).toBe(1);
    expect((await restarted.list()).length).toBe(1);
    await writeFile(path.join(folder, 'current.json'), 'corrupt pointer');
    expect((await restarted.read(doc.id)).revision).toBe(1);
    await restarted.transact(doc.id, 1, translated);
    expect((await restarted.read(doc.id)).revision).toBe(2);
  });
  it('never promotes an orphan generation when both pointers are invalid', async () => {
    const { directory, repo, doc } = await fixture();
    await repo.transact(doc.id, 1, translated);
    const folder = path.join(directory, doc.id);
    await writeFile(path.join(folder, 'current.json'), '{}');
    await writeFile(path.join(folder, 'previous.json'), '{}');
    await expect(repo.read(doc.id)).rejects.toThrow('document_unavailable');
    expect(await repo.listSnapshot()).toMatchObject({ documents: [], unavailableDocuments: 1 });
    expect(await readFile(path.join(folder, 'current.json'), 'utf8')).toBe('{}');
    expect(await readFile(path.join(folder, 'previous.json'), 'utf8')).toBe('{}');
  });
  it('keeps healthy documents usable beside an incompatible document and preserves its published files', async () => {
    const { directory, repo, doc } = await fixture();
    const brokenId = randomUUID();
    const folder = path.join(directory, brokenId); await mkdir(folder);
    const pointer = JSON.stringify({ schemaVersion: 1, generation: randomUUID() });
    await writeFile(path.join(folder, 'current.json'), pointer);
    expect(await repo.listSnapshot()).toMatchObject({ documents: [doc], unavailableDocuments: 1 });
    await expect(repo.read(brokenId)).rejects.toThrow('document_unavailable');
    await repo.transact(doc.id, 1, translated);
    expect((await repo.read(doc.id)).revision).toBe(2);
    expect(await readFile(path.join(folder, 'current.json'), 'utf8')).toBe(pointer);
  });
  it('serializes competing instances and rejects stale revisions and asynchronous mutations', async () => {
    const { directory, repo, doc } = await fixture();
    const results = await Promise.allSettled([repo.transact(doc.id, 1, translated), new DocumentRepository(directory).transact(doc.id, 1, translated)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(repo.transact(doc.id, 1, translated)).rejects.toThrow('revision_conflict');
    await expect(repo.transact(doc.id, 2, (() => Promise.resolve()) as never)).rejects.toThrow('invalid_input');
  });
  it('identifies unreadable records consistently across restart and removes only the selected app record', async () => {
    const { directory, root, repo, doc } = await fixture();
    const brokenId = randomUUID(); const folder = path.join(directory, brokenId); await mkdir(folder);
    await writeFile(path.join(folder, 'current.json'), '{}');
    await writeFile(path.join(root, 'source.lrc'), 'source must stay');
    const record = (await repo.listSnapshot()).unavailable[0];
    expect(record).toMatchObject({ id: brokenId, directory: folder, reason: 'document_unavailable' });
    expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await new DocumentRepository(directory).listSnapshot()).unavailable).toEqual([record]);
    expect(await repo.revealUnavailable(brokenId, record.token)).toBe(folder);
    expect(await repo.deleteUnavailable(brokenId, record.token)).toEqual({ cleanupPending: false });
    expect((await new DocumentRepository(directory).listSnapshot()).unavailable).toEqual([]);
    expect((await repo.read(doc.id)).id).toBe(doc.id);
    expect(await readFile(path.join(root, 'source.lrc'), 'utf8')).toBe('source must stay');
    expect(JSON.parse(await readFile(path.join(directory, '.deleted', `${brokenId}.json`), 'utf8'))).toEqual({ schemaVersion: 1, documentId: brokenId, kind: 'unavailable' });
  });
  it('rejects stale recovery tokens and will not delete a document that has become readable', async () => {
    const { directory, repo, doc } = await fixture();
    const file = path.join(directory, doc.id, 'current.json'); const pointer = await readFile(file, 'utf8');
    await writeFile(file, '{}');
    const first = (await repo.listSnapshot()).unavailable[0];
    await writeFile(file, '{"changed":true}');
    await expect(repo.revealUnavailable(doc.id, first.token)).rejects.toThrow('revision_conflict');
    await expect(repo.deleteUnavailable(doc.id, first.token)).rejects.toThrow('revision_conflict');
    const second = (await repo.listSnapshot()).unavailable[0];
    expect(second.token).not.toBe(first.token);
    await writeFile(file, pointer);
    await expect(repo.deleteUnavailable(doc.id, second.token)).rejects.toThrow('revision_conflict');
    expect((await repo.read(doc.id)).revision).toBe(1);
  });
  it('retains unreadable data after authorization failure and retries published recovery cleanup on restart', async () => {
    const { directory, repo, doc } = await fixture();
    await writeFile(path.join(directory, doc.id, 'current.json'), '{}');
    const record = (await repo.listSnapshot()).unavailable[0];
    await expect(repo.deleteUnavailable(doc.id, record.token, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect((await repo.listSnapshot()).unavailable).toEqual([record]);
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    expect(await failing.deleteUnavailable(doc.id, record.token)).toEqual({ cleanupPending: true });
    expect(await readFile(path.join(directory, doc.id, 'current.json'), 'utf8')).toBe('{}');
    expect((await new DocumentRepository(directory).listSnapshot()).unavailable).toEqual([]);
    await expect(readFile(path.join(directory, doc.id, 'current.json'))).rejects.toThrow();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)('clears %s task checkpoints while keeping translation, source and exports', async status => {
    const { repo, doc, root, raw } = await fixture();
    await repo.transact(doc.id, 1, snapshot => { translated(snapshot); snapshot.tasks[0].status = status; });
    const snapshot = await repo.readSnapshot(doc.id);
    await writeFile(path.join(root, 'export.lrc'), raw);
    await repo.removeTask(doc.id, 2, snapshot.tasks[0].id);
    const restored = await repo.readSnapshot(doc.id);
    expect(restored.tasks).toEqual([]);
    expect(restored.document.translationTracks).toEqual(snapshot.document.translationTracks);
    expect(restored.document.cues).toEqual(snapshot.document.cues);
    expect(sourceBytes(restored.document).toString()).toBe(raw);
    expect(await readFile(path.join(root, 'export.lrc'), 'utf8')).toBe(raw);
  });
  it.each(['queued', 'running'] as const)('preserves terminal checkpoints and the document revision while another task is %s', async status => {
    const { directory, repo, doc } = await fixture();
    const before = await repo.transact(doc.id, 1, snapshot => {
      translated(snapshot);
      translated(snapshot);
      snapshot.tasks[1].status = status;
      snapshot.tasks[1].completedBatchIds = [];
      snapshot.tasks[1].attempts = status === 'queued' ? 0 : 1;
    });
    await expect(repo.removeTask(doc.id, before.document.revision, before.tasks[0].id)).rejects.toThrow('revision_conflict');
    expect(await new DocumentRepository(directory).readSnapshot(doc.id)).toEqual(before);
    const completed = await repo.transact(doc.id, before.document.revision, snapshot => {
      snapshot.tasks[1].status = 'completed';
      snapshot.tasks[1].completedBatchIds = ['b1'];
    });
    const cleared = await repo.removeTask(doc.id, completed.document.revision, before.tasks[0].id);
    expect(cleared.tasks).toEqual([completed.tasks[1]]);
    expect(cleared.document.translationTracks).toEqual(completed.document.translationTracks);
    expect(cleared.document.cues).toEqual(completed.document.cues);
    expect(cleared.document.preservation).toEqual(completed.document.preservation);
  });
  it('publishes a tombstone before cancellation/cleanup and rejects late commits or recreation', async () => {
    const { directory, repo, doc, root, raw } = await fixture();
    await writeFile(path.join(root, 'v1-sentinel'), 'keep');
    await writeFile(path.join(root, 'export.lrc'), raw);
    const controller = new AbortController();
    const release = repo.registerActivity(doc.id, controller);
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    const result = await failing.delete(doc.id, 1);
    expect(result.cleanupPending).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    await expect(repo.transact(doc.id, 1, translated)).rejects.toThrow('document_unavailable');
    await expect(repo.create(doc)).rejects.toThrow('document_unavailable');
    expect(await repo.list()).toEqual([]);
    expect((await new DocumentRepository(directory).retryCleanup(doc.id)).cleanupPending).toBe(false);
    expect(await readFile(path.join(root, 'v1-sentinel'), 'utf8')).toBe('keep');
    expect(await readFile(path.join(root, 'export.lrc'), 'utf8')).toBe(raw);
    release();
  });
  it('failed tombstone publication leaves the live document and activity intact', async () => {
    const { directory, repo, doc } = await fixture();
    const controller = new AbortController(); repo.registerActivity(doc.id, controller);
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-publish') throw new Error('locked'); } });
    await expect(failing.delete(doc.id, 1)).rejects.toThrow();
    expect((await repo.read(doc.id)).revision).toBe(1);
    expect(controller.signal.aborted).toBe(false);
  });
  it('validates the entire checkpoint and rejects credential fields without changing current', async () => {
    const { directory, repo, doc } = await fixture();
    await expect(repo.transact(doc.id, 1, snapshot => { translated(snapshot); Object.assign(snapshot.tasks[0], { apiKey: 'must-not-persist', capability: randomUUID() }); })).rejects.toThrow('invalid_input');
    expect((await repo.read(doc.id)).revision).toBe(1);
    for (const file of await readdir(path.join(directory, doc.id))) expect(await readFile(path.join(directory, doc.id, file), 'utf8')).not.toContain('must-not-persist');
    await expect(repo.read('../escape')).rejects.toThrow('invalid_input');
    await mkdir(path.join(directory, 'ignored-cache'));
    expect((await repo.list()).length).toBe(1);
  });
  it('rechecks revoked authorization at publication and preserves current data', async () => {
    const { repo, doc } = await fixture();
    const revoked = () => { throw new Error('access_denied'); };
    await expect(repo.transact(doc.id, 1, translated, revoked)).rejects.toThrow('access_denied');
    await expect(repo.delete(doc.id, 1, revoked)).rejects.toThrow('access_denied');
    expect((await repo.read(doc.id)).revision).toBe(1);
    await expect(repo.create({ ...doc, id: randomUUID() }, revoked)).rejects.toThrow('access_denied');
    expect(await repo.list()).toHaveLength(1);
  });
  it('rejects document directory symlinks and retries only its own tombstoned files after restart', async () => {
    const { directory, repo, doc, root } = await fixture();
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    const linkedId = randomUUID();
    await symlink(outside, path.join(directory, linkedId), 'dir');
    await expect(repo.read(linkedId)).rejects.toThrow('document_unavailable');
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    await failing.delete(doc.id, 1);
    expect(await new DocumentRepository(directory).list()).toEqual([]);
    await expect(readFile(path.join(directory, doc.id, 'current.json'))).rejects.toThrow();
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
  });
  it('detects valid-JSON tampering and reads legacy T01 pointers', async () => {
    const { directory, repo, doc } = await fixture();
    const pointerPath = path.join(directory, doc.id, 'current.json');
    const first = JSON.parse(await readFile(pointerPath, 'utf8'));
    await writeFile(pointerPath, JSON.stringify({ generation: first.generation }));
    expect((await repo.read(doc.id)).id).toBe(doc.id);
    await repo.transact(doc.id, 1, translated);
    const current = JSON.parse(await readFile(pointerPath, 'utf8'));
    const generation = path.join(directory, doc.id, `${current.generation}.json`);
    const json = JSON.parse(await readFile(generation, 'utf8'));
    json.document.origin.displayName = 'tampered.lrc';
    await writeFile(generation, JSON.stringify(json));
    expect((await repo.read(doc.id)).revision).toBe(1);
  });
});

async function library(count: number) {
  const current = await fixture();
  const docs = [current.doc];
  for (let index = 1; index < count; index++) {
    const raw = `[00:01.00]Line ${index}\n`;
    const doc = importSubtitleText(raw, { format: 'lrc', displayName: `sample-${index}.lrc`, encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex') }, randomUUID);
    await current.repo.create(doc); docs.push(doc);
  }
  const events: RepositoryEvent[] = [];
  current.repo.subscribe(event => { events.push(event); });
  const activities = docs.map(doc => { const controller = new AbortController(); current.repo.registerActivity(doc.id, controller); return controller; });
  return { ...current, docs, events, aborted: () => activities.map(controller => controller.signal.aborted) };
}
const reference = (doc: { id: string }, revision = 1) => ({ documentId: doc.id, revision });

describe('batch deletion', () => {
  it('deletes documents in one slot with one ordered deletion event each', async () => {
    const { directory, repo, docs: [kept, first, second], events, aborted } = await library(3);
    expect(await repo.deleteMany([reference(first), reference(second)], 'at-least'))
      .toEqual({ cleanupPending: false, items: [{ documentId: first.id, ok: true }, { documentId: second.id, ok: true }] });
    expect(events.map(({ documentId, revision, deleted }) => ({ documentId, revision, deleted }))).toEqual([
      { documentId: first.id, revision: 2, deleted: true }, { documentId: second.id, revision: 2, deleted: true }]);
    expect(events[1].sequence).toBe(events[0].sequence + 1);
    expect(aborted()).toEqual([false, true, true]);
    expect((await repo.list()).map(doc => doc.id)).toEqual([kept.id]);
    expect((await readdir(directory)).sort()).toEqual(['.deleted', kept.id].sort());
    expect((await readdir(path.join(directory, '.deleted'))).sort()).toEqual([`${first.id}.json`, `${second.id}.json`].sort());
    await expect(repo.create(first)).rejects.toThrow('document_unavailable');
    await expect(repo.transact(second.id, 1, translated)).rejects.toThrow('document_unavailable');
  });
  it('deletes the committed revision under at-least and only the requested one under exact', async () => {
    const { directory, repo, docs: [doc], events } = await library(1);
    await repo.transact(doc.id, 1, translated);
    expect(await repo.deleteMany([reference(doc)], 'exact')).toEqual({ cleanupPending: false, items: [{ documentId: doc.id, ok: false, error: 'revision_conflict' }] });
    expect(await repo.deleteMany([reference(doc, 5)], 'at-least')).toEqual({ cleanupPending: false, items: [{ documentId: doc.id, ok: false, error: 'revision_conflict' }] });
    expect((await repo.read(doc.id)).revision).toBe(2);
    expect(await repo.deleteMany([reference(doc)], 'at-least')).toEqual({ cleanupPending: false, items: [{ documentId: doc.id, ok: true }] });
    expect(JSON.parse(await readFile(path.join(directory, '.deleted', `${doc.id}.json`), 'utf8'))).toEqual({ schemaVersion: 1, documentId: doc.id, revision: 3 });
    expect(events.at(-1)).toMatchObject({ documentId: doc.id, revision: 3, deleted: true });
  });
  it('reports each document of a mixed batch on its own and removes only the deletable one', async () => {
    const { repo, docs: [doc, gone, edited] } = await library(3);
    await repo.delete(gone.id, 1);
    await repo.transact(edited.id, 1, translated);
    const unknown = randomUUID();
    expect(await repo.deleteMany([reference(doc), { documentId: unknown, revision: 1 }, reference(gone), reference(edited)], 'exact')).toEqual({ cleanupPending: false, items: [
      { documentId: doc.id, ok: true }, { documentId: unknown, ok: false, error: 'document_unavailable' },
      { documentId: gone.id, ok: false, error: 'document_unavailable' }, { documentId: edited.id, ok: false, error: 'revision_conflict' }] });
    expect((await repo.list()).map(item => item.id)).toEqual([edited.id]);
  });
  it('keeps a document whose tombstone cannot be published while the rest of the batch completes', async () => {
    const { directory, repo, docs, events, aborted } = await library(3);
    let publications = 0;
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-publish' && ++publications === 2) throw new Error('locked'); } });
    expect(await failing.deleteMany(docs.map(doc => reference(doc)), 'at-least')).toEqual({ cleanupPending: false, items: [
      { documentId: docs[0].id, ok: true }, { documentId: docs[1].id, ok: false, error: 'document_unavailable' }, { documentId: docs[2].id, ok: true }] });
    expect((await repo.read(docs[1].id)).revision).toBe(1);
    expect(aborted()).toEqual([true, false, true]);
    expect(events.map(event => event.documentId)).toEqual([docs[0].id, docs[2].id]);
    expect((await readdir(path.join(directory, '.deleted'))).sort()).toEqual([`${docs[0].id}.json`, `${docs[2].id}.json`].sort());
  });
  it('stops at a revoked guard and still finishes the documents already tombstoned', async () => {
    const { directory, repo, docs, events, aborted } = await library(3);
    let checks = 0;
    await expect(repo.deleteMany(docs.map(doc => reference(doc)), 'at-least', () => { if (++checks === 2) throw new StudioError('access_denied'); })).rejects.toThrow('access_denied');
    expect(events.map(({ documentId, deleted }) => ({ documentId, deleted }))).toEqual([{ documentId: docs[0].id, deleted: true }]);
    expect(aborted()).toEqual([true, false, false]);
    await expect(readdir(path.join(directory, docs[0].id))).rejects.toThrow();
    expect((await repo.list()).map(doc => doc.id).sort()).toEqual([docs[1].id, docs[2].id].sort());
  });
  it('reports pending cleanup, hides every document and lets a later listing remove the folders', async () => {
    const { directory, docs, events } = await library(2);
    const failing = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    expect(await failing.deleteMany(docs.map(doc => reference(doc)), 'at-least')).toEqual({ cleanupPending: true, items: docs.map(doc => ({ documentId: doc.id, ok: true })) });
    expect(events.map(event => event.deleted)).toEqual([true, true]);
    expect((await readdir(directory)).sort()).toEqual(['.deleted', ...docs.map(doc => doc.id)].sort());
    expect(await new DocumentRepository(directory).listSnapshot()).toMatchObject({ documents: [], unavailableDocuments: 0 });
    expect(await readdir(directory)).toEqual(['.deleted']);
  });
  it('orders the batch with commits, activities and listings queued around it', async () => {
    const { directory, repo, docs: [doc] } = await library(1);
    const edit = repo.transact(doc.id, 1, translated);
    const deletion = repo.deleteMany([reference(doc)], 'at-least');
    const late = repo.transact(doc.id, 2, translated);
    const listing = repo.listSnapshot();
    expect((await edit).document.revision).toBe(2);
    expect(await deletion).toEqual({ cleanupPending: false, items: [{ documentId: doc.id, ok: true }] });
    await expect(late).rejects.toThrow('document_unavailable');
    expect((await listing).documents).toEqual([]);
    expect(JSON.parse(await readFile(path.join(directory, '.deleted', `${doc.id}.json`), 'utf8')).revision).toBe(3);
    const controller = new AbortController(); repo.registerActivity(doc.id, controller);
    await repo.listSnapshot();
    expect(controller.signal.aborted).toBe(true);
  });
  it('rejects empty, oversized, duplicate and malformed batches before writing anything', async () => {
    const { directory, repo, doc } = await fixture();
    for (const documents of [[], Array.from({ length: 101 }, () => ({ documentId: randomUUID(), revision: 1 })), [reference(doc), reference(doc)], [{ documentId: '../x', revision: 1 }], [reference(doc, 0)]])
      await expect(repo.deleteMany(documents, 'exact')).rejects.toThrow('invalid_input');
    expect(await readdir(directory)).toEqual([doc.id]);
    expect((await repo.read(doc.id)).revision).toBe(1);
  });
  it('lists without revisiting old tombstones and still removes a leftover folder', async () => {
    const { directory, repo, docs: [kept, leftover] } = await library(2);
    await mkdir(path.join(directory, '.deleted'));
    for (let index = 0; index < 40; index++) {
      const id = randomUUID();
      await writeFile(path.join(directory, '.deleted', `${id}.json`), JSON.stringify({ schemaVersion: 1, documentId: id, revision: 2 }));
    }
    const locked = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    expect(await locked.delete(leftover.id, 1)).toEqual({ cleanupPending: true });
    let cleanups = 0;
    const counting = new DocumentRepository(directory, { fault: stage => { if (stage === 'delete-cleanup') cleanups++; } });
    expect(await counting.listSnapshot()).toMatchObject({ documents: [kept], unavailableDocuments: 0 });
    expect(cleanups).toBe(1);
    expect((await readdir(directory)).sort()).toEqual(['.deleted', kept.id].sort());
    expect(await readdir(path.join(directory, '.deleted'))).toHaveLength(41);
    expect((await repo.list()).map(doc => doc.id)).toEqual([kept.id]);
  });
});
