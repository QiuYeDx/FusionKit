import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportOptions, ExportPlanSummary } from '../../src/subtitle-studio/export-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { ExportService } from '../../electron/main/subtitle-studio/export-service';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';

const parse = (text: string, format: 'srt' | 'lrc' = 'lrc') => importSubtitleText(text, { format, displayName: `synthetic-integration.${format}`, encoding: 'utf-8', digest: 'b'.repeat(64) }, randomUUID);
const config: TranslationConfig = { model: { profileId: 'synthetic-export', modelKey: 'fixture-chat', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'lrc', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'next-start', finalDurationMs: 1750 }, ...overrides });
const accepted = (plan: ExportPlanSummary) => plan.issues.filter(issue => issue.confirmation).map(issue => issue.code);
const items = (request: ModelRuntimeTextRequest): { id: string; text: string }[] => JSON.parse(request.messages[1].content).items;
const success = (request: ModelRuntimeTextRequest, prefix = 'translated'): ModelRuntimeTextResult => ({ apiFormat: 'chat_completions', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 }, content: JSON.stringify({ items: items(request).map(item => ({ id: item.id, text: `${prefix} ${item.text}` })) }) });
const resources: { root: string; translations: TranslationService[]; exports: ExportService[]; release: (() => void)[] }[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-export-translation-'));
  const resource = { root, translations: [] as TranslationService[], exports: [] as ExportService[], release: [] as (() => void)[] };
  resources.push(resource);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const doc = parse('[offset:+125]\n[00:01]first\n[00:02]\n[00:03] \t\n[00:04]second');
  await repository.create(doc);
  const send = vi.fn(async (request: ModelRuntimeTextRequest) => success(request));
  const translation = new TranslationService(repository, send, new TranslationScheduler());
  resource.translations.push(translation);
  const planned = await translation.plan(7, doc.id, doc.revision, config);
  expect(planned.batchCount).toBe(2);
  const started = await translation.start(7, doc.id, doc.revision, planned.planId, 'synthetic-only-key');
  await translation.settled(started.taskId);
  const completed = await repository.readSnapshot(doc.id);
  expect(completed.tasks[0]).toMatchObject({ status: 'completed', completedBatchIds: ['b1', 'b2'], attempts: 2 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([request]) => items(request).map(item => item.text))).toEqual([['first'], ['second']]);
  expect(Object.keys(completed.document.translationTracks[0].entries)).toEqual([doc.cues[0].id, doc.cues[3].id]);
  await translation.dispose();
  return { resource, root, repository, doc, send, completed, trackId: completed.document.translationTracks[0].id };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const current of resources.splice(0)) {
    current.release.forEach(release => release());
    for (const service of current.translations) await service.dispose();
    current.exports.forEach(service => service.dispose());
    await rm(current.root, { recursive: true, force: true });
  }
});

describe('translation to persisted local exports', () => {
  it('restarts after two real service batches and exports all mode/format/order combinations without requests or state changes', async () => {
    const current = await fixture();
    const repository = new DocumentRepository(path.join(current.root, 'documents'));
    const translation = new TranslationService(repository, current.send, new TranslationScheduler());
    const exporter = new ExportService(repository);
    current.resource.translations.push(translation); current.resource.exports.push(exporter);
    await translation.initialize();
    const before = await repository.readSnapshot(current.doc.id);
    expect(before).toEqual(current.completed);
    const documentFiles = new Map<string, Buffer>();
    const documentDirectory = path.join(current.root, 'documents', current.doc.id);
    for (const name of await readdir(documentDirectory)) documentFiles.set(name, await readFile(path.join(documentDirectory, name)));
    for (const mode of ['source', 'target', 'bilingual'] as const) for (const format of ['srt', 'lrc'] as const) for (const order of ['source-first', 'target-first'] as const) {
      const request = options({ mode, format, order, trackId: current.trackId, bom: true, encoding: format === 'srt' ? 'utf-16le' : 'utf-8', newline: 'crlf' });
      const plan = await exporter.plan(7, current.doc.id, before.document.revision, request);
      expect(plan).toMatchObject({ revision: before.document.revision, missingCount: 0, staleCount: 0, partial: false, cueCount: 4 });
      expect(plan.planId).toBeTypeOf('string');
      const destination = path.join(current.root, `${mode}-${format}-${order}.${format}`);
      const result = await exporter.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), destination);
      expect(result).toMatchObject({ revision: before.document.revision, mode, incomplete: 'block', partial: false });
      const parsed = parse(iconv.decode(await readFile(destination), request.encoding), format);
      const expected: { text: string; start: number; end: number | null }[] = [];
      for (const [index, cue] of before.document.cues.entries()) {
        let texts = [cue.source.plain];
        const target = before.document.translationTracks[0].entries[cue.id]?.text.plain;
        if (mode === 'target' && target !== undefined) texts = [target];
        if (mode === 'bilingual' && target !== undefined) texts = order === 'source-first' ? [cue.source.plain, target] : [target, cue.source.plain];
        if (format === 'srt') texts = [texts.filter(text => text.trim()).join('\n')];
        for (const text of texts) expected.push({ text, start: cue.timing.startMs, end: format === 'srt' ? before.document.cues[index + 1]?.timing.startMs ?? cue.timing.startMs + 1750 : null });
      }
      expect(parsed.cues.map(cue => ({ text: cue.source.plain, start: cue.timing.startMs, end: cue.timing.endMs }))).toEqual(expected);
      expect(current.send).toHaveBeenCalledTimes(2);
      expect(await repository.readSnapshot(current.doc.id)).toEqual(before);
    }
    expect((await readdir(documentDirectory)).sort()).toEqual([...documentFiles.keys()].sort());
    for (const [name, content] of documentFiles) expect(await readFile(path.join(documentDirectory, name))).toEqual(content);
  });

  it('publishes the frozen earlier revision while a new translation commits in the repository queue', async () => {
    const current = await fixture();
    const repository = new DocumentRepository(path.join(current.root, 'documents'));
    const exporter = new ExportService(repository); current.resource.exports.push(exporter);
    const frozen = await exporter.plan(7, current.doc.id, current.completed.document.revision, options({ mode: 'bilingual', format: 'srt', trackId: current.trackId }));
    const entered = deferred<ModelRuntimeTextRequest>(); const response = deferred<ModelRuntimeTextResult>();
    let newCalls = 0;
    const translation = new TranslationService(repository, request => {
      newCalls++;
      if (newCalls === 1) { entered.resolve(request); return response.promise; }
      return Promise.resolve(success(request, 'new generation'));
    }, new TranslationScheduler());
    current.resource.translations.push(translation);
    const plan = await translation.plan(8, current.doc.id, current.completed.document.revision, config);
    const task = await translation.start(8, current.doc.id, plan.revision, plan.planId, 'another-synthetic-key');
    const request = await entered.promise;
    current.resource.release.push(() => response.resolve(success(request, 'new generation')));
    const latest = await repository.read(current.doc.id);
    const releaseGate = deferred<void>(); const enteredGate = deferred<void>();
    current.resource.release.push(() => releaseGate.resolve());
    const gate = repository.withDocument(latest.id, latest.revision, async () => { enteredGate.resolve(); await releaseGate.promise; });
    await enteredGate.promise;
    const commitQueued = deferred<void>();
    const transact = repository.transact.bind(repository);
    vi.spyOn(repository, 'transact').mockImplementation((...args) => { const operation = transact(...args); commitQueued.resolve(); return operation; });
    response.resolve(success(request, 'new generation')); await commitQueued.promise;
    const publishQueued = deferred<void>();
    const withExisting = repository.withExistingDocument.bind(repository);
    vi.spyOn(repository, 'withExistingDocument').mockImplementation((...args) => { const operation = withExisting(...args); publishQueued.resolve(); return operation; });
    const destination = path.join(current.root, 'frozen-during-new-translation.srt');
    const publishing = exporter.publish(7, current.doc.id, frozen.revision, frozen.planId!, accepted(frozen), destination);
    await publishQueued.promise;
    releaseGate.resolve(); await gate;
    const published = await publishing; await translation.settled(task.taskId);
    const final = await repository.readSnapshot(current.doc.id);
    expect(published.revision).toBe(current.completed.document.revision);
    expect(final.document.revision).toBeGreaterThan(published.revision);
    expect(final.tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    expect(final.document.translationTracks[0]).toEqual(current.completed.document.translationTracks[0]);
    expect(Object.values(final.document.translationTracks[1].entries).map(entry => entry.text.plain)).toEqual(['new generation first', 'new generation second']);
    expect(parse(await readFile(destination, 'utf8'), 'srt').cues.map(cue => cue.source.plain)).toEqual(['first\ntranslated first', '', '', 'second\ntranslated second']);
    expect(current.send).toHaveBeenCalledTimes(2); expect(newCalls).toBe(2);
    expect(final.document.cues).toEqual(current.doc.cues);
    expect((await readdir(current.root)).some(name => /^\.subtitle-studio-.*\.tmp$/.test(name))).toBe(false);
  });
});
