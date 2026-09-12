import { expect, it } from 'vitest';
import { enqueueTranscriptionRequestSchema, transcriptionTaskSummarySchema } from '../../src/subtitle-studio/transcription/task-contract';
const request = () => ({ files: [{ fileToken: 'ls-input-opaque' }], config: { modelId: 'large-v3-q5_0', devicePreference: 'cpu',
  language: 'auto', taskMode: 'transcribe', vadEnabled: true, advanced: { beamSize: 5, temperature: 0,
    vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 80, maxLineChars: 40 } } });
it('accepts capability-only requests and rejects paths, output settings, identity proofs, and oversized batches', () => {
  expect(enqueueTranscriptionRequestSchema.safeParse(request()).success).toBe(true);
  const valid = request();
  for (const value of [
    { ...valid, ownerSessionId: 'spoof' },
    { ...valid, files: [{ fileToken: 'C:\\private\\audio.wav' }] },
    { ...valid, files: [{ fileToken: 'ls-input-opaque', filePath: '/private/audio.wav' }] },
    { ...valid, files: [valid.files[0], valid.files[0]] },
    { ...valid, files: Array.from({ length: 21 }, (_, index) => ({ fileToken: `input-${index}` })) },
    { ...valid, config: { ...valid.config, output: { mode: 'source' } } },
    { ...valid, config: { ...valid.config, backendResolution: {} } },
    { ...valid, config: { ...valid.config, windowStrategy: 'acoustic_quiet_v1', vadEnabled: false } },
  ]) expect(enqueueTranscriptionRequestSchema.safeParse(value).success).toBe(false);
});
it('bounds summaries and excludes capabilities and private diagnostics', () => {
  const task = { taskId: 'task-1', batchId: 'batch-1', generation: 1, displayName: 'audio.wav', status: 'failed',
    progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelId: 'large-v3-q5_0', resolvedBackend: 'cpu',
    error: { code: 'transcription_failed' } };
  expect(transcriptionTaskSummarySchema.safeParse(task).success).toBe(true);
  for (const extra of [{ fileToken: 'ls-input-secret' }, { sourcePathDisplay: '/private' }, { progress: 101 },
    { error: { code: 'transcription_failed', message: '/private/native/path' } }, { generation: 2 }])
    expect(transcriptionTaskSummarySchema.safeParse({ ...task, ...extra }).success).toBe(false);
});
