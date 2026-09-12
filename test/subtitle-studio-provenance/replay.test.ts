import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createReplayPair, runReplayCase, saveReplayEvidence } from './replay-harness.mjs';
import { replayCases, type ReplayCase } from './fixtures/replay-cases';

let pair: Awaited<ReturnType<typeof createReplayPair>> | undefined;
const traces: any[] = [];
const brands: string[] = [];
const wordEvidence: any[] = [];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

beforeAll(async () => { pair = await createReplayPair(); }, 120_000);

afterAll(async () => {
  if (!pair) return;
  let cleaned = false;
  try { await pair.cleanup(); cleaned = true; }
  finally {
    await saveReplayEvidence({ ...pair.evidence,
      status: cleaned && traces.length === replayCases.length && brands.length === 4 && wordEvidence.length === 3 ? 'passed' : 'incomplete',
      cleanupSucceeded: cleaned, brands, wordEvidence,
      cases: traces.map(trace => ({ id: trace.id, digest: digest(trace), trace })),
      limits: ['Synthetic deterministic responses and PCM only; no native ASR, Electron or user media.',
        'PCM/window brands use the real normalizer with its injected process runner, not the executor helper brand override.',
        'Legacy application sources came only from fixed Git blobs. Ordinary Studio tests do not import this migration harness.'],
    });
  }
}, 60_000);

function assertExpected(trace: any, scenario: ReplayCase) {
  const expected = scenario.expected;
  expect(trace.config).toMatchObject({
    model: { modelId: scenario.options.modelId ?? 'large-v3-q5_0' },
    resolvedBackend: scenario.options.backend ?? 'cpu', language: 'auto', taskMode: 'transcribe',
    inference: {
      windowStrategy: scenario.options.taskWindowStrategy ?? 'fixed_v1',
      advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500 },
      vad: { enabled: scenario.options.vadEnabled === true, modelId: 'silero-vad-v6.2.0-ggml',
        tokenTimestamps: false, timelinePolicy: 'mapped_segment_timestamps_only' },
    },
  });
  expect(trace.status).toBe(expected.status);
  expect(trace.errorCode).toBe(expected.errorCode ?? null);
  expect(trace.requests).toHaveLength(expected.requests);
  expect(trace.requests.map((request: any) => request.requestGeneration)).toEqual(Array.from({ length: expected.requests }, (_, index) => index + 1));
  if (expected.ranges) expect(trace.windows.map((item: any) => [item.descriptor.startMs, item.descriptor.endMs])).toStrictEqual(expected.ranges);
  if (expected.conditioned) expect(trace.windows.map((item: any) => item.conditioned)).toStrictEqual(expected.conditioned);
  if (expected.temperatures) expect(trace.requests.map((request: any) => request.temperature)).toStrictEqual(expected.temperatures);
  if (expected.parentKeys) expect(trace.windows.map((item: any) => item.descriptor.parentWindowKey)).toStrictEqual(expected.parentKeys);
  if (expected.scans !== undefined) expect(trace.lifecycle.filter((event: any) => event.name === 'scan')).toHaveLength(expected.scans);
  if (expected.dtw) expect(trace.requests.map((request: any) => request.timingMode)).toStrictEqual(expected.dtw);
  if (expected.noExport) {
    expect(trace.transcript).toBeNull();
    expect(trace.lifecycle.some((event: any) => event.name === 'export')).toBe(false);
  } else {
    expect(trace.transcript?.segments.length).toBeGreaterThan(0);
    const exportIndex = trace.lifecycle.findIndex((event: any) => event.name === 'export');
    const cleanupIndex = trace.lifecycle.findIndex((event: any) => event.name === 'dispose-normalized');
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(cleanupIndex);
    if (expected.texts) expect(trace.transcript.segments.map((cue: any) => cue.text)).toStrictEqual(expected.texts);
    if (expected.times) expect(trace.transcript.segments.map((cue: any) => [cue.startMs, cue.endMs])).toStrictEqual(expected.times);
    // Only the golden text assertion ignores display whitespace. The old/new transcript comparison is strict.
    if (expected.joinedSource) expect(trace.transcript.segments.map((cue: any) => cue.text).join('').replace(/[\n ]/g, '')).toBe(expected.joinedSource);
  }
  expect(trace.lifecycle.filter((event: any) => event.name === 'release-pin')).toHaveLength(1);
  if (scenario.id === 'quiet-conditioned-long-response-falls-back-to-original') {
    expect(trace.requests[0].vadSpeechPadMs).toBe(1000);
    expect(trace.requests[1]).not.toHaveProperty('vadSpeechPadMs');
    expect(trace.rawResponses[0].response.result.text).toBe('Discarded candidate');
    expect(trace.rawResponses[1].response.result.text).toBe('Original output');
  }
  if (scenario.id === 'fixed-unknown-boundary-and-legal-repetition') {
    expect(trace.transcript.segments.slice(-2).map((cue: any) => cue.text)).toEqual(['うん', 'うん']);
    expect(trace.transcript.segments[0]).not.toHaveProperty('estimatedTiming');
  }
  if (scenario.id === 'cuda-f16-preserves-qualified-word-points') {
    expect(trace.rawResponses[1].response.result.segments[1].dtwTokens[0]).toEqual({ text: '明日', pointMs: 4500 });
    expect(trace.requests[1]).toMatchObject({ timingMode: 'dtw_large_v3', vadEnabled: false, language: 'ja' });
  }
}

describe('frozen v1 and independent Studio deterministic replay', () => {
  it.each(replayCases)('$id', async scenario => {
    const legacy = await runReplayCase(pair!.legacy.executor, scenario);
    const studio = await runReplayCase(pair!.studio.executor, scenario);
    // Full objects: do not drop punctuation, cue/word timing evidence, raw response fields or retry plans.
    expect(studio).toStrictEqual(legacy);
    assertExpected(legacy, scenario);
    assertExpected(studio, scenario);
    traces.push(studio);
  }, 60_000);

  it.each(['ordinary', 'vad', 'dtw'] as const)('preserves the exact %s word evidence contract', mode => {
    const raw = { task: 'transcribe', language: 'japanese', duration: 2.5, text: ' hello\n', segments: [{
      id: 0, text: ' hello ', start: 0.12, end: 2.34, tokens: [1, 2],
      words: [{ word: 'hello', start: 0.12, end: 0.8, t_dtw: 42, probability: 0.91 }],
      temperature: 0, avg_logprob: -0.25, no_speech_prob: 0.01,
    }] };
    const options = { taskMode: 'transcribe', vadEnabled: mode === 'vad', ...(mode === 'dtw' ? { timingMode: 'dtw_large_v3' } : {}) };
    const legacy = pair!.legacy.executor.parseLocalSubtitleServerVerboseJson(structuredClone(raw), options);
    const studio = pair!.studio.executor.parseLocalSubtitleServerVerboseJson(structuredClone(raw), options);
    expect(studio).toStrictEqual(legacy);
    expect(studio.segments[0]).toMatchObject({ startMs: 120, endMs: 2340, text: 'hello' });
    expect(studio.wordTimelineStatus).toBe(mode === 'dtw' ? 'dtw_token_points' : mode === 'vad' ? 'discarded_vad_compressed_timeline' : 'not_requested');
    if (mode === 'dtw') {
      expect(studio.segments[0].dtwTokens).toEqual([{ text: 'hello', pointMs: 420 }]);
      expect(studio.segments[0].dtwTokens[0]).not.toHaveProperty('startMs');
    } else expect(studio.segments[0]).not.toHaveProperty('dtwTokens');
    expect(studio.segments[0]).not.toHaveProperty('words');
    wordEvidence.push({ mode, result: studio });
  });
});

async function cleanupAll(actions: Array<() => unknown>) {
  const failures: unknown[] = [];
  for (const action of actions) try { await action(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Brand fixture cleanup failed');
}

describe('real issuing registries reject proofs from the other module copy', () => {
  it('backend resolution: own issuer succeeds and foreign resolution fails batch admission both ways', async () => {
    const apis = [pair!.legacy.executor, pair!.studio.executor];
    const harnesses: any[] = [];
    try {
      for (const api of apis) harnesses.push(await api.createHarness());
      for (let index = 0; index < 2; index++) {
        const own = harnesses[index], foreign = harnesses[1 - index];
        expect(apis[index].isLocalSubtitleVerifiedBackendResolution(own.context.backendResolution)).toBe(true);
        expect(apis[index].isLocalSubtitleVerifiedBackendResolution(foreign.context.backendResolution)).toBe(false);
        let rejection: any;
        try { own.executor.beginBatchSlice({ ...own.context, backendResolution: foreign.context.backendResolution, signal: own.sliceController.signal }); }
        catch (error) { rejection = error; }
        expect(rejection).toMatchObject({ code: 'invalid_ipc_request', stage: 'preflight' });
        expect(own.media.normalizeTask).not.toHaveBeenCalled();
        expect((await own.executor.execute(own.context)).status).toBe('completed');
      }
      brands.push('backend: bidirectional admission rejection and own execution');
    } finally { await cleanupAll([...harnesses.map(harness => () => harness.executor.endBatchSlice(harness.context.batchRuntime)), ...apis.map(api => () => api.cleanup())]); }
  });

  it('accelerator proof: real installation verification is local to each module copy', async () => {
    const apis = [pair!.legacy.executor, pair!.studio.executor];
    const fixtures: any[] = [], harnesses: any[] = [];
    try {
      for (const api of apis) fixtures.push(await api.createAcceleratorFixture());
      for (let index = 0; index < 2; index++) {
        expect(apis[index].isLocalSubtitleVerifiedAcceleratorPack(fixtures[index].proof)).toBe(true);
        expect(apis[index].isLocalSubtitleVerifiedAcceleratorPack(fixtures[1 - index].proof)).toBe(false);
        // Auto resolution cannot admit the foreign CUDA proof; its CPU fallback cannot authorize a CUDA batch.
        await expect(apis[index].createHarness({ backend: 'cuda', acceleratorPack: fixtures[1 - index].proof })).rejects.toMatchObject({ code: 'invalid_ipc_request', stage: 'preflight' });
        const harness = await apis[index].createHarness({ backend: 'cuda', acceleratorPack: fixtures[index].proof });
        harnesses.push(harness);
        expect((await harness.executor.execute(harness.context)).status).toBe('completed');
      }
      brands.push('accelerator: bidirectional CUDA batch admission rejection and own execution');
    } finally { await cleanupAll([...harnesses.map(harness => () => harness.executor.endBatchSlice(harness.context.batchRuntime)), ...fixtures.map(fixture => () => fixture.cleanup()), ...apis.map(api => () => api.cleanup())]); }
  });

  it('batch runtime: a genuine foreign executor slice cannot authorize local execution', async () => {
    const apis = [pair!.legacy.executor, pair!.studio.executor];
    const harnesses: any[] = [];
    try {
      for (const api of apis) harnesses.push(await api.createHarness());
      for (let index = 0; index < 2; index++) {
        const own = harnesses[index], foreign = harnesses[1 - index];
        await expect(own.executor.execute({ ...own.context, batchRuntime: foreign.context.batchRuntime })).resolves.toMatchObject({ status: 'failed', error: { code: 'invalid_ipc_request', stage: 'preflight' } });
        expect(own.media.normalizeTask).not.toHaveBeenCalled();
        expect(own.supervisor.beginInference).not.toHaveBeenCalled();
        expect((await own.executor.execute(own.context)).status).toBe('completed');
      }
      brands.push('batch: bidirectional WeakMap slice rejection before native work');
    } finally { await cleanupAll([...harnesses.map(harness => () => harness.executor.endBatchSlice(harness.context.batchRuntime)), ...apis.map(api => () => api.cleanup())]); }
  });

  it('PCM/window: real normalizers reject foreign active proofs before any consumer reads their files', async () => {
    const apis = [pair!.legacy.media, pair!.studio.media];
    const initialized: any[] = [], fixtures: any[] = [], windows: any[] = [];
    try {
      for (const api of apis) { await api.setup(); initialized.push(api); }
      for (const api of apis) fixtures.push(await api.normalizedFixture(api.OWNER_A, 'proof.mov', 'task-proof'));
      for (let index = 0; index < 2; index++) {
        const { harness, normalized } = fixtures[index];
        expect(apis[index].isLocalSubtitleNormalizedPcm(normalized)).toBe(true);
        windows.push(await harness.normalizer.materializeWindow({ normalized, descriptor: apis[index].structuralWindow(0, 16000) }));
        expect(apis[index].isLocalSubtitleBrandedPcmWindow(windows[index])).toBe(true);
        await expect(harness.normalizer.resolveWindow(windows[index], {
          taskId: normalized.taskId, taskGeneration: normalized.taskGeneration, descriptor: windows[index].descriptor,
        })).resolves.toMatchObject({ sha256: windows[index].sha256 });
      }
      for (let index = 0; index < 2; index++) {
        const { harness } = fixtures[index];
        expect(apis[index].isLocalSubtitleNormalizedPcm(fixtures[1 - index].normalized)).toBe(false);
        expect(apis[index].isLocalSubtitleBrandedPcmWindow(windows[1 - index])).toBe(false);
        const callsBefore = harness.calls.length;
        await expect(harness.normalizer.materializeWindow({ normalized: fixtures[1 - index].normalized, descriptor: apis[index].structuralWindow(0, 16000) })).rejects.toMatchObject({ code: 'invalid_configuration', localSubtitleCode: 'runtime_protocol_mismatch' });
        await expect(harness.normalizer.resolveWindow(windows[1 - index], {
          taskId: windows[1 - index].taskId, taskGeneration: windows[1 - index].taskGeneration, descriptor: windows[1 - index].descriptor,
        })).rejects.toMatchObject({ code: 'invalid_configuration', localSubtitleCode: 'runtime_protocol_mismatch' });
        expect(harness.calls).toHaveLength(callsBefore);
      }
      brands.push('PCM/window: bidirectional real materialize/resolve rejection');
    } finally { await cleanupAll([
      ...windows.map((window, index) => () => fixtures[index].harness.normalizer.disposeWindow(window)),
      ...fixtures.map(fixture => () => fixture.harness.normalizer.disposeNormalized(fixture.normalized)),
      ...initialized.map(api => () => api.cleanup()),
    ]); }
  }, 60_000);
});
