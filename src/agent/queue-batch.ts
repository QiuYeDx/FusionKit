export const DEFAULT_QUEUE_BATCH_SIZE = 15;
export const MAX_QUEUE_BATCH_SIZE = 25;
export const SCAN_RESULT_PREVIEW_LIMIT = 30;
const MAX_STORED_SCAN_RESULTS = 10;

export type DiscoveredSubtitleFile = {
  absolutePath: string;
  fileName: string;
  extension: string;
  size: number;
  sourceDirectory: string;
};

type StoredScanResult = {
  scanId: string;
  files: DiscoveredSubtitleFile[];
  createdAt: number;
};

export type QueueFileReferenceArgs = {
  filePaths?: string[];
  scanId?: string;
  batchStart?: number;
  batchSize?: number;
};

export type QueueBatchMeta = {
  scanId: string;
  batchStart: number;
  batchEnd: number;
  batchSize: number;
  attemptedCount: number;
  totalFiles: number;
  queuedThrough: number;
  hasMore: boolean;
  nextBatchStart: number | null;
  remainingCount: number;
};

export type QueueFileSelection =
  | {
      ok: true;
      source: "filePaths";
      filePaths: string[];
      totalFiles: number;
    }
  | {
      ok: true;
      source: "scan";
      filePaths: string[];
      totalFiles: number;
      batch: QueueBatchMeta;
    }
  | {
      ok: false;
      error: string;
    };

const scanResults = new Map<string, StoredScanResult>();

export function rememberScanResult(files: DiscoveredSubtitleFile[]): string {
  const scanId = `scan_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  scanResults.set(scanId, {
    scanId,
    files,
    createdAt: Date.now(),
  });
  pruneScanResults();
  return scanId;
}

export function clearStoredScanResults(): void {
  scanResults.clear();
}

export function createScanResultPayload(
  files: DiscoveredSubtitleFile[],
  scannedDirectories: string[],
) {
  const scanId = rememberScanResult(files);
  const filesPreview = files.slice(0, SCAN_RESULT_PREVIEW_LIMIT);

  return {
    scanId,
    files: filesPreview,
    totalCount: files.length,
    scannedDirectories,
    allFilesIncluded: filesPreview.length === files.length,
    previewCount: filesPreview.length,
    omittedCount: Math.max(0, files.length - filesPreview.length),
    recommendedQueueBatchSize: DEFAULT_QUEUE_BATCH_SIZE,
    maxQueueBatchSize: MAX_QUEUE_BATCH_SIZE,
    queueInstruction:
      files.length > DEFAULT_QUEUE_BATCH_SIZE
        ? "Use scanId with batchStart and batchSize to queue files in batches. Continue with nextBatchStart until hasMore is false."
        : "Use filePaths directly or use scanId with batchStart=0 to queue these files.",
  };
}

export function resolveQueueFileSelection(
  args: QueueFileReferenceArgs,
): QueueFileSelection {
  const explicitPaths = args.filePaths
    ?.map((path) => (typeof path === "string" ? path.trim() : ""))
    .filter((path) => path.length > 0);
  if (explicitPaths && explicitPaths.length > 0) {
    return {
      ok: true,
      source: "filePaths",
      filePaths: explicitPaths,
      totalFiles: explicitPaths.length,
    };
  }

  if (!args.scanId) {
    return {
      ok: false,
      error:
        "Missing filePaths or scanId. Queue tools need explicit file paths or a scanId returned by scan_subtitle_files.",
    };
  }

  const scanResult = scanResults.get(args.scanId);
  if (!scanResult) {
    return {
      ok: false,
      error: `Scan result "${args.scanId}" is no longer available. Please scan the directory again before queueing.`,
    };
  }

  const totalFiles = scanResult.files.length;
  if (totalFiles === 0) {
    return {
      ok: false,
      error: `Scan result "${args.scanId}" has no files to queue.`,
    };
  }

  const batchStart = normalizeBatchStart(args.batchStart);
  if (batchStart >= totalFiles) {
    return {
      ok: false,
      error: `batchStart ${batchStart} is outside scan result "${args.scanId}" with ${totalFiles} files.`,
    };
  }

  const batchSize = normalizeBatchSize(args.batchSize);
  const batchEnd = Math.min(batchStart + batchSize, totalFiles);
  const filePaths = scanResult.files
    .slice(batchStart, batchEnd)
    .map((file) => file.absolutePath);
  const hasMore = batchEnd < totalFiles;

  return {
    ok: true,
    source: "scan",
    filePaths,
    totalFiles,
    batch: {
      scanId: args.scanId,
      batchStart,
      batchEnd,
      batchSize,
      attemptedCount: filePaths.length,
      totalFiles,
      queuedThrough: batchEnd,
      hasMore,
      nextBatchStart: hasMore ? batchEnd : null,
      remainingCount: Math.max(0, totalFiles - batchEnd),
    },
  };
}

export function normalizeBatchSize(value: number | undefined): number {
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

function pruneScanResults(): void {
  if (scanResults.size <= MAX_STORED_SCAN_RESULTS) return;
  const oldest = [...scanResults.values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  )[0];
  if (oldest) {
    scanResults.delete(oldest.scanId);
  }
}
