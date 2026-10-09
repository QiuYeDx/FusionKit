import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { createAutomaticTranslationCoordinator } from '../../electron/main/subtitle-studio/automatic-translation';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createAutomaticExporter, automaticExportOptions } from '../../electron/main/subtitle-studio/automatic-export';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { summarizeDocument } from '../../src/subtitle-studio/ipc-contract';
import type { AutomaticExportSpec } from '../../src/subtitle-studio/automatic-export-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const transcript = (displayName: string) => ({ schemaVersion: 1, source: { displayName, durationMs: 4000 },
  model: { engine: 'whisper_cpp', modelId: 'test', modelHash: 'a'.repeat(64), backend: 'cpu' },
  segments: [{ id: 'segment-1', startMs: 0, endMs: 1500, text: 'こんにちは。' }, { id: 'segment-2', startMs: 2000, endMs: 3500, text: 'さようなら。' }] });
const spec = (overrides: Partial<AutomaticExportSpec> = {}): AutomaticExportSpec => ({ format: 'auto', mode: 'source', order: 'source-first', conflictPolicy: 'indexed', ...overrides });

async function transcribed(fileName: string, automaticExport: AutomaticExportSpec, bind = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-auto-export-'))); roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const parent = path.join(root, 'media'); await mkdir(parent);
  const media = path.join(parent, fileName); await writeFile(media, 'synthetic media bytes');
  const sink = createTranscriptionDocumentSink({ repository, owner: { webContentsId: 3, ownerSessionId: 'auto-export-test' }, taskId: 'task-1', generation: 1,
    assertActive() {}, automaticExport, ...(bind ? { sourceLocation: await captureSourceInput(media) } : {}) });
  const { documentId } = await sink.publish(transcript(fileName));
  return { repository, parent, documentId };
}

describe('automatic export after a pipeline', () => {
  it('writes an audio transcript as LRC next to its media and keeps the outcome on the document', async () => {
    const f = await transcribed('01.導入パート.wav', spec());
    expect((await f.repository.readSnapshot(f.documentId)).automaticExport).toMatchObject({ state: 'pending' });
    await createAutomaticExporter(f.repository).exportDocument(f.documentId);
    expect(await readFile(path.join(f.parent, '01.導入パート.lrc'), 'utf8')).toContain('こんにちは。');
    const snapshot = await f.repository.readSnapshot(f.documentId);
    expect(snapshot.automaticExport).toMatchObject({ state: 'exported', fileName: '01.導入パート.lrc' });
    expect(summarizeDocument(snapshot.document, snapshot.tasks, undefined, snapshot.automaticExport).automaticExport)
      .toEqual({ state: 'exported', format: 'auto', fileName: '01.導入パート.lrc' });
    // Done is done: a second call writes nothing more.
    await createAutomaticExporter(f.repository).exportDocument(f.documentId);
    expect(await readdir(f.parent)).toEqual(['01.導入パート.lrc', '01.導入パート.wav']);
  });

  it('writes video as SRT and numbers the file rather than replacing one that exists', async () => {
    const f = await transcribed('episode.mkv', spec());
    await writeFile(path.join(f.parent, 'episode.srt'), 'keep me');
    await createAutomaticExporter(f.repository).exportDocument(f.documentId);
    expect(await readFile(path.join(f.parent, 'episode.srt'), 'utf8')).toBe('keep me');
    expect(await readFile(path.join(f.parent, 'episode (1).srt'), 'utf8')).toContain('00:00:00,000 --> 00:00:01,500');
  });

  it('records why it could not export instead of failing silently', async () => {
    const f = await transcribed('voice.mp3', spec(), false);
    await createAutomaticExporter(f.repository).exportDocument(f.documentId);
    expect((await f.repository.readSnapshot(f.documentId)).automaticExport).toMatchObject({ state: 'failed', error: 'needs_configuration' });
  });

  it('exports the bilingual result as soon as the automatic translation completes', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-auto-chain-'))); roots.push(root);
    const repository = new DocumentRepository(path.join(root, 'documents'));
    const parent = path.join(root, 'media'); await mkdir(parent);
    const media = path.join(parent, '02.右耳かきパート.wav'); await writeFile(media, 'synthetic media bytes');
    const send = vi.fn(async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => ({ apiFormat: request.model.apiFormat, finishReason: 'stop',
      content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string }) => ({ id: item.id, text: '你好。' })) }),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }));
    const translation = new TranslationService(repository, send);
    const coordinator = createAutomaticTranslationCoordinator({ repository, translation });
    const exporter = createAutomaticExporter(repository);
    translation.onAutomaticCompleted(documentId => { void exporter.exportDocument(documentId); });
    const taskId = randomUUID(), intent = { intentId: randomUUID(), sourceTaskId: taskId, generation: 1 as const, state: 'pending' as const,
      config: { model: { profileId: 'profile', modelKey: 'deepseek-chat', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 32 } };
    const sink = createTranscriptionDocumentSink({ repository, owner: { webContentsId: 4, ownerSessionId: 'chain' }, taskId, generation: 1, assertActive() {},
      automaticTranslation: intent, automaticExport: spec({ mode: 'bilingual' }), sourceLocation: await captureSourceInput(media) });
    try {
      const { documentId } = await sink.publish(transcript('02.右耳かきパート.wav'));
      const admitted = await coordinator.handoff(documentId, intent.intentId, 'key');
      await translation.settled(admitted.taskId); await exporter.settled();
      const written = await readFile(path.join(parent, '02.右耳かきパート.lrc'), 'utf8');
      expect(written).toContain('こんにちは。'); expect(written).toContain('你好。');
      expect((await repository.readSnapshot(documentId)).automaticExport).toMatchObject({ state: 'exported', fileName: '02.右耳かきパート.lrc' });
    } finally { await coordinator.shutdown(); await translation.dispose(); }
  });

  it('waits for the automatic translation track before exporting translated content', async () => {
    const f = await transcribed('voice.mp3', spec({ mode: 'bilingual' }));
    // No automatic translation has written a track yet, so there is nothing to export.
    expect(automaticExportOptions(await f.repository.readSnapshot(f.documentId))).toBeUndefined();
  });
});
