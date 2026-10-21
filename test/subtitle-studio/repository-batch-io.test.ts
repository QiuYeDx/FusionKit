import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const filesystem = vi.hoisted(() => ({ failLstat: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (async (target: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      if (filesystem.failLstat && String(target) === filesystem.failLstat) throw Object.assign(new Error('synthetic i/o error'), { code: 'EIO' });
      return (actual.lstat as (...input: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof actual.lstat,
  };
});

import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { DocumentRepository, type RepositoryEvent } from '../../electron/main/subtitle-studio/document-repository';

const roots: string[] = [];
afterEach(async () => { filesystem.failLstat = ''; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('batch deletion I/O failures', () => {
  it('fails only the document whose tombstone check hits an unexpected I/O error and deletes the rest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-repository-io-')); roots.push(root);
    const directory = path.join(root, 'documents');
    const repo = new DocumentRepository(directory);
    const docs = [];
    for (let index = 0; index < 5; index++) {
      const raw = `[00:01.00]Line ${index}\n`;
      const doc = importSubtitleText(raw, { format: 'lrc', displayName: `sample-${index}.lrc`, encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex') }, randomUUID);
      await repo.create(doc); docs.push(doc);
    }
    const events: RepositoryEvent[] = [];
    repo.subscribe(event => { events.push(event); });
    filesystem.failLstat = path.join(directory, '.deleted', `${docs[2].id}.json`);
    expect(await repo.deleteMany(docs.map(doc => ({ documentId: doc.id, revision: 1 })), 'at-least')).toEqual({ cleanupPending: false, items: docs.map((doc, index) =>
      index === 2 ? { documentId: doc.id, ok: false, error: 'document_unavailable' } : { documentId: doc.id, ok: true }) });
    expect(events.map(event => event.documentId)).toEqual([docs[0].id, docs[1].id, docs[3].id, docs[4].id]);
    filesystem.failLstat = '';
    expect((await repo.list()).map(doc => doc.id)).toEqual([docs[2].id]);
  });
});
