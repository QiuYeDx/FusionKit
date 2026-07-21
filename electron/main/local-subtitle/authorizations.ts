import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";

const NOFOLLOW_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const DEFAULT_DRAFT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IMPORT_TTL_MS = 2 * 60 * 1000;

export interface LocalSubtitleOwnerKey {
  readonly webContentsId: number;
  readonly ownerSessionId: string;
}

export type LocalSubtitleAuthorizationErrorCode =
  | "invalid_ipc_request"
  | "owner_released"
  | "authorization_expired"
  | "media_changed"
  | "output_write_failed"
  | "invalid_content"
  | "limit_exceeded";

export class LocalSubtitleAuthorizationError extends Error {
  readonly name = "LocalSubtitleAuthorizationError";
  constructor(
    readonly code: LocalSubtitleAuthorizationErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type LocalSubtitleInputOperation =
  | "probe"
  | "transcribe"
  | "derive_source_output";
export type LocalSubtitleOutputOperation = "write";
export type LocalSubtitleArtifactOperation = "read" | "reveal" | "handoff";

export interface LocalSubtitleFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface LocalSubtitleDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface FileDescriptor {
  readonly path: string;
  readonly displayName: string;
  readonly identity: LocalSubtitleFileIdentity;
}

interface DirectoryDescriptor {
  readonly path: string;
  readonly directoryName: string;
  readonly identity: LocalSubtitleDirectoryIdentity;
}

export interface AuthorizedLocalSubtitleInput {
  readonly fileToken: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly expiresAt: number;
}

export interface ResolvedLocalSubtitleInput {
  readonly filePath: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly identity: LocalSubtitleFileIdentity;
  readonly expiresAt: number;
}

export interface AuthorizedLocalSubtitleOutputDirectory {
  readonly outputDirToken: string;
  readonly directoryName: string;
  readonly expiresAt: number;
}

export interface ResolvedLocalSubtitleOutputDirectory {
  readonly directoryPath: string;
  readonly directoryName: string;
  readonly identity: LocalSubtitleDirectoryIdentity;
  readonly expiresAt: number;
}

interface RegistryOptions {
  readonly draftTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
}

interface Entry<TDescriptor, TOperation extends string> {
  readonly token: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly descriptor: TDescriptor;
  readonly operations: ReadonlySet<TOperation>;
  readonly state: "draft" | "reserved" | "leased";
  readonly expiresAt: number;
  readonly version: number;
  readonly reservationId?: string;
  readonly scopeId?: string;
  readonly draftExpiresAt?: number;
  readonly leaseExpiresAt?: number;
}

interface PreparedLease {
  readonly token: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly version: number;
  readonly scopeId: string;
}

class DraftLeaseRegistry<TDescriptor, TOperation extends string> {
  private readonly entries = new Map<string, Entry<TDescriptor, TOperation>>();
  private readonly scopeTokens = new Map<string, string>();
  private readonly releasedOwners = new Set<string>();
  readonly draftTtlMs: number;
  readonly leaseTtlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;

  constructor(
    options: RegistryOptions,
    private readonly verify: (descriptor: TDescriptor) => Promise<void>,
    private readonly tokenPrefix: string,
  ) {
    this.draftTtlMs = ttl(options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS);
    this.leaseTtlMs = ttl(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  authorizeMany(
    owner: LocalSubtitleOwnerKey,
    descriptors: readonly TDescriptor[],
    operations: readonly TOperation[],
  ): readonly Entry<TDescriptor, TOperation>[] {
    assertOwner(owner);
    this.assertActive(owner);
    if (descriptors.length === 0 || operations.length === 0) {
      throw invalid("files");
    }
    this.sweepExpired();
    const operationSet = new Set(operations);
    if (operationSet.size !== operations.length) throw invalid("operations");
    const tokens = mintTokens(
      descriptors.length,
      this.tokenPrefix,
      this.tokenFactory,
      (candidate) => this.entries.has(candidate),
    );
    const expiresAt = addTtl(this.now(), this.draftTtlMs);
    const entries = descriptors.map<Entry<TDescriptor, TOperation>>(
      (descriptor, index) => ({
        token: tokens[index]!,
        owner: Object.freeze({ ...owner }),
        descriptor,
        operations: operationSet,
        state: "draft",
        expiresAt,
        version: 1,
      }),
    );
    this.assertActive(owner);
    for (const entry of entries) this.entries.set(entry.token, entry);
    return entries;
  }

  async resolveDraft(
    owner: LocalSubtitleOwnerKey,
    token: string,
    op: TOperation,
  ) {
    const entry = this.requireDraft(owner, token, op);
    await this.verifyOrDelete(entry);
    const current = this.requireDraft(owner, token, op);
    if (current.version !== entry.version) throw invalid("token");
    return current;
  }

  revokeDraft(owner: LocalSubtitleOwnerKey, token: string): boolean {
    assertOwner(owner);
    const entry = this.entries.get(token);
    if (!entry || entry.state !== "draft" || !sameOwner(entry.owner, owner)) {
      return false;
    }
    this.entries.delete(token);
    return entry.expiresAt > this.now();
  }

  async prepare(
    owner: LocalSubtitleOwnerKey,
    token: string,
    scopeId: string,
    op: TOperation,
  ) {
    assertId(scopeId, "scopeId");
    const entry = await this.resolveDraft(owner, token, op);
    return { token, owner: { ...owner }, version: entry.version, scopeId };
  }

  reserve(
    prepared: PreparedLease,
    reservationId: string,
    leaseExpiresAt: number,
  ): void {
    const entry = this.entries.get(prepared.token);
    const scopeKey = ownedScope(prepared.owner, prepared.scopeId);
    if (
      !entry ||
      entry.state !== "draft" ||
      entry.version !== prepared.version ||
      !sameOwner(entry.owner, prepared.owner) ||
      this.scopeTokens.has(scopeKey)
    ) {
      throw invalid("token");
    }
    this.assertActive(prepared.owner);
    if (entry.expiresAt <= this.now()) throw expired("token");
    this.entries.set(entry.token, {
      ...entry,
      state: "reserved",
      reservationId,
      scopeId: prepared.scopeId,
      draftExpiresAt: entry.expiresAt,
      leaseExpiresAt,
      version: entry.version + 1,
    });
    this.scopeTokens.set(scopeKey, entry.token);
  }

  assertReserved(reservationId: string, token: string): void {
    const entry = this.entries.get(token);
    if (
      !entry ||
      entry.state !== "reserved" ||
      entry.reservationId !== reservationId
    ) {
      throw invalid("token");
    }
    this.assertActive(entry.owner);
    const now = this.now();
    if (entry.draftExpiresAt! <= now || entry.leaseExpiresAt! <= now) {
      throw expired("token");
    }
  }

  commit(reservationId: string, token: string): void {
    const entry = this.entries.get(token);
    if (
      !entry ||
      entry.state !== "reserved" ||
      entry.reservationId !== reservationId
    ) {
      throw invalid("token");
    }
    this.entries.set(token, {
      ...entry,
      state: "leased",
      expiresAt: entry.leaseExpiresAt!,
      version: entry.version + 1,
    });
  }

  rollback(reservationId: string, token: string): void {
    const entry = this.entries.get(token);
    if (
      !entry ||
      entry.state === "draft" ||
      entry.reservationId !== reservationId
    ) {
      return;
    }
    this.scopeTokens.delete(ownedScope(entry.owner, entry.scopeId!));
    if (
      this.releasedOwners.has(ownerKey(entry.owner)) ||
      entry.draftExpiresAt! <= this.now()
    ) {
      this.entries.delete(token);
      return;
    }
    this.entries.set(token, {
      token,
      owner: entry.owner,
      descriptor: entry.descriptor,
      operations: entry.operations,
      state: "draft",
      expiresAt: entry.draftExpiresAt!,
      version: entry.version + 1,
    });
  }

  async resolveLease(
    owner: LocalSubtitleOwnerKey,
    scopeId: string,
    op: TOperation,
  ) {
    const entry = this.requireLease(owner, scopeId, op);
    await this.verifyOrDelete(entry);
    const current = this.requireLease(owner, scopeId, op);
    if (current.version !== entry.version) throw invalid("scopeId");
    return current;
  }

  async renewLease(
    owner: LocalSubtitleOwnerKey,
    scopeId: string,
    ttlMs = this.leaseTtlMs,
  ) {
    const entry = this.requireLease(owner, scopeId);
    await this.verifyOrDelete(entry);
    const current = this.requireLease(owner, scopeId);
    if (current.version !== entry.version) throw invalid("scopeId");
    const expiresAt = addTtl(this.now(), ttl(ttlMs));
    this.entries.set(current.token, {
      ...current,
      expiresAt,
      version: current.version + 1,
    });
    return expiresAt;
  }

  releaseLease(owner: LocalSubtitleOwnerKey, scopeId: string): boolean {
    const key = ownedScope(owner, scopeId);
    const token = this.scopeTokens.get(key);
    const entry = token ? this.entries.get(token) : undefined;
    if (
      !entry ||
      entry.state !== "leased" ||
      !sameOwner(entry.owner, owner)
    ) {
      return false;
    }
    this.entries.delete(entry.token);
    this.scopeTokens.delete(key);
    return true;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    assertOwner(owner);
    this.releasedOwners.add(ownerKey(owner));
    for (const [token, entry] of this.entries) {
      if (sameOwner(entry.owner, owner)) this.remove(token, entry);
    }
  }

  sweepExpired(): number {
    let count = 0;
    for (const [token, entry] of this.entries) {
      const expiresAt = entry.state === "reserved"
        ? entry.draftExpiresAt!
        : entry.expiresAt;
      if (expiresAt > this.now()) continue;
      this.remove(token, entry);
      count += 1;
    }
    return count;
  }

  private requireDraft(
    owner: LocalSubtitleOwnerKey,
    token: string,
    op: TOperation,
  ) {
    assertOwner(owner);
    this.assertActive(owner);
    const entry = this.entries.get(token);
    if (
      !entry ||
      entry.state !== "draft" ||
      !sameOwner(entry.owner, owner)
    ) {
      throw invalid("token");
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      throw expired("token");
    }
    if (!entry.operations.has(op)) throw invalid("operation");
    return entry;
  }

  private requireLease(
    owner: LocalSubtitleOwnerKey,
    scopeId: string,
    op?: TOperation,
  ) {
    assertOwner(owner);
    this.assertActive(owner);
    const token = this.scopeTokens.get(ownedScope(owner, scopeId));
    const entry = token ? this.entries.get(token) : undefined;
    if (
      !entry ||
      entry.state !== "leased" ||
      !sameOwner(entry.owner, owner)
    ) {
      throw invalid("scopeId");
    }
    if (entry.expiresAt <= this.now()) {
      this.remove(entry.token, entry);
      throw expired("scopeId");
    }
    if (op && !entry.operations.has(op)) throw invalid("operation");
    return entry;
  }

  private async verifyOrDelete(
    entry: Entry<TDescriptor, TOperation>,
  ): Promise<void> {
    try {
      await this.verify(entry.descriptor);
    } catch (error) {
      this.remove(entry.token, entry);
      throw error;
    }
  }

  private assertActive(owner: LocalSubtitleOwnerKey): void {
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure("owner_released", "Owner released.", "owner");
    }
  }

  private remove(token: string, entry: Entry<TDescriptor, TOperation>): void {
    this.entries.delete(token);
    if (entry.scopeId) {
      this.scopeTokens.delete(ownedScope(entry.owner, entry.scopeId));
    }
  }
}

export class LocalSubtitleInputAuthorizationRegistry {
  private readonly core: DraftLeaseRegistry<
    FileDescriptor,
    LocalSubtitleInputOperation
  >;

  constructor(options: RegistryOptions = {}) {
    this.core = new DraftLeaseRegistry(options, verifyFile, "ls-input-");
  }

  async authorizeMany(
    owner: LocalSubtitleOwnerKey,
    paths: readonly string[],
    operations: readonly LocalSubtitleInputOperation[] = [
      "probe",
      "transcribe",
      "derive_source_output",
    ],
  ) {
    const descriptors = await Promise.all(paths.map(inspectFile));
    const identityCount = new Set(
      descriptors.map((value) => identityKey(value.identity)),
    ).size;
    if (identityCount !== descriptors.length) throw invalid("files");
    return this.core
      .authorizeMany(owner, descriptors, operations)
      .map((entry) =>
        Object.freeze({
          fileToken: entry.token,
          displayName: entry.descriptor.displayName,
          byteSize: entry.descriptor.identity.size,
          expiresAt: entry.expiresAt,
        })
      );
  }

  async authorize(
    owner: LocalSubtitleOwnerKey,
    filePath: string,
    operations?: readonly LocalSubtitleInputOperation[],
  ) {
    return (await this.authorizeMany(owner, [filePath], operations))[0]!;
  }

  async resolveDraft(
    owner: LocalSubtitleOwnerKey,
    token: string,
    op: LocalSubtitleInputOperation,
  ) {
    return resolvedInput(await this.core.resolveDraft(owner, token, op));
  }

  revokeDraft(owner: LocalSubtitleOwnerKey, token: string) {
    return this.core.revokeDraft(owner, token);
  }

  async resolveTaskLease(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
    op: LocalSubtitleInputOperation,
  ) {
    return resolvedInput(await this.core.resolveLease(owner, taskId, op));
  }

  renewTaskLease(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
    ttlMs?: number,
  ) {
    return this.core.renewLease(owner, taskId, ttlMs);
  }

  releaseTaskLease(owner: LocalSubtitleOwnerKey, taskId: string) {
    return this.core.releaseLease(owner, taskId);
  }

  releaseOwner(owner: LocalSubtitleOwnerKey) {
    this.core.releaseOwner(owner);
  }

  sweepExpired() {
    return this.core.sweepExpired();
  }

  get leaseTtlMs() {
    return this.core.leaseTtlMs;
  }

  _prepare(owner: LocalSubtitleOwnerKey, token: string, taskId: string) {
    return this.core.prepare(owner, token, taskId, "transcribe");
  }

  _reserve(value: PreparedLease, id: string, expiry: number) {
    this.core.reserve(value, id, expiry);
  }

  _assert(id: string, token: string) {
    this.core.assertReserved(id, token);
  }

  _commit(id: string, token: string) {
    this.core.commit(id, token);
  }

  _rollback(id: string, token: string) {
    this.core.rollback(id, token);
  }
}

export class LocalSubtitleOutputDirectoryAuthorizationRegistry {
  private readonly core: DraftLeaseRegistry<
    DirectoryDescriptor,
    LocalSubtitleOutputOperation
  >;

  constructor(options: RegistryOptions = {}) {
    this.core = new DraftLeaseRegistry(options, verifyDirectory, "ls-output-");
  }

  async authorize(owner: LocalSubtitleOwnerKey, directoryPath: string) {
    const descriptor = await inspectDirectory(directoryPath);
    const [entry] = this.core.authorizeMany(owner, [descriptor], ["write"]);
    return Object.freeze({
      outputDirToken: entry!.token,
      directoryName: entry!.descriptor.directoryName,
      expiresAt: entry!.expiresAt,
    });
  }

  async resolveDraft(owner: LocalSubtitleOwnerKey, token: string) {
    return resolvedOutput(await this.core.resolveDraft(owner, token, "write"));
  }

  revokeDraft(owner: LocalSubtitleOwnerKey, token: string) {
    return this.core.revokeDraft(owner, token);
  }

  async resolveBatchLease(owner: LocalSubtitleOwnerKey, batchId: string) {
    return resolvedOutput(await this.core.resolveLease(owner, batchId, "write"));
  }

  renewBatchLease(
    owner: LocalSubtitleOwnerKey,
    batchId: string,
    ttlMs?: number,
  ) {
    return this.core.renewLease(owner, batchId, ttlMs);
  }

  releaseBatchLease(owner: LocalSubtitleOwnerKey, batchId: string) {
    return this.core.releaseLease(owner, batchId);
  }

  releaseOwner(owner: LocalSubtitleOwnerKey) {
    this.core.releaseOwner(owner);
  }

  sweepExpired() {
    return this.core.sweepExpired();
  }

  get leaseTtlMs() {
    return this.core.leaseTtlMs;
  }

  _prepare(owner: LocalSubtitleOwnerKey, token: string, batchId: string) {
    return this.core.prepare(owner, token, batchId, "write");
  }

  _reserve(value: PreparedLease, id: string, expiry: number) {
    this.core.reserve(value, id, expiry);
  }

  _assert(id: string, token: string) {
    this.core.assertReserved(id, token);
  }

  _commit(id: string, token: string) {
    this.core.commit(id, token);
  }

  _rollback(id: string, token: string) {
    this.core.rollback(id, token);
  }
}

export interface ReserveLocalSubtitleBatchCapabilitiesOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly batchId: string;
  readonly inputs: readonly {
    readonly fileToken: string;
    readonly taskId: string;
  }[];
  readonly outputDirToken?: string;
  readonly leaseTtlMs?: number;
}

export class LocalSubtitleBatchCapabilityTransaction {
  private pending = true;
  constructor(
    private readonly input: LocalSubtitleInputAuthorizationRegistry,
    private readonly output: LocalSubtitleOutputDirectoryAuthorizationRegistry,
    private readonly reservationId: string,
    private readonly inputTokens: readonly string[],
    private readonly outputToken: string | undefined,
    readonly batchId: string,
    readonly taskIds: readonly string[],
    readonly expiresAt: number,
  ) {}

  commit() {
    if (!this.pending) throw invalid("transaction");
    try {
      this.inputTokens.forEach((token) =>
        this.input._assert(this.reservationId, token)
      );
      if (this.outputToken) {
        this.output._assert(this.reservationId, this.outputToken);
      }
      this.inputTokens.forEach((token) =>
        this.input._commit(this.reservationId, token)
      );
      if (this.outputToken) {
        this.output._commit(this.reservationId, this.outputToken);
      }
      this.pending = false;
      return Object.freeze({
        batchId: this.batchId,
        taskIds: Object.freeze([...this.taskIds]),
        expiresAt: this.expiresAt,
      });
    } catch (error) {
      this.rollbackInternal();
      throw error;
    }
  }
  rollback() {
    if (this.pending) this.rollbackInternal();
  }

  private rollbackInternal() {
    this.inputTokens.forEach((token) =>
      this.input._rollback(this.reservationId, token)
    );
    if (this.outputToken) {
      this.output._rollback(this.reservationId, this.outputToken);
    }
    this.pending = false;
  }
}

export class LocalSubtitleCapabilityLeaseCoordinator {
  constructor(
    private readonly input: LocalSubtitleInputAuthorizationRegistry,
    private readonly output: LocalSubtitleOutputDirectoryAuthorizationRegistry,
    private readonly options: {
      readonly now?: () => number;
      readonly reservationIdFactory?: () => string;
    } = {},
  ) {}

  async reserveBatch(options: ReserveLocalSubtitleBatchCapabilitiesOptions) {
    assertId(options.batchId, "batchId");
    const fileTokenCount = new Set(
      options.inputs.map((value) => value.fileToken),
    ).size;
    const taskIdCount = new Set(
      options.inputs.map((value) => value.taskId),
    ).size;
    if (
      !options.inputs.length ||
      fileTokenCount !== options.inputs.length ||
      taskIdCount !== options.inputs.length
    ) {
      throw invalid("inputs");
    }
    const preparedInputs = await Promise.all(
      options.inputs.map((value) =>
        this.input._prepare(options.owner, value.fileToken, value.taskId)
      ),
    );
    const preparedOutput = options.outputDirToken
      ? await this.output._prepare(
        options.owner,
        options.outputDirToken,
        options.batchId,
      )
      : undefined;
    const now = (this.options.now ?? Date.now)();
    const defaultLeaseTtlMs = Math.min(
      this.input.leaseTtlMs,
      this.output.leaseTtlMs,
    );
    const expiresAt = addTtl(
      now,
      ttl(options.leaseTtlMs ?? defaultLeaseTtlMs),
    );
    const reservationId = mintTokens(
      1,
      "ls-reservation-",
      this.options.reservationIdFactory ?? randomUUID,
      () => false,
    )[0]!;
    const reserved: string[] = [];
    try {
      for (const value of preparedInputs) {
        this.input._reserve(value, reservationId, expiresAt);
        reserved.push(value.token);
      }
      if (preparedOutput) {
        this.output._reserve(preparedOutput, reservationId, expiresAt);
      }
    } catch (error) {
      reserved.forEach((token) => this.input._rollback(reservationId, token));
      if (preparedOutput) {
        this.output._rollback(reservationId, preparedOutput.token);
      }
      throw error;
    }
    return new LocalSubtitleBatchCapabilityTransaction(
      this.input,
      this.output,
      reservationId,
      preparedInputs.map((value) => value.token),
      preparedOutput?.token,
      options.batchId,
      preparedInputs.map((value) => value.scopeId),
      expiresAt,
    );
  }
}

interface OpaqueEntry<T, TOperation extends string> {
  readonly owner: LocalSubtitleOwnerKey;
  readonly value: T;
  readonly operations: ReadonlySet<TOperation>;
  readonly expiresAt: number;
}

interface ArtifactRegistryOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
}

export class LocalSubtitleArtifactAuthorizationRegistry<T> {
  private readonly entries = new Map<
    string,
    OpaqueEntry<T, LocalSubtitleArtifactOperation>
  >();
  private readonly releasedOwners = new Set<string>();

  constructor(private readonly options: ArtifactRegistryOptions = {}) {}

  register(
    owner: LocalSubtitleOwnerKey,
    value: T,
    operations: readonly LocalSubtitleArtifactOperation[] = [
      "read",
      "reveal",
      "handoff",
    ],
  ) {
    assertOwner(owner);
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure("owner_released", "Owner released.", "owner");
    }
    this.sweepExpired();
    const allowedOperations = ["read", "reveal", "handoff"] as const;
    const hasInvalidOperation = operations.some(
      (operation) => !allowedOperations.includes(operation),
    );
    if (
      !operations.length ||
      new Set(operations).size !== operations.length ||
      hasInvalidOperation
    ) {
      throw invalid("operations");
    }
    const token = mintTokens(
      1,
      "ls-artifact-",
      this.options.tokenFactory ?? randomUUID,
      (value) => this.entries.has(value),
    )[0]!;
    const expiresAt = addTtl(
      (this.options.now ?? Date.now)(),
      ttl(this.options.ttlMs ?? DEFAULT_ARTIFACT_TTL_MS),
    );
    this.entries.set(token, {
      owner: { ...owner },
      value,
      operations: new Set(operations),
      expiresAt,
    });
    return Object.freeze({ artifactRef: token, expiresAt });
  }

  resolve(
    owner: LocalSubtitleOwnerKey,
    token: string,
    op: LocalSubtitleArtifactOperation,
  ) {
    assertOwner(owner);
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure("owner_released", "Owner released.", "owner");
    }
    const entry = this.entries.get(token);
    if (
      !entry ||
      !sameOwner(entry.owner, owner) ||
      !entry.operations.has(op)
    ) {
      throw invalid("artifactRef");
    }
    if (entry.expiresAt <= (this.options.now ?? Date.now)()) {
      this.entries.delete(token);
      throw expired("artifactRef");
    }
    return entry.value;
  }

  revoke(owner: LocalSubtitleOwnerKey, token: string) {
    assertOwner(owner);
    const entry = this.entries.get(token);
    return Boolean(
      entry && sameOwner(entry.owner, owner) && this.entries.delete(token),
    );
  }

  releaseOwner(owner: LocalSubtitleOwnerKey) {
    assertOwner(owner);
    this.releasedOwners.add(ownerKey(owner));
    for (const [token, entry] of this.entries) {
      if (sameOwner(entry.owner, owner)) this.entries.delete(token);
    }
  }

  sweepExpired() {
    let count = 0;
    const now = (this.options.now ?? Date.now)();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(token);
      count += 1;
    }
    return count;
  }
}

interface ImportTokenRegistryOptions {
  readonly ttlMs?: number;
  readonly maxTokens?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
}

interface ImportTokenValue<T> {
  readonly value: T;
  readonly bytes: number;
  readonly dispose: (value: T) => void;
}

type ImportTokenEntry<T> = OpaqueEntry<ImportTokenValue<T>, "consume">;

export class LocalSubtitleImportTokenRegistry<T> {
  private readonly entries = new Map<string, ImportTokenEntry<T>>();
  private readonly releasedOwners = new Set<string>();
  private bytes = 0;

  constructor(private readonly options: ImportTokenRegistryOptions = {}) {}

  mint(
    owner: LocalSubtitleOwnerKey,
    value: T,
    bytes: number,
    dispose: (value: T) => void,
  ) {
    assertOwner(owner);
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure("owner_released", "Owner released.", "owner");
    }
    this.sweepExpired();
    const exceedsCount = this.entries.size >= (this.options.maxTokens ?? 8);
    const exceedsBytes =
      this.bytes + bytes > (this.options.maxBytes ?? 64 * 1024 * 1024);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || exceedsCount || exceedsBytes) {
      throw failure(
        "limit_exceeded",
        "Import token quota exceeded.",
        "importToken",
      );
    }
    const token = mintTokens(
      1,
      "ls-import-",
      this.options.tokenFactory ?? randomUUID,
      (candidate) => this.entries.has(candidate),
    )[0]!;
    const expiresAt = addTtl(
      (this.options.now ?? Date.now)(),
      ttl(this.options.ttlMs ?? DEFAULT_IMPORT_TTL_MS),
    );
    this.entries.set(token, {
      owner: { ...owner },
      value: { value, bytes, dispose },
      operations: new Set(["consume"]),
      expiresAt,
    });
    this.bytes += bytes;
    return Object.freeze({ translationImportToken: token, expiresAt });
  }

  async consume<R>(
    owner: LocalSubtitleOwnerKey,
    token: string,
    consumer: (value: T) => R | Promise<R>,
  ) {
    assertOwner(owner);
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw failure("owner_released", "Owner released.", "owner");
    }
    const entry = this.entries.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) throw invalid("importToken");
    this.entries.delete(token);
    this.bytes -= entry.value.bytes;
    try {
      if (entry.expiresAt <= (this.options.now ?? Date.now)()) {
        throw expired("importToken");
      }
      return await consumer(entry.value.value);
    } finally {
      try {
        entry.value.dispose(entry.value.value);
      } catch {
        // Disposal failures must not make a consumed token reusable.
      }
    }
  }

  revoke(owner: LocalSubtitleOwnerKey, token: string) {
    assertOwner(owner);
    const entry = this.entries.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) return false;
    this.finalize(token, entry);
    return true;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey) {
    assertOwner(owner);
    this.releasedOwners.add(ownerKey(owner));
    for (const [token, entry] of [...this.entries]) {
      if (sameOwner(entry.owner, owner)) this.finalize(token, entry);
    }
  }

  sweepExpired() {
    let count = 0;
    const now = (this.options.now ?? Date.now)();
    for (const [token, entry] of [...this.entries]) {
      if (entry.expiresAt > now) continue;
      this.finalize(token, entry);
      count += 1;
    }
    return count;
  }

  private finalize(token: string, entry: ImportTokenEntry<T>) {
    if (!this.entries.delete(token)) return;
    this.bytes = Math.max(0, this.bytes - entry.value.bytes);
    try {
      entry.value.dispose(entry.value.value);
    } catch {
      // Disposal failures must not make a revoked token reusable.
    }
  }
}

export function resolveSafeLocalSubtitleChildPath(root: string, leaf: string): string {
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
  const unsafeLeaf =
    !path.isAbsolute(root) ||
    !leaf ||
    leaf.length > 255 ||
    leaf === "." ||
    leaf === ".." ||
    path.isAbsolute(leaf) ||
    /[\\/:\u0000-\u001f\u007f]/.test(leaf) ||
    /[. ]$/.test(leaf) ||
    reserved.test(leaf);
  if (unsafeLeaf) {
    throw failure("output_write_failed", "Unsafe output leaf.", "leaf");
  }
  const parent = path.resolve(root);
  const child = path.resolve(parent, leaf);
  const relative = path.relative(parent, child);
  const escaped =
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  if (escaped) {
    throw failure(
      "output_write_failed",
      "Output escaped its authorization.",
      "leaf",
    );
  }
  return child;
}

async function inspectFile(filePath: string): Promise<FileDescriptor> {
  const absolute = absolutePath(filePath, "file");
  try {
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    const canonical = await realpath(absolute);
    const handle = await open(canonical, NOFOLLOW_READ);
    try {
      const opened = await handle.stat();
      const after = await lstat(absolute);
      if (
        !opened.isFile() ||
        after.isSymbolicLink() ||
        !sameFile(before, opened) ||
        !sameFile(before, after)
      ) {
        throw new Error();
      }
      if (
        opened.size === 0 ||
        opened.size > LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes
      ) {
        throw failure(
          "limit_exceeded",
          "Selected input size is outside the supported range.",
          "file",
        );
      }
      return Object.freeze({
        path: canonical,
        displayName: safeDisplayName(path.basename(absolute), "file"),
        identity: Object.freeze(fileIdentity(opened)),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LocalSubtitleAuthorizationError) throw error;
    throw failure(
      "media_changed",
      "Selected input is unavailable or unsafe.",
      "file",
    );
  }
}

async function verifyFile(value: FileDescriptor): Promise<void> {
  try {
    const before = await lstat(value.path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameFileIdentity(fileIdentity(before), value.identity)
    ) {
      throw new Error();
    }
    const handle = await open(value.path, NOFOLLOW_READ);
    try {
      if (!sameFileIdentity(fileIdentity(await handle.stat()), value.identity)) {
        throw new Error();
      }
    } finally {
      await handle.close();
    }
  } catch {
    throw failure("media_changed", "Authorized input changed.", "fileToken");
  }
}

async function inspectDirectory(directoryPath: string): Promise<DirectoryDescriptor> {
  const absolute = absolutePath(directoryPath, "outputDir");
  try {
    const before = await lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error();
    const canonical = await realpath(absolute);
    const after = await lstat(canonical);
    const lexicalAfter = await lstat(absolute);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      lexicalAfter.isSymbolicLink() ||
      !sameDirectory(before, after) ||
      !sameDirectory(before, lexicalAfter)
    ) {
      throw new Error();
    }
    const basename = path.basename(absolute);
    return Object.freeze({
      path: canonical,
      directoryName: basename
        ? safeDisplayName(basename, "outputDir")
        : "Filesystem root",
      identity: Object.freeze(directoryIdentity(after)),
    });
  } catch (error) {
    if (error instanceof LocalSubtitleAuthorizationError) throw error;
    throw failure(
      "output_write_failed",
      "Selected output directory is unavailable or unsafe.",
      "outputDir",
    );
  }
}

async function verifyDirectory(value: DirectoryDescriptor): Promise<void> {
  try {
    const current = await lstat(value.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(directoryIdentity(current), value.identity)
    ) {
      throw new Error();
    }
  } catch {
    throw failure(
      "output_write_failed",
      "Authorized output directory changed.",
      "outputDirToken",
    );
  }
}

function resolvedInput(
  entry: Entry<FileDescriptor, LocalSubtitleInputOperation>,
): ResolvedLocalSubtitleInput {
  return Object.freeze({
    filePath: entry.descriptor.path,
    displayName: entry.descriptor.displayName,
    byteSize: entry.descriptor.identity.size,
    identity: entry.descriptor.identity,
    expiresAt: entry.expiresAt,
  });
}

function resolvedOutput(
  entry: Entry<DirectoryDescriptor, LocalSubtitleOutputOperation>,
): ResolvedLocalSubtitleOutputDirectory {
  return Object.freeze({
    directoryPath: entry.descriptor.path,
    directoryName: entry.descriptor.directoryName,
    identity: entry.descriptor.identity,
    expiresAt: entry.expiresAt,
  });
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

function directoryIdentity(value: Stats): LocalSubtitleDirectoryIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  };
}

function sameFile(a: Stats, b: Stats) {
  return sameFileIdentity(fileIdentity(a), fileIdentity(b));
}

function sameFileIdentity(
  a: LocalSubtitleFileIdentity,
  b: LocalSubtitleFileIdentity,
) {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
}

function sameDirectory(a: Stats, b: Stats) {
  return sameDirectoryIdentity(directoryIdentity(a), directoryIdentity(b));
}

function sameDirectoryIdentity(
  a: LocalSubtitleDirectoryIdentity,
  b: LocalSubtitleDirectoryIdentity,
) {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs;
}

function identityKey(value: LocalSubtitleFileIdentity) {
  return JSON.stringify(value);
}

function safeDisplayName(value: string, field: string) {
  const unsafe =
    !value ||
    value === "." ||
    value === ".." ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
    !value.trim() ||
    /[\\/\u0000-\u001f\u007f]/.test(value);
  if (unsafe) {
    throw failure(
      "invalid_content",
      "Selected item has an unsafe display name.",
      field,
    );
  }
  return value;
}

function sameOwner(a: LocalSubtitleOwnerKey, b: LocalSubtitleOwnerKey) {
  return a.webContentsId === b.webContentsId &&
    a.ownerSessionId === b.ownerSessionId;
}

function ownerKey(value: LocalSubtitleOwnerKey) {
  return JSON.stringify([value.webContentsId, value.ownerSessionId]);
}

function ownedScope(owner: LocalSubtitleOwnerKey, scope: string) {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId, scope]);
}

function assertOwner(value: LocalSubtitleOwnerKey) {
  const invalidOwner =
    !Number.isSafeInteger(value.webContentsId) ||
    value.webContentsId < 0 ||
    !value.ownerSessionId ||
    value.ownerSessionId.length > 128 ||
    value.ownerSessionId.trim() !== value.ownerSessionId ||
    /[\u0000-\u001f\u007f]/.test(value.ownerSessionId);
  if (invalidOwner) throw invalid("owner");
}

function assertId(value: string, field: string) {
  if (
    !value ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid(field);
  }
}

function absolutePath(value: string, field: string) {
  if (!path.isAbsolute(value)) throw invalid(field);
  return path.resolve(value);
}

function ttl(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid("ttlMs");
  return value;
}

function addTtl(now: number, value: number) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + value)) {
    throw invalid("expiresAt");
  }
  return now + value;
}

function mintTokens(
  count: number,
  prefix: string,
  factory: () => string,
  exists: (token: string) => boolean,
) {
  const result: string[] = [];
  const pending = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    let token: string | undefined;
    for (let tries = 0; tries < 16; tries += 1) {
      const raw = factory();
      const value = `${prefix}${raw}`;
      if (
        /^[A-Za-z0-9_-]+$/.test(raw) &&
        value.length <= 128 &&
        !exists(value) &&
        !pending.has(value)
      ) {
        token = value;
        break;
      }
    }
    if (!token) {
      throw failure(
        "limit_exceeded",
        "Could not mint a unique authorization.",
        "token",
      );
    }
    result.push(token);
    pending.add(token);
  }
  return result;
}

function invalid(field: string) {
  return failure(
    "invalid_ipc_request",
    "Local subtitle authorization is invalid.",
    field,
  );
}

function expired(field: string) {
  return failure(
    "authorization_expired",
    "Local subtitle authorization expired.",
    field,
  );
}

function failure(
  code: LocalSubtitleAuthorizationErrorCode,
  message: string,
  field?: string,
) {
  return new LocalSubtitleAuthorizationError(code, message, field);
}
