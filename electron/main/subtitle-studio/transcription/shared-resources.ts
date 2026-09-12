import { SpeechResourceSmokeError, LOCAL_SUBTITLE_ERROR_CODES,
  type SpeechResourceModelSmoke, type SpeechResourceVadSmoke } from '../../../../src/speech-resources/contracts';
import { LocalSubtitleServerSupervisor } from './native/server-supervisor';
import { createLocalSubtitleServerSession } from './native/server-session';
import { verifyLocalSubtitleRuntimeBundle, selectLocalSubtitleCpuServerArtifactId,
  type LocalSubtitleResourceEnvironment } from './native/resource-path';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import type { SpeechResourceService } from '../../speech-resources/service';
import { SPEECH_CUDA_PACK_DEFINITION, canonicalResourceId } from '../../speech-resources/catalog';
import { cleanupSpeechResourceSessionStartupOrphans } from '../../speech-resources/engine/resource-startup-cleaner';
import { LocalSubtitleAcceleratorManager, LocalSubtitleAcceleratorManagerError,
  LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY } from './native/accelerator-manager';
import { LocalSubtitleResourceJobManager } from './native/resource-job';
import { LocalSubtitleSessionRegistry } from './native/session-registry';
import type { LocalSubtitleModelManager } from './native/model-manager';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { SPEECH_RESOURCES_CHANGED, SPEECH_RESOURCES_STATUS } from '../../../../src/speech-resources/events';

type ManagerSurface = Pick<LocalSubtitleModelManager, 'initialize' | 'listManagedResources' | 'importModel' |
  'startResourceInstall' | 'cancelResourceJob' | 'deleteManagedResource' | 'getSessionSnapshot' | 'onResourceEvent' |
  'resolveManagedModel' | 'resolveManagedVad' | 'resolveManagedAccelerator' | 'releaseOwner' | 'waitForIdle' | 'shutdown'>;

/** Only the private domain verifier issues a CUDA brand; installs belong to the app service. */
export function createStudioSharedResources(options: { service: SpeechResourceService; isResourceBusy: (id: string) => boolean;
  platform?: string; arch?: string }) {
  const { service } = options, client = service.createClient({ id: 'studio', isResourceBusy: options.isResourceBusy });
  const catalogOwner = Object.freeze({ webContentsId: 0, ownerSessionId: randomUUID() });
  const verifierJobs = new LocalSubtitleResourceJobManager(new LocalSubtitleSessionRegistry());
  const forbidden = async (): Promise<never> => { throw new Error('The Studio shared-resource verifier cannot mutate resources.'); };
  const verifier = new LocalSubtitleAcceleratorManager({ managedResourceRoot: service.managedResourceRoot,
    platform: options.platform, arch: options.arch, resourceJobs: verifierJobs, packs: [SPEECH_CUDA_PACK_DEFINITION],
    downloadResource: forbidden, extractArchive: forbidden, probePack: forbidden, removeDirectory: forbidden, renameDirectory: forbidden });
  async function requireVerifierRoots() {
    for (const leaf of ['', 'accelerators', LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.stagingDirectoryName,
      LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.downloadsDirectoryName]) {
      const directory = path.join(service.managedResourceRoot, leaf), stat = await lstat(directory).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || path.resolve(await realpath(directory)) !== path.resolve(directory))
        throw new LocalSubtitleAcceleratorManagerError('accelerator_unavailable', 'Shared accelerator directories are not ready.');
    }
  }
  const adapter: ManagerSurface & { reserveUse: typeof client.reserveUse; status: typeof client.status } = {
    initialize: () => client.initialize(), listManagedResources: (owner, signal) => client.listManagedResources(owner ?? catalogOwner, signal),
    importModel: input => client.importModel(input), startResourceInstall: (owner, id) => client.startResourceInstall(owner, id),
    cancelResourceJob: (owner, id) => client.cancelResourceJob(owner, id), deleteManagedResource: (owner, id) => client.deleteManagedResource(owner, id),
    getSessionSnapshot: owner => client.getSessionSnapshot(owner), onResourceEvent: (owner, listener) => client.onResourceEvent(owner, listener),
    resolveManagedModel: (id, signal) => client.resolveManagedModel(id, signal), resolveManagedVad: (id, signal) => client.resolveManagedVad(id, signal),
    resolveManagedAccelerator: (id, signal) => client.withResourceRead(id, async () => {
      await requireVerifierRoots(); return verifier.resolveManagedAccelerator(canonicalResourceId(id), signal);
    }),
    releaseOwner: owner => client.releaseOwner(owner), waitForIdle: () => client.waitForIdle(),
    reserveUse: ids => client.reserveUse(ids), status: () => client.status(),
    async shutdown() { const results = await Promise.allSettled([client.shutdown(), verifier.shutdown()]);
      const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Studio resource client cleanup failed.'); },
  };
  return adapter;
}

export type StudioSharedResources = ReturnType<typeof createStudioSharedResources>;

/** The sole application window receives only non-sensitive invalidations and resource status. */
export function installSpeechResourceWindowBridge(options: {
  service: Pick<SpeechResourceService, 'onChanged' | 'status'>;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  getWindow: () => Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null;
  rendererUrl: string;
}) {
  const page = (value: string) => { const url = new URL(value); url.hash = ''; return url.href; };
  const trustedPage = page(options.rendererUrl);
  function trustedWindow() {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
    try { return page(window.webContents.mainFrame.url) === trustedPage ? window : undefined; }
    catch { return undefined; }
  }
  const detach = options.service.onChanged(revision => {
    trustedWindow()?.webContents.send(SPEECH_RESOURCES_CHANGED, { revision });
  });
  options.ipc.handle(SPEECH_RESOURCES_STATUS, (event: IpcMainInvokeEvent, request: unknown) => {
    const window = trustedWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== 0) {
      throw new Error('Shared speech resources are unavailable.');
    }
    const status = options.service.status();
    return { shared: true, revision: status.revision, busyResourceIds: status.busyResourceIds,
      ...(status.mutationResourceId ? { mutationResourceId: status.mutationResourceId } : {}),
      migrationIssues: status.migrationIssues.map(issue => ({ code: issue.code,
        ...(issue.resourceId ? { resourceId: issue.resourceId } : {}) })), cleanupPending: status.cleanupPending };
  });
  return () => { detach(); options.ipc.removeHandler(SPEECH_RESOURCES_STATUS); };
}

/** Dedicated application smoke process; it never borrows a user's inference epoch. */
export function createSpeechResourceSmoke(options: {
  managedResourceRoot: string;
  sessionRoot: string;
  environment: LocalSubtitleResourceEnvironment;
}, dependencies: { startupCleanup?: typeof cleanupSpeechResourceSessionStartupOrphans } = {}) {
  let startupCleanup: Promise<unknown> | undefined;
  let closing = false;
  let shutdownOperation: Promise<void> | undefined;
  const requireOpen = () => { if (closing) throw new SpeechResourceSmokeError('owner_released', 'The shared speech resource load check is closed.'); };
  const supervisor = new LocalSubtitleServerSupervisor({ managedResourceRoot: options.managedResourceRoot,
    dependencies: { async createSession() {
      requireOpen();
      // This dedicated directory is otherwise untouched by the two tool startup cleaners.
      // Cache before awaiting, so a later load cannot sweep an already-live smoke session.
      startupCleanup ??= Promise.resolve().then(() => (dependencies.startupCleanup ?? cleanupSpeechResourceSessionStartupOrphans)({
        managedResourceRoot: options.sessionRoot, platform: options.environment.platform ?? process.platform }));
      await startupCleanup; requireOpen();
      return createLocalSubtitleServerSession(options.sessionRoot);
    } } });
  const failure = (error: unknown): never => {
    const value = error && typeof error === 'object' ? error as { localSubtitleCode?: unknown; code?: unknown } : {};
    const code = value.localSubtitleCode ?? value.code;
    throw new SpeechResourceSmokeError(LOCAL_SUBTITLE_ERROR_CODES.includes(code as never)
      ? code as typeof LOCAL_SUBTITLE_ERROR_CODES[number] : 'model_incompatible', 'The shared speech resource could not pass its native load check.');
  };
  const smokeModel: SpeechResourceModelSmoke = async input => {
    try {
      input.signal.throwIfAborted();
      const verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({ environment: options.environment, scope: 'server' });
      input.signal.throwIfAborted();
      await supervisor.smokeModelLoad(input.owner, { purpose: 'model_load_smoke', backend: 'cpu', verifiedRuntime,
        serverArtifactId: selectLocalSubtitleCpuServerArtifactId(verifiedRuntime), model: input.model, threads: 1 }, input.signal);
    } catch (error) { failure(error); }
  };
  const smokeVad: SpeechResourceVadSmoke = async input => {
    try {
      input.signal.throwIfAborted();
      const verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({ environment: options.environment, scope: 'server' });
      input.signal.throwIfAborted();
      await supervisor.smokeVadLoad(input.owner, { purpose: 'vad_load_smoke', backend: 'cpu', verifiedRuntime,
        serverArtifactId: selectLocalSubtitleCpuServerArtifactId(verifiedRuntime), model: input.model, vadModel: input.vad, threads: 1 }, input.signal);
    } catch (error) { failure(error); }
  };
  return { smokeModel, smokeVad, snapshot: () => supervisor.snapshot,
    shutdown(reason: 'app_quit' | 'update' | 'fatal'): Promise<void> {
      if (shutdownOperation) return shutdownOperation;
      closing = true;
      let resolve!: () => void, reject!: (error: unknown) => void;
      const operation = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      shutdownOperation = operation;
      // Fence the supervisor immediately, then join both native work and pre-session cleanup.
      let native: Promise<void>;
      try { native = supervisor.shutdown(reason); } catch (error) { native = Promise.reject(error); }
      void Promise.allSettled([native, startupCleanup]).then(results => {
        const failed = results.filter(result => result.status === 'rejected');
        if (failed.length) { if (shutdownOperation === operation) shutdownOperation = undefined;
          reject(new AggregateError(failed.map(result => result.reason), 'Shared speech resource smoke cleanup failed.')); }
        else resolve();
      });
      return operation;
    } };
}
