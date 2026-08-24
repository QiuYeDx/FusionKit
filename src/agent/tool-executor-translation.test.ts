import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import {
  executeQueueRecoveredSubtitleTranslate,
  executeQueueTranslate,
  executeScanSubtitleRecoveryTasks,
} from "./tool-executor";

const api = {
  selectAgentInputFiles: vi.fn(),
  readAgentInputFile: vi.fn(),
  registerAgentAuthorizedTask: vi.fn(),
  revokeAgentInputSelection: vi.fn(),
  selectOutputDirectory: vi.fn(),
  revokeOutputDirectory: vi.fn(),
  selectRecoveryDirectory: vi.fn(),
  selectRecoveryManifest: vi.fn(),
  prepareRecoveredTasks: vi.fn(),
  revokeRecoveryScan: vi.fn(),
  releaseGeneratedTask: vi.fn(),
};

const originalWindow = globalThis.window;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { subtitleTranslationApi: api },
  });
  useSubtitleTranslatorStore.getState().initializeSubtitleTranslatorStore();
  useAgentStore.setState({
    executionMode: "queue_only",
    pendingExecution: null,
    session: {
      id: "agent-test-session",
      messages: [{
        id: "user-one",
        role: "user",
        content: "翻译我选择的字幕",
        timestamp: 1,
      }],
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  useModelStore.setState({
    profiles: [{
      id: "task-profile",
      name: "Task profile",
      provider: Model.OpenAI,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5",
      tokenPricing: {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
    }],
    assignment: { agent: null, taskExecution: "task-profile" },
  });
  api.selectAgentInputFiles.mockResolvedValue({
    ok: true,
    data: {
      cancelled: false,
      selectionRef: "subtitle-translation-selection-agent",
      files: [{
        itemRef: "subtitle-translation-selection-item-agent",
        displayName: "selected.srt",
      }],
      expiresAt: Date.now() + 60_000,
    },
  });
  api.readAgentInputFile.mockResolvedValue({
    ok: true,
    data: { displayName: "selected.srt", content: "subtitle content" },
  });
  api.registerAgentAuthorizedTask.mockResolvedValue({
    ok: true,
    data: {
      kind: "authorized_task_v1",
      source: {
        kind: "authorized_file",
        token: "subtitle-translation-source-agent",
        displayName: "selected.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-agent",
        displayLabel: "Selected source",
      },
    },
  });
  api.revokeAgentInputSelection.mockResolvedValue({
    ok: true,
    data: { revoked: false },
  });
  api.revokeOutputDirectory.mockResolvedValue({
    ok: true,
    data: { revoked: true },
  });
  api.revokeRecoveryScan.mockResolvedValue({
    ok: true,
    data: { released: true },
  });
  api.releaseGeneratedTask.mockResolvedValue({
    ok: true,
    data: { released: true },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Agent subtitle translation producer", () => {
  it("queues only picker-authorized path-free tasks", async () => {
    const result = await executeQueueTranslate({
      sliceType: "NORMAL",
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
      outputMode: "source",
      conflictPolicy: "index",
      concurrentSlices: true,
    });

    expect(result).toMatchObject({
      success: true,
      data: { queuedCount: 1, totalFiles: 1, executionStatus: "queued_only" },
    });
    expect(api.readAgentInputFile).toHaveBeenCalledWith({
      selectionRef: "subtitle-translation-selection-agent",
      itemRef: "subtitle-translation-selection-item-agent",
    });
    expect(api.registerAgentAuthorizedTask).toHaveBeenCalledWith(expect.objectContaining({
      selectionRef: "subtitle-translation-selection-agent",
      itemRef: "subtitle-translation-selection-item-agent",
      outputMode: "source",
      outputFileName: "selected.srt",
    }));
    expect(api.revokeAgentInputSelection).toHaveBeenCalledWith(
      "subtitle-translation-selection-agent",
    );
    const [task] = useSubtitleTranslatorStore.getState().notStartedTaskQueue;
    expect(task).toMatchObject({
      fileName: "selected.srt",
      taskReference: { kind: "authorized_task_v1" },
    });
    expect(task).not.toHaveProperty("originFileURL");
    expect(task).not.toHaveProperty("targetFileURL");
  });

  it.each([
    { filePaths: ["/private/input.srt"] },
    { scanId: "scan-renderer" },
    { outputDir: "/private/output" },
  ])("rejects legacy renderer authority before opening a picker: %o", async (legacy) => {
    const result = await executeQueueTranslate({
      sliceType: "NORMAL",
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
      outputMode: "source",
      conflictPolicy: "index",
      concurrentSlices: true,
      ...legacy,
    } as never);

    expect(result).toMatchObject({ success: false });
    expect(api.selectAgentInputFiles).not.toHaveBeenCalled();
  });
});

describe("Agent subtitle translation recovery", () => {
  it.each([
    {
      selectionMode: "directory" as const,
      method: "selectRecoveryDirectory" as const,
    },
    {
      selectionMode: "manifest" as const,
      method: "selectRecoveryManifest" as const,
    },
  ])("uses the fixed $selectionMode picker and returns only opaque scan data", async ({
    selectionMode,
    method,
  }) => {
    api[method].mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        recoveryScanId: "recovery-scan-agent",
        candidates: [{
          candidateId: "recovery-candidate-agent",
          checkpointRef: "checkpoint-agent",
          fileName: "recoverable.srt",
          schemaVersion: 2,
          manifestStatus: "failed",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:01:00.000Z",
          outputDirectoryLabel: "Recovery",
          options: {
            fileType: "SRT",
            sliceType: "NORMAL",
            sourceLang: "JA",
            targetLang: "ZH",
            translationOutputMode: "bilingual",
          },
          resolvedFragments: 1,
          totalFragments: 2,
          progress: 50,
          recoverability: "ready_from_manifest",
        }],
        totalCount: 1,
        recoverableCount: 1,
        scannedDirs: 1,
        scannedFiles: 1,
        skippedFiles: 0,
        truncated: false,
        errors: [],
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = await executeScanSubtitleRecoveryTasks({
      selectionMode,
      includeCompleted: false,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        recoveryScanId: "recovery-scan-agent",
        candidates: [{ checkpointRef: "checkpoint-agent" }],
      },
    });
    expect(api[method]).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("reauthorizes the target in main and returns an explicit task-free batch summary", async () => {
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        directoryToken: "recovery-directory-agent",
        displayLabel: "New output",
        expiresAt: Date.now() + 60_000,
      },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce({
      ok: true,
      data: {
        tasks: [{
          taskId: "subtitle-task-recovered-agent",
          fileName: "recoverable.srt",
          sliceType: "NORMAL",
          sourceLang: "JA",
          targetLang: "ZH",
          translationOutputMode: "bilingual",
          resolvedFragments: 1,
          totalFragments: 2,
          progress: 50,
          checkpointRef: "checkpoint-agent",
          reference: {
            kind: "generated_task_v1",
            source: {
              kind: "generated_content",
              displayName: "recoverable.srt",
            },
            target: {
              kind: "authorized_directory",
              token: "recovery-target-agent",
              displayLabel: "New output",
            },
          },
        }],
        totalCandidates: 1,
        batchStart: 0,
        batchEnd: 1,
        hasMore: false,
        nextBatchStart: null,
      },
    });

    const result = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });

    expect(api.prepareRecoveredTasks).toHaveBeenCalledWith({
      recoveryScanId: "recovery-scan-agent",
      directoryToken: "recovery-directory-agent",
      batchStart: 0,
      batchSize: 10,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        queuedCount: 1,
        batch: {
          recoveryScanId: "recovery-scan-agent",
          batchStart: 0,
          batchEnd: 1,
          hasMore: false,
          queuedCount: 1,
        },
      },
    });
    expect(Object.prototype.hasOwnProperty.call(result.data.batch, "tasks"))
      .toBe(false);
    expect(api.revokeRecoveryScan).toHaveBeenCalledWith("recovery-scan-agent");
    const [task] = useSubtitleTranslatorStore.getState().notStartedTaskQueue;
    expect(task).toMatchObject({
      taskId: "subtitle-task-recovered-agent",
      checkpointRef: "checkpoint-agent",
      taskReference: { kind: "generated_task_v1" },
    });
    expect(task).not.toHaveProperty("checkpointPath");
    expect(task).not.toHaveProperty("targetFileURL");
  });

  it("stops on target cancellation and revokes an unused target after prepare fails", async () => {
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: { cancelled: true },
    });
    const cancelled = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });
    expect(cancelled).toMatchObject({ success: false });
    expect(api.prepareRecoveredTasks).not.toHaveBeenCalled();

    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        directoryToken: "unused-recovery-directory",
        displayLabel: "Unused output",
        expiresAt: Date.now() + 60_000,
      },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "authorization_expired",
        message: "Recovery scan expired.",
      },
    });
    const failed = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });
    expect(failed).toMatchObject({
      success: false,
      error: "Recovery scan expired.",
    });
    expect(api.revokeOutputDirectory).toHaveBeenCalledWith(
      "unused-recovery-directory",
    );
  });
});
