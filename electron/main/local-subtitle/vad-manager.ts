import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  createLocalSubtitleError,
  isLocalSubtitleErrorCode,
  type LocalSubtitleError,
  type LocalSubtitleErrorCode,
  type LocalSubtitleResourceJobSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleManagedResourceSummary } from "@/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "./authorizations";
import {
  downloadLocalSubtitleResource,
  LocalSubtitleResourceDownloadError,
  type DownloadLocalSubtitleResourceOptions,
} from "./resource-download";
import {
  LocalSubtitleResourceJobManager,
  type LocalSubtitleResourceJobContext,
  type LocalSubtitleResourceJobExecutionResult,
} from "./resource-job";
import {
  selectLocalSubtitleCpuServerArtifactId,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import type { LocalSubtitleServerManagedResourceIdentity } from "./server-process-contract";
import type { LocalSubtitleServerVadLoadSmokeOptions } from "./server-supervisor";
import {
  LOCAL_SUBTITLE_VAD_MANIFEST,
  type LocalSubtitleVadManifestEntry,
} from "./vad-manifest";

const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_EXCLUSIVE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const HASH_CHUNK_BYTES = 1024 * 1024;

export const LOCAL_SUBTITLE_VAD_MANAGER_POLICY = Object.freeze({
  vadDirectoryName: "vad",
  stagingDirectoryName: "vad-staging",
  downloadsDirectoryName: "downloads",
  manifestFileName: "manifest.json",
  smokeThreads: 1,
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
} as const);

export interface LocalSubtitleVadDefinition {
  readonly resourceId: string;
  readonly displayName: string;
  readonly version: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly allowedDownloadHosts: readonly string[];
  readonly byteSize: number;
  readonly sha256: string;
  readonly isDefault: boolean;
  readonly manifestFileName: string;
  readonly manifestBytes: Buffer;
}

export interface LocalSubtitleVadLoadSmokeTarget {
  smokeVadLoad(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerVadLoadSmokeOptions,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface LocalSubtitleVadManagerOptions {
  readonly managedResourceRoot: string;
  readonly platform?: NodeJS.Platform | string;
  readonly resourceJobs: LocalSubtitleResourceJobManager;
  readonly supervisor: LocalSubtitleVadLoadSmokeTarget;
  readonly resolveSmokeModel: (
    signal?: AbortSignal,
  ) => Promise<LocalSubtitleServerManagedResourceIdentity<"managed">>;
  readonly verifyServerRuntime: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly definition?: LocalSubtitleVadDefinition;
  readonly availableBytes?: (directory: string) => Promise<number>;
  readonly stagingIdFactory?: () => string;
  readonly downloadResource?: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly removeDirectory?: (absolutePath: string) => Promise<void>;
  readonly renameDirectory?: (source: string, destination: string) => Promise<void>;
  readonly isResourceBusy?: (
    resourceId: string,
  ) => boolean | Promise<boolean>;
}

export class LocalSubtitleVadManagerError extends Error {
  readonly name = "LocalSubtitleVadManagerError";

  constructor(
    readonly localSubtitleCode: LocalSubtitleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface FileIdentity extends DirectoryIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface PrivateDirectoryProof extends DirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
}

interface VadRootProofs {
  readonly managed: PrivateDirectoryProof;
  readonly vad: PrivateDirectoryProof;
  readonly staging: PrivateDirectoryProof;
  readonly downloads: PrivateDirectoryProof;
}

interface StagingReceipt {
  currentPath: string;
  readonly identity: DirectoryIdentity;
  quarantined: boolean;
  cleaned: boolean;
}

interface VerifiedVadObservation {
  readonly rootIdentity: DirectoryIdentity;
  readonly vadIdentity: FileIdentity;
  readonly manifestIdentity: FileIdentity;
}

interface ActiveVerification {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly complete: () => void;
}

export const LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION =
  createProductionDefinition(LOCAL_SUBTITLE_VAD_MANIFEST.vad);

export class LocalSubtitleVadManager {
  readonly #managedRoot: string;
  readonly #vadRoot: string;
  readonly #stagingRoot: string;
  readonly #downloadsRoot: string;
  readonly #platform: string;
  readonly #resourceJobs: LocalSubtitleResourceJobManager;
  readonly #supervisor: LocalSubtitleVadLoadSmokeTarget;
  readonly #resolveSmokeModel: LocalSubtitleVadManagerOptions["resolveSmokeModel"];
  readonly #verifyServerRuntime: LocalSubtitleVadManagerOptions["verifyServerRuntime"];
  readonly #definition: LocalSubtitleVadDefinition;
  readonly #availableBytes: (directory: string) => Promise<number>;
  readonly #stagingIdFactory: () => string;
  readonly #downloadResource: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly #removeDirectory: (absolutePath: string) => Promise<void>;
  readonly #renameDirectory: (source: string, destination: string) => Promise<void>;
  readonly #isResourceBusy: (
    resourceId: string,
  ) => boolean | Promise<boolean>;
  readonly #claimedResourceIds = new Set<string>();
  readonly #activeResourceIds = new Set<string>();
  readonly #activeVerifications = new Set<ActiveVerification>();
  readonly #activeDeletions = new Set<Promise<void>>();
  readonly #orphanedStaging = new Set<StagingReceipt>();
  #verifiedVad: VerifiedVadObservation | undefined;
  #rootProofs: VadRootProofs | undefined;
  #rootProofOperation: Promise<void> | undefined;
  #cleanupOperation: Promise<void> | undefined;
  #shutdownRequested = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(options: LocalSubtitleVadManagerOptions) {
    if (
      !options ||
      !(options.resourceJobs instanceof LocalSubtitleResourceJobManager) ||
      typeof options.supervisor?.smokeVadLoad !== "function" ||
      typeof options.resolveSmokeModel !== "function" ||
      typeof options.verifyServerRuntime !== "function"
    ) {
      throw new TypeError("The local subtitle VAD manager options are invalid.");
    }
    this.#managedRoot = validateAbsoluteRoot(options.managedResourceRoot);
    this.#vadRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_VAD_MANAGER_POLICY.vadDirectoryName,
    );
    this.#stagingRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_VAD_MANAGER_POLICY.stagingDirectoryName,
    );
    this.#downloadsRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_VAD_MANAGER_POLICY.downloadsDirectoryName,
    );
    this.#platform = options.platform ?? process.platform;
    this.#resourceJobs = options.resourceJobs;
    this.#supervisor = options.supervisor;
    this.#resolveSmokeModel = options.resolveSmokeModel;
    this.#verifyServerRuntime = options.verifyServerRuntime;
    this.#definition = validateDefinition(
      options.definition ?? LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION,
    );
    this.#availableBytes = options.availableBytes ?? availableFileSystemBytes;
    this.#stagingIdFactory = options.stagingIdFactory ?? randomUUID;
    this.#downloadResource = options.downloadResource ??
      downloadLocalSubtitleResource;
    this.#removeDirectory = options.removeDirectory ?? ((absolutePath) =>
      rm(absolutePath, {
        recursive: true,
        force: false,
        maxRetries: LOCAL_SUBTITLE_VAD_MANAGER_POLICY.cleanupMaxRetries,
        retryDelay: LOCAL_SUBTITLE_VAD_MANAGER_POLICY.cleanupRetryDelayMs,
      }));
    this.#renameDirectory = options.renameDirectory ?? rename;
    this.#isResourceBusy = options.isResourceBusy ?? (() => false);
  }

  hasResourceId(resourceId: string): boolean {
    return resourceId === this.#definition.resourceId;
  }

  startResourceInstall(
    owner: LocalSubtitleOwnerKey,
    resourceId: string,
  ): LocalSubtitleResourceJobSummary {
    this.#assertAvailable();
    const definition = this.#resolveDefinition(resourceId);
    this.#claim(definition.resourceId);
    try {
      return this.#resourceJobs.start({
        owner,
        resourceId: definition.resourceId,
        resourceType: "vad",
        execute: async (context) => {
          try {
            return await this.#executeInstall(owner, definition, context);
          } finally {
            this.#claimedResourceIds.delete(definition.resourceId);
          }
        },
      });
    } catch (error) {
      this.#claimedResourceIds.delete(definition.resourceId);
      throw error;
    }
  }

  async deleteManagedResource(
    resourceId: string,
  ): Promise<Readonly<{ deleted: boolean }>> {
    this.#assertAvailable();
    const definition = this.#resolveDefinition(resourceId);
    this.#claim(definition.resourceId);
    let complete!: () => void;
    const deletion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#activeDeletions.add(deletion);
    try {
      if (await this.#isResourceBusy(definition.resourceId)) {
        throw vadFailure("resource_busy", "The local subtitle VAD is currently in use.");
      }
      const finalPath = this.#finalDirectory();
      if (!(await lstatOptional(finalPath))) {
        return Object.freeze({ deleted: false });
      }
      await this.#ensureRoots();
      await this.#verifyVad(finalPath, undefined, true);
      if (await this.#isResourceBusy(definition.resourceId)) {
        throw vadFailure(
          "resource_busy",
          "The local subtitle VAD became busy during deletion.",
        );
      }
      await this.#assertRoots();
      const receipt = await this.#reserveExistingDirectory(
        finalPath,
        `.delete-${safeId(this.#stagingIdFactory())}`,
      );
      await this.#cleanupReceipt(receipt);
      this.#verifiedVad = undefined;
      return Object.freeze({ deleted: true });
    } finally {
      this.#claimedResourceIds.delete(definition.resourceId);
      this.#activeDeletions.delete(deletion);
      complete();
    }
  }

  async listManagedResources(
    signal?: AbortSignal,
  ): Promise<readonly LocalSubtitleManagedResourceSummary[]> {
    this.#assertAvailable();
    const definition = this.#definition;
    const base = {
      resourceId: definition.resourceId,
      resourceType: "vad" as const,
      displayName: definition.displayName,
      version: definition.version,
      byteSize: definition.byteSize,
      isDefault: definition.isDefault,
      compatibleBackends: ["cpu", "cuda", "metal"] as Array<
        "cpu" | "cuda" | "metal"
      >,
    };
    if (
      this.#claimedResourceIds.has(definition.resourceId) ||
      this.#activeResourceIds.has(definition.resourceId)
    ) {
      return Object.freeze([
        Object.freeze({ ...base, status: "installing" as const }),
      ]);
    }
    try {
      const finalPath = this.#finalDirectory();
      if (!(await lstatOptional(finalPath))) {
        return Object.freeze([
          Object.freeze({ ...base, status: "not_installed" as const }),
        ]);
      }
      await this.#ensureRoots();
      await this.#runVerification(signal, (operationSignal) =>
        this.#verifyVad(finalPath, operationSignal, true));
      return Object.freeze([
        Object.freeze({ ...base, status: "ready" as const }),
      ]);
    } catch (error) {
      if (signal?.aborted || this.#shutdownRequested || isLifecycleCancellation(error)) {
        throw error;
      }
      return Object.freeze([
        Object.freeze({
          ...base,
          status: "invalid" as const,
          errorCode: vadErrorCode(error),
        }),
      ]);
    }
  }

  async resolveManagedVad(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerManagedResourceIdentity<"managed">> {
    this.#assertAvailable();
    const definition = this.#resolveDefinition(resourceId);
    if (
      this.#claimedResourceIds.has(definition.resourceId) ||
      this.#activeResourceIds.has(definition.resourceId)
    ) {
      throw vadFailure("resource_busy", "The local subtitle VAD is still being installed.");
    }
    const finalPath = this.#finalDirectory();
    if (!(await lstatOptional(finalPath))) {
      throw vadFailure(
        "model_missing",
        "The managed local subtitle VAD is not installed.",
      );
    }
    await this.#ensureRoots();
    await this.#runVerification(signal, (operationSignal) =>
      this.#verifyVad(finalPath, operationSignal, true));
    return Object.freeze({
      storage: "managed" as const,
      id: definition.resourceId,
      absolutePath: path.join(finalPath, definition.fileName),
      byteSize: definition.byteSize,
      sha256: definition.sha256,
    });
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
        vadFailure("owner_released", "The local subtitle VAD manager is shutting down."),
      );
    }
    void Promise.resolve()
      .then(async () => {
        await this.#resourceJobs.shutdown();
        await this.#waitForActiveOperations();
        await this.#retryOutstandingCleanup();
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
    await this.#waitForActiveOperations();
    await this.#retryOutstandingCleanup();
  }

  async #executeInstall(
    owner: LocalSubtitleOwnerKey,
    definition: LocalSubtitleVadDefinition,
    context: LocalSubtitleResourceJobContext,
  ): Promise<LocalSubtitleResourceJobExecutionResult> {
    let transaction: StagingReceipt | undefined;
    let committed: StagingReceipt | undefined;
    let completed = false;
    let commitStarted = false;
    let outcome: LocalSubtitleResourceJobExecutionResult | undefined;
    this.#activeResourceIds.add(definition.resourceId);
    try {
      context.update({
        status: "acquiring",
        progress: 1,
        bytesCompleted: 0,
        bytesTotal: definition.byteSize,
      });
      throwIfCancelled(context);
      await this.#retryOutstandingCleanup();
      await this.#ensureRoots();
      if (await lstatOptional(this.#finalDirectory())) {
        throw vadFailure("resource_busy", "The local subtitle VAD is already installed.");
      }

      await this.#resolveSmokeModel(context.signal);
      throwIfCancelled(context);
      await this.#assertDiskSpace(
        definition.byteSize + definition.manifestBytes.byteLength,
      );
      transaction = await this.#createStagingReceipt();
      const stagedVadPath = path.join(transaction.currentPath, definition.fileName);
      await this.#downloadResource({
        sourceUrl: definition.downloadUrl,
        allowedHosts: definition.allowedDownloadHosts,
        expectedBytes: definition.byteSize,
        downloadDirectory: this.#downloadsRoot,
        partFileName: `${definition.resourceId}.part`,
        metadataFileName: `${definition.resourceId}.part.json`,
        destinationPath: stagedVadPath,
        signal: context.signal,
        ensureCapacity: (remainingBytes) => this.#assertDiskSpace(
          remainingBytes + definition.manifestBytes.byteLength,
        ),
        onProgress: (completedBytes, totalBytes) => context.update({
          status: "acquiring",
          progress: Math.min(60, 5 + (completedBytes / totalBytes) * 55),
          bytesCompleted: completedBytes,
          bytesTotal: totalBytes,
        }),
      });
      await writeExclusiveFile(
        path.join(transaction.currentPath, definition.manifestFileName),
        definition.manifestBytes,
      );

      context.update({
        status: "verifying",
        progress: 70,
        bytesCompleted: definition.byteSize,
        bytesTotal: definition.byteSize,
      });
      await this.#verifyVad(transaction.currentPath, context.signal, true);
      throwIfCancelled(context);

      context.update({
        status: "load_smoke",
        progress: 85,
        bytesCompleted: definition.byteSize,
        bytesTotal: definition.byteSize,
      });
      const smokeModel = await this.#resolveSmokeModel(context.signal);
      throwIfCancelled(context);
      const runtime = await this.#verifyServerRuntime();
      const serverArtifactId = selectLocalSubtitleCpuServerArtifactId(runtime);
      await this.#supervisor.smokeVadLoad(
        owner,
        {
          purpose: "vad_load_smoke",
          backend: "cpu",
          verifiedRuntime: runtime,
          serverArtifactId,
          model: smokeModel,
          vadModel: {
            storage: "managed_staging",
            id: definition.resourceId,
            absolutePath: stagedVadPath,
            byteSize: definition.byteSize,
            sha256: definition.sha256,
          },
          threads: LOCAL_SUBTITLE_VAD_MANAGER_POLICY.smokeThreads,
        },
        context.signal,
      );
      await this.#verifyVad(transaction.currentPath, context.signal, true);
      throwIfCancelled(context);

      context.update({
        status: "committing",
        progress: 95,
        bytesCompleted: definition.byteSize,
        bytesTotal: definition.byteSize,
      });
      commitStarted = true;
      await this.#assertRoots();
      const finalPath = this.#finalDirectory();
      if (await lstatOptional(finalPath)) {
        throw vadFailure("resource_busy", "The local subtitle VAD destination exists.");
      }
      const transactionStats = await lstat(transaction.currentPath);
      const identity = directoryIdentity(transactionStats);
      await this.#renameDirectory(transaction.currentPath, finalPath);
      committed = {
        currentPath: finalPath,
        identity,
        quarantined: false,
        cleaned: false,
      };
      transaction.cleaned = true;
      assertSameDirectory(identity, directoryIdentity(await lstat(finalPath)));

      await this.#verifyVad(finalPath, undefined, true);
      completed = true;
      outcome = { status: "completed" };
    } catch (error) {
      outcome = !commitStarted && isCancellation(error, context)
        ? { status: "cancelled" }
        : { status: "failed", error: toResourceJobError(error) };
    }

    if (!completed) {
      this.#verifiedVad = undefined;
      for (const receipt of [committed, transaction]) {
        if (!receipt || receipt.cleaned) continue;
        try {
          await this.#cleanupReceipt(receipt);
        } catch {
          this.#orphanedStaging.add(receipt);
          outcome = failedJob(
            "cancel_failed",
            "The local subtitle VAD staging area could not be removed safely.",
          );
        }
      }
    }
    this.#activeResourceIds.delete(definition.resourceId);
    return outcome ?? failedJob(
      "resource_signature_invalid",
      "The local subtitle VAD install did not reach a terminal state.",
    );
  }

  async #verifyVad(
    root: string,
    signal: AbortSignal | undefined,
    verifyHash: boolean,
  ): Promise<void> {
    throwIfSignalAborted(signal);
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw invalidVad();
    await assertExactVadTree(root, this.#definition, signal);
    const canCache = verifyHash && root === this.#finalDirectory();
    const cached = canCache ? this.#verifiedVad : undefined;
    if (cached) {
      try {
        assertSameDirectory(cached.rootIdentity, directoryIdentity(rootStats));
        assertSameFile(
          cached.vadIdentity,
          fileIdentity(await lstat(path.join(root, this.#definition.fileName))),
        );
        assertSameFile(
          cached.manifestIdentity,
          fileIdentity(await lstat(
            path.join(root, this.#definition.manifestFileName),
          )),
        );
        return;
      } catch {
        this.#verifiedVad = undefined;
      }
    }
    const manifestIdentity = await verifyExactFile(
      path.join(root, this.#definition.manifestFileName),
      this.#definition.manifestBytes.byteLength,
      createHash("sha256").update(this.#definition.manifestBytes).digest("hex"),
      signal,
      true,
    );
    const vadIdentity = await verifyExactFile(
      path.join(root, this.#definition.fileName),
      this.#definition.byteSize,
      this.#definition.sha256,
      signal,
      verifyHash,
    );
    const rootIdentity = directoryIdentity(rootStats);
    assertSameDirectory(rootIdentity, directoryIdentity(await lstat(root)));
    if (canCache) {
      this.#verifiedVad = Object.freeze({
        rootIdentity,
        vadIdentity,
        manifestIdentity,
      });
    }
  }

  async #runVerification<T>(
    parentSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const record: ActiveVerification = { controller, completion, complete };
    this.#activeVerifications.add(record);
    try {
      if (parentSignal?.aborted) controller.abort(parentSignal.reason);
      return await operation(controller.signal);
    } finally {
      parentSignal?.removeEventListener("abort", onAbort);
      this.#activeVerifications.delete(record);
      complete();
    }
  }

  async #waitForActiveOperations(): Promise<void> {
    while (this.#activeVerifications.size > 0 || this.#activeDeletions.size > 0) {
      await Promise.all([
        ...[...this.#activeVerifications].map((record) => record.completion),
        ...this.#activeDeletions,
      ]);
    }
  }

  #claim(resourceId: string): void {
    if (
      this.#claimedResourceIds.size > 0 ||
      this.#activeResourceIds.size > 0 ||
      this.#activeVerifications.size > 0 ||
      this.#activeDeletions.size > 0
    ) {
      throw vadFailure(
        "resource_busy",
        `The local subtitle VAD already has an active operation for ${resourceId}.`,
      );
    }
    this.#claimedResourceIds.add(resourceId);
  }

  async #ensureRoots(): Promise<void> {
    if (this.#rootProofOperation) return this.#rootProofOperation;
    const operation = this.#createOrVerifyRoots();
    this.#rootProofOperation = operation;
    try {
      await operation;
    } finally {
      if (this.#rootProofOperation === operation) this.#rootProofOperation = undefined;
    }
  }

  async #createOrVerifyRoots(): Promise<void> {
    if (this.#rootProofs) {
      await verifyRootProofs(this.#rootProofs);
      return;
    }
    const managed = await ensurePrivateDirectory(this.#managedRoot, this.#platform);
    const vad = await ensurePrivateDirectory(this.#vadRoot, this.#platform);
    const staging = await ensurePrivateDirectory(this.#stagingRoot, this.#platform);
    const downloads = await ensurePrivateDirectory(
      this.#downloadsRoot,
      this.#platform,
    );
    const proofs = Object.freeze({ managed, vad, staging, downloads });
    assertRootContainment(proofs);
    await verifyRootProofs(proofs);
    this.#rootProofs = proofs;
  }

  async #assertRoots(): Promise<void> {
    if (!this.#rootProofs) {
      throw vadFailure("resource_not_allowed", "The managed VAD roots are not initialized.");
    }
    await verifyRootProofs(this.#rootProofs);
  }

  async #assertDiskSpace(requiredBytes: number): Promise<void> {
    await this.#assertRoots();
    let available: number;
    try {
      available = await this.#availableBytes(this.#stagingRoot);
    } catch {
      throw vadFailure(
        "insufficient_disk",
        "Available disk space for the local subtitle VAD could not be verified.",
      );
    }
    await this.#assertRoots();
    if (!Number.isSafeInteger(available) || available < requiredBytes) {
      throw vadFailure(
        "insufficient_disk",
        "There is not enough disk space to install the local subtitle VAD.",
      );
    }
  }

  async #createStagingReceipt(): Promise<StagingReceipt> {
    await this.#assertRoots();
    const root = await mkdtemp(path.join(
      this.#stagingRoot,
      `.install-${safeId(this.#definition.resourceId)}-${safeId(
        this.#stagingIdFactory(),
      )}-`,
    ));
    const stats = await lstat(root);
    const real = await realpath(root);
    if (!isContainedPath(this.#rootProofs!.staging.realPath, real)) {
      throw vadFailure(
        "resource_not_allowed",
        "The VAD staging directory escaped its private root.",
      );
    }
    return {
      currentPath: root,
      identity: directoryIdentity(stats),
      quarantined: false,
      cleaned: false,
    };
  }

  async #reserveExistingDirectory(
    absolutePath: string,
    quarantineLeaf: string,
  ): Promise<StagingReceipt> {
    const stats = await lstat(absolutePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidVad();
    const quarantine = path.join(this.#stagingRoot, quarantineLeaf);
    await this.#renameDirectory(absolutePath, quarantine);
    const receipt: StagingReceipt = {
      currentPath: quarantine,
      identity: directoryIdentity(stats),
      quarantined: true,
      cleaned: false,
    };
    try {
      assertSameDirectory(
        receipt.identity,
        directoryIdentity(await lstat(quarantine)),
      );
    } catch (error) {
      this.#orphanedStaging.add(receipt);
      throw error;
    }
    return receipt;
  }

  async #cleanupReceipt(receipt: StagingReceipt): Promise<void> {
    if (receipt.cleaned) return;
    const stats = await lstatOptional(receipt.currentPath);
    if (!stats) {
      receipt.cleaned = true;
      this.#orphanedStaging.delete(receipt);
      return;
    }
    assertSameDirectory(receipt.identity, directoryIdentity(stats));
    if (!receipt.quarantined) {
      const quarantine = path.join(
        this.#stagingRoot,
        `.cleanup-${safeId(this.#stagingIdFactory())}`,
      );
      await this.#renameDirectory(receipt.currentPath, quarantine);
      receipt.currentPath = quarantine;
      receipt.quarantined = true;
    }
    assertSameDirectory(
      receipt.identity,
      directoryIdentity(await lstat(receipt.currentPath)),
    );
    const stagingRealPath = await realpath(this.#stagingRoot);
    const quarantineRealPath = await realpath(receipt.currentPath);
    if (!isContainedPath(stagingRealPath, quarantineRealPath)) {
      throw new Error("VAD cleanup escaped its private staging root.");
    }
    await this.#removeDirectory(receipt.currentPath);
    if (await lstatOptional(receipt.currentPath)) {
      throw new Error("VAD cleanup did not remove the owned directory.");
    }
    receipt.cleaned = true;
    this.#orphanedStaging.delete(receipt);
  }

  #retryOutstandingCleanup(): Promise<void> {
    if (this.#cleanupOperation) return this.#cleanupOperation;
    const operation = this.#performOutstandingCleanup();
    this.#cleanupOperation = operation;
    void operation.finally(() => {
      if (this.#cleanupOperation === operation) this.#cleanupOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  async #performOutstandingCleanup(): Promise<void> {
    let failed = false;
    for (const receipt of [...this.#orphanedStaging]) {
      try {
        await this.#cleanupReceipt(receipt);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      throw vadFailure(
        "cancel_failed",
        "A local subtitle VAD directory still requires cleanup.",
      );
    }
  }

  #finalDirectory(): string {
    return path.join(this.#vadRoot, this.#definition.resourceId);
  }

  #resolveDefinition(resourceId: string): LocalSubtitleVadDefinition {
    if (resourceId !== this.#definition.resourceId) {
      throw vadFailure(
        "resource_not_allowed",
        "The requested local subtitle VAD is not allowlisted.",
      );
    }
    return this.#definition;
  }

  #assertAvailable(): void {
    if (this.#shutdownRequested) {
      throw vadFailure(
        "owner_released",
        "The local subtitle VAD manager is shutting down.",
      );
    }
  }
}

function createProductionDefinition(
  manifest: LocalSubtitleVadManifestEntry,
): LocalSubtitleVadDefinition {
  return deepFreeze({
    resourceId: manifest.id,
    displayName: "Silero VAD v6.2.0",
    version: manifest.engineCompatibility,
    fileName: manifest.fileName,
    downloadUrl: manifest.downloadUrl,
    allowedDownloadHosts: [...manifest.allowedDownloadHosts],
    byteSize: manifest.byteSize,
    sha256: manifest.sha256,
    isDefault: manifest.defaultEnabled,
    manifestFileName: LOCAL_SUBTITLE_VAD_MANAGER_POLICY.manifestFileName,
    manifestBytes: Buffer.from(
      `${JSON.stringify(LOCAL_SUBTITLE_VAD_MANIFEST, null, 2)}\n`,
      "utf8",
    ),
  });
}

function validateDefinition(
  definition: LocalSubtitleVadDefinition,
): LocalSubtitleVadDefinition {
  if (
    !definition ||
    !isSafeLeaf(definition.resourceId) ||
    !isSafeLeaf(definition.fileName) ||
    !isSafeLeaf(definition.manifestFileName) ||
    definition.fileName === definition.manifestFileName ||
    typeof definition.displayName !== "string" ||
    definition.displayName.trim() === "" ||
    typeof definition.version !== "string" ||
    definition.version.trim() === "" ||
    typeof definition.downloadUrl !== "string" ||
    !Array.isArray(definition.allowedDownloadHosts) ||
    definition.allowedDownloadHosts.length === 0 ||
    !Number.isSafeInteger(definition.byteSize) ||
    definition.byteSize <= 0 ||
    !/^[a-f0-9]{64}$/u.test(definition.sha256) ||
    typeof definition.isDefault !== "boolean" ||
    !Buffer.isBuffer(definition.manifestBytes) ||
    definition.manifestBytes.length === 0
  ) {
    throw new TypeError("The local subtitle VAD definition is invalid.");
  }
  return deepFreeze({
    ...definition,
    allowedDownloadHosts: [...definition.allowedDownloadHosts],
    manifestBytes: Buffer.from(definition.manifestBytes),
  });
}

async function verifyExactFile(
  absolutePath: string,
  expectedBytes: number,
  expectedSha256: string,
  signal: AbortSignal | undefined,
  verifyHash: boolean,
): Promise<FileIdentity> {
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedBytes) {
    throw invalidVad();
  }
  const handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  try {
    const opened = await handle.stat();
    assertSameFile(fileIdentity(before), fileIdentity(opened));
    if (verifyHash) {
      const observedHash = await hashFileHandle(handle, opened.size, signal);
      if (observedHash !== expectedSha256) throw invalidVad();
    }
    const observedIdentity = fileIdentity(opened);
    assertSameFile(observedIdentity, fileIdentity(await handle.stat()));
    assertSameFile(observedIdentity, fileIdentity(await lstat(absolutePath)));
    return observedIdentity;
  } finally {
    await handle.close();
  }
}

async function hashFileHandle(
  handle: FileHandle,
  byteSize: number,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  while (position < byteSize) {
    throwIfSignalAborted(signal);
    const length = Math.min(chunk.length, byteSize - position);
    const read = await handle.read(chunk, 0, length, position);
    if (read.bytesRead <= 0) throw invalidVad();
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest("hex");
}

async function assertExactVadTree(
  root: string,
  definition: LocalSubtitleVadDefinition,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSignalAborted(signal);
  const expected = new Set([definition.fileName, definition.manifestFileName]);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== expected.size) throw invalidVad();
  for (const entry of entries) {
    throwIfSignalAborted(signal);
    if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw invalidVad();
    }
  }
}

async function writeExclusiveFile(absolutePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(absolutePath, WRITE_EXCLUSIVE_NOFOLLOW_FLAGS, 0o600);
  try {
    let position = 0;
    while (position < bytes.length) {
      const write = await handle.write(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (write.bytesWritten <= 0) throw invalidVad();
      position += write.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(
  absolutePath: string,
  platform: string,
): Promise<PrivateDirectoryProof> {
  await mkdir(absolutePath, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(absolutePath, 0o700);
  return readPrivateDirectoryProof(absolutePath, platform);
}

async function readPrivateDirectoryProof(
  absolutePath: string,
  platform: string,
): Promise<PrivateDirectoryProof> {
  const stats = await lstat(absolutePath);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (platform !== "win32" && (stats.mode & 0o077) !== 0)
  ) {
    throw vadFailure("resource_not_allowed", "A managed VAD directory is not private.");
  }
  return Object.freeze({
    absolutePath,
    realPath: await realpath(absolutePath),
    ...directoryIdentity(stats),
  });
}

async function verifyRootProofs(proofs: VadRootProofs): Promise<void> {
  await Promise.all(Object.values(proofs).map(async (proof) => {
    const stats = await lstat(proof.absolutePath);
    assertSameDirectory(proof, directoryIdentity(stats));
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidVad();
    if (await realpath(proof.absolutePath) !== proof.realPath) throw invalidVad();
  }));
  assertRootContainment(proofs);
}

function assertRootContainment(proofs: VadRootProofs): void {
  const children = [proofs.vad, proofs.staging, proofs.downloads];
  if (children.some((child) => !isContainedPath(proofs.managed.realPath, child.realPath))) {
    throw vadFailure(
      "resource_not_allowed",
      "A managed VAD directory escaped its private root.",
    );
  }
  if (new Set(children.map((child) => child.realPath.toLowerCase())).size !== 3) {
    throw vadFailure(
      "resource_not_allowed",
      "Managed VAD directories must be independent.",
    );
  }
}

function validateAbsoluteRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute VAD resource root is required.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The filesystem root cannot be a VAD resource root.");
  }
  return resolved;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function isSafeLeaf(value: string): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0]/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(value);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw new TypeError("The local subtitle VAD staging id is invalid.");
  }
  return value;
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

function fileIdentity(
  stats: Pick<
    Stats,
    "dev" | "ino" | "birthtimeMs" | "size" | "mtimeMs" | "ctimeMs"
  >,
): FileIdentity {
  return Object.freeze({
    ...directoryIdentity(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function assertSameDirectory(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.birthtimeMs !== right.birthtimeMs
  ) {
    throw invalidVad();
  }
}

function assertSameFile(left: FileIdentity, right: FileIdentity): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.birthtimeMs !== right.birthtimeMs ||
    left.size !== right.size ||
    left.mtimeMs !== right.mtimeMs ||
    left.ctimeMs !== right.ctimeMs
  ) {
    throw invalidVad();
  }
}

async function lstatOptional(absolutePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function availableFileSystemBytes(directory: string): Promise<number> {
  const stats = await statfs(directory, { bigint: true });
  const available = stats.bavail * stats.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(available);
}

function throwIfCancelled(context: LocalSubtitleResourceJobContext): void {
  if (context.signal.aborted || context.isCancellationRequested()) {
    throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function isCancellation(
  error: unknown,
  context: LocalSubtitleResourceJobContext,
): boolean {
  return context.signal.aborted ||
    context.isCancellationRequested() ||
    (error instanceof DOMException && error.name === "AbortError");
}

function isLifecycleCancellation(error: unknown): boolean {
  return (error instanceof LocalSubtitleVadManagerError &&
      error.localSubtitleCode === "owner_released") ||
    (error instanceof DOMException && error.name === "AbortError");
}

function toResourceJobError(error: unknown): LocalSubtitleError {
  if (error instanceof LocalSubtitleVadManagerError) {
    return createLocalSubtitleError(error.localSubtitleCode, error.message);
  }
  if (error instanceof LocalSubtitleResourceDownloadError) {
    const code = error.code === "model_disk_full"
      ? "insufficient_disk"
      : error.code;
    return createLocalSubtitleError(code, error.message);
  }
  if (
    error instanceof Error &&
    "localSubtitleCode" in error &&
    isLocalSubtitleErrorCode(error.localSubtitleCode)
  ) {
    return createLocalSubtitleError(error.localSubtitleCode, error.message);
  }
  return createLocalSubtitleError(
    "resource_signature_invalid",
    "The local subtitle VAD installation failed.",
  );
}

function vadErrorCode(error: unknown): LocalSubtitleErrorCode {
  if (error instanceof LocalSubtitleVadManagerError) {
    return error.localSubtitleCode;
  }
  return "resource_signature_invalid";
}

function failedJob(
  code: LocalSubtitleErrorCode,
  message: string,
): LocalSubtitleResourceJobExecutionResult {
  return { status: "failed", error: createLocalSubtitleError(code, message) };
}

function invalidVad(): LocalSubtitleVadManagerError {
  return vadFailure(
    "resource_signature_invalid",
    "The local subtitle VAD failed static verification.",
  );
}

function vadFailure(
  code: LocalSubtitleErrorCode,
  message: string,
): LocalSubtitleVadManagerError {
  return new LocalSubtitleVadManagerError(code, message);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function deepFreeze<T>(value: T): T {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
