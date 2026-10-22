import { describe, expect, it, vi } from 'vitest';
import { handleTranscriptionRequest, transcriptionIpcError } from '../../electron/main/subtitle-studio/transcription-ipc';
import type { TranscriptionRuntime } from '../../electron/main/subtitle-studio/transcription/runtime';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';
import { createLocalSubtitleError } from '../../src/subtitle-studio/transcription/domain';

const owner = { webContentsId: 7, ownerSessionId: 'owner-retry' };
const taskId = '44444444-4444-4444-8444-444444444444';
const admission = { batchId: '77777777-7777-4777-8777-777777777777', tasks: [] };
function handle(retry: TranscriptionRuntime['tasks']['retry'], payload: unknown) {
  const runtime = { tasks: { retry } } as unknown as TranscriptionRuntime;
  return handleTranscriptionRequest({ method: 'retryTranscriptionTask', payload, sender: {} as never, owner, runtime, alive: () => {} });
}

describe('retrying a transcription task over IPC', () => {
  it('passes the task and only the audio type or device to the runtime, and returns the new batch', async () => {
    const retry = vi.fn(async () => admission);
    await expect(handle(retry, { taskId })).resolves.toEqual({ status: 'admitted', admission });
    await expect(handle(retry, { taskId, audioProfile: 'quiet_whisper_v1' })).resolves.toMatchObject({ status: 'admitted' });
    await expect(handle(retry, { taskId, devicePreference: 'cpu' })).resolves.toMatchObject({ status: 'admitted' });
    expect(retry.mock.calls).toEqual([[owner, taskId, {}], [owner, taskId, { audioProfile: 'quiet_whisper_v1' }], [owner, taskId, { devicePreference: 'cpu' }]]);
    // Nothing else of a request can be changed, and the values are the contract's own.
    for (const payload of [{ taskId, modelId: 'large-v3' }, { taskId, audioProfile: 'loud' }, { taskId, devicePreference: 'gpu' }, { taskId: '../x' }, {}]) {
      await expect(handle(retry, payload), JSON.stringify(payload)).rejects.toBeDefined();
    }
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('answers that the file has to be added again when it was moved or modified, and reports other failures as errors', async () => {
    const changed = vi.fn(async () => { throw createLocalSubtitleError('media_changed', 'The transcribed file was moved or modified.', { stage: 'preflight' }); });
    await expect(handle(changed, { taskId })).resolves.toEqual({ status: 'source_changed' });
    const busy = vi.fn(async () => { throw createLocalSubtitleError('resource_busy', 'This source already has an active transcription.'); });
    const failure = await handle(busy, { taskId }).catch(error => error);
    expect(transcriptionIpcError(failure)).toBe('resource_busy');
  });

  it('is a fixed public method of the Studio bridge', async () => {
    expect(isPublicStudioChannel(STUDIO_CHANNELS.retryTranscriptionTask)).toBe(true);
    const invoke = vi.fn(async () => ({ ok: true, value: { status: 'source_changed' } }));
    const api = createSubtitleStudioApi({ sendSync: () => 'capability', invoke, on: () => undefined, removeListener: () => undefined });
    await expect(api.retryTranscriptionTask({ taskId, devicePreference: 'cpu' })).resolves.toEqual({ ok: true, value: { status: 'source_changed' } });
    expect(invoke).toHaveBeenCalledWith(STUDIO_CHANNELS.retryTranscriptionTask, { capability: 'capability', payload: { taskId, devicePreference: 'cpu' } });
  });
});
