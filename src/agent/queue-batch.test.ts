import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUE_BATCH_SIZE,
  MAX_QUEUE_BATCH_SIZE,
  SCAN_RESULT_PREVIEW_LIMIT,
  clearStoredScanResults,
  createScanResultPayload,
  resolveQueueFileSelection,
  type DiscoveredSubtitleFile,
} from "./queue-batch";

function makeFiles(count: number): DiscoveredSubtitleFile[] {
  return Array.from({ length: count }, (_, index) => ({
    absolutePath: `/media/subtitles/file-${String(index).padStart(3, "0")}.srt`,
    fileName: `file-${String(index).padStart(3, "0")}.srt`,
    extension: "SRT",
    size: 1024 + index,
    sourceDirectory: "/media/subtitles",
  }));
}

describe("queue batch scan references", () => {
  beforeEach(() => {
    clearStoredScanResults();
  });

  it("stores full scan results while returning only a bounded preview", () => {
    const payload = createScanResultPayload(makeFiles(80), ["/media/subtitles"]);

    expect(payload.scanId).toMatch(/^scan_/);
    expect(payload.files).toHaveLength(SCAN_RESULT_PREVIEW_LIMIT);
    expect(payload.totalCount).toBe(80);
    expect(payload.allFilesIncluded).toBe(false);
    expect(payload.omittedCount).toBe(80 - SCAN_RESULT_PREVIEW_LIMIT);
    expect(payload.recommendedQueueBatchSize).toBe(DEFAULT_QUEUE_BATCH_SIZE);
  });

  it("resolves scanId batches with next-batch metadata", () => {
    const payload = createScanResultPayload(makeFiles(37), ["/media/subtitles"]);

    const first = resolveQueueFileSelection({ scanId: payload.scanId });

    expect(first.ok).toBe(true);
    if (!first.ok || first.source !== "scan") return;
    expect(first.filePaths).toHaveLength(DEFAULT_QUEUE_BATCH_SIZE);
    expect(first.filePaths[0]).toBe("/media/subtitles/file-000.srt");
    expect(first.batch.batchStart).toBe(0);
    expect(first.batch.batchEnd).toBe(DEFAULT_QUEUE_BATCH_SIZE);
    expect(first.batch.hasMore).toBe(true);
    expect(first.batch.nextBatchStart).toBe(DEFAULT_QUEUE_BATCH_SIZE);
    expect(first.batch.remainingCount).toBe(37 - DEFAULT_QUEUE_BATCH_SIZE);

    const final = resolveQueueFileSelection({
      scanId: payload.scanId,
      batchStart: 30,
      batchSize: DEFAULT_QUEUE_BATCH_SIZE,
    });

    expect(final.ok).toBe(true);
    if (!final.ok || final.source !== "scan") return;
    expect(final.filePaths).toHaveLength(7);
    expect(final.batch.hasMore).toBe(false);
    expect(final.batch.nextBatchStart).toBeNull();
    expect(final.batch.queuedThrough).toBe(37);
  });

  it("caps oversized batch requests", () => {
    const payload = createScanResultPayload(makeFiles(80), ["/media/subtitles"]);

    const selection = resolveQueueFileSelection({
      scanId: payload.scanId,
      batchSize: 200,
    });

    expect(selection.ok).toBe(true);
    if (!selection.ok || selection.source !== "scan") return;
    expect(selection.filePaths).toHaveLength(MAX_QUEUE_BATCH_SIZE);
    expect(selection.batch.batchSize).toBe(MAX_QUEUE_BATCH_SIZE);
    expect(selection.batch.nextBatchStart).toBe(MAX_QUEUE_BATCH_SIZE);
  });

  it("keeps explicit filePaths backward compatible", () => {
    const selection = resolveQueueFileSelection({
      filePaths: ["/a.srt", " ", "/b.srt"],
    });

    expect(selection).toEqual({
      ok: true,
      source: "filePaths",
      filePaths: ["/a.srt", "/b.srt"],
      totalFiles: 2,
    });
  });

  it("reports stale scan references clearly", () => {
    const selection = resolveQueueFileSelection({ scanId: "scan_missing" });

    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.error).toContain("no longer available");
  });
});
