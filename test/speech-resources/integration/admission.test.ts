import { describe, expect, it } from 'vitest';
import { protectLegacyResourceAdmissions } from '../../../electron/main/local-subtitle/shared-resources';
import { LocalSubtitleSessionRegistry } from '../../../electron/main/local-subtitle/session-registry';
import type { LocalSubtitleIpcHandlerContext } from '../../../electron/main/local-subtitle/ipc';
import { LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS as channels, localSubtitleIpcSuccess } from '../../../src/type/localSubtitleIpc';
import { SPEECH_CUDA_RESOURCE_ID } from '../../../electron/main/speech-resources/catalog';

const context = { owner: { webContentsId: 1, ownerSessionId: 'admission-owner' } } as LocalSubtitleIpcHandlerContext;
describe('legacy shared resource admission fence', () => {
  it.each(['win32', 'darwin'])('takes the use lease synchronously and retains it until %s admission settles', async platform => {
    let active = false, ids: readonly string[] = [], finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const handlers = protectLegacyResourceAdmissions({ registry: new LocalSubtitleSessionRegistry(), platform,
      resources: { reserveUse(values) { ids = values; active = true; return { release() { active = false; } }; } },
      handlers: { [channels.previewBackend]: async () => { expect(active).toBe(true); await gate; return localSubtitleIpcSuccess({}); } } });
    const result = handlers[channels.previewBackend]!({ modelId: 'large-v3-q5_0', devicePreference: 'auto' }, context);
    expect(active).toBe(true); expect(ids).toEqual(platform === 'win32' ? ['large-v3-q5_0', SPEECH_CUDA_RESOURCE_ID] : ['large-v3-q5_0']);
    finish(); await result; expect(active).toBe(false);
  });
  it.each([false, true])('releases a failed admission lease (async: %s)', async asynchronous => {
    let active = false; const error = new Error('original admission failure');
    const handlers = protectLegacyResourceAdmissions({ registry: new LocalSubtitleSessionRegistry(),
      resources: { reserveUse() { active = true; return { release() { active = false; } }; } },
      handlers: { [channels.previewBackend]: () => { if (asynchronous) return Promise.reject(error); throw error; } } });
    const run = () => handlers[channels.previewBackend]!({ modelId: 'large-v3-q5_0', devicePreference: 'cpu' }, context);
    if (asynchronous) await expect(run()).rejects.toBe(error); else expect(run).toThrow(error);
    expect(active).toBe(false);
  });
});
