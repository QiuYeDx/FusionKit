import { execFile } from "node:child_process";
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
  type LocalSubtitleError,
  type LocalSubtitleErrorCode,
  type LocalSubtitleResourceJobSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleManagedResourceSummary } from "@/type/localSubtitleIpc";
import {
  extractLocalSubtitleAcceleratorArchive,
  LocalSubtitleAcceleratorArchiveError,
  type ExtractLocalSubtitleAcceleratorArchiveOptions,
} from "./accelerator-archive";
import {
  LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT,
  LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST,
  type LocalSubtitleAcceleratorArchiveContract,
  type LocalSubtitleAcceleratorManifest,
} from "./accelerator-manifest";
import type { LocalSubtitleOwnerKey } from "./authorizations";
import {
  downloadLocalSubtitleResource,
  LocalSubtitleResourceDownloadError,
  type DownloadLocalSubtitleResourceOptions,
} from "./resource-download";
import {
  LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY,
} from "./resource-startup-cleaner";
import {
  LocalSubtitleResourceJobManager,
  type LocalSubtitleResourceJobContext,
  type LocalSubtitleResourceJobExecutionResult,
} from "./resource-job";
import { inspectLocalSubtitleNativeBinary } from "./resource-manifest";

const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_EXCLUSIVE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_NATIVE_HEADER_BYTES = 1024 * 1024;

export const LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY = Object.freeze({
  acceleratorDirectoryName: "accelerators",
  stagingDirectoryName:
    LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY
      .acceleratorStagingDirectoryName,
  downloadsDirectoryName:
    LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY
      .acceleratorDownloadsDirectoryName,
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
  probeTimeoutMs: 15_000,
  probeMaxOutputBytes: 1024 * 1024,
} as const);

export interface LocalSubtitleAcceleratorPackDefinition {
  readonly resourceId: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceArchive: {
    readonly fileName: string;
    readonly downloadUrl: string;
    readonly allowedDownloadHosts: readonly string[];
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly installedByteSize: number;
  readonly manifestRelativePath: string;
  readonly manifestBytes: Buffer;
  readonly archiveContract: LocalSubtitleAcceleratorArchiveContract;
  readonly artifacts: readonly {
    readonly id: string;
    readonly kind: "server" | "dynamic_library";
    readonly relativePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }[];
}

export interface LocalSubtitleAcceleratorProbeOptions {
  readonly packRoot: string;
  readonly serverPath: string;
  readonly signal?: AbortSignal;
}

export interface LocalSubtitleAcceleratorManagerOptions {
  readonly managedResourceRoot: string;
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: string;
  readonly resourceJobs: LocalSubtitleResourceJobManager;
  readonly packs?: readonly LocalSubtitleAcceleratorPackDefinition[];
  readonly availableBytes?: (directory: string) => Promise<number>;
  readonly stagingIdFactory?: () => string;
  readonly downloadResource?: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly extractArchive?: (
    options: ExtractLocalSubtitleAcceleratorArchiveOptions,
  ) => Promise<unknown>;
  readonly probePack?: (
    options: LocalSubtitleAcceleratorProbeOptions,
  ) => Promise<void>;
  readonly removeDirectory?: (absolutePath: string) => Promise<void>;
  readonly renameDirectory?: (source: string, destination: string) => Promise<void>;
  readonly isResourceBusy?: (
    resourceId: string,
  ) => boolean | Promise<boolean>;
}

export class LocalSubtitleAcceleratorManagerError extends Error {
  readonly name = "LocalSubtitleAcceleratorManagerError";

  constructor(
    readonly localSubtitleCode: Extract<
      LocalSubtitleErrorCode,
      | "owner_released"
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

interface VerifiedPackObservation {
  readonly rootIdentity: DirectoryIdentity;
  readonly files: readonly {
    readonly relativePath: string;
    readonly identity: FileIdentity;
  }[];
}

interface PrivateDirectoryProof extends DirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
}

interface AcceleratorRootProofs {
  readonly managed: PrivateDirectoryProof;
  readonly accelerators: PrivateDirectoryProof;
  readonly staging: PrivateDirectoryProof;
  readonly downloads: PrivateDirectoryProof;
}

interface StagingReceipt {
  currentPath: string;
  readonly stagingRoot: string;
  readonly identity: DirectoryIdentity;
  quarantined: boolean;
  cleaned: boolean;
}

interface ActiveVerification {
  readonly resourceId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly complete: () => void;
}

export const LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION =
  createProductionPackDefinition(
    LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST,
    LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT,
  );

export class LocalSubtitleAcceleratorManager {
  readonly #managedRoot: string;
  readonly #acceleratorsRoot: string;
  readonly #stagingRoot: string;
  readonly #downloadsRoot: string;
  readonly #platform: string;
  readonly #arch: string;
  readonly #resourceJobs: LocalSubtitleResourceJobManager;
  readonly #packs: readonly LocalSubtitleAcceleratorPackDefinition[];
  readonly #availableBytes: (directory: string) => Promise<number>;
  readonly #stagingIdFactory: () => string;
  readonly #downloadResource: (
    options: DownloadLocalSubtitleResourceOptions,
  ) => Promise<unknown>;
  readonly #extractArchive: (
    options: ExtractLocalSubtitleAcceleratorArchiveOptions,
  ) => Promise<unknown>;
  readonly #probePack: (
    options: LocalSubtitleAcceleratorProbeOptions,
  ) => Promise<void>;
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
  readonly #verifiedPacks = new Map<string, VerifiedPackObservation>();
  #rootProofs: AcceleratorRootProofs | undefined;
  #rootProofOperation: Promise<void> | undefined;
  #cleanupOperation: Promise<void> | undefined;
  #shutdownRequested = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(options: LocalSubtitleAcceleratorManagerOptions) {
    if (
      !options ||
      !(options.resourceJobs instanceof LocalSubtitleResourceJobManager)
    ) {
      throw new TypeError("The local subtitle accelerator manager options are invalid.");
    }
    this.#managedRoot = validateAbsoluteRoot(options.managedResourceRoot);
    this.#acceleratorsRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.acceleratorDirectoryName,
    );
    this.#stagingRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.stagingDirectoryName,
    );
    this.#downloadsRoot = path.join(
      this.#managedRoot,
      LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.downloadsDirectoryName,
    );
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#resourceJobs = options.resourceJobs;
    this.#packs = validatePackCatalog(
      options.packs ?? [LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION],
    );
    this.#availableBytes = options.availableBytes ?? availableFileSystemBytes;
    this.#stagingIdFactory = options.stagingIdFactory ?? randomUUID;
    this.#downloadResource = options.downloadResource ??
      downloadLocalSubtitleResource;
    this.#extractArchive = options.extractArchive ??
      extractLocalSubtitleAcceleratorArchive;
    this.#probePack = options.probePack ?? probeLocalSubtitleAcceleratorPack;
    this.#removeDirectory = options.removeDirectory ?? ((absolutePath) =>
      rm(absolutePath, {
        recursive: true,
        force: false,
        maxRetries:
          LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.cleanupMaxRetries,
        retryDelay:
          LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.cleanupRetryDelayMs,
      }));
    this.#renameDirectory = options.renameDirectory ?? rename;
    this.#isResourceBusy = options.isResourceBusy ?? (() => false);
  }

  hasResourceId(resourceId: string): boolean {
    return this.#packs.some((pack) => pack.resourceId === resourceId);
  }

  startResourceInstall(
    owner: LocalSubtitleOwnerKey,
    resourceId: string,
  ): LocalSubtitleResourceJobSummary {
    this.#assertAvailable();
    this.#assertSupportedTarget();
    const pack = this.#resolvePack(resourceId);
    this.#claim(pack.resourceId);
    try {
      return this.#resourceJobs.start({
        owner,
        resourceId: pack.resourceId,
        resourceType: "accelerator",
        execute: async (context) => {
          try {
            return await this.#executeInstall(pack, context);
          } finally {
            this.#claimedResourceIds.delete(pack.resourceId);
          }
        },
      });
    } catch (error) {
      this.#claimedResourceIds.delete(pack.resourceId);
      throw error;
    }
  }

  async deleteManagedResource(
    resourceId: string,
  ): Promise<Readonly<{ deleted: boolean }>> {
    this.#assertAvailable();
    const pack = this.#resolvePack(resourceId);
    this.#claim(pack.resourceId);
    let complete!: () => void;
    const deletion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#activeDeletions.add(deletion);
    try {
      if (await this.#isResourceBusy(pack.resourceId)) {
        throw acceleratorFailure(
          "resource_busy",
          "The local subtitle accelerator is currently in use.",
        );
      }
      const finalPath = this.#finalPackPath(pack);
      const stats = await lstatOptional(finalPath);
      if (!stats) return Object.freeze({ deleted: false });
      await this.#ensureRoots();
      await this.#verifyPack(pack, finalPath, undefined, true);
      if (await this.#isResourceBusy(pack.resourceId)) {
        throw acceleratorFailure(
          "resource_busy",
          "The local subtitle accelerator became busy during deletion.",
        );
      }
      await this.#assertRoots();
      const receipt = await this.#reserveExistingDirectory(
        finalPath,
        `.delete-${safeId(this.#stagingIdFactory())}`,
      );
      await this.#cleanupReceipt(receipt);
      this.#verifiedPacks.delete(pack.resourceId);
      return Object.freeze({ deleted: true });
    } finally {
      this.#claimedResourceIds.delete(pack.resourceId);
      this.#activeDeletions.delete(deletion);
      complete();
    }
  }

  async listManagedResources(
    signal?: AbortSignal,
  ): Promise<readonly LocalSubtitleManagedResourceSummary[]> {
    this.#assertAvailable();
    return Promise.all(this.#packs.map(async (pack) => {
      const base = {
        resourceId: pack.resourceId,
        resourceType: "accelerator" as const,
        displayName: pack.displayName,
        version: pack.version,
        byteSize: pack.installedByteSize,
        isDefault: false,
        compatibleBackends: ["cuda" as const],
      };
      if (
        this.#claimedResourceIds.has(pack.resourceId) ||
        this.#activeResourceIds.has(pack.resourceId)
      ) {
        return Object.freeze({ ...base, status: "installing" as const });
      }
      try {
        const present = await this.#runVerification(
          pack.resourceId,
          signal,
          async (operationSignal) => {
            const finalPath = this.#finalPackPath(pack);
            const stats = await lstatOptional(finalPath);
            if (!stats) {
              this.#verifiedPacks.delete(pack.resourceId);
              return false;
            }
            await this.#ensureRoots();
            await this.#verifyPack(pack, finalPath, operationSignal, true);
            return true;
          },
        );
        return Object.freeze({
          ...base,
          status: present ? "ready" as const : "not_installed" as const,
        });
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
          errorCode: acceleratorErrorCode(error),
        });
      }
    }));
  }

  shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#shutdownRequested = true;
    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#shutdownOperation = operation;
    for (const verification of this.#activeVerifications) {
      verification.controller.abort(
        acceleratorFailure(
          "owner_released",
          "The local subtitle accelerator manager is shutting down.",
        ),
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
    pack: LocalSubtitleAcceleratorPackDefinition,
    context: LocalSubtitleResourceJobContext,
  ): Promise<LocalSubtitleResourceJobExecutionResult> {
    let transaction: StagingReceipt | undefined;
    let committed: StagingReceipt | undefined;
    let completed = false;
    let commitStarted = false;
    let outcome: LocalSubtitleResourceJobExecutionResult | undefined;
    const totalBytes = pack.sourceArchive.byteSize + pack.installedByteSize;
    this.#activeResourceIds.add(pack.resourceId);
    try {
      context.update({
        status: "acquiring",
        progress: 1,
        bytesCompleted: 0,
        bytesTotal: totalBytes,
      });
      throwIfCancelled(context);
      await this.#retryOutstandingCleanup();
      await this.#ensureRoots();
      if (await lstatOptional(this.#finalPackPath(pack))) {
        throw acceleratorFailure(
          "resource_busy",
          "The selected local subtitle accelerator is already installed.",
        );
      }
      this.#verifiedPacks.delete(pack.resourceId);
      await this.#assertDiskSpace(totalBytes + pack.manifestBytes.byteLength);
      transaction = await this.#createStagingReceipt(pack);
      const archivePath = path.join(
        transaction.currentPath,
        pack.sourceArchive.fileName,
      );
      await this.#downloadResource({
        sourceUrl: pack.sourceArchive.downloadUrl,
        allowedHosts: pack.sourceArchive.allowedDownloadHosts,
        expectedBytes: pack.sourceArchive.byteSize,
        downloadDirectory: this.#downloadsRoot,
        partFileName: `${pack.resourceId}.part`,
        metadataFileName: `${pack.resourceId}.part.json`,
        destinationPath: archivePath,
        signal: context.signal,
        ensureCapacity: (remainingBytes) => this.#assertDiskSpace(
          remainingBytes + pack.installedByteSize + pack.manifestBytes.byteLength,
        ),
        onProgress: (completedBytes) => context.update({
          status: "acquiring",
          progress: Math.min(
            45,
            5 + (completedBytes / pack.sourceArchive.byteSize) * 40,
          ),
          bytesCompleted: completedBytes,
          bytesTotal: totalBytes,
        }),
      });
      throwIfCancelled(context);
      const packRoot = path.join(transaction.currentPath, "pack");
      context.update({
        status: "verifying",
        progress: 46,
        bytesCompleted: pack.sourceArchive.byteSize,
        bytesTotal: totalBytes,
      });
      await this.#extractArchive({
        archivePath,
        destinationDirectory: packRoot,
        contract: pack.archiveContract,
        signal: context.signal,
        onProgress: (completedBytes, extractionBytes) => context.update({
          status: "verifying",
          progress: Math.min(75, 46 + (completedBytes / extractionBytes) * 29),
          bytesCompleted: Math.min(
            totalBytes,
            pack.sourceArchive.byteSize +
              Math.round((completedBytes / extractionBytes) * pack.installedByteSize),
          ),
          bytesTotal: totalBytes,
        }),
      });
      await writeExclusiveFile(
        resolvePackRelativePath(packRoot, pack.manifestRelativePath),
        pack.manifestBytes,
      );
      context.update({
        status: "verifying",
        progress: 78,
        bytesCompleted: totalBytes,
        bytesTotal: totalBytes,
      });
      await this.#verifyPack(pack, packRoot, context.signal, false);
      throwIfCancelled(context);
      const server = pack.artifacts.find((artifact) => artifact.kind === "server");
      if (!server) throw invalidPack();
      context.update({
        status: "load_smoke",
        progress: 88,
        bytesCompleted: totalBytes,
        bytesTotal: totalBytes,
      });
      await this.#probePack({
        packRoot,
        serverPath: resolvePackRelativePath(packRoot, server.relativePath),
        signal: context.signal,
      });
      await this.#verifyPack(pack, packRoot, context.signal, false);
      throwIfCancelled(context);

      context.update({
        status: "committing",
        progress: 95,
        bytesCompleted: totalBytes,
        bytesTotal: totalBytes,
      });
      commitStarted = true;
      await this.#assertRoots();
      const finalPath = this.#finalPackPath(pack);
      if (await lstatOptional(finalPath)) {
        throw acceleratorFailure(
          "resource_busy",
          "The local subtitle accelerator destination already exists.",
        );
      }
      const packRootStats = await lstat(packRoot);
      const packIdentity = directoryIdentity(packRootStats);
      await this.#renameDirectory(packRoot, finalPath);
      const finalStats = await lstat(finalPath);
      assertSameDirectory(packIdentity, directoryIdentity(finalStats));
      committed = {
        currentPath: finalPath,
        stagingRoot: this.#stagingRoot,
        identity: packIdentity,
        quarantined: false,
        cleaned: false,
      };

      // Cancellation after the commit boundary cannot turn a verified install
      // into a partially published pack. Post-commit verification is unabortable.
      await this.#verifyPack(pack, finalPath, undefined, true);
      await this.#cleanupReceipt(transaction);
      await this.#cleanupSupersededPacks(pack);
      completed = true;
      outcome = { status: "completed" };
    } catch (error) {
      outcome = !commitStarted && isCancellation(error, context)
        ? { status: "cancelled" }
        : { status: "failed", error: toResourceJobError(error) };
    }

    if (!completed) {
      this.#verifiedPacks.delete(pack.resourceId);
      for (const receipt of [committed, transaction]) {
        if (!receipt || receipt.cleaned) continue;
        try {
          await this.#cleanupReceipt(receipt);
        } catch {
          this.#orphanedStaging.add(receipt);
          outcome = failedJob(
            "cancel_failed",
            "The local subtitle accelerator staging area could not be removed safely.",
          );
        }
      }
    }
    this.#activeResourceIds.delete(pack.resourceId);
    return outcome ?? failedJob(
      "accelerator_unavailable",
      "The local subtitle accelerator install did not reach a terminal state.",
    );
  }

  async #verifyPack(
    pack: LocalSubtitleAcceleratorPackDefinition,
    packRoot: string,
    signal: AbortSignal | undefined,
    verifyHashes: boolean,
  ): Promise<void> {
    throwIfSignalAborted(signal);
    const rootStats = await lstat(packRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw invalidPack();
    const expectedFiles = new Set([
      pack.manifestRelativePath,
      ...pack.artifacts.map((artifact) => artifact.relativePath),
    ]);
    await assertExactPackTree(packRoot, expectedFiles, signal);
    const canCache = verifyHashes && packRoot === this.#finalPackPath(pack);
    const cached = canCache ? this.#verifiedPacks.get(pack.resourceId) : undefined;
    if (cached) {
      try {
        assertSameDirectory(cached.rootIdentity, directoryIdentity(rootStats));
        for (const file of cached.files) {
          throwIfSignalAborted(signal);
          const stats = await lstat(
            resolvePackRelativePath(packRoot, file.relativePath),
          );
          if (!stats.isFile() || stats.isSymbolicLink()) throw invalidPack();
          assertSameFile(file.identity, fileIdentity(stats));
        }
        return;
      } catch {
        this.#verifiedPacks.delete(pack.resourceId);
      }
    }

    const manifestObservation = await readNoFollowFile(
      resolvePackRelativePath(packRoot, pack.manifestRelativePath),
      signal,
      pack.manifestBytes.byteLength,
    );
    if (!manifestObservation.bytes.equals(pack.manifestBytes)) throw invalidPack();

    const files: Array<VerifiedPackObservation["files"][number]> = [{
      relativePath: pack.manifestRelativePath,
      identity: manifestObservation.identity,
    }];
    for (const artifact of pack.artifacts) {
      throwIfSignalAborted(signal);
      const identity = await verifyPeArtifact(
        resolvePackRelativePath(packRoot, artifact.relativePath),
        artifact,
        signal,
        verifyHashes,
      );
      files.push({ relativePath: artifact.relativePath, identity });
    }
    const rootIdentity = directoryIdentity(rootStats);
    assertSameDirectory(rootIdentity, directoryIdentity(await lstat(packRoot)));
    if (canCache) {
      this.#verifiedPacks.set(pack.resourceId, Object.freeze({
        rootIdentity,
        files: Object.freeze(files.map((file) => Object.freeze(file))),
      }));
    }
  }

  async #runVerification<T>(
    resourceId: string,
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
    const record: ActiveVerification = {
      resourceId,
      controller,
      completion,
      complete,
    };
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
      throw acceleratorFailure(
        "resource_busy",
        `The local subtitle accelerator already has an active operation for ${resourceId}.`,
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
      if (this.#rootProofOperation === operation) {
        this.#rootProofOperation = undefined;
      }
    }
  }

  async #createOrVerifyRoots(): Promise<void> {
    if (this.#rootProofs) {
      await verifyRootProofs(this.#rootProofs);
      return;
    }
    const managed = await ensurePrivateDirectory(this.#managedRoot, this.#platform);
    const accelerators = await ensurePrivateDirectory(
      this.#acceleratorsRoot,
      this.#platform,
    );
    const staging = await ensurePrivateDirectory(this.#stagingRoot, this.#platform);
    const downloads = await ensurePrivateDirectory(
      this.#downloadsRoot,
      this.#platform,
    );
    const proofs = Object.freeze({ managed, accelerators, staging, downloads });
    assertRootContainment(proofs);
    await verifyRootProofs(proofs);
    this.#rootProofs = proofs;
  }

  async #assertRoots(): Promise<void> {
    if (!this.#rootProofs) {
      throw acceleratorFailure(
        "resource_not_allowed",
        "The managed accelerator roots are not initialized.",
      );
    }
    await verifyRootProofs(this.#rootProofs);
  }

  async #assertDiskSpace(requiredBytes: number): Promise<void> {
    await this.#assertRoots();
    let available: number;
    try {
      available = await this.#availableBytes(this.#stagingRoot);
    } catch {
      throw acceleratorFailure(
        "insufficient_disk",
        "Available disk space for the local subtitle accelerator could not be verified.",
      );
    }
    await this.#assertRoots();
    if (!Number.isSafeInteger(available) || available < requiredBytes) {
      throw acceleratorFailure(
        "insufficient_disk",
        "There is not enough disk space to install the local subtitle accelerator.",
      );
    }
  }

  async #createStagingReceipt(
    pack: LocalSubtitleAcceleratorPackDefinition,
  ): Promise<StagingReceipt> {
    await this.#assertRoots();
    const root = await mkdtemp(path.join(
      this.#stagingRoot,
      `.install-${safeId(pack.resourceId)}-${safeId(this.#stagingIdFactory())}-`,
    ));
    const proof = await readPrivateDirectoryProof(root, this.#platform);
    if (!isContainedPath(this.#rootProofs!.staging.realPath, proof.realPath)) {
      throw acceleratorFailure(
        "resource_not_allowed",
        "The accelerator staging directory escaped its private root.",
      );
    }
    return {
      currentPath: root,
      stagingRoot: this.#stagingRoot,
      identity: directoryIdentity(proof),
      quarantined: false,
      cleaned: false,
    };
  }

  async #reserveExistingDirectory(
    absolutePath: string,
    quarantineLeaf: string,
  ): Promise<StagingReceipt> {
    const stats = await lstat(absolutePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidPack();
    const quarantine = path.join(this.#stagingRoot, quarantineLeaf);
    await this.#renameDirectory(absolutePath, quarantine);
    const receipt: StagingReceipt = {
      currentPath: quarantine,
      stagingRoot: this.#stagingRoot,
      identity: directoryIdentity(stats),
      quarantined: true,
      cleaned: false,
    };
    assertSameDirectory(
      receipt.identity,
      directoryIdentity(await lstat(quarantine)),
    );
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
        receipt.stagingRoot,
        `.cleanup-${safeId(this.#stagingIdFactory())}`,
      );
      await this.#renameDirectory(receipt.currentPath, quarantine);
      receipt.currentPath = quarantine;
      receipt.quarantined = true;
    }
    const quarantineStats = await lstat(receipt.currentPath);
    assertSameDirectory(receipt.identity, directoryIdentity(quarantineStats));
    const stagingRealPath = await realpath(receipt.stagingRoot);
    const quarantineRealPath = await realpath(receipt.currentPath);
    if (!isContainedPath(stagingRealPath, quarantineRealPath)) {
      throw new Error("Accelerator cleanup escaped its private staging root.");
    }
    await this.#removeDirectory(receipt.currentPath);
    if (await lstatOptional(receipt.currentPath)) {
      throw new Error("Accelerator cleanup did not remove the owned directory.");
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
      throw acceleratorFailure(
        "cancel_failed",
        "A local subtitle accelerator directory still requires cleanup.",
      );
    }
  }

  async #cleanupSupersededPacks(
    activePack: LocalSubtitleAcceleratorPackDefinition,
  ): Promise<void> {
    for (const pack of this.#packs) {
      if (pack.resourceId === activePack.resourceId) continue;
      const oldPath = this.#finalPackPath(pack);
      if (!(await lstatOptional(oldPath))) continue;
      let receipt: StagingReceipt | undefined;
      try {
        await this.#verifyPack(pack, oldPath, undefined, true);
        receipt = await this.#reserveExistingDirectory(
          oldPath,
          `.superseded-${safeId(pack.resourceId)}-${safeId(this.#stagingIdFactory())}`,
        );
        await this.#cleanupReceipt(receipt);
        this.#verifiedPacks.delete(pack.resourceId);
      } catch {
        // A new verified pack stays active even when an older, independently
        // versioned pack cannot be proven safe to remove.
        if (receipt && !receipt.cleaned) this.#orphanedStaging.add(receipt);
      }
    }
  }

  #finalPackPath(pack: LocalSubtitleAcceleratorPackDefinition): string {
    return resolvePackRelativePath(this.#acceleratorsRoot, pack.resourceId);
  }

  #resolvePack(resourceId: string): LocalSubtitleAcceleratorPackDefinition {
    const pack = this.#packs.find((candidate) => candidate.resourceId === resourceId);
    if (!pack) {
      throw acceleratorFailure(
        "accelerator_unavailable",
        "The requested local subtitle accelerator is not allowlisted.",
      );
    }
    return pack;
  }

  #assertSupportedTarget(): void {
    if (this.#platform !== "win32") {
      throw acceleratorFailure(
        "unsupported_platform",
        "The CUDA local subtitle accelerator is available only on Windows.",
      );
    }
    if (this.#arch !== "x64") {
      throw acceleratorFailure(
        "unsupported_architecture",
        "The CUDA local subtitle accelerator requires Windows x64.",
      );
    }
  }

  #assertAvailable(): void {
    if (this.#shutdownRequested) {
      throw acceleratorFailure(
        "owner_released",
        "The local subtitle accelerator manager is shutting down.",
      );
    }
  }
}

export async function probeLocalSubtitleAcceleratorPack(
  options: LocalSubtitleAcceleratorProbeOptions,
): Promise<void> {
  if (!options || !path.isAbsolute(options.serverPath)) throw invalidPack();
  throwIfSignalAborted(options.signal);
  const runtimeDirectory = path.dirname(options.serverPath);
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const system32 = path.win32.join(systemRoot, "System32");
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: `${runtimeDirectory};${system32}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    LANG: "C",
    LC_ALL: "C",
    ...(process.env.ProgramFiles === undefined
      ? {}
      : { ProgramFiles: process.env.ProgramFiles }),
    ...(process.env.ProgramW6432 === undefined
      ? {}
      : { ProgramW6432: process.env.ProgramW6432 }),
  } as unknown as NodeJS.ProcessEnv;
  const result = await runIdentityProbe(
    options.serverPath,
    system32,
    environment,
    options.signal,
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0 || !/(?:whisper-server|whisper server|usage:)/iu.test(output)) {
    throw acceleratorFailure(
      "accelerator_unavailable",
      "The Windows CUDA server failed its launch identity probe.",
    );
  }
}

function createProductionPackDefinition(
  manifest: LocalSubtitleAcceleratorManifest,
  archiveContract: LocalSubtitleAcceleratorArchiveContract,
): LocalSubtitleAcceleratorPackDefinition {
  return deepFreeze({
    resourceId: manifest.packId,
    displayName: `CUDA ${manifest.target.cudaVersion} accelerator`,
    version: `${manifest.engine.version}+cuda-${manifest.target.cudaVersion}`,
    sourceArchive: {
      fileName: manifest.sourceArchive.fileName,
      downloadUrl: manifest.sourceArchive.downloadUrl,
      allowedDownloadHosts: [...manifest.sourceArchive.allowedDownloadHosts],
      byteSize: manifest.sourceArchive.byteSize,
      sha256: manifest.sourceArchive.sha256,
    },
    installedByteSize: manifest.selection.selectedArtifactByteSize,
    manifestRelativePath: manifest.staging.manifestRelativePath,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    archiveContract,
    artifacts: manifest.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
    })),
  });
}

function validatePackCatalog(
  packs: readonly LocalSubtitleAcceleratorPackDefinition[],
): readonly LocalSubtitleAcceleratorPackDefinition[] {
  if (!Array.isArray(packs) || packs.length === 0) {
    throw new TypeError("The local subtitle accelerator catalog is invalid.");
  }
  const ids = new Set<string>();
  const catalog = packs as readonly LocalSubtitleAcceleratorPackDefinition[];
  const validated = catalog.map((pack: LocalSubtitleAcceleratorPackDefinition) => {
    if (
      !pack ||
      !isSafeLeaf(pack.resourceId) ||
      typeof pack.displayName !== "string" ||
      pack.displayName.trim() === "" ||
      typeof pack.version !== "string" ||
      pack.version.trim() === "" ||
      !Buffer.isBuffer(pack.manifestBytes) ||
      pack.manifestBytes.length === 0 ||
      !isSafeRelativePath(pack.manifestRelativePath) ||
      !Number.isSafeInteger(pack.installedByteSize) ||
      pack.installedByteSize <= 0 ||
      !Array.isArray(pack.artifacts) ||
      pack.artifacts.length === 0 ||
      !pack.sourceArchive ||
      !isSafeLeaf(pack.sourceArchive.fileName) ||
      !Array.isArray(pack.sourceArchive.allowedDownloadHosts) ||
      pack.sourceArchive.allowedDownloadHosts.length === 0 ||
      !Number.isSafeInteger(pack.sourceArchive.byteSize) ||
      pack.sourceArchive.byteSize <= 0 ||
      !/^[a-f0-9]{64}$/u.test(pack.sourceArchive.sha256)
    ) {
      throw new TypeError("The local subtitle accelerator catalog is invalid.");
    }
    const normalizedId = pack.resourceId.toLowerCase();
    if (ids.has(normalizedId)) {
      throw new TypeError("The local subtitle accelerator ids are not unique.");
    }
    ids.add(normalizedId);
    const artifactIds = new Set<string>();
    const paths = [pack.manifestRelativePath];
    let artifactBytes = 0;
    let serverCount = 0;
    for (const artifact of pack.artifacts) {
      if (
        !artifact ||
        !isSafeLeaf(artifact.id) ||
        !isSafeRelativePath(artifact.relativePath) ||
        !Number.isSafeInteger(artifact.byteSize) ||
        artifact.byteSize <= 0 ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      ) {
        throw new TypeError("The local subtitle accelerator artifacts are invalid.");
      }
      const artifactId = artifact.id.toLowerCase();
      if (artifactIds.has(artifactId)) {
        throw new TypeError("The local subtitle accelerator artifact ids are not unique.");
      }
      artifactIds.add(artifactId);
      artifactBytes += artifact.byteSize;
      if (artifact.kind === "server") serverCount += 1;
      paths.push(artifact.relativePath);
    }
    const selected = pack.archiveContract?.selectedEntries;
    if (
      serverCount !== 1 ||
      artifactBytes !== pack.installedByteSize ||
      pack.archiveContract?.archive.byteSize !== pack.sourceArchive.byteSize ||
      pack.archiveContract.archive.sha256 !== pack.sourceArchive.sha256 ||
      !Array.isArray(selected) ||
      selected.length !== pack.artifacts.length ||
      pack.artifacts.some((artifact) => {
        const entry = selected.find(
          (candidate) => candidate.outputRelativePath === artifact.relativePath,
        );
        return !entry ||
          entry.byteSize !== artifact.byteSize ||
          entry.sha256 !== artifact.sha256;
      }) ||
      new Set(paths.map((value) => value.toLowerCase())).size !== paths.length
    ) {
      throw new TypeError("The local subtitle accelerator contract is inconsistent.");
    }
    return deepFreeze({
      ...pack,
      sourceArchive: {
        ...pack.sourceArchive,
        allowedDownloadHosts: [...pack.sourceArchive.allowedDownloadHosts],
      },
      manifestBytes: Buffer.from(pack.manifestBytes),
      artifacts: pack.artifacts.map((artifact) => ({ ...artifact })),
    });
  });
  return Object.freeze(validated);
}

async function verifyPeArtifact(
  absolutePath: string,
  expected: LocalSubtitleAcceleratorPackDefinition["artifacts"][number],
  signal: AbortSignal | undefined,
  verifyHash: boolean,
): Promise<FileIdentity> {
  const before = await lstat(absolutePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== expected.byteSize
  ) {
    throw invalidPack();
  }
  const handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  try {
    const opened = await handle.stat();
    assertSameFile(fileIdentity(before), fileIdentity(opened));
    const header = Buffer.alloc(Math.min(opened.size, MAX_NATIVE_HEADER_BYTES));
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length) throw invalidPack();
    const nativeIdentity = inspectLocalSubtitleNativeBinary(header);
    if (
      nativeIdentity.format !== "pe" ||
      nativeIdentity.architectures.length !== 1 ||
      nativeIdentity.architectures[0] !== "x64"
    ) {
      throw invalidPack();
    }
    if (verifyHash) {
      const observedHash = await hashFileHandle(handle, opened.size, signal);
      if (observedHash !== expected.sha256) throw invalidPack();
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
    if (read.bytesRead <= 0) throw invalidPack();
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest("hex");
}

async function assertExactPackTree(
  root: string,
  expectedFiles: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles) {
    let current = path.posix.dirname(file);
    while (current !== ".") {
      expectedDirectories.add(current);
      current = path.posix.dirname(current);
    }
  }
  const observedFiles = new Set<string>();
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    throwIfSignalAborted(signal);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) throw invalidPack();
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) throw invalidPack();
        await walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(relativePath)) throw invalidPack();
        observedFiles.add(relativePath);
      } else {
        throw invalidPack();
      }
    }
  };
  await walk(root);
  if (
    observedFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !observedFiles.has(file))
  ) {
    throw invalidPack();
  }
}

async function readNoFollowFile(
  absolutePath: string,
  signal: AbortSignal | undefined,
  expectedBytes: number,
): Promise<Readonly<{ bytes: Buffer; identity: FileIdentity }>> {
  const handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expectedBytes) throw invalidPack();
    const bytes = Buffer.alloc(expectedBytes);
    let position = 0;
    while (position < bytes.length) {
      throwIfSignalAborted(signal);
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead <= 0) throw invalidPack();
      position += read.bytesRead;
    }
    const identity = fileIdentity(stats);
    assertSameFile(identity, fileIdentity(await handle.stat()));
    assertSameFile(identity, fileIdentity(await lstat(absolutePath)));
    return Object.freeze({ bytes, identity });
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(absolutePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const handle = await open(absolutePath, WRITE_EXCLUSIVE_NOFOLLOW_FLAGS, 0o600);
  try {
    let position = 0;
    while (position < bytes.length) {
      const write = await handle.write(bytes, position, bytes.length - position, position);
      if (write.bytesWritten <= 0) throw invalidPack();
      position += write.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runIdentityProbe(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    execFile(command, ["--help"], {
      cwd,
      env,
      timeout: LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.probeTimeoutMs,
      maxBuffer: LOCAL_SUBTITLE_ACCELERATOR_MANAGER_POLICY.probeMaxOutputBytes,
      windowsHide: true,
      shell: false,
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      if (!error) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      resolve({
        exitCode: typeof error.code === "number" ? error.code : null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
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
    throw acceleratorFailure(
      "resource_not_allowed",
      "A managed accelerator directory is not private.",
    );
  }
  return Object.freeze({
    absolutePath,
    realPath: await realpath(absolutePath),
    ...directoryIdentity(stats),
  });
}

async function verifyRootProofs(proofs: AcceleratorRootProofs): Promise<void> {
  await Promise.all(Object.values(proofs).map(async (proof) => {
    const stats = await lstat(proof.absolutePath);
    assertSameDirectory(proof, directoryIdentity(stats));
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidPack();
    if (await realpath(proof.absolutePath) !== proof.realPath) throw invalidPack();
  }));
  assertRootContainment(proofs);
}

function assertRootContainment(proofs: AcceleratorRootProofs): void {
  const children = [proofs.accelerators, proofs.staging, proofs.downloads];
  if (children.some((child) => !isContainedPath(proofs.managed.realPath, child.realPath))) {
    throw acceleratorFailure(
      "resource_not_allowed",
      "A managed accelerator directory escaped its private root.",
    );
  }
  if (new Set(children.map((child) => child.realPath.toLowerCase())).size !== 3) {
    throw acceleratorFailure(
      "resource_not_allowed",
      "Managed accelerator directories must be independent.",
    );
  }
}

function resolvePackRelativePath(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath) && !isSafeLeaf(relativePath)) {
    throw new TypeError("The local subtitle accelerator path is invalid.");
  }
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isContainedPath(root, resolved)) {
    throw new TypeError("The local subtitle accelerator path escaped its root.");
  }
  return resolved;
}

function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => isSafeLeaf(segment));
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
    throw new TypeError("The local subtitle accelerator staging id is invalid.");
  }
  return value;
}

function validateAbsoluteRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute accelerator resource root is required.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The filesystem root cannot be an accelerator resource root.");
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

function directoryIdentity(stats: Pick<Stats, "dev" | "ino" | "birthtimeMs">): DirectoryIdentity {
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

function assertSameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.birthtimeMs !== right.birthtimeMs
  ) {
    throw invalidPack();
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
    throw invalidPack();
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
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof LocalSubtitleAcceleratorArchiveError &&
      error.code === "accelerator_archive_cancelled");
}

function isLifecycleCancellation(error: unknown): boolean {
  return (error instanceof LocalSubtitleAcceleratorManagerError &&
      error.localSubtitleCode === "owner_released") ||
    (error instanceof DOMException && error.name === "AbortError");
}

function toResourceJobError(error: unknown): LocalSubtitleError {
  if (error instanceof LocalSubtitleAcceleratorManagerError) {
    return createLocalSubtitleError(error.localSubtitleCode, error.message);
  }
  if (error instanceof LocalSubtitleResourceDownloadError) {
    const code = error.code === "model_disk_full"
      ? "insufficient_disk"
      : error.code;
    return createLocalSubtitleError(code, error.message);
  }
  if (error instanceof LocalSubtitleAcceleratorArchiveError) {
    const code = error.code === "accelerator_archive_cleanup_failed"
      ? "cancel_failed"
      : "resource_signature_invalid";
    return createLocalSubtitleError(code, error.message);
  }
  return createLocalSubtitleError(
    "accelerator_unavailable",
    "The local subtitle accelerator installation failed.",
  );
}

function acceleratorErrorCode(error: unknown): LocalSubtitleErrorCode {
  if (error instanceof LocalSubtitleAcceleratorManagerError) {
    return error.localSubtitleCode;
  }
  if (error instanceof LocalSubtitleAcceleratorArchiveError) {
    return error.code === "accelerator_archive_cleanup_failed"
      ? "cancel_failed"
      : "resource_signature_invalid";
  }
  return "resource_signature_invalid";
}

function failedJob(
  code: LocalSubtitleErrorCode,
  message: string,
): LocalSubtitleResourceJobExecutionResult {
  return { status: "failed", error: createLocalSubtitleError(code, message) };
}

function invalidPack(): LocalSubtitleAcceleratorManagerError {
  return acceleratorFailure(
    "resource_signature_invalid",
    "The local subtitle accelerator pack failed static verification.",
  );
}

function acceleratorFailure(
  code: LocalSubtitleAcceleratorManagerError["localSubtitleCode"],
  message: string,
): LocalSubtitleAcceleratorManagerError {
  return new LocalSubtitleAcceleratorManagerError(code, message);
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
