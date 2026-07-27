import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isProxy } from "node:util/types";
import type { LocalSubtitleFormat } from "@/type/localSubtitle";
import type {
  LocalSubtitleOwnerKey,
  ResolvedLocalSubtitleOutputDirectory,
} from "./authorizations";
import type {
  LocalSubtitleMainRuntimeShutdownReason,
  LocalSubtitleMainRuntimeTarget,
} from "./main-runtime";
import {
  fenceLocalSubtitleOverwriteDirectory,
  localSubtitleOverwriteDirectoryKey,
  releaseLocalSubtitleOverwriteDirectoryFence,
  sameLocalSubtitleOverwriteDirectoryIdentity,
  snapshotLocalSubtitleOverwriteDirectoryIdentity,
  withLocalSubtitleOverwriteDirectory,
} from "./overwrite-directory-coordinator";
import {
  isLocalSubtitleOverwriteTransactionReceipt,
  type LocalSubtitleOverwriteDirectoryIdentity,
  type LocalSubtitleOverwriteTransactionReceipt,
} from "./overwrite-transaction";

const RECOVERY_RECORD_SCHEMA_VERSION = 2 as const;
const RECOVERY_FILE_SCHEMA_VERSION = 2 as const;
const MAX_RECOVERY_FILE_BYTES = 1024 * 1024;
const RECOVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/u;
const OWNER_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const authorityInstances = new WeakSet<object>();
const claimedAuthorities = new WeakSet<object>();
const ownerInstances = new WeakSet<object>();
const claimedRecoveryReceipts = new WeakSet<object>();

export type LocalSubtitleOverwriteRecoveryDirection = "finalize" | "rollback";
export type LocalSubtitleOverwriteRecoveryDecision =
  | "finalize_committed"
  | "rollback_unpublished";
export type LocalSubtitleOverwriteRecoveryNativeState =
  | "not_started"
  | "pending"
  | "settled"
  | "retry_failed";

export interface LocalSubtitleOverwriteRecoveryRequest {
  readonly transactionId: string;
  readonly directoryPath: string;
  readonly expectedDirectoryIdentity: LocalSubtitleOverwriteDirectoryIdentity;
  readonly decision: LocalSubtitleOverwriteRecoveryDirection;
}

export type LocalSubtitleOverwriteRecoveryResult = Readonly<{
  state: "finalized" | "rolled_back" | "not_found";
}>;

export interface LocalSubtitleOverwriteRecoveryBackend {
  recover(request: LocalSubtitleOverwriteRecoveryRequest): unknown;
  acknowledge(request: LocalSubtitleOverwriteRecoveryRequest): unknown;
}

export type LocalSubtitleOverwriteAcknowledgementResult = Readonly<{
  state: "acknowledged" | "not_found";
}>;

export interface LocalSubtitleOverwriteRecoveryRecord {
  readonly schemaVersion: typeof RECOVERY_RECORD_SCHEMA_VERSION;
  readonly recoveryId: string;
  readonly ownerFingerprint: string;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly decision: LocalSubtitleOverwriteRecoveryDecision;
  readonly nativeState: LocalSubtitleOverwriteRecoveryNativeState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalSubtitleOverwriteRecoverySummary {
  readonly recoveryId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly direction: LocalSubtitleOverwriteRecoveryDirection;
  readonly state: LocalSubtitleOverwriteRecoveryNativeState;
  readonly createdAt: number;
  readonly requiresDirectorySelection: boolean;
}

export interface LocalSubtitleOverwriteRecoveryRepository {
  load(): readonly LocalSubtitleOverwriteRecoveryRecord[];
  replace(records: readonly LocalSubtitleOverwriteRecoveryRecord[]): void;
}

export interface LocalSubtitleOverwriteRecoveryFileRepositoryOptions {
  readonly syncParentDirectory?: (directoryPath: string) => void;
}

export interface LocalSubtitleOverwriteRecoveryRegistry<TReservation> {
  revokeReservation(reservation: TReservation): boolean;
  revokeArtifact(owner: LocalSubtitleOwnerKey, artifactRef: string): boolean;
}

export type LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation> =
  | { readonly state: "active"; readonly artifactRef: string }
  | { readonly state: "reserved"; readonly reservation: TReservation }
  | { readonly state: "settled" };

export interface AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation> {
  readonly handoff: LocalSubtitleOverwriteRecoveryHandoff;
  readonly recoveryId: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly direction: LocalSubtitleOverwriteRecoveryDirection;
  readonly directoryIdentity: LocalSubtitleOverwriteDirectoryIdentity;
  readonly receipt: LocalSubtitleOverwriteTransactionReceipt;
  readonly registry: LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation>;
}

export interface PrepareLocalSubtitleOverwriteRecoveryOptions {
  readonly recoveryId: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly directoryIdentity: LocalSubtitleOverwriteDirectoryIdentity;
}

export interface LocalSubtitleOverwriteRecoveryHandoff {
  readonly recoveryId: string;
}

export interface RecoverLocalSubtitleOverwriteAfterReauthorizationOptions {
  readonly recoveryId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly directory: ResolvedLocalSubtitleOutputDirectory;
}

export type LocalSubtitleOverwriteRecoveryErrorCode =
  | "invalid_authority"
  | "invalid_record"
  | "invalid_request"
  | "invalid_result"
  | "invalid_state"
  | "persistence_failed"
  | "recovery_pending";

export class LocalSubtitleOverwriteRecoveryError extends Error {
  readonly name = "LocalSubtitleOverwriteRecoveryError";

  constructor(
    readonly code: LocalSubtitleOverwriteRecoveryErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export class LocalSubtitleOverwriteRecoveryAuthority {
  readonly #recoverBackend: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => unknown;
  readonly #acknowledgeBackend: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => unknown;

  constructor(backend: LocalSubtitleOverwriteRecoveryBackend) {
    if (
      (typeof backend !== "object" && typeof backend !== "function") ||
      backend === null ||
      isProxy(backend)
    ) {
      throw failure("invalid_authority", "A synchronous overwrite recovery backend is required.");
    }
    const recover = Reflect.get(backend, "recover");
    const acknowledge = Reflect.get(backend, "acknowledge");
    if (typeof recover !== "function" || typeof acknowledge !== "function") {
      throw failure("invalid_authority", "A synchronous overwrite recovery backend is required.");
    }
    this.#recoverBackend = (request) => recover.call(backend, request);
    this.#acknowledgeBackend = (request) => acknowledge.call(backend, request);
    authorityInstances.add(this);
    Object.freeze(this);
  }

  claim(): Readonly<{
    recover(request: LocalSubtitleOverwriteRecoveryRequest): LocalSubtitleOverwriteRecoveryResult;
    acknowledge(request: LocalSubtitleOverwriteRecoveryRequest): LocalSubtitleOverwriteAcknowledgementResult;
  }> {
    if (
      !authorityInstances.has(this) ||
      Object.getPrototypeOf(this) !== LocalSubtitleOverwriteRecoveryAuthority.prototype ||
      claimedAuthorities.has(this)
    ) {
      throw failure("invalid_authority", "The overwrite recovery authority is unavailable.");
    }
    claimedAuthorities.add(this);
    const invoke = <T>(
      operation: (request: LocalSubtitleOverwriteRecoveryRequest) => unknown,
      request: LocalSubtitleOverwriteRecoveryRequest,
      validate: (input: unknown) => T,
      label: string,
    ): T => {
      const snapshot = snapshotRecoveryRequest(request);
      const rawResult = operation(snapshot);
      if (isThenable(rawResult)) {
        void Promise.resolve(rawResult).catch(() => undefined);
        throw failure("invalid_result", `Overwrite ${label} must be synchronous.`);
      }
      return validate(rawResult);
    };
    return Object.freeze({
      recover: (request: LocalSubtitleOverwriteRecoveryRequest) =>
        invoke(this.#recoverBackend, request, validateRecoveryResult, "recovery"),
      acknowledge: (request: LocalSubtitleOverwriteRecoveryRequest) =>
        invoke(
          this.#acknowledgeBackend,
          request,
          validateAcknowledgementResult,
          "recovery acknowledgement",
        ),
    });
  }
}

Object.freeze(LocalSubtitleOverwriteRecoveryAuthority.prototype);

export function createLocalSubtitleOverwriteRecoveryAuthority(
  backend: LocalSubtitleOverwriteRecoveryBackend,
): LocalSubtitleOverwriteRecoveryAuthority {
  return new LocalSubtitleOverwriteRecoveryAuthority(backend);
}

export function isLocalSubtitleOverwriteRecoveryOwner(
  value: unknown,
): value is LocalSubtitleOverwriteRecoveryOwner<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    ownerInstances.has(value) &&
    Object.getPrototypeOf(value) === LocalSubtitleOverwriteRecoveryOwner.prototype
  );
}

export class LocalSubtitleOverwriteRecoveryFileRepository
  implements LocalSubtitleOverwriteRecoveryRepository
{
  readonly #syncParentDirectory: (directoryPath: string) => void;

  constructor(
    private readonly filePath: string,
    options: LocalSubtitleOverwriteRecoveryFileRepositoryOptions = {},
  ) {
    if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
      throw new TypeError("The overwrite recovery repository path must be absolute.");
    }
    this.#syncParentDirectory = options.syncParentDirectory ?? syncParentDirectory;
  }

  load(): readonly LocalSubtitleOverwriteRecoveryRecord[] {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.filePath);
    } catch (error) {
      if (errno(error) === "ENOENT") return Object.freeze([]);
      throw persistenceFailure("The overwrite recovery repository could not be read.", error);
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECOVERY_FILE_BYTES) {
      throw failure("invalid_record", "The overwrite recovery repository is invalid.");
    }
    try {
      return parseRecoveryFile(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof LocalSubtitleOverwriteRecoveryError) throw error;
      throw failure("invalid_record", "The overwrite recovery repository is invalid.", error);
    }
  }

  replace(records: readonly LocalSubtitleOverwriteRecoveryRecord[]): void {
    const validated = Object.freeze(records.map(validatePersistedRecord));
    const payload = serializeRecoveryFile(validated);
    const parent = path.dirname(this.filePath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    let handle: number | undefined;
    let renamed = false;
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      handle = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      writeFileSync(handle, payload, { encoding: "utf8" });
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(temporary, this.filePath);
      renamed = true;
      this.#syncParentDirectory(parent);
    } catch (error) {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          // Preserve the primary persistence failure.
        }
      }
      if (!renamed) {
        try {
          unlinkSync(temporary);
        } catch {
          // Ignore an absent temporary path.
        }
      } else {
        try {
          if (readFileSync(this.filePath, "utf8") === payload) return;
        } catch {
          // Preserve the post-rename persistence failure when read-back is unknown.
        }
      }
      throw persistenceFailure("The overwrite recovery repository could not be updated.", error);
    }
  }
}

function syncParentDirectory(directoryPath: string): void {
  const directoryHandle = openSync(directoryPath, fsConstants.O_RDONLY);
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

interface VolatileRecovery<TReservation> {
  readonly owner: LocalSubtitleOwnerKey;
  readonly receipt: LocalSubtitleOverwriteTransactionReceipt;
  registry: LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation>;
}

interface OwnedRecovery<TReservation> {
  record: LocalSubtitleOverwriteRecoveryRecord;
  volatile?: VolatileRecovery<TReservation>;
  persistenceUncertain?: boolean;
  readonly directoryKeys: Set<string>;
}

interface PreparedRecoveryHandoff {
  readonly recoveryId: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerFingerprint: string;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly directoryIdentity: LocalSubtitleOverwriteDirectoryIdentity;
  readonly directoryKey: string;
  readonly createdAt: number;
  status: "prepared" | "begin_started" | "claimed" | "discarded";
}

export class LocalSubtitleOverwriteRecoveryOwner<TReservation>
  implements LocalSubtitleMainRuntimeTarget
{
  readonly #entries = new Map<string, OwnedRecovery<TReservation>>();
  readonly #releasedOwners = new Set<string>();
  readonly #handoffs = new WeakMap<
    LocalSubtitleOverwriteRecoveryHandoff,
    PreparedRecoveryHandoff
  >();
  readonly #pendingHandoffIds = new Map<
    string,
    LocalSubtitleOverwriteRecoveryHandoff
  >();
  readonly #recoveryTails = new Map<string, Promise<void>>();
  readonly #recover: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => LocalSubtitleOverwriteRecoveryResult;
  readonly #acknowledge: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => LocalSubtitleOverwriteAcknowledgementResult;
  readonly #now: () => number;
  #shutdownOperation: Promise<void> | undefined;
  #shutdownStarted = false;

  constructor(
    private readonly repository: LocalSubtitleOverwriteRecoveryRepository,
    private readonly artifacts: LocalSubtitleOverwriteRecoveryRegistry<TReservation>,
    authority: LocalSubtitleOverwriteRecoveryAuthority,
    options: { readonly now?: () => number } = {},
  ) {
    if (!isRepository(repository) || !isRecoveryRegistry(artifacts)) {
      throw new TypeError("The overwrite recovery owner dependencies are invalid.");
    }
    if (
      !authorityInstances.has(authority) ||
      Object.getPrototypeOf(authority) !== LocalSubtitleOverwriteRecoveryAuthority.prototype
    ) {
      throw failure("invalid_authority", "A validated overwrite recovery authority is required.");
    }
    const claimedAuthority = authority.claim();
    this.#recover = claimedAuthority.recover;
    this.#acknowledge = claimedAuthority.acknowledge;
    this.#now = options.now ?? Date.now;
    for (const record of repository.load()) {
      const validated = validatePersistedRecord(record);
      if (this.#entries.has(validated.recoveryId)) {
        throw failure("invalid_record", "The overwrite recovery repository contains duplicates.");
      }
      this.#entries.set(validated.recoveryId, {
        record: validated,
        directoryKeys: new Set(),
      });
    }
    ownerInstances.add(this);
  }

  listPending(): readonly LocalSubtitleOverwriteRecoverySummary[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map(({ record, volatile }) => Object.freeze({
          recoveryId: record.recoveryId,
          taskId: record.taskId,
          generation: record.generation,
          format: record.format,
          direction: directionForDecision(record.decision),
          state: record.nativeState,
          createdAt: record.createdAt,
          requiresDirectorySelection: volatile === undefined,
        }))
        .sort((left, right) =>
          left.createdAt - right.createdAt ||
          left.recoveryId.localeCompare(right.recoveryId)
        ),
    );
  }

  prepareAdoption(
    options: PrepareLocalSubtitleOverwriteRecoveryOptions,
  ): LocalSubtitleOverwriteRecoveryHandoff {
    const directoryIdentity = assertAdoptionMetadata(options);
    if (
      this.#entries.has(options.recoveryId) ||
      this.#pendingHandoffIds.has(options.recoveryId)
    ) {
      throw failure("invalid_state", "The overwrite recovery identifier is already owned.");
    }
    const createdAt = requireTimestamp(this.#now(), "createdAt");
    const directoryKey = localSubtitleOverwriteDirectoryKey(directoryIdentity);
    const handoff = Object.freeze({
      recoveryId: options.recoveryId,
    }) satisfies LocalSubtitleOverwriteRecoveryHandoff;
    const prepared: PreparedRecoveryHandoff = {
      recoveryId: options.recoveryId,
      owner: Object.freeze({ ...options.owner }),
      ownerFingerprint: ownerFingerprint(options.owner),
      taskId: options.taskId,
      generation: options.generation,
      format: options.format,
      directoryIdentity,
      directoryKey,
      createdAt,
      status: "prepared",
    };
    const record = validatePersistedRecord({
      schemaVersion: RECOVERY_RECORD_SCHEMA_VERSION,
      recoveryId: prepared.recoveryId,
      ownerFingerprint: prepared.ownerFingerprint,
      taskId: prepared.taskId,
      generation: prepared.generation,
      format: prepared.format,
      decision: "rollback_unpublished",
      nativeState: "not_started",
      createdAt: prepared.createdAt,
      updatedAt: prepared.createdAt,
    });
    fenceLocalSubtitleOverwriteDirectory(directoryKey, record.recoveryId);
    this.#entries.set(record.recoveryId, {
      record,
      directoryKeys: new Set([directoryKey]),
    });
    try {
      this.#persist();
    } catch (error) {
      const entry = this.#entries.get(record.recoveryId);
      if (entry) entry.persistenceUncertain = true;
      throw error;
    }
    this.#handoffs.set(handoff, prepared);
    this.#pendingHandoffIds.set(options.recoveryId, handoff);
    return handoff;
  }

  markBeginStarted(handoff: LocalSubtitleOverwriteRecoveryHandoff): void {
    const prepared = this.#handoffs.get(handoff);
    if (
      !prepared ||
      prepared.status !== "prepared" ||
      this.#pendingHandoffIds.get(prepared.recoveryId) !== handoff
    ) {
      throw failure("invalid_state", "The overwrite recovery handoff is unavailable.");
    }
    prepared.status = "begin_started";
  }

  releaseAdoption(handoff: LocalSubtitleOverwriteRecoveryHandoff): void {
    const prepared = this.#handoffs.get(handoff);
    if (
      !prepared ||
      (prepared.status !== "prepared" && prepared.status !== "begin_started")
    ) return;
    if (prepared.status === "prepared") {
      const entry = this.#entries.get(prepared.recoveryId);
      if (entry) this.#complete(prepared.recoveryId, entry);
    }
    if (this.#pendingHandoffIds.get(prepared.recoveryId) === handoff) {
      this.#pendingHandoffIds.delete(prepared.recoveryId);
    }
    prepared.status = "discarded";
  }

  adopt(options: AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation>): void {
    this.#adoptPrepared(options.handoff, options);
  }

  commitActivated(
    handoff: LocalSubtitleOverwriteRecoveryHandoff,
    artifactRef: string,
  ): void {
    const prepared = this.#handoffs.get(handoff);
    if (!prepared || prepared.status !== "claimed" || !isId(artifactRef)) {
      throw failure("invalid_state", "The overwrite recovery handoff is unavailable.");
    }
    const entry = this.#requireEntry(prepared.recoveryId);
    if (!entry.volatile) {
      throw failure("invalid_state", "The overwrite recovery decision is unavailable.");
    }
    if (entry.record.decision === "rollback_unpublished") {
      entry.volatile.registry = Object.freeze({ state: "active", artifactRef });
      entry.record = validatePersistedRecord({
        ...entry.record,
        decision: "finalize_committed",
        nativeState: "pending",
        updatedAt: requireTimestamp(this.#now(), "updatedAt"),
      });
    } else if (
      !entry.persistenceUncertain ||
      entry.volatile.registry.state !== "active" ||
      entry.volatile.registry.artifactRef !== artifactRef
    ) {
      throw failure("invalid_state", "The overwrite recovery decision is unavailable.");
    }
    try {
      this.#persist();
      entry.persistenceUncertain = false;
    } catch (error) {
      entry.persistenceUncertain = true;
      throw error;
    }
  }

  settleAdoption(handoff: LocalSubtitleOverwriteRecoveryHandoff): void {
    const prepared = this.#handoffs.get(handoff);
    if (!prepared || prepared.status !== "claimed") {
      throw failure("invalid_state", "The overwrite recovery handoff is unavailable.");
    }
    const entry = this.#requireEntry(prepared.recoveryId);
    this.#settleVolatile(prepared.recoveryId, entry);
  }

  #adoptPrepared(
    handoff: LocalSubtitleOverwriteRecoveryHandoff,
    options: AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation>,
  ): void {
    const prepared = this.#handoffs.get(handoff);
    const directoryIdentity = assertAdoptionMetadata(options);
    const registry = assertAdoptionTerminal(options);
    if (
      !prepared ||
      prepared.status !== "begin_started" ||
      this.#pendingHandoffIds.get(prepared.recoveryId) !== handoff ||
      !sameAdoptionMetadata(prepared, options, directoryIdentity)
    ) {
      throw failure("invalid_state", "The overwrite recovery handoff is unavailable.");
    }
    if (claimedRecoveryReceipts.has(options.receipt)) {
      throw failure("invalid_state", "The overwrite transaction receipt is already owned.");
    }
    const entry = this.#entries.get(prepared.recoveryId);
    if (!entry || entry.volatile) {
      throw failure("invalid_state", "The overwrite recovery preclaim is unavailable.");
    }
    const decision = decisionForDirection(options.direction);
    entry.record = validatePersistedRecord({
      ...entry.record,
      decision,
      nativeState: "pending",
      updatedAt: requireTimestamp(this.#now(), "updatedAt"),
    });
    entry.volatile = {
      owner: prepared.owner,
      receipt: options.receipt,
      registry,
    };
    this.#pendingHandoffIds.delete(entry.record.recoveryId);
    prepared.status = "claimed";
    claimedRecoveryReceipts.add(options.receipt);

    let firstFailure: unknown;
    if (decision !== "rollback_unpublished") {
      try {
        this.#persist();
      } catch (error) {
        entry.persistenceUncertain = true;
        firstFailure = error;
      }
    }

    if (
      this.#releasedOwners.has(entry.record.ownerFingerprint) ||
      this.#shutdownStarted
    ) {
      try {
        this.#settleVolatile(entry.record.recoveryId, entry);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  retry(recoveryId: string): void {
    const entry = this.#requireEntry(recoveryId);
    if (!entry.volatile) {
      throw failure(
        "recovery_pending",
        "The overwrite recovery requires output directory reauthorization.",
      );
    }
    this.#settleVolatile(recoveryId, entry);
  }

  async recoverAfterReauthorization(
    options: RecoverLocalSubtitleOverwriteAfterReauthorizationOptions,
  ): Promise<LocalSubtitleOverwriteRecoveryResult> {
    const selection = assertRecoverySelection(options);
    return this.#withRecovery(selection.recoveryId, () => {
      const entry = this.#requireEntry(selection.recoveryId);
      if (entry.volatile) {
        throw failure("invalid_state", "The overwrite recovery still has an in-process receipt.");
      }
      if (
        entry.record.taskId !== selection.taskId ||
        entry.record.generation !== selection.generation ||
        entry.record.format !== selection.format
      ) {
        throw failure("invalid_request", "The overwrite recovery metadata does not match.");
      }
      const key = localSubtitleOverwriteDirectoryKey(selection.directory.identity);
      fenceLocalSubtitleOverwriteDirectory(key, entry.record.recoveryId);
      entry.directoryKeys.add(key);
      return withLocalSubtitleOverwriteDirectory(
        key,
        () => {
          const request = {
            transactionId: entry.record.recoveryId,
            directoryPath: selection.directory.directoryPath,
            expectedDirectoryIdentity: selection.directory.identity,
            decision: directionForDecision(entry.record.decision),
          } as const;
          if (entry.record.nativeState === "settled") {
            if (entry.persistenceUncertain) {
              this.#persist();
              entry.persistenceUncertain = false;
            }
            this.#acknowledge(request);
            this.#complete(entry.record.recoveryId, entry);
            return Object.freeze({ state: terminalResultForDecision(entry.record.decision) });
          }

          let result: LocalSubtitleOverwriteRecoveryResult;
          try {
            result = this.#recover(request);
          } catch (error) {
            if (entry.record.nativeState !== "not_started") {
              entry.record = this.#updatedRecord(entry.record, "retry_failed");
              this.#persist();
            }
            throw error;
          }

          if (result.state === "not_found") {
            if (entry.record.nativeState !== "not_started") {
              entry.record = this.#updatedRecord(entry.record, "retry_failed");
              this.#persist();
              throw failure("recovery_pending", "The overwrite recovery terminal marker is missing.");
            }
            this.#complete(entry.record.recoveryId, entry);
            return Object.freeze({ state: "rolled_back" as const });
          }
          if (result.state !== terminalResultForDecision(entry.record.decision)) {
            throw failure("invalid_result", "The overwrite recovery result conflicts with its durable decision.");
          }
          entry.record = this.#updatedRecord(entry.record, "settled");
          try {
            this.#persist();
            entry.persistenceUncertain = false;
          } catch (error) {
            entry.persistenceUncertain = true;
            throw error;
          }
          const acknowledgement = this.#acknowledge(request);
          if (acknowledgement.state !== "acknowledged" && acknowledgement.state !== "not_found") {
            throw failure("invalid_result", "The overwrite recovery acknowledgement is invalid.");
          }
          this.#complete(entry.record.recoveryId, entry);
          return result;
        },
        { recoveryId: entry.record.recoveryId },
      );
    });
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    const fingerprint = ownerFingerprint(owner);
    this.#releasedOwners.add(fingerprint);
    let firstFailure: unknown;
    for (const [recoveryId, entry] of [...this.#entries]) {
      if (entry.record.ownerFingerprint !== fingerprint) continue;
      try {
        if (entry.volatile) this.#settleVolatile(recoveryId, entry);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  shutdown(_reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#shutdownStarted = true;
    const operation = Promise.resolve().then(() => {
      let firstFailure: unknown;
      for (const [recoveryId, entry] of [...this.#entries]) {
        try {
          if (entry.volatile) this.#settleVolatile(recoveryId, entry);
        } catch (error) {
          firstFailure ??= error;
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
      if (this.#entries.size > 0) {
        throw failure(
          "recovery_pending",
          "Overwrite recovery remains pending and requires reauthorization.",
        );
      }
    });
    this.#shutdownOperation = operation;
    void operation.then(() => {
      if (this.#shutdownOperation === operation) this.#shutdownOperation = undefined;
    }, () => {
      if (this.#shutdownOperation === operation) this.#shutdownOperation = undefined;
    });
    return operation;
  }

  #settleVolatile(
    recoveryId: string,
    entry: OwnedRecovery<TReservation>,
  ): void {
    const volatile = entry.volatile;
    if (!volatile) {
      throw failure("recovery_pending", "The overwrite recovery requires reauthorization.");
    }
    let firstFailure: unknown;

    if (entry.persistenceUncertain) {
      try {
        this.#persist();
        entry.persistenceUncertain = false;
      } catch (error) {
        throw error;
      }
    }

    const direction = directionForDecision(entry.record.decision);
    const terminalState = direction === "finalize"
      ? "finalized"
      : "rolled_back";
    const pendingAckState = direction === "finalize"
      ? "finalize_pending_ack"
      : "rollback_pending_ack";
    if (
      volatile.receipt.state !== terminalState &&
      volatile.receipt.state !== pendingAckState
    ) {
      try {
        if (direction === "finalize") volatile.receipt.finalize();
        else volatile.receipt.rollback();
      } catch (error) {
        firstFailure = error;
      }
    }

    const nativeConverged = volatile.receipt.state === pendingAckState ||
      volatile.receipt.state === terminalState;
    if (nativeConverged && entry.record.nativeState !== "settled") {
      try {
        entry.record = this.#updatedRecord(entry.record, "settled");
        this.#persist();
        entry.persistenceUncertain = false;
      } catch (error) {
        entry.persistenceUncertain = true;
        firstFailure ??= error;
      }
    }

    if (
      entry.record.nativeState === "settled" &&
      !entry.persistenceUncertain &&
      volatile.receipt.state === pendingAckState
    ) {
      try {
        volatile.receipt.acknowledge();
      } catch (error) {
        firstFailure ??= error;
      }
    }

    if (direction === "rollback" && volatile.registry.state !== "settled") {
      try {
        if (volatile.registry.state === "active") {
          this.artifacts.revokeArtifact(
            volatile.owner,
            volatile.registry.artifactRef,
          );
        } else {
          this.artifacts.revokeReservation(volatile.registry.reservation);
        }
        volatile.registry = { state: "settled" };
      } catch (error) {
        firstFailure ??= error;
      }
    }

    const nativeSettled = volatile.receipt.state === terminalState;
    const registrySettled = direction === "finalize" ||
      volatile.registry.state === "settled";
    if (nativeSettled && registrySettled) {
      this.#complete(recoveryId, entry);
      return;
    }

    if (entry.record.nativeState !== "settled") {
      try {
        entry.record = this.#updatedRecord(entry.record, "retry_failed");
        this.#persist();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    throw firstFailure ?? failure(
      "recovery_pending",
      "The overwrite recovery remains pending.",
    );
  }

  #complete(recoveryId: string, entry: OwnedRecovery<TReservation>): void {
    const previous = this.#entries.get(recoveryId);
    this.#entries.delete(recoveryId);
    try {
      this.#persist();
    } catch (error) {
      if (previous) this.#entries.set(recoveryId, previous);
      throw error;
    }
    for (const directoryKey of entry.directoryKeys) {
      releaseLocalSubtitleOverwriteDirectoryFence(directoryKey, recoveryId);
    }
    entry.directoryKeys.clear();
  }

  #updatedRecord(
    record: LocalSubtitleOverwriteRecoveryRecord,
    nativeState: LocalSubtitleOverwriteRecoveryNativeState,
  ): LocalSubtitleOverwriteRecoveryRecord {
    return validatePersistedRecord({
      ...record,
      nativeState,
      updatedAt: requireTimestamp(this.#now(), "updatedAt"),
    });
  }

  #persist(): void {
    try {
      this.repository.replace([...this.#entries.values()].map(({ record }) => record));
    } catch (error) {
      if (error instanceof LocalSubtitleOverwriteRecoveryError) throw error;
      throw persistenceFailure("The overwrite recovery state could not be persisted.", error);
    }
  }

  async #withRecovery<T>(
    recoveryId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.#recoveryTails.get(recoveryId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#recoveryTails.set(recoveryId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#recoveryTails.get(recoveryId) === tail) {
        this.#recoveryTails.delete(recoveryId);
      }
    }
  }

  #requireEntry(recoveryId: string): OwnedRecovery<TReservation> {
    if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
      throw failure("invalid_request", "The overwrite recovery identifier is invalid.");
    }
    const entry = this.#entries.get(recoveryId);
    if (!entry) {
      throw failure("invalid_request", "The overwrite recovery does not exist.");
    }
    return entry;
  }
}

function snapshotRecoveryRequest(
  request: LocalSubtitleOverwriteRecoveryRequest,
): LocalSubtitleOverwriteRecoveryRequest {
  const directoryIdentity = isExactRecord(request, [
    "transactionId",
    "directoryPath",
    "expectedDirectoryIdentity",
    "decision",
  ])
    ? snapshotLocalSubtitleOverwriteDirectoryIdentity(
        request.expectedDirectoryIdentity,
      )
    : undefined;
  if (
    !directoryIdentity ||
    !RECOVERY_ID_PATTERN.test(request.transactionId) ||
    typeof request.directoryPath !== "string" ||
    !path.isAbsolute(request.directoryPath) ||
    request.directoryPath.includes("\0") ||
    (request.decision !== "finalize" && request.decision !== "rollback")
  ) {
    throw failure("invalid_request", "The overwrite recovery request is invalid.");
  }
  return deepFreeze({
    transactionId: request.transactionId,
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: directoryIdentity,
    decision: request.decision,
  });
}

function validateRecoveryResult(input: unknown): LocalSubtitleOverwriteRecoveryResult {
  if (
    !isExactRecord(input, ["state"]) ||
    isProxy(input) ||
    !["finalized", "rolled_back", "not_found"].includes(
      input.state as string,
    )
  ) {
    throw failure("invalid_result", "The overwrite recovery result is invalid.");
  }
  return Object.freeze({
    state: input.state as LocalSubtitleOverwriteRecoveryResult["state"],
  });
}

function validateAcknowledgementResult(
  input: unknown,
): LocalSubtitleOverwriteAcknowledgementResult {
  if (
    !isExactRecord(input, ["state"]) ||
    isProxy(input) ||
    (input.state !== "acknowledged" && input.state !== "not_found")
  ) {
    throw failure("invalid_result", "The overwrite recovery acknowledgement is invalid.");
  }
  return Object.freeze({ state: input.state });
}

function assertAdoptionMetadata(
  options: PrepareLocalSubtitleOverwriteRecoveryOptions,
): LocalSubtitleOverwriteDirectoryIdentity {
  const directoryIdentity = snapshotLocalSubtitleOverwriteDirectoryIdentity(
    options?.directoryIdentity,
  );
  if (
    !options ||
    typeof options.recoveryId !== "string" ||
    !RECOVERY_ID_PATTERN.test(options.recoveryId) ||
    !isOwner(options.owner) ||
    !isId(options.taskId) ||
    !isPositiveSafeInteger(options.generation) ||
    !isFormat(options.format) ||
    !directoryIdentity
  ) {
    throw failure("invalid_request", "The overwrite recovery handoff is invalid.");
  }
  return directoryIdentity;
}

function assertAdoptionTerminal<TReservation>(
  options: AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation>,
): LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation> {
  const registry = snapshotRegistryAuthority<TReservation>(options.registry);
  if (
    !["finalize", "rollback"].includes(options.direction) ||
    !isLocalSubtitleOverwriteTransactionReceipt(options.receipt) ||
    !registry
  ) {
    throw failure("invalid_request", "The overwrite recovery handoff is invalid.");
  }
  const state = options.receipt.state;
  if (
    (options.direction === "finalize" && registry.state !== "active") ||
    (options.direction === "finalize" &&
      state !== "finalize_pending" &&
      state !== "finalize_pending_ack" &&
      state !== "finalized") ||
    (options.direction === "rollback" &&
      state !== "open" &&
      state !== "rollback_pending" &&
      state !== "rollback_pending_ack" &&
      state !== "rolled_back")
  ) {
    throw failure("invalid_state", "The overwrite recovery direction is inconsistent.");
  }
  return registry;
}

function sameAdoptionMetadata<TReservation>(
  prepared: PreparedRecoveryHandoff,
  options: AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation>,
  directoryIdentity: LocalSubtitleOverwriteDirectoryIdentity,
): boolean {
  return prepared.recoveryId === options.recoveryId &&
    prepared.owner.webContentsId === options.owner.webContentsId &&
    prepared.owner.ownerSessionId === options.owner.ownerSessionId &&
    prepared.taskId === options.taskId &&
    prepared.generation === options.generation &&
    prepared.format === options.format &&
    sameLocalSubtitleOverwriteDirectoryIdentity(
      prepared.directoryIdentity,
      directoryIdentity,
    );
}

function snapshotRegistryAuthority<TReservation>(
  value: unknown,
): LocalSubtitleOverwriteRecoveryRegistryAuthority<TReservation> | undefined {
  if (isExactRecord(value, ["state"]) && ownDataValue(value, "state") === "settled") {
    return Object.freeze({ state: "settled" });
  }
  if (isExactRecord(value, ["state", "artifactRef"])) {
    const state = ownDataValue(value, "state");
    const artifactRef = ownDataValue(value, "artifactRef");
    if (state === "active" && isId(artifactRef)) {
      return Object.freeze({ state, artifactRef });
    }
  }
  if (isExactRecord(value, ["state", "reservation"])) {
    const state = ownDataValue(value, "state");
    if (state === "reserved") {
      return Object.freeze({
        state,
        reservation: ownDataValue(value, "reservation") as TReservation,
      });
    }
  }
  return undefined;
}

function assertRecoverySelection(
  options: RecoverLocalSubtitleOverwriteAfterReauthorizationOptions,
): Readonly<RecoverLocalSubtitleOverwriteAfterReauthorizationOptions> {
  const recoveryId = options?.recoveryId;
  const taskId = options?.taskId;
  const generation = options?.generation;
  const format = options?.format;
  const directory = snapshotResolvedDirectory(options?.directory);
  if (
    !options ||
    typeof recoveryId !== "string" ||
    !RECOVERY_ID_PATTERN.test(recoveryId) ||
    !isId(taskId) ||
    !isPositiveSafeInteger(generation) ||
    !isFormat(format) ||
    !directory
  ) {
    throw failure("invalid_request", "The overwrite recovery selection is invalid.");
  }
  return Object.freeze({ recoveryId, taskId, generation, format, directory });
}

function serializeRecoveryFile(
  records: readonly LocalSubtitleOverwriteRecoveryRecord[],
): string {
  const content = {
    schemaVersion: RECOVERY_FILE_SCHEMA_VERSION,
    records,
  };
  return `${JSON.stringify({
    ...content,
    checksum: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  })}\n`;
}

function parseRecoveryFile(input: string): readonly LocalSubtitleOverwriteRecoveryRecord[] {
  const parsed = JSON.parse(input) as unknown;
  if (
    !isExactRecord(parsed, ["schemaVersion", "records", "checksum"]) ||
    parsed.schemaVersion !== RECOVERY_FILE_SCHEMA_VERSION ||
    !Array.isArray(parsed.records) ||
    typeof parsed.checksum !== "string" ||
    !OWNER_FINGERPRINT_PATTERN.test(parsed.checksum)
  ) {
    throw failure("invalid_record", "The overwrite recovery repository is invalid.");
  }
  const content = {
    schemaVersion: parsed.schemaVersion,
    records: parsed.records,
  };
  const expected = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  if (parsed.checksum !== expected) {
    throw failure("invalid_record", "The overwrite recovery repository checksum is invalid.");
  }
  const records = parsed.records.map(validatePersistedRecord);
  if (new Set(records.map(({ recoveryId }) => recoveryId)).size !== records.length) {
    throw failure("invalid_record", "The overwrite recovery repository contains duplicates.");
  }
  return Object.freeze(records);
}

function validatePersistedRecord(input: unknown): LocalSubtitleOverwriteRecoveryRecord {
  if (
    !isExactRecord(input, [
      "schemaVersion",
      "recoveryId",
      "ownerFingerprint",
      "taskId",
      "generation",
      "format",
      "decision",
      "nativeState",
      "createdAt",
      "updatedAt",
    ]) ||
    input.schemaVersion !== RECOVERY_RECORD_SCHEMA_VERSION ||
    typeof input.recoveryId !== "string" ||
    !RECOVERY_ID_PATTERN.test(input.recoveryId) ||
    typeof input.ownerFingerprint !== "string" ||
    !OWNER_FINGERPRINT_PATTERN.test(input.ownerFingerprint) ||
    !isId(input.taskId) ||
    !isPositiveSafeInteger(input.generation) ||
    !isFormat(input.format) ||
    !["finalize_committed", "rollback_unpublished"].includes(input.decision as string) ||
    !["not_started", "pending", "settled", "retry_failed"].includes(
      input.nativeState as string,
    ) ||
    (input.decision === "finalize_committed" && input.nativeState === "not_started") ||
    !isTimestamp(input.createdAt) ||
    !isTimestamp(input.updatedAt) ||
    input.updatedAt < input.createdAt
  ) {
    throw failure("invalid_record", "The overwrite recovery record is invalid.");
  }
  return deepFreeze({ ...input }) as unknown as LocalSubtitleOverwriteRecoveryRecord;
}

function ownerFingerprint(owner: LocalSubtitleOwnerKey): string {
  if (!isOwner(owner)) {
    throw failure("invalid_request", "The overwrite recovery owner is invalid.");
  }
  return createHash("sha256")
    .update(String(owner.webContentsId))
    .update("\0")
    .update(owner.ownerSessionId)
    .digest("hex");
}

function isRepository(value: unknown): value is LocalSubtitleOverwriteRecoveryRepository {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as LocalSubtitleOverwriteRecoveryRepository).load === "function" &&
    typeof (value as LocalSubtitleOverwriteRecoveryRepository).replace === "function",
  );
}

function isRecoveryRegistry<TReservation>(
  value: unknown,
): value is LocalSubtitleOverwriteRecoveryRegistry<TReservation> {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as LocalSubtitleOverwriteRecoveryRegistry<TReservation>)
      .revokeReservation === "function" &&
    typeof (value as LocalSubtitleOverwriteRecoveryRegistry<TReservation>)
      .revokeArtifact === "function",
  );
}

function snapshotResolvedDirectory(
  value: unknown,
): ResolvedLocalSubtitleOutputDirectory | undefined {
  if (
    !isExactRecord(value, [
      "directoryPath",
      "directoryName",
      "identity",
      "expiresAt",
    ])
  ) {
    return undefined;
  }
  const directoryPath = ownDataValue(value, "directoryPath");
  const directoryName = ownDataValue(value, "directoryName");
  const identity = snapshotLocalSubtitleOverwriteDirectoryIdentity(
    ownDataValue(value, "identity"),
  );
  const expiresAt = ownDataValue(value, "expiresAt");
  if (
    typeof directoryPath !== "string" ||
    !path.isAbsolute(directoryPath) ||
    directoryPath.includes("\0") ||
    typeof directoryName !== "string" ||
    !identity ||
    !isTimestamp(expiresAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    directoryPath,
    directoryName,
    identity,
    expiresAt,
  });
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isOwner(value: unknown): value is LocalSubtitleOwnerKey {
  return Boolean(
    value &&
    typeof value === "object" &&
    isNonNegativeSafeInteger((value as LocalSubtitleOwnerKey).webContentsId) &&
    isId((value as LocalSubtitleOwnerKey).ownerSessionId),
  );
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isFormat(value: unknown): value is LocalSubtitleFormat {
  return value === "SRT" || value === "LRC";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function decisionForDirection(
  direction: LocalSubtitleOverwriteRecoveryDirection,
): LocalSubtitleOverwriteRecoveryDecision {
  return direction === "finalize" ? "finalize_committed" : "rollback_unpublished";
}

function directionForDecision(
  decision: LocalSubtitleOverwriteRecoveryDecision,
): LocalSubtitleOverwriteRecoveryDirection {
  return decision === "finalize_committed" ? "finalize" : "rollback";
}

function terminalResultForDecision(
  decision: LocalSubtitleOverwriteRecoveryDecision,
): "finalized" | "rolled_back" {
  return decision === "finalize_committed" ? "finalized" : "rolled_back";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireTimestamp(value: number, field: string): number {
  if (!isTimestamp(value)) {
    throw failure("invalid_record", `The overwrite recovery ${field} is invalid.`);
  }
  return value;
}

function isExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): input is Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input)
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(input);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof Reflect.get(value, "then") === "function",
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function persistenceFailure(message: string, cause: unknown) {
  return failure("persistence_failed", message, cause);
}

function failure(
  code: LocalSubtitleOverwriteRecoveryErrorCode,
  message: string,
  cause?: unknown,
): LocalSubtitleOverwriteRecoveryError {
  return new LocalSubtitleOverwriteRecoveryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
