import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { readSubtitleWithSource } from '../../electron/main/subtitle-studio/input-service';
import { ExportService, publishBytes } from '../../electron/main/subtitle-studio/export-service';
import { BatchService } from '../../electron/main/subtitle-studio/batch-service';
import type { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { SourceLocationService, SOURCE_LOCATION_FILE } from '../../electron/main/subtitle-studio/source-location-service';
import { fileNameSuffixSchema, type ExportOptions, type ExportPlanSummary } from '../../src/subtitle-studio/export-contract';
import { subtitleExportFileName } from '../../src/subtitle-studio/export-filename';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { summarizeDocument } from '../../src/subtitle-studio/ipc-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const raw = '1\n00:00:01,000 --> 00:00:02,000\nOriginal subtitle.\n';
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false,
  newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, ...overrides });
const losses = (plan: ExportPlanSummary) => plan.issues.filter(issue => issue.confirmation).map(issue => issue.code);
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-source-'))); roots.push(root);
  const repositoryRoot = path.join(root, 'documents'), repository = new DocumentRepository(repositoryRoot);
  const imports = async (directory: string, name = 'sample.srt') => {
    const parent = path.join(root, directory); await mkdir(parent, { recursive: true });
    const file = path.join(parent, name); await writeFile(file, raw);
    const { document, sourceLocation } = await readSubtitleWithSource(file, 'utf-8');
    await repository.create(document, undefined, sourceLocation);
    return { document, file, parent, sourceLocation };
  };
  return { root, repositoryRoot, repository, imports, service: new ExportService(repository), sources: new SourceLocationService(repository),
    batches: new BatchService(repository, {} as TranslationService) };
}

describe('private source locations and safe exports', () => {
  it('persists the actual selected source across repository reopen without exposing paths in documents or summaries', async () => {
    const f = await fixture(), input = await f.imports('audio-project');
    const reopened = new DocumentRepository(f.repositoryRoot), sources = new SourceLocationService(reopened);
    expect(await sources.get(input.document.id)).toEqual({ status: 'ready', origin: 'input' });
    expect((await reopened.readSourceLocation(input.document.id))?.capture).toMatchObject({ inputPath: input.file, directoryPath: input.parent });
    const snapshot = await reopened.readSnapshot(input.document.id);
    expect(JSON.stringify(snapshot)).not.toContain(f.root);
    expect(JSON.stringify(summarizeDocument(snapshot.document))).not.toContain(f.root);
    await reopened.transact(input.document.id, 1, () => {});
    expect(await sources.get(input.document.id)).toEqual({ status: 'ready', origin: 'input' });
    await reopened.delete(input.document.id, 2);
    await expect(readFile(path.join(f.repositoryRoot, input.document.id, SOURCE_LOCATION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(input.file, 'utf8')).toBe(raw);
  });

  it('exports a frozen plan and the original bytes beside their input without overwriting that input', async () => {
    const f = await fixture(), input = await f.imports('source');
    const plan = await f.service.plan(7, input.document.id, 1, options());
    expect(plan.fileName).toBe('sample.srt');
    expect(plan.sourceLocation?.status).toBe('ready');
    const result = await f.service.publishToSource(7, input.document.id, 1, plan.planId!, losses(plan));
    expect(result.fileName).toBe('sample (1).srt');
    const original = await f.service.exportOriginalToSource(input.document.id, 1);
    expect(original.fileName).toBe('sample (2).srt');
    expect(await readFile(path.join(input.parent, original.fileName), 'utf8')).toBe(raw);
    expect(await readFile(input.file, 'utf8')).toBe(raw);
    expect((await readdir(input.parent)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('keeps a missing legacy binding recoverable and invalidates a plan when the directory is explicitly rebound', async () => {
    const f = await fixture(), input = await f.imports('source');
    const legacy = { ...input.document, id: randomUUID() }; await f.repository.create(legacy);
    expect(await f.sources.get(legacy.id)).toEqual({ status: 'missing' });
    const plan = await f.service.plan(7, legacy.id, 1, options());
    await expect(f.service.publishToSource(7, legacy.id, 1, plan.planId!, losses(plan))).rejects.toThrow('needs_configuration');
    const destination = path.join(f.root, 'rebound'); await mkdir(destination);
    expect(await f.sources.selectDirectory(legacy.id, destination)).toEqual({ status: 'ready', origin: 'user-selected-directory' });
    await expect(f.service.publishToSource(7, legacy.id, 1, plan.planId!, losses(plan))).rejects.toThrow('needs_configuration');
    const fresh = await f.service.plan(7, legacy.id, 1, options());
    await f.sources.selectDirectory(legacy.id, input.parent);
    await expect(f.service.publishToSource(7, legacy.id, 1, fresh.planId!, losses(fresh))).rejects.toThrow('revision_conflict');
    expect(await readdir(destination)).toEqual([]);
  });

  it('rejects replaced parents even if the same input inode is linked into the replacement', async () => {
    const f = await fixture(), input = await f.imports('source');
    const plan = await f.service.plan(7, input.document.id, 1, options());
    const previous = `${input.parent}-old`; await rename(input.parent, previous); await mkdir(input.parent);
    await link(path.join(previous, path.basename(input.file)), input.file);
    expect((await f.sources.get(input.document.id)).status).toBe('unavailable');
    await expect(f.service.publishToSource(7, input.document.id, 1, plan.planId!, losses(plan))).rejects.toThrow('output_write_failed');
    expect(await readdir(input.parent)).toEqual(['sample.srt']);
    expect((await f.repository.read(input.document.id)).cues).toHaveLength(1);
  });

  it('fails only the missing source in a batch and writes healthy files to their own distinct parents', async () => {
    const f = await fixture(), inputs = await Promise.all([f.imports('one'), f.imports('two'), f.imports('three')]);
    const documents = inputs.map(({ document }) => ({ documentId: document.id, revision: 1 }));
    const plan = await f.batches.planExport(8, { documents, options: options({ fileNameSuffix: { mode: 'custom', value: 'review' } }) });
    await rm(inputs[1].file);
    const result = await f.batches.export(8, plan.batchId, [], undefined, undefined, 'source-directory');
    expect(result.items.map(item => item.ok)).toEqual([true, false, true]);
    for (const index of [0, 2]) expect(await readFile(path.join(inputs[index].parent, 'sample.review.srt'), 'utf8')).toContain('Original subtitle.');
    expect(await readdir(inputs[1].parent)).toEqual([]);
    const originals = await f.batches.exportSources(documents, undefined, undefined, 'source-directory');
    expect(originals.items.map(item => item.ok)).toEqual([true, false, true]);
    expect(await readFile(path.join(inputs[0].parent, 'sample (1).srt'), 'utf8')).toBe(raw);
  });

  it('retains source identity through real media-document publication rather than deriving a path from transcript displayName', async () => {
    const f = await fixture(), parent = path.join(f.root, 'media'); await mkdir(parent);
    const mediaPath = path.join(parent, 'actually-selected.wav'); await writeFile(mediaPath, 'synthetic media bytes, no ASR');
    const capture = await captureSourceInput(mediaPath);
    const sink = createTranscriptionDocumentSink({ repository: f.repository, owner: { webContentsId: 2, ownerSessionId: 'media-source-test' },
      taskId: 'task-1', generation: 1, assertActive() {}, sourceLocation: capture });
    const receipt = await sink.publish({ schemaVersion: 1, source: { displayName: 'display-only.wav', durationMs: 1000 },
      model: { engine: 'whisper_cpp', modelId: 'test', modelHash: 'a'.repeat(64), backend: 'cpu' }, segments: [{ id: 'segment-1', startMs: 0, endMs: 1000, text: 'Hello.' }] });
    const record = await new DocumentRepository(f.repositoryRoot).readSourceLocation(receipt.documentId);
    expect(record?.capture).toMatchObject({ inputPath: mediaPath, directoryPath: parent });
    const plan = await f.service.plan(2, receipt.documentId, 1, options());
    await f.service.publishToSource(2, receipt.documentId, 1, plan.planId!, losses(plan));
    expect(await readFile(path.join(parent, 'display-only.srt'), 'utf8')).toContain('Hello.');
    expect(JSON.stringify(await f.repository.read(receipt.documentId))).not.toContain(mediaPath);
  });

  it('isolates corrupt private location records from document readability and allows explicit recovery', async () => {
    const f = await fixture(), input = await f.imports('source');
    await writeFile(path.join(f.repositoryRoot, input.document.id, SOURCE_LOCATION_FILE), JSON.stringify({ inputPath: 'untrusted' }));
    expect(await f.sources.get(input.document.id)).toEqual({ status: 'unavailable' });
    expect((await f.repository.read(input.document.id)).id).toBe(input.document.id);
    await f.sources.selectDirectory(input.document.id, input.parent);
    expect(await f.sources.get(input.document.id)).toEqual({ status: 'ready', origin: 'user-selected-directory' });
  });

  it('rechecks a bound parent at the actual publication boundary and does not alter a replacement directory victim', async () => {
    const f = await fixture(), input = await f.imports('source');
    const location = await f.sources.inspect(input.document.id);
    let checks = 0;
    await expect(f.sources.publish(input.document.id, location.bindingId, async (directory, verify) => {
      return publishBytes(Buffer.from('new output'), path.join(directory, 'victim.srt'), async () => {
        if (++checks === 3) {
          await rename(input.parent, `${input.parent}-old`); await mkdir(input.parent);
          await writeFile(path.join(input.parent, 'victim.srt'), 'untouched victim');
        }
        await verify();
      }, 'indexed');
    })).rejects.toThrow('output_write_failed');
    expect(await readFile(path.join(input.parent, 'victim.srt'), 'utf8')).toBe('untouched victim');
    expect(await readdir(input.parent)).toEqual(['victim.srt']);
  });

  it('cleans an unpublished private binding with its failed creation and never confuses another document binding', async () => {
    const f = await fixture(), input = await f.imports('source');
    const failed = { ...input.document, id: randomUUID() };
    const repository = new DocumentRepository(f.repositoryRoot, { fault(stage) { if (stage === 'current-publish') throw new Error('synthetic commit failure'); } });
    await expect(repository.createConfirmed(failed, undefined, input.sourceLocation)).rejects.toThrow('synthetic commit failure');
    await expect(readdir(path.join(f.repositoryRoot, failed.id))).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await f.imports('other');
    await writeFile(path.join(f.repositoryRoot, other.document.id, SOURCE_LOCATION_FILE), await readFile(path.join(f.repositoryRoot, input.document.id, SOURCE_LOCATION_FILE)));
    expect(await f.sources.get(other.document.id)).toEqual({ status: 'unavailable' });
    expect((await f.repository.read(other.document.id)).id).toBe(other.document.id);
    const plan = await f.service.plan(1, input.document.id, 1, options());
    expect(JSON.stringify(plan)).not.toContain(input.parent);
    expect(JSON.stringify(plan)).not.toContain((await f.repository.readSourceLocation(input.document.id))!.bindingId);
  });
});

describe('optional export filename suffixes', () => {
  it.each(['source', 'target', 'bilingual'] as const)('keeps %s defaults unadorned, including partial exports', async mode => {
    const f = await fixture(), { document } = await f.imports('source');
    const id = randomUUID(); document.translationTracks.push({ id, language: 'zh-CN', revision: 1, entries: {} });
    const opts = options({ mode, trackId: id, incomplete: 'source-fallback' });
    const plan = planSubtitleExport(document, opts);
    expect(plan.fileName).toBe('sample.srt'); expect(plan.partial).toBe(mode !== 'source');
    expect(subtitleExportFileName(document, { ...opts, fileNameSuffix: { mode: 'preset', preset: 'content-mode' } })).toBe(`sample.${mode}.srt`);
    expect(subtitleExportFileName(document, { ...opts, fileNameSuffix: { mode: 'custom', value: 'review' } })).toBe('sample.review.srt');
    if (mode !== 'source') expect(subtitleExportFileName(document, { ...opts, fileNameSuffix: { mode: 'preset', preset: 'target-language' } })).toBe('sample.zh-CN.srt');
  });
  it.each(['../x', 'x/y', 'x\\y', 'x:', 'x\0', 'x\n', 'x.', 'x ', ' ', '.', '\ud800'])('rejects unsafe custom suffix %j', value => {
    expect(fileNameSuffixSchema.safeParse({ mode: 'custom', value }).success).toBe(false);
  });
});
