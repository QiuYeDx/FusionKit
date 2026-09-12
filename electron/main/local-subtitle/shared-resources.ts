import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import type { SpeechResourceService } from '../speech-resources/service';
import { LocalSubtitleModelManagerError as SharedModelManagerError } from '../speech-resources/engine/model-manager';
import { LocalSubtitleModelError as SharedModelError } from '../speech-resources/engine/model-manifest';
import { LocalSubtitleModelManagerError } from './model-manager';
import { LocalSubtitleModelError } from './model-manifest';
import { SPEECH_CUDA_PACK_DEFINITION, SPEECH_CUDA_RESOURCE_ID, canonicalResourceId } from '../speech-resources/catalog';
import { LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS, enqueueLocalSubtitleBatchRequestSchema,
  localSubtitleBackendPreviewRequestSchema, localSubtitleTaskIdRequestSchema, localSubtitleCpuRetryRequestSchema } from '../../../src/type/localSubtitleIpc';
import type { LocalSubtitleIpcHandlers } from './ipc';
import { LocalSubtitleAcceleratorManager, LocalSubtitleAcceleratorManagerError,
  LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY } from './accelerator-manager';
import { LocalSubtitleResourceJobManager } from './resource-job';
import { LocalSubtitleSessionRegistry } from './session-registry';
import type { LocalSubtitleOwnerKey } from './authorizations';
import type { LocalSubtitleModelManager } from './model-manager';

type ManagerSurface = Pick<LocalSubtitleModelManager, 'initialize' | 'listManagedResources' | 'importModel' |
  'startResourceInstall' | 'cancelResourceJob' | 'deleteManagedResource' | 'getSessionSnapshot' | 'onResourceEvent' |
  'resolveManagedModel' | 'resolveManagedVad' | 'resolveManagedAccelerator' | 'releaseOwner' | 'waitForIdle' | 'shutdown'>;

/** The legacy IPC deliberately recognizes its own error classes, never arbitrary code-shaped objects. */
function legacyError(error: unknown): never {
  if (error instanceof SharedModelManagerError) throw new LocalSubtitleModelManagerError(error.localSubtitleCode, error.message, error.field);
  if (error instanceof SharedModelError) throw new LocalSubtitleModelError(error.code, error.stage, error.message);
  throw error;
}
function translateResourceErrors<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
  return (...args: Args): Result => {
    try { const result = operation(...args); return result instanceof Promise ? result.catch(legacyError) as Result : result; }
    catch (error) { return legacyError(error); }
  };
}

/** Existing task registry retains its own revision stream; shared jobs are projected into it. */
export function createLegacySharedResources(options: { service: SpeechResourceService; registry: LocalSubtitleSessionRegistry;
  isResourceBusy: (id: string) => boolean; platform?: string; arch?: string }) {
  const { service, registry } = options;
  const raw = service.createClient({ id: 'legacy', isResourceBusy: options.isResourceBusy });
  const client = { ...raw, initialize: translateResourceErrors(raw.initialize), listManagedResources: translateResourceErrors(raw.listManagedResources),
    importModel: translateResourceErrors(raw.importModel), startResourceInstall: translateResourceErrors(raw.startResourceInstall),
    cancelResourceJob: translateResourceErrors(raw.cancelResourceJob), deleteManagedResource: translateResourceErrors(raw.deleteManagedResource),
    getSessionSnapshot: translateResourceErrors(raw.getSessionSnapshot), onResourceEvent: translateResourceErrors(raw.onResourceEvent),
    resolveManagedModel: translateResourceErrors(raw.resolveManagedModel), resolveManagedVad: translateResourceErrors(raw.resolveManagedVad),
    reserveUse: translateResourceErrors(raw.reserveUse), withResourceRead: translateResourceErrors(raw.withResourceRead), status: translateResourceErrors(raw.status) };
  const catalogOwner = Object.freeze({ webContentsId: 0, ownerSessionId: randomUUID() });
  const verifierJobs = new LocalSubtitleResourceJobManager(new LocalSubtitleSessionRegistry());
  const forbidden = async (): Promise<never> => { throw new Error('The legacy shared-resource verifier cannot mutate resources.'); };
  const verifier = new LocalSubtitleAcceleratorManager({ managedResourceRoot: service.managedResourceRoot,
    platform: options.platform, arch: options.arch, resourceJobs: verifierJobs, packs: [SPEECH_CUDA_PACK_DEFINITION],
    downloadResource: forbidden, extractArchive: forbidden, probePack: forbidden, removeDirectory: forbidden, renameDirectory: forbidden });
  const owners = new Map<string, { owner: LocalSubtitleOwnerKey; detach: () => void }>();
  const key = (owner: LocalSubtitleOwnerKey) => JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
  const synchronize = (owner: LocalSubtitleOwnerKey) => {
    const jobs = client.getSessionSnapshot(owner).resourceJobs;
    const current = registry.getSnapshot(owner).resourceJobs;
    const ids = new Set(jobs.map(job => job.jobId));
    for (const job of current) if (!ids.has(job.jobId)) registry.removeResourceJob(owner, job.jobId, new Date().toISOString());
    for (const job of jobs) if (JSON.stringify(current.find(value => value.jobId === job.jobId)) !== JSON.stringify(job)) registry.upsertResourceJob(owner, job);
  };
  function attachOwner(owner: LocalSubtitleOwnerKey) {
    if (owners.has(key(owner))) return;
    const entry = { owner, detach: () => {} }; owners.set(key(owner), entry);
    try { entry.detach = client.onResourceEvent(owner, () => synchronize(owner)); synchronize(owner); }
    catch (error) { entry.detach(); owners.delete(key(owner)); throw error; }
  }
  async function requireVerifierRoots() {
    for (const leaf of ['', 'accelerators', LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.stagingDirectoryName,
      LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.downloadsDirectoryName]) {
      const directory = path.join(service.managedResourceRoot, leaf);
      const stat = await lstat(directory).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || path.resolve(await realpath(directory)) !== path.resolve(directory))
        throw new LocalSubtitleAcceleratorManagerError('accelerator_unavailable', 'Shared accelerator directories are not ready.');
    }
  }
  const adapter: ManagerSurface & { attachOwner: typeof attachOwner; reserveUse: typeof client.reserveUse; status: typeof client.status } = {
    initialize: () => client.initialize(), attachOwner,
    listManagedResources: (owner, signal) => { if (owner) attachOwner(owner); return client.listManagedResources(owner ?? catalogOwner, signal); },
    importModel: input => { attachOwner(input.owner); return client.importModel(input); },
    startResourceInstall: (owner, id) => { attachOwner(owner); return client.startResourceInstall(owner, id); },
    cancelResourceJob: (owner, id) => { attachOwner(owner); return client.cancelResourceJob(owner, id); },
    deleteManagedResource: (owner, id) => { attachOwner(owner); return client.deleteManagedResource(owner, id); },
    getSessionSnapshot: owner => { attachOwner(owner); synchronize(owner); return registry.getSnapshot(owner); },
    onResourceEvent: (owner, listener) => { attachOwner(owner); return registry.onResourceEvent(owner, listener); },
    resolveManagedModel: (id, signal) => client.resolveManagedModel(id, signal),
    resolveManagedVad: (id, signal) => client.resolveManagedVad(id, signal),
    resolveManagedAccelerator: (id, signal) => client.withResourceRead(id, async () => {
      await requireVerifierRoots(); return verifier.resolveManagedAccelerator(canonicalResourceId(id), signal);
    }),
    releaseOwner(owner) { owners.get(key(owner))?.detach(); owners.delete(key(owner)); client.releaseOwner(owner); },
    waitForIdle: () => client.waitForIdle(), reserveUse: ids => client.reserveUse(ids), status: () => client.status(),
    async shutdown() { for (const entry of owners.values()) entry.detach(); owners.clear();
      const results = await Promise.allSettled([client.shutdown(), verifier.shutdown()]);
      const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Legacy resource client cleanup failed.'); },
  };
  return adapter;
}

export type LegacySharedResources = ReturnType<typeof createLegacySharedResources>;

/** Protect shared files before native admission's first asynchronous read. */
export function protectLegacyResourceAdmissions(options: { handlers: NonNullable<LocalSubtitleIpcHandlers['public']>;
  resources: Pick<LegacySharedResources, 'reserveUse'>; registry: LocalSubtitleSessionRegistry; platform?: string }) {
  const result = { ...options.handlers };
  const channels = LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS;
  for (const channel of [channels.enqueue, channels.previewBackend, channels.retryTask, channels.retryTaskOnCpu]) {
    const handler = result[channel]; if (!handler) continue;
    result[channel] = (request, context) => {
      let config: { modelId: string; vadEnabled?: boolean; devicePreference: string } | undefined;
      if (channel === channels.enqueue) config = enqueueLocalSubtitleBatchRequestSchema.parse(request).config;
      else if (channel === channels.previewBackend) config = localSubtitleBackendPreviewRequestSchema.parse(request);
      else {
        const { taskId } = (channel === channels.retryTaskOnCpu ? localSubtitleCpuRetryRequestSchema : localSubtitleTaskIdRequestSchema).parse(request);
        config = options.registry.getSnapshot(context.owner).batches.find(batch => batch.tasks.some(task => task.taskId === taskId))?.config;
        if (config && channel === channels.retryTaskOnCpu) config = { ...config, devicePreference: 'cpu' };
      }
      if (!config) return handler(request, context);
      const use = options.resources.reserveUse([config.modelId,
        ...(config.vadEnabled ? ['silero-vad-v6.2.0-ggml'] : []),
        ...((options.platform ?? process.platform) === 'win32' && ['auto', 'cuda'].includes(config.devicePreference) ? [SPEECH_CUDA_RESOURCE_ID] : [])]);
      try { return Promise.resolve(handler(request, context)).finally(() => use.release()); }
      catch (error) { use.release(); throw error; }
    };
  }
  return result;
}
