import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn(), tasks: [] as unknown[] }));
vi.mock("@/services/subtitle-studio/transcription-controller", () => ({
  getStudioTranscriptionController: () => ({ getState: () => ({ tasks: mocks.tasks }) }),
}));
vi.mock("./orchestrator", () => ({ reportUiEvent: mocks.report }));

import useAgentStore from "@/store/agent/useAgentStore";
import { useTestSession } from "@/store/agent/agent-store-test-utils";
import { watchStudioPipeline } from "./pipeline-watch";

const finished = { taskId: "a", documentId: "doc-a", batchId: "b", generation: 1, displayName: "a.wav", status: "completed", progress: 100, createdAt: "", updatedAt: "", modelId: "m", resolvedBackend: "cpu" };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.report.mockReset();
  mocks.tasks = [finished];
  useTestSession("owner");
  useAgentStore.getState().addMessage({ id: "u", role: "user", content: "transcribe", timestamp: 1 });
});
afterEach(() => { vi.useRealTimers(); });

describe("pipeline reports and sessions", () => {
  it("reports to the session that submitted the batch while the user is in another one", async () => {
    useAgentStore.getState().createSession();
    watchStudioPipeline({ sessionId: "owner", taskIds: ["a"], translate: false, exportFiles: false });
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
    expect(mocks.report.mock.calls[0][1]).toBe("owner");
    expect(mocks.report.mock.calls[0][0]).toMatchObject({ kind: "pipeline_completed", values: { total: 1, finished: 1 } });
  });

  it("stops watching once the session is deleted", async () => {
    watchStudioPipeline({ sessionId: "owner", taskIds: ["a"], translate: false, exportFiles: false });
    useAgentStore.getState().removeSession("owner");
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
