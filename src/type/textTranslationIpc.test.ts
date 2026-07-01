import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_TRANSLATION_OPTIONS } from "@/type/textTranslation";
import {
  TEXT_TRANSLATION_EVENT_CHANNELS,
  TEXT_TRANSLATION_IPC_CHANNELS,
  isTextTranslationEventPayload,
  validateCreateTextTranslationTaskIpcRequest,
  validateDeleteTextTranslationTaskIpcRequest,
  validateListRecoverableTextTranslationTasksIpcRequest,
  validateTextTranslationTaskIdIpcRequest,
} from "@/type/textTranslationIpc";

describe("text translation IPC contract", () => {
  it("keeps every command and event under the text-translation namespace", () => {
    const channels = [
      ...Object.values(TEXT_TRANSLATION_IPC_CHANNELS),
      ...Object.values(TEXT_TRANSLATION_EVENT_CHANNELS),
    ];

    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((channel) => channel.startsWith("text-translation:")))
      .toBe(true);
    expect(channels).not.toContain("update-progress");
    expect(channels).not.toContain("task-failed");
  });

  it("accepts create-task requests that only pass paths, options, and runtime model credentials", () => {
    const result = validateCreateTextTranslationTaskIpcRequest({
      files: [
        {
          sourcePath: "/books/chapter-01.txt",
          relativePath: "chapter-01.txt",
          order: 0,
        },
      ],
      options: DEFAULT_TEXT_TRANSLATION_OPTIONS,
      model: {
        profileId: "task-model",
        apiKey: "sk-runtime-only",
        modelKey: "deepseek-chat",
        endpoint: "https://api.example.test/v1",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files[0].sourcePath).toBe("/books/chapter-01.txt");
      expect(result.data.model.apiKey).toBe("sk-runtime-only");
    }
  });

  it("rejects create-task requests that try to send source text through IPC", () => {
    const result = validateCreateTextTranslationTaskIpcRequest({
      files: [
        {
          sourcePath: "/books/chapter-01.txt",
          order: 0,
          content: "long novel content must not cross IPC",
        },
      ],
      options: DEFAULT_TEXT_TRANSLATION_OPTIONS,
      model: {
        apiKey: "sk-runtime-only",
        modelKey: "deepseek-chat",
        endpoint: "https://api.example.test/v1",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("full_text_payload_not_allowed");
      expect(result.error.field).toBe("files.0.content");
      expect(JSON.stringify(result.error)).not.toContain("sk-runtime-only");
    }
  });

  it("returns structured errors for malformed task control requests", () => {
    const missing = validateTextTranslationTaskIdIpcRequest({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("missing_task_id");
      expect(missing.error.field).toBe("taskId");
    }

    const invalidDelete = validateDeleteTextTranslationTaskIpcRequest({
      taskId: "task_001",
      deleteWorkspace: "yes",
    });

    expect(invalidDelete.ok).toBe(false);
    if (!invalidDelete.ok) {
      expect(invalidDelete.error.code).toBe("invalid_ipc_request");
      expect(invalidDelete.error.field).toBe("deleteWorkspace");
    }
  });

  it("validates recoverable-task and event payload shapes", () => {
    expect(validateListRecoverableTextTranslationTasksIpcRequest(undefined).ok)
      .toBe(true);
    expect(validateListRecoverableTextTranslationTasksIpcRequest({ extra: true }).ok)
      .toBe(false);

    expect(
      isTextTranslationEventPayload({
        type: "progress",
        taskId: "task_001",
        sequence: 1,
        occurredAt: "2026-06-23T00:00:00.000Z",
        progress: {
          phase: "translating",
          completedFiles: 0,
          totalFiles: 1,
          completedSegments: 1,
          totalSegments: 3,
          activeSegmentIds: ["segment_002"],
          percentage: 33,
        },
      }),
    ).toBe(true);

    expect(
      isTextTranslationEventPayload({
        type: "progress",
        taskId: "task_001",
        sequence: 1.5,
        occurredAt: "2026-06-23T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});
