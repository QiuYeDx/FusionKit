import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE_DIRECTORY, KnowledgeRepository, RETAINED_GENERATIONS, type RepositoryOptions, type StoredLibrary } from '../../electron/main/translation-knowledge/repository';
import { KnowledgeServiceError } from '../../electron/main/translation-knowledge/errors';

const roots: string[] = [];
const repositories: KnowledgeRepository[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repository => repository.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-knowledge-repo-')); roots.push(root);
  return root;
}
function open(root: string, options: RepositoryOptions = {}) {
  const repository = new KnowledgeRepository(root, options); repositories.push(repository);
  return repository;
}
async function close(repository: KnowledgeRepository) {
  await repository.dispose();
  repositories.splice(repositories.indexOf(repository), 1);
}
const addCollection = (state: StoredLibrary, name = 'Example') => {
  state.data.collections.push({ id: randomUUID(), revision: 1, name, description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: false });
  return { state, result: (published: StoredLibrary) => published };
};
/** Files a previous storage layout could leave behind. Their contents are never interpreted. */
async function writeOtherLayout(root: string) {
  const files = {
    'current.json': JSON.stringify({ version: 1, generation: 4, file: 'generation-4-00000000-0000-4000-8000-000000000004.json', digest: 'a'.repeat(64) }),
    'generation-3-00000000-0000-4000-8000-000000000003.json': '{"format":2,"anything":"old"}',
    'generation-4-00000000-0000-4000-8000-000000000004.json': '{"format":2,"subjects":[]}',
    'purge-00000000-0000-4000-8000-000000000009.json': '{"format":1}',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return files;
}

describe('knowledge repository', () => {
  it('starts an empty library in an empty directory without creating an archive', async () => {
    const root = await directory();
    const state = await open(root).read();
    expect(state).toMatchObject({ format: 3, generation: 0, data: { schemaVersion: 2, collections: [], entries: [], presets: [] } });
    expect(await readdir(root)).not.toContain(ARCHIVE_DIRECTORY);
  });

  it('moves a library stored in another layout into the archive unchanged and starts fresh', async () => {
    const root = await directory();
    const files = await writeOtherLayout(root);
    const repository = open(root, { now: () => new Date('2026-10-12T08:09:10.123Z') });
    expect((await repository.read()).data.collections).toEqual([]);
    const archived = path.join(root, ARCHIVE_DIRECTORY, '20261012T080910Z');
    expect((await readdir(archived)).sort()).toEqual(Object.keys(files).sort());
    for (const [name, text] of Object.entries(files)) expect(await readFile(path.join(archived, name), 'utf8')).toBe(text);
    expect((await readdir(root)).filter(name => name !== ARCHIVE_DIRECTORY && !name.startsWith('generation-'))).toEqual(['current.json']);
    const saved = await repository.transact(state => addCollection(state));
    expect(saved.data.collections).toHaveLength(1);
    await close(repository);
    const reopened = open(root);
    expect((await reopened.read()).data.collections).toHaveLength(1);
    expect(await readdir(path.join(root, ARCHIVE_DIRECTORY))).toEqual(['20261012T080910Z']);
  });

  it('finishes an interrupted archive on the next start because the pointer moves last', async () => {
    const root = await directory();
    const files = await writeOtherLayout(root);
    let moves = 0;
    const failing = open(root, { now: () => new Date('2026-10-12T00:00:00Z'), archiveHook: () => { if (++moves === 2) throw new Error('disk busy'); } });
    await expect(failing.read()).rejects.toMatchObject({ code: 'storage_unavailable', diagnostics: [expect.objectContaining({ code: 'ARCHIVE_FAILED' })] });
    expect(await readdir(root)).toContain('current.json');
    await close(failing);
    const retried = open(root, { now: () => new Date('2026-10-12T00:00:05Z') });
    expect((await retried.read()).generation).toBe(0);
    const archives = await readdir(path.join(root, ARCHIVE_DIRECTORY));
    expect(archives.sort()).toEqual(['20261012T000000Z', '20261012T000005Z']);
    const moved = (await Promise.all(archives.map(name => readdir(path.join(root, ARCHIVE_DIRECTORY, name))))).flat();
    expect(moved.sort()).toEqual(Object.keys(files).sort());
  });

  it('reports a damaged current library instead of archiving or emptying it', async () => {
    const root = await directory();
    const repository = open(root);
    await repository.transact(state => addCollection(state));
    await close(repository);
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    await writeFile(path.join(root, pointer.file), '{"format":3,"generation":1,"data":{}}');
    await expect(open(root).read()).rejects.toMatchObject({ code: 'storage_unavailable', diagnostics: [expect.objectContaining({ code: 'GENERATION_DIGEST' })] });
    await close(repositories[0]);
    await writeFile(path.join(root, 'current.json'), '{not json');
    await expect(open(root).read()).rejects.toMatchObject({ code: 'storage_unavailable', diagnostics: [expect.objectContaining({ code: 'CURRENT_CORRUPT' })] });
    await close(repositories[0]);
    await rm(path.join(root, 'current.json'));
    await expect(open(root).read()).rejects.toMatchObject({ code: 'storage_unavailable', diagnostics: [expect.objectContaining({ code: 'CURRENT_MISSING' })] });
    expect(await readdir(root)).not.toContain(ARCHIVE_DIRECTORY);
  });

  it(`keeps the newest ${RETAINED_GENERATIONS} generations and leaves other files alone`, async () => {
    const root = await directory();
    await mkdir(path.join(root, ARCHIVE_DIRECTORY, 'kept'), { recursive: true });
    await writeFile(path.join(root, ARCHIVE_DIRECTORY, 'kept', 'generation-0-00000000-0000-4000-8000-000000000000.json'), '{}');
    const repository = open(root);
    for (let i = 0; i < 25; i++) await repository.transact(state => addCollection(state, `Collection ${i}`));
    const names = await readdir(root);
    const generations = names.filter(name => name.startsWith('generation-'));
    expect(generations).toHaveLength(RETAINED_GENERATIONS);
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    expect(pointer).toMatchObject({ version: 2, generation: 25 });
    expect(generations).toContain(pointer.file);
    expect(Math.min(...generations.map(name => Number(name.split('-')[1])))).toBe(6);
    expect(await readdir(path.join(root, ARCHIVE_DIRECTORY, 'kept'))).toHaveLength(1);
    expect((await repository.read()).data.collections).toHaveLength(25);
  });

  it('publishes nothing when the generation or pointer cannot be written', async () => {
    const root = await directory();
    let failAt: string | undefined;
    const repository = open(root, { publicationHook: stage => { if (stage === failAt) throw new Error(`fail ${stage}`); } });
    await repository.read();
    for (const stage of ['generation_synced', 'before_pointer_rename'] as const) {
      failAt = stage;
      await expect(repository.transact(state => addCollection(state))).rejects.toMatchObject({ code: 'write_failed', diagnostics: [expect.objectContaining({ code: 'PUBLICATION_FAILED' })] });
      failAt = undefined;
      expect((await repository.read()).data.collections).toEqual([]);
      expect((await readdir(root)).filter(name => name.startsWith('.pending-'))).toEqual([]);
    }
    failAt = 'pointer_renamed';
    await expect(repository.transact(state => addCollection(state))).rejects.toMatchObject({ code: 'write_failed', diagnostics: [expect.objectContaining({ code: 'PUBLICATION_UNCERTAIN' })] });
    failAt = undefined;
    expect((await repository.read()).data.collections).toHaveLength(1);
  });

  it('rejects invalid transaction results without publishing them', async () => {
    const root = await directory();
    const repository = open(root);
    await expect(repository.transact(state => {
      state.data.entries.push({ id: randomUUID(), revision: 1, collectionId: randomUUID(), enabled: true, kind: 'rule', payload: { text: 'Orphan', required: false } });
      return { state, result: () => undefined };
    })).rejects.toBeInstanceOf(KnowledgeServiceError);
    expect((await repository.read()).generation).toBe(0);
  });

  it('allows one active owner for a directory', async () => {
    const root = await directory();
    await open(root).read();
    await expect(open(root).read()).rejects.toMatchObject({ code: 'storage_unavailable', diagnostics: [expect.objectContaining({ code: 'LIBRARY_BUSY' })] });
  });
});
