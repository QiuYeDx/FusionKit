import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STUDIO_CHANNELS, transcriptionRequestSchemas } from '../../src/subtitle-studio/ipc-contract';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { assertLegacyStudioChannelAllowed, isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '', open: vi.fn(), runtime: undefined as any, create: vi.fn() }));
const dropResolver = vi.hoisted(() => vi.fn(async (paths: readonly string[]) => paths));
vi.mock('../../electron/main/subtitle-studio/transcription/native/windows-explorer-drop-resolver', () => ({ resolveLocalSubtitleInputPaths: dropResolver }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showOpenDialog: adapter.open }, shell: {},
  ipcMain: { on: (channel: string, handler: Function) => adapter.listeners.set(channel, handler), handle: (channel: string, handler: Function) => adapter.handlers.set(channel, handler), removeAllListeners: (channel: string) => adapter.listeners.delete(channel), removeHandler: (channel: string) => adapter.handlers.delete(channel) },
}));
vi.mock('../../electron/main/subtitle-studio/transcription/runtime', () => ({ createTranscriptionRuntime: (...args: unknown[]) => { adapter.create(...args); return adapter.runtime; } }));
import { registerSubtitleStudio } from '../../electron/main/subtitle-studio';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';

let registration: ReturnType<typeof registerSubtitleStudio> | undefined;
let sequence = 0;
const rendererUrl = pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href;
function attach() {
  const sender = Object.assign(new EventEmitter(), { id: ++sequence, mainFrame: { url: rendererUrl }, isDestroyed: () => false, send: vi.fn() });
  registration!.attach(sender as never);
  const event = { sender, senderFrame: sender.mainFrame, returnValue: null as unknown };
  adapter.listeners.get(STUDIO_CHANNELS.register)!(event, {});
  return { sender, capability: event.returnValue, key: { webContentsId: sender.id, ownerSessionId: event.returnValue },
    invoke: (method: keyof typeof STUDIO_CHANNELS, payload: unknown, overrides = {}) => adapter.handlers.get(STUDIO_CHANNELS[method])!({ sender, senderFrame: sender.mainFrame, ...overrides }, { capability: event.returnValue, payload }) };
}
const fileToken = 'media-token';
const media = { fileToken, sourceKey: 'source-key', displayName: 'voice.wav', byteSize: 64000, expiresAt: Date.now() + 60000 };
const probe = { fileToken, displayName: 'voice.wav', durationMs: 1000, audioTracks: [{ streamId: 'audio-0', ordinal: 1, isDefault: true }], autoSelectedStreamId: 'audio-0' };
const config = { modelId: 'fixture-model', devicePreference: 'cpu', language: 'auto', taskMode: 'transcribe', vadEnabled: false,
  advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 80, maxLineChars: 40 } };
const request = { files: [{ fileToken }], config };

beforeEach(async () => {
  adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-transcription-ipc-'));
  adapter.create.mockClear(); adapter.open.mockReset();
  dropResolver.mockReset(); dropResolver.mockImplementation(async paths => paths);
  adapter.runtime = {
    initialize: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), releaseOwner: vi.fn(async () => {}),
    inspectRuntime: vi.fn(async () => ({ status: 'missing', code: 'runtime_missing', stage: 'manifest' })),
    media: { authorizeInput: vi.fn(async () => media), probe: vi.fn(async () => probe), revokeInput: vi.fn(() => true) },
    resources: { list: vi.fn(async () => []), status: vi.fn(() => undefined), delete: vi.fn(async () => ({ deleted: true })), snapshot: vi.fn(() => ({ resourceJobs: [] })), importModel: vi.fn(), install: vi.fn(), cancel: vi.fn(() => ({ cancelled: true })) },
    tasks: { enqueue: vi.fn(async () => ({ batchId: randomUUID(), tasks: [] })), list: vi.fn(() => []), cancel: vi.fn(), remove: vi.fn() },
  };
  registration = registerSubtitleStudio();
});
afterEach(async () => {
  await registration?.dispose(); registration = undefined;
  await rm(adapter.directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Subtitle Studio transcription application IPC', () => {
  it('prepares durable translation recovery only for opted-in enqueue, without blocking media or plain transcription', async () => {
    const client = attach();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const initialize = vi.spyOn(TranslationService.prototype, 'initialize').mockReturnValue(pending);
    const autoTranslation = { config: { model: { profileId: 'controlled', modelKey: 'controlled', endpoint: 'http://127.0.0.1:4567/v1', apiFormat: 'chat_completions' },
      language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 30 }, apiKey: 'ephemeral-test-only' };
    try {
      expect((await client.invoke('enqueueTranscription', request)).ok).toBe(true);
      expect(initialize).not.toHaveBeenCalled();
      const enabled = client.invoke('enqueueTranscription', { ...request, autoTranslation });
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
      expect(adapter.runtime.tasks.enqueue).toHaveBeenCalledTimes(1);
      expect((await client.invoke('probeTranscriptionMedia', { fileToken })).ok).toBe(true);
      finish();
      expect((await enabled).ok).toBe(true);
      expect(adapter.runtime.tasks.enqueue).toHaveBeenLastCalledWith(client.key, { ...request, autoTranslation });
      const dependencies = adapter.create.mock.calls[0][1];
      expect(dependencies.automaticTranslation).toMatchObject({ initialize: expect.any(Function), handoff: expect.any(Function), shutdown: expect.any(Function) });
    } finally { finish(); }
  });

  it('fences opted-in admission synchronously on shutdown and joins initialization before disposing translation', async () => {
    const client = attach();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(TranslationService.prototype, 'initialize').mockReturnValue(pending);
    const disposeTranslation = vi.spyOn(TranslationService.prototype, 'dispose');
    await client.invoke('listTranscriptionTasks', {});
    const coordinator = adapter.create.mock.calls[0][1].automaticTranslation;
    const preparing = coordinator.initialize();
    try {
      const closing = registration!.dispose(); const settled = vi.fn(); void closing.then(settled);
      await expect(coordinator.handoff(randomUUID(), randomUUID(), 'ephemeral-test-only')).rejects.toMatchObject({ code: 'interrupted' });
      await Promise.resolve();
      expect(disposeTranslation).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
      expect(adapter.handlers.has(STUDIO_CHANNELS.dropTranscriptionMedia)).toBe(false);
      finish(); await preparing; await closing;
      expect(disposeTranslation).toHaveBeenCalledOnce(); expect(adapter.runtime.shutdown).toHaveBeenCalledOnce();
    } finally { finish(); }
  });

  it('imports a dropped media batch through the picker authority, preserving partial probe failures and original names', async () => {
    const client = attach();
    const backing = path.join(adapter.directory, 'voice (1).wav');
    const original = path.join(adapter.directory, 'voice.wav');
    const invalid = path.join(adapter.directory, 'no-audio.mp4');
    const folder = path.join(adapter.directory, 'folder');
    await writeFile(backing, 'controlled backing'); await writeFile(original, 'controlled source'); await writeFile(invalid, 'controlled video'); await mkdir(folder);
    dropResolver.mockResolvedValue([original, original, invalid]);
    adapter.runtime.media.probe.mockResolvedValueOnce(probe).mockRejectedValueOnce({ code: 'unsupported_media', message: adapter.directory });
    const result = await client.invoke('dropTranscriptionMedia', { paths: [backing, backing, folder, invalid, path.join(adapter.directory, 'missing.wav')] });
    expect(result).toEqual({ ok: true, value: { items: [
      { displayName: 'voice.wav', ok: true, media, probe },
      { displayName: 'folder', ok: false, error: 'invalid_input' },
      { displayName: 'no-audio.mp4', ok: false, error: 'unsupported_feature', media },
      { displayName: 'missing.wav', ok: false, error: 'document_unavailable' },
    ] } });
    expect(adapter.open).not.toHaveBeenCalled();
    expect(adapter.runtime.media.authorizeInput.mock.calls).toEqual([[client.key, original], [client.key, invalid]]);
    expect(JSON.stringify(result)).not.toContain(adapter.directory);
  });

  it('rejects untrusted frames and malformed media captures before authorization', async () => {
    const client = attach();
    const payload = { paths: [path.join(adapter.directory, 'voice.wav')] };
    expect(await client.invoke('dropTranscriptionMedia', payload, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    expect(await client.invoke('dropTranscriptionMedia', { ...payload, source: 'picker' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await client.invoke('dropTranscriptionMedia', { paths: Array(21).fill(payload.paths[0]) })).toEqual({ ok: false, error: 'invalid_input' });
    expect(adapter.create).not.toHaveBeenCalled(); expect(dropResolver).not.toHaveBeenCalled();
  });

  it('keeps ambiguous Shell proxies untrusted and fences a resolved batch after navigation', async () => {
    const client = attach(); const backing = path.join(adapter.directory, 'voice.wav'); await writeFile(backing, 'controlled');
    dropResolver.mockRejectedValueOnce(new Error('Ambiguous original.'));
    expect(await client.invoke('dropTranscriptionMedia', { paths: [backing] })).toEqual({ ok: true, value: { items: [{ displayName: 'voice.wav', ok: false, error: 'access_denied' }] } });
    expect(adapter.runtime.media.authorizeInput).not.toHaveBeenCalled();
    let finish!: (paths: readonly string[]) => void;
    dropResolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.invoke('dropTranscriptionMedia', { paths: [backing] });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.sender.emit('did-start-navigation', {}, rendererUrl, false, true);
    finish([backing]);
    expect(await pending).toEqual({ ok: false, error: 'access_denied' });
    expect(adapter.runtime.media.authorizeInput).not.toHaveBeenCalled();
  });

  it('exposes only the narrow shared status DTO through the resource list', async () => {
    const client = attach();
    adapter.runtime.resources.status.mockReturnValue({ shared: true, revision: 3, busyResourceIds: ['model'], cleanupPending: false,
      migrationIssues: [{ code: 'invalid_source', resourceId: 'model', sourceRoot: 'private-source', message: adapter.directory }] });
    expect(await client.invoke('listTranscriptionResources', {})).toEqual({ ok: true, value: { resources: [], jobs: [],
      shared: { shared: true, revision: 3, busyResourceIds: ['model'], migrationIssues: [{ code: 'invalid_source', resourceId: 'model' }], cleanupPending: false } } });
  });
  it('authorizes fixed shared deletion, rejects paths and keeps busy errors explicit', async () => {
    const client = attach();
    expect(await client.invoke('deleteTranscriptionResource', { resourceId: 'model', path: '/forged.bin' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(adapter.runtime.resources.delete).not.toHaveBeenCalled();
    expect(await client.invoke('deleteTranscriptionResource', { resourceId: 'model' })).toEqual({ ok: true, value: { deleted: true } });
    expect(adapter.runtime.resources.delete).toHaveBeenCalledWith(client.key, 'model');
    adapter.runtime.resources.delete.mockRejectedValue({ code: 'resource_busy', message: 'private details' });
    expect(await client.invoke('deleteTranscriptionResource', { resourceId: 'model' })).toEqual({ ok: false, error: 'resource_busy' });
    expect(await client.invoke('deleteTranscriptionResource', { resourceId: 'model' }, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
  });
  it('constructs no runtime until transcription is requested and keeps paths inside main pickers', async () => {
    const client = attach(); expect(adapter.create).not.toHaveBeenCalled();
    adapter.open.mockResolvedValue({ canceled: false, filePaths: [path.join(adapter.directory, 'voice.wav')] });
    expect(await client.invoke('selectTranscriptionMedia', {})).toEqual({ ok: true, value: { items: [{ displayName: 'voice.wav', ok: true, media, probe }] } });
    expect(adapter.runtime.media.authorizeInput).toHaveBeenCalledWith(client.key, path.join(adapter.directory, 'voice.wav'));
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(await client.invoke('revokeTranscriptionMedia', { fileToken })).toEqual({ ok: true, value: { revoked: true } });
    expect(adapter.runtime.media.revokeInput).toHaveBeenCalledWith(client.key, fileToken);
    expect(JSON.stringify(await client.invoke('inspectTranscriptionRuntime', {}))).not.toContain(adapter.directory);
  });

  it('rejects raw paths, extra options, subframes and stolen capabilities before native work', async () => {
    const client = attach(); const other = attach();
    expect(await client.invoke('selectTranscriptionMedia', { path: '/forged.wav' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await client.invoke('importTranscriptionModel', { modelId: 'fixture', path: '/forged.bin', mode: 'move' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await client.invoke('enqueueTranscription', { ...request, outputPath: '/forged.srt' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await client.invoke('listTranscriptionTasks', {}, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    const stolen = await adapter.handlers.get(STUDIO_CHANNELS.listTranscriptionTasks)!({ sender: other.sender, senderFrame: other.sender.mainFrame }, { capability: client.capability, payload: {} });
    expect(stolen).toEqual({ ok: false, error: 'access_denied' });
    expect(adapter.create).not.toHaveBeenCalled(); expect(adapter.open).not.toHaveBeenCalled();
  });

  it('retains an issued token on failed probe and never exposes diagnostic paths', async () => {
    const client = attach();
    adapter.open.mockResolvedValue({ canceled: false, filePaths: [path.join(adapter.directory, 'voice.wav')] });
    adapter.runtime.media.probe.mockRejectedValue(new Error(`private ${adapter.directory}`));
    expect(await client.invoke('selectTranscriptionMedia', {})).toEqual({ ok: true, value: { items: [{ displayName: 'voice.wav', ok: false, error: 'transcription_failed', media }] } });
    const result = await client.invoke('revokeTranscriptionMedia', { fileToken }); expect(result.ok).toBe(true);
  });

  it('re-probes an existing token with its private owner and rejects paths or stale frames', async () => {
    const client = attach();
    expect(await client.invoke('probeTranscriptionMedia', { fileToken })).toEqual({ ok: true, value: probe });
    expect(adapter.runtime.media.probe).toHaveBeenCalledWith(client.key, fileToken);
    expect(await client.invoke('probeTranscriptionMedia', { fileToken, path: '/forged.wav' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await client.invoke('probeTranscriptionMedia', { fileToken }, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    adapter.runtime.media.probe.mockRejectedValue({ code: 'authorization_invalid' });
    expect(await client.invoke('probeTranscriptionMedia', { fileToken: 'foreign-token' })).toEqual({ ok: false, error: 'access_denied' });
    expect(adapter.runtime.media.probe).toHaveBeenCalledTimes(2);
  });

  it('fences a delayed probe after navigation and rejects invalid native summaries', async () => {
    const client = attach();
    adapter.runtime.media.probe.mockResolvedValueOnce({ ...probe, privatePath: adapter.directory });
    expect(await client.invoke('probeTranscriptionMedia', { fileToken })).toEqual({ ok: false, error: 'transcription_failed' });
    let finish!: (value: unknown) => void;
    adapter.runtime.media.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const work = client.invoke('probeTranscriptionMedia', { fileToken });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.sender.emit('did-start-navigation', {}, rendererUrl, false, true);
    finish(probe);
    expect(await work).toEqual({ ok: false, error: 'access_denied' });
  });

  it('routes task controls with the private owner and keeps model import copy-only in main', async () => {
    const client = attach(); const taskId = randomUUID();
    expect((await client.invoke('enqueueTranscription', request)).ok).toBe(true);
    expect(adapter.runtime.tasks.enqueue).toHaveBeenCalledWith(client.key, request);
    await client.invoke('listTranscriptionTasks', {}); await client.invoke('cancelTranscriptionTask', { taskId });
    expect(adapter.runtime.tasks.cancel).toHaveBeenCalledWith(client.key, taskId);
    expect(await client.invoke('removeTranscriptionTask', { taskId })).toEqual({ ok: true, value: null });
    const modelPath = path.join(adapter.directory, 'model.bin');
    adapter.open.mockResolvedValue({ canceled: false, filePaths: [modelPath] });
    adapter.runtime.resources.importModel.mockResolvedValue({ jobId: 'job-model', resourceId: 'fixture-model', resourceType: 'model', status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect((await client.invoke('importTranscriptionModel', { modelId: 'fixture-model' })).ok).toBe(true);
    expect(adapter.runtime.resources.importModel).toHaveBeenCalledWith({ owner: client.key, filePath: modelPath, modelId: 'fixture-model' });
  });

  it('bounds picker admission and redacts resource job diagnostics to a stable error code', async () => {
    const client = attach();
    adapter.open.mockResolvedValue({ canceled: false, filePaths: Array.from({ length: 21 }, (_, i) => path.join(adapter.directory, `${i}.wav`)) });
    expect(await client.invoke('selectTranscriptionMedia', {})).toEqual({ ok: false, error: 'limit_exceeded' });
    expect(adapter.runtime.media.authorizeInput).not.toHaveBeenCalled();
    const job = { jobId: 'job-model', resourceId: 'fixture-model', resourceType: 'model', status: 'failed', progress: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      error: { code: 'model_download_failed', stage: 'resource', retryable: true, message: `Failed in ${adapter.directory}` } };
    adapter.runtime.resources.snapshot.mockReturnValue({ resourceJobs: [job] });
    const result = await client.invoke('listTranscriptionResources', {});
    expect(result).toMatchObject({ ok: true, value: { jobs: [{ error: { code: 'model_download_failed' } }] } });
    expect(result.value.jobs[0].error).toEqual({ code: 'model_download_failed' });
    expect(JSON.stringify(result)).not.toContain(adapter.directory);
  });

  it('fences delayed dialogs on navigation and replaces owner sessions without reusing authority', async () => {
    const client = attach();
    let finish!: (selection: unknown) => void;
    adapter.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const work = client.invoke('selectTranscriptionMedia', {});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.sender.emit('did-start-navigation', {}, rendererUrl, false, true);
    expect(adapter.runtime.releaseOwner).toHaveBeenCalledWith(client.key);
    finish({ canceled: false, filePaths: [path.join(adapter.directory, 'voice.wav')] });
    expect(await work).toEqual({ ok: false, error: 'access_denied' });
    expect(adapter.runtime.media.authorizeInput).not.toHaveBeenCalled();
    const event = { sender: client.sender, senderFrame: client.sender.mainFrame, returnValue: null };
    adapter.listeners.get(STUDIO_CHANNELS.register)!(event, {});
    expect(event.returnValue).not.toBe(client.capability);
    expect(await client.invoke('listTranscriptionTasks', {})).toEqual({ ok: false, error: 'access_denied' });
  });

  it('awaits native shutdown and owner cleanup while synchronously closing the IPC surface', async () => {
    const client = attach(); await client.invoke('listTranscriptionTasks', {});
    let finish!: () => void;
    adapter.runtime.shutdown.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const work = registration!.dispose('update'); const settled = vi.fn(); void work.then(settled);
    expect(registration!.dispose()).toBe(work);
    expect(adapter.handlers.size).toBe(0); expect(adapter.runtime.releaseOwner).toHaveBeenCalledWith(client.key);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect(settled).not.toHaveBeenCalled();
    finish(); await work; expect(adapter.runtime.shutdown).toHaveBeenCalledWith('update');
  });

  it('still shuts down after synchronous owner retirement failure and permits a cleanup retry', async () => {
    const client = attach(); await client.invoke('listTranscriptionTasks', {});
    const failure = new Error('owner retirement failed');
    adapter.runtime.releaseOwner.mockImplementationOnce(() => { throw failure; });
    await expect(registration!.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(adapter.runtime.shutdown).toHaveBeenCalledOnce();
    await registration!.dispose(); expect(adapter.runtime.shutdown).toHaveBeenCalledTimes(2);
  });

  it('exposes only fixed channels and keeps legacy invokes out of the entire Studio namespace', async () => {
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc);
    for (const method of Object.keys(transcriptionRequestSchemas) as (keyof typeof transcriptionRequestSchemas)[]) {
      expect(isPublicStudioChannel(STUDIO_CHANNELS[method])).toBe(true);
      expect(() => assertLegacyStudioChannelAllowed(STUDIO_CHANNELS[method])).toThrow();
    }
    for (const channel of [STUDIO_CHANNELS.register, STUDIO_CHANNELS.changed, 'subtitle-studio:transcription:internal:authorize-input-files', `${STUDIO_CHANNELS.enqueueTranscription}:extra`]) expect(isPublicStudioChannel(channel)).toBe(false);
    await api.listTranscriptionTasks({}); await api.selectTranscriptionMedia({}); await api.probeTranscriptionMedia({ fileToken });
    expect(ipc.invoke.mock.calls).toEqual([[STUDIO_CHANNELS.listTranscriptionTasks, { capability, payload: {} }], [STUDIO_CHANNELS.selectTranscriptionMedia, { capability, payload: {} }], [STUDIO_CHANNELS.probeTranscriptionMedia, { capability, payload: { fileToken } }]]);
    expect(Object.isFrozen(api)).toBe(true); expect('invoke' in api || 'capability' in api).toBe(false);
  });
});
