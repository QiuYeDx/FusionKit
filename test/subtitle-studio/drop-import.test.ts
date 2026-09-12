import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { assertLegacyStudioChannelAllowed, isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';
import { droppedSubtitlesRequestSchema, requestSchemas, STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';

const resolver = vi.hoisted(() => vi.fn(async (paths: readonly string[]) => paths));
vi.mock('../../electron/main/subtitle-studio/transcription/native/windows-explorer-drop-resolver', () => ({ resolveLocalSubtitleInputPaths: resolver }));
import { resolveDroppedSubtitlePaths } from '../../electron/main/subtitle-studio/drop-input-service';

const roots: string[] = [];
afterEach(async () => {
  resolver.mockReset(); resolver.mockImplementation(async paths => paths);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
});

describe('subtitle File drop bridge', () => {
  it('captures all paths synchronously through webUtils and keeps its channel internal', async () => {
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true, value: { items: [] } })), on: vi.fn(), removeListener: vi.fn() };
    const one = {} as File; const two = {} as File;
    const files = new Map([[one, 'C:\\selected\\one.vtt'], [two, 'C:\\selected\\two.ass']]);
    const webUtils = { getPathForFile: vi.fn((file: File) => { if (!files.has(file)) throw new TypeError('Not a native File.'); return files.get(file)!; }) };
    const api = createSubtitleStudioApi(ipc, webUtils);
    const result = api.importDroppedSubtitles([one, two], { encoding: 'utf-8' });
    expect(webUtils.getPathForFile.mock.calls.map(([file]) => file)).toEqual([one, two]);
    expect(ipc.invoke).toHaveBeenCalledWith(STUDIO_CHANNELS.importDroppedSubtitles, { capability, payload: { encoding: 'utf-8', paths: [...files.values()] } });
    expect(await result).toMatchObject({ ok: true });
    expect(isPublicStudioChannel(STUDIO_CHANNELS.importDroppedSubtitles)).toBe(false);
    expect(isPublicStudioChannel(STUDIO_CHANNELS.register)).toBe(false);
    for (const method of Object.keys(requestSchemas) as (keyof typeof requestSchemas)[]) expect(isPublicStudioChannel(STUDIO_CHANNELS[method])).toBe(true);
    expect(() => assertLegacyStudioChannelAllowed(STUDIO_CHANNELS.importDroppedSubtitles)).toThrow();
    expect(Object.keys(api)).not.toContain('invoke');
    expect(Object.keys(api)).not.toContain('capability');
  });
  it('rejects forged paths, synthetic Files, empty/oversized batches and malformed options before IPC', async () => {
    const ipc = { sendSync: () => randomUUID(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc, { getPathForFile: () => { throw new TypeError('Not a native File.'); } });
    expect(await api.importDroppedSubtitles([{ path: 'C:\\forged.ass' } as unknown as File], { encoding: 'utf-8' })).toEqual({ ok: false, error: 'access_denied' });
    expect(await api.importDroppedSubtitles([], { encoding: 'utf-8' })).toMatchObject({ ok: false });
    expect(await api.importDroppedSubtitles(Array(101).fill({}), { encoding: 'utf-8' })).toEqual({ ok: false, error: 'limit_exceeded' });
    expect(await api.importDroppedSubtitles([{} as File], { encoding: 'utf-8', paths: ['C:\\forged.ass'] } as never)).toMatchObject({ ok: false });
    expect(await createSubtitleStudioApi(ipc, { getPathForFile: () => '' }).importDroppedSubtitles([{} as File], { encoding: 'utf-8' })).toMatchObject({ ok: false });
    expect(ipc.invoke).not.toHaveBeenCalled();
    for (const value of [{ encoding: 'utf-8', paths: ['x\0y'] }, { encoding: 'utf-8', paths: [], source: 'picker' }]) expect(droppedSubtitlesRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe('drop selection before document reading', () => {
  it('isolates missing paths and directories without discarding valid files, and uses resolved original names', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-drop-')); roots.push(root);
    const original = path.join(root, 'original.ass'); const backing = path.join(root, 'original (1).ass'); const folder = path.join(root, 'folder');
    await writeFile(backing, 'subtitle'); await mkdir(folder);
    resolver.mockResolvedValueOnce([original]);
    const result = await resolveDroppedSubtitlePaths([backing, folder, path.join(root, 'missing.srt')]);
    expect(result).toEqual([{ fileName: 'original.ass', path: original }, { fileName: 'folder', error: 'invalid_input' }, { fileName: 'missing.srt', error: 'document_unavailable' }]);
    expect(resolver).toHaveBeenCalledWith([backing], 'drop');
  });
  it('does not authorize guessed temporary source paths when original recovery fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-drop-')); roots.push(root);
    const backing = path.join(root, 'proxy.vtt'); await writeFile(backing, 'WEBVTT');
    resolver.mockRejectedValueOnce(new Error('Ambiguous Explorer source.'));
    expect(await resolveDroppedSubtitlePaths([backing, 'relative.srt'])).toEqual([{ fileName: 'proxy.vtt', error: 'access_denied' }, { fileName: 'relative.srt', error: 'access_denied' }]);
  });
});
