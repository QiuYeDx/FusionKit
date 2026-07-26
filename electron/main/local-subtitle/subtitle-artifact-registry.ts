import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_SUBTITLE_FORMATS,
  LOCAL_SUBTITLE_LIMITS,
  type GeneratedSubtitleArtifactSummary,
  type LocalSubtitleFormat,
} from "@/type/localSubtitle";
import {
  localSubtitleArtifactTextResultSchema,
  type LocalSubtitleArtifactTextResult,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleDirectoryIdentity,
  LocalSubtitleFileIdentity,
  LocalSubtitleFileObjectIdentity,
  LocalSubtitleOwnerKey,
} from "./authorizations";
import {
  localSubtitleFilesystemObjectIdentityForHandle,
  localSubtitleFilesystemObjectIdentityForPath,
  localSubtitleFilesystemObjectIdentityForPathSync,
  sameLocalSubtitleFilesystemObjectIdentity,
  snapshotLocalSubtitleFilesystemObjectIdentity,
} from "./filesystem-object-identity";
import {
  LocalSubtitleFormatError,
  parseLocalSubtitleArtifactUtf8,
  toPlainLocalSubtitleText,
} from "./subtitle-formats";

const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES =
  LOCAL_SUBTITLE_LIMITS.maxSessionBatches *
  LOCAL_SUBTITLE_LIMITS.maxBatchFiles *
  LOCAL_SUBTITLE_FORMATS.length;
const NOFOLLOW_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_TOKEN_SOURCE = /^[A-Za-z0-9_-]+$/u;
const RESERVED_WINDOWS_LEAF =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export type LocalSubtitleArtifactOperation = "read" | "reveal" | "handoff";

export type LocalSubtitleArtifactRegistryErrorCode =
  | "invalid_ipc_request"
  | "owner_released"
  | "artifact_expired"
  | "artifact_changed"
  | "content_too_large"
  | "invalid_content"
  | "limit_exceeded";

export class LocalSubtitleArtifactRegistryError extends Error {
  readonly name = "LocalSubtitleArtifactRegistryError";

  constructor(
    readonly code: LocalSubtitleArtifactRegistryErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface LocalSubtitleArtifactRegistryOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly reservationFactory?: () => string;
  readonly revealFile?: (filePath: string) => void | Promise<void>;
}

export interface ReserveLocalSubtitleArtifactOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly operations?: readonly LocalSubtitleArtifactOperation[];
}

export interface ReservedLocalSubtitleArtifact {
  readonly artifactRef: string;
  readonly expiresAt: number;
  readonly reservation: string;
}

export interface ActivateLocalSubtitleArtifactOptions {
  readonly filePath: string;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly expectedFileIdentity: LocalSubtitleFileObjectIdentity;
  readonly expectedDirectoryIdentity: LocalSubtitleDirectoryIdentity;
}

export interface LocalSubtitleArtifactHandoffSnapshot {
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly rawText: string;
  readonly plainText: string;
  readonly cueCount: number;
  readonly byteSize: number;
  readonly sha256: string;
}

interface ArtifactEntryBase {
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly operations: ReadonlySet<LocalSubtitleArtifactOperation>;
  readonly artifactRef: string;
  readonly expiresAt: number;
}

interface PendingArtifactEntry extends ArtifactEntryBase {
  readonly state: "pending";
  readonly reservation: string;
}

interface ActiveArtifactEntry extends ArtifactEntryBase {
  readonly state: "active";
  readonly record: LocalSubtitleArtifactRecord;
}

interface InvalidArtifactEntry extends ArtifactEntryBase {
  readonly state: "invalid";
  readonly errorCode:
    | "artifact_changed"
    | "content_too_large"
    | "invalid_content";
}

type ArtifactEntry =
  | PendingArtifactEntry
  | ActiveArtifactEntry
  | InvalidArtifactEntry;

interface LocalSubtitleArtifactRecord {
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly directoryPath: string;
  readonly directoryIdentity: LocalSubtitleDirectoryIdentity;
  readonly filePath: string;
  readonly fileObjectIdentity: LocalSubtitleFileObjectIdentity;
  readonly fileIdentity: LocalSubtitleFileIdentity;
  readonly byteSize: number;
  readonly sha256: string;
}

interface ValidatedArtifact {
  readonly rawText: string;
  readonly plainText: string;
  readonly cueCount: number;
}

export class LocalSubtitleArtifactRegistry {
  private readonly entries = new Map<string, ArtifactEntry>();
  private readonly reservationRefs = new Map<string, string>();
  private readonly releasedOwners = new Set<string>();
  private readonly revokedTasks = new Set<string>();
  private readonly taskGenerations = new Map<string, number>();
  private readonly ownerTaskKeys = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly reservationFactory: () => string;
  private readonly revealFile: LocalSubtitleArtifactRegistryOptions["revealFile"];

  constructor(options: LocalSubtitleArtifactRegistryOptions = {}) {
    this.ttlMs = requirePositiveSafeInteger(
      options.ttlMs ?? DEFAULT_ARTIFACT_TTL_MS,
      "ttlMs",
    );
    this.maxEntries = requirePositiveSafeInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      "maxEntries",
    );
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.reservationFactory = options.reservationFactory ?? randomUUID;
    this.revealFile = options.revealFile;
  }

  reserve(
    options: ReserveLocalSubtitleArtifactOptions,
  ): ReservedLocalSubtitleArtifact {
    assertOwner(options.owner);
    assertId(options.taskId, "taskId");
    const generation = requirePositiveSafeInteger(
      options.generation,
      "generation",
    );
    assertFormat(options.format);
    assertDisplayName(options.displayName, options.format);
    this.assertOwnerActive(options.owner);
    const taskKey = ownedTask(options.owner, options.taskId);
    if (this.revokedTasks.has(taskKey)) {
      throw invalid("taskId");
    }

    this.sweepExpired();
    const claimedGeneration = this.taskGenerations.get(taskKey);
    if (claimedGeneration !== undefined && generation < claimedGeneration) {
      throw invalid("generation");
    }

    const operations = validateOperations(options.operations);
    const artifactRef = mintOpaqueValue(
      "ls-artifact-",
      this.tokenFactory,
      (value) => this.entries.has(value),
    );
    const reservation = mintOpaqueValue(
      "ls-artifact-reservation-",
      this.reservationFactory,
      (value) => this.reservationRefs.has(value),
    );
    const expiresAt = addTtl(this.now(), this.ttlMs);
    this.assertOwnerActive(options.owner);
    if (this.revokedTasks.has(taskKey)) throw invalid("taskId");

    const currentGeneration = this.taskGenerations.get(taskKey);
    if (currentGeneration !== undefined && generation < currentGeneration) {
      throw invalid("generation");
    }
    const advancesGeneration =
      currentGeneration === undefined || generation > currentGeneration;
    const supersededEntries = advancesGeneration && currentGeneration !== undefined
      ? [...this.entries.values()].filter(
          (candidate) =>
            sameOwner(candidate.owner, options.owner) &&
            candidate.taskId === options.taskId,
        )
      : [];
    if (this.entries.size - supersededEntries.length >= this.maxEntries) {
      throw failure(
        "limit_exceeded",
        "Local subtitle artifact registry capacity was reached.",
        "artifactRef",
      );
    }

    const entry: PendingArtifactEntry = Object.freeze({
      state: "pending",
      owner: Object.freeze({ ...options.owner }),
      taskId: options.taskId,
      generation,
      format: options.format,
      displayName: options.displayName,
      operations,
      artifactRef,
      expiresAt,
      reservation,
    });
    for (const superseded of supersededEntries) {
      this.removeEntry(superseded);
    }
    if (advancesGeneration) this.taskGenerations.set(taskKey, generation);
    this.trackOwnerTask(options.owner, taskKey);
    this.entries.set(artifactRef, entry);
    this.reservationRefs.set(reservation, artifactRef);
    return Object.freeze({ artifactRef, expiresAt, reservation });
  }

  activate(
    reservation: string,
    options: ActivateLocalSubtitleArtifactOptions,
  ): GeneratedSubtitleArtifactSummary {
    const entry = this.requirePendingReservation(reservation);
    this.assertOwnerActive(entry.owner);
    if (entry.expiresAt <= this.now()) {
      this.removeEntry(entry);
      throw artifactExpired();
    }
    if (
      options.format !== entry.format ||
      options.displayName !== entry.displayName
    ) {
      throw invalid("reservation");
    }
    assertActivationMetadata(options);

    const record = captureArtifactRecord(options, entry.generation);
    this.assertOwnerActive(entry.owner);
    const active: ActiveArtifactEntry = Object.freeze({
      state: "active",
      owner: entry.owner,
      taskId: entry.taskId,
      generation: entry.generation,
      format: entry.format,
      displayName: entry.displayName,
      operations: entry.operations,
      artifactRef: entry.artifactRef,
      expiresAt: entry.expiresAt,
      record,
    });
    this.entries.set(entry.artifactRef, active);
    this.reservationRefs.delete(entry.reservation);
    return artifactSummary(active);
  }

  revokeReservation(reservation: string): boolean {
    if (!isOpaqueValue(reservation, "ls-artifact-reservation-")) return false;
    const artifactRef = this.reservationRefs.get(reservation);
    const entry = artifactRef ? this.entries.get(artifactRef) : undefined;
    if (!entry || entry.state !== "pending" || entry.reservation !== reservation) {
      return false;
    }
    this.removeEntry(entry);
    return true;
  }

  async readText(
    owner: LocalSubtitleOwnerKey,
    artifactRef: string,
  ): Promise<LocalSubtitleArtifactTextResult> {
    const entry = this.requireActive(owner, artifactRef, "read");
    const validated = await this.validateEntry(entry);
    this.assertEntryCurrent(entry);
    return Object.freeze({
      format: entry.format,
      rawText: validated.rawText,
      plainText: validated.plainText,
      cueCount: validated.cueCount,
    });
  }

  async reveal(
    owner: LocalSubtitleOwnerKey,
    artifactRef: string,
  ): Promise<{ readonly revealed: true }> {
    const entry = this.requireActive(owner, artifactRef, "reveal");
    await this.validateEntry(entry);
    this.assertEntryCurrent(entry);
    if (!this.revealFile) {
      throw failure(
        "invalid_content",
        "Local subtitle artifact reveal service is unavailable.",
      );
    }
    try {
      await this.revealFile(entry.record.filePath);
    } catch {
      throw failure(
        "artifact_changed",
        "Local subtitle artifact could not be revealed.",
      );
    }
    this.assertEntryCurrent(entry);
    return Object.freeze({ revealed: true as const });
  }

  async snapshotForHandoff(
    owner: LocalSubtitleOwnerKey,
    artifactRef: string,
  ): Promise<LocalSubtitleArtifactHandoffSnapshot> {
    const entry = this.requireActive(owner, artifactRef, "handoff");
    const validated = await this.validateEntry(entry);
    this.assertEntryCurrent(entry);
    return Object.freeze({
      format: entry.format,
      displayName: entry.displayName,
      rawText: validated.rawText,
      plainText: validated.plainText,
      cueCount: validated.cueCount,
      byteSize: entry.record.byteSize,
      sha256: entry.record.sha256,
    });
  }

  revokeArtifact(owner: LocalSubtitleOwnerKey, artifactRef: string): boolean {
    assertOwner(owner);
    if (!isOpaqueValue(artifactRef, "ls-artifact-")) return false;
    const entry = this.entries.get(artifactRef);
    if (!entry || !sameOwner(entry.owner, owner)) return false;
    this.removeEntry(entry);
    return true;
  }

  revokeTask(owner: LocalSubtitleOwnerKey, taskId: string): number {
    assertOwner(owner);
    assertId(taskId, "taskId");
    const taskKey = ownedTask(owner, taskId);
    this.revokedTasks.add(taskKey);
    this.taskGenerations.delete(taskKey);
    this.trackOwnerTask(owner, taskKey);
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (sameOwner(entry.owner, owner) && entry.taskId === taskId) {
        this.removeEntry(entry);
        count += 1;
      }
    }
    return count;
  }

  revokeOwner(owner: LocalSubtitleOwnerKey): number {
    assertOwner(owner);
    const releasedOwnerKey = ownerKey(owner);
    this.releasedOwners.add(releasedOwnerKey);
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (sameOwner(entry.owner, owner)) {
        this.removeEntry(entry);
        count += 1;
      }
    }
    const taskKeys = this.ownerTaskKeys.get(releasedOwnerKey);
    if (taskKeys) {
      for (const taskKey of taskKeys) {
        this.taskGenerations.delete(taskKey);
        this.revokedTasks.delete(taskKey);
      }
      this.ownerTaskKeys.delete(releasedOwnerKey);
    }
    return count;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    this.revokeOwner(owner);
  }

  sweepExpired(): number {
    const now = this.now();
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt > now) continue;
      this.removeEntry(entry);
      count += 1;
    }
    return count;
  }

  private requirePendingReservation(
    reservation: string,
  ): PendingArtifactEntry {
    if (!isOpaqueValue(reservation, "ls-artifact-reservation-")) {
      throw invalid("reservation");
    }
    const artifactRef = this.reservationRefs.get(reservation);
    const entry = artifactRef ? this.entries.get(artifactRef) : undefined;
    if (!entry || entry.state !== "pending" || entry.reservation !== reservation) {
      throw invalid("reservation");
    }
    return entry;
  }

  private requireActive(
    owner: LocalSubtitleOwnerKey,
    artifactRef: string,
    operation: LocalSubtitleArtifactOperation,
  ): ActiveArtifactEntry {
    assertOwner(owner);
    this.assertOwnerActive(owner);
    if (!isOpaqueValue(artifactRef, "ls-artifact-")) {
      throw invalid("artifactRef");
    }
    const entry = this.entries.get(artifactRef);
    if (!entry) throw artifactExpired();
    if (!sameOwner(entry.owner, owner)) throw invalid("artifactRef");
    if (!entry.operations.has(operation)) throw invalid("operation");
    if (entry.expiresAt <= this.now()) {
      this.removeEntry(entry);
      throw artifactExpired();
    }
    if (entry.state === "pending") throw invalid("artifactRef");
    if (entry.state === "invalid") {
      throw stableValidationFailure(entry.errorCode);
    }
    return entry;
  }

  private async validateEntry(
    entry: ActiveArtifactEntry,
  ): Promise<ValidatedArtifact> {
    try {
      return await validateArtifactRecord(entry.record);
    } catch (error) {
      const normalized = normalizeValidationFailure(error);
      const current = this.entries.get(entry.artifactRef);
      if (current === entry && entry.expiresAt > this.now()) {
        const invalidEntry: InvalidArtifactEntry = Object.freeze({
          state: "invalid",
          owner: entry.owner,
          taskId: entry.taskId,
          generation: entry.generation,
          format: entry.format,
          displayName: entry.displayName,
          operations: entry.operations,
          artifactRef: entry.artifactRef,
          expiresAt: entry.expiresAt,
          errorCode: normalized.code,
        });
        this.entries.set(entry.artifactRef, invalidEntry);
      }
      throw normalized;
    }
  }

  private assertEntryCurrent(entry: ActiveArtifactEntry): void {
    this.assertOwnerActive(entry.owner);
    const current = this.entries.get(entry.artifactRef);
    if (entry.expiresAt <= this.now()) {
      if (current) this.removeEntry(current);
      throw artifactExpired();
    }
    if (current === entry) return;
    if (!current) throw artifactExpired();
    if (current.state === "invalid") {
      throw stableValidationFailure(current.errorCode);
    }
    throw invalid("artifactRef");
  }

  private assertOwnerActive(owner: LocalSubtitleOwnerKey): void {
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure(
        "owner_released",
        "Local subtitle artifact owner was released.",
        "owner",
      );
    }
  }

  private trackOwnerTask(owner: LocalSubtitleOwnerKey, taskKey: string): void {
    const key = ownerKey(owner);
    const taskKeys = this.ownerTaskKeys.get(key);
    if (taskKeys) {
      taskKeys.add(taskKey);
      return;
    }
    this.ownerTaskKeys.set(key, new Set([taskKey]));
  }

  private removeEntry(entry: ArtifactEntry): void {
    if (this.entries.get(entry.artifactRef) !== entry) return;
    this.entries.delete(entry.artifactRef);
    if (entry.state === "pending") {
      this.reservationRefs.delete(entry.reservation);
    }
  }
}

function artifactSummary(
  entry: Pick<
    ActiveArtifactEntry,
    "artifactRef" | "displayName" | "format" | "expiresAt"
  >,
): GeneratedSubtitleArtifactSummary {
  return Object.freeze({
    artifactRef: entry.artifactRef,
    displayName: entry.displayName,
    format: entry.format,
    expiresAt: entry.expiresAt,
  });
}

function captureArtifactRecord(
  options: ActivateLocalSubtitleArtifactOptions,
  generation: number,
): LocalSubtitleArtifactRecord {
  try {
    const filePath = requireAbsolutePath(options.filePath, "filePath");
    const directoryPath = path.dirname(filePath);
    if (path.basename(filePath) !== options.displayName) {
      throw invalid("displayName");
    }

    const directoryBefore = lstatSync(directoryPath);
    const directoryIdentityBefore =
      localSubtitleFilesystemObjectIdentityForPathSync(directoryPath);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw artifactChanged();
    }
    if (
      !sameDirectoryIdentity(
        directoryIdentityBefore,
        options.expectedDirectoryIdentity,
      )
    ) {
      throw artifactChanged();
    }
    const canonicalDirectory = realpathSync(directoryPath);
    if (!samePath(canonicalDirectory, directoryPath)) {
      throw artifactChanged();
    }

    const before = lstatSync(filePath);
    const fileObjectIdentityBefore =
      localSubtitleFilesystemObjectIdentityForPathSync(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw artifactChanged();
    if (before.size !== options.byteSize) throw artifactChanged();
    if (
      !sameFileObjectIdentity(
        fileObjectIdentityBefore,
        options.expectedFileIdentity,
      )
    ) {
      throw artifactChanged();
    }
    const canonicalFile = realpathSync(filePath);
    if (!samePath(canonicalFile, filePath)) throw artifactChanged();

    const after = lstatSync(filePath);
    const fileObjectIdentityAfter =
      localSubtitleFilesystemObjectIdentityForPathSync(filePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.size !== options.byteSize ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(after)) ||
      !sameFileObjectIdentity(
        fileObjectIdentityAfter,
        options.expectedFileIdentity,
      )
    ) {
      throw artifactChanged();
    }

    const directoryAfter = lstatSync(directoryPath);
    const directoryIdentityAfter =
      localSubtitleFilesystemObjectIdentityForPathSync(directoryPath);
    if (
      !directoryAfter.isDirectory() ||
      directoryAfter.isSymbolicLink() ||
      !sameDirectoryIdentity(
        directoryIdentityBefore,
        directoryIdentityAfter,
      ) ||
      !sameDirectoryIdentity(
        directoryIdentityAfter,
        options.expectedDirectoryIdentity,
      )
    ) {
      throw artifactChanged();
    }

    return Object.freeze({
      generation,
      format: options.format,
      displayName: options.displayName,
      directoryPath,
      directoryIdentity: directoryIdentityAfter,
      filePath,
      fileObjectIdentity: fileObjectIdentityAfter,
      fileIdentity: Object.freeze(fileIdentity(after)),
      byteSize: options.byteSize,
      sha256: options.sha256,
    });
  } catch (error) {
    if (error instanceof LocalSubtitleArtifactRegistryError) throw error;
    throw artifactChanged();
  }
}

async function validateArtifactRecord(
  record: LocalSubtitleArtifactRecord,
): Promise<ValidatedArtifact> {
  await verifyArtifactDirectory(record);

  let before: Stats;
  let beforeObjectIdentity: LocalSubtitleFileObjectIdentity;
  try {
    before = await lstat(record.filePath);
    beforeObjectIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(record.filePath);
  } catch {
    throw artifactChanged();
  }
  if (before.size > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
    throw contentTooLarge();
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameFileObjectIdentity(beforeObjectIdentity, record.fileObjectIdentity) ||
    !sameFileIdentity(fileIdentity(before), record.fileIdentity)
  ) {
    throw artifactChanged();
  }

  let handle: FileHandle;
  try {
    handle = await open(record.filePath, NOFOLLOW_READ);
  } catch {
    throw artifactChanged();
  }

  let bytes: Uint8Array;
  try {
    const opened = await handle.stat();
    const openedObjectIdentity =
      await localSubtitleFilesystemObjectIdentityForHandle(handle);
    if (opened.size > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
      throw contentTooLarge();
    }
    if (
      !opened.isFile() ||
      !sameFileObjectIdentity(
        openedObjectIdentity,
        record.fileObjectIdentity,
      ) ||
      !sameFileIdentity(fileIdentity(opened), record.fileIdentity)
    ) {
      throw artifactChanged();
    }
    bytes = await readExactArtifactBytes(handle, opened.size);
    const openedAfter = await handle.stat();
    const openedAfterObjectIdentity =
      await localSubtitleFilesystemObjectIdentityForHandle(handle);
    if (
      !sameFileObjectIdentity(
        openedAfterObjectIdentity,
        record.fileObjectIdentity,
      ) ||
      !sameFileIdentity(fileIdentity(openedAfter), record.fileIdentity)
    ) {
      throw artifactChanged();
    }
  } finally {
    try {
      await handle.close();
    } catch {
      throw artifactChanged();
    }
  }

  let after: Stats;
  let afterObjectIdentity: LocalSubtitleFileObjectIdentity;
  try {
    after = await lstat(record.filePath);
    afterObjectIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(record.filePath);
  } catch {
    throw artifactChanged();
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFileObjectIdentity(afterObjectIdentity, record.fileObjectIdentity) ||
    !sameFileIdentity(fileIdentity(after), record.fileIdentity)
  ) {
    throw artifactChanged();
  }
  await verifyArtifactDirectory(record);

  if (
    bytes.byteLength !== record.byteSize ||
    createHash("sha256").update(bytes).digest("hex") !== record.sha256
  ) {
    throw artifactChanged();
  }

  const parsed = parseLocalSubtitleArtifactUtf8(record.format, bytes);
  const result = {
    format: record.format,
    rawText: parsed.rawText,
    plainText: toPlainLocalSubtitleText(parsed),
    cueCount: parsed.cues.length,
  };
  const validated = localSubtitleArtifactTextResultSchema.safeParse(result);
  if (!validated.success) {
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") >
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes
    ) {
      throw contentTooLarge();
    }
    throw failure(
      "invalid_content",
      "Local subtitle artifact text does not match the versioned schema.",
    );
  }
  return Object.freeze({
    rawText: validated.data.rawText,
    plainText: validated.data.plainText,
    cueCount: validated.data.cueCount,
  });
}

async function verifyArtifactDirectory(
  record: LocalSubtitleArtifactRecord,
): Promise<void> {
  try {
    const current = await lstat(record.directoryPath);
    const currentIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(record.directoryPath);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(
        currentIdentity,
        record.directoryIdentity,
      )
    ) {
      throw artifactChanged();
    }
    const canonical = await realpath(record.directoryPath);
    if (!samePath(canonical, record.directoryPath)) throw artifactChanged();
    const relative = path.relative(record.directoryPath, record.filePath);
    if (
      !relative ||
      relative !== record.displayName ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw artifactChanged();
    }
  } catch (error) {
    if (error instanceof LocalSubtitleArtifactRegistryError) throw error;
    throw artifactChanged();
  }
}

async function readExactArtifactBytes(
  handle: FileHandle,
  size: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw failure(
      "invalid_content",
      "Local subtitle artifact is empty or invalid.",
    );
  }
  if (size > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
    throw contentTooLarge();
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead <= 0) throw artifactChanged();
    offset += bytesRead;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await handle.read(sentinel, 0, 1, size);
  if (extraBytes !== 0) throw artifactChanged();
  return buffer;
}

function normalizeValidationFailure(
  error: unknown,
): LocalSubtitleArtifactRegistryError & {
  readonly code: "artifact_changed" | "content_too_large" | "invalid_content";
} {
  if (error instanceof LocalSubtitleArtifactRegistryError) {
    if (
      error.code === "artifact_changed" ||
      error.code === "content_too_large" ||
      error.code === "invalid_content"
    ) {
      return error as LocalSubtitleArtifactRegistryError & {
        readonly code:
          | "artifact_changed"
          | "content_too_large"
          | "invalid_content";
      };
    }
  }
  if (error instanceof LocalSubtitleFormatError) {
    return error.code === "limit_exceeded"
      ? contentTooLarge()
      : failure(
        "invalid_content",
        "Local subtitle artifact content is invalid.",
      ) as LocalSubtitleArtifactRegistryError & {
        readonly code: "invalid_content";
      };
  }
  return artifactChanged();
}

function stableValidationFailure(
  code: InvalidArtifactEntry["errorCode"],
): LocalSubtitleArtifactRegistryError {
  switch (code) {
    case "artifact_changed":
      return artifactChanged();
    case "content_too_large":
      return contentTooLarge();
    case "invalid_content":
      return failure(
        "invalid_content",
        "Local subtitle artifact content is invalid.",
      );
  }
}

function validateOperations(
  value: readonly LocalSubtitleArtifactOperation[] | undefined,
): ReadonlySet<LocalSubtitleArtifactOperation> {
  const operations = value ?? ["read", "reveal", "handoff"];
  const allowed = new Set<LocalSubtitleArtifactOperation>([
    "read",
    "reveal",
    "handoff",
  ]);
  if (
    operations.length === 0 ||
    new Set(operations).size !== operations.length ||
    operations.some((operation) => !allowed.has(operation))
  ) {
    throw invalid("operations");
  }
  return new Set(operations);
}

function assertActivationMetadata(
  options: ActivateLocalSubtitleArtifactOptions,
): void {
  assertFormat(options.format);
  assertDisplayName(options.displayName, options.format);
  if (!SHA256_PATTERN.test(options.sha256)) throw invalid("sha256");
  if (
    !Number.isSafeInteger(options.byteSize) ||
    options.byteSize <= 0
  ) {
    throw invalid("byteSize");
  }
  if (options.byteSize > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
    throw contentTooLarge();
  }
  assertFileObjectIdentity(options.expectedFileIdentity, "expectedFileIdentity");
  assertDirectoryIdentity(
    options.expectedDirectoryIdentity,
    "expectedDirectoryIdentity",
  );
}

function assertFileObjectIdentity(
  value: LocalSubtitleFileObjectIdentity,
  field: string,
): void {
  if (!snapshotLocalSubtitleFilesystemObjectIdentity(value)) {
    throw invalid(field);
  }
}

function assertDirectoryIdentity(
  value: LocalSubtitleDirectoryIdentity,
  field: string,
): void {
  if (!snapshotLocalSubtitleFilesystemObjectIdentity(value)) {
    throw invalid(field);
  }
}

function assertDisplayName(value: string, format: LocalSubtitleFormat): void {
  const reserved = RESERVED_WINDOWS_LEAF.test(value);
  const invalidValue =
    !value ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
    value === "." ||
    value === ".." ||
    value.trim() !== value ||
    path.isAbsolute(value) ||
    /[\\/:\u0000-\u001f\u007f]/u.test(value) ||
    /[. ]$/u.test(value) ||
    reserved;
  const expectedExtension = format === "SRT" ? ".srt" : ".lrc";
  if (
    invalidValue ||
    path.extname(value).toLowerCase() !== expectedExtension
  ) {
    throw invalid("displayName");
  }
}

function assertFormat(value: string): asserts value is LocalSubtitleFormat {
  if (!(LOCAL_SUBTITLE_FORMATS as readonly string[]).includes(value)) {
    throw invalid("format");
  }
}

function assertOwner(value: LocalSubtitleOwnerKey): void {
  if (
    !value ||
    !Number.isSafeInteger(value.webContentsId) ||
    value.webContentsId < 0 ||
    !value.ownerSessionId ||
    value.ownerSessionId.length > 128 ||
    value.ownerSessionId.trim() !== value.ownerSessionId ||
    /[\u0000-\u001f\u007f]/u.test(value.ownerSessionId)
  ) {
    throw invalid("owner");
  }
}

function assertId(value: string, field: string): void {
  if (
    !value ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(field);
  }
}

function requireAbsolutePath(value: string, field: string): string {
  if (!value || !path.isAbsolute(value)) throw invalid(field);
  return path.resolve(value);
}

function fileIdentity(value: Stats): LocalSubtitleFileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameFileIdentity(
  left: LocalSubtitleFileIdentity,
  right: LocalSubtitleFileIdentity,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function sameFileObjectIdentity(
  left: LocalSubtitleFileObjectIdentity,
  right: LocalSubtitleFileObjectIdentity,
): boolean {
  return sameLocalSubtitleFilesystemObjectIdentity(left, right);
}

function sameDirectoryIdentity(
  left: LocalSubtitleDirectoryIdentity,
  right: LocalSubtitleDirectoryIdentity,
): boolean {
  return sameLocalSubtitleFilesystemObjectIdentity(left, right);
}

function sameOwner(
  left: LocalSubtitleOwnerKey,
  right: LocalSubtitleOwnerKey,
): boolean {
  return left.webContentsId === right.webContentsId &&
    left.ownerSessionId === right.ownerSessionId;
}

function ownerKey(value: LocalSubtitleOwnerKey): string {
  return JSON.stringify([value.webContentsId, value.ownerSessionId]);
}

function ownedTask(owner: LocalSubtitleOwnerKey, taskId: string): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId, taskId]);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(field);
  return value;
}

function addTtl(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt)) {
    throw invalid("expiresAt");
  }
  return expiresAt;
}

function mintOpaqueValue(
  prefix: string,
  factory: () => string,
  exists: (value: string) => boolean,
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const source = factory();
    const value = `${prefix}${source}`;
    if (
      SAFE_TOKEN_SOURCE.test(source) &&
      value.length <= LOCAL_SUBTITLE_LIMITS.maxOpaqueRefChars &&
      !exists(value)
    ) {
      return value;
    }
  }
  throw failure(
    "limit_exceeded",
    "Could not mint a unique local subtitle artifact reference.",
    "artifactRef",
  );
}

function isOpaqueValue(value: string, prefix: string): boolean {
  const source = typeof value === "string" && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : "";
  return Boolean(
    source &&
      SAFE_TOKEN_SOURCE.test(source) &&
      value.length <= LOCAL_SUBTITLE_LIMITS.maxOpaqueRefChars,
  );
}

function invalid(field: string): LocalSubtitleArtifactRegistryError {
  return failure(
    "invalid_ipc_request",
    "Local subtitle artifact request is invalid.",
    field,
  );
}

function artifactExpired(): LocalSubtitleArtifactRegistryError {
  return failure(
    "artifact_expired",
    "Local subtitle artifact reference expired.",
    "artifactRef",
  );
}

function artifactChanged(): LocalSubtitleArtifactRegistryError & {
  readonly code: "artifact_changed";
} {
  return failure(
    "artifact_changed",
    "Local subtitle artifact changed.",
    "artifactRef",
  ) as LocalSubtitleArtifactRegistryError & {
    readonly code: "artifact_changed";
  };
}

function contentTooLarge(): LocalSubtitleArtifactRegistryError & {
  readonly code: "content_too_large";
} {
  return failure(
    "content_too_large",
    "Local subtitle artifact exceeds the supported size.",
    "artifactRef",
  ) as LocalSubtitleArtifactRegistryError & {
    readonly code: "content_too_large";
  };
}

function failure(
  code: LocalSubtitleArtifactRegistryErrorCode,
  message: string,
  field?: string,
): LocalSubtitleArtifactRegistryError {
  return new LocalSubtitleArtifactRegistryError(code, message, field);
}
