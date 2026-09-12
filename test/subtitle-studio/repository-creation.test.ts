import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(fault?: (stage: CommitStage) => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-confirmed-create-')); roots.push(root);
  const raw = '[00:01.00]Hello\n';
  const doc = importSubtitleText(raw, { format: 'lrc', displayName: 'sample.lrc', encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex') }, randomUUID);
  return { root, doc, repo: new DocumentRepository(root, { fault }) };
}

describe('confirmed document creation', () => {
  it.each<CommitStage>(['generation-write', 'generation-sync', 'generation-ready', 'current-write', 'current-sync', 'current-publish'])('retries the same identity after %s fails before publication', async stage => {
    let fail = true;
    const { repo, doc, root } = await fixture(point => { if (fail && point === stage) throw new Error('disk failure'); });
    await expect(repo.createConfirmed(doc)).rejects.toThrow('disk failure');
    expect(await repo.list()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    fail = false;
    expect(await repo.createConfirmed(doc)).toMatchObject({ status: 'committed', documentId: doc.id, revision: 1, replayed: false, durability: 'confirmed' });
    expect((await repo.list()).map(value => value.id)).toEqual([doc.id]);
  });

  it('retains an already published document and reports uncertain durability after directory sync fails', async () => {
    const { repo, doc, root } = await fixture(stage => { if (stage === 'current-directory-sync') throw new Error('sync failure'); });
    const events: unknown[] = []; const unsubscribe = repo.subscribe(event => events.push(event));
    expect(await repo.createConfirmed(doc)).toEqual({ status: 'committed', documentId: doc.id, revision: 1, replayed: false, durability: 'uncertain' });
    expect(await repo.read(doc.id)).toEqual(doc);
    expect(events).toHaveLength(1);
    const restarted = new DocumentRepository(root);
    expect(await restarted.createConfirmed(doc)).toMatchObject({ status: 'committed', documentId: doc.id, replayed: true, durability: 'confirmed' });
    expect(await restarted.list()).toHaveLength(1);
    expect(events).toHaveLength(1);
    unsubscribe();
  });

  it('keeps creation identity through later revisions and refuses a different creation payload', async () => {
    const { repo, doc } = await fixture();
    const concurrent = await Promise.all([repo.createConfirmed(doc), repo.createConfirmed(structuredClone(doc))]);
    expect(concurrent.map(receipt => receipt.replayed)).toEqual([false, true]);
    await repo.transact(doc.id, 1, snapshot => { snapshot.document.origin.displayName = 'renamed.lrc'; });
    expect(await repo.createConfirmed(doc)).toMatchObject({ documentId: doc.id, revision: 1, replayed: true });
    expect((await repo.read(doc.id)).revision).toBe(2);
    await expect(repo.createConfirmed({ ...doc, origin: { ...doc.origin, displayName: 'different.lrc' } })).rejects.toThrow('revision_conflict');
    expect((await repo.read(doc.id)).origin.displayName).toBe('renamed.lrc');
  });

  it('gives published deletion precedence over a replay and never adopts an ordinary document', async () => {
    const { repo, doc } = await fixture();
    await repo.createConfirmed(doc);
    await repo.delete(doc.id, 1);
    await expect(repo.createConfirmed(doc)).rejects.toThrow('document_unavailable');
    const ordinary = { ...doc, id: randomUUID() };
    await repo.create(ordinary);
    await expect(repo.createConfirmed(ordinary)).rejects.toThrow('revision_conflict');
    expect((await repo.list()).map(value => value.id)).toEqual([ordinary.id]);
  });

  it('retains cleanup ownership after a pre-publication cleanup failure and retries only that exact directory', async () => {
    let fail = true;
    const { repo, doc, root } = await fixture(stage => { if (fail && ['current-sync', 'create-cleanup'].includes(stage)) throw new Error(stage); });
    await expect(repo.createConfirmed(doc)).rejects.toThrow('cleanup remains pending');
    const before = await lstat(path.join(root, doc.id));
    expect(await repo.listSnapshot()).toMatchObject({ documents: [], unavailableDocuments: 1 });
    fail = false;
    expect(await repo.createConfirmed(doc)).toMatchObject({ status: 'committed', documentId: doc.id });
    expect((await lstat(path.join(root, doc.id))).ino).toBe(before.ino);
    expect(await repo.listSnapshot()).toMatchObject({ unavailableDocuments: 0 });
  });

  it('does not promote or delete an unrelated unpublished directory', async () => {
    const { repo, doc, root } = await fixture();
    const directory = path.join(root, doc.id); await mkdir(directory);
    await writeFile(path.join(directory, 'sentinel'), 'keep');
    await expect(repo.createConfirmed(doc)).rejects.toThrow('document_unavailable');
    expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readdir(directory)).toEqual(['sentinel']);
  });

  it('does not reuse cleanup authority after its unpublished directory is replaced', async () => {
    let fail = true;
    const { repo, doc, root } = await fixture(stage => { if (fail && ['current-sync', 'create-cleanup'].includes(stage)) throw new Error(stage); });
    await expect(repo.createConfirmed(doc)).rejects.toThrow('cleanup remains pending');
    const directory = path.join(root, doc.id);
    // Keep the old inode alive so this replacement cannot accidentally reuse its identity.
    const retained = path.join(root, 'retained');
    const { rename } = await import('node:fs/promises');
    await rename(directory, retained); await mkdir(directory);
    await writeFile(path.join(directory, 'sentinel'), 'replacement');
    fail = false;
    await expect(repo.createConfirmed(doc)).rejects.toThrow('revision_conflict');
    expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).toBe('replacement');
  });

  it('fences queued and publication-time revocation, but does not reject an already published creation', async () => {
    let active = true;
    const guard = () => { if (!active) throw new Error('revoked'); };
    const early = await fixture(stage => { if (stage === 'current-publish') active = false; });
    await expect(early.repo.createConfirmed(early.doc, guard)).rejects.toThrow('revoked');
    expect(await early.repo.list()).toEqual([]);
    active = true;
    const late = await fixture(stage => { if (stage === 'current-directory-sync') active = false; });
    expect(await late.repo.createConfirmed(late.doc, guard)).toMatchObject({ status: 'committed' });
    expect(await late.repo.list()).toHaveLength(1);
  });

  it('captures the validated payload before waiting for the repository queue', async () => {
    const { repo, doc } = await fixture();
    const pending = repo.createConfirmed(doc);
    doc.origin.displayName = 'mutated-after-call.lrc';
    await pending;
    expect((await repo.read(doc.id)).origin.displayName).toBe('sample.lrc');
  });
});
