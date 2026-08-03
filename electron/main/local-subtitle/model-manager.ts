import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  createLocalSubtitleError,
  type LocalSubtitleError,
  type LocalSubtitleErrorCode,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
} from "@/type/localSubtitle";
import type { LocalSubtitleManagedResourceSummary } from "@/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "./authorizations";
import {
  LocalSubtitleAcceleratorManager,
  LocalSubtitleAcceleratorManagerError,
  type LocalSubtitleAcceleratorManagerOptions,
} from "./accelerator-manager";
import {
  verifyLocalSubtitleGgmlModelFile,
  verifyLocalSubtitleGgmlModelHeader,
  type LocalSubtitleGgmlModelVerification,
} from "./ggml-model";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST,
  LocalSubtitleModelError,
  parseLocalSubtitleModelCatalog,
  type LocalSubtitleModelManifestEntry,
} from "./model-manifest";
import {
  LocalSubtitleResourceJobManager,
  type LocalSubtitleResourceJobContext,
  type LocalSubtitleResourceJobExecutionResult,
  type LocalSubtitleSessionRegistryOwnership,
} from "./resource-job";
import {
  downloadLocalSubtitleResource,
  LocalSubtitleResourceDownloadError,
  type DownloadLocalSubtitleResourceOptions,
} from "./resource-download";
import {
  cleanupLocalSubtitleResourceStartupOrphans,
  LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY,
} from "./resource-startup-cleaner";
import {
  selectLocalSubtitleCpuServerArtifactId,
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleResourceEnvironment,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import { LocalSubtitleResourceError } from "./resource-manifest";
import type {
  LocalSubtitleServerManagedResourceIdentity,
} from "./server-process-contract";
import {
  LocalSubtitleServerSupervisorError,
  type LocalSubtitleServerModelLoadSmokeOptions,
} from "./server-supervisor";
import {
  LocalSubtitleSessionRegistry,
  LocalSubtitleSessionRegistryError,
  type LocalSubtitleResourceEventListener,
} from "./session-registry";
import {
  LocalSubtitleVadManager,
  LocalSubtitleVadManagerError,
  type LocalSubtitleVadLoadSmokeTarget,
  type LocalSubtitleVadManagerOptions,
} from "./vad-manager";

const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_EXCLUSIVE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const COPY_CHUNK_BYTES = 1024 * 1024;

export const LOCAL_SUBTITLE_MODEL_MANAGER_POLICY = Object.freeze({
  modelsDirectoryName: "models",
  stagingDirectoryName:
    LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.modelStagingDirectoryName,
  downloadsDirectoryName:
    LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.downloadsDirectoryName,
  copyChunkBytes: COPY_CHUNK_BYTES,
  smokeThreads: 1,
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
} as const);

export type LocalSubtitleModelImportMode = "copy" | "move";

export class LocalSubtitleModelManagerError extends Error {
  readonly name = "LocalSubtitleModelManagerError";

  constructor(
    readonly localSubtitleCode: Extract<
      LocalSubtitleErrorCode,
      | "invalid_ipc_request"
      | "owner_released"
      | "model_missing"
      | "model_incompatible"
      | "model_corrupt"
      | "model_download_failed"
      | "model_disk_full"
      | "unsupported_platform"
      | "unsupported_architecture"
      | "accelerator_unavailable"
      | "resource_not_allowed"
      | "resource_busy"
      | "resource_signature_invalid"
      | "insufficient_disk"
      | "cancel_failed"
    >,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface LocalSubtitleModelLoadSmokeTarget {
  smokeModelLoad(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerModelLoadSmokeOptions,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type LocalSubtitleModelResourceTarget = LocalSubtitleModelLoadSmokeTarget &
  Partial<LocalSubtitleVadLoadSmokeTarget>;

export interface LocalSubtitleModelManagerOptions {
  readonly managedResourceRoot: string;
  readonly runtimeEnvironment: LocalSubtitleResourceEnvironment;
  readonly supervisor: LocalSubtitleModelResourceTarget;
  readonly sessionRegistry?: LocalSubtitleSessionRegistry;
  readonly resourceJobs?: LocalSubtitleResourceJobManager;
  readonly acceleratorManager?: false;
  readonly acceleratorOptions?: Omit<
    LocalSubtitleAcceleratorManagerOptions,
    | "managedResourceRoot"
    | "platform"
    | "arch"
    | "resourceJobs"
    | "isResourceBusy"
  >;
  readonly vadManager?: false;
  readonly vadOptions?: Omit<
    LocalSubtitleVadManagerOptions,
    | "managedResourceRoot"
    | "platform"
    | "resourceJobs"
    | "supervisor"
    | "resolveSmokeModel"
    | "verifyServerRuntime"
    | "isResourceBusy"
  >;
  readonly modelCatalog?: readonly LocalSubtitleModelManifestEntry[];
  readonly verifyModelFile?: typeof verifyLocalSubtitleGgmlModelFile;
  readonly verifyServerRuntime?: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly availableBytes?: (directory: string) => Promise<number>;
  readonly stagingIdFactory?: () => string;
  readonly removeSourceFile?: (absolutePath: string) => Promise<void>;
  readonly commitModelLink?: (source: string, destination: string) => Promise<void>;
  readonly removeStagingDirectory?: (absolutePath: string) => Promise<void>;
  readonly downloadResource?: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly isResourceBusy?: (
    resourceId: string,
  ) => boolean | Promise<boolean>;
  readonly startupCleanup?: () => Promise<void>;
  readonly now?: () => number;
  readonly jobIdFactory?: () => string;
}

export interface ImportLocalSubtitleModelOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly filePath: string;
  readonly mode: LocalSubtitleModelImportMode;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface PrivateDirectoryProof extends DirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly mode: number;
}

interface ImportRootProofs {
  readonly managed: PrivateDirectoryProof;
  readonly models: PrivateDirectoryProof;
  readonly staging: PrivateDirectoryProof;
  readonly downloads: PrivateDirectoryProof;
}

interface SourceReceipt {
  readonly modelId: string;
  readonly absolutePath: string;
  identity: FileIdentity;
  readonly parentPath: string;
  readonly parentIdentity: DirectoryIdentity;
  handle?: FileHandle;
  quarantinePath?: string;
}

interface StagingReceipt {
  readonly modelId: string;
  readonly phase: "staging" | "managed_reservation";
  currentPath: string;
  readonly stagingRoot: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly fileName: string;
  fileIdentity?: FileIdentity;
  quarantined: boolean;
  cleanupConfirmed: boolean;
}

interface PendingManagedReservation {
  readonly modelId: string;
  readonly absolutePath: string;
  receipt?: StagingReceipt;
}

interface PendingSourceRecovery {
  readonly source: SourceReceipt;
  readonly committed: StagingReceipt;
}

interface ManagedVerificationRecord {
  readonly owner?: LocalSubtitleOwnerKey;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly complete: () => void;
}

interface VerifiedManagedModel {
  readonly identity: FileIdentity;
  readonly verification: LocalSubtitleGgmlModelVerification;
}

class ImportCancelledError extends Error {
  readonly name = "ImportCancelledError";
}

class SourceRestorePendingError extends Error {
  readonly name = "SourceRestorePendingError";

  constructor(readonly source: SourceReceipt) {
    super("The selected source model still requires identity-bound recovery.");
  }
}

export class LocalSubtitleModelManager {
  readonly #managedResourceRoot: string;
  readonly #modelsRoot: string;
  readonly #stagingRoot: string;
  readonly #downloadsRoot: string;
  readonly #runtimeEnvironment: LocalSubtitleResourceEnvironment;
  readonly #supervisor: LocalSubtitleModelLoadSmokeTarget;
  readonly #registry: LocalSubtitleSessionRegistry;
  readonly #resourceJobs: LocalSubtitleResourceJobManager;
  readonly #acceleratorManager: LocalSubtitleAcceleratorManager | undefined;
  readonly #vadManager: LocalSubtitleVadManager | undefined;
  readonly #catalog: readonly LocalSubtitleModelManifestEntry[];
  readonly #verifyModelFile: typeof verifyLocalSubtitleGgmlModelFile;
  readonly #verifyServerRuntime: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly #availableBytes: (directory: string) => Promise<number>;
  readonly #stagingIdFactory: () => string;
  readonly #removeSourceFile: (absolutePath: string) => Promise<void>;
  readonly #commitModelLink: (source: string, destination: string) => Promise<void>;
  readonly #removeStagingDirectory: (absolutePath: string) => Promise<void>;
  readonly #downloadResource: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly #isResourceBusy: (resourceId: string) => boolean | Promise<boolean>;
  readonly #startupCleanup: () => Promise<void>;
  readonly #claimedModelIds = new Set<string>();
  readonly #activeModelIds = new Set<string>();
  readonly #verifiedModels = new Map<string, VerifiedManagedModel>();
  readonly #orphanedStaging = new Set<StagingReceipt>();
  readonly #pendingSourceRestores = new Set<PendingSourceRecovery>();
  readonly #pendingManagedReservations = new Map<
    string,
    PendingManagedReservation
  >();
  readonly #activeVerifications = new Set<ManagedVerificationRecord>();
  readonly #activeDeletions = new Set<Promise<void>>();
  readonly #releasedOwners = new Set<string>();
  #rootProofs: ImportRootProofs | undefined;
  #rootProofOperation: Promise<void> | undefined;
  #cleanupRetryOperation: Promise<void> | undefined;
  #initializationOperation: Promise<void> | undefined;
  #initializationComplete = false;
  #initializationFailed = false;
  #shutdownRequested = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(options: LocalSubtitleModelManagerOptions) {
    if (!options || !options.supervisor) {
      throw new TypeError("The local subtitle model manager options are invalid.");
    }
    this.#managedResourceRoot = validateManagedRoot(
      options.managedResourceRoot,
    );
    this.#modelsRoot = path.join(
      this.#managedResourceRoot,
      LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.modelsDirectoryName,
    );
    this.#stagingRoot = path.join(
      this.#managedResourceRoot,
      LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.stagingDirectoryName,
    );
    this.#downloadsRoot = path.join(
      this.#managedResourceRoot,
      LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.downloadsDirectoryName,
    );
    this.#runtimeEnvironment = options.runtimeEnvironment;
    this.#supervisor = options.supervisor;
    const sessionRegistryOwnership: LocalSubtitleSessionRegistryOwnership =
      options.sessionRegistry === undefined ? "owned" : "shared";
    this.#registry = options.sessionRegistry ?? new LocalSubtitleSessionRegistry();
    this.#resourceJobs = options.resourceJobs ??
      new LocalSubtitleResourceJobManager(this.#registry, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.jobIdFactory === undefined
          ? {}
          : { jobIdFactory: options.jobIdFactory }),
        sessionRegistryOwnership,
      });
    const platform = options.runtimeEnvironment.platform ?? process.platform;
    const arch = options.runtimeEnvironment.arch ?? process.arch;
    this.#acceleratorManager = options.acceleratorManager === false
      ? undefined
      : platform === "win32" && arch === "x64"
        ? new LocalSubtitleAcceleratorManager({
            ...options.acceleratorOptions,
            managedResourceRoot: this.#managedResourceRoot,
            platform,
            arch,
            resourceJobs: this.#resourceJobs,
            isResourceBusy: options.isResourceBusy,
          })
        : undefined;
    this.#catalog = parseLocalSubtitleModelCatalog(
      options.modelCatalog ?? LOCAL_SUBTITLE_MODEL_MANIFEST.models,
    );
    this.#verifyModelFile =
      options.verifyModelFile ?? verifyLocalSubtitleGgmlModelFile;
    this.#verifyServerRuntime = options.verifyServerRuntime ?? (() =>
      verifyLocalSubtitleRuntimeBundle({
        environment: this.#runtimeEnvironment,
        scope: "server",
      }));
    this.#availableBytes = options.availableBytes ?? availableFileSystemBytes;
    this.#stagingIdFactory = options.stagingIdFactory ?? randomUUID;
    this.#removeSourceFile = options.removeSourceFile ?? unlink;
    this.#commitModelLink = options.commitModelLink ?? link;
    this.#removeStagingDirectory = options.removeStagingDirectory ?? ((absolutePath) =>
      rm(absolutePath, {
        recursive: true,
        force: false,
        maxRetries: LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.cleanupMaxRetries,
        retryDelay: LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.cleanupRetryDelayMs,
      }));
    this.#downloadResource = options.downloadResource ??
      downloadLocalSubtitleResource;
    this.#isResourceBusy = options.isResourceBusy ?? (() => false);
    this.#startupCleanup = options.startupCleanup ?? (() =>
      cleanupLocalSubtitleResourceStartupOrphans({
        managedResourceRoot: this.#managedResourceRoot,
        platform,
        arch,
      }).then(() => undefined));
    const vadSupervisor = hasVadLoadSmoke(options.supervisor)
      ? options.supervisor
      : undefined;
    this.#vadManager = options.vadManager === false || !vadSupervisor
      ? undefined
      : new LocalSubtitleVadManager({
          ...options.vadOptions,
          managedResourceRoot: this.#managedResourceRoot,
          platform,
          resourceJobs: this.#resourceJobs,
          supervisor: vadSupervisor,
          resolveSmokeModel: (signal) =>
            this.resolveManagedModel(this.#catalog[0]!.id, signal),
          verifyServerRuntime: this.#verifyServerRuntime,
          isResourceBusy: this.#isResourceBusy,
        });
  }

  initialize(): Promise<void> {
    if (this.#initializationOperation) return this.#initializationOperation;
    if (this.#shutdownRequested) {
      return Promise.reject(managerFailure(
        "owner_released",
        "The local subtitle model manager is shutting down.",
      ));
    }
    const operation = Promise.resolve()
      .then(() => this.#startupCleanup())
      .then(
        () => {
          this.#initializationComplete = true;
        },
        (error: unknown) => {
          this.#initializationFailed = true;
          throw error;
        },
      );
    this.#initializationOperation = operation;
    return operation;
  }

  importModel(
    options: ImportLocalSubtitleModelOptions,
  ): LocalSubtitleResourceJobSummary {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(options.owner);
    validateImportMode(options.mode);
    const sourcePath = validateSourcePath(options.filePath);
    const model = this.#catalog[0]!;

    return this.#startClaimedModelJob(
      options.owner,
      model,
      (context) => this.#executeImport(
          options.owner,
          sourcePath,
          options.mode,
          model,
          context,
        ),
    );
  }

  startResourceInstall(
    owner: LocalSubtitleOwnerKey,
    resourceId: string,
  ): LocalSubtitleResourceJobSummary {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    if (this.#vadManager?.hasResourceId(resourceId)) {
      try {
        return this.#vadManager.startResourceInstall(owner, resourceId);
      } catch (error) {
        throw normalizeVadManagerError(error);
      }
    }
    if (this.#acceleratorManager?.hasResourceId(resourceId)) {
      try {
        return this.#acceleratorManager.startResourceInstall(owner, resourceId);
      } catch (error) {
        throw normalizeAcceleratorManagerError(error);
      }
    }
    const model = this.#resolveCatalogEntry(resourceId);
    return this.#startClaimedModelJob(
      owner,
      model,
      (context) => this.#executeDownload(owner, model, context),
    );
  }

  async deleteManagedResource(
    owner: LocalSubtitleOwnerKey,
    resourceId: string,
  ): Promise<Readonly<{ deleted: boolean }>> {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    if (this.#vadManager?.hasResourceId(resourceId)) {
      try {
        return await this.#vadManager.deleteManagedResource(resourceId);
      } catch (error) {
        throw normalizeVadManagerError(error);
      }
    }
    if (this.#acceleratorManager?.hasResourceId(resourceId)) {
      try {
        return await this.#acceleratorManager.deleteManagedResource(resourceId);
      } catch (error) {
        throw normalizeAcceleratorManagerError(error);
      }
    }
    const model = this.#resolveCatalogEntry(resourceId);
    this.#claimModelOperation(model.id);
    let completeDeletion!: () => void;
    const deletion = new Promise<void>((resolve) => {
      completeDeletion = resolve;
    });
    this.#activeDeletions.add(deletion);
    try {
      if (await this.#isResourceBusy(model.id)) {
        throw managerFailure(
          "resource_busy",
          "The local subtitle model is currently in use.",
        );
      }
      return Object.freeze({ deleted: await this.#deleteManagedModel(model) });
    } finally {
      this.#claimedModelIds.delete(model.id);
      this.#activeDeletions.delete(deletion);
      completeDeletion();
    }
  }

  cancelResourceJob(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
  ): Readonly<{ cancelled: boolean }> {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    return this.#resourceJobs.cancel(owner, jobId);
  }

  getSessionSnapshot(owner: LocalSubtitleOwnerKey): LocalSubtitleSessionSnapshot {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    return this.#registry.getSnapshot(owner);
  }

  onResourceEvent(
    owner: LocalSubtitleOwnerKey,
    listener: LocalSubtitleResourceEventListener,
  ): () => void {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    return this.#registry.onResourceEvent(owner, listener);
  }

  async listManagedResources(
    owner: LocalSubtitleOwnerKey,
    signal?: AbortSignal,
  ): Promise<readonly LocalSubtitleManagedResourceSummary[]> {
    this.#assertManagerAvailable();
    this.#assertOwnerAvailable(owner);
    const [models, vad, accelerators] = await Promise.all([
      Promise.all(this.#catalog.map(async (model) => {
        const base = {
          resourceId: model.id,
          resourceType: "model" as const,
          displayName: model.id,
          version: model.engineCompatibility,
          byteSize: model.byteSize,
          isDefault: model.defaultRecommended,
          compatibleBackends: ["cpu", "cuda", "metal"] as Array<
            "cpu" | "cuda" | "metal"
          >,
        };
        if (
          this.#claimedModelIds.has(model.id) ||
          this.#activeModelIds.has(model.id)
        ) {
          return Object.freeze({ ...base, status: "installing" as const });
        }
        if (this.#pendingManagedReservations.has(model.id)) {
          return Object.freeze({
            ...base,
            status: "invalid" as const,
            errorCode: "cancel_failed" as const,
          });
        }
        try {
          const present = await this.#hasManagedModel(model, owner, signal);
          if (!present) {
            return Object.freeze({ ...base, status: "not_installed" as const });
          }
          return Object.freeze({ ...base, status: "ready" as const });
        } catch (error) {
          if (
            signal?.aborted ||
            this.#shutdownRequested ||
            isLifecycleCancellation(error)
          ) {
            throw error;
          }
          return Object.freeze({
            ...base,
            status: "invalid" as const,
            errorCode: modelErrorCode(error),
          });
        }
      })),
      this.#vadManager?.listManagedResources(signal) ?? Promise.resolve([]),
      this.#acceleratorManager?.listManagedResources(signal) ?? Promise.resolve([]),
    ]);
    return Object.freeze([...models, ...vad, ...accelerators]);
  }

  async resolveManagedModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerManagedResourceIdentity<"managed">> {
    this.#assertManagerAvailable();
    const model = this.#resolveCatalogEntry(modelId);
    if (
      this.#activeModelIds.has(model.id) ||
      this.#claimedModelIds.has(model.id) ||
      this.#pendingManagedReservations.has(model.id)
    ) {
      throw managerFailure(
        "resource_busy",
        "The local subtitle model is still being imported.",
      );
    }
    const verification = await this.#verifyManagedModel(model, undefined, signal);
    return Object.freeze({
      storage: "managed" as const,
      id: model.id,
      absolutePath: verification.absolutePath,
      byteSize: verification.byteSize,
      sha256: verification.sha256,
    });
  }

  async resolveManagedVad(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerManagedResourceIdentity<"managed">> {
    this.#assertManagerAvailable();
    if (!this.#vadManager?.hasResourceId(resourceId)) {
      throw managerFailure(
        "resource_not_allowed",
        "The requested local subtitle VAD is not allowlisted.",
      );
    }
    try {
      return await this.#vadManager.resolveManagedVad(resourceId, signal);
    } catch (error) {
      throw normalizeVadManagerError(error);
    }
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    const key = modelOwnerKey(owner);
    if (this.#releasedOwners.has(key)) return;
    this.#registry.assertOwnerActive(owner);
    this.#releasedOwners.add(key);
    let releaseFailure: unknown;
    let releaseFailed = false;
    try {
      this.#resourceJobs.releaseOwner(owner);
    } catch (error) {
      releaseFailure = error;
      releaseFailed = true;
    }
    for (const verification of this.#activeVerifications) {
      if (sameOwner(verification.owner, owner)) {
        verification.controller.abort(
          managerFailure(
            "owner_released",
            "The local subtitle owner session was released.",
          ),
        );
      }
    }
    if (releaseFailed) throw releaseFailure;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#shutdownOperation = operation;
    this.#shutdownRequested = true;
    for (const verification of this.#activeVerifications) {
      verification.controller.abort(
        managerFailure(
          "owner_released",
          "The local subtitle model manager is shutting down.",
        ),
      );
    }
    void Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled([
          ...(this.#initializationOperation
            ? [this.#initializationOperation]
            : []),
          this.#resourceJobs.shutdown(),
          this.#waitForActiveVerifications(),
          this.#waitForActiveDeletions(),
          ...(this.#acceleratorManager
            ? [this.#acceleratorManager.shutdown()]
            : []),
          ...(this.#vadManager ? [this.#vadManager.shutdown()] : []),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        await this.#retryOutstandingCleanup();
        if (failure) throw failure.reason;
      })
      .then(resolveOperation, (error: unknown) => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
        }
        rejectOperation(error);
      });
    return operation;
  }

  async waitForIdle(): Promise<void> {
    await this.#resourceJobs.waitForIdle();
    await this.#waitForActiveVerifications();
    await this.#waitForActiveDeletions();
    await this.#acceleratorManager?.waitForIdle();
    await this.#vadManager?.waitForIdle();
    await this.#retryOutstandingCleanup();
  }

  #retryOutstandingCleanup(): Promise<void> {
    if (this.#cleanupRetryOperation) return this.#cleanupRetryOperation;
    const operation = this.#performOutstandingCleanup();
    this.#cleanupRetryOperation = operation;
    void operation.then(
      () => {
        if (this.#cleanupRetryOperation === operation) {
          this.#cleanupRetryOperation = undefined;
        }
      },
      () => {
        if (this.#cleanupRetryOperation === operation) {
          this.#cleanupRetryOperation = undefined;
        }
      },
    );
    return operation;
  }

  async #performOutstandingCleanup(): Promise<void> {
    let failed = false;
    for (const recovery of [...this.#pendingSourceRestores]) {
      try {
        await restoreSourceQuarantine(recovery.source);
        await this.#cleanupStaging(recovery.committed);
        this.#pendingSourceRestores.delete(recovery);
      } catch {
        failed = true;
      }
    }
    const cleanupReceipts = new Set(this.#orphanedStaging);
    const sourceRecoveryReceipts = new Set(
      [...this.#pendingSourceRestores].map((recovery) => recovery.committed),
    );
    for (const pending of this.#pendingManagedReservations.values()) {
      if (this.#activeModelIds.has(pending.modelId)) continue;
      if (pending.receipt && !sourceRecoveryReceipts.has(pending.receipt)) {
        cleanupReceipts.add(pending.receipt);
      }
      else failed = true;
    }
    for (const staging of cleanupReceipts) {
      try {
        await this.#cleanupStaging(staging);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      throw managerFailure(
        "cancel_failed",
        "A local subtitle model staging directory still requires cleanup.",
      );
    }
  }

  async #waitForActiveVerifications(): Promise<void> {
    while (this.#activeVerifications.size > 0) {
      await Promise.all(
        [...this.#activeVerifications].map((record) => record.completion),
      );
    }
  }

  async #waitForActiveDeletions(): Promise<void> {
    while (this.#activeDeletions.size > 0) {
      await Promise.all([...this.#activeDeletions]);
    }
  }

  #startClaimedModelJob(
    owner: LocalSubtitleOwnerKey,
    model: LocalSubtitleModelManifestEntry,
    execute: (
      context: LocalSubtitleResourceJobContext,
    ) => Promise<LocalSubtitleResourceJobExecutionResult>,
  ): LocalSubtitleResourceJobSummary {
    this.#claimModelOperation(model.id);
    try {
      return this.#resourceJobs.start({
        owner,
        resourceId: model.id,
        resourceType: "model",
        execute: async (context) => {
          try {
            return await execute(context);
          } finally {
            this.#claimedModelIds.delete(model.id);
          }
        },
      });
    } catch (error) {
      this.#claimedModelIds.delete(model.id);
      throw error;
    }
  }

  #claimModelOperation(modelId: string): void {
    if (
      this.#claimedModelIds.has(modelId) ||
      this.#activeModelIds.has(modelId) ||
      this.#pendingManagedReservations.has(modelId)
    ) {
      throw managerFailure(
        "resource_busy",
        "The selected local subtitle model already has an active resource operation.",
      );
    }
    this.#claimedModelIds.add(modelId);
  }

  async #executeDownload(
    owner: LocalSubtitleOwnerKey,
    model: LocalSubtitleModelManifestEntry,
    context: LocalSubtitleResourceJobContext,
  ): Promise<LocalSubtitleResourceJobExecutionResult> {
    let staging: StagingReceipt | undefined;
    let committed: StagingReceipt | undefined;
    let completed = false;
    let commitStarted = false;
    let outcome: LocalSubtitleResourceJobExecutionResult | undefined;

    this.#activeModelIds.add(model.id);
    try {
      context.update({
        status: "acquiring",
        progress: 1,
        bytesCompleted: 0,
        bytesTotal: model.byteSize,
      });
      throwIfCancelled(context);
      await this.#retryOutstandingCleanup();
      await this.#ensureImportRoots();
      if (await this.#hasManagedModel(model, owner, context.signal)) {
        throw managerFailure(
          "resource_busy",
          "The selected local subtitle model is already installed.",
        );
      }
      staging = await this.#createStaging(model);
      const stagedPath = path.join(staging.currentPath, staging.fileName);
      await this.#downloadResource({
        sourceUrl: model.downloadUrl,
        allowedHosts: model.allowedDownloadHosts,
        expectedBytes: model.byteSize,
        downloadDirectory: this.#downloadsRoot,
        partFileName: `${model.id}.part`,
        metadataFileName: `${model.id}.part.json`,
        destinationPath: stagedPath,
        signal: context.signal,
        ensureCapacity: (remainingBytes) =>
          this.#assertDiskSpace(remainingBytes),
        onProgress: (completedBytes, totalBytes) => {
          context.update({
            status: "acquiring",
            progress: Math.min(
              55,
              5 + (completedBytes / totalBytes) * 50,
            ),
            bytesCompleted: completedBytes,
            bytesTotal: totalBytes,
          });
        },
      });
      const downloadedStats = await lstat(stagedPath);
      if (!downloadedStats.isFile() || downloadedStats.isSymbolicLink()) {
        throw managerFailure(
          "model_corrupt",
          "The downloaded local subtitle model staging file is invalid.",
        );
      }
      staging.fileIdentity = fileIdentity(downloadedStats);
      await this.#assertImportRoots();
      await this.#assertStagingIdentity(staging);

      context.update({
        status: "verifying",
        progress: 65,
        bytesCompleted: model.byteSize,
        bytesTotal: model.byteSize,
      });
      throwIfCancelled(context);
      const verification = await this.#verifyModelFile(stagedPath, {
        modelId: model.id,
        byteSize: model.byteSize,
        sha256: model.sha256,
        ggml: model.ggml,
      }, context.signal);
      assertVerifiedModelMatches(verification, model, stagedPath);
      const stagedGuard = await open(stagedPath, READ_ONLY_NOFOLLOW_FLAGS);
      try {
        const guardedIdentity = fileIdentity(await stagedGuard.stat());
        assertSameFileIdentity(verification.fileIdentity, guardedIdentity);
        await assertPathStillNamesFile(stagedPath, guardedIdentity);
        staging.fileIdentity = guardedIdentity;

        context.update({
          status: "load_smoke",
          progress: 80,
          bytesCompleted: model.byteSize,
          bytesTotal: model.byteSize,
        });
        throwIfCancelled(context);
        const runtime = await this.#verifyServerRuntime();
        const serverArtifactId = selectLocalSubtitleCpuServerArtifactId(runtime);
        await this.#supervisor.smokeModelLoad(
          owner,
          {
            purpose: "model_load_smoke",
            backend: "cpu",
            verifiedRuntime: runtime,
            serverArtifactId,
            model: {
              storage: "managed_staging",
              id: model.id,
              absolutePath: stagedPath,
              byteSize: model.byteSize,
              sha256: model.sha256,
            },
            threads: LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.smokeThreads,
          },
          context.signal,
        );
        await this.#assertStagingIdentity(staging);
        assertSameFileIdentity(
          staging.fileIdentity,
          fileIdentity(await stagedGuard.stat()),
        );
      } finally {
        await stagedGuard.close();
      }
      throwIfCancelled(context);

      context.update({
        status: "committing",
        progress: 95,
        bytesCompleted: model.byteSize,
        bytesTotal: model.byteSize,
      });
      commitStarted = true;
      committed = await this.#commitStaging(staging, model);
      await this.#cleanupStaging(staging);
      const finalPath = path.join(committed.currentPath, committed.fileName);
      const finalIdentity = fileIdentity(await lstat(finalPath));
      assertSameFileObjectAndContent(verification.fileIdentity, finalIdentity);
      committed.fileIdentity = finalIdentity;
      await this.#assertStagingIdentity(committed);
      this.#verifiedModels.set(model.id, {
        identity: finalIdentity,
        verification: Object.freeze({
          ...verification,
          absolutePath: finalPath,
          fileIdentity: finalIdentity,
        }),
      });
      completed = true;
      this.#pendingManagedReservations.delete(model.id);
      outcome = { status: "completed" };
    } catch (error) {
      outcome = !commitStarted && isCancellation(error, context)
        ? { status: "cancelled" }
        : { status: "failed", error: toResourceJobError(error) };
    }

    if (!completed) {
      for (const receipt of [committed, staging]) {
        if (!receipt || receipt.cleanupConfirmed) continue;
        try {
          await this.#cleanupStaging(receipt);
        } catch {
          this.#orphanedStaging.add(receipt);
          outcome = failedJob(
            "cancel_failed",
            "The local subtitle model download staging area could not be removed safely.",
          );
        }
      }
    }
    this.#activeModelIds.delete(model.id);
    return outcome ?? failedJob(
      "model_download_failed",
      "The local subtitle model download did not reach a terminal state.",
    );
  }

  async #executeImport(
    owner: LocalSubtitleOwnerKey,
    sourcePath: string,
    mode: LocalSubtitleModelImportMode,
    model: LocalSubtitleModelManifestEntry,
    context: LocalSubtitleResourceJobContext,
  ): Promise<LocalSubtitleResourceJobExecutionResult> {
    let staging: StagingReceipt | undefined;
    let committed: StagingReceipt | undefined;
    let source: SourceReceipt | undefined;
    let completed = false;
    let commitStarted = false;
    let sourceRecoveryPending = false;
    let outcome: LocalSubtitleResourceJobExecutionResult | undefined;

    if (
      this.#activeModelIds.has(model.id) ||
      this.#pendingManagedReservations.has(model.id)
    ) {
      return failedJob(
        "resource_busy",
        "The selected local subtitle model is already being imported.",
      );
    }
    this.#activeModelIds.add(model.id);
    try {
      context.update({
        status: "acquiring",
        progress: 1,
        bytesCompleted: 0,
        bytesTotal: model.byteSize,
      });
      throwIfCancelled(context);
      await this.#retryOutstandingCleanup();
      await this.#ensureImportRoots();
      await this.#assertSourceOutsideManagedRoot(sourcePath);
      await this.#assertDiskSpace(model.byteSize);
      staging = await this.#createStaging(model);
      source = await this.#copyIntoStaging(
        sourcePath,
        staging,
        model,
        context,
      );
      if (mode === "copy") await closeSourceHandle(source);

      context.update({
        status: "verifying",
        progress: 65,
        bytesCompleted: model.byteSize,
        bytesTotal: model.byteSize,
      });
      throwIfCancelled(context);
      const stagedPath = path.join(staging.currentPath, staging.fileName);
      const verification = await this.#verifyModelFile(stagedPath, {
        modelId: model.id,
        byteSize: model.byteSize,
        sha256: model.sha256,
        ggml: model.ggml,
      }, context.signal);
      assertVerifiedModelMatches(verification, model, stagedPath);
      const stagedGuard = await open(stagedPath, READ_ONLY_NOFOLLOW_FLAGS);
      try {
        const guardedIdentity = fileIdentity(await stagedGuard.stat());
        assertSameFileIdentity(
          verification.fileIdentity,
          guardedIdentity,
        );
        await assertPathStillNamesFile(stagedPath, guardedIdentity);
        staging.fileIdentity = guardedIdentity;

        context.update({
          status: "load_smoke",
          progress: 80,
          bytesCompleted: model.byteSize,
          bytesTotal: model.byteSize,
        });
        throwIfCancelled(context);
        const runtime = await this.#verifyServerRuntime();
        const serverArtifactId = selectLocalSubtitleCpuServerArtifactId(runtime);
        await this.#supervisor.smokeModelLoad(
          owner,
          {
            purpose: "model_load_smoke",
            backend: "cpu",
            verifiedRuntime: runtime,
            serverArtifactId,
            model: {
              storage: "managed_staging",
              id: model.id,
              absolutePath: stagedPath,
              byteSize: model.byteSize,
              sha256: model.sha256,
            },
            threads: LOCAL_SUBTITLE_MODEL_MANAGER_POLICY.smokeThreads,
          },
          context.signal,
        );
        await this.#assertStagingIdentity(staging);
        assertSameFileIdentity(
          staging.fileIdentity,
          fileIdentity(await stagedGuard.stat()),
        );
      } finally {
        await stagedGuard.close();
      }
      throwIfCancelled(context);

      context.update({
        status: "committing",
        progress: 95,
        bytesCompleted: model.byteSize,
        bytesTotal: model.byteSize,
      });
      commitStarted = true;
      committed = await this.#commitStaging(staging, model);
      await this.#cleanupStaging(staging);
      const finalPath = path.join(committed.currentPath, committed.fileName);
      const finalIdentity = fileIdentity(await lstat(finalPath));
      assertSameFileObjectAndContent(
        verification.fileIdentity,
        finalIdentity,
      );
      committed.fileIdentity = finalIdentity;
      await this.#assertStagingIdentity(committed);
      this.#verifiedModels.set(model.id, {
        identity: finalIdentity,
        verification: Object.freeze({
          ...verification,
          absolutePath: finalPath,
          fileIdentity: finalIdentity,
        }),
      });
      if (mode === "move") {
        try {
          await this.#removeVerifiedSource(source);
        } catch (error) {
          this.#verifiedModels.delete(model.id);
          if (error instanceof SourceRestorePendingError) {
            this.#pendingSourceRestores.add({
              source: error.source,
              committed,
            });
            sourceRecoveryPending = true;
          }
          throw error;
        }
      }
      completed = true;
      this.#pendingManagedReservations.delete(model.id);
      outcome = { status: "completed" };
    } catch (error) {
      outcome = !commitStarted && isCancellation(error, context)
        ? { status: "cancelled" }
        : { status: "failed", error: toResourceJobError(error) };
    }

    try {
      await closeSourceHandle(source);
    } catch {
      outcome = failedJob(
        "cancel_failed",
        "The selected local subtitle model file could not be released safely.",
      );
    }

    if (!completed) {
      for (const receipt of [
        sourceRecoveryPending ? undefined : committed,
        staging,
      ]) {
        if (!receipt || receipt.cleanupConfirmed) continue;
        try {
          await this.#cleanupStaging(receipt);
        } catch {
          this.#orphanedStaging.add(receipt);
          outcome = failedJob(
            "cancel_failed",
            "The local subtitle model staging area could not be removed safely.",
          );
        }
      }
    }
    this.#activeModelIds.delete(model.id);
    return outcome ?? failedJob(
      "model_download_failed",
      "The local subtitle model import did not reach a terminal state.",
    );
  }

  async #ensureImportRoots(): Promise<void> {
    if (this.#rootProofOperation) return this.#rootProofOperation;
    const operation = this.#createOrVerifyImportRoots();
    this.#rootProofOperation = operation;
    try {
      await operation;
    } finally {
      if (this.#rootProofOperation === operation) {
        this.#rootProofOperation = undefined;
      }
    }
  }

  async #createOrVerifyImportRoots(): Promise<void> {
    if (this.#rootProofs) {
      await verifyImportRootProofs(this.#rootProofs);
      return;
    }
    const managed = await ensurePrivateDirectory(this.#managedResourceRoot);
    const models = await ensurePrivateDirectory(this.#modelsRoot);
    const staging = await ensurePrivateDirectory(this.#stagingRoot);
    const downloads = await ensurePrivateDirectory(this.#downloadsRoot);
    const proofs = Object.freeze({ managed, models, staging, downloads });
    assertImportRootContainment(proofs);
    await verifyImportRootProofs(proofs);
    this.#rootProofs = proofs;
  }

  async #assertImportRoots(): Promise<void> {
    const proofs = this.#rootProofs;
    if (!proofs) {
      throw managerFailure(
        "resource_not_allowed",
        "The managed local subtitle model roots are not initialized.",
      );
    }
    await verifyImportRootProofs(proofs);
  }

  async #assertStagingRoot(): Promise<void> {
    const proofs = this.#rootProofs;
    if (!proofs) {
      throw managerFailure(
        "resource_not_allowed",
        "The managed local subtitle staging root is not initialized.",
      );
    }
    await Promise.all([
      verifyPrivateDirectoryProof(proofs.managed),
      verifyPrivateDirectoryProof(proofs.staging),
    ]);
    if (!isContainedPath(proofs.managed.realPath, proofs.staging.realPath)) {
      throw managerFailure(
        "resource_not_allowed",
        "The managed local subtitle staging root escaped its private root.",
      );
    }
  }

  async #assertSourceOutsideManagedRoot(sourcePath: string): Promise<void> {
    await this.#assertImportRoots();
    const managedRealPath = this.#rootProofs!.managed.realPath;
    let sourceRealPath: string;
    try {
      sourceRealPath = await realpath(sourcePath);
    } catch {
      return;
    }
    if (isContainedPath(managedRealPath, sourceRealPath)) {
      throw managerFailure(
        "resource_not_allowed",
        "A managed local subtitle model cannot be imported as an external source.",
      );
    }
  }

  async #assertDiskSpace(requiredBytes: number): Promise<void> {
    await this.#assertImportRoots();
    let available: number;
    try {
      available = await this.#availableBytes(this.#stagingRoot);
    } catch {
      throw managerFailure(
        "model_disk_full",
        "Available disk space for the local subtitle model could not be verified.",
      );
    }
    await this.#assertImportRoots();
    if (!Number.isSafeInteger(available) || available < requiredBytes) {
      throw managerFailure(
        "model_disk_full",
        "There is not enough disk space to import the local subtitle model.",
      );
    }
  }

  async #createStaging(
    model: LocalSubtitleModelManifestEntry,
  ): Promise<StagingReceipt> {
    await this.#assertImportRoots();
    const prefix = path.join(
      this.#stagingRoot,
      `.import-${sanitizeStagingId(this.#stagingIdFactory())}-`,
    );
    const root = await mkdtemp(prefix);
    const proof = await readPrivateDirectoryProof(root);
    const receipt: StagingReceipt = {
      modelId: model.id,
      phase: "staging",
      currentPath: root,
      stagingRoot: this.#stagingRoot,
      directoryIdentity: directoryIdentity(proof),
      fileName: model.fileName,
      quarantined: false,
      cleanupConfirmed: false,
    };
    try {
      await this.#assertImportRoots();
      if (!isContainedPath(this.#rootProofs!.staging.realPath, proof.realPath)) {
        throw managerFailure(
          "resource_not_allowed",
          "The local subtitle model staging directory escaped its private root.",
        );
      }
      return receipt;
    } catch (error) {
      try {
        await this.#cleanupStaging(receipt);
      } catch {
        this.#orphanedStaging.add(receipt);
        throw managerFailure(
          "cancel_failed",
          "The invalid local subtitle staging directory could not be removed safely.",
        );
      }
      throw error;
    }
  }

  async #copyIntoStaging(
    sourcePath: string,
    staging: StagingReceipt,
    model: LocalSubtitleModelManifestEntry,
    context: LocalSubtitleResourceJobContext,
  ): Promise<SourceReceipt> {
    const sourceStats = await lstatModelSource(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new LocalSubtitleModelError(
        "model_incompatible",
        "path",
        "The selected model must be a regular GGML file, not a directory or symbolic link.",
      );
    }
    if (sourceStats.size !== model.byteSize) {
      throw new LocalSubtitleModelError(
        "model_corrupt",
        "integrity",
        "The selected model has an unexpected byte size.",
      );
    }

    const parentPath = path.dirname(sourcePath);
    const parentStats = await lstatModelSource(parentPath);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new LocalSubtitleModelError(
        "model_incompatible",
        "path",
        "The selected model parent directory is invalid.",
      );
    }
    const destinationPath = path.join(staging.currentPath, staging.fileName);
    let sourceHandle: FileHandle | undefined;
    let destinationHandle: FileHandle | undefined;
    let retainSourceHandle = false;
    try {
      sourceHandle = await open(sourcePath, READ_ONLY_NOFOLLOW_FLAGS);
      const openedSourceStats = await sourceHandle.stat();
      assertSameFileIdentity(fileIdentity(sourceStats), fileIdentity(openedSourceStats));
      const header = Buffer.alloc(48);
      const headerRead = await sourceHandle.read(header, 0, header.length, 0);
      if (headerRead.bytesRead !== header.length) {
        throw new LocalSubtitleModelError(
          "model_corrupt",
          "header",
          "The selected GGML model header is truncated.",
        );
      }
      verifyLocalSubtitleGgmlModelHeader(header, model.ggml);

      destinationHandle = await open(
        destinationPath,
        WRITE_EXCLUSIVE_NOFOLLOW_FLAGS,
        0o600,
      );
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
      let position = 0;
      let nextProgressAt = 0;
      while (position < model.byteSize) {
        throwIfCancelled(context);
        const requested = Math.min(chunk.length, model.byteSize - position);
        const { bytesRead } = await sourceHandle.read(
          chunk,
          0,
          requested,
          position,
        );
        if (bytesRead === 0) {
          throw new LocalSubtitleModelError(
            "model_corrupt",
            "integrity",
            "The selected model ended before its declared size.",
          );
        }
        await writeAll(destinationHandle, chunk.subarray(0, bytesRead), position);
        hash.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
        if (position >= nextProgressAt || position === model.byteSize) {
          context.update({
            status: "acquiring",
            progress: Math.min(55, 5 + (position / model.byteSize) * 50),
            bytesCompleted: position,
            bytesTotal: model.byteSize,
          });
          nextProgressAt = position + Math.max(
            COPY_CHUNK_BYTES,
            Math.ceil(model.byteSize / 100),
          );
        }
      }
      await destinationHandle.sync();
      const completedSourceStats = await sourceHandle.stat();
      assertSameFileIdentity(
        fileIdentity(openedSourceStats),
        fileIdentity(completedSourceStats),
      );
      await assertPathStillNamesFile(sourcePath, fileIdentity(completedSourceStats));
      if (hash.digest("hex") !== model.sha256) {
        throw new LocalSubtitleModelError(
          "model_corrupt",
          "integrity",
          "The selected model failed its SHA-256 check.",
        );
      }
      const receipt: SourceReceipt = {
        modelId: model.id,
        absolutePath: sourcePath,
        identity: fileIdentity(completedSourceStats),
        parentPath,
        parentIdentity: directoryIdentity(parentStats),
        handle: sourceHandle,
      };
      retainSourceHandle = true;
      return receipt;
    } catch (error) {
      if (error instanceof LocalSubtitleModelError || error instanceof ImportCancelledError) {
        throw error;
      }
      throw managerFailure(
        isNodeError(error, "ENOSPC") ? "model_disk_full" : "model_download_failed",
        "The selected model could not be copied into managed staging.",
      );
    } finally {
      await Promise.allSettled([
        retainSourceHandle ? undefined : sourceHandle?.close(),
        destinationHandle?.close(),
      ]);
    }
  }

  async #assertStagingIdentity(staging: StagingReceipt): Promise<void> {
    const directoryStats = await lstat(staging.currentPath);
    assertSameDirectoryIdentity(
      staging.directoryIdentity,
      directoryIdentity(directoryStats),
    );
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw managerFailure(
        "model_corrupt",
        "The local subtitle model staging directory changed during verification.",
      );
    }
    const fileStats = await lstat(path.join(staging.currentPath, staging.fileName));
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw managerFailure(
        "model_corrupt",
        "The staged local subtitle model changed during verification.",
      );
    }
    assertSameFileIdentity(staging.fileIdentity, fileIdentity(fileStats));
  }

  async #commitStaging(
    staging: StagingReceipt,
    model: LocalSubtitleModelManifestEntry,
  ): Promise<StagingReceipt> {
    await this.#assertImportRoots();
    await this.#assertStagingIdentity(staging);
    const finalDirectory = this.#finalModelDirectory(model);
    try {
      await mkdir(finalDirectory, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw managerFailure(
          "resource_busy",
          "The managed local subtitle model already exists.",
        );
      }
      throw managerFailure(
        isNodeError(error, "ENOSPC") ? "model_disk_full" : "model_download_failed",
        "The managed local subtitle model directory could not be reserved.",
      );
    }
    const pending: PendingManagedReservation = {
      modelId: model.id,
      absolutePath: finalDirectory,
    };
    this.#pendingManagedReservations.set(model.id, pending);
    let committed: StagingReceipt | undefined;
    try {
      const finalDirectoryProof = await readPrivateDirectoryProof(finalDirectory);
      committed = {
        modelId: model.id,
        phase: "managed_reservation",
        currentPath: finalDirectory,
        stagingRoot: staging.stagingRoot,
        directoryIdentity: directoryIdentity(finalDirectoryProof),
        fileName: model.fileName,
        quarantined: false,
        cleanupConfirmed: false,
      };
      pending.receipt = committed;
      await this.#assertImportRoots();
      if (
        !isContainedPath(
          this.#rootProofs!.models.realPath,
          finalDirectoryProof.realPath,
        )
      ) {
        throw managerFailure(
          "resource_not_allowed",
          "The managed local subtitle model reservation escaped its private root.",
        );
      }
      const stagedPath = path.join(staging.currentPath, staging.fileName);
      const finalPath = path.join(finalDirectory, model.fileName);
      try {
        await this.#commitModelLink(stagedPath, finalPath);
      } catch (error) {
        throw managerFailure(
          isNodeError(error, "ENOSPC") ? "model_disk_full" : "model_download_failed",
          "The local subtitle model could not be committed atomically.",
        );
      }
      const stagedIdentity = fileIdentity(await lstat(stagedPath));
      assertSameFileObjectAndContent(staging.fileIdentity!, stagedIdentity);
      staging.fileIdentity = stagedIdentity;
      const finalIdentity = fileIdentity(await lstat(finalPath));
      assertSameFileIdentity(stagedIdentity, finalIdentity);
      committed.fileIdentity = finalIdentity;
      await this.#assertImportRoots();
      await this.#assertStagingIdentity(staging);
      await this.#assertStagingIdentity(committed);
      return committed;
    } catch (error) {
      if (!committed) {
        throw managerFailure(
          "cancel_failed",
          "The managed model reservation could not be proven for cleanup.",
        );
      }
      try {
        await this.#cleanupStaging(committed);
      } catch {
        this.#orphanedStaging.add(committed);
        throw managerFailure(
          "cancel_failed",
          "The failed managed model reservation could not be removed safely.",
        );
      }
      throw error;
    }
  }

  async #removeVerifiedSource(source: SourceReceipt): Promise<void> {
    const handle = source.handle;
    if (!handle) {
      throw managerFailure(
        "cancel_failed",
        "The selected local subtitle model file is no longer guarded.",
      );
    }
    assertSameFileIdentity(source.identity, fileIdentity(await handle.stat()));
    const parentStats = await lstat(source.parentPath);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw managerFailure(
        "model_corrupt",
        "The selected model parent directory changed during import.",
      );
    }
    assertSameDirectoryIdentity(
      source.parentIdentity,
      directoryIdentity(parentStats),
    );
    await assertPathStillNamesFile(source.absolutePath, source.identity);
    const quarantinePath = path.join(
      source.parentPath,
      `.fusionkit-model-move-${sanitizeStagingId(this.#stagingIdFactory())}`,
    );
    try {
      await link(source.absolutePath, quarantinePath);
      source.quarantinePath = quarantinePath;
      const linkedHandleIdentity = fileIdentity(await handle.stat());
      assertSameFileObjectAndContent(source.identity, linkedHandleIdentity);
      source.identity = linkedHandleIdentity;
      const quarantinedStats = await lstat(quarantinePath);
      if (!quarantinedStats.isFile() || quarantinedStats.isSymbolicLink()) {
        throw new LocalSubtitleModelError(
          "model_corrupt",
          "integrity",
          "The selected model changed while preparing the move.",
        );
      }
      assertSameFileIdentity(source.identity, fileIdentity(quarantinedStats));
      const currentSourceStats = lstatSync(source.absolutePath);
      if (!currentSourceStats.isFile() || currentSourceStats.isSymbolicLink()) {
        throw new LocalSubtitleModelError(
          "model_corrupt",
          "integrity",
          "The selected model changed while preparing the move.",
        );
      }
      assertSameFileIdentity(source.identity, fileIdentity(currentSourceStats));
      unlinkSync(source.absolutePath);
      const unlinkedIdentity = fileIdentity(await handle.stat());
      assertSameFileObjectAndContent(source.identity, unlinkedIdentity);
      source.identity = unlinkedIdentity;
      await assertPathStillNamesFile(quarantinePath, source.identity);
      await closeSourceHandle(source);
      await assertPathStillNamesFile(quarantinePath, source.identity);
      await this.#removeSourceFile(quarantinePath);
      if (await pathExistsNoFollow(quarantinePath)) {
        throw new Error("source quarantine removal did not reach ENOENT");
      }
      source.quarantinePath = undefined;
    } catch (error) {
      await closeSourceHandle(source).catch(() => undefined);
      try {
        await restoreSourceQuarantine(source);
      } catch {
        throw new SourceRestorePendingError(source);
      }
      if (error instanceof LocalSubtitleModelError) throw error;
      throw managerFailure(
        "model_download_failed",
        "The source model could not be removed after managed commit.",
      );
    }
  }

  async #cleanupStaging(staging: StagingReceipt): Promise<void> {
    if (staging.cleanupConfirmed) return;
    await this.#assertStagingRoot();
    let stats: Stats;
    try {
      stats = await lstat(staging.currentPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        const rediscovered = await rediscoverStagingQuarantine(staging);
        if (!rediscovered) {
          throw new Error("staging directory disappeared before cleanup proof");
        }
        staging.currentPath = rediscovered;
        staging.quarantined = true;
        stats = await lstat(rediscovered);
      } else {
        throw error;
      }
    }
    assertSameDirectoryIdentity(
      staging.directoryIdentity,
      directoryIdentity(stats),
    );
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("staging directory identity mismatch");
    }
    if (!staging.quarantined) {
      const quarantine = path.join(
        staging.stagingRoot,
        `.cleanup-${sanitizeStagingId(this.#stagingIdFactory())}`,
      );
      await rename(staging.currentPath, quarantine);
      staging.currentPath = quarantine;
      staging.quarantined = true;
    }
    const quarantinedStats = await lstat(staging.currentPath);
    assertSameDirectoryIdentity(
      staging.directoryIdentity,
      directoryIdentity(quarantinedStats),
    );
    const stagingRootRealPath = await realpath(staging.stagingRoot);
    const quarantineRealPath = await realpath(staging.currentPath);
    if (!isContainedPath(stagingRootRealPath, quarantineRealPath)) {
      throw new Error("staging quarantine escaped its private root");
    }
    await this.#removeStagingDirectory(staging.currentPath);
    if (await pathExistsNoFollow(staging.currentPath)) {
      throw new Error("staging directory removal did not reach ENOENT");
    }
    const residual = await rediscoverStagingQuarantine(staging);
    if (residual) {
      staging.currentPath = residual;
      throw new Error("staging directory identity survived cleanup");
    }
    staging.cleanupConfirmed = true;
    this.#orphanedStaging.delete(staging);
    if (
      staging.phase === "managed_reservation" &&
      this.#pendingManagedReservations.get(staging.modelId)?.receipt === staging
    ) {
      this.#pendingManagedReservations.delete(staging.modelId);
    }
  }

  async #deleteManagedModel(
    model: LocalSubtitleModelManifestEntry,
  ): Promise<boolean> {
    await this.#retryOutstandingCleanup();
    await this.#ensureImportRoots();
    const finalDirectory = this.#finalModelDirectory(model);
    let directoryStats: Stats;
    try {
      directoryStats = await lstat(finalDirectory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw managerFailure(
        "model_download_failed",
        "The managed local subtitle model could not be inspected for deletion.",
      );
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw managerFailure(
        "model_corrupt",
        "The managed local subtitle model directory is invalid.",
      );
    }
    await this.#verifyManagedModel(model);
    if (await this.#isResourceBusy(model.id)) {
      throw managerFailure(
        "resource_busy",
        "The local subtitle model is currently in use.",
      );
    }
    await this.#assertImportRoots();
    const finalPath = this.#finalModelPath(model);
    const guard = await open(finalPath, READ_ONLY_NOFOLLOW_FLAGS);
    let fileProof: FileIdentity;
    try {
      fileProof = fileIdentity(await guard.stat());
      await assertPathStillNamesFile(finalPath, fileProof);
    } finally {
      await guard.close();
    }

    const quarantinePath = path.join(
      this.#stagingRoot,
      `.delete-${sanitizeStagingId(this.#stagingIdFactory())}`,
    );
    const receipt: StagingReceipt = {
      modelId: model.id,
      phase: "managed_reservation",
      currentPath: quarantinePath,
      stagingRoot: this.#stagingRoot,
      directoryIdentity: directoryIdentity(directoryStats),
      fileName: model.fileName,
      fileIdentity: fileProof,
      quarantined: true,
      cleanupConfirmed: false,
    };
    try {
      await rename(finalDirectory, quarantinePath);
    } catch (error) {
      throw managerFailure(
        isNodeError(error, "EBUSY") ||
          isNodeError(error, "EPERM") ||
          isNodeError(error, "EACCES")
          ? "resource_busy"
          : "model_download_failed",
        "The managed local subtitle model could not be reserved for deletion.",
      );
    }
    this.#pendingManagedReservations.set(model.id, {
      modelId: model.id,
      absolutePath: quarantinePath,
      receipt,
    });
    this.#verifiedModels.delete(model.id);
    try {
      await this.#assertStagingIdentity(receipt);
      await this.#cleanupStaging(receipt);
      return true;
    } catch {
      this.#orphanedStaging.add(receipt);
      throw managerFailure(
        "cancel_failed",
        "The managed local subtitle model deletion still requires cleanup.",
      );
    }
  }

  async #hasManagedModel(
    model: LocalSubtitleModelManifestEntry,
    owner: LocalSubtitleOwnerKey,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.#rootProofs) await this.#assertImportRoots();
    await assertExistingManagedRootState(
      this.#managedResourceRoot,
      this.#modelsRoot,
      this.#stagingRoot,
      this.#downloadsRoot,
    );
    const finalDirectory = this.#finalModelDirectory(model);
    try {
      await lstat(finalDirectory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    await this.#verifyManagedModel(model, owner, signal);
    return true;
  }

  async #verifyManagedModel(
    model: LocalSubtitleModelManifestEntry,
    owner?: LocalSubtitleOwnerKey,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleGgmlModelVerification> {
    return this.#runManagedVerification(owner, signal, async (operationSignal) => {
      const finalDirectory = this.#finalModelDirectory(model);
      const finalPath = this.#finalModelPath(model);
      if (this.#rootProofs) await this.#assertImportRoots();
      await assertExistingManagedRootState(
        this.#managedResourceRoot,
        this.#modelsRoot,
        this.#stagingRoot,
        this.#downloadsRoot,
      );
      let directoryStats: Stats;
      try {
        directoryStats = await lstat(finalDirectory);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          throw managerFailure(
            "model_missing",
            "The requested managed local subtitle model is not installed.",
          );
        }
        throw error;
      }
      throwIfSignalAborted(operationSignal);
      await assertManagedDirectoryChain(
        this.#managedResourceRoot,
        this.#modelsRoot,
        finalDirectory,
      );
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        throw new LocalSubtitleModelError(
          "model_incompatible",
          "path",
          "The managed local subtitle model directory is invalid.",
        );
      }
      let stats: Stats;
      try {
        stats = await lstat(finalPath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          throw new LocalSubtitleModelError(
            "model_corrupt",
            "path",
            "The managed local subtitle model installation is incomplete.",
          );
        }
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new LocalSubtitleModelError(
          "model_incompatible",
          "path",
          "The managed local subtitle model is not a regular file.",
        );
      }
      const identity = fileIdentity(stats);
      const cached = this.#verifiedModels.get(model.id);
      if (cached && sameFileIdentity(cached.identity, identity)) {
        throwIfSignalAborted(operationSignal);
        return cached.verification;
      }
      const verification = await this.#verifyModelFile(finalPath, {
        modelId: model.id,
        byteSize: model.byteSize,
        sha256: model.sha256,
        ggml: model.ggml,
      }, operationSignal);
      assertVerifiedModelMatches(verification, model, finalPath);
      throwIfSignalAborted(operationSignal);
      const guard = await open(finalPath, READ_ONLY_NOFOLLOW_FLAGS);
      let completedIdentity: FileIdentity;
      try {
        completedIdentity = fileIdentity(await guard.stat());
        assertSameFileIdentity(
          verification.fileIdentity,
          completedIdentity,
        );
        await assertPathStillNamesFile(finalPath, completedIdentity);
      } finally {
        await guard.close();
      }
      throwIfSignalAborted(operationSignal);
      const canonicalVerification = Object.freeze({
        ...verification,
        modelId: model.id,
        absolutePath: finalPath,
        byteSize: model.byteSize,
        sha256: model.sha256,
        fileIdentity: completedIdentity,
      });
      this.#verifiedModels.set(model.id, {
        identity: completedIdentity,
        verification: canonicalVerification,
      });
      return canonicalVerification;
    });
  }

  async #runManagedVerification<T>(
    owner: LocalSubtitleOwnerKey | undefined,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#assertManagerAvailable();
    const controller = new AbortController();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const record: ManagedVerificationRecord = {
      ...(owner === undefined ? {} : { owner }),
      controller,
      completion,
      complete,
    };
    this.#activeVerifications.add(record);
    const detach = forwardAbort(signal, controller);
    try {
      throwIfSignalAborted(controller.signal);
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throwIfSignalAborted(controller.signal);
      }
      throw error;
    } finally {
      detach();
      this.#activeVerifications.delete(record);
      record.complete();
    }
  }

  #resolveCatalogEntry(modelId: string): LocalSubtitleModelManifestEntry {
    const model = this.#catalog.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw managerFailure(
        "model_incompatible",
        "The requested local subtitle model is not allowlisted.",
        "modelId",
      );
    }
    return model;
  }

  #assertManagerAvailable(): void {
    if (this.#shutdownRequested) {
      throw managerFailure(
        "owner_released",
        "The local subtitle model manager is shutting down.",
      );
    }
    if (this.#initializationFailed) {
      throw managerFailure(
        "resource_not_allowed",
        "Local subtitle managed resources failed startup cleanup.",
      );
    }
    if (this.#initializationOperation && !this.#initializationComplete) {
      throw managerFailure(
        "resource_busy",
        "Local subtitle managed resources are still initializing.",
      );
    }
  }

  #assertOwnerAvailable(owner: LocalSubtitleOwnerKey): void {
    if (this.#releasedOwners.has(modelOwnerKey(owner))) {
      throw new LocalSubtitleSessionRegistryError(
        "owner_released",
        "The local subtitle model owner is unavailable.",
        "owner",
      );
    }
    this.#registry.assertOwnerActive(owner);
  }

  #finalModelDirectory(model: LocalSubtitleModelManifestEntry): string {
    return resolveContainedCatalogPath(this.#modelsRoot, model.id);
  }

  #finalModelPath(model: LocalSubtitleModelManifestEntry): string {
    return resolveContainedCatalogPath(
      this.#finalModelDirectory(model),
      model.fileName,
    );
  }
}

async function ensurePrivateDirectory(
  absolutePath: string,
): Promise<PrivateDirectoryProof> {
  try {
    await mkdir(absolutePath, { recursive: true, mode: 0o700 });
    return await readPrivateDirectoryProof(absolutePath);
  } catch (error) {
    if (error instanceof LocalSubtitleModelManagerError) throw error;
    throw managerFailure(
      "resource_not_allowed",
      "A private local subtitle model directory is unavailable.",
    );
  }
}

async function readPrivateDirectoryProof(
  absolutePath: string,
): Promise<PrivateDirectoryProof> {
  try {
    const before = await lstat(absolutePath);
    assertPrivateDirectoryStats(before);
    const resolved = await realpath(absolutePath);
    const after = await lstat(absolutePath);
    assertPrivateDirectoryStats(after);
    assertSameDirectoryIdentity(
      directoryIdentity(before),
      directoryIdentity(after),
    );
    if (
      process.platform !== "win32" &&
      (before.mode & 0o777) !== (after.mode & 0o777)
    ) {
      throw new Error("directory permissions changed");
    }
    return Object.freeze({
      absolutePath,
      realPath: resolved,
      dev: after.dev,
      ino: after.ino,
      birthtimeMs: after.birthtimeMs,
      mode: after.mode & 0o777,
    });
  } catch (error) {
    if (error instanceof LocalSubtitleModelManagerError) throw error;
    throw managerFailure(
      "resource_not_allowed",
      "A private local subtitle model directory identity is invalid.",
    );
  }
}

async function verifyPrivateDirectoryProof(
  expected: PrivateDirectoryProof,
): Promise<void> {
  const current = await readPrivateDirectoryProof(expected.absolutePath);
  if (
    !sameDirectoryIdentity(expected, current) ||
    expected.realPath !== current.realPath ||
    (process.platform !== "win32" && expected.mode !== current.mode)
  ) {
    throw managerFailure(
      "resource_not_allowed",
      "A private local subtitle model directory identity changed.",
    );
  }
}

async function verifyImportRootProofs(proofs: ImportRootProofs): Promise<void> {
  await Promise.all([
    verifyPrivateDirectoryProof(proofs.managed),
    verifyPrivateDirectoryProof(proofs.models),
    verifyPrivateDirectoryProof(proofs.staging),
    verifyPrivateDirectoryProof(proofs.downloads),
  ]);
  assertImportRootContainment(proofs);
}

function assertImportRootContainment(proofs: ImportRootProofs): void {
  if (
    proofs.models.realPath === proofs.managed.realPath ||
    proofs.staging.realPath === proofs.managed.realPath ||
    proofs.downloads.realPath === proofs.managed.realPath ||
    proofs.models.realPath === proofs.staging.realPath ||
    proofs.models.realPath === proofs.downloads.realPath ||
    proofs.staging.realPath === proofs.downloads.realPath ||
    !isContainedPath(proofs.managed.realPath, proofs.models.realPath) ||
    !isContainedPath(proofs.managed.realPath, proofs.staging.realPath) ||
    !isContainedPath(proofs.managed.realPath, proofs.downloads.realPath)
  ) {
    throw managerFailure(
      "resource_not_allowed",
      "A managed local subtitle model directory escaped its private root.",
    );
  }
}

function assertPrivateDirectoryStats(stats: Stats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("not a private directory");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    throw new Error("private directory permissions must be mode 0700");
  }
}

async function rediscoverStagingQuarantine(
  staging: StagingReceipt,
): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(staging.stagingRoot);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!name.startsWith(".cleanup-")) continue;
    const candidate = path.join(staging.stagingRoot, name);
    let stats: Stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    if (
      stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      sameDirectoryIdentity(
        staging.directoryIdentity,
        directoryIdentity(stats),
      )
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length > 1) {
    throw new Error("multiple staging quarantines matched one cleanup proof");
  }
  return matches[0];
}

async function assertManagedDirectoryChain(
  managedRoot: string,
  modelsRoot: string,
  modelDirectory: string,
): Promise<void> {
  const [managed, models, model] = await Promise.all([
    readPrivateDirectoryProof(managedRoot),
    readPrivateDirectoryProof(modelsRoot),
    readPrivateDirectoryProof(modelDirectory),
  ]);
  if (
    models.realPath === managed.realPath ||
    model.realPath === models.realPath ||
    !isContainedPath(managed.realPath, models.realPath) ||
    !isContainedPath(models.realPath, model.realPath)
  ) {
    throw new LocalSubtitleModelError(
      "model_incompatible",
      "path",
      "The managed local subtitle model escaped its private root.",
    );
  }
}

async function assertExistingManagedRootState(
  managedRoot: string,
  modelsRoot: string,
  stagingRoot: string,
  downloadsRoot: string,
): Promise<void> {
  if (!(await pathExistsNoFollow(managedRoot))) return;
  const managed = await readPrivateDirectoryProof(managedRoot);
  const children: PrivateDirectoryProof[] = [];
  for (const candidate of [modelsRoot, stagingRoot, downloadsRoot]) {
    if (await pathExistsNoFollow(candidate)) {
      children.push(await readPrivateDirectoryProof(candidate));
    }
  }
  if (
    children.some(
      (child) =>
        child.realPath === managed.realPath ||
        !isContainedPath(managed.realPath, child.realPath),
    )
  ) {
    throw managerFailure(
      "resource_not_allowed",
      "A managed local subtitle model root escaped its private directory.",
    );
  }
}

async function pathExistsNoFollow(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function lstatModelSource(absolutePath: string): Promise<Stats> {
  try {
    return await lstat(absolutePath);
  } catch {
    throw new LocalSubtitleModelError(
      "model_incompatible",
      "path",
      "The selected model path is unavailable.",
    );
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    if (result.bytesWritten === 0) throw new Error("partial write stalled");
    written += result.bytesWritten;
  }
}

async function closeSourceHandle(
  source: SourceReceipt | undefined,
): Promise<void> {
  const handle = source?.handle;
  if (!source || !handle) return;
  source.handle = undefined;
  await handle.close();
}

async function restoreSourceQuarantine(source: SourceReceipt): Promise<void> {
  const parentStats = await lstat(source.parentPath);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("source parent directory changed before recovery");
  }
  assertSameDirectoryIdentity(
    source.parentIdentity,
    directoryIdentity(parentStats),
  );

  let existing: Stats | undefined;
  try {
    existing = await lstat(source.absolutePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const sourceAlreadyRestored =
    existing !== undefined &&
    existing.isFile() &&
    !existing.isSymbolicLink() &&
    sameFileObjectAndContent(source.identity, fileIdentity(existing));
  const quarantinePath = await resolveOwnedSourceQuarantine(source);

  if (sourceAlreadyRestored) {
    if (quarantinePath) unlinkSync(quarantinePath);
    source.identity = fileIdentity(await lstat(source.absolutePath));
    source.quarantinePath = undefined;
    await assertPathStillNamesFile(source.absolutePath, source.identity);
    return;
  }
  if (existing !== undefined) throw new Error("source path was replaced");
  if (!quarantinePath) {
    throw new Error("source quarantine disappeared before recovery proof");
  }

  await assertPathStillNamesFileObjectAndContent(quarantinePath, source.identity);
  await link(quarantinePath, source.absolutePath);
  const linkedIdentity = fileIdentity(await lstat(source.absolutePath));
  assertSameFileObjectAndContent(source.identity, linkedIdentity);
  source.identity = linkedIdentity;
  const quarantineIdentity = fileIdentity(await lstat(quarantinePath));
  assertSameFileIdentity(source.identity, quarantineIdentity);
  unlinkSync(quarantinePath);
  const restoredIdentity = fileIdentity(await lstat(source.absolutePath));
  assertSameFileObjectAndContent(source.identity, restoredIdentity);
  source.identity = restoredIdentity;
  source.quarantinePath = undefined;
  await assertPathStillNamesFile(source.absolutePath, source.identity);
}

async function resolveOwnedSourceQuarantine(
  source: SourceReceipt,
): Promise<string | undefined> {
  if (!source.quarantinePath) return undefined;
  if (
    await pathNamesSameFileObjectAndContent(
      source.quarantinePath,
      source.identity,
    )
  ) {
    return source.quarantinePath;
  }
  const names = await readdir(source.parentPath);
  const matches: string[] = [];
  for (const name of names) {
    if (!name.startsWith(".fusionkit-model-move-")) continue;
    const candidate = path.join(source.parentPath, name);
    if (await pathNamesSameFileObjectAndContent(candidate, source.identity)) {
      matches.push(candidate);
    }
  }
  if (matches.length > 1) {
    throw new Error("multiple source quarantines matched one recovery proof");
  }
  if (matches[0]) source.quarantinePath = matches[0];
  return matches[0];
}

async function pathNamesSameFileObjectAndContent(
  absolutePath: string | undefined,
  expected: FileIdentity,
): Promise<boolean> {
  if (!absolutePath) return false;
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  return sameFileObjectAndContent(expected, fileIdentity(stats));
}

async function assertPathStillNamesFileObjectAndContent(
  absolutePath: string,
  expected: FileIdentity,
): Promise<void> {
  if (!(await pathNamesSameFileObjectAndContent(absolutePath, expected))) {
    throw new LocalSubtitleModelError(
      "model_corrupt",
      "integrity",
      "The selected model changed during import.",
    );
  }
}

async function assertPathStillNamesFile(
  absolutePath: string,
  expected: FileIdentity,
): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    throw new LocalSubtitleModelError(
      "model_corrupt",
      "integrity",
      "The selected model changed during import.",
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new LocalSubtitleModelError(
      "model_corrupt",
      "integrity",
      "The selected model changed during import.",
    );
  }
  assertSameFileIdentity(expected, fileIdentity(stats));
}

function fileIdentity(stats: Stats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function directoryIdentity(
  stats: Pick<Stats, "dev" | "ino" | "birthtimeMs">,
): DirectoryIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  });
}

function assertSameFileIdentity(
  expected: FileIdentity | undefined,
  actual: FileIdentity,
): void {
  if (!expected || !sameFileIdentity(expected, actual)) {
    throw new LocalSubtitleModelError(
      "model_corrupt",
      "integrity",
      "The selected model changed during import.",
    );
  }
}

function sameFileIdentity(expected: FileIdentity, actual: FileIdentity): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeMs === actual.birthtimeMs &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  );
}

function assertSameFileObjectAndContent(
  expected: FileIdentity,
  actual: FileIdentity,
): void {
  if (!sameFileObjectAndContent(expected, actual)) {
    throw new LocalSubtitleModelError(
      "model_corrupt",
      "integrity",
      "The selected model changed during import.",
    );
  }
}

function sameFileObjectAndContent(
  expected: FileIdentity,
  actual: FileIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeMs === actual.birthtimeMs &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function assertSameDirectoryIdentity(
  expected: DirectoryIdentity,
  actual: DirectoryIdentity,
): void {
  if (!sameDirectoryIdentity(expected, actual)) {
    throw new Error("directory identity mismatch");
  }
}

function sameDirectoryIdentity(
  expected: DirectoryIdentity,
  actual: DirectoryIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeMs === actual.birthtimeMs
  );
}

function assertVerifiedModelMatches(
  verification: LocalSubtitleGgmlModelVerification,
  model: LocalSubtitleModelManifestEntry,
  stagedPath: string,
): void {
  if (
    verification.modelId !== model.id ||
    verification.absolutePath !== stagedPath ||
    verification.byteSize !== model.byteSize ||
    verification.sha256 !== model.sha256
  ) {
    throw managerFailure(
      "model_corrupt",
      "The staged local subtitle model verification result is invalid.",
    );
  }
}

function throwIfCancelled(context: LocalSubtitleResourceJobContext): void {
  if (context.signal.aborted || context.isCancellationRequested()) {
    throw new ImportCancelledError("The local subtitle model import was cancelled.");
  }
}

function isCancellation(
  error: unknown,
  context: LocalSubtitleResourceJobContext,
): boolean {
  return (
    error instanceof ImportCancelledError ||
    (context.isCancellationRequested() && context.signal.aborted)
  );
}

function failedJob(
  code: LocalSubtitleErrorCode,
  message: string,
): LocalSubtitleResourceJobExecutionResult {
  return { status: "failed", error: createLocalSubtitleError(code, message) };
}

function toResourceJobError(error: unknown): LocalSubtitleError {
  if (error instanceof SourceRestorePendingError) {
    return createLocalSubtitleError(
      "cancel_failed",
      "The selected source model still requires safe recovery.",
    );
  }
  if (error instanceof LocalSubtitleModelManagerError) {
    return createLocalSubtitleError(error.localSubtitleCode, error.message, {
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  if (error instanceof LocalSubtitleResourceDownloadError) {
    return createLocalSubtitleError(error.code, error.message);
  }
  if (error instanceof LocalSubtitleModelError) {
    return createLocalSubtitleError(error.code, error.message);
  }
  if (error instanceof LocalSubtitleResourceError) {
    return createLocalSubtitleError(
      error.code,
      "Local subtitle runtime resource is unavailable.",
    );
  }
  if (error instanceof LocalSubtitleServerSupervisorError) {
    return createLocalSubtitleError(
      error.localSubtitleCode,
      "The local subtitle model load smoke failed.",
    );
  }
  if (error instanceof LocalSubtitleSessionRegistryError) {
    return createLocalSubtitleError(error.localSubtitleCode, error.message, {
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  return createLocalSubtitleError(
    "model_download_failed",
    "The local subtitle model import failed.",
  );
}

function modelErrorCode(error: unknown): LocalSubtitleErrorCode {
  if (error instanceof LocalSubtitleModelError) return error.code;
  if (error instanceof LocalSubtitleModelManagerError) {
    return error.localSubtitleCode;
  }
  return "model_corrupt";
}

function isLifecycleCancellation(error: unknown): boolean {
  return (
    (error instanceof LocalSubtitleModelManagerError &&
      error.localSubtitleCode === "owner_released") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function managerFailure(
  code: LocalSubtitleModelManagerError["localSubtitleCode"],
  message: string,
  field?: string,
): LocalSubtitleModelManagerError {
  return new LocalSubtitleModelManagerError(code, message, field);
}

function normalizeAcceleratorManagerError(
  error: unknown,
): LocalSubtitleModelManagerError {
  if (error instanceof LocalSubtitleAcceleratorManagerError) {
    return managerFailure(error.localSubtitleCode, error.message);
  }
  if (error instanceof LocalSubtitleModelManagerError) return error;
  throw error;
}

function hasVadLoadSmoke(
  target: LocalSubtitleModelResourceTarget,
): target is LocalSubtitleModelLoadSmokeTarget & LocalSubtitleVadLoadSmokeTarget {
  return typeof target.smokeVadLoad === "function";
}

function normalizeVadManagerError(
  error: unknown,
): LocalSubtitleModelManagerError {
  if (error instanceof LocalSubtitleModelManagerError) return error;
  if (error instanceof LocalSubtitleVadManagerError) {
    const code = error.localSubtitleCode;
    if (
      code === "owner_released" ||
      code === "model_missing" ||
      code === "resource_not_allowed" ||
      code === "resource_busy" ||
      code === "resource_signature_invalid" ||
      code === "insufficient_disk" ||
      code === "cancel_failed"
    ) {
      return managerFailure(code, error.message);
    }
  }
  throw error;
}

function validateManagedRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute managed resource root is required.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The filesystem root cannot be a managed resource root.");
  }
  return resolved;
}

function validateSourcePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw managerFailure(
      "invalid_ipc_request",
      "A selected local subtitle model file is required.",
      "filePath",
    );
  }
  return path.resolve(value);
}

function validateImportMode(value: string): asserts value is LocalSubtitleModelImportMode {
  if (value !== "copy" && value !== "move") {
    throw managerFailure(
      "invalid_ipc_request",
      "The local subtitle model import mode is invalid.",
      "mode",
    );
  }
}

function resolveContainedCatalogPath(root: string, leaf: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, leaf);
  if (
    path.dirname(candidate) !== normalizedRoot ||
    candidate === normalizedRoot ||
    !isContainedPath(normalizedRoot, candidate)
  ) {
    throw managerFailure(
      "resource_not_allowed",
      "A local subtitle model catalog path escaped its managed root.",
    );
  }
  return candidate;
}

function sameOwner(
  left: LocalSubtitleOwnerKey | undefined,
  right: LocalSubtitleOwnerKey,
): boolean {
  return (
    left?.webContentsId === right.webContentsId &&
    left.ownerSessionId === right.ownerSessionId
  );
}

function modelOwnerKey(owner: LocalSubtitleOwnerKey): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The local subtitle model operation was aborted.", "AbortError");
}

function sanitizeStagingId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,128}$/u.test(value)) {
    throw new TypeError("The local subtitle staging id is invalid.");
  }
  return value;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function availableFileSystemBytes(directory: string): Promise<number> {
  const stats = await statfs(directory, { bigint: true });
  const available = stats.bavail * stats.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(available);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
