import { expect, it, vi } from 'vitest';
import { createSpeechResourcesApi, assertLegacySpeechResourcesChannelAllowed } from '../../electron/preload/speech-resources-api';
import { SPEECH_RESOURCES_CHANGED, SPEECH_RESOURCES_STATUS, speechResourceIsBusy } from '../../src/speech-resources/events';

it('exposes only a fixed status read and validated revision events, with exact listener disposal', async () => {
  let receive!: (event: unknown, payload: unknown) => void;
  const ipc = { invoke: vi.fn(async () => ({ shared: true })), on: vi.fn((channel, listener) => { expect(channel).toBe(SPEECH_RESOURCES_CHANGED); receive = listener; }), removeListener: vi.fn() };
  const api = createSpeechResourcesApi(ipc); const listener = vi.fn(); const dispose = api.onChanged(listener);
  await api.getStatus(); expect(ipc.invoke).toHaveBeenCalledWith(SPEECH_RESOURCES_STATUS, {});
  for (const bad of [null, [], { revision: 1, path: 'private' }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, Object.create({ revision: 3 })]) receive({ sender: 'private' }, bad);
  expect(listener).not.toHaveBeenCalled();
  receive({ sender: 'private' }, { revision: 8 }); expect(listener).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledWith({ revision: 8 });
  dispose(); dispose(); receive({}, { revision: 9 });
  expect(ipc.removeListener).toHaveBeenCalledOnce(); expect(ipc.removeListener).toHaveBeenCalledWith(SPEECH_RESOURCES_CHANGED, receive);
  expect(listener).toHaveBeenCalledOnce();
  for (const channel of [SPEECH_RESOURCES_CHANGED, SPEECH_RESOURCES_STATUS, 'speech-resources:delete']) expect(() => assertLegacySpeechResourcesChannelAllowed(channel)).toThrow('restricted');
  expect(() => assertLegacySpeechResourcesChannelAllowed('app:version')).not.toThrow();
});

it('matches only fixed CUDA aliases and blocks global mutation/cleanup without broad ID matching', () => {
  const status = { shared: true as const, revision: 1, busyResourceIds: ['speech-windows-x64-cuda-12.4-v1'], migrationIssues: [], cleanupPending: false };
  expect(speechResourceIsBusy(status, 'local-subtitle-windows-x64-cuda-12.4-v1')).toBe(true);
  expect(speechResourceIsBusy(status, 'subtitle-studio-windows-x64-cuda-12.4-v1')).toBe(true);
  expect(speechResourceIsBusy(status, 'unrelated-cuda-pack')).toBe(false);
  expect(speechResourceIsBusy({ ...status, mutationResourceId: 'model' }, 'other')).toBe(true);
  expect(speechResourceIsBusy({ ...status, cleanupPending: true }, 'other')).toBe(true);
});
