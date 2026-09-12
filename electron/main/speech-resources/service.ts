import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalSubtitleModelManager, LocalSubtitleModelManagerError, type LocalSubtitleModelManagerOptions } from './engine/model-manager';
import { LocalSubtitleSessionRegistry } from './engine/session-registry';
import { canonicalResourceId, SPEECH_CUDA_RESOURCE_ID, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from './catalog';
import { migrateSpeechResources, type SpeechResourceMigrationResult } from './migration';
import { SPEECH_MIGRATION_RESOURCES } from './catalog-migration';
import { LOCAL_SUBTITLE_LIMITS, type LocalSubtitleOwnerKey, type LocalSubtitleResourceEventEnvelope, type LocalSubtitleResourceJobSummary, type LocalSubtitleSessionSnapshot } from '../../../src/speech-resources/contracts';

export interface SpeechResourceConsumer {
  readonly id: 'legacy' | 'studio';
  /** Includes queued work, failed cleanup, and warm native processes. */
  readonly isResourceBusy: (canonicalId: string) => boolean;
}
export interface SpeechResourceUseLease { release(): void; }
export interface SpeechResourceServiceOptions extends Omit<LocalSubtitleModelManagerOptions, 'managedResourceRoot' | 'sessionRegistry' | 'resourceJobs' | 'isResourceBusy' | 'startupCleanup'> {
  readonly userDataRoot: string;
  readonly migration?: typeof migrateSpeechResources;
  readonly migrationResources?: Parameters<typeof migrateSpeechResources>[0]['resources'];
}

const rootOwners = new Map<string, object>();
const active = (job: LocalSubtitleResourceJobSummary) => !['completed', 'cancelled', 'failed'].includes(job.status);
const keyOf = (owner: LocalSubtitleOwnerKey) => JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
const busy = () => new LocalSubtitleModelManagerError('resource_busy', 'Shared speech resources are currently in use.');
const closed = () => new LocalSubtitleModelManagerError('owner_released', 'The shared speech resource client is closed.');
interface Mutation { readonly id: string; jobId?: string; cleanup?: Promise<void>; cleanupFailed?: boolean; }

/** Sole owner of downloadable speech assets. Tasks and native processes remain consumers. */
export class SpeechResourceService {
  readonly managedResourceRoot: string;
  readonly #options: SpeechResourceServiceOptions;
  readonly #identity = {};
  readonly #owner: LocalSubtitleOwnerKey = Object.freeze({ webContentsId: 0, ownerSessionId: randomUUID() });
  readonly #registry = new LocalSubtitleSessionRegistry();
  readonly #consumers = new Map<string, SpeechResourceConsumer>();
  readonly #uses = new Map<string, number>();
  readonly #reads = new Set<Promise<unknown>>();
  readonly #listeners = new Set<(revision: number) => void>();
  readonly #resourceListeners = new Set<(event: LocalSubtitleResourceEventEnvelope) => void>();
  #manager?: LocalSubtitleModelManager;
  #rootKey?: string;
  #initialization?: Promise<void>;
  #shutdown?: Promise<void>;
  #ready = false;
  #fenced = false;
  #revision = 0;
  #mutation?: Mutation;
  #migration?: SpeechResourceMigrationResult;
  #registrySubscription?: () => void;

  constructor(options: SpeechResourceServiceOptions) {
    if (!options || !path.isAbsolute(options.userDataRoot) || path.resolve(options.userDataRoot) === path.parse(options.userDataRoot).root) {
      throw new TypeError('A non-root absolute userData directory is required.');
    }
    this.#options = options;
    this.managedResourceRoot = path.join(path.resolve(options.userDataRoot), 'speech-resources');
  }

  initialize(): Promise<void> {
    if (this.#fenced) return Promise.reject(closed());
    if (this.#ready) return Promise.resolve();
    if (this.#initialization) return this.#initialization;
    this.#initialization = Promise.resolve().then(async () => {
      const parent = path.dirname(this.managedResourceRoot);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new TypeError('The userData directory must not be a link.');
      const rootKey = path.join(await realpath(parent), 'speech-resources');
      const key = process.platform === 'win32' ? rootKey.toLowerCase() : rootKey;
      if (rootOwners.has(key) && rootOwners.get(key) !== this.#identity) throw busy();
      rootOwners.set(key, this.#identity); this.#rootKey = key;
      const migrate = this.#options.migration ?? migrateSpeechResources;
      this.#migration = await migrate({ userDataRoot: parent, sharedRoot: this.managedResourceRoot,
        resources: this.#options.migrationResources ?? SPEECH_MIGRATION_RESOURCES });
      if (this.#migration.cleanupPending) throw busy();
      if (this.#fenced) throw closed();
      const { userDataRoot: _root, migration: _migration, migrationResources: _entries, ...engine } = this.#options;
      this.#manager ??= new LocalSubtitleModelManager({ ...engine, managedResourceRoot: this.managedResourceRoot,
        sessionRegistry: this.#registry, isResourceBusy: id => this.isResourceBusy(id) });
      this.#registrySubscription ??= this.#registry.onResourceEvent(this.#owner, event => {
        for (const listener of [...this.#resourceListeners]) { try { listener(event); } catch { /* observers cannot change resource ownership */ } }
        this.#changed();
      });
      await this.#manager.initialize();
      if (this.#fenced) throw closed();
      this.#ready = true; this.#changed();
    }).catch(error => { this.#initialization = undefined; throw error; });
    return this.#initialization;
  }

  #requireReady(): LocalSubtitleModelManager {
    if (this.#fenced) throw closed();
    if (!this.#ready || !this.#manager) throw busy();
    return this.#manager;
  }
  #id(value: string): string {
    const id = canonicalResourceId(value);
    if (!this.#resourceIds().includes(id)) throw new LocalSubtitleModelManagerError('resource_not_allowed', 'The shared resource is not in the fixed catalog.');
    return id;
  }
  #resourceIds(): string[] {
    return [...(this.#options.modelCatalog ?? SPEECH_MODEL_MANIFEST.models).map(model => model.id),
      ...((this.#options.vadManager === false) ? [] : [SPEECH_VAD_MANIFEST.vad.id]),
      ...((this.#options.acceleratorManager === false || (this.#options.platform ?? process.platform) !== 'win32') ? [] : [SPEECH_CUDA_RESOURCE_ID])];
  }

  isResourceBusy(resourceId: string): boolean {
    const id = canonicalResourceId(resourceId);
    if ((this.#uses.get(id) ?? 0) > 0) return true;
    for (const consumer of this.#consumers.values()) {
      try { if (consumer.isResourceBusy(id)) return true; } catch { return true; }
    }
    return false;
  }

  /** Synchronous and all-or-nothing: callers take this before admission's first await. */
  reserveUse(resourceIds: readonly string[]): SpeechResourceUseLease {
    this.#requireReady();
    const ids = [...new Set(resourceIds.map(id => this.#id(id)))];
    if (this.#mutation && ids.includes(this.#mutation.id)) throw busy();
    for (const id of ids) this.#uses.set(id, (this.#uses.get(id) ?? 0) + 1);
    let released = false;
    return Object.freeze({ release: () => {
      if (released) return;
      released = true;
      for (const id of ids) { const count = (this.#uses.get(id) ?? 0) - 1; if (count > 0) this.#uses.set(id, count); else this.#uses.delete(id); }
    } });
  }

  async withResourceRead<T>(id: string, read: () => Promise<T>): Promise<T> {
    const lease = this.reserveUse([id]);
    const operation = Promise.resolve().then(read);
    this.#reads.add(operation);
    try { return await operation; } finally { this.#reads.delete(operation); lease.release(); }
  }

  #claimMutation(id: string) {
    this.#requireReady();
    if (this.#mutation || this.isResourceBusy(id)) throw busy();
    const claim: Mutation = { id };
    this.#mutation = claim; this.#changed();
    return claim;
  }
  #releaseMutation(claim: { id: string }) {
    if (this.#mutation === claim) { this.#mutation = undefined; this.#changed(); }
  }
  async #settleMutation(manager: LocalSubtitleModelManager, claim: Mutation): Promise<void> {
    try { await manager.waitForIdle(); this.#releaseMutation(claim); }
    catch (error) { claim.cleanupFailed = true; this.#changed(); throw error; }
  }
  #startJob(id: string, start: (manager: LocalSubtitleModelManager) => LocalSubtitleResourceJobSummary) {
    const manager = this.#requireReady(); const claim = this.#claimMutation(id);
    try {
      // Application ownership is long-lived; retain a bounded history without exhausting admission.
      const jobs = this.#registry.getSnapshot(this.#owner).resourceJobs;
      let remaining = jobs.length;
      for (const job of jobs) {
        if (remaining < LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs) break;
        if (!active(job)) { this.#registry.removeResourceJob(this.#owner, job.jobId, new Date().toISOString()); remaining--; }
      }
      const job = start(manager); claim.jobId = job.jobId;
      // The underlying operation, including finally cleanup, owns the lock past its terminal event.
      claim.cleanup = this.#settleMutation(manager, claim).catch(() => undefined);
      return job;
    } catch (error) { this.#releaseMutation(claim); throw error; }
  }

  onChanged(listener: (revision: number) => void): () => void {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  #changed() {
    this.#revision++;
    for (const listener of [...this.#listeners]) { try { listener(this.#revision); } catch { /* invalidation is advisory */ } }
  }
  status() {
    return Object.freeze({ revision: this.#revision, shared: true as const,
      busyResourceIds: this.#resourceIds().filter(id => this.isResourceBusy(id)),
      mutationResourceId: this.#mutation?.id,
      migrationIssues: this.#migration?.issues ?? [], cleanupPending: !!this.#migration?.cleanupPending || !!this.#mutation?.cleanupFailed });
  }

  createClient(consumer: SpeechResourceConsumer) {
    if (!['legacy', 'studio'].includes(consumer.id) || typeof consumer.isResourceBusy !== 'function' || this.#consumers.has(consumer.id)) {
      throw new TypeError('A unique speech resource consumer is required.');
    }
    this.#consumers.set(consumer.id, consumer);
    let clientClosed = false;
    const released = new Set<string>();
    const subscriptions = new Map<string, Set<() => void>>();
    const changedSubscriptions = new Set<() => void>();
    const assertClient = (owner?: LocalSubtitleOwnerKey) => {
      if (clientClosed || this.#fenced) throw closed();
      if (owner && (!Number.isSafeInteger(owner.webContentsId) || owner.webContentsId < 0 || typeof owner.ownerSessionId !== 'string' || !owner.ownerSessionId || owner.ownerSessionId.length > 128 || owner.ownerSessionId.trim() !== owner.ownerSessionId || /[\u0000-\u001f\u007f]/u.test(owner.ownerSessionId))) throw closed();
      if (owner && released.has(keyOf(owner))) throw closed();
    };
    const alias = (id: string) => id !== SPEECH_CUDA_RESOURCE_ID ? id : consumer.id === 'legacy'
      ? 'local-subtitle-windows-x64-cuda-12.4-v1' : 'subtitle-studio-windows-x64-cuda-12.4-v1';
    const jobView = (job: LocalSubtitleResourceJobSummary) => Object.freeze({ ...job, resourceId: alias(job.resourceId) });
    const releaseOwner = (owner: LocalSubtitleOwnerKey) => {
      const key = keyOf(owner); released.add(key);
      for (const unsubscribe of subscriptions.get(key) ?? []) unsubscribe();
      subscriptions.delete(key);
    };
    return Object.freeze({
      initialize: async () => { assertClient(); await this.initialize(); },
      listManagedResources: async (owner: LocalSubtitleOwnerKey, signal?: AbortSignal) => {
        assertClient(owner);
        const manager = this.#requireReady();
        // Refresh is also the bounded recovery entry for a previously failed filesystem cleanup.
        // The mutation remains claimed throughout; a repeated failure stays visible in status().
        const pendingCleanup = this.#mutation;
        if (pendingCleanup?.cleanupFailed) await this.#settleMutation(manager, pendingCleanup).catch(() => undefined);
        // An active mutation is reported by the engine without reading its incomplete payload.
        // All other resources remain pinned until the entire catalog observation settles.
        const lease = this.reserveUse(this.#resourceIds().filter(id => id !== this.#mutation?.id));
        const operation = manager.listManagedResources(this.#owner, signal);
        this.#reads.add(operation);
        try {
          const result = await operation;
          assertClient(owner); return Object.freeze(result.map(resource => Object.freeze({ ...resource, resourceId: alias(resource.resourceId) })));
        } finally { this.#reads.delete(operation); lease.release(); }
      },
      importModel: (input: { owner: LocalSubtitleOwnerKey; filePath: string; modelId?: string; mode: 'copy' | 'move' }) => {
        assertClient(input.owner);
        if (!input.modelId) throw new LocalSubtitleModelManagerError('invalid_ipc_request', 'A fixed model ID is required.');
        const id = this.#id(input.modelId);
        return jobView(this.#startJob(id, manager => manager.importModel({ ...input, modelId: id, owner: this.#owner })));
      },
      startResourceInstall: (owner: LocalSubtitleOwnerKey, resourceId: string) => {
        assertClient(owner); const id = this.#id(resourceId);
        return jobView(this.#startJob(id, manager => manager.startResourceInstall(this.#owner, id)));
      },
      cancelResourceJob: (owner: LocalSubtitleOwnerKey, jobId: string) => {
        assertClient(owner); return this.#requireReady().cancelResourceJob(this.#owner, jobId);
      },
      deleteManagedResource: async (owner: LocalSubtitleOwnerKey, resourceId: string) => {
        assertClient(owner); const id = this.#id(resourceId); const claim = this.#claimMutation(id);
        const manager = this.#requireReady();
        try { return await manager.deleteManagedResource(this.#owner, id); }
        finally { await this.#settleMutation(manager, claim); }
      },
      getSessionSnapshot: (owner: LocalSubtitleOwnerKey): LocalSubtitleSessionSnapshot => {
        assertClient(owner); const snapshot = this.#requireReady().getSessionSnapshot(this.#owner);
        return Object.freeze({ ...snapshot, resourceJobs: Object.freeze(snapshot.resourceJobs.map(jobView)) });
      },
      onResourceEvent: (owner: LocalSubtitleOwnerKey, listener: (event: LocalSubtitleResourceEventEnvelope) => void) => {
        assertClient(owner); this.#requireReady();
        const handler = (envelope: LocalSubtitleResourceEventEnvelope) => {
          if (clientClosed || released.has(keyOf(owner))) return;
          listener(Object.freeze({ ...envelope, event: envelope.event.type === 'resource-job-updated'
            ? Object.freeze({ ...envelope.event, job: jobView(envelope.event.job) }) : envelope.event }));
        };
        this.#resourceListeners.add(handler);
        const unsubscribe = () => { this.#resourceListeners.delete(handler); subscriptions.get(keyOf(owner))?.delete(unsubscribe); };
        const set = subscriptions.get(keyOf(owner)) ?? new Set(); set.add(unsubscribe); subscriptions.set(keyOf(owner), set);
        return unsubscribe;
      },
      resolveManagedModel: (id: string, signal?: AbortSignal) => { assertClient(); const canonical = this.#id(id); return this.withResourceRead(canonical, () => this.#requireReady().resolveManagedModel(canonical, signal)); },
      resolveManagedVad: (id: string, signal?: AbortSignal) => { assertClient(); const canonical = this.#id(id); return this.withResourceRead(canonical, () => this.#requireReady().resolveManagedVad(canonical, signal)); },
      reserveUse: (ids: readonly string[]) => { assertClient(); return this.reserveUse(ids); },
      withResourceRead: <T>(id: string, callback: () => Promise<T>) => { assertClient(); return this.withResourceRead(id, callback); },
      onChanged: (listener: (revision: number) => void) => {
        assertClient(); const stop = this.onChanged(listener);
        const unsubscribe = () => { stop(); changedSubscriptions.delete(unsubscribe); };
        changedSubscriptions.add(unsubscribe); return unsubscribe;
      },
      status: () => { assertClient(); const status = this.status(); return { ...status, busyResourceIds: status.busyResourceIds.map(alias), mutationResourceId: status.mutationResourceId && alias(status.mutationResourceId) }; },
      releaseOwner,
      waitForIdle: async () => {
        await this.#manager?.waitForIdle();
        const claim = this.#mutation;
        if (claim?.cleanupFailed) this.#releaseMutation(claim);
        else await claim?.cleanup;
      },
      shutdown: async () => {
        clientClosed = true;
        for (const set of subscriptions.values()) for (const unsubscribe of [...set]) unsubscribe();
        subscriptions.clear(); for (const unsubscribe of [...changedSubscriptions]) unsubscribe();
      },
    });
  }

  /** Fence first, before either consumer starts native shutdown. Downloads outlive pages, not the app. */
  fence(): void {
    this.#fenced = true;
    if (!this.#manager || !this.#ready) return;
    for (const job of this.#manager.getSessionSnapshot(this.#owner).resourceJobs) {
      if (active(job)) this.#manager.cancelResourceJob(this.#owner, job.jobId);
    }
  }
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const operation = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    this.#shutdown = operation;
    try { this.fence(); } catch (error) { this.#shutdown = undefined; reject(error); return operation; }
    void Promise.resolve().then(async () => {
      await this.#initialization?.catch(() => undefined);
      await Promise.allSettled([...this.#reads]);
      if ([...this.#uses.values()].some(count => count > 0) || this.#resourceIds().some(id => this.isResourceBusy(id))) throw busy();
      await this.#manager?.shutdown();
      await this.#mutation?.cleanup;
      this.#registrySubscription?.(); await this.#registry.shutdown();
      if (this.#rootKey && rootOwners.get(this.#rootKey) === this.#identity) rootOwners.delete(this.#rootKey);
      this.#ready = false; this.#mutation = undefined; this.#listeners.clear(); this.#resourceListeners.clear(); this.#consumers.clear();
    }).then(resolve, error => { if (this.#shutdown === operation) this.#shutdown = undefined; reject(error); });
    return operation;
  }
}

export type SpeechResourceClient = ReturnType<SpeechResourceService['createClient']>;
