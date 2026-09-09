import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
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
    await expect(repo.list()).rejects.toThrow('document_unavailable');
  });
  it('serializes competing instances and rejects stale revisions and asynchronous mutations', async () => {
    const { directory, repo, doc } = await fixture();
    const results = await Promise.allSettled([repo.transact(doc.id, 1, translated), new DocumentRepository(directory).transact(doc.id, 1, translated)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(repo.transact(doc.id, 1, translated)).rejects.toThrow('revision_conflict');
    await expect(repo.transact(doc.id, 2, (() => Promise.resolve()) as never)).rejects.toThrow('invalid_input');
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
