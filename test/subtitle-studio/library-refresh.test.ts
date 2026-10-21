import { describe, expect, it } from 'vitest';
import { StudioDeletionDeferral, StudioLibraryInvalidation } from '../../src/services/subtitle-studio/library-refresh';
import { StudioRefreshCoordinator } from '../../src/services/subtitle-studio/refresh-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

/** The Studio page's wiring: list reads settle the changes they cover; the background read takes the flag first. */
function library() {
  const changes = new StudioLibraryInvalidation();
  const reads: string[] = [];
  let gate: Promise<void> | undefined;
  const load = async (kind: string) => {
    const covered = changes.beginRead();
    reads.push(kind);
    await gate;
    changes.settle(covered);
  };
  const reader = new StudioRefreshCoordinator(async () => { if (changes.take()) await load('background'); }, error => { throw error; });
  const changed = () => { changes.invalidate(); if (changes.dirty) reader.requestRefresh(); };
  return { changes, reads, reader, changed, load, hold: (value: Promise<void>) => { gate = value; }, release: () => { gate = undefined; } };
}

describe('library invalidation', () => {
  it('reads again after a change that arrives while a foreground read is running', async () => {
    const { reads, reader, changed, load, hold, release } = library();
    const pending = deferred(); hold(pending.promise);
    const foreground = reader.runForeground(() => load('foreground'));
    await flush();
    expect(reads).toEqual(['foreground']);
    changed();
    release(); pending.resolve(); await foreground; await flush();
    expect(reads).toEqual(['foreground', 'background']);
  });
  it('skips the queued background read when a later foreground read already covered the change', async () => {
    const { changes, reads, reader, changed, load } = library();
    changed();
    await reader.runForeground(() => load('foreground')); await flush();
    expect(reads).toEqual(['foreground']);
    expect(changes.dirty).toBe(false);
  });
  it('keeps the flag for a change counted after the read began, and clears it once a later read covers it', () => {
    const changes = new StudioLibraryInvalidation();
    const first = changes.beginRead();
    changes.invalidate();
    changes.settle(first);
    expect(changes.dirty).toBe(true);
    const second = changes.beginRead();
    changes.settle(second);
    expect(changes.dirty).toBe(false);
  });
  it('lets the background read take the flag once', () => {
    const changes = new StudioLibraryInvalidation();
    expect(changes.take()).toBe(false);
    changes.invalidate(); changes.invalidate();
    expect(changes.take()).toBe(true);
    expect(changes.dirty).toBe(false);
    expect(changes.take()).toBe(false);
  });
});

describe('deferred batch deletions', () => {
  it('holds only the open batch\'s own events and forgets them together with the successful items', () => {
    const deletions = new StudioDeletionDeferral();
    expect(deletions.hold('a')).toBe(false);
    const batch = deletions.open(['a', 'b', 'c']);
    expect(deletions.hold('a')).toBe(true);
    expect(deletions.hold('elsewhere')).toBe(false);
    const { forget, items } = deletions.settle(batch, { items: [{ documentId: 'a', ok: true }, { documentId: 'b', ok: true }, { documentId: 'c', ok: false, error: 'revision_conflict' }] });
    expect([...forget].sort()).toEqual(['a', 'b']);
    expect(items).toEqual([{ documentId: 'a', ok: true }, { documentId: 'b', ok: true }, { documentId: 'c', ok: false, error: 'revision_conflict' }]);
    expect(deletions.hold('b')).toBe(false);
  });
  it('forgets a document whose deletion was observed although main reports it failed, and keeps that result', () => {
    const deletions = new StudioDeletionDeferral();
    const batch = deletions.open(['a', 'b']);
    deletions.hold('b');
    const { forget, items } = deletions.settle(batch, { items: [{ documentId: 'a', ok: true }, { documentId: 'b', ok: false, error: 'document_unavailable' }] });
    expect([...forget].sort()).toEqual(['a', 'b']);
    expect(items[1]).toEqual({ documentId: 'b', ok: false, error: 'document_unavailable' });
  });
  it('reports observed deletions as done when the request failed as a whole', () => {
    const deletions = new StudioDeletionDeferral();
    const batch = deletions.open(['a', 'b', 'c']);
    deletions.hold('a'); deletions.hold('b');
    const { forget, items } = deletions.settle(batch, { error: 'access_denied' });
    expect([...forget].sort()).toEqual(['a', 'b']);
    expect(items).toEqual([{ documentId: 'a', ok: true }, { documentId: 'b', ok: true }, { documentId: 'c', ok: false, error: 'access_denied' }]);
  });
  it('fails a target missing from the answer', () => {
    const deletions = new StudioDeletionDeferral();
    const batch = deletions.open(['a', 'b']);
    const { forget, items } = deletions.settle(batch, { items: [{ documentId: 'a', ok: true }] });
    expect([...forget]).toEqual(['a']);
    expect(items[1]).toEqual({ documentId: 'b', ok: false, error: 'document_unavailable' });
  });
  it('leaves a newer batch open when an older one settles', () => {
    const deletions = new StudioDeletionDeferral();
    const older = deletions.open(['a']);
    deletions.open(['b']);
    deletions.settle(older, { items: [{ documentId: 'a', ok: true }] });
    expect(deletions.hold('b')).toBe(true);
    expect(deletions.hold('a')).toBe(false);
  });
});
