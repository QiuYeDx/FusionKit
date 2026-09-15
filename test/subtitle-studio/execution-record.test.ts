import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { validateSnapshot, type DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import { executionRequestDigest, recordBaseDigest, validateExecutionRecord, type ExecutionRecord, type FrozenExecutionRequest } from '../../src/subtitle-studio/execution-record-contract';
import { buildTranslationRequest, planTranslation, serializeTranslationRequest } from '../../electron/main/subtitle-studio/translation-planner';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { readExecutionRecordPage } from '../../electron/main/subtitle-studio/execution-view';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const createdAt = '2026-09-14T00:00:00.000Z';

function fixture(apiFormat: 'chat_completions' | 'responses' = 'chat_completions') {
  const raw = '1\n00:00:01,000 --> 00:00:02,000\n<b>Hello <i>world</i></b>\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye\n';
  const doc = importSubtitleText(raw, { format: 'srt', displayName: 'record.srt', encoding: 'utf-8', digest: sha(raw) }, randomUUID);
  const config = { model: { profileId: 'profile', modelKey: 'model', endpoint: 'https://example.com/v1', apiFormat }, language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
  const plan = planTranslation(doc, config);
  const record: ExecutionRecord = { version: 1, id: randomUUID(), documentId: doc.id, taskId: randomUUID(), trackId: randomUUID(), createdAt,
    sourceDigest: sha('source'), configDigest: sha256Canonical(plan.config), policyVersion: 'studio-translation/2;request-body/1', plan, baseRequests: {}, requests: {} };
  return { doc, record };
}
async function prepared(apiFormat: 'chat_completions' | 'responses' = 'chat_completions') {
  const value = fixture(apiFormat);
  for (const [index, batch] of value.record.plan.batches.entries()) value.record.baseRequests[batch.id] = requestFor(value.record, index);
  return value;
}
function requestFor(record: ExecutionRecord, index = 0, previous: string[] = []): FrozenExecutionRequest {
  const batch = record.plan.batches[index];
  const runtime = buildTranslationRequest(record.plan.config, batch, previous, 'must-not-persist');
  const { signal: _signal, model: runtimeModel, ...settings } = runtime;
  const { apiKey: _apiKey, ...model } = runtimeModel;
  const request = JSON.parse(JSON.stringify({ ...settings, model }));
  const base = { version: 1 as const, batchId: batch.id, createdAt, request, httpBody: serializeTranslationRequest(runtime) };
  return { ...base, digest: executionRequestDigest(base) };
}
function snapshotFor(doc: ReturnType<typeof fixture>['doc'], record: ExecutionRecord): DocumentSnapshot {
  const document = structuredClone(doc);
  document.translationTracks.push({ id: record.trackId, revision: 1, language: 'zh-Hans', origin: 'ai', executionRef: { version: 1, id: record.id, digest: recordBaseDigest(record) }, entries: {} });
  return { schemaVersion: 1, document, tasks: [{ id: record.taskId, trackId: record.trackId, generation: 1, status: 'failed', attempts: 0, completedBatchIds: [], uncertainBatchIds: [] }], executionRecords: { [record.id]: record } };
}

describe('private translation execution records', () => {
  it('refuses a saved body that disagrees with the frozen source even when its request checksum was recomputed', async () => {
    const { doc, record } = await prepared();
    const saved = requestFor(record), payload = JSON.parse(saved.request.messages[1].content);
    payload.items[0].text = 'Different source';
    saved.request.messages[1].content = JSON.stringify(payload);
    saved.httpBody = serializeTranslationRequest(saved.request);
    saved.digest = executionRequestDigest(saved);
    record.requests[saved.batchId] = saved;
    expect(validateExecutionRecord(record)).toEqual(record);
    expect(readExecutionRecordPage(snapshotFor(doc, record), record.trackId, 0)).toEqual({ state: 'unavailable' });
  });
  it.each(['chat_completions', 'responses'] as const)('returns one readable batch and the exact saved %s body, without reconstructing missing requests', async format => {
    const { doc, record } = await prepared(format);
    const saved = requestFor(record, 1, ['前一批机器译文']);
    record.requests[saved.batchId] = saved;
    const snapshot = snapshotFor(doc, record);
    expect(readExecutionRecordPage(snapshot, record.trackId, 0)).toMatchObject({ state: 'available', batch: { request: null } });
    const page = readExecutionRecordPage(snapshot, record.trackId, 1);
    expect(page).toMatchObject({ state: 'available', batchOffset: 1, totalBatches: 2, batch: {
      items: [{ id: 'u2', text: 'Goodbye' }], request: { httpBody: saved.httpBody, priorModelTranslations: ['前一批机器译文'] },
    } });
    expect(JSON.stringify(page)).not.toContain('must-not-persist');
    expect(() => readExecutionRecordPage(snapshot, record.trackId, 2)).toThrow('invalid_input');
    delete snapshot.document.translationTracks[0].executionRef;
    expect(readExecutionRecordPage(snapshot, record.trackId, 0)).toEqual({ state: 'legacy' });
  });

  it.each(['chat_completions', 'responses'] as const)('round-trips complete plans and %s requests while keeping the base reference stable', async apiFormat => {
    const { doc, record } = await prepared(apiFormat);
    const base = recordBaseDigest(record);
    expect(record.plan.batches[0].units[0].protectedMarks).toEqual([{ id: 1, mark: 'b', parentId: null }, { id: 2, mark: 'i', parentId: 1 }]);
    for (const [index, batch] of record.plan.batches.entries()) record.requests[batch.id] = requestFor(record, index, index ? ['已提交的上一句'] : []);
    expect(recordBaseDigest(record)).toBe(base);
    expect(validateExecutionRecord(JSON.parse(JSON.stringify(record)), { ref: { version: 1, id: record.id, digest: base }, documentId: doc.id, taskId: record.taskId, trackId: record.trackId })).toEqual(record);
    expect(JSON.stringify(record)).not.toContain('must-not-persist');
    expect(validateSnapshot(snapshotFor(doc, record)).executionRecords?.[record.id]).toEqual(record);
    const changed = structuredClone(record); changed.plan.config.instructions = 'Different';
    expect(recordBaseDigest(changed)).not.toBe(base);
  });

  it('binds the exact HTTP body bytes and request settings independently from the base digest', async () => {
    const { record } = await prepared();
    const request = requestFor(record);
    record.requests[request.batchId] = request;
    const base = recordBaseDigest(record);
    request.httpBody += '\n';
    expect(() => validateExecutionRecord(record)).toThrow('invalid_input');
    request.digest = executionRequestDigest(request);
    expect(validateExecutionRecord(record)).toEqual(record);
    expect(recordBaseDigest(record)).toBe(base);
    request.request.timeoutMs = 1;
    expect(() => validateExecutionRecord(record)).toThrow('invalid_input');
  });

  it.each(['record', 'plan', 'model', 'request', 'requestModel', 'body'] as const)('rejects credential fields at the %s boundary', async location => {
    const { doc, record } = await prepared();
    const request = requestFor(record); record.requests[request.batchId] = request;
    const targets = { record, plan: record.plan, model: record.plan.config.model, request: request.request, requestModel: request.request.model };
    if (location === 'body') request.httpBody = JSON.stringify({ ...JSON.parse(request.httpBody), apiKey: 'secret' });
    else Object.assign(targets[location], { apiKey: 'secret' });
    expect(() => validateExecutionRecord(record)).toThrow('invalid_input');
  });

  it('rejects malformed batch membership, markers and request membership', async () => {
    const { record } = await prepared();
    const check = (mutate: (copy: ExecutionRecord) => void) => { const copy = structuredClone(record); mutate(copy); expect(() => validateExecutionRecord(copy)).toThrow('invalid_input'); };
    check(copy => { copy.plan.batches[1].id = copy.plan.batches[0].id; });
    check(copy => { copy.plan.batches[1].units[0].id = copy.plan.batches[0].units[0].id; });
    check(copy => { copy.plan.batches[1].units[0].cueId = copy.plan.batches[0].units[0].cueId; });
    check(copy => { copy.plan.batches[0].units[0].protectedMarks[1].parentId = null; });
    check(copy => { copy.requests.unknown = requestFor(copy); });
    check(copy => { copy.plan.documentId = randomUUID(); });
    check(copy => { copy.configDigest = sha('wrong'); });
  });

  it('keeps missing and semantically mismatched references readable until explicit trace/recovery validation', async () => {
    const { doc, record } = await prepared();
    const snapshot = snapshotFor(doc, record);
    delete snapshot.executionRecords;
    expect(validateSnapshot(snapshot).document.translationTracks[0].executionRef?.id).toBe(record.id);
    expect(() => validateExecutionRecord(undefined)).toThrow('invalid_input');
    snapshot.executionRecords = { [record.id]: { ...record, configDigest: sha('changed') } };
    expect(validateSnapshot(snapshot).executionRecords?.[record.id]).toMatchObject({ configDigest: sha('changed') });
    expect(() => validateExecutionRecord(snapshot.executionRecords![record.id])).toThrow('invalid_input');
    expect(() => validateExecutionRecord(record, { ref: { version: 1, id: record.id, digest: sha('wrong') } })).toThrow('invalid_input');
    expect(() => validateExecutionRecord(record, { taskId: randomUUID() })).toThrow('invalid_input');
  });

  it('enforces the 32 MiB aggregate as UTF-8 bytes before persisting or sending', async () => {
    const { doc, record } = await prepared();
    const request = requestFor(record); record.requests[request.batchId] = request;
    const content = '界'.repeat(6 * 1024 * 1024);
    request.request.messages[1].content = content;
    request.httpBody = JSON.stringify({ model: record.plan.config.model.modelKey, messages: request.request.messages });
    expect(() => validateSnapshot(snapshotFor(doc, record))).toThrow('limit_exceeded');
  });

  it('retains records and public track references when task rows are removed, including after reopening', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-execution-record-')); roots.push(root);
    const repo = new DocumentRepository(root);
    const { doc, record } = await prepared();
    await repo.create(doc);
    const admitted = snapshotFor(doc, record);
    const saved = await repo.transact(doc.id, 1, value => { value.document.translationTracks = admitted.document.translationTracks; value.tasks = admitted.tasks; value.executionRecords = admitted.executionRecords; });
    await repo.removeTask(doc.id, saved.document.revision, record.taskId);
    const reopened = await new DocumentRepository(root).readSnapshot(doc.id);
    expect(reopened.tasks).toEqual([]);
    expect(reopened.executionRecords?.[record.id]).toEqual(record);
    expect((await repo.read(doc.id)).translationTracks[0].executionRef).toEqual(admitted.document.translationTracks[0].executionRef);
    expect(await repo.read(doc.id)).not.toHaveProperty('executionRecords');
  });

  it('rejects new malformed records and credentials at publication and only appends immutable requests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-execution-record-')); roots.push(root);
    const repo = new DocumentRepository(root);
    const { doc, record } = await prepared();
    await repo.create(doc);
    await expect(repo.transact(doc.id, 1, value => { value.executionRecords = { [record.id]: { ...record, apiKey: 'secret' } }; })).rejects.toThrow('invalid_input');
    await expect(repo.transact(doc.id, 1, value => { value.executionRecords = { [record.id]: { ...record, version: 2 } }; })).rejects.toThrow('invalid_input');
    expect((await repo.read(doc.id)).revision).toBe(1);
    const admitted = snapshotFor(doc, record);
    let saved = await repo.transact(doc.id, 1, value => { value.document.translationTracks = admitted.document.translationTracks; value.tasks = admitted.tasks; value.executionRecords = admitted.executionRecords; });
    const first = requestFor(record);
    saved = await repo.transact(doc.id, saved.document.revision, value => {
      const current = validateExecutionRecord(value.executionRecords![record.id]);
      current.requests[first.batchId] = first; value.executionRecords![record.id] = current;
    });
    const mutate = async (change: (value: ExecutionRecord) => void) => repo.transact(doc.id, saved.document.revision, value => {
      const current = validateExecutionRecord(value.executionRecords![record.id]);
      change(current); value.executionRecords![record.id] = current;
    });
    await expect(mutate(current => { current.policyVersion = 'different-policy'; })).rejects.toThrow('invalid_input');
    await expect(mutate(current => { delete current.requests[first.batchId]; })).rejects.toThrow('invalid_input');
    await expect(mutate(current => { current.requests[first.batchId].createdAt = '2026-09-15T00:00:00.000Z'; current.requests[first.batchId].digest = executionRequestDigest(current.requests[first.batchId]); })).rejects.toThrow('invalid_input');
    await expect(repo.transact(doc.id, saved.document.revision, value => { delete value.executionRecords; })).rejects.toThrow('invalid_input');
    expect((await repo.read(doc.id)).revision).toBe(saved.document.revision);
  });

  it.each([false, true])('cleans an AI track record only after its last track reference is removed (shared: %s)', async shared => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-execution-record-')); roots.push(root);
    const repo = new DocumentRepository(root);
    const { doc, record } = await prepared();
    await repo.create(doc);
    const admitted = snapshotFor(doc, record);
    const otherTrackId = randomUUID();
    if (shared) admitted.document.translationTracks.push({ ...structuredClone(admitted.document.translationTracks[0]), id: otherTrackId });
    const saved = await repo.transact(doc.id, 1, value => { value.document.translationTracks = admitted.document.translationTracks; value.tasks = admitted.tasks; value.executionRecords = admitted.executionRecords; });
    await new BilingualService(repo).removeTrack(doc.id, saved.document.revision, record.trackId);
    let reopened = await new DocumentRepository(root).readSnapshot(doc.id);
    expect(reopened.document.cues).toEqual(doc.cues);
    expect(reopened.document.translationTracks.some(track => track.id === record.trackId)).toBe(false);
    expect(reopened.tasks).toEqual([]);
    if (shared) {
      expect(reopened.executionRecords?.[record.id]).toEqual(record);
      await new BilingualService(repo).removeTrack(doc.id, reopened.document.revision, otherTrackId);
      reopened = await new DocumentRepository(root).readSnapshot(doc.id);
    }
    expect(reopened.executionRecords).toEqual({});
    expect(reopened.document.translationTracks).toEqual([]);
  });

  it.each(['missing', 'base_mismatch', 'unknown_version', 'invalid_structure'] as const)('does not fall back to previous document commit for a %s execution record', async failure => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-execution-record-')); roots.push(root);
    const repo = new DocumentRepository(root);
    const { doc, record } = await prepared();
    await repo.create(doc);
    const admitted = snapshotFor(doc, record);
    await repo.transact(doc.id, 1, value => { value.document.translationTracks = admitted.document.translationTracks; value.tasks = admitted.tasks; value.executionRecords = admitted.executionRecords; });
    const directory = path.join(root, doc.id), pointerPath = path.join(directory, 'current.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const generationPath = path.join(directory, `${pointer.generation}.json`);
    const current = JSON.parse(await readFile(generationPath, 'utf8'));
    if (failure === 'missing') delete current.executionRecords;
    else if (failure === 'unknown_version') current.executionRecords[record.id].version = 2;
    else if (failure === 'invalid_structure') current.executionRecords[record.id] = { version: 1, invalid: true };
    else current.executionRecords[record.id].configDigest = sha('incorrect');
    const json = JSON.stringify(current); pointer.digest = sha(json);
    await writeFile(generationPath, json); await writeFile(pointerPath, JSON.stringify(pointer));
    const recovered = await new DocumentRepository(root).readSnapshot(doc.id);
    expect(recovered.document.revision).toBe(2);
    expect(recovered.document.translationTracks[0].executionRef?.id).toBe(record.id);
    expect(() => validateExecutionRecord(recovered.executionRecords?.[record.id], { ref: recovered.document.translationTracks[0].executionRef })).toThrow('invalid_input');
    expect(readExecutionRecordPage(recovered, record.trackId, 0)).toEqual({ state: 'unavailable' });
    const kept = await repo.transact(doc.id, recovered.document.revision, value => { value.document.translationTracks[0].language = 'en'; });
    expect(kept.document.revision).toBe(3);
    expect(kept.executionRecords).toEqual(recovered.executionRecords);
  });
});
