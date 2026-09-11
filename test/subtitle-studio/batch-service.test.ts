import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { batchRequestSchemas } from '../../src/subtitle-studio/batch-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { StudioError } from '../../src/subtitle-studio/domain';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { BatchService } from '../../electron/main/subtitle-studio/batch-service';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';

const config: TranslationConfig = { model: { profileId: 'batch-fixture', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
const options: ExportOptions = { mode: 'source', format: 'lrc', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } };
const success = (request: ModelRuntimeTextRequest): ModelRuntimeTextResult => ({ apiFormat: 'chat_completions', finishReason: 'stop', content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string }) => ({ id: item.id, text: '译文' })) }) });
const roots: string[] = []; const services: TranslationService[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = async request => success(request)) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-batch-')); roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const translation = new TranslationService(repository, send, new TranslationScheduler(1)); services.push(translation);
  const batches = new BatchService(repository, translation);
  const documents = [];
  for (let index = 0; index < 3; index++) {
    const doc = importSubtitleText(`[00:01]Source ${index}\n`, { format: 'lrc', displayName: 'same.lrc', encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
    await repository.create(doc); documents.push(doc);
  }
  await translation.initialize();
  const references = documents.map(doc => ({ documentId: doc.id, revision: doc.revision }));
  const output = path.join(root, 'output'); await mkdir(output);
  return { root, output, repository, translation, batches, documents, references };
}
describe('bounded document batches', () => {
  it('keeps a batch independent of single-file previews and isolates a stale item during admission', async () => {
    const send = vi.fn(async request => success(request));
    const current = await fixture(send);
    const planned = await current.batches.planTranslation(1, { documents: current.references.slice(0, 2), config });
    await current.translation.plan(1, current.documents[2].id, 1, config);
    await current.repository.transact(current.documents[1].id, 1, () => {});
    planned.items.reverse(); // A caller cannot mutate the cached order or selected identities.
    const result = await current.batches.createTranslation(1, planned.batchId, 'private-key');
    expect(result.items[0]).toMatchObject({ documentId: current.documents[0].id, ok: true });
    expect(result.items[1]).toMatchObject({ documentId: current.documents[1].id, ok: false, error: 'revision_conflict' });
    if (!result.items[0].ok) throw new Error('expected admission');
    await current.translation.settled(result.items[0].taskId);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await current.repository.readSnapshot(current.documents[0].id)).tasks[0].status).toBe('completed');
    expect((await current.repository.readSnapshot(current.documents[1].id)).tasks).toEqual([]);
    for (const file of await readdir(path.join(current.root, 'documents', current.documents[0].id))) expect(await readFile(path.join(current.root, 'documents', current.documents[0].id, file), 'utf8')).not.toContain('private-key');
    await expect(current.batches.createTranslation(1, planned.batchId, 'private-key')).rejects.toThrow('access_denied');
  });
  it('persists every admitted task and restores interrupted queued work without sending automatically', async () => {
    const pending = vi.fn((request: ModelRuntimeTextRequest) => new Promise<ModelRuntimeTextResult>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new StudioError('interrupted')), { once: true })));
    const current = await fixture(pending);
    const planned = await current.batches.planTranslation(1, { documents: current.references, config });
    const result = await current.batches.createTranslation(1, planned.batchId, 'secret');
    expect(result.items.every(item => item.ok)).toBe(true);
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
    await current.translation.dispose();
    for (const item of result.items) if (item.ok) await current.translation.settled(item.taskId);
    const send = vi.fn(async request => success(request));
    const restarted = new TranslationService(current.repository, send, new TranslationScheduler(1)); services.push(restarted);
    await restarted.initialize(); expect(send).not.toHaveBeenCalled();
    for (const doc of current.documents) {
      const snapshot = await current.repository.readSnapshot(doc.id);
      expect(snapshot.tasks).toHaveLength(1); expect(snapshot.tasks[0].status).toBe('interrupted');
      const resumed = await restarted.resume(doc.id, snapshot.document.revision, snapshot.tasks[0].id, config.model, 'secret');
      await restarted.settled(resumed.taskId);
      expect((await current.repository.readSnapshot(doc.id)).tasks[0].status).toBe('completed');
    }
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('rejects a different owner, expiry, revocation and simultaneous reuse of one batch', async () => {
    const current = await fixture();
    const planned = await current.batches.planTranslation(1, { documents: current.references, config });
    await expect(current.batches.createTranslation(2, planned.batchId, 'secret')).rejects.toThrow('access_denied');
    const start = current.batches.createTranslation(1, planned.batchId, 'secret');
    await expect(current.batches.createTranslation(1, planned.batchId, 'secret')).rejects.toThrow('revision_conflict');
    const result = await start; for (const item of result.items) if (item.ok) await current.translation.settled(item.taskId);
    const exported = await current.batches.planExport(1, { documents: [{ documentId: current.documents[0].id, revision: (await current.repository.read(current.documents[0].id)).revision }], options });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60000);
    expect(() => current.batches.inspectExport(1, exported.batchId, [])).toThrow('revision_conflict'); vi.restoreAllMocks();
    current.batches.forgetOwner(1);
    await expect(current.batches.export(1, exported.batchId, [], current.output)).rejects.toThrow('access_denied');
    expect(await readdir(current.output)).toEqual([]);
  });
  it('numbers colliding output names without replacing existing files and retains per-item revision failures', async () => {
    const current = await fixture();
    await writeFile(path.join(current.output, 'same.source.lrc'), 'keep prior output');
    const planned = await current.batches.planExport(1, { documents: current.references, options });
    await current.repository.transact(current.documents[1].id, 1, () => {});
    const result = await current.batches.export(1, planned.batchId, [], current.output);
    expect(result.items[0]).toMatchObject({ ok: true, result: { fileName: 'same.source (1).lrc' } });
    expect(result.items[1]).toMatchObject({ ok: false, error: 'revision_conflict' });
    expect(result.items[2]).toMatchObject({ ok: true, result: { fileName: 'same.source (2).lrc' } });
    expect(await readFile(path.join(current.output, 'same.source.lrc'), 'utf8')).toBe('keep prior output');
    expect(await readFile(path.join(current.output, 'same.source (1).lrc'), 'utf8')).toContain('Source 0');
    expect(await readFile(path.join(current.output, 'same.source (2).lrc'), 'utf8')).toContain('Source 2');
    expect((await readdir(current.output)).some(name => name.endsWith('.tmp'))).toBe(false);
    await expect(current.batches.export(1, planned.batchId, [], current.output)).rejects.toThrow('access_denied');
  });
  it('requires loss acceptance per document and preserves original bytes in source downloads', async () => {
    const current = await fixture();
    for (const reference of current.references) { await current.repository.transact(reference.documentId, reference.revision, value => { value.document.cues[0].timing.endMs = 2000; }); reference.revision++; }
    const planned = await current.batches.planExport(1, { documents: current.references, options });
    expect(() => current.batches.inspectExport(1, planned.batchId, [])).toThrow('invalid_input');
    const accepted = planned.items.filter(item => item.ok).map(item => ({ documentId: item.documentId, codes: item.plan.issues.filter(issue => issue.confirmation).map(issue => issue.code) }));
    expect(() => current.batches.inspectExport(1, planned.batchId, [{ documentId: randomUUID(), codes: [] }])).toThrow('invalid_input');
    expect((await current.batches.export(1, planned.batchId, accepted, current.output)).items.every(item => item.ok)).toBe(true);
    const source = await current.batches.exportSources(current.references, current.output);
    expect(source.items.map(item => item.ok && item.fileName)).toEqual(['same.lrc', 'same (1).lrc', 'same (2).lrc']);
    expect(await readFile(path.join(current.output, 'same.lrc'), 'utf8')).toBe(current.documents[0].preservation.rawText);
  });
  it('keeps blocked export items visible while publishing ready siblings', async () => {
    const current = await fixture();
    await current.repository.transact(current.references[0].documentId, 1, value => { value.document.cues[0].timing.endMs = 2000; });
    current.references[0].revision++;
    const planned = await current.batches.planExport(1, { documents: current.references, options: { ...options, format: 'srt' } });
    expect(planned.items[1]).toMatchObject({ ok: true, plan: { issues: expect.arrayContaining([expect.objectContaining({ code: 'missing_end', blocking: true })]) } });
    const result = await current.batches.export(1, planned.batchId, [], current.output);
    expect(result.items[0]).toMatchObject({ ok: true, result: { fileName: 'same.source.srt' } });
    expect(result.items.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: 'unsupported_feature' })]));
    expect(await readdir(current.output)).toEqual(['same.source.srt']);
  });
  it('rejects duplicate documents and batches beyond the admission bound', () => {
    const ref = { documentId: randomUUID(), revision: 1 };
    expect(batchRequestSchemas.planTranslationBatch.safeParse({ documents: [ref, ref], config }).success).toBe(false);
    expect(batchRequestSchemas.exportSources.safeParse({ documents: Array.from({ length: 101 }, () => ({ documentId: randomUUID(), revision: 1 })) }).success).toBe(false);
  });
});
