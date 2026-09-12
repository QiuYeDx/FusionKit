import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { z } from 'zod';
import {
  LocalSubtitleCapabilityLeaseCoordinator, LocalSubtitleImportTokenRegistry,
  LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type LocalSubtitleOwnerKey,
} from './native/authorizations';
import { LocalSubtitleArtifactHandoffService, type LocalSubtitleTranslationImportTokenRegistry } from './native/artifact-handoff';
import { createLocalSubtitleProductionBackendAttestor } from './native/backend-attestor';
import { LocalSubtitleBackendResolver } from './native/backend-resolver';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION } from './native/accelerator-manager';
import { LocalSubtitleJobManager } from './native/job-manager';
import { LocalSubtitleMediaNormalizer, type LocalSubtitleMediaNormalizerOptions } from './native/media-normalizer';
import { LocalSubtitleModelManager, type LocalSubtitleModelManagerOptions } from './native/model-manager';
import { LocalSubtitleProductionExecutor } from './native/production-executor';
import { LocalSubtitleServerSupervisor, type LocalSubtitleServerSupervisorOptions } from './native/server-supervisor';
import { LocalSubtitleSessionRegistry, type LocalSubtitleResourceEventListener } from './native/session-registry';
import { LocalSubtitleSessionLifecycle } from './native/session-lifecycle';
import { LocalSubtitleArtifactRegistry } from './native/subtitle-artifact-registry';
import { LocalSubtitleExporter } from './native/subtitle-exporter';
import { cleanupLocalSubtitleResourceStartupOrphans } from './native/resource-startup-cleaner';
import { LocalSubtitleResourceError, assertSupportedLocalSubtitleRuntimeTarget } from './native/resource-manifest';
import {
  verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment,
  type LocalSubtitleRuntimeVerificationScope, type LocalSubtitleSignatureVerifier,
} from './native/resource-path';
import type { LocalSubtitleMainRuntimeShutdownReason, LocalSubtitleMainRuntimeTarget } from './native/main-runtime';
import { DocumentRepository } from '../document-repository';
import { TranscriptionExecutor } from './transcript-executor';
import { createTranscriptionTaskService, type TranscriptionTaskService } from './task-service';
import type { EnqueueTranscriptionRequest } from '../../../../src/subtitle-studio/transcription/task-contract';
import { enqueueTranscriptionRequestSchema } from '../../../../src/subtitle-studio/transcription/task-contract';
import type { SpeechResourceService } from '../../speech-resources/service';
import { canonicalResourceId, SPEECH_CUDA_RESOURCE_ID } from '../../speech-resources/catalog';
import { createStudioSharedResources, type StudioSharedResources } from './shared-resources';
import { createLocalSubtitleServerSession } from './native/server-session';
import { cleanupSpeechResourceSessionStartupOrphans } from '../../speech-resources/engine/resource-startup-cleaner';

export interface TranscriptionRuntimeOptions {
  readonly userDataRoot: string;
  readonly environment: LocalSubtitleResourceEnvironment;
}

/** Low-level adapters for isolated hosts/tests; composed services cannot be supplied. */
export interface TranscriptionRuntimeDependencies {
  readonly sharedResources?: SpeechResourceService;
  readonly signatureVerifier?: LocalSubtitleSignatureVerifier;
  readonly media?: Pick<LocalSubtitleMediaNormalizerOptions, 'processRunner' | 'availableBytes' | 'sourceEnvironment'>;
  readonly server?: Omit<LocalSubtitleServerSupervisorOptions, 'managedResourceRoot'>;
  readonly resources?: Pick<LocalSubtitleModelManagerOptions,
    'modelCatalog' | 'availableBytes' | 'downloadResource' | 'removeStagingDirectory'>;
  readonly startupCleanup?: typeof cleanupLocalSubtitleResourceStartupOrphans;
}

export class TranscriptionRuntimeError extends Error {
  constructor(readonly code: 'invalid_configuration' | 'runtime_busy' | 'not_initialized' | 'runtime_closed' | 'owner_released') {
    super(`Subtitle Studio transcription runtime: ${code}.`);
    this.name = 'TranscriptionRuntimeError';
  }
}

const ownerSchema = z.object({ webContentsId: z.number().int().positive(),
  ownerSessionId: z.string().min(1).max(128).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)) }).strict();
const importSchema = z.object({ owner: ownerSchema, filePath: z.string().min(1), modelId: z.string().min(1) }).strict();
const absolutePathSchema = z.string().min(1).refine(value => !value.includes('\0') && path.isAbsolute(value));
const targetFields = { platform: z.enum(['darwin', 'win32']).optional(), arch: z.enum(['arm64', 'x64']).optional() };
const optionsSchema = z.object({ userDataRoot: absolutePathSchema, environment: z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('development'), appRoot: absolutePathSchema, ...targetFields }).strict(),
  z.object({ mode: z.literal('packaged'), resourcesPath: absolutePathSchema, ...targetFields }).strict(),
]) }).strict();
const roots = new Map<string, object>();
type Phase = 'new' | 'initializing' | 'initialized' | 'failed' | 'closing' | 'closed';

/** Construction is inert. Initialization owns private storage; native work remains explicit. */
export function createTranscriptionRuntime(options: TranscriptionRuntimeOptions, dependencies: TranscriptionRuntimeDependencies = {}, repository?: DocumentRepository) {
  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedOptions.success || path.parse(options.userDataRoot).root === path.resolve(options.userDataRoot)) {
    throw new TranscriptionRuntimeError('invalid_configuration');
  }
  const environment = Object.freeze({ ...parsedOptions.data.environment });
  if (repository !== undefined && !(repository instanceof DocumentRepository)) throw new TranscriptionRuntimeError('invalid_configuration');
  try { assertSupportedLocalSubtitleRuntimeTarget(environment.platform ?? process.platform, environment.arch ?? process.arch); }
  catch { throw new TranscriptionRuntimeError('invalid_configuration'); }
  const userDataRoot = path.resolve(options.userDataRoot);
  const managedResourceRoot = path.join(userDataRoot, 'subtitle-studio', 'transcription');
  const identity = {};
  const owners = new Map<string, { owner: LocalSubtitleOwnerKey; released: boolean; controller: AbortController }>();
  let phase: Phase = 'new';
  let lockKey: string | undefined;
  let initialization: Promise<void> | undefined;
  let shutdownOperation: Promise<void> | undefined;
  let terminal = false;
  let services: ReturnType<typeof compose> | undefined;
  const ownerReleases = new Map<string, Promise<void>>();
  const partial: { jobs?: LocalSubtitleJobManager; models?: LocalSubtitleModelManager | StudioSharedResources; media?: LocalSubtitleMediaNormalizer;
    server?: LocalSubtitleServerSupervisor; registry?: LocalSubtitleSessionRegistry } = {};

  function ownerKey(owner: LocalSubtitleOwnerKey) { return `${owner.webContentsId}:${owner.ownerSessionId}`; }
  function requireReady() {
    if (terminal) throw new TranscriptionRuntimeError('runtime_closed');
    if (phase !== 'initialized' || !services) throw new TranscriptionRuntimeError('not_initialized');
    return services;
  }
  function requireOwner(value: LocalSubtitleOwnerKey) {
    const current = requireReady();
    const owner = Object.freeze(ownerSchema.parse(value));
    const key = ownerKey(owner);
    if (owners.get(key)?.released) throw new TranscriptionRuntimeError('owner_released');
    if (!owners.has(key)) owners.set(key, { owner, released: false, controller: new AbortController() });
    return { current, owner, signal: owners.get(key)!.controller.signal };
  }
  async function completeOwner<T>(owner: LocalSubtitleOwnerKey, work: Promise<T>): Promise<T> {
    const result = await work; requireOwner(owner); return result;
  }
  const ownerSignal = (signal: AbortSignal, external?: AbortSignal) => external ? AbortSignal.any([signal, external]) : signal;
  const verifyRuntime = (scope: LocalSubtitleRuntimeVerificationScope) => verifyLocalSubtitleRuntimeBundle({
    environment, scope, ...(dependencies.signatureVerifier ? { signatureVerifier: dependencies.signatureVerifier } : {}),
  });

  function compose() {
    const inputs = new LocalSubtitleInputAuthorizationRegistry();
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs);
    const artifacts = new LocalSubtitleArtifactRegistry();
    const importTokens: LocalSubtitleTranslationImportTokenRegistry = new LocalSubtitleImportTokenRegistry();
    const handoffs = new LocalSubtitleArtifactHandoffService(artifacts, importTokens);
    const media = partial.media = new LocalSubtitleMediaNormalizer({ ...dependencies.media, environment, managedResourceRoot,
      inputAuthorizations: inputs, signatureVerifier: dependencies.signatureVerifier });
    const attestor = createLocalSubtitleProductionBackendAttestor({ platform: environment.platform, arch: environment.arch });
    const server = partial.server = new LocalSubtitleServerSupervisor({ ...dependencies.server,
      managedResourceRoot: dependencies.sharedResources?.managedResourceRoot ?? managedResourceRoot,
      dependencies: { verifyBackend: attestor.verifyBackend, ...dependencies.server?.dependencies,
        ...(dependencies.sharedResources ? { createSession: () => createLocalSubtitleServerSession(managedResourceRoot) } : {}) } });
    const registry = partial.registry = new LocalSubtitleSessionRegistry();
    let jobs: LocalSubtitleJobManager | undefined;
    let tasks: TranscriptionTaskService | undefined;
    const isResourceBusy = (id: string) => phase !== 'closed' && Boolean(tasks?.isResourceBusy(id)
      || (id === SPEECH_CUDA_RESOURCE_ID && tasks?.isResourceBusy(LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION.resourceId))
      || jobs?.isManagedModelBusy(id) || jobs?.isManagedVadBusy(id) || jobs?.isManagedAcceleratorBusy(id)
      || server.isManagedAcceleratorBusy(id) || server.snapshot.modelId === id || server.snapshot.vadModelId === id);
    const models = partial.models = dependencies.sharedResources ? createStudioSharedResources({ service: dependencies.sharedResources,
      isResourceBusy, platform: environment.platform, arch: environment.arch }) : new LocalSubtitleModelManager({ ...dependencies.resources,
      managedResourceRoot, runtimeEnvironment: environment, supervisor: server, sessionRegistry: registry,
      // The factory ran this exact cleanup before composing any service that could own live work.
      startupCleanup: async () => undefined,
      verifyServerRuntime: () => verifyRuntime('server'),
      isResourceBusy,
    });
    const resolveCudaAccelerator = (signal?: AbortSignal) => models.resolveManagedAccelerator(LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION.resourceId, signal);
    const backendResolver = new LocalSubtitleBackendResolver({ runtimeEnvironment: environment,
      verifyServerRuntime: () => verifyRuntime('server'), resolveCudaAccelerator,
      metalAttestationAvailable: attestor.supportedBackends.includes('metal'), cudaAttestationAvailable: attestor.supportedBackends.includes('cuda') });
    if (repository) {
      const executor = new TranscriptionExecutor({ media, supervisor: server, runtimeEnvironment: environment, resolveCudaAccelerator });
      tasks = createTranscriptionTaskService({ repository, inputs, leases, media, modelResolver: models, backendResolver, executor });
    } else {
      // Retain the resource-only T03 host contract; no legacy job API is exposed.
      const exporter = new LocalSubtitleExporter(artifacts);
      const executor = new LocalSubtitleProductionExecutor({ media, supervisor: server, inputs, outputs, exporter,
        runtimeEnvironment: environment, resolveCudaAccelerator });
      jobs = partial.jobs = new LocalSubtitleJobManager({ registry, inputs, outputs, leases, runtimeVerifier: media,
        backendResolver, modelResolver: models, mediaSelections: media, executor, artifacts: handoffs });
    }
    // Document tasks are joined explicitly before resource/media shutdown begins.
    const taskTarget = jobs ?? { releaseOwner() {}, async shutdown() {} };
    const lifecycle = new LocalSubtitleSessionLifecycle(taskTarget, models, media, server, registry);
    return { inputs, outputs, artifacts, importTokens, media, server, models, registry, lifecycle, tasks };
  }

  function releaseCapabilities(owner: LocalSubtitleOwnerKey) {
    if (!services) return;
    const failures: unknown[] = [];
    for (const target of [services.inputs, services.outputs, services.artifacts, services.importTokens]) {
      try { target.releaseOwner(owner); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Transcription capabilities could not be released.');
  }
  function releaseLock() {
    if (lockKey && roots.get(lockKey) === identity) roots.delete(lockKey);
    lockKey = undefined;
  }
  async function closeServices(reason: LocalSubtitleMainRuntimeShutdownReason) {
    const failures: unknown[] = [];
    if (services) {
      try { await services.tasks?.shutdown(reason); } catch (error) { failures.push(error); }
      // Existing owner releases must finish before closing their backing services.
      const releases = await Promise.allSettled([...ownerReleases.values()]);
      for (const result of releases) if (result.status === 'rejected') failures.push(result.reason);
      try { await services.lifecycle.shutdown(reason); } catch (error) { failures.push(error); }
    } else {
      for (const targets of [[partial.jobs, partial.models], [partial.media, partial.server], [partial.registry]]) {
        const results = await Promise.allSettled(targets.filter((target): target is NonNullable<typeof target> => Boolean(target))
          .map(target => Promise.resolve().then(() => (target as LocalSubtitleMainRuntimeTarget).shutdown(reason))));
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    for (const record of owners.values()) {
      record.released = true;
      record.controller.abort();
      try { releaseCapabilities(record.owner); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Transcription runtime cleanup failed.');
    services?.tasks?.confirmCleanup();
    releaseLock();
  }

  function initialize(): Promise<void> {
    if (terminal) return Promise.reject(new TranscriptionRuntimeError('runtime_closed'));
    if (initialization) return initialization;
    phase = 'initializing';
    initialization = Promise.resolve().then(async () => {
      // The app's shared migration completes before any per-domain startup cleaner runs.
      await dependencies.sharedResources?.initialize();
      await mkdir(userDataRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(userDataRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TranscriptionRuntimeError('invalid_configuration');
      const canonical = path.join(await realpath(userDataRoot), 'subtitle-studio', 'transcription');
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (roots.has(key)) throw new TranscriptionRuntimeError('runtime_busy');
      roots.set(key, identity); lockKey = key;
      for (const directory of [path.dirname(managedResourceRoot), managedResourceRoot]) {
        await mkdir(directory, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TranscriptionRuntimeError('invalid_configuration');
      }
      if (terminal) throw new TranscriptionRuntimeError('runtime_closed');
      // The frozen cleaner also removes resource staging; preserve shared migration sources.
      if (!dependencies.sharedResources) await (dependencies.startupCleanup ?? cleanupLocalSubtitleResourceStartupOrphans)({ managedResourceRoot,
        platform: environment.platform ?? process.platform, arch: environment.arch ?? process.arch });
      else await cleanupSpeechResourceSessionStartupOrphans({ managedResourceRoot, platform: environment.platform ?? process.platform });
      if (terminal) throw new TranscriptionRuntimeError('runtime_closed');
      services = compose();
      await services.models.initialize();
      if (terminal) throw new TranscriptionRuntimeError('runtime_closed');
      phase = 'initialized';
    }).catch(async error => {
      phase = 'failed';
      try { await closeServices('fatal'); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Transcription initialization and cleanup failed.'); }
      throw error;
    });
    return initialization;
  }

  function shutdown(reason: LocalSubtitleMainRuntimeShutdownReason = 'app_quit'): Promise<void> {
    if (shutdownOperation) return shutdownOperation;
    if (phase === 'closed') return Promise.resolve();
    terminal = true; phase = 'closing';
    shutdownOperation = Promise.resolve().then(async () => {
      // Initialization reports its own error and cleans partial construction before this joins it.
      if (initialization) await Promise.allSettled([initialization]);
      await closeServices(reason);
      phase = 'closed';
    }).catch(error => { phase = 'failed'; shutdownOperation = undefined; throw error; });
    // Cache before synchronous abort callbacks can re-enter shutdown.
    for (const record of owners.values()) record.controller.abort();
    return shutdownOperation;
  }

  return Object.freeze({
    managedResourceRoot, initialize, shutdown,
    snapshot: () => Object.freeze({ phase, server: services?.server.snapshot ?? null }),
    releaseOwner(value: LocalSubtitleOwnerKey) {
      const owner = Object.freeze(ownerSchema.parse(value));
      const key = ownerKey(owner);
      const fence = () => {
        const record = owners.get(key);
        if (record) { record.released = true; record.controller.abort(); }
        else { const controller = new AbortController(); owners.set(key, { owner, released: true, controller }); controller.abort(); }
      };
      const failures: unknown[] = [];
      if (!services?.tasks) {
        fence();
        try { releaseCapabilities(owner); } catch (error) { failures.push(error); }
        try { services?.lifecycle.releaseOwner(owner); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Transcription owner release failed.');
        return Promise.resolve();
      }
      if (ownerReleases.has(key)) return ownerReleases.get(key)!;
      const current = services;
      let resolveRelease!: () => void;
      let rejectRelease!: (error: unknown) => void;
      const operation = new Promise<void>((resolve, reject) => { resolveRelease = resolve; rejectRelease = reject; });
      ownerReleases.set(key, operation);
      void operation.then(() => { if (ownerReleases.get(key) === operation) ownerReleases.delete(key); },
        () => { if (ownerReleases.get(key) === operation) ownerReleases.delete(key); });
      // Both owner abort and task release can synchronously re-enter this facade.
      fence();
      try { releaseCapabilities(owner); } catch (error) { failures.push(error); }
      let joined: Promise<void> | undefined;
      try { joined = current.tasks!.releaseOwner(owner); } catch (error) { failures.push(error); }
      void Promise.resolve().then(async () => {
        try { await joined; } catch (error) { failures.push(error); }
        try { current.lifecycle.releaseOwner(owner); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Transcription owner release failed.');
      }).then(resolveRelease, rejectRelease);
      return operation;
    },
    async inspectRuntime(scope: LocalSubtitleRuntimeVerificationScope = 'all') {
      requireReady();
      try {
        const result = await verifyRuntime(scope);
        requireReady();
        return Object.freeze({ status: 'verified' as const, runtimeGeneration: result.runtimeGeneration, target: result.target });
      } catch (error) {
        requireReady();
        if (!(error instanceof LocalSubtitleResourceError)) throw error;
        return Object.freeze({ status: error.code.endsWith('_missing') ? 'missing' as const : 'invalid' as const,
          code: error.code, stage: error.stage });
      }
    },
    media: Object.freeze({
      authorizeInput(value: LocalSubtitleOwnerKey, filePath: string) {
        const { current, owner } = requireOwner(value);
        return completeOwner(owner, current.inputs.authorize(owner, filePath, ['probe', 'transcribe', 'derive_source_output']));
      },
      revokeInput(value: LocalSubtitleOwnerKey, fileToken: string) {
        const { current, owner } = requireOwner(value);
        return current.inputs.revokeDraft(owner, fileToken);
      },
      probe(value: LocalSubtitleOwnerKey, fileToken: string, signal?: AbortSignal) {
        const { current, owner, signal: lifetime } = requireOwner(value);
        return completeOwner(owner, current.media.probeDraft({ owner, fileToken, signal: ownerSignal(lifetime, signal) }));
      },
    }),
    tasks: Object.freeze({
      enqueue(value: LocalSubtitleOwnerKey, request: EnqueueTranscriptionRequest) {
        const { current, owner, signal } = requireOwner(value);
        if (!current.tasks) throw new TranscriptionRuntimeError('invalid_configuration');
        if (!dependencies.sharedResources) return completeOwner(owner, current.tasks.enqueue(owner, request, signal));
        const parsed = enqueueTranscriptionRequestSchema.parse(request), config = parsed.config;
        const use = dependencies.sharedResources.reserveUse([config.modelId,
          ...(config.vadEnabled ? ['silero-vad-v6.2.0-ggml'] : []),
          ...((environment.platform ?? process.platform) === 'win32' && ['auto', 'cuda'].includes(config.devicePreference) ? [SPEECH_CUDA_RESOURCE_ID] : [])].map(canonicalResourceId));
        try { return completeOwner(owner, current.tasks.enqueue(owner, parsed, signal)).finally(() => use.release()); }
        catch (error) { use.release(); throw error; }
      },
      list(value: LocalSubtitleOwnerKey) {
        const { current, owner } = requireOwner(value);
        if (!current.tasks) throw new TranscriptionRuntimeError('invalid_configuration');
        return current.tasks.list(owner);
      },
      cancel(value: LocalSubtitleOwnerKey, taskId: string) {
        const { current, owner } = requireOwner(value);
        if (!current.tasks) throw new TranscriptionRuntimeError('invalid_configuration');
        return current.tasks.cancel(owner, taskId);
      },
      remove(value: LocalSubtitleOwnerKey, taskId: string) {
        const { current, owner } = requireOwner(value);
        if (!current.tasks) throw new TranscriptionRuntimeError('invalid_configuration');
        return current.tasks.remove(owner, taskId);
      },
      waitForIdle() { return requireReady().tasks?.waitForIdle() ?? Promise.resolve(); },
    }),
    resources: Object.freeze({
      status() { const { models } = requireReady(); return 'status' in models ? models.status() : undefined; },
      list(value: LocalSubtitleOwnerKey, signal?: AbortSignal) {
        const { current, owner, signal: lifetime } = requireOwner(value);
        return completeOwner(owner, current.models.listManagedResources(owner, ownerSignal(lifetime, signal)));
      },
      importModel(input: { owner: LocalSubtitleOwnerKey; filePath: string; modelId: string }) {
        const parsed = importSchema.parse(input);
        const { current, owner } = requireOwner(parsed.owner);
        return current.models.importModel({ owner, filePath: parsed.filePath, modelId: parsed.modelId, mode: 'copy' });
      },
      install(value: LocalSubtitleOwnerKey, resourceId: string) {
        const { current, owner } = requireOwner(value); return current.models.startResourceInstall(owner, resourceId);
      },
      cancel(value: LocalSubtitleOwnerKey, jobId: string) {
        const { current, owner } = requireOwner(value); return current.models.cancelResourceJob(owner, jobId);
      },
      delete(value: LocalSubtitleOwnerKey, resourceId: string) {
        const { current, owner } = requireOwner(value); return completeOwner(owner, current.models.deleteManagedResource(owner, resourceId));
      },
      resolveModel(value: LocalSubtitleOwnerKey, modelId: string, signal?: AbortSignal) {
        const { current, owner, signal: lifetime } = requireOwner(value);
        return completeOwner(owner, current.models.resolveManagedModel(modelId, ownerSignal(lifetime, signal)));
      },
      snapshot(value: LocalSubtitleOwnerKey) {
        const { current, owner } = requireOwner(value); return current.models.getSessionSnapshot(owner);
      },
      subscribe(value: LocalSubtitleOwnerKey, listener: LocalSubtitleResourceEventListener) {
        const { current, owner } = requireOwner(value); return current.models.onResourceEvent(owner, listener);
      },
      waitForIdle() { return requireReady().models.waitForIdle(); },
    }),
  });
}

export type TranscriptionRuntime = ReturnType<typeof createTranscriptionRuntime>;
