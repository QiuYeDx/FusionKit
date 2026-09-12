import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { assertLegacyStudioChannelAllowed, isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';
import { droppedTranscriptionMediaRequestSchema, STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';

describe('native transcription media drop capability', () => {
  it('consumes the native File batch before yielding without exposing a raw-path invoke', async () => {
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true, value: { items: [] } })), on: vi.fn(), removeListener: vi.fn() };
    const one = {} as File, two = {} as File;
    const nativeFiles = new Map([[one, 'C:\\selected\\one.wav'], [two, 'C:\\selected\\two.mp4']]);
    const getPathForFile = vi.fn((file: File) => { const value = nativeFiles.get(file); if (!value) throw new TypeError('Not a native File.'); return value; });
    const api = createSubtitleStudioApi(ipc, { getPathForFile });
    const work = api.dropTranscriptionMedia([one, two]);
    nativeFiles.clear();
    expect(getPathForFile.mock.calls.map(([file]) => file)).toEqual([one, two]);
    expect(ipc.invoke).toHaveBeenCalledWith(STUDIO_CHANNELS.dropTranscriptionMedia, { capability, payload: { paths: ['C:\\selected\\one.wav', 'C:\\selected\\two.mp4'] } });
    expect(await work).toEqual({ ok: true, value: { items: [] } });
    expect(isPublicStudioChannel(STUDIO_CHANNELS.dropTranscriptionMedia)).toBe(false);
    expect(() => assertLegacyStudioChannelAllowed(STUDIO_CHANNELS.dropTranscriptionMedia)).toThrow();
    expect(Object.keys(api)).not.toContain('invoke');
  });

  it('rejects synthetic/forged inputs, expired bridge and more than twenty files before native IPC', async () => {
    const ipc = { sendSync: () => randomUUID(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc, { getPathForFile: () => { throw new TypeError('No OS backing.'); } });
    expect(await api.dropTranscriptionMedia([{ path: 'C:\\forged.wav' } as unknown as File])).toEqual({ ok: false, error: 'access_denied' });
    expect(await api.dropTranscriptionMedia([])).toEqual({ ok: false, error: 'invalid_input' });
    expect(await api.dropTranscriptionMedia(Array(21).fill({}))).toEqual({ ok: false, error: 'limit_exceeded' });
    expect(await createSubtitleStudioApi(ipc, { getPathForFile: () => '' }).dropTranscriptionMedia([{} as File])).toEqual({ ok: false, error: 'access_denied' });
    expect(await createSubtitleStudioApi({ ...ipc, sendSync: () => null }, { getPathForFile: () => 'C:\\x.wav' }).dropTranscriptionMedia([{} as File])).toEqual({ ok: false, error: 'access_denied' });
    for (const value of [{ paths: ['x\0y'] }, { paths: ['C:\\x.wav'], source: 'picker' }, { paths: Array(21).fill('C:\\x.wav') }]) expect(droppedTranscriptionMediaRequestSchema.safeParse(value).success).toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
