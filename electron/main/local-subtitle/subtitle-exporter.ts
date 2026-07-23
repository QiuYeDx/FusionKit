import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_SUBTITLE_ERROR_CODES,
  LOCAL_SUBTITLE_FORMATS,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_CONFLICT_POLICIES,
  resolveLocalSubtitleTerminalOutcome,
  type GeneratedSubtitleArtifactSummary,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleCompletionResult,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleErrorCode,
  type LocalSubtitleFormat,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";
import {
  resolveSafeLocalSubtitleChildPath,
  type LocalSubtitleDirectoryIdentity,
  type LocalSubtitleFileObjectIdentity,
  type LocalSubtitleOwnerKey,
  type ResolvedLocalSubtitleOutputDirectory,
} from "./authorizations";
import {
  encodeLocalSubtitleArtifact,
  LocalSubtitleFormatError,
  parseLocalSubtitleArtifactUtf8,
  verifyLocalSubtitleArtifactRoundTrip,
} from "./subtitle-formats";
import {
  isLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionReceipt,
} from "./overwrite-transaction";
import {
  isLocalSubtitleOverwriteRecoveryOwner,
  type LocalSubtitleOverwriteRecoveryOwner,
  type LocalSubtitleOverwriteRecoveryRegistryAuthority,
} from "./overwrite-recovery-owner";
import {
  localSubtitleOverwriteDirectoryKey,
  withLocalSubtitleOverwriteDirectory,
} from "./overwrite-directory-coordinator";

const PRIVATE_FILE_MODE = 0o600;
const WRITE_EXCLUSIVE_NOFOLLOW =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const READ_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_CHUNK_BYTES = 1024 * 1024;
const MAX_PARTIAL_CREATE_ATTEMPTS = 16;
const MAX_INDEX_ATTEMPTS = 10_000;
const ARTIFACT_EXTENSIONS = {
  SRT: "srt",
  LRC: "lrc",
} as const satisfies Record<LocalSubtitleFormat, string>;
const ERROR_CODES = new Set<string>(LOCAL_SUBTITLE_ERROR_CODES);

type FileObjectIdentity = LocalSubtitleFileObjectIdentity;

export interface LocalSubtitleArtifactReservation<TReservation> {
  readonly artifactRef: string;
  readonly expiresAt: number;
  readonly reservation: TReservation;
}

export interface LocalSubtitleArtifactRegistryCollaborator<TReservation> {
  reserve(options: {
    readonly owner: LocalSubtitleOwnerKey;
    readonly taskId: string;
    readonly generation: number;
    readonly format: LocalSubtitleFormat;
    readonly displayName: string;
  }): LocalSubtitleArtifactReservation<TReservation>;
  activate(
    reservation: TReservation,
    artifact: {
      readonly filePath: string;
      readonly format: LocalSubtitleFormat;
      readonly displayName: string;
      readonly sha256: string;
      readonly byteSize: number;
      readonly expectedFileIdentity: LocalSubtitleFileObjectIdentity;
      readonly expectedDirectoryIdentity: LocalSubtitleDirectoryIdentity;
    },
  ): GeneratedSubtitleArtifactSummary;
  revokeReservation(reservation: TReservation): boolean;
  revokeArtifact(owner: LocalSubtitleOwnerKey, artifactRef: string): boolean;
}

export interface LocalSubtitleExporterDependencies<TReservation = unknown> {
  readonly createPartialId?: () => string;
  readonly commitIndex?: (partialPath: string, finalPath: string) => Promise<void>;
  readonly overwriteTransaction?: LocalSubtitleOverwriteTransactionCoordinator;
  readonly overwriteRecoveryOwner?: LocalSubtitleOverwriteRecoveryOwner<TReservation>;
  /** Explicit legacy/test adapter. It is never used as a production fallback. */
  readonly commitOverwrite?: (
    partialPath: string,
    finalPath: string,
  ) => Promise<void>;
  readonly removeFile?: (filePath: string) => Promise<void>;
  readonly removeFileSync?: (filePath: string) => void;
  readonly onPartialWriteChunk?: (writtenBytes: number) => void;
}

export interface ExportLocalSubtitleArtifactsOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly outputStem: string;
  readonly formats: readonly LocalSubtitleFormat[];
  readonly conflictPolicy: LocalSubtitleConflictPolicy;
  readonly transcript: LocalSubtitleTranscript;
  readonly resolveOutputDirectory: () => Promise<ResolvedLocalSubtitleOutputDirectory>;
  readonly signal?: AbortSignal;
}

export type LocalSubtitleExportResult =
  | {
      readonly status: "completed";
      readonly artifactResults: readonly LocalSubtitleArtifactResult[];
      readonly completion: LocalSubtitleCompletionResult;
    }
  | {
      readonly status: "cancelled" | "failed";
      readonly artifactResults: readonly LocalSubtitleArtifactResult[];
    };

export class LocalSubtitleExporterError extends Error {
  readonly name = "LocalSubtitleExporterError";

  constructor(
    readonly code: LocalSubtitleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface PreparedArtifact {
  readonly transactionId: string;
  readonly partialPath: string;
  readonly identity: FileObjectIdentity;
  readonly byteSize: number;
  readonly sha256: string;
}

interface CommittedArtifact {
  readonly summary: GeneratedSubtitleArtifactSummary;
  readonly prepared: PreparedArtifact;
}

export class LocalSubtitleExporter<TReservation> {
  readonly #createPartialId: () => string;
  readonly #commitIndex: (
    partialPath: string,
    finalPath: string,
  ) => Promise<void>;
  readonly #overwriteTransaction?: LocalSubtitleOverwriteTransactionCoordinator;
  readonly #overwriteRecoveryOwner?: LocalSubtitleOverwriteRecoveryOwner<TReservation>;
  readonly #commitOverwrite?: (
    partialPath: string,
    finalPath: string,
  ) => Promise<void>;
  readonly #removeFile: (filePath: string) => Promise<void>;
  readonly #removeFileSync: (filePath: string) => void;
  readonly #onPartialWriteChunk?: (writtenBytes: number) => void;

  constructor(
    private readonly artifacts: LocalSubtitleArtifactRegistryCollaborator<TReservation>,
    dependencies: LocalSubtitleExporterDependencies<TReservation> = {},
  ) {
    if (dependencies.overwriteTransaction && dependencies.commitOverwrite) {
      throw new TypeError(
        "Only one local subtitle overwrite commit strategy may be configured.",
      );
    }
    if (
      dependencies.overwriteTransaction &&
      !isLocalSubtitleOverwriteTransactionCoordinator(
        dependencies.overwriteTransaction,
      )
    ) {
      throw new TypeError(
        "A validated local subtitle overwrite transaction coordinator is required.",
      );
    }
    if (
      Boolean(dependencies.overwriteTransaction) !==
        Boolean(dependencies.overwriteRecoveryOwner) ||
      (dependencies.overwriteRecoveryOwner &&
        !isLocalSubtitleOverwriteRecoveryOwner(
          dependencies.overwriteRecoveryOwner,
        ))
    ) {
      throw new TypeError(
        "A validated recovery owner is required with the overwrite transaction coordinator.",
      );
    }
    this.#createPartialId = dependencies.createPartialId ?? randomUUID;
    this.#commitIndex = dependencies.commitIndex ?? link;
    this.#overwriteTransaction = dependencies.overwriteTransaction;
    this.#overwriteRecoveryOwner = dependencies.overwriteRecoveryOwner;
    this.#commitOverwrite = dependencies.commitOverwrite;
    this.#removeFile = dependencies.removeFile ?? unlink;
    this.#removeFileSync = dependencies.removeFileSync ?? unlinkSync;
    this.#onPartialWriteChunk = dependencies.onPartialWriteChunk;
  }

  async exportArtifacts(
    options: ExportLocalSubtitleArtifactsOptions,
  ): Promise<LocalSubtitleExportResult> {
    assertExportOptions(options);
    const overwriteUnavailable =
      options.conflictPolicy === "overwrite" &&
      !this.#overwriteTransaction &&
      !this.#commitOverwrite;
    const artifactResults: LocalSubtitleArtifactResult[] = [];
    let committedCount = 0;
    let cancellationRequested = Boolean(options.signal?.aborted);

    for (const format of options.formats) {
      if (options.signal?.aborted) cancellationRequested = true;
      if (cancellationRequested) {
        artifactResults.push(
          skippedResult(format, committedCount > 0),
        );
        continue;
      }

      try {
        if (overwriteUnavailable) {
          throw outputWriteFailure(
            "The native subtitle overwrite transaction is unavailable.",
          );
        }
        const artifact = await this.#exportFormat(options, format);
        artifactResults.push(
          Object.freeze({
            format,
            status: "committed" as const,
            artifact: artifact.summary,
          }),
        );
        committedCount += 1;
      } catch (error) {
        const code = errorCode(error);
        if (code === "cancel_failed") {
          if (options.signal?.aborted) cancellationRequested = true;
          artifactResults.push(
            Object.freeze({
              format,
              status: "failed" as const,
              errorCode: code,
            }),
          );
          continue;
        }
        if (error instanceof ExportCancelledError || options.signal?.aborted) {
          cancellationRequested = true;
          artifactResults.push(skippedResult(format, committedCount > 0));
          continue;
        }
        artifactResults.push(
          Object.freeze({
            format,
            status: "failed" as const,
            errorCode: code,
          }),
        );
      }
    }

    if (options.signal?.aborted) cancellationRequested = true;
    const terminal = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: options.formats,
      artifactResults,
      cancellationRequested,
    });
    if (!terminal.ok) {
      throw new LocalSubtitleExporterError(
        "invalid_content",
        "Subtitle export results violated the terminal outcome contract.",
      );
    }

    const frozenResults = Object.freeze([...artifactResults]);
    if (terminal.status === "completed") {
      return Object.freeze({
        status: terminal.status,
        artifactResults: frozenResults,
        completion: terminal.completion,
      });
    }
    return Object.freeze({
      status: terminal.status,
      artifactResults: frozenResults,
    });
  }

  async #exportFormat(
    options: ExportLocalSubtitleArtifactsOptions,
    format: LocalSubtitleFormat,
  ): Promise<CommittedArtifact> {
    throwIfCancelled(options.signal);
    const initialDirectory = await options.resolveOutputDirectory();
    assertResolvedDirectory(initialDirectory);
    const key = localSubtitleOverwriteDirectoryKey(initialDirectory.identity);

    return withLocalSubtitleOverwriteDirectory(key, async () => {
      throwIfCancelled(options.signal);
      const lockedDirectory = await options.resolveOutputDirectory();
      assertSameResolvedDirectory(initialDirectory, lockedDirectory);
      await assertDirectoryIdentity(lockedDirectory);
      throwIfCancelled(options.signal);

      const bytes = encodeLocalSubtitleArtifact(format, options.transcript);
      let prepared: PreparedArtifact | undefined;
      let committed = false;
      try {
        prepared = await this.#writeAndVerifyPartial({
          directory: lockedDirectory,
          format,
          transcript: options.transcript,
          bytes,
          signal: options.signal,
        });
        throwIfCancelled(options.signal);

        const committedArtifact = options.conflictPolicy === "index"
          ? await this.#commitWithIndex({
              options,
              format,
              initialDirectory,
              prepared,
            })
          : await this.#commitWithOverwrite({
              options,
              format,
              initialDirectory,
              prepared,
            });
        committed = true;
        return committedArtifact;
      } finally {
        if (!committed && prepared) {
          await removeOwnedPartial(
            prepared.partialPath,
            prepared.identity,
            this.#removeFile,
            cleanupFailureForSignal(options.signal),
          );
        }
      }
    });
  }

  async #writeAndVerifyPartial(options: {
    readonly directory: ResolvedLocalSubtitleOutputDirectory;
    readonly format: LocalSubtitleFormat;
    readonly transcript: LocalSubtitleTranscript;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<PreparedArtifact> {
    let handle: FileHandle | undefined;
    let partialPath: string | undefined;
    let identity: FileObjectIdentity | undefined;
    let partialCreated = false;

    try {
      for (let attempt = 0; attempt < MAX_PARTIAL_CREATE_ATTEMPTS; attempt += 1) {
        throwIfCancelled(options.signal);
        const partialId = this.#createPartialId();
        if (!/^[a-zA-Z0-9-]{1,80}$/u.test(partialId)) {
          throw new LocalSubtitleExporterError(
            "output_write_failed",
            "The subtitle partial identifier is invalid.",
          );
        }
        const leaf = `.fusionkit-local-subtitle-${partialId}.partial`;
        partialPath = resolveSafeLocalSubtitleChildPath(
          options.directory.directoryPath,
          leaf,
        );
        try {
          handle = await open(partialPath, WRITE_EXCLUSIVE_NOFOLLOW, PRIVATE_FILE_MODE);
          partialCreated = true;
          break;
        } catch (error) {
          if (errno(error) === "EEXIST") continue;
          throw outputWriteFailure("The subtitle partial file could not be created.");
        }
      }
      if (!handle || !partialPath) {
        throw outputWriteFailure("A unique subtitle partial file could not be created.");
      }

      const created = await handle.stat();
      identity = fileObjectIdentity(created);
      assertPrivateRegularFile(created, 0);
      await writeExactly(
        handle,
        options.bytes,
        options.signal,
        this.#onPartialWriteChunk,
      );
      const written = await handle.stat();
      assertPrivateRegularFile(written, options.bytes.byteLength);
      if (!sameFileObject(fileObjectIdentity(written), identity)) {
        throw outputWriteFailure("The subtitle partial identity changed while writing.");
      }
      await handle.sync();
      await closeRequired(handle);
      handle = undefined;
      throwIfCancelled(options.signal);

      const actualBytes = await readOwnedPartial(
        partialPath,
        identity,
        options.bytes.byteLength,
      );
      const parsed = parseLocalSubtitleArtifactUtf8(options.format, actualBytes);
      verifyLocalSubtitleArtifactRoundTrip(
        options.format,
        options.transcript,
        parsed,
      );
      throwIfCancelled(options.signal);
      return Object.freeze({
        transactionId: path.basename(partialPath).slice(
          ".fusionkit-local-subtitle-".length,
          -".partial".length,
        ),
        partialPath,
        identity,
        byteSize: actualBytes.byteLength,
        sha256: createHash("sha256").update(actualBytes).digest("hex"),
      });
    } catch (error) {
      const cleanupFailure = cleanupFailureForSignal(
        options.signal,
        error instanceof ExportCancelledError,
      );
      let cleanupError: LocalSubtitleExporterError | undefined;
      if (handle) {
        try {
          await handle.close();
        } catch {
          cleanupError = cleanupFailure(
            "The subtitle partial file could not be closed during cleanup.",
          );
        }
      }
      if (partialCreated) {
        if (!partialPath || !identity) {
          cleanupError ??= cleanupFailure(
            "The subtitle partial file could not be identified for cleanup.",
          );
        } else {
          try {
            await removeOwnedPartial(
              partialPath,
              identity,
              this.#removeFile,
              cleanupFailure,
            );
          } catch (cleanupErrorValue) {
            cleanupError = asCleanupFailure(cleanupErrorValue, cleanupFailure);
          }
        }
      }
      if (cleanupError) throw cleanupError;
      if (error instanceof ExportCancelledError) throw error;
      if (error instanceof LocalSubtitleExporterError) throw error;
      if (error instanceof LocalSubtitleFormatError) {
        throw new LocalSubtitleExporterError(error.code, error.message);
      }
      throw outputWriteFailure("The subtitle partial file could not be written.");
    }
  }

  async #commitWithIndex(options: {
    readonly options: ExportLocalSubtitleArtifactsOptions;
    readonly format: LocalSubtitleFormat;
    readonly initialDirectory: ResolvedLocalSubtitleOutputDirectory;
    readonly prepared: PreparedArtifact;
  }): Promise<CommittedArtifact> {
    for (let index = 0; index < MAX_INDEX_ATTEMPTS; index += 1) {
      throwIfCancelled(options.options.signal);
      const directory = await options.options.resolveOutputDirectory();
      assertSameResolvedDirectory(options.initialDirectory, directory);
      await assertDirectoryIdentity(directory);
      const displayName = artifactDisplayName(
        options.options.outputStem,
        options.format,
        index,
      );
      const finalPath = resolveArtifactPath(directory.directoryPath, displayName);
      if (await pathExists(finalPath)) continue;

      const reserved = this.artifacts.reserve({
        owner: options.options.owner,
        taskId: options.options.taskId,
        generation: options.options.generation,
        format: options.format,
        displayName,
      });
      let activated = false;
      try {
        throwIfCancelled(options.options.signal);
        try {
          await this.#commitIndex(options.prepared.partialPath, finalPath);
        } catch (error) {
          if (errno(error) === "EEXIST") continue;
          throw outputWriteFailure("The indexed subtitle artifact could not be committed.");
        }

        // Removing the temporary hard-link updates the inode ctime. Do it in the
        // same synchronous segment so the registry captures the stable identity.
        const cleanupFailure = cleanupFailureForSignal(options.options.signal);
        try {
          detachOwnedPartialSync(
            options.prepared.partialPath,
            options.prepared.identity,
            this.#removeFileSync,
            cleanupFailure,
          );
        } catch (detachError) {
          try {
            rollbackOwnedIndexSync(
              finalPath,
              options.prepared.identity,
              this.#removeFileSync,
              cleanupFailure,
            );
          } catch {
            throw cleanupFailure(
              "The indexed subtitle artifact could not be rolled back after partial cleanup failed.",
            );
          }
          throw asCleanupFailure(detachError, cleanupFailure);
        }
        // No cancellation check or awaited work may split commit and activation.
        let summary: GeneratedSubtitleArtifactSummary;
        try {
          summary = this.artifacts.activate(reserved.reservation, {
            filePath: finalPath,
            format: options.format,
            displayName,
            sha256: options.prepared.sha256,
            byteSize: options.prepared.byteSize,
            expectedFileIdentity: options.prepared.identity,
            expectedDirectoryIdentity: directory.identity,
          });
        } catch (activationError) {
          try {
            rollbackOwnedIndexSync(
              finalPath,
              options.prepared.identity,
              this.#removeFileSync,
              cleanupFailure,
            );
          } catch (rollbackError) {
            throw asCleanupFailure(rollbackError, cleanupFailure);
          }
          throw activationError;
        }
        activated = true;
        return Object.freeze({ summary, prepared: options.prepared });
      } finally {
        if (!activated) this.artifacts.revokeReservation(reserved.reservation);
      }
    }
    throw new LocalSubtitleExporterError(
      "output_conflict",
      "No indexed subtitle output name is available.",
    );
  }

  async #commitWithOverwrite(options: {
    readonly options: ExportLocalSubtitleArtifactsOptions;
    readonly format: LocalSubtitleFormat;
    readonly initialDirectory: ResolvedLocalSubtitleOutputDirectory;
    readonly prepared: PreparedArtifact;
  }): Promise<CommittedArtifact> {
    throwIfCancelled(options.options.signal);
    const directory = await options.options.resolveOutputDirectory();
    assertSameResolvedDirectory(options.initialDirectory, directory);
    await assertDirectoryIdentity(directory);
    const displayName = artifactDisplayName(
      options.options.outputStem,
      options.format,
      0,
    );
    const finalPath = resolveArtifactPath(directory.directoryPath, displayName);

    if (!this.#overwriteTransaction && !this.#commitOverwrite) {
      throw outputWriteFailure(
        "The native subtitle overwrite transaction is unavailable.",
      );
    }
    if (!this.#overwriteTransaction) {
      await assertOverwriteTarget(finalPath);
    }

    const reserved = this.artifacts.reserve({
      owner: options.options.owner,
      taskId: options.options.taskId,
      generation: options.options.generation,
      format: options.format,
      displayName,
    });
    let activated = false;
    let recoveryTransferred = false;
    try {
      throwIfCancelled(options.options.signal);
      if (this.#overwriteTransaction) {
        return this.#commitWithOverwriteTransaction({
          ...options,
          directory,
          displayName,
          finalPath,
          reserved,
          markActivated: () => {
            activated = true;
          },
          markRecoveryTransferred: () => {
            recoveryTransferred = true;
          },
        });
      }
      try {
        await this.#commitOverwrite!(options.prepared.partialPath, finalPath);
      } catch {
        throw outputWriteFailure("The subtitle artifact could not be atomically replaced.");
      }

      // See the index path above: activation is the first synchronous action
      // after the atomic replace has crossed its irreversible commit point.
      const summary = this.artifacts.activate(reserved.reservation, {
        filePath: finalPath,
        format: options.format,
        displayName,
        sha256: options.prepared.sha256,
        byteSize: options.prepared.byteSize,
        expectedFileIdentity: options.prepared.identity,
        expectedDirectoryIdentity: directory.identity,
      });
      activated = true;
      return Object.freeze({ summary, prepared: options.prepared });
    } finally {
      if (!activated && !recoveryTransferred) {
        this.artifacts.revokeReservation(reserved.reservation);
      }
    }
  }

  #commitWithOverwriteTransaction(options: {
    readonly options: ExportLocalSubtitleArtifactsOptions;
    readonly format: LocalSubtitleFormat;
    readonly initialDirectory: ResolvedLocalSubtitleOutputDirectory;
    readonly directory: ResolvedLocalSubtitleOutputDirectory;
    readonly prepared: PreparedArtifact;
    readonly displayName: string;
    readonly finalPath: string;
    readonly reserved: LocalSubtitleArtifactReservation<TReservation>;
    readonly markActivated: () => void;
    readonly markRecoveryTransferred: () => void;
  }): CommittedArtifact {
    if (path.dirname(options.prepared.partialPath) !== options.directory.directoryPath) {
      throw outputWriteFailure(
        "The subtitle partial is not bound to the overwrite directory.",
      );
    }

    const recoveryOwner = this.#overwriteRecoveryOwner!;
    const recoveryHandoff = recoveryOwner.prepareAdoption({
      recoveryId: options.prepared.transactionId,
      owner: options.options.owner,
      taskId: options.options.taskId,
      generation: options.options.generation,
      format: options.format,
      directoryIdentity: options.directory.identity,
    });
    let receipt: LocalSubtitleOverwriteTransactionReceipt | undefined;
    const transferRecovery = (
      direction: "finalize" | "rollback",
      registry: LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation>,
      markTransferred: () => void,
    ): void => {
      if (!receipt) {
        throw outputWriteFailure(
          "The overwrite recovery handoff has no transaction receipt.",
        );
      }
      let adoptionFailure: unknown;
      try {
        recoveryOwner.adopt({
          handoff: recoveryHandoff,
          recoveryId: options.prepared.transactionId,
          owner: options.options.owner,
          taskId: options.options.taskId,
          generation: options.options.generation,
          format: options.format,
          direction,
          directoryIdentity: options.directory.identity,
          receipt,
          registry,
        });
      } catch (error) {
        adoptionFailure = error;
      }
      if (recoveryOwner.isAdoptionClaimed(recoveryHandoff)) {
        markTransferred();
        return;
      }
      throw adoptionFailure ?? outputWriteFailure(
        "The overwrite recovery owner rejected the transaction handoff.",
      );
    };

    try {
    try {
      receipt = this.#overwriteTransaction!.begin({
        transactionId: options.prepared.transactionId,
        directoryPath: options.directory.directoryPath,
        expectedDirectoryIdentity: options.directory.identity,
        partialLeaf: path.basename(options.prepared.partialPath),
        finalLeaf: options.displayName,
        expectedPartialIdentity: options.prepared.identity,
        expectedByteSize: options.prepared.byteSize,
      });
    } catch {
      throw outputWriteFailure(
        "The native subtitle overwrite transaction could not begin.",
      );
    }

    let summary: GeneratedSubtitleArtifactSummary;
    try {
      summary = this.artifacts.activate(options.reserved.reservation, {
        filePath: options.finalPath,
        format: options.format,
        displayName: options.displayName,
        sha256: options.prepared.sha256,
        byteSize: options.prepared.byteSize,
        expectedFileIdentity: receipt.expectedFinalIdentity,
        expectedDirectoryIdentity: options.directory.identity,
      });
    } catch (activationError) {
      try {
        receipt.rollback();
      } catch {
        transferRecovery(
          "rollback",
          {
            state: "reserved",
            reservation: options.reserved.reservation,
          },
          options.markRecoveryTransferred,
        );
        throw cleanupFailureForSignal(options.options.signal)(
          "The overwritten subtitle target could not be rolled back after artifact activation failed.",
        );
      }
      throw activationError;
    }

    try {
      receipt.finalize();
    } catch {
      if (receipt.state === "finalize_pending") {
        try {
          receipt.finalize();
        } catch {
          transferRecovery(
            "finalize",
            {
              state: "active",
              artifactRef: summary.artifactRef,
            },
            options.markActivated,
          );
          throw cleanupFailureForSignal(options.options.signal)(
            "The overwritten subtitle transaction remains pending after finalization retry failed.",
          );
        }
      } else {
        let registryRevoked = false;
        try {
          registryRevoked = this.artifacts.revokeArtifact(
            options.options.owner,
            summary.artifactRef,
          );
        } catch {
          // Rollback still has to run even if Registry cleanup failed.
        }
        let rolledBack = false;
        try {
          receipt.rollback();
          rolledBack = true;
        } catch {
          // Report one stable cleanup failure after attempting both cleanup phases.
        }
        if (!registryRevoked || !rolledBack) {
          transferRecovery(
            "rollback",
            registryRevoked
              ? { state: "settled" }
              : { state: "active", artifactRef: summary.artifactRef },
            options.markActivated,
          );
          throw cleanupFailureForSignal(options.options.signal)(
            "The overwritten subtitle artifact could not be revoked and rolled back after finalization failed.",
          );
        }
        throw outputWriteFailure(
          "The overwritten subtitle transaction could not be finalized.",
        );
      }
    }

    options.markActivated();
    return Object.freeze({ summary, prepared: options.prepared });
    } finally {
      recoveryOwner.releaseAdoption(recoveryHandoff);
    }
  }
}

async function writeExactly(
  handle: FileHandle,
  bytes: Uint8Array,
  signal?: AbortSignal,
  onChunk?: (writtenBytes: number) => void,
): Promise<void> {
  let position = 0;
  while (position < bytes.byteLength) {
    throwIfCancelled(signal);
    const length = Math.min(WRITE_CHUNK_BYTES, bytes.byteLength - position);
    const result = await handle.write(bytes, position, length, position);
    if (result.bytesWritten <= 0) {
      throw outputWriteFailure("The subtitle partial write stalled.");
    }
    position += result.bytesWritten;
    onChunk?.(position);
  }
}

async function readOwnedPartial(
  partialPath: string,
  expected: FileObjectIdentity,
  expectedSize: number,
): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(partialPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !sameFileObject(fileObjectIdentity(before), expected) ||
      before.size !== expectedSize
    ) {
      throw outputWriteFailure("The subtitle partial identity changed.");
    }
    handle = await open(partialPath, READ_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFileObject(fileObjectIdentity(opened), expected) ||
      opened.size !== expectedSize
    ) {
      throw outputWriteFailure("The subtitle partial identity changed.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== expectedSize ||
      !sameFileObject(fileObjectIdentity(after), expected) ||
      after.size !== expectedSize
    ) {
      throw outputWriteFailure("The subtitle partial bytes changed.");
    }
    await closeRequired(handle);
    handle = undefined;
    return bytes;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function closeRequired(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw outputWriteFailure("The subtitle partial file could not be closed.");
  }
}

async function removeOwnedPartial(
  partialPath: string,
  expected: FileObjectIdentity,
  removeFile: (filePath: string) => Promise<void>,
  cleanupFailure: (message: string) => LocalSubtitleExporterError,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(partialPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw cleanupFailure(
      "The subtitle partial file could not be inspected during cleanup.",
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileObject(fileObjectIdentity(current), expected)
  ) {
    throw cleanupFailure(
      "The subtitle partial identity changed before cleanup.",
    );
  }
  try {
    await removeFile(partialPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw cleanupFailure(
      "The subtitle partial file could not be removed.",
    );
  }
}

function detachOwnedPartialSync(
  partialPath: string,
  expected: FileObjectIdentity,
  removeFileSync: (filePath: string) => void,
  cleanupFailure: (message: string) => LocalSubtitleExporterError,
): void {
  let current: Stats;
  try {
    current = lstatSync(partialPath);
  } catch {
    throw cleanupFailure(
      "The indexed subtitle partial could not be inspected before detach.",
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileObject(fileObjectIdentity(current), expected)
  ) {
    throw cleanupFailure(
      "The indexed subtitle partial identity changed before detach.",
    );
  }
  try {
    removeFileSync(partialPath);
  } catch {
    throw cleanupFailure(
      "The indexed subtitle partial could not be detached.",
    );
  }
}

function rollbackOwnedIndexSync(
  finalPath: string,
  expected: FileObjectIdentity,
  removeFileSync: (filePath: string) => void,
  cleanupFailure: (message: string) => LocalSubtitleExporterError,
): void {
  let current: Stats;
  try {
    current = lstatSync(finalPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw cleanupFailure(
      "The indexed subtitle artifact could not be inspected for rollback.",
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileObject(fileObjectIdentity(current), expected)
  ) {
    throw cleanupFailure(
      "The indexed subtitle artifact identity changed before rollback.",
    );
  }
  try {
    removeFileSync(finalPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw cleanupFailure(
      "The indexed subtitle artifact could not be rolled back.",
    );
  }
}

async function assertOverwriteTarget(finalPath: string): Promise<void> {
  try {
    const current = await lstat(finalPath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw outputWriteFailure("The overwrite target is not a safe regular file.");
    }
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    if (error instanceof LocalSubtitleExporterError) throw error;
    throw outputWriteFailure("The overwrite target could not be inspected.");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw outputWriteFailure("The indexed subtitle target could not be inspected.");
  }
}

async function assertDirectoryIdentity(
  directory: ResolvedLocalSubtitleOutputDirectory,
): Promise<void> {
  try {
    const current = await lstat(directory.directoryPath);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(directoryIdentity(current), directory.identity)
    ) {
      throw new Error();
    }
  } catch {
    throw outputWriteFailure("The authorized subtitle output directory changed.");
  }
}

function assertResolvedDirectory(
  value: ResolvedLocalSubtitleOutputDirectory,
): void {
  if (
    !path.isAbsolute(value.directoryPath) ||
    !value.directoryName ||
    !Number.isFinite(value.expiresAt) ||
    !validDirectoryIdentity(value.identity)
  ) {
    throw outputWriteFailure("The resolved subtitle output directory is invalid.");
  }
}

function assertSameResolvedDirectory(
  expected: ResolvedLocalSubtitleOutputDirectory,
  actual: ResolvedLocalSubtitleOutputDirectory,
): void {
  assertResolvedDirectory(actual);
  if (
    actual.directoryPath !== expected.directoryPath ||
    !sameDirectoryIdentity(actual.identity, expected.identity)
  ) {
    throw outputWriteFailure("The resolved subtitle output directory changed.");
  }
}

function artifactDisplayName(
  stem: string,
  format: LocalSubtitleFormat,
  index: number,
): string {
  const suffix = index === 0 ? "" : ` (${index})`;
  return `${stem}${suffix}.${ARTIFACT_EXTENSIONS[format]}`;
}

function resolveArtifactPath(directoryPath: string, displayName: string): string {
  if (
    displayName.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
    Buffer.byteLength(displayName, "utf8") > 255
  ) {
    throw outputWriteFailure("The subtitle output name is too long.");
  }
  return resolveSafeLocalSubtitleChildPath(directoryPath, displayName);
}

function assertExportOptions(options: ExportLocalSubtitleArtifactsOptions): void {
  const uniqueFormats = new Set(options.formats);
  const validStem =
    options.outputStem.length > 0 &&
    options.outputStem.length <= LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars &&
    options.outputStem.trim() === options.outputStem &&
    options.outputStem !== "." &&
    options.outputStem !== ".." &&
    !/[\\/:\u0000-\u001f\u007f]/u.test(options.outputStem);
  if (
    !options.taskId ||
    options.taskId.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !Number.isSafeInteger(options.generation) ||
    options.generation <= 0 ||
    options.formats.length === 0 ||
    uniqueFormats.size !== options.formats.length ||
    options.formats.some(
      (format) => !(LOCAL_SUBTITLE_FORMATS as readonly string[]).includes(format),
    ) ||
    !(LOCAL_SUBTITLE_CONFLICT_POLICIES as readonly string[]).includes(
      options.conflictPolicy,
    ) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(options.taskId) ||
    options.taskId === "." ||
    options.taskId === ".." ||
    !validStem
  ) {
    throw new LocalSubtitleExporterError(
      "invalid_content",
      "Subtitle export options are invalid.",
    );
  }
}

function assertPrivateRegularFile(stat: Stats, expectedSize: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== expectedSize ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_FILE_MODE)
  ) {
    throw outputWriteFailure("The subtitle partial file identity is invalid.");
  }
}

function fileObjectIdentity(value: Stats): FileObjectIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  });
}

function sameFileObject(
  left: FileObjectIdentity,
  right: FileObjectIdentity,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

function directoryIdentity(value: Stats): LocalSubtitleDirectoryIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  });
}

function validDirectoryIdentity(value: LocalSubtitleDirectoryIdentity): boolean {
  return Number.isFinite(value.dev) &&
    Number.isFinite(value.ino) &&
    Number.isFinite(value.birthtimeMs);
}

function sameDirectoryIdentity(
  left: LocalSubtitleDirectoryIdentity,
  right: LocalSubtitleDirectoryIdentity,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

function skippedResult(
  format: LocalSubtitleFormat,
  afterCommit: boolean,
): LocalSubtitleArtifactResult {
  return Object.freeze(
    afterCommit
      ? {
          format,
          status: "skipped" as const,
          errorCode: "cancelled_after_partial_commit" as const,
        }
      : { format, status: "skipped" as const },
  );
}

class ExportCancelledError extends Error {
  readonly name = "ExportCancelledError";
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError("Subtitle export cancelled.");
}

function errorCode(error: unknown): LocalSubtitleErrorCode {
  if (error instanceof LocalSubtitleExporterError) return error.code;
  if (error instanceof LocalSubtitleFormatError) return error.code;
  if (error && typeof error === "object") {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && ERROR_CODES.has(code)) {
      return code as LocalSubtitleErrorCode;
    }
    const localSubtitleCode = Reflect.get(error, "localSubtitleCode");
    if (
      typeof localSubtitleCode === "string" &&
      ERROR_CODES.has(localSubtitleCode)
    ) {
      return localSubtitleCode as LocalSubtitleErrorCode;
    }
  }
  return "output_write_failed";
}

function errno(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function outputWriteFailure(message: string): LocalSubtitleExporterError {
  return new LocalSubtitleExporterError("output_write_failed", message);
}

function cancellationCleanupFailure(message: string): LocalSubtitleExporterError {
  return new LocalSubtitleExporterError("cancel_failed", message);
}

function cleanupFailure(message: string): LocalSubtitleExporterError {
  return new LocalSubtitleExporterError("cleanup_failed", message);
}

function cleanupFailureForSignal(
  signal?: AbortSignal,
  cancellationAlreadyRequested = false,
): (message: string) => LocalSubtitleExporterError {
  return (message) =>
    cancellationAlreadyRequested || signal?.aborted
      ? cancellationCleanupFailure(message)
      : cleanupFailure(message);
}

function asCleanupFailure(
  error: unknown,
  cleanupFailure: (message: string) => LocalSubtitleExporterError,
): LocalSubtitleExporterError {
  return error instanceof LocalSubtitleExporterError
    ? error
    : cleanupFailure("The subtitle partial cleanup failed.");
}
