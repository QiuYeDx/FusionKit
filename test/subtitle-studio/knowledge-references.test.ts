import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { executionRequestDigest, recordBaseDigest, type ExecutionRecord } from '../../src/subtitle-studio/execution-record-contract';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { buildFrozenKnowledgeSnapshot, knowledgeResourceReferences } from '../../src/translation-knowledge/snapshot-contract';
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas';
import { DocumentRepository, KNOWLEDGE_REFERENCE_SCAN_LIMITS } from '../../electron/main/subtitle-studio/document-repository';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { buildTranslationRequest, planTranslation, serializeTranslationRequest } from '../../electron/main/subtitle-studio/translation-planner';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const createdAt = '2026-09-14T00:00:00.000Z';

async function fixture(withKnowledge = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-knowledge-references-')); roots.push(root);
  const directory = path.join(root, 'documents'), repo = new DocumentRepository(directory);
  const raw = '[00:01.00]Council\n';
  const doc = importSubtitleText(raw, { format: 'lrc', displayName: 'council.lrc', encoding: 'utf-8', digest: hash(raw) }, randomUUID);
  const plan = planTranslation(doc, { model: { profileId: 'profile', modelKey: 'model', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
    language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20 });
  const collectionId = randomUUID(), sourceId = randomUUID();
  const data: KnowledgePackage = { format: 'fusionkit.translation-knowledge', schemaVersion: 1,
    package: { id: randomUUID(), revision: 1, name: 'Test', description: '', purpose: 'backup', createdAt, generator: { name: 'test' } },
    subjects: [], collections: [{ id: collectionId, revision: 1, name: 'Collection', archived: false, description: '', aboutSubjectIds: [] }],
    sources: [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Source', excerpt: 'Private knowledge evidence' }],
    entries: [{ id: randomUUID(), revision: 1, kind: 'term', title: 'Council', collectionId, aboutSubjectIds: [], state: 'candidate', evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
      scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } },
      payload: { source: 'Council', target: '议会', aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'preferred' } }],
    styles: [], recipes: [], preferenceTemplates: [],
  };
  const knowledge = buildFrozenKnowledgeSnapshot({ generation: 1, data, approvals: {}, imports: [] }, {
    version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [collectionId], bindings: [], confirmations: [], disabledEntryIds: [],
  }, [], Object.fromEntries(plan.batches.map(batch => [batch.id, { policyVersion: 'test-knowledge/1', environmentDigest: hash('environment'), instructions: '', context: '', items: [], issues: [] }])));
  const record: ExecutionRecord = { version: 1, id: randomUUID(), documentId: doc.id, taskId: randomUUID(), trackId: randomUUID(), createdAt,
    sourceDigest: hash('source'), configDigest: sha256Canonical(plan.config), policyVersion: withKnowledge ? 'studio-knowledge-translation/1;request-body/1' : 'studio-translation/2;request-body/1', plan,
    baseRequests: Object.fromEntries(plan.batches.map(batch => {
      const runtime = buildTranslationRequest(plan.config, batch);
      const { signal: _signal, model: runtimeModel, ...settings } = runtime, { apiKey: _apiKey, ...model } = runtimeModel;
      const frozen = { version: 1 as const, batchId: batch.id, createdAt, request: JSON.parse(JSON.stringify({ ...settings, model })), httpBody: serializeTranslationRequest(runtime) };
      return [batch.id, { ...frozen, digest: executionRequestDigest(frozen) }];
    })), requests: {}, ...(withKnowledge ? { knowledge } : {}),
  };
  await repo.create(doc);
  const saved = await repo.transact(doc.id, 1, value => {
    value.executionRecords = { [record.id]: record };
    value.document.translationTracks.push({ id: record.trackId, revision: 1, language: 'zh-Hans', entries: {}, executionRef: { version: 1, id: record.id, digest: recordBaseDigest(record) } });
    value.tasks.push({ id: record.taskId, generation: 1, trackId: record.trackId, status: 'failed', completedBatchIds: [], uncertainBatchIds: [], attempts: 0 });
  });
  return { root, directory, repo, doc, record, knowledge, saved, folder: path.join(directory, doc.id) };
}
async function generation(folder: string, pointerName = 'current.json') {
  const pointerPath = path.join(folder, pointerName), pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  const file = path.join(folder, `${pointer.generation}.json`);
  return { pointer, pointerPath, file, value: JSON.parse(await readFile(file, 'utf8')) };
}
async function alter(folder: string, change: (value: any) => void, pointerName = 'current.json') {
  const value = await generation(folder, pointerName); change(value.value);
  const text = JSON.stringify(value.value); value.pointer.digest = hash(text);
  await writeFile(value.file, text); await writeFile(value.pointerPath, JSON.stringify(value.pointer));
}

describe('conservative knowledge reference inventory', () => {
  it('reads a missing root without creating it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-knowledge-references-')); roots.push(root);
    const directory = path.join(root, 'missing');
    expect(await new DocumentRepository(directory).inspectKnowledgeReferences()).toMatchObject({ references: [], unknownDocuments: 0 });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('indexes complete entity versions, deduplicates current/previous, and derives status from current', async () => {
    const f = await fixture();
    const active = await f.repo.inspectKnowledgeReferences();
    expect(active).toMatchObject({ unknownDocuments: 0, references: [{ recordId: f.record.id, status: 'active' }] });
    expect(active.references[0].resources).toEqual(expect.arrayContaining(knowledgeResourceReferences(f.knowledge)));
    await f.repo.removeTask(f.doc.id, f.saved.document.revision, f.record.taskId);
    const retained = await f.repo.inspectKnowledgeReferences();
    expect(retained).toMatchObject({ unknownDocuments: 0, references: [{ recordId: f.record.id, status: 'retained' }] });
    expect(retained.references).toHaveLength(1);
    expect(await new DocumentRepository(f.directory).inspectKnowledgeReferences()).toEqual(retained);
  });

  it('finds a previous-only record after track deletion and does not clean it during inspection', async () => {
    const f = await fixture();
    await new BilingualService(f.repo).removeTrack(f.doc.id, f.saved.document.revision, f.record.trackId);
    const before = new Map(await Promise.all((await readdir(f.folder)).map(async name => [name, await readFile(path.join(f.folder, name))] as const)));
    const inventory = await f.repo.inspectKnowledgeReferences();
    expect(inventory).toMatchObject({ unknownDocuments: 0, references: [{ recordId: f.record.id, status: 'retained' }] });
    expect((await f.repo.readSnapshot(f.doc.id)).executionRecords).toEqual({});
    for (const [name, bytes] of before) expect(await readFile(path.join(f.folder, name))).toEqual(bytes);
    const current = await f.repo.read(f.doc.id);
    await f.repo.transact(f.doc.id, current.revision, value => { value.document.origin.displayName = 'renamed.lrc'; });
    expect(await f.repo.inspectKnowledgeReferences()).toMatchObject({ references: [], unknownDocuments: 0 });
  });

  it.each(['current.json', 'previous.json'])('does not hide a broken %s behind the other valid pointer', async pointer => {
    const f = await fixture();
    await f.repo.transact(f.doc.id, f.saved.document.revision, value => { value.document.origin.displayName = 'later.lrc'; });
    await writeFile(path.join(f.folder, pointer), '{broken');
    const inventory = await f.repo.inspectKnowledgeReferences();
    expect(inventory.unknownDocuments).toBeGreaterThan(0); expect(inventory.references).toHaveLength(1);
    expect((await f.repo.read(f.doc.id)).cues).toEqual(f.doc.cues);
  });

  it.each(['missing', 'unknown_version', 'bad_record', 'bad_knowledge', 'bad_ref', 'unreferenced_unknown'] as const)('treats %s record data as unknown without rolling back or rewriting the document', async mode => {
    const f = await fixture();
    await alter(f.folder, value => {
      if (mode === 'missing') delete value.executionRecords;
      if (mode === 'unknown_version') value.executionRecords[f.record.id].version = 99;
      if (mode === 'bad_record') value.executionRecords[f.record.id] = { version: 1, invalid: true };
      if (mode === 'bad_knowledge') value.executionRecords[f.record.id].knowledge.digest = hash('changed');
      if (mode === 'bad_ref') value.document.translationTracks[0].executionRef.digest = hash('wrong');
      if (mode === 'unreferenced_unknown') value.executionRecords[randomUUID()] = { version: 99 };
    });
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
    expect((await f.repo.read(f.doc.id)).revision).toBe(f.saved.document.revision);
  });

  it('reports tombstoned directory remnants until explicit cleanup and never triggers cleanup itself', async () => {
    const f = await fixture();
    const failing = new DocumentRepository(f.directory, { fault: stage => { if (stage === 'delete-cleanup') throw new Error('locked'); } });
    expect(await failing.delete(f.doc.id, f.saved.document.revision)).toEqual({ cleanupPending: true });
    const inventory = await f.repo.inspectKnowledgeReferences();
    expect(inventory.unknownDocuments).toBeGreaterThan(0); expect(inventory.references).toHaveLength(1);
    expect((await lstat(f.folder)).isDirectory()).toBe(true);
    await f.repo.retryCleanup(f.doc.id);
    expect(await f.repo.inspectKnowledgeReferences()).toMatchObject({ references: [], unknownDocuments: 0 });
    expect((await lstat(path.join(f.directory, '.deleted', `${f.doc.id}.json`))).isFile()).toBe(true);
  });

  it.each(['root_file', 'document_file', 'orphan_generation', 'temporary', 'bad_tombstone', 'wrong_tombstone_identity', 'missing_generation'] as const)('blocks incomplete inspection for %s', async mode => {
    const f = await fixture();
    if (mode === 'root_file') await writeFile(path.join(f.directory, 'unknown.json'), '{}');
    if (mode === 'document_file') await writeFile(path.join(f.folder, 'unknown.json'), '{}');
    if (mode === 'orphan_generation') await writeFile(path.join(f.folder, `${randomUUID()}.json`), JSON.stringify(f.saved));
    if (mode === 'temporary') await writeFile(path.join(f.folder, 'leftover.tmp'), 'partial');
    if (mode === 'bad_tombstone' || mode === 'wrong_tombstone_identity') {
      await mkdir(path.join(f.directory, '.deleted'));
      await writeFile(path.join(f.directory, '.deleted', `${randomUUID()}.json`), mode === 'bad_tombstone' ? '{broken' : JSON.stringify({ schemaVersion: 1, documentId: randomUUID(), revision: 1 }));
    }
    if (mode === 'missing_generation') await rm((await generation(f.folder)).file);
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
  });

  it('does not follow document, tombstone or generation symlinks', async () => {
    const f = await fixture();
    const linkedId = randomUUID(); await symlink(f.folder, path.join(f.directory, linkedId), 'dir');
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
    await rm(path.join(f.directory, linkedId));
    const current = await generation(f.folder); await rm(current.file); await symlink(path.join(f.root, 'outside'), current.file);
    await writeFile(path.join(f.root, 'outside'), JSON.stringify(current.value));
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
    await rm(current.file); await writeFile(current.file, JSON.stringify(current.value));
    await symlink(f.root, path.join(f.directory, '.deleted'), 'dir');
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
  });

  it('returns incomplete for oversized generations and bounds the number of inspected documents', async () => {
    const f = await fixture();
    const current = await generation(f.folder), handle = await open(current.file, 'w');
    try { await handle.truncate(128 * 1024 * 1024 + 1); } finally { await handle.close(); }
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
    await rm(f.folder, { recursive: true });
    await Promise.all(Array.from({ length: KNOWLEDGE_REFERENCE_SCAN_LIMITS.documents + 1 }, () => mkdir(path.join(f.directory, randomUUID()))));
    const inventory = await f.repo.inspectKnowledgeReferences();
    expect(inventory.unknownDocuments).toBe(KNOWLEDGE_REFERENCE_SCAN_LIMITS.documents + 1);
    expect(inventory.references).toEqual([]);
  });

  it('recognizes valid ordinary execution records as containing no knowledge', async () => {
    const f = await fixture(false);
    expect(await f.repo.inspectKnowledgeReferences()).toMatchObject({ references: [], unknownDocuments: 0 });
  });

  it('does not assume an unknown ordinary policy has no knowledge references', async () => {
    const f = await fixture(false);
    await alter(f.folder, value => {
      value.executionRecords[f.record.id].policyVersion = 'future-policy/99';
      value.document.translationTracks[0].executionRef.digest = recordBaseDigest(value.executionRecords[f.record.id]);
    });
    expect((await f.repo.inspectKnowledgeReferences()).unknownDocuments).toBeGreaterThan(0);
  });
});
