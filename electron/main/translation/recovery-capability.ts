import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SUBTITLE_TRANSLATION_LIMITS,
  subtitleTranslationDisplayLabelSchema,
  subtitleTranslationOutputLeafSchema,
  type SubtitleTranslationPreparedRecoveryBatch,
  type SubtitleTranslationRecoveryCandidateSummary,
  type SubtitleTranslationRecoveryScanSelection,
} from "@/type/subtitleTranslationIpc";
import {
  localSubtitleFilesystemObjectIdentityForPath,
  sameLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity,
} from "../local-subtitle/filesystem-object-identity";
import {
  buildCheckpointPaths,
  getResolvedCount,
  parseCheckpointManifest,
  validateManifestSelfContained,
  type CheckpointArtifactPaths,
} from "./checkpoint";
import {
  inspectTranslationRecoveryArtifact,
  scanTranslationRecoveryArtifacts,
} from "./recovery-discovery";
import {
  SubtitleTranslationCapabilityError,
  type SubtitleTranslationDirectoryCapabilityRegistry,
  type SubtitleTranslationOwnerKey,
} from "./directory-capability";
import type { TranslationCheckpointManifest } from "./typing";

const DEFAULT_RECOVERY_TTL_MS = 30 * 60 * 1000;

interface RecoveryCheckpointEntry {
  readonly checkpointRef: string;
  readonly candidateId: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly checkpointPath: string;
  readonly identity: LocalSubtitleFilesystemObjectIdentity;
  readonly size: number;
  readonly mtimeMs: number;
  readonly summary: SubtitleTranslationRecoveryCandidateSummary;
  readonly expiresAt: number;
  readonly scanId?: string;
  readonly taskId?: string;
}

interface RecoveryScanEntry {
  readonly recoveryScanId: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly checkpointRefs: readonly string[];
  readonly expiresAt: number;
}

export interface SubtitleTranslationRecoveryCapabilityOptions {
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly ttlMs?: number;
}

export class SubtitleTranslationRecoveryCapabilityRegistry {
  private readonly scans = new Map<string, RecoveryScanEntry>();
  private readonly checkpoints = new Map<string, RecoveryCheckpointEntry>();
  private readonly activeCheckpointByTask = new Map<string, string>();
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly ttlMs: number;

  constructor(options: SubtitleTranslationRecoveryCapabilityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.ttlMs = options.ttlMs ?? DEFAULT_RECOVERY_TTL_MS;
  }

  async scanDirectory(
    owner: SubtitleTranslationOwnerKey,
    directoryPath: string,
    includeCompleted = false,
  ): Promise<Exclude<SubtitleTranslationRecoveryScanSelection, { cancelled: true }>> {
    const result = await scanTranslationRecoveryArtifacts({
      roots: [directoryPath],
      recursive: true,
      includeCompleted,
    });
    return this.registerScan(owner, result.candidates, {
      scannedDirs: result.scannedDirs,
      scannedFiles: result.scannedFiles,
      skippedFiles: result.skippedFiles,
      truncated: result.truncated,
      errors: result.errors.map(() =>
        "Part of the selected recovery directory could not be scanned."),
    });
  }

  async inspectManifest(
    owner: SubtitleTranslationOwnerKey,
    checkpointPath: string,
  ): Promise<Exclude<SubtitleTranslationRecoveryScanSelection, { cancelled: true }>> {
    const candidate = await inspectTranslationRecoveryArtifact(checkpointPath);
    return this.registerScan(owner, [candidate], {
      scannedDirs: 1,
      scannedFiles: 1,
      skippedFiles: 0,
      truncated: false,
      errors: [],
    });
  }

  async prepareRecoveredTasks(args: {
    readonly owner: SubtitleTranslationOwnerKey;
    readonly recoveryScanId: string;
    readonly directoryToken: string;
    readonly candidateIds?: readonly string[];
    readonly batchStart?: number;
    readonly batchSize?: number;
    readonly directoryCapabilities: SubtitleTranslationDirectoryCapabilityRegistry;
  }): Promise<SubtitleTranslationPreparedRecoveryBatch> {
    const scan = this.requireScan(args.owner, args.recoveryScanId);
    let entries = scan.checkpointRefs
      .map((checkpointRef) => this.requireCheckpoint(args.owner, checkpointRef))
      .filter((entry) => entry.summary.recoverability === "ready_from_manifest");
    if (args.candidateIds?.length) {
      const requested = new Set(args.candidateIds);
      if (requested.size !== args.candidateIds.length) throw invalid("candidateIds");
      entries = args.candidateIds.map((candidateId) => {
        const entry = entries.find((candidate) =>
          candidate.candidateId === candidateId);
        if (!entry || !requested.has(candidateId)) throw invalid("candidateIds");
        return entry;
      });
    }
    const totalCandidates = entries.length;
    const batchStart = args.candidateIds?.length
      ? 0
      : Math.max(0, args.batchStart ?? 0);
    const batchSize = Math.min(
      SUBTITLE_TRANSLATION_LIMITS.maxRecoveryBatchFiles,
      Math.max(1, args.batchSize ?? 10),
    );
    if (batchStart >= totalCandidates && totalCandidates > 0) {
      throw invalid("batchStart");
    }
    const selected = args.candidateIds?.length
      ? entries
      : entries.slice(batchStart, batchStart + batchSize);
    if (selected.length === 0) throw invalid("recoveryScanId");
    if (selected.some((entry) => entry.taskId)) {
      throw conflict("A recovery candidate was already prepared for a task.");
    }

    const prepared = await Promise.all(selected.map(async (entry) => {
      await this.verifyCheckpoint(entry);
      const manifest = await readManifest(entry.checkpointPath);
      const validation = validateManifestSelfContained(manifest);
      if (!validation.valid) {
        throw new SubtitleTranslationCapabilityError(
          "invalid_content",
          `Recovery manifest validation failed: ${validation.reason}`,
          "checkpointRef",
        );
      }
      const taskId = `subtitle-task-${this.tokenFactory()}`;
      return { entry, manifest, taskId };
    }));

    const references = await args.directoryCapabilities.registerRecoveredTaskBatch({
      owner: args.owner,
      directoryToken: args.directoryToken,
      tasks: prepared.map(({ taskId, manifest }) => ({
        taskId,
        fileName: manifest.fileName,
      })),
    });

    const tasks = prepared.map(({ entry, manifest, taskId }, index) => {
      const bound = Object.freeze({ ...entry, taskId });
      this.checkpoints.set(entry.checkpointRef, bound);
      this.activeCheckpointByTask.set(taskId, entry.checkpointRef);
      const resolvedFragments = getResolvedCount(manifest);
      const failedFragmentIndexes = manifest.fragments
        .filter((fragment) => fragment.status === "failed")
        .map((fragment) => fragment.index);
      return Object.freeze({
        taskId,
        fileName: manifest.fileName,
        sliceType: manifest.options.sliceType,
        ...(manifest.options.customSliceLength === undefined
          ? {}
          : { customSliceLength: manifest.options.customSliceLength }),
        sourceLang: manifest.options.sourceLang,
        targetLang: manifest.options.targetLang,
        translationOutputMode: manifest.options.translationOutputMode,
        thinkingEnabled: manifest.options.thinkingEnabled === true,
        resolvedFragments,
        totalFragments: manifest.fragments.length,
        progress: Math.round((resolvedFragments / manifest.fragments.length) * 100),
        checkpointRef: entry.checkpointRef,
        reference: references[index],
        ...(failedFragmentIndexes.length === 0
          ? {}
          : { failedFragmentIndexes }),
      });
    });
    const batchEnd = batchStart + tasks.length;
    return Object.freeze({
      tasks: Object.freeze(tasks),
      totalCandidates,
      batchStart,
      batchEnd,
      hasMore: batchEnd < totalCandidates,
      nextBatchStart: batchEnd < totalCandidates ? batchEnd : null,
    });
  }

  async authorizeCheckpoint(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    checkpointPath: string,
  ): Promise<string> {
    const entry = await this.createCheckpointEntry(owner, checkpointPath, {
      taskId,
    });
    const previousRef = this.activeCheckpointByTask.get(taskId);
    if (previousRef && previousRef !== entry.checkpointRef) {
      this.checkpoints.delete(previousRef);
    }
    this.checkpoints.set(entry.checkpointRef, entry);
    this.activeCheckpointByTask.set(taskId, entry.checkpointRef);
    return entry.checkpointRef;
  }

  async resolveCheckpointForTask(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    checkpointRef: string,
  ): Promise<string> {
    const entry = this.requireCheckpoint(owner, checkpointRef);
    if (entry.taskId !== taskId) throw invalid("checkpointRef");
    await this.verifyCheckpoint(entry);
    return entry.checkpointPath;
  }

  resolveCheckpointForReveal(
    owner: SubtitleTranslationOwnerKey,
    checkpointRef: string,
  ): string {
    return this.requireCheckpoint(owner, checkpointRef).checkpointPath;
  }

  releaseTask(owner: SubtitleTranslationOwnerKey, taskId: string): boolean {
    const checkpointRef = this.activeCheckpointByTask.get(taskId);
    if (!checkpointRef) return false;
    const entry = this.checkpoints.get(checkpointRef);
    if (!entry || !sameOwner(entry.owner, owner)) return false;
    this.activeCheckpointByTask.delete(taskId);
    this.checkpoints.delete(checkpointRef);
    return true;
  }

  async resolveTaskArtifactCleanupPaths(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): Promise<CheckpointArtifactPaths | undefined> {
    const checkpointRef = this.activeCheckpointByTask.get(taskId);
    if (!checkpointRef) return undefined;
    const entry = this.checkpoints.get(checkpointRef);
    if (!entry || !sameOwner(entry.owner, owner)) return undefined;
    await this.verifyCheckpoint(entry);
    const manifest = await readManifest(entry.checkpointPath);
    const taskScopedPaths = buildCheckpointPaths(
      path.dirname(entry.checkpointPath),
      manifest.fileName,
      taskId,
    );
    if (path.resolve(taskScopedPaths.manifestPath) === entry.checkpointPath) {
      return taskScopedPaths;
    }
    const legacyPaths = buildCheckpointPaths(
      path.dirname(entry.checkpointPath),
      manifest.fileName,
    );
    if (path.resolve(legacyPaths.manifestPath) !== entry.checkpointPath) {
      throw conflict("The recovery artifact namespace changed.");
    }
    return legacyPaths;
  }

  revokeScan(owner: SubtitleTranslationOwnerKey, recoveryScanId: string): boolean {
    const scan = this.scans.get(recoveryScanId);
    if (!scan || !sameOwner(scan.owner, owner)) return false;
    this.scans.delete(recoveryScanId);
    for (const checkpointRef of scan.checkpointRefs) {
      const entry = this.checkpoints.get(checkpointRef);
      if (entry && !entry.taskId) this.checkpoints.delete(checkpointRef);
    }
    return true;
  }

  releaseOwner(owner: SubtitleTranslationOwnerKey): void {
    for (const [scanId, scan] of this.scans) {
      if (sameOwner(scan.owner, owner)) this.scans.delete(scanId);
    }
    for (const [checkpointRef, entry] of this.checkpoints) {
      if (sameOwner(entry.owner, owner)) this.checkpoints.delete(checkpointRef);
    }
    for (const [taskId, checkpointRef] of this.activeCheckpointByTask) {
      if (!this.checkpoints.has(checkpointRef)) {
        this.activeCheckpointByTask.delete(taskId);
      }
    }
  }

  sweepExpired(): number {
    const now = this.now();
    let swept = 0;
    for (const [scanId, scan] of this.scans) {
      if (scan.expiresAt > now) continue;
      this.scans.delete(scanId);
      swept += 1;
    }
    for (const [checkpointRef, entry] of this.checkpoints) {
      if (entry.expiresAt > now || entry.taskId) continue;
      this.checkpoints.delete(checkpointRef);
      swept += 1;
    }
    return swept;
  }

  private async registerScan(
    owner: SubtitleTranslationOwnerKey,
    candidates: Awaited<ReturnType<typeof scanTranslationRecoveryArtifacts>>["candidates"],
    stats: {
      readonly scannedDirs: number;
      readonly scannedFiles: number;
      readonly skippedFiles: number;
      readonly truncated: boolean;
      readonly errors: readonly string[];
    },
  ): Promise<Exclude<SubtitleTranslationRecoveryScanSelection, { cancelled: true }>> {
    const recoveryScanId = `recovery-scan-${this.tokenFactory()}`;
    const expiresAt = this.now() + this.ttlMs;
    const entries: RecoveryCheckpointEntry[] = [];
    const errors = stats.errors.map(sanitizePublicError);
    for (const candidate of candidates) {
      try {
        const entry = await this.createCheckpointEntry(
          owner,
          candidate.checkpointPath,
          { recoveryScanId, candidate },
        );
        entries.push(entry);
      } catch (error) {
        errors.push(sanitizePublicError(error));
      }
    }
    for (const entry of entries) this.checkpoints.set(entry.checkpointRef, entry);
    this.scans.set(recoveryScanId, Object.freeze({
      recoveryScanId,
      owner: Object.freeze({ ...owner }),
      checkpointRefs: Object.freeze(entries.map((entry) => entry.checkpointRef)),
      expiresAt,
    }));
    const publicCandidates = entries
      .slice(0, SUBTITLE_TRANSLATION_LIMITS.maxRecoveryPreviewFiles)
      .map((entry) => entry.summary);
    return Object.freeze({
      cancelled: false as const,
      recoveryScanId,
      candidates: Object.freeze(publicCandidates),
      totalCount: entries.length,
      recoverableCount: entries.filter((entry) =>
        entry.summary.recoverability === "ready_from_manifest").length,
      scannedDirs: stats.scannedDirs,
      scannedFiles: stats.scannedFiles,
      skippedFiles: stats.skippedFiles,
      truncated: stats.truncated || publicCandidates.length < entries.length,
      errors: Object.freeze(errors.slice(0, 50)),
      expiresAt,
    });
  }

  private async createCheckpointEntry(
    owner: SubtitleTranslationOwnerKey,
    checkpointPath: string,
    options: {
      readonly recoveryScanId?: string;
      readonly taskId?: string;
      readonly candidate?: Awaited<ReturnType<typeof inspectTranslationRecoveryArtifact>>;
    },
  ): Promise<RecoveryCheckpointEntry> {
    const absolutePath = path.resolve(checkpointPath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("checkpointRef");
    const identity = await localSubtitleFilesystemObjectIdentityForPath(absolutePath);
    const manifest = await readManifest(absolutePath);
    const validation = validateManifestSelfContained(manifest);
    if (!validation.valid) {
      throw new SubtitleTranslationCapabilityError(
        "invalid_content",
        `Recovery manifest validation failed: ${validation.reason}`,
        "checkpointRef",
      );
    }
    const candidate = options.candidate ??
      await inspectTranslationRecoveryArtifact(absolutePath);
    const checkpointRef = `checkpoint-${this.tokenFactory()}`;
    const candidateId = `recovery-candidate-${this.tokenFactory()}`;
    const summary = toPublicSummary(candidate, manifest, checkpointRef, candidateId);
    return Object.freeze({
      checkpointRef,
      candidateId,
      owner: Object.freeze({ ...owner }),
      checkpointPath: absolutePath,
      identity,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      summary,
      expiresAt: this.now() + this.ttlMs,
      ...(options.recoveryScanId ? { scanId: options.recoveryScanId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
  }

  private requireScan(
    owner: SubtitleTranslationOwnerKey,
    recoveryScanId: string,
  ): RecoveryScanEntry {
    const scan = this.scans.get(recoveryScanId);
    if (!scan || !sameOwner(scan.owner, owner)) throw invalid("recoveryScanId");
    if (scan.expiresAt <= this.now()) {
      this.revokeScan(owner, recoveryScanId);
      throw expired("recoveryScanId");
    }
    return scan;
  }

  private requireCheckpoint(
    owner: SubtitleTranslationOwnerKey,
    checkpointRef: string,
  ): RecoveryCheckpointEntry {
    const entry = this.checkpoints.get(checkpointRef);
    if (!entry || !sameOwner(entry.owner, owner)) throw invalid("checkpointRef");
    if (entry.expiresAt <= this.now() && !entry.taskId) {
      this.checkpoints.delete(checkpointRef);
      throw expired("checkpointRef");
    }
    return entry;
  }

  private async verifyCheckpoint(entry: RecoveryCheckpointEntry): Promise<void> {
    const stat = await lstat(entry.checkpointPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.size ||
      stat.mtimeMs !== entry.mtimeMs
    ) {
      throw conflict("The recovery manifest changed after authorization.");
    }
    const identity = await localSubtitleFilesystemObjectIdentityForPath(
      entry.checkpointPath,
    );
    if (!sameLocalSubtitleFilesystemObjectIdentity(identity, entry.identity)) {
      throw conflict("The recovery manifest identity changed after authorization.");
    }
  }
}

async function readManifest(
  checkpointPath: string,
): Promise<TranslationCheckpointManifest> {
  const bytes = await readFile(checkpointPath);
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) {
    throw new SubtitleTranslationCapabilityError(
      "invalid_content",
      "The recovery manifest size is invalid.",
      "checkpointRef",
    );
  }
  try {
    return parseCheckpointManifest(JSON.parse(bytes.toString("utf-8")));
  } catch (error) {
    throw new SubtitleTranslationCapabilityError(
      "invalid_content",
      error instanceof Error ? error.message : "The recovery manifest is invalid.",
      "checkpointRef",
    );
  }
}

function toPublicSummary(
  candidate: Awaited<ReturnType<typeof inspectTranslationRecoveryArtifact>>,
  manifest: TranslationCheckpointManifest,
  checkpointRef: string,
  candidateId: string,
): SubtitleTranslationRecoveryCandidateSummary {
  const safeFileName = subtitleTranslationOutputLeafSchema.safeParse(
    candidate.fileName,
  );
  const recoverability = candidate.recoverability === "ready" ||
      candidate.recoverability === "ready_from_manifest"
    ? "ready_from_manifest"
    : candidate.recoverability;
  const parsedDirectoryLabel = subtitleTranslationDisplayLabelSchema.safeParse(
    path.basename(path.dirname(candidate.checkpointPath)),
  );
  const outputDirectoryLabel = parsedDirectoryLabel.success
    ? parsedDirectoryLabel.data
    : "Selected directory";
  return Object.freeze({
    candidateId,
    checkpointRef,
    fileName: safeFileName.success ? safeFileName.data : "recovery-manifest.srt",
    schemaVersion: manifest.schemaVersion,
    manifestStatus: candidate.manifestStatus,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    outputDirectoryLabel,
    options: Object.freeze({
      fileType: candidate.options.fileType,
      sliceType: candidate.options.sliceType,
      ...(candidate.options.customSliceLength === undefined
        ? {}
        : { customSliceLength: candidate.options.customSliceLength }),
      sourceLang: candidate.options.sourceLang || "unknown",
      targetLang: candidate.options.targetLang || "unknown",
      translationOutputMode: candidate.options.translationOutputMode,
      thinkingEnabled: candidate.options.thinkingEnabled === true,
    }),
    resolvedFragments: candidate.resolvedFragments,
    totalFragments: candidate.totalFragments,
    ...(candidate.failedFragmentIndexes?.length
      ? { failedFragmentIndexes: Object.freeze([...candidate.failedFragmentIndexes]) }
      : {}),
    progress: candidate.progress,
    recoverability,
    ...(candidate.blockingReason ? { blockingReason: candidate.blockingReason } : {}),
  });
}

function sameOwner(
  left: SubtitleTranslationOwnerKey,
  right: SubtitleTranslationOwnerKey,
): boolean {
  return left.webContentsId === right.webContentsId &&
    left.ownerSessionId === right.ownerSessionId;
}

function invalid(field: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "invalid_ipc_request",
    "The subtitle translation recovery authority is invalid.",
    field,
  );
}

function expired(field: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "authorization_expired",
    "The subtitle translation recovery authority expired.",
    field,
  );
}

function conflict(message: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "task_reference_conflict",
    message,
    "checkpointRef",
  );
}

function sanitizePublicError(error: unknown): string {
  if (error instanceof SubtitleTranslationCapabilityError) {
    return error.message.slice(0, 512);
  }
  const code = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  return code
    ? `A recovery manifest could not be inspected (${code}).`
    : "A recovery manifest could not be inspected.";
}
