import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { installSpeechResourceWindowBridge } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import { SPEECH_RESOURCES_CHANGED, SPEECH_RESOURCES_STATUS } from '../../../src/speech-resources/events';

describe('shared resource main-window bridge', () => {
  it('only exposes path-free status to the trusted application main frame', () => {
    let changed!: (revision: number) => void;
    const send = vi.fn(), detach = vi.fn(), removeHandler = vi.fn(), handle = vi.fn();
    const frame = { url: 'file:///app/index.html#/studio' }, sender = { mainFrame: frame, isDestroyed: () => false, send };
    const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
    const close = installSpeechResourceWindowBridge({ rendererUrl: 'file:///app/index.html', getWindow: () => window,
      ipc: { handle, removeHandler }, service: { onChanged(listener) { changed = listener; return detach; },
        status: () => ({ shared: true, revision: 7, busyResourceIds: ['large-v3-q5_0'], cleanupPending: false,
          mutationResourceId: undefined, migrationIssues: [{ code: 'invalid_source', resourceId: 'model', message: 'private-path', sourceRoot: 'local-subtitle' }] }) } });
    const query = handle.mock.calls[0][1]; expect(handle.mock.calls[0][0]).toBe(SPEECH_RESOURCES_STATUS);
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(query(event, {})).toEqual({ shared: true, revision: 7, busyResourceIds: ['large-v3-q5_0'], cleanupPending: false,
      migrationIssues: [{ code: 'invalid_source', resourceId: 'model' }] });
    for (const request of [undefined, null, [], { path: 'private' }]) expect(() => query(event, request)).toThrow();
    expect(() => query({ sender: {}, senderFrame: frame }, {})).toThrow();
    expect(() => query({ sender, senderFrame: { url: frame.url } }, {})).toThrow();
    changed(8); expect(send).toHaveBeenCalledWith(SPEECH_RESOURCES_CHANGED, { revision: 8 });
    frame.url = 'https://foreign.example/'; changed(9); expect(send).toHaveBeenCalledTimes(1);
    expect(() => query(event, {})).toThrow();
    close(); expect(detach).toHaveBeenCalledOnce(); expect(removeHandler).toHaveBeenCalledWith(SPEECH_RESOURCES_STATUS);
  });
});
