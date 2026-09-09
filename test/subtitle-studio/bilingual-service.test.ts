import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioError, type SubtitleDocument } from '../../src/subtitle-studio/domain';
import type { BilingualOptions } from '../../src/subtitle-studio/bilingual-contract';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
import { sourceBytes } from '../../electron/main/subtitle-studio/export-service';
import { readSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { sourceDigest, serializeTranslationRequest } from '../../electron/main/subtitle-studio/translation-planner';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';

const options: BilingualOptions = { sourceSide: 'first', splitInline: false, overrides: [] };
const original = '[00:01.00]\u3053\u3093\u306b\u3061\u306f\n[00:01.00]IMPORTED_TARGET_A\n[00:03.00]\u307e\u305f\u660e\u65e5\n[00:03.00]IMPORTED_TARGET_B\n';
const parse = (source = original) => importSubtitleText(source, {
  format: 'lrc', displayName: 'bilingual.lrc', encoding: 'utf-8', digest: 'f'.repeat(64),
}, randomUUID);
type Task = DocumentSnapshot['tasks'][number];
const taskFor = (trackId: string, status: Task['status']): Task => ({
  id: randomUUID(), trackId, status, generation: 1, attempts: 0, completedBatchIds: [], uncertainBatchIds: [],
});
const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
const roots: string[] = [];
const translations: TranslationService[] = [];
async function fixture(doc = parse()) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-bilingual-service-'));
  roots.push(root);
  const directory = path.join(root, 'documents');
  const repository = new DocumentRepository(directory);
  await repository.create(doc);
  return { root, directory, repository, service: new BilingualService(repository), doc };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const config = {
  model: { profileId: 'bilingual-fixture', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const },
  language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1,
};
const result = (request: ModelRuntimeTextRequest): ModelRuntimeTextResult => ({
  apiFormat: 'chat_completions', finishReason: 'stop',
  content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string }) => ({ id: item.id, text: `NEW_TARGET_${item.id}` })) }),
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

afterEach(async () => {
  for (const service of translations.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bilingual document service transactions', () => {
  it('previews without committing, applies one revision and restores original bytes after reopening', async () => {
    const current = await fixture();
    const bytes = Buffer.from(`\ufeff${original.replaceAll('\n', '\r\n')}`, 'utf8');
    const sourcePath = path.join(current.root, 'original.lrc');
    await writeFile(sourcePath, bytes);
    const doc = await current.repository.create(await readSubtitle(sourcePath, 'utf-8'));
    const before = await current.repository.readSnapshot(doc.id);
    const preview = await current.service.preview(doc.id, doc.revision, options, 0);
    expect(preview).toMatchObject({ revision: 1, originalCueCount: 4, cueCount: 2, pairedCount: 2, remainingCount: 0 });
    expect(await current.repository.readSnapshot(doc.id)).toEqual(before);
    const applied = await current.service.apply(doc.id, doc.revision, options);
    expect(applied.revision).toBe(doc.revision + 1);
    expect(applied.cues.map(cue => cue.id)).toEqual([doc.cues[0].id, doc.cues[2].id]);
    expect(applied.cues.map(cue => cue.source.plain)).toEqual([doc.cues[0].source.plain, doc.cues[2].source.plain]);
    expect(applied.cues.map(cue => cue.timing)).toEqual([doc.cues[0].timing, doc.cues[2].timing]);
    expect(applied.translationTracks).toHaveLength(1);
    const track = applied.translationTracks[0];
    expect(track.origin).toBe('imported');
    for (const [index, cue] of applied.cues.entries()) {
      expect(cue.sourceRevision).toBe(doc.cues[index * 2].sourceRevision + 1);
      expect(track.entries[cue.id]).toMatchObject({ sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), origin: 'imported', reviewStatus: 'unreviewed' });
      expect(track.entries[cue.id].text.plain).toBe(doc.cues[index * 2 + 1].source.plain);
    }
    expect(applied.preservation.rawText).toBe(doc.preservation.rawText);
    expect(applied.preservation.nodes.map(({ cueIds: _cueIds, ...node }) => node))
      .toEqual(doc.preservation.nodes.map(({ cueIds: _cueIds, ...node }) => node));
    await rm(sourcePath);
    const reopened = await new DocumentRepository(current.directory).read(doc.id);
    expect(reopened).toEqual(applied);
    expect(sourceBytes(reopened).equals(bytes)).toBe(true);
  });

  it.each<CommitStage>(['generation-write', 'generation-sync', 'generation-ready', 'previous-ready', 'current-write', 'current-sync', 'current-publish'])('does not publish a partial reinterpretation when %s fails', async stage => {
    const current = await fixture();
    const before = await current.repository.readSnapshot(current.doc.id);
    const failing = new BilingualService(new DocumentRepository(current.directory, { fault: point => {
      if (point === stage) throw new Error('synthetic-write-failure');
    } }));
    await expect(failing.apply(current.doc.id, 1, options)).rejects.toThrow('synthetic-write-failure');
    expect(await new DocumentRepository(current.directory).readSnapshot(current.doc.id)).toEqual(before);
    expect(sourceBytes(before.document).toString('utf8')).toBe(original);
  });

  it('rejects stale revisions, invalid split choices and revoked owners without changing the document', async () => {
    const current = await fixture();
    const before = await current.repository.readSnapshot(current.doc.id);
    const denied = () => { throw new StudioError('access_denied'); };
    await expect(current.service.preview(current.doc.id, 2, options, 0)).rejects.toThrow('revision_conflict');
    await expect(current.service.apply(current.doc.id, 2, options)).rejects.toThrow('revision_conflict');
    await expect(current.service.preview(current.doc.id, 1, options, 0, denied)).rejects.toThrow('access_denied');
    await expect(current.service.apply(current.doc.id, 1, options, denied)).rejects.toThrow('access_denied');
    await expect(current.service.apply(current.doc.id, 1, { ...options, overrides: [{ cueId: current.doc.cues[0].id, splitAt: 1 }] })).rejects.toThrow('invalid_input');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it.each(['track', 'task', 'bilingual-import'] as const)('rejects another interpretation when %s already exists', async kind => {
    const current = await fixture();
    let revision = 1;
    if (kind === 'bilingual-import') {
      const applied = await current.service.apply(current.doc.id, revision, options);
      const removed = await current.service.removeTrack(current.doc.id, applied.revision, applied.translationTracks[0].id);
      revision = removed.revision;
      expect(removed.translationTracks).toEqual([]);
    } else {
      const updated = await current.repository.transact(current.doc.id, revision, snapshot => {
        const trackId = randomUUID();
        snapshot.document.translationTracks.push({ id: trackId, language: 'en', revision: 1, entries: {} });
        if (kind === 'task') snapshot.tasks.push(taskFor(trackId, 'completed'));
      });
      revision = updated.document.revision;
    }
    const before = await current.repository.readSnapshot(current.doc.id);
    await expect(current.service.preview(current.doc.id, revision, options, 0)).rejects.toThrow('revision_conflict');
    await expect(current.service.apply(current.doc.id, revision, options)).rejects.toThrow('revision_conflict');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it('allows only one winner for simultaneous apply attempts', async () => {
    const current = await fixture();
    const outcomes = await Promise.allSettled([
      current.service.apply(current.doc.id, 1, options),
      current.service.apply(current.doc.id, 1, options),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'revision_conflict' } });
    const stored = await current.repository.readSnapshot(current.doc.id);
    expect(stored.document.revision).toBe(2);
    expect(stored.document.translationTracks).toHaveLength(1);
    expect(stored.document.cues).toHaveLength(2);
  });
});

describe('clearing a selected translation track', () => {
  it('removes only the requested track and its terminal tasks, preserving source, other tracks and original bytes', async () => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const removedId = applied.translationTracks[0].id;
    const otherId = randomUUID();
    const before = await current.repository.transact(current.doc.id, applied.revision, snapshot => {
      snapshot.document.translationTracks.push({ id: otherId, revision: 1, language: 'en', origin: 'human', entries: {
        [snapshot.document.cues[0].id]: { sourceRevision: snapshot.document.cues[0].sourceRevision, sourceHash: sourceDigest(snapshot.document.cues[0]), text: text('OTHER_TRACK'), origin: 'human', reviewStatus: 'reviewed' },
      } });
      snapshot.tasks.push(...(['completed', 'failed', 'cancelled'] as const).map(status => taskFor(removedId, status)), taskFor(otherId, 'completed'));
    });
    const removed = await current.service.removeTrack(current.doc.id, before.document.revision, removedId);
    const after = await new DocumentRepository(current.directory).readSnapshot(current.doc.id);
    expect(after.document).toEqual(removed);
    expect(after.document.revision).toBe(before.document.revision + 1);
    expect(after.document.translationTracks).toEqual(before.document.translationTracks.filter(track => track.id === otherId));
    expect(after.tasks).toEqual(before.tasks.filter(task => task.trackId === otherId));
    expect(after.document.cues).toEqual(before.document.cues);
    expect(after.document.preservation).toEqual(before.document.preservation);
    expect(after.document.bilingualImport).toEqual(before.document.bilingualImport);
    expect(sourceBytes(after.document).toString('utf8')).toBe(original);
    await expect(current.repository.transact(current.doc.id, before.document.revision, snapshot => {
      snapshot.document.translationTracks.push(before.document.translationTracks[0]);
    })).rejects.toThrow('revision_conflict');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(after);
  });

  it.each(['queued', 'running', 'interrupted', 'needs_configuration'] as const)('refuses clearing a track with a %s task', async status => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const trackId = applied.translationTracks[0].id;
    const before = await current.repository.transact(current.doc.id, applied.revision, snapshot => {
      snapshot.tasks.push(taskFor(trackId, status));
    });
    await expect(current.service.removeTrack(current.doc.id, before.document.revision, trackId)).rejects.toThrow('revision_conflict');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it.each(['queued', 'running'] as const)('refuses clearing another track while a %s task owns the document revision', async status => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const otherId = randomUUID();
    const before = await current.repository.transact(current.doc.id, applied.revision, snapshot => {
      snapshot.document.translationTracks.push({ id: otherId, revision: 1, language: 'en', entries: {} });
      snapshot.tasks.push(taskFor(otherId, status));
    });
    await expect(current.service.removeTrack(current.doc.id, before.document.revision, applied.translationTracks[0].id)).rejects.toThrow('revision_conflict');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it('lets an in-flight translation complete after clearing another track is rejected', async () => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const importedTrack = applied.translationTracks[0];
    const entered = deferred<ModelRuntimeTextRequest>();
    const release = deferred<ModelRuntimeTextResult>();
    const service = new TranslationService(current.repository, request => { entered.resolve(request); return release.promise; });
    translations.push(service);
    const plan = await service.plan(9, applied.id, applied.revision, { ...config, maxBatchCues: 2 });
    const started = await service.start(9, applied.id, applied.revision, plan.planId, 'synthetic-memory-only');
    const request = await entered.promise;
    try {
      const running = await current.repository.readSnapshot(applied.id);
      expect(running.tasks[0].status).toBe('running');
      await expect(current.service.removeTrack(applied.id, running.document.revision, importedTrack.id)).rejects.toThrow('revision_conflict');
      expect(await current.repository.readSnapshot(applied.id)).toEqual(running);
    } finally { release.resolve(result(request)); }
    await service.settled(started.taskId);
    const final = await current.repository.readSnapshot(applied.id);
    expect(final.tasks[0]).toMatchObject({ status: 'completed', completedBatchIds: [expect.any(String)] });
    expect(final.document.translationTracks).toHaveLength(2);
    expect(final.document.translationTracks.find(track => track.id === importedTrack.id)).toEqual(importedTrack);
    expect(Object.keys(final.document.translationTracks.find(track => track.id === final.tasks[0].trackId)!.entries)).toEqual(applied.cues.map(cue => cue.id));
    expect(final.document.cues).toEqual(applied.cues);
    expect(sourceBytes(final.document).toString('utf8')).toBe(original);
  });

  it('leaves the selected track untouched on missing ID, stale revision or owner revocation', async () => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const before = await current.repository.readSnapshot(current.doc.id);
    await expect(current.service.removeTrack(current.doc.id, applied.revision, randomUUID())).rejects.toThrow('invalid_input');
    await expect(current.service.removeTrack(current.doc.id, 1, applied.translationTracks[0].id)).rejects.toThrow('revision_conflict');
    await expect(current.service.removeTrack(current.doc.id, applied.revision, applied.translationTracks[0].id, () => { throw new StudioError('access_denied'); })).rejects.toThrow('access_denied');
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it('translates the interpreted source without sending the imported target after clearing it', async () => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const cleared = await current.service.removeTrack(current.doc.id, applied.revision, applied.translationTracks[0].id);
    const requests: ModelRuntimeTextRequest[] = [];
    const service = new TranslationService(current.repository, async request => { requests.push(request); return result(request); });
    translations.push(service);
    const plan = await service.plan(9, cleared.id, cleared.revision, config);
    const started = await service.start(9, cleared.id, cleared.revision, plan.planId, 'synthetic-memory-only');
    await service.settled(started.taskId);
    const final = await current.repository.readSnapshot(cleared.id);
    expect(final.tasks[0].status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests.flatMap(request => JSON.parse(request.messages[1].content).items.map((item: { text: string }) => item.text)))
      .toEqual(cleared.cues.map(cue => cue.source.plain));
    for (const request of requests) expect(serializeTranslationRequest(request)).not.toMatch(/IMPORTED_TARGET_[AB]|\[00:|bilingual\.lrc/);
    const track = final.document.translationTracks[0];
    for (const cue of cleared.cues) expect(track.entries[cue.id]).toMatchObject({ sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), origin: 'ai', reviewStatus: 'unreviewed' });
    expect(final.document.cues).toEqual(cleared.cues);
    expect(final.document.preservation).toEqual(cleared.preservation);
    expect(sourceBytes(final.document).toString('utf8')).toBe(original);
  });

  it('does not resurrect a cleared track when an already cancelled task returns late', async () => {
    const current = await fixture();
    const applied = await current.service.apply(current.doc.id, 1, options);
    const cleared = await current.service.removeTrack(current.doc.id, applied.revision, applied.translationTracks[0].id);
    const entered = deferred<ModelRuntimeTextRequest>();
    const release = deferred<ModelRuntimeTextResult>();
    const service = new TranslationService(current.repository, request => { entered.resolve(request); return release.promise; });
    translations.push(service);
    const plan = await service.plan(9, cleared.id, cleared.revision, config);
    const started = await service.start(9, cleared.id, cleared.revision, plan.planId, 'synthetic-memory-only');
    const request = await entered.promise;
    let expected: SubtitleDocument | undefined;
    try {
      const running = await current.repository.readSnapshot(cleared.id);
      const cancelled = await current.repository.transact(cleared.id, running.document.revision, snapshot => {
        snapshot.tasks[0].status = 'cancelled'; snapshot.tasks[0].generation++;
      });
      expected = await current.service.removeTrack(cleared.id, cancelled.document.revision, cancelled.tasks[0].trackId);
    } finally { release.resolve(result(request)); }
    await service.settled(started.taskId);
    const final = await current.repository.readSnapshot(cleared.id);
    expect(final.document).toEqual(expected);
    expect(final.document.translationTracks).toEqual([]);
    expect(final.tasks).toEqual([]);
    expect(sourceBytes(final.document).toString('utf8')).toBe(original);
  });
});
