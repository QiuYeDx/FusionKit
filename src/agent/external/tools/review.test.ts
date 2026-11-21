import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_TOOLS } from "../catalog";
import { listStudioTranscriptionReview } from "./review";
import { getStudioTasks } from "./tasks";

const api = { listTranscriptionReview: vi.fn(), listTranscriptionTasks: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "codex", version: "1" }, signal: new AbortController().signal });
const reviewInput = (value: object) => EXTERNAL_TOOLS.list_studio_transcription_review.inputSchema.parse(value) as never;
const tasksInput = (value: object) => EXTERNAL_TOOLS.get_studio_tasks.inputSchema.parse(value) as never;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api } });
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("list_studio_transcription_review", () => {
  it("pages the ranges with why each one needs a listening check and the cue it falls at", async () => {
    api.listTranscriptionReview.mockResolvedValue({ ok: true, value: { total: 3, ranges: [
      { startMs: 1000, endMs: 2400, reason: "empty", cue: { id: "00000000-0000-4000-8000-0000000000c1", index: 0, text: "おはよう" } },
      { startMs: 5000, endMs: 9000, reason: "too_long" },
    ] } });
    const result = await listStudioTranscriptionReview(reviewInput({ taskId: "task-1" }), ctx());
    expect(api.listTranscriptionReview).toHaveBeenCalledWith({ taskId: "task-1", offset: 0, limit: 20 });
    expect(result).toEqual({ taskId: "task-1", total: 3, offset: 0, nextOffset: 2, items: [
      { startMs: 1000, endMs: 2400, reason: "empty", cue: { cueId: "00000000-0000-4000-8000-0000000000c1", index: 0, text: "おはよう" } },
      { startMs: 5000, endMs: 9000, reason: "too_long" },
    ] });
  });

  it("keeps Studio's error code and reads nothing else", async () => {
    api.listTranscriptionReview.mockResolvedValue({ ok: false, error: "access_denied" });
    await expect(listStudioTranscriptionReview(reviewInput({ taskId: "other" }), ctx())).rejects.toMatchObject({ code: "access_denied" });
  });
});

describe("get_studio_tasks transcription mode", () => {
  it("reports the mode, the two-stage phase and the ranges left to check", async () => {
    api.listTranscriptionTasks.mockResolvedValue({ ok: true, value: [
      { taskId: "t1", batchId: "b1", displayName: "asmr.wav", status: "completed", progress: 100, mode: "japanese_asmr",
        phase: { stage: "recognizing", done: 12, total: 12 }, asmrReviewCount: 2, asmrAutomationHeld: true, documentId: "00000000-0000-4000-8000-0000000000d1" },
      { taskId: "t2", batchId: "b1", displayName: "plain.wav", status: "completed", progress: 100, documentId: "00000000-0000-4000-8000-0000000000d2" },
    ] });
    const result = await getStudioTasks(tasksInput({ kind: "transcription" }), ctx()) as { items: Record<string, unknown>[] };
    expect(result.items[0]).toMatchObject({ taskId: "t1", mode: "japanese_asmr", reviewCount: 2, automationHeld: true, phase: { stage: "recognizing", done: 12, total: 12 } });
    // A standard task says so explicitly, so a caller never has to guess.
    expect(result.items[1]).toMatchObject({ taskId: "t2", mode: "standard" });
    expect(result.items[1]).not.toHaveProperty("reviewCount");
  });
});
