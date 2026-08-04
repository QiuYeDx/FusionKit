import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  LOCAL_SUBTITLE_BACKENDS,
  LOCAL_SUBTITLE_BATCH_STATUSES,
  LOCAL_SUBTITLE_ERROR_CODES,
  LOCAL_SUBTITLE_FORMATS,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_TASK_STAGES,
  LOCAL_SUBTITLE_TASK_STATUSES,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleErrorCode,
  type LocalSubtitleFormat,
  type LocalSubtitleRecoveredSessionSummary,
  type LocalSubtitleTaskStage,
} from "@/type/localSubtitle";
import { localSubtitleRecoveredSessionSummarySchema } from "@/type/localSubtitleIpc";

const SESSION_SUMMARY_SCHEMA_VERSION = 1 as const;
const MAX_SESSION_SUMMARY_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const LOCAL_SUBTITLE_SESSION_SUMMARY_POLICY = Object.freeze({
  schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
  fileName: "session-summary.v1.json",
  maxBytes: MAX_SESSION_SUMMARY_BYTES,
  privateDirectoryMode: PRIVATE_DIRECTORY_MODE,
  privateFileMode: PRIVATE_FILE_MODE,
} as const);

export const LOCAL_SUBTITLE_PERSISTED_TASK_STATUSES = [
  ...LOCAL_SUBTITLE_TASK_STATUSES,
  "interrupted",
] as const;
export type LocalSubtitlePersistedTaskStatus =
  (typeof LOCAL_SUBTITLE_PERSISTED_TASK_STATUSES)[number];

export const LOCAL_SUBTITLE_PERSISTED_BATCH_STATUSES = [
  ...LOCAL_SUBTITLE_BATCH_STATUSES,
  "interrupted",
] as const;
export type LocalSubtitlePersistedBatchStatus =
  (typeof LOCAL_SUBTITLE_PERSISTED_BATCH_STATUSES)[number];

export interface LocalSubtitlePersistedArtifactResult {
  readonly format: LocalSubtitleFormat;
  readonly status: "committed" | "failed" | "skipped";
  readonly errorCode?: LocalSubtitleErrorCode;
}

export interface LocalSubtitlePersistedTaskSummary {
  readonly taskId: string;
  readonly batchId: string;
  readonly generation: number;
  readonly displayName: string;
  readonly status: LocalSubtitlePersistedTaskStatus;
  readonly stage: LocalSubtitleTaskStage;
  readonly formats: readonly LocalSubtitleFormat[];
  readonly backend: (typeof LOCAL_SUBTITLE_BACKENDS)[number];
  readonly artifactResults: readonly LocalSubtitlePersistedArtifactResult[];
  readonly errorCode?: LocalSubtitleErrorCode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalSubtitlePersistedBatchSummary {
  readonly batchId: string;
  readonly status: LocalSubtitlePersistedBatchStatus;
  readonly tasks: readonly LocalSubtitlePersistedTaskSummary[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalSubtitleResourceWatermarks {
  readonly peakResidentBytes: number;
  readonly peakHeapUsedBytes: number;
  readonly minimumAvailableDiskBytes: number;
  readonly sampledAt: string;
}

export interface LocalSubtitleSessionSummaryManifest {
  readonly schemaVersion: typeof SESSION_SUMMARY_SCHEMA_VERSION;
  readonly build: Readonly<{
    engine: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.id;
    version: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version;
    commit: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit;
  }>;
  readonly batches: readonly LocalSubtitlePersistedBatchSummary[];
  readonly resourceWatermarks?: LocalSubtitleResourceWatermarks;
  readonly updatedAt: string;
}

export type LocalSubtitleSessionSummaryDiagnosticCode =
  | "summary_invalid"
  | "summary_read_failed"
  | "summary_write_failed"
  | "resource_probe_failed";

export interface LocalSubtitleSessionSummaryDiagnostic {
  readonly code: LocalSubtitleSessionSummaryDiagnosticCode;
  readonly operation: "initialize" | "persist" | "resource_probe";
  readonly occurredAt: string;
}

export interface LocalSubtitleSessionSummarySink {
  capture(batches: readonly LocalSubtitleBatchSummary[]): void;
  getRecoveredSessionSummary?(): LocalSubtitleRecoveredSessionSummary | undefined;
}

export interface LocalSubtitleSessionSummaryStoreOptions {
  readonly managedResourceRoot: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly memoryUsage?: () => Readonly<{ readonly rss: number; readonly heapUsed: number }>;
  readonly availableBytes?: (directory: string) => number;
  readonly syncParentDirectory?: (directory: string) => void;
}

const idSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxIdChars)
  .regex(ID_PATTERN);
const isoTimestampSchema = z.string().datetime({ offset: true });
const artifactResultSchema = z
  .object({
    format: z.enum(LOCAL_SUBTITLE_FORMATS),
    status: z.enum(["committed", "failed", "skipped"]),
    errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
  })
  .strict();
const persistedTaskSchema = z
  .object({
    taskId: idSchema,
    batchId: idSchema,
    generation: z.number().int().safe().positive(),
    displayName: z
      .string()
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars)
      .regex(/^media-[A-Za-z0-9_-]{1,32}(?:\.[A-Za-z0-9]{1,12})?$/u),
    status: z.enum(LOCAL_SUBTITLE_PERSISTED_TASK_STATUSES),
    stage: z.enum(LOCAL_SUBTITLE_TASK_STAGES),
    formats: z
      .array(z.enum(LOCAL_SUBTITLE_FORMATS))
      .min(1)
      .max(LOCAL_SUBTITLE_FORMATS.length),
    backend: z.enum(LOCAL_SUBTITLE_BACKENDS),
    artifactResults: z
      .array(artifactResultSchema)
      .max(LOCAL_SUBTITLE_FORMATS.length),
    errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
const persistedBatchSchema = z
  .object({
    batchId: idSchema,
    status: z.enum(LOCAL_SUBTITLE_PERSISTED_BATCH_STATUSES),
    tasks: z.array(persistedTaskSchema).min(1).max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.tasks.some((task) => task.batchId !== batch.batchId)) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Persisted tasks must belong to their enclosing batch.",
      });
    }
  });
const resourceWatermarksSchema = z
  .object({
    peakResidentBytes: z.number().int().safe().nonnegative(),
    peakHeapUsedBytes: z.number().int().safe().nonnegative(),
    minimumAvailableDiskBytes: z.number().int().safe().nonnegative(),
    sampledAt: isoTimestampSchema,
  })
  .strict();
const sessionSummaryManifestSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SUMMARY_SCHEMA_VERSION),
    build: z
      .object({
        engine: z.literal(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.id),
        version: z.literal(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version),
        commit: z.literal(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit),
      })
      .strict(),
    batches: z
      .array(persistedBatchSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxSessionBatches),
    resourceWatermarks: resourceWatermarksSchema.optional(),
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const batchIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const [batchIndex, batch] of manifest.batches.entries()) {
      if (batchIds.has(batch.batchId)) {
        context.addIssue({
          code: "custom",
          path: ["batches", batchIndex, "batchId"],
          message: "Persisted batch ids must be unique.",
        });
      }
      batchIds.add(batch.batchId);
      for (const [taskIndex, task] of batch.tasks.entries()) {
        if (taskIds.has(task.taskId)) {
          context.addIssue({
            code: "custom",
            path: ["batches", batchIndex, "tasks", taskIndex, "taskId"],
            message: "Persisted task ids must be unique.",
          });
        }
        taskIds.add(task.taskId);
      }
    }
  });

interface DirectoryProof {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly mode: number;
}

class LocalSubtitleSessionSummaryFileRepository {
  readonly filePath: string;
  readonly #root: DirectoryProof;
  readonly #idFactory: () => string;
  readonly #syncParentDirectory: (directory: string) => void;

  constructor(
    managedResourceRoot: string,
    options: Pick<
      LocalSubtitleSessionSummaryStoreOptions,
      "idFactory" | "syncParentDirectory"
    >,
  ) {
    const root = validateManagedRoot(managedResourceRoot);
    mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    this.#root = readPrivateDirectoryProof(root);
    this.filePath = path.join(
      root,
      LOCAL_SUBTITLE_SESSION_SUMMARY_POLICY.fileName,
    );
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#syncParentDirectory =
      options.syncParentDirectory ?? syncParentDirectory;
  }

  load(): LocalSubtitleSessionSummaryManifest | undefined {
    this.#verifyRoot();
    let stats: Stats;
    try {
      stats = lstatSync(this.filePath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "read",
        "The local subtitle session summary could not be read.",
        error,
      );
    }
    assertPrivateSummaryFile(stats);
    if (stats.size <= 0 || stats.size > MAX_SESSION_SUMMARY_BYTES) {
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The local subtitle session summary is invalid.",
      );
    }

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle: number | undefined;
    try {
      handle = openSync(this.filePath, fsConstants.O_RDONLY | noFollow);
      const before = fstatSync(handle);
      assertSameFileObject(stats, before);
      const bytes = readFileSync(handle);
      const after = fstatSync(handle);
      assertSameFileObject(before, after);
      if (bytes.byteLength <= 0 || bytes.byteLength > MAX_SESSION_SUMMARY_BYTES) {
        throw new Error("The session summary byte length is invalid.");
      }
      const parsed = sessionSummaryManifestSchema.safeParse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (!parsed.success) throw new Error("The session summary schema is invalid.");
      return freezeValue(parsed.data);
    } catch (error) {
      if (error instanceof LocalSubtitleSessionSummaryRepositoryError) throw error;
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The local subtitle session summary is invalid.",
        error,
      );
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  replace(manifest: LocalSubtitleSessionSummaryManifest): void {
    const parsed = sessionSummaryManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The local subtitle session summary is invalid.",
      );
    }
    const payload = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_SESSION_SUMMARY_BYTES) {
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The local subtitle session summary is too large.",
      );
    }

    this.#verifyRoot();
    const temporary = path.join(
      this.#root.absolutePath,
      `.${LOCAL_SUBTITLE_SESSION_SUMMARY_POLICY.fileName}.${validateUuid(this.#idFactory())}.tmp`,
    );
    let handle: number | undefined;
    let renamed = false;
    try {
      handle = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        PRIVATE_FILE_MODE,
      );
      writeFileSync(handle, payload, "utf8");
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      this.#verifyRoot();
      renameSync(temporary, this.filePath);
      renamed = true;
      this.#syncParentDirectory(this.#root.absolutePath);
      const committed = lstatSync(this.filePath);
      assertPrivateSummaryFile(committed);
      if (committed.size !== Buffer.byteLength(payload, "utf8")) {
        throw new Error("The committed session summary size changed.");
      }
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
          // Ignore an absent or already-cleaned temporary file.
        }
      } else {
        try {
          if (readFileSync(this.filePath, "utf8") === payload) return;
        } catch {
          // Preserve uncertainty after the rename boundary.
        }
      }
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "write",
        "The local subtitle session summary could not be updated.",
        error,
      );
    }
  }

  #verifyRoot(): void {
    const current = readPrivateDirectoryProof(this.#root.absolutePath);
    if (
      current.realPath !== this.#root.realPath ||
      current.dev !== this.#root.dev ||
      current.ino !== this.#root.ino ||
      current.birthtimeMs !== this.#root.birthtimeMs ||
      current.mode !== this.#root.mode
    ) {
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The local subtitle session summary root changed identity.",
      );
    }
  }
}

class LocalSubtitleSessionSummaryRepositoryError extends Error {
  readonly name = "LocalSubtitleSessionSummaryRepositoryError";

  constructor(
    readonly code: "invalid" | "read" | "write",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export class LocalSubtitleSessionSummaryStore
  implements LocalSubtitleSessionSummarySink
{
  readonly #root: string;
  readonly #now: () => Date;
  readonly #memoryUsage: () => Readonly<{ readonly rss: number; readonly heapUsed: number }>;
  readonly #availableBytes: (directory: string) => number;
  readonly #repository: LocalSubtitleSessionSummaryFileRepository;
  #initialized = false;
  #disabled = false;
  #manifest: LocalSubtitleSessionSummaryManifest | undefined;
  #recovered: LocalSubtitleSessionSummaryManifest | undefined;
  #recoveredSession: LocalSubtitleRecoveredSessionSummary | undefined;
  #semanticKey = "";
  #diagnostic: LocalSubtitleSessionSummaryDiagnostic | undefined;

  constructor(options: LocalSubtitleSessionSummaryStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Local subtitle session summary options are required.");
    }
    this.#root = validateManagedRoot(options.managedResourceRoot);
    this.#now = options.now ?? (() => new Date());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#availableBytes = options.availableBytes ?? availableFileSystemBytes;
    this.#repository = new LocalSubtitleSessionSummaryFileRepository(
      this.#root,
      options,
    );
  }

  initialize(): LocalSubtitleSessionSummaryManifest | undefined {
    if (this.#initialized) return this.#recovered;
    this.#initialized = true;
    try {
      const loaded = this.#repository.load();
      if (!loaded) return undefined;
      const recovered = recoverInterruptedTasks(loaded, this.#timestamp());
      if (JSON.stringify(recovered) !== JSON.stringify(loaded)) {
        this.#repository.replace(recovered);
      }
      this.#manifest = recovered;
      this.#recovered = recovered;
      this.#recoveredSession = toRecoveredSessionSummary(recovered);
      this.#semanticKey = semanticBatchKey(recovered.batches);
      return recovered;
    } catch (error) {
      this.#disabled = true;
      this.#diagnostic = freezeValue({
        code: error instanceof LocalSubtitleSessionSummaryRepositoryError &&
            error.code === "invalid"
          ? "summary_invalid"
          : "summary_read_failed",
        operation: "initialize",
        occurredAt: this.#timestamp(),
      });
      return undefined;
    }
  }

  capture(batches: readonly LocalSubtitleBatchSummary[]): void {
    if (!this.#initialized) this.initialize();
    if (this.#disabled) return;
    if (!Array.isArray(batches)) {
      throw new TypeError("Local subtitle session batches must be an array.");
    }
    const persistedBatches = freezeValue(batches.map(toPersistedBatch));
    const nextSemanticKey = semanticBatchKey(persistedBatches);
    if (nextSemanticKey === this.#semanticKey) return;

    const timestamp = this.#timestamp();
    const resourceWatermarks = this.#sampleWatermarks(timestamp);
    const manifest = freezeValue({
      schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
      build: {
        engine: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.id,
        version: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
        commit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      },
      batches: persistedBatches,
      ...(resourceWatermarks === undefined ? {} : { resourceWatermarks }),
      updatedAt: timestamp,
    } satisfies LocalSubtitleSessionSummaryManifest);

    try {
      this.#repository.replace(manifest);
      this.#manifest = manifest;
      this.#semanticKey = nextSemanticKey;
      if (this.#diagnostic?.operation === "persist") this.#diagnostic = undefined;
    } catch {
      this.#diagnostic = freezeValue({
        code: "summary_write_failed",
        operation: "persist",
        occurredAt: timestamp,
      });
    }
  }

  getRecoveredSummary(): LocalSubtitleSessionSummaryManifest | undefined {
    return this.#recovered;
  }

  getRecoveredSessionSummary(): LocalSubtitleRecoveredSessionSummary | undefined {
    return this.#recoveredSession;
  }

  getCurrentSummary(): LocalSubtitleSessionSummaryManifest | undefined {
    return this.#manifest;
  }

  getDiagnostic(): LocalSubtitleSessionSummaryDiagnostic | undefined {
    return this.#diagnostic;
  }

  #sampleWatermarks(
    sampledAt: string,
  ): LocalSubtitleResourceWatermarks | undefined {
    try {
      const memory = this.#memoryUsage();
      const availableDisk = this.#availableBytes(this.#root);
      assertNonNegativeSafeInteger(memory.rss);
      assertNonNegativeSafeInteger(memory.heapUsed);
      assertNonNegativeSafeInteger(availableDisk);
      const previous = this.#manifest?.resourceWatermarks;
      if (this.#diagnostic?.operation === "resource_probe") {
        this.#diagnostic = undefined;
      }
      return freezeValue({
        peakResidentBytes: Math.max(previous?.peakResidentBytes ?? 0, memory.rss),
        peakHeapUsedBytes: Math.max(previous?.peakHeapUsedBytes ?? 0, memory.heapUsed),
        minimumAvailableDiskBytes: Math.min(
          previous?.minimumAvailableDiskBytes ?? availableDisk,
          availableDisk,
        ),
        sampledAt,
      });
    } catch {
      this.#diagnostic = freezeValue({
        code: "resource_probe_failed",
        operation: "resource_probe",
        occurredAt: sampledAt,
      });
      return this.#manifest?.resourceWatermarks;
    }
  }

  #timestamp(): string {
    const date = this.#now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new TypeError("The local subtitle session summary clock is invalid.");
    }
    return date.toISOString();
  }
}

function toPersistedBatch(
  batch: LocalSubtitleBatchSummary,
): LocalSubtitlePersistedBatchSummary {
  return {
    batchId: batch.batchId,
    status: batch.status,
    tasks: batch.tasks.map((task) => ({
      taskId: task.taskId,
      batchId: task.batchId,
      generation: task.generation,
      displayName: privateDisplayName(task.taskId, task.displayName),
      status: task.status,
      stage: task.progress.stage,
      formats: [...task.requestedFormats],
      backend: task.resolvedBackend,
      artifactResults: task.artifactResults.map((artifact) => ({
        format: artifact.format,
        status: artifact.status,
        ...(artifact.status === "committed" || artifact.errorCode === undefined
          ? {}
          : { errorCode: artifact.errorCode }),
      })),
      ...(task.error === undefined ? {} : { errorCode: task.error.code }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function privateDisplayName(taskId: string, original: string): string {
  const idSuffix = taskId.replace(/[^A-Za-z0-9_-]/gu, "").slice(-16) || "task";
  const extension = path.extname(original);
  const safeExtension = /^\.[A-Za-z0-9]{1,12}$/u.test(extension)
    ? extension.toLowerCase()
    : "";
  return `media-${idSuffix}${safeExtension}`;
}

function recoverInterruptedTasks(
  manifest: LocalSubtitleSessionSummaryManifest,
  recoveredAt: string,
): LocalSubtitleSessionSummaryManifest {
  let changed = false;
  const batches = manifest.batches.map((batch) => {
    const tasks = batch.tasks.map((task) => {
      if (isTerminalPersistedTaskStatus(task.status)) return task;
      changed = true;
      return {
        ...task,
        status: "interrupted" as const,
        errorCode: "runtime_crashed" as const,
        updatedAt: recoveredAt,
      };
    });
    const interrupted = tasks.some((task) => task.status === "interrupted");
    if (!interrupted) return batch;
    return {
      ...batch,
      status: "interrupted" as const,
      tasks,
      updatedAt: recoveredAt,
    };
  });
  if (!changed) return manifest;
  return freezeValue({
    ...manifest,
    batches,
    updatedAt: recoveredAt,
  });
}

function isTerminalPersistedTaskStatus(
  status: LocalSubtitlePersistedTaskStatus,
): boolean {
  return status === "completed" || status === "cancelled" ||
    status === "failed" || status === "interrupted";
}

function toRecoveredSessionSummary(
  manifest: LocalSubtitleSessionSummaryManifest,
): LocalSubtitleRecoveredSessionSummary {
  for (const batch of manifest.batches) {
    if (
      !["completed", "cancelled", "failed", "interrupted"].includes(
        batch.status,
      ) ||
      batch.tasks.some((task) => !isTerminalPersistedTaskStatus(task.status))
    ) {
      throw new LocalSubtitleSessionSummaryRepositoryError(
        "invalid",
        "The recovered local subtitle summary is not terminal.",
      );
    }
  }
  const candidate = {
    build: { ...manifest.build },
    batches: manifest.batches.map((batch) => ({
      batchId: batch.batchId,
      status: batch.status as "completed" | "cancelled" | "failed" | "interrupted",
      tasks: batch.tasks.map((task) => ({
        taskId: task.taskId,
        batchId: task.batchId,
        generation: task.generation,
        displayName: task.displayName,
        status: task.status as "completed" | "cancelled" | "failed" | "interrupted",
        stage: task.stage,
        formats: [...task.formats],
        backend: task.backend,
        artifactResults: task.artifactResults.map((artifact) => ({ ...artifact })),
        ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    })),
    ...(manifest.resourceWatermarks === undefined
      ? {}
      : { resourceWatermarks: { ...manifest.resourceWatermarks } }),
    updatedAt: manifest.updatedAt,
  };
  const parsed = localSubtitleRecoveredSessionSummarySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new LocalSubtitleSessionSummaryRepositoryError(
      "invalid",
      "The recovered local subtitle summary is invalid.",
    );
  }
  return freezeValue(parsed.data);
}

function semanticBatchKey(
  batches: readonly LocalSubtitlePersistedBatchSummary[],
): string {
  return JSON.stringify(batches.map((batch) => ({
    batchId: batch.batchId,
    status: batch.status,
    tasks: batch.tasks.map((task) => ({
      taskId: task.taskId,
      batchId: task.batchId,
      generation: task.generation,
      displayName: task.displayName,
      status: task.status,
      stage: task.stage,
      formats: task.formats,
      backend: task.backend,
      artifactResults: task.artifactResults,
      errorCode: task.errorCode,
    })),
  })));
}

function validateManagedRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute local subtitle managed root is required.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The filesystem root cannot store local subtitle summaries.");
  }
  return resolved;
}

function readPrivateDirectoryProof(absolutePath: string): DirectoryProof {
  const before = lstatSync(absolutePath);
  assertPrivateDirectory(before);
  const resolved = realpathSync(absolutePath);
  const after = lstatSync(absolutePath);
  assertPrivateDirectory(after);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeMs !== after.birthtimeMs
  ) {
    throw new TypeError("The local subtitle summary root changed identity.");
  }
  return Object.freeze({
    absolutePath,
    realPath: resolved,
    dev: after.dev,
    ino: after.ino,
    birthtimeMs: after.birthtimeMs,
    mode: after.mode & 0o777,
  });
}

function assertPrivateDirectory(stats: Stats): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new TypeError("The local subtitle summary root is not private.");
  }
}

function assertPrivateSummaryFile(stats: Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== "win32" &&
      (stats.mode & 0o777) !== PRIVATE_FILE_MODE)
  ) {
    throw new LocalSubtitleSessionSummaryRepositoryError(
      "invalid",
      "The local subtitle session summary file is not private.",
    );
  }
}

function assertSameFileObject(
  expected: Pick<Stats, "dev" | "ino" | "birthtimeMs">,
  actual: Pick<Stats, "dev" | "ino" | "birthtimeMs">,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.birthtimeMs !== actual.birthtimeMs
  ) {
    throw new LocalSubtitleSessionSummaryRepositoryError(
      "invalid",
      "The local subtitle session summary file changed identity.",
    );
  }
}

function availableFileSystemBytes(directory: string): number {
  const stats = statfsSync(directory, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bytes);
}

function syncParentDirectory(directory: string): void {
  const handle = openSync(directory, fsConstants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function validateUuid(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new TypeError("The local subtitle session summary id is invalid.");
  }
  return value;
}

function assertNonNegativeSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("A local subtitle resource watermark is invalid.");
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeValue(nested);
  }
  return Object.freeze(value);
}
