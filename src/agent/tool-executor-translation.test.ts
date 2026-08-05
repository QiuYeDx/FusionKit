import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import { executeQueueTranslate } from "./tool-executor";

const api = {
  selectAgentInputFiles: vi.fn(),
  readAgentInputFile: vi.fn(),
  registerAgentAuthorizedTask: vi.fn(),
  revokeAgentInputSelection: vi.fn(),
  selectOutputDirectory: vi.fn(),
  revokeOutputDirectory: vi.fn(),
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
      originFileURL: "",
      targetFileURL: "",
      taskReference: { kind: "authorized_task_v1" },
    });
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
