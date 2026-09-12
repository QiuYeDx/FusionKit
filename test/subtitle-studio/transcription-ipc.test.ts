import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STUDIO_CHANNELS, transcriptionRequestSchemas } from '../../src/subtitle-studio/ipc-contract';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { assertLegacyStudioChannelAllowed, isPublicStudioChannel } from '../../electron/preload/subtitle-studio-channel-policy';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '', open: vi.fn(), runtime: undefined as any, create: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showOpenDialog: adapter.open }, shell: {},
  ipcMain: { on: (channel: string, handler: Function) => adapter.listeners.set(channel, handler), handle: (channel: string, handler: Function) => adapter.handlers.set(channel, handler), removeAllListeners: (channel: string) => adapter.listeners.delete(channel), removeHandler: (channel: string) => adapter.handlers.delete(channel) },
}));
vi.mock('../../electron/main/subtitle-studio/transcription/runtime', () => ({ createTranscriptionRuntime: (...args: unknown[]) => { adapter.create(...args); return adapter.runtime; } }));
import { registerSubtitleStudio } from '../../electron/main/subtitle-studio';

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
});

describe('Subtitle Studio transcription application IPC', () => {
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
