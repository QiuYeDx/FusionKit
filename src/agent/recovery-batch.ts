import type { TranslationRecoveryCandidate } from "@/type/subtitle";
import { DEFAULT_QUEUE_BATCH_SIZE, MAX_QUEUE_BATCH_SIZE } from "./queue-batch";

export const RECOVERY_SCAN_PREVIEW_LIMIT = 30;
const MAX_STORED_RECOVERY_SCAN_RESULTS = 10;

export type StoredRecoveryCandidate = TranslationRecoveryCandidate;

type StoredRecoveryScanResult = {
  recoveryScanId: string;
  candidates: StoredRecoveryCandidate[];
  createdAt: number;
};

export type RecoveryBatchMeta = {
  recoveryScanId: string;
  batchStart: number;
  batchEnd: number;
  batchSize: number;
  attemptedCount: number;
  totalCandidates: number;
  queuedThrough: number;
  hasMore: boolean;
  nextBatchStart: number | null;
  remainingCount: number;
};

export type RecoveryCandidateSelection =
  | {
      ok: true;
      source: "checkpointPaths";
      candidates: StoredRecoveryCandidate[];
      totalCandidates: number;
    }
  | {
      ok: true;
      source: "scan";
      candidates: StoredRecoveryCandidate[];
      totalCandidates: number;
      batch: RecoveryBatchMeta;
    }
  | {
      ok: false;
      error: string;
    };

export type RecoveryScanPayload = {
  recoveryScanId: string;
  candidates: Array<{
    id: string;
    checkpointPath: string;
    fileName: string;
    manifestStatus: string;
    progress: number;
    resolvedFragments: number;
    totalFragments: number;
    recoverability: string;
    sourceState: string;
    blockingReason?: string;
    options: TranslationRecoveryCandidate["options"];
  }>;
  totalCount: number;
  recoverableCount: number;
  readyCount: number;
  readyFromManifestCount: number;
  completedCount: number;
  invalidCount: number;
  scannedRoots: string[];
  allCandidatesIncluded: boolean;
  previewCount: number;
  omittedCount: number;
  recommendedQueueBatchSize: number;
  maxQueueBatchSize: number;
  queueInstruction: string;
};

const recoveryScanResults = new Map<string, StoredRecoveryScanResult>();

export function rememberRecoveryScanResult(
  candidates: StoredRecoveryCandidate[],
): string {
  const recoveryScanId = `rscan_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  recoveryScanResults.set(recoveryScanId, {
    recoveryScanId,
    candidates,
    createdAt: Date.now(),
  });
  pruneRecoveryScanResults();
  return recoveryScanId;
}

export function clearStoredRecoveryScanResults(): void {
  recoveryScanResults.clear();
}

function candidatePreview(c: StoredRecoveryCandidate) {
  return {
    id: c.id,
    checkpointPath: c.checkpointPath,
    fileName: c.fileName,
    manifestStatus: c.manifestStatus,
    progress: c.progress,
    resolvedFragments: c.resolvedFragments,
    totalFragments: c.totalFragments,
    recoverability: c.recoverability,
    sourceState: c.sourceState,
    blockingReason: c.blockingReason,
    options: c.options,
  };
}

export function createRecoveryScanResultPayload(
  candidates: StoredRecoveryCandidate[],
  scannedRoots: string[],
): RecoveryScanPayload {
  const recoveryScanId = rememberRecoveryScanResult(candidates);
  const preview = candidates
    .slice(0, RECOVERY_SCAN_PREVIEW_LIMIT)
    .map(candidatePreview);

  const readyCount = candidates.filter(
    (c) => c.recoverability === "ready",
  ).length;
  const readyFromManifestCount = candidates.filter(
    (c) => c.recoverability === "ready_from_manifest",
  ).length;
  const completedCount = candidates.filter(
    (c) => c.recoverability === "completed",
  ).length;
  const recoverableCount = readyCount + readyFromManifestCount;
  const invalidCount = candidates.length - recoverableCount - completedCount;

  return {
    recoveryScanId,
    candidates: preview,
    totalCount: candidates.length,
    recoverableCount,
    readyCount,
    readyFromManifestCount,
    completedCount,
    invalidCount,
    scannedRoots,
    allCandidatesIncluded: preview.length === candidates.length,
    previewCount: preview.length,
    omittedCount: Math.max(0, candidates.length - preview.length),
    recommendedQueueBatchSize: DEFAULT_QUEUE_BATCH_SIZE,
    maxQueueBatchSize: MAX_QUEUE_BATCH_SIZE,
    queueInstruction:
      recoverableCount > DEFAULT_QUEUE_BATCH_SIZE
        ? "Use recoveryScanId with batchStart and batchSize to queue candidates in batches. Continue with nextBatchStart until hasMore is false."
        : recoverableCount > 0
          ? "Use recoveryScanId with batchStart=0 to queue these candidates."
          : "No recoverable candidates found. Do not call queue_recovered_subtitle_translate.",
  };
}

export function resolveRecoveryCandidateSelection(args: {
  recoveryScanId?: string;
  checkpointPaths?: string[];
  candidateIds?: string[];
  batchStart?: number;
  batchSize?: number;
  recoverability?: "ready" | "ready_from_manifest" | "both";
}): RecoveryCandidateSelection {
  const recoverability = args.recoverability ?? "both";

  if (args.checkpointPaths && args.checkpointPaths.length > 0) {
    return {
      ok: true,
      source: "checkpointPaths",
      candidates: [],
      totalCandidates: args.checkpointPaths.length,
    };
  }

  if (!args.recoveryScanId) {
    return {
      ok: false,
      error:
        "Missing recoveryScanId or checkpointPaths. Use scan_subtitle_recovery_tasks first, then pass the returned recoveryScanId.",
    };
  }

  const scanResult = recoveryScanResults.get(args.recoveryScanId);
  if (!scanResult) {
    return {
      ok: false,
      error: `Recovery scan result "${args.recoveryScanId}" is no longer available. Please scan again before queueing.`,
    };
  }

  let filtered = scanResult.candidates.filter((c) => {
    if (recoverability === "ready") return c.recoverability === "ready";
    if (recoverability === "ready_from_manifest")
      return c.recoverability === "ready_from_manifest";
    return (
      c.recoverability === "ready" ||
      c.recoverability === "ready_from_manifest"
    );
  });

  if (args.candidateIds && args.candidateIds.length > 0) {
    const idSet = new Set(args.candidateIds);
    filtered = filtered.filter((c) => idSet.has(c.id));
  }

  const totalCandidates = filtered.length;
  if (totalCandidates === 0) {
    return {
      ok: false,
      error: `No recoverable candidates matching recoverability="${recoverability}" in scan "${args.recoveryScanId}".`,
    };
  }

  const batchStart = normalizeBatchStart(args.batchStart);
  if (batchStart >= totalCandidates) {
    return {
      ok: false,
      error: `batchStart ${batchStart} is outside recovery scan "${args.recoveryScanId}" with ${totalCandidates} recoverable candidates.`,
    };
  }

  const batchSize = normalizeBatchSize(args.batchSize);
  const batchEnd = Math.min(batchStart + batchSize, totalCandidates);
  const batch = filtered.slice(batchStart, batchEnd);
  const hasMore = batchEnd < totalCandidates;

  return {
    ok: true,
    source: "scan",
    candidates: batch,
    totalCandidates,
    batch: {
      recoveryScanId: args.recoveryScanId,
      batchStart,
      batchEnd,
      batchSize,
      attemptedCount: batch.length,
      totalCandidates,
      queuedThrough: batchEnd,
      hasMore,
      nextBatchStart: hasMore ? batchEnd : null,
      remainingCount: Math.max(0, totalCandidates - batchEnd),
    },
  };
}

function normalizeBatchSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_QUEUE_BATCH_SIZE;
  }
  return Math.min(MAX_QUEUE_BATCH_SIZE, Math.max(1, Math.floor(value)));
}

function normalizeBatchStart(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function pruneRecoveryScanResults(): void {
  if (recoveryScanResults.size <= MAX_STORED_RECOVERY_SCAN_RESULTS) return;
  const oldest = [...recoveryScanResults.values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  )[0];
  if (oldest) {
    recoveryScanResults.delete(oldest.recoveryScanId);
  }
}
