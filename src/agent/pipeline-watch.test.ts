import { describe, expect, it } from "vitest";
import type { DocumentSummary } from "@/subtitle-studio/ipc-contract";
import type { TranscriptionTaskSummary } from "@/subtitle-studio/transcription/task-contract";
import { pipelineOutcome } from "./pipeline-watch";

const task = (id: string, overrides: Partial<TranscriptionTaskSummary> = {}) => ({ taskId: id, batchId: "b", generation: 1, displayName: `${id}.wav`, status: "completed",
  progress: 100, createdAt: "", updatedAt: "", modelId: "m", resolvedBackend: "cuda", documentId: `doc-${id}`, automaticTranslation: { status: "admitted", taskId: `tr-${id}` }, ...overrides }) as TranscriptionTaskSummary;
const doc = (id: string, overrides: Partial<DocumentSummary> = {}) => [`doc-${id}`, { id: `doc-${id}`, task: { id: `tr-${id}`, status: "completed", completedBatches: 1, totalBatches: 1 },
  automaticExport: { state: "exported", format: "auto", fileName: `${id}.lrc` }, ...overrides } as DocumentSummary] as const;
const scope = { translate: true, exportFiles: true };

describe("transcription pipeline outcome", () => {
  it("waits while any file is still being transcribed, translated or exported", () => {
    expect(pipelineOutcome([task("a"), task("b", { status: "transcribing" })], new Map([doc("a")]), scope)).toBeNull();
    expect(pipelineOutcome([task("a")], new Map([doc("a", { task: { id: "tr-a", status: "running", completedBatches: 0, totalBatches: 2 } })]), scope)).toBeNull();
    expect(pipelineOutcome([task("a")], new Map([doc("a", { automaticExport: { state: "pending", format: "auto" } })]), scope)).toBeNull();
    expect(pipelineOutcome([task("a", { automaticTranslation: { status: "pending" } })], new Map([doc("a")]), scope)).toBeNull();
  });
  it("reports once everything has gone as far as it will, with what was written and what was not", () => {
    const event = pipelineOutcome([task("a"), task("b"), task("c", { status: "failed", documentId: undefined, error: { code: "transcription_failed" } })],
      new Map([doc("a"), doc("b", { task: { id: "tr-b", status: "failed", completedBatches: 0, totalBatches: 1 } })]), scope);
    expect(event).toEqual({ kind: "pipeline_completed", values: { total: 3, finished: 1, failed: 2, files: "a.lrc",
      problems: "b.wav: failed; c.wav: transcription_failed" } });
  });
  it("needs no documents when it only transcribes", () => {
    expect(pipelineOutcome([task("a")], new Map(), { translate: false, exportFiles: false })).toMatchObject({ values: { finished: 1, failed: 0 } });
  });
});
