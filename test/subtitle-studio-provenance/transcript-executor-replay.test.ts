import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTranscriptExecutorReplay } from './transcript-executor-harness.mjs';
import { replayCases } from './fixtures/replay-cases';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { createTranscriptionDocumentProducer } from '../../electron/main/subtitle-studio/transcription/document-producer';

let pair: Awaited<ReturnType<typeof createTranscriptExecutorReplay>>;
const evidence: any[] = [];
const boundaryChecks: string[] = [];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
beforeAll(async () => { pair = await createTranscriptExecutorReplay(); }, 120_000);
afterAll(async () => {
  if (!pair) return;
  await pair.cleanup();
  const directory = path.resolve('test-results/subtitle-studio-transcript-executor'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'replay-evidence.json'), JSON.stringify({ ...pair.evidence,
    status: evidence.length === replayCases.length && boundaryChecks.length === 10 ? 'passed' : 'incomplete', cases: evidence, boundaryChecks,
    scope: 'Synthetic fixed responses and task-owned PCM fixtures; T02 reference exporter captures the transcript without writing SRT/LRC.',
  }, null, 2) + '\n');
}, 60_000);

const requestProjection = (request: any) => {
  const { filePath, signal, ...data } = request;
  return { ...data, windowFile: path.basename(filePath), aborted: signal?.aborted ?? false };
};
async function run(api: any, scenario: any, derived: boolean) {
  const accelerator = scenario.accelerator ? await api.createAcceleratorFixture() : undefined;
  let harness: any;
  try {
    harness = await api.createHarness({ ...scenario.options, ...(accelerator ? { acceleratorPack: accelerator.proof } : {}),
      inference: (input: any) => scenario.inference(api, input) });
    if (scenario.quietCandidates) harness.media.readQuietCandidates.mockResolvedValue(structuredClone(scenario.quietCandidates));
    let captured: any;
    // This comparison stops the T02 reference at the audited output seam. It
    // returns cancellation, never fabricated committed file artifacts.
    harness.exporter.exportArtifacts.mockImplementation(async (options: any) => { captured = structuredClone(options.transcript); return { status: 'cancelled', artifactResults: [] }; });
    const result = await harness.executor.execute(harness.context);
    harness.executor.endBatchSlice(harness.context.batchRuntime);
    const transcript = derived ? result.status === 'transcript_ready' ? result.transcript : null : captured ?? null;
    expect(harness.media.disposeNormalized).toHaveBeenCalledOnce();
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
    expect(await fs.readdir(harness.outputRoot)).toEqual([]);
    if (derived) {
      expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      expect(harness.exporter.supportsConflictPolicy).not.toHaveBeenCalled();
      expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
      expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('artifactResults');
    } else if (captured) {
      expect(harness.exporter.exportArtifacts.mock.invocationCallOrder[0]).toBeGreaterThan(harness.media.disposeNormalized.mock.invocationCallOrder[0]);
      expect(result.status).toBe('cancelled');
    }
    const lifecycle: any[] = [];
    for (const [name, mock] of [['scan', harness.media.readQuietCandidates], ['window', harness.media.materializeWindow],
      ['infer', harness.supervisor.beginInference], ['dispose-window', harness.media.disposeWindow],
      ['task-lease', harness.supervisor.acquirePinnedTaskLease], ['separator-lease', harness.supervisor.acquirePinnedSeparatorLease],
      ['release-lease', harness.supervisor.release], ['dispose-normalized', harness.media.disposeNormalized], ['release-pin', harness.supervisor.releaseBatchRuntimePin]] as const) {
      for (const order of mock.mock.invocationCallOrder) lifecycle.push({ name, order });
    }
    lifecycle.sort((a, b) => a.order - b.order);
    return { transcript: structuredClone(transcript), status: transcript ? 'transcript_ready' : result.status, error: structuredClone(result.error ?? null),
      durationMs: result.durationMs, requests: harness.supervisor.beginInference.mock.calls.map((call: any) => requestProjection(call[1])),
      windows: harness.media.materializeWindow.mock.calls.map(([request]: any) => ({ descriptor: structuredClone(request.descriptor), conditioned: request.conditionQuietAudio === true })),
      lifecycle: lifecycle.map(event => event.name),
    };
  } finally {
    if (harness) harness.executor.endBatchSlice(harness.context.batchRuntime);
    await accelerator?.cleanup(); await api.cleanup();
  }
}

describe('T02 and transcript executor paired final-output replay', () => {
  it.each(replayCases)('$id', async scenario => {
    const original = await run(pair.t02, scenario, false);
    const derived = await run(pair.transcript, scenario, true);
    expect(derived).toStrictEqual(original);
    expect(derived.status).toBe(scenario.expected.status === 'completed' ? 'transcript_ready' : scenario.expected.status);
    expect(derived.requests).toHaveLength(scenario.expected.requests);
    if (scenario.expected.texts) expect(derived.transcript.segments.map((cue: any) => cue.text)).toEqual(scenario.expected.texts);
    if (scenario.expected.times) expect(derived.transcript.segments.map((cue: any) => [cue.startMs, cue.endMs])).toEqual(scenario.expected.times);
    if (scenario.expected.ranges) expect(derived.windows.map((window: any) => [window.descriptor.startMs, window.descriptor.endMs])).toEqual(scenario.expected.ranges);
    if (scenario.expected.conditioned) expect(derived.windows.map((window: any) => window.conditioned)).toEqual(scenario.expected.conditioned);
    if (scenario.expected.dtw) expect(derived.requests.map((request: any) => request.timingMode)).toEqual(scenario.expected.dtw);
    if (scenario.expected.errorCode) expect(derived.error?.code).toBe(scenario.expected.errorCode);
    if (scenario.expected.noExport) expect(derived.transcript).toBeNull();
    evidence.push({ id: scenario.id, transcriptSha256: hash(derived.transcript), traceSha256: hash(derived), segments: derived.transcript?.segments.length ?? 0 });
  }, 60_000);
});

describe('transcript readiness and resource boundaries', () => {
  it.each(['dispose', 'release', 'pipeline', 'cancel-before', 'cancel-cleanup', 'cancel-cleanup-failure'] as const)('does not expose a transcript after %s', async mode => {
    const traces: any[] = [];
    for (const api of [pair.t02, pair.transcript]) {
      const harness = await api.createHarness({ disposeNormalizedFailure: mode === 'dispose', releaseFailure: mode === 'release',
        ...(mode === 'pipeline' ? { normalizeFailure: Object.assign(new Error('synthetic decode failure'), { localSubtitleCode: 'media_decode_failed' }) } : {}) });
      try {
        if (mode === 'cancel-before') harness.controller.abort();
        if (mode.startsWith('cancel-cleanup')) harness.media.disposeNormalized.mockImplementation(async () => {
          harness.controller.abort();
          if (mode === 'cancel-cleanup-failure') throw new Error('synthetic cleanup failure');
          return { removed: true };
        });
        const result = await harness.executor.execute(harness.context);
        expect(result.status).not.toBe('transcript_ready'); expect(result).not.toHaveProperty('transcript');
        expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
        traces.push({ status: result.status, error: result.error, durationMs: result.durationMs });
        if (mode === 'dispose' || mode === 'release') expect(result.error?.code).toBe('cleanup_failed');
        if (mode === 'cancel-cleanup-failure') expect(result.error?.code).toBe('cancel_failed');
        if (mode === 'cancel-before' || mode === 'cancel-cleanup') expect(result.status).toBe('cancelled');
      } finally { harness.executor.endBatchSlice(harness.context.batchRuntime); await api.cleanup(); }
    }
    expect(traces[1]).toStrictEqual(traces[0]);
    boundaryChecks.push(mode);
  });

  it('requires no output config, output directory authority, file exporter, or handoff', async () => {
    const api = pair.transcript, harness = await api.createHarness({ outputMode: 'source' });
    let runtime: any;
    try {
      harness.executor.endBatchSlice(harness.context.batchRuntime);
      const { output, postAction, ...config } = harness.context.config;
      const sealed = Object.freeze(config);
      runtime = harness.executor.beginBatchSlice({ ...harness.context, config: sealed, signal: harness.sliceController.signal });
      const result = await harness.executor.execute({ ...harness.context, config: sealed, batchRuntime: runtime });
      expect(result.status).toBe('transcript_ready');
      expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
      expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
      expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      expect(harness.exporter.supportsConflictPolicy).not.toHaveBeenCalled();
      expect(await fs.readdir(harness.outputRoot)).toEqual([]);
      boundaryChecks.push('no-output-collaborators');
    } finally { harness.executor.endBatchSlice(runtime); await api.cleanup(); }
  });

  it('rejects a genuine T02 batch runtime before normalization or inference', async () => {
    const original = await pair.t02.createHarness(), derived = await pair.transcript.createHarness();
    try {
      const result = await derived.executor.execute({ ...derived.context, batchRuntime: original.context.batchRuntime });
      expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_ipc_request', stage: 'preflight' } });
      expect(derived.media.normalizeTask).not.toHaveBeenCalled(); expect(derived.supervisor.beginInference).not.toHaveBeenCalled();
      boundaryChecks.push('foreign-batch-rejected');
    } finally {
      original.executor.endBatchSlice(original.context.batchRuntime); derived.executor.endBatchSlice(derived.context.batchRuntime);
      await pair.t02.cleanup(); await pair.transcript.cleanup();
    }
  });

  it('retains the default PCM brand check outside the deterministic helper override', async () => {
    const api = pair.transcript, harness = await api.createHarness();
    const strict = new api.Executor({ ...harness.executorOptions, validateWindowBrand: undefined });
    const runtime = strict.beginBatchSlice({ ...harness.context, signal: harness.sliceController.signal });
    try {
      const result = await strict.execute({ ...harness.context, batchRuntime: runtime });
      expect(result).toMatchObject({ status: 'failed', error: { code: 'media_changed' } });
      expect(harness.supervisor.beginInference).not.toHaveBeenCalled(); expect(harness.media.disposeNormalized).toHaveBeenCalledOnce();
      boundaryChecks.push('default-window-brand-rejected');
    } finally { strict.endBatchSlice(runtime); harness.executor.endBatchSlice(harness.context.batchRuntime); await api.cleanup(); }
  });

  it('commits a real derived executor result through the producer and reopens the full T02-equivalent transcript', async () => {
    const scenario = replayCases.find(item => item.id === 'fixed-unknown-boundary-and-legal-repetition')!;
    const reference = await run(pair.t02, scenario, false);
    const api = pair.transcript;
    const harness = await api.createHarness({ ...scenario.options, inference: (input: any) => scenario.inference(api, input) });
    harness.executor.endBatchSlice(harness.context.batchRuntime);
    const repository = new DocumentRepository(path.join(harness.root, 'documents'));
    const assertActive = () => {};
    const sink = createTranscriptionDocumentSink({ repository, owner: harness.context.owner, taskId: harness.context.taskId, generation: harness.context.generation, assertActive });
    const { batchRuntime, ...task } = harness.context;
    const commit = vi.spyOn(repository, 'createConfirmed');
    const producer = createTranscriptionDocumentProducer({ executor: harness.executor, sink, task,
      batch: { ...task, signal: harness.sliceController.signal }, assertActive });
    try {
      const result = await producer.run();
      expect(result.status).toBe('committed');
      expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
      expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(harness.supervisor.releaseBatchRuntimePin.mock.invocationCallOrder[0]);
      const document = await new DocumentRepository(path.join(harness.root, 'documents')).read(producer.documentId);
      expect(document.schemaVersion).toBe(2);
      if (document.schemaVersion !== 2) throw new Error('Expected a media document');
      expect(document.preservation.kind).toBe('transcription');
      expect(document.preservation.transcript).toStrictEqual(reference.transcript);
      expect(document.cues.map(cue => cue.source.plain)).toEqual(reference.transcript.segments.map((cue: any) => cue.text));
      expect(document.cues.map(cue => [cue.timing.startMs, cue.timing.endMs])).toEqual(reference.transcript.segments.map((cue: any) => [cue.startMs, cue.endMs]));
      expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
      expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
      expect(await fs.readdir(harness.outputRoot)).toEqual([]);
      boundaryChecks.push('real-producer-sink-repository-round-trip');
    } finally { commit.mockRestore(); await api.cleanup(); }
  });
});
