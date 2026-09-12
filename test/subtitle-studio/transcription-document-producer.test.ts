import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StudioError } from '../../src/subtitle-studio/domain';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { createTranscriptionDocumentProducer } from '../../electron/main/subtitle-studio/transcription/document-producer';
import type { TranscriptionBatchExecutionContext, TranscriptionTaskExecutionContext, TranscriptExecutionResult } from '../../electron/main/subtitle-studio/transcription/transcript-executor';
import type { LocalSubtitleJobBatchRuntime } from '../../electron/main/subtitle-studio/transcription/native/job-manager';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const transcript = () => ({ schemaVersion: 1 as const, source: { displayName: 'meeting.wav', durationMs: 5000 },
  model: { engine: 'whisper_cpp' as const, modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' as const },
  detectedLanguage: 'en', languageProbability: 0.99,
  segments: [{ id: 'segment-1', startMs: 1000, endMs: 3000, text: 'Hello world.', confidence: 0.8, speaker: 'A',
    words: [{ text: 'Hello', startMs: 1000, endMs: 1800, probability: 0.8 }, { text: ' world.', startMs: 1800, endMs: 3000, probability: 0.9 }] }],
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-document-producer-')); roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const controller = new AbortController();
  const owner = { webContentsId: 41, ownerSessionId: 'producer-owner' };
  let active = true;
  const assertActive = () => { if (!active) throw new StudioError('access_denied'); };
  const sink = createTranscriptionDocumentSink({ repository, owner, taskId: 'producer-task', generation: 1, assertActive });
  // Only orchestration is simulated here. Native admission/brands are exercised
  // by the derived executor's paired tests, not by these placeholder contexts.
  const batch = { owner, batchId: 'producer-batch', config: {}, managedModel: {}, backendResolution: {},
    admittedRuntimeGeneration: 'b'.repeat(64), signal: controller.signal } as unknown as TranscriptionBatchExecutionContext;
  const task = { ...batch, taskId: 'producer-task', generation: 1, fileToken: 'private-ephemeral', update: vi.fn() } as unknown as Omit<TranscriptionTaskExecutionContext, 'batchRuntime'>;
  const order: string[] = [];
  const result = { status: 'transcript_ready', transcript: transcript() } as TranscriptExecutionResult;
  const executor = {
    beginBatchSlice: vi.fn(() => { order.push('begin'); return {} as LocalSubtitleJobBatchRuntime; }),
    execute: vi.fn(async () => { order.push('execute'); return result; }),
    endBatchSlice: vi.fn(() => { order.push('release'); }),
  };
  const publish = vi.spyOn(repository, 'createConfirmed');
  const create = () => createTranscriptionDocumentProducer({ executor, sink, batch, task, assertActive });
  return { root, repository, controller, owner, sink, batch, task, executor, order, publish, create, revoke: () => { active = false; } };
}

it('joins concurrent runs, commits after batch cleanup, and reopens the complete transcript', async () => {
  const f = await fixture(), gate = deferred();
  f.executor.execute.mockImplementation(async () => { f.order.push('execute'); await gate.promise; return { status: 'transcript_ready', transcript: transcript() } as TranscriptExecutionResult; });
  f.executor.endBatchSlice.mockImplementation(() => { expect(f.publish).not.toHaveBeenCalled(); f.order.push('release'); });
  const producer = f.create(), first = producer.run(), second = producer.run();
  expect(second).toBe(first); gate.resolve();
  const result = await first;
  expect(result.status).toBe('committed');
  expect(f.order).toEqual(['begin', 'execute', 'release']);
  expect(f.publish).toHaveBeenCalledTimes(1);
  const reopened = await new DocumentRepository(path.join(f.root, 'documents')).read(producer.documentId);
  expect(reopened.origin.format).toBe('media');
  expect(JSON.stringify(reopened)).toContain('Hello world.');
  expect(JSON.stringify(reopened)).toContain('"probability":0.9');
  expect(JSON.stringify(reopened)).not.toContain('private-ephemeral');
  expect((await producer.run()).status).toBe('committed');
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(await f.repository.list()).toHaveLength(1);
});

it.each(['failed', 'cancelled'] as const)('never invokes the sink for a %s pipeline', async status => {
  const f = await fixture();
  f.executor.execute.mockResolvedValue({ status, ...(status === 'failed' ? { error: { code: 'transcript_quality_failed' } } : {}) } as TranscriptExecutionResult);
  expect((await f.create().run()).status).toBe(status);
  expect(f.executor.endBatchSlice).toHaveBeenCalledTimes(1);
  expect(f.publish).not.toHaveBeenCalled();
  expect(await f.repository.list()).toEqual([]);
});

it('blocks publication on batch cleanup failure and cannot reuse the closed batch', async () => {
  const f = await fixture();
  f.executor.endBatchSlice.mockImplementation(() => { throw new Error('pin release failed'); });
  const producer = f.create();
  await expect(producer.run()).rejects.toThrow('pin release failed');
  await expect(producer.run()).rejects.toThrow('pin release failed');
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.publish).not.toHaveBeenCalled();
  expect(await f.repository.list()).toEqual([]);
});

it.each(['cancel', 'owner'] as const)('blocks a %s invalidation during final batch cleanup', async kind => {
  const f = await fixture();
  f.executor.endBatchSlice.mockImplementation(() => { if (kind === 'cancel') f.controller.abort(); else f.revoke(); });
  await expect(f.create().run()).rejects.toBeInstanceOf(StudioError);
  expect(await f.repository.list()).toEqual([]);
});

it('retries the same document after a prepublication failure without repeating ASR', async () => {
  const f = await fixture();
  f.publish.mockRejectedValueOnce(new StudioError('output_write_failed'));
  const producer = f.create();
  await expect(producer.run()).rejects.toMatchObject({ code: 'output_write_failed' });
  expect(await f.repository.list()).toEqual([]);
  expect((await producer.run()).status).toBe('committed');
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(await f.repository.list()).toHaveLength(1);
});

it('retains a committed receipt when cancellation arrives after publication', async () => {
  const f = await fixture();
  const unsubscribe = f.repository.subscribe(() => { f.controller.abort(); f.revoke(); });
  try {
    const result = await f.create().run();
    expect(result.status).toBe('committed');
    expect(await f.repository.list()).toHaveLength(1);
  } finally { unsubscribe(); }
});

it('rejects a sink bound to another owner or task generation before starting work', async () => {
  const f = await fixture();
  for (const mismatch of [{ generation: 2 }, { taskId: 'different-task' }, { owner: { ...f.owner, ownerSessionId: 'other' } }]) {
    expect(() => createTranscriptionDocumentProducer({ executor: f.executor, sink: f.sink, batch: f.batch,
      task: { ...f.task, ...mismatch }, assertActive: () => {} })).toThrow(StudioError);
  }
  expect(f.executor.beginBatchSlice).not.toHaveBeenCalled();
});

it('does not return a cached terminal result to a revoked owner', async () => {
  const f = await fixture();
  f.executor.execute.mockResolvedValue({ status: 'cancelled' });
  const producer = f.create();
  expect((await producer.run()).status).toBe('cancelled');
  f.revoke();
  await expect(producer.run()).rejects.toMatchObject({ code: 'access_denied' });
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
});
