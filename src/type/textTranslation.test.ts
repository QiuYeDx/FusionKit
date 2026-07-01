import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_TRANSLATION_OPTIONS,
  TEXT_TRANSLATION_RESOURCE_LIMITS,
  createPersistedTextTranslationTask,
  createTextTranslationOptions,
  createTextTranslationTask,
  estimateTextTranslationRequiredContextTokens,
  estimateTextTranslationWorkspaceDiskRequirement,
  assessTextTranslationDiskSpace,
  validateTextTranslationConfig,
  type TextTranslationFileRef,
} from "@/type/textTranslation";

const MB = 1024 * 1024;

describe("text translation domain contract", () => {
  it("keeps defaults aligned with the final design", () => {
    expect(DEFAULT_TEXT_TRANSLATION_OPTIONS).toMatchObject({
      sourceLang: "AUTO",
      targetLang: "ZH",
      executionMode: "parallel",
      outputMode: "target_only",
      projectMode: "independent_files",
      sliceTokenLimit: 3000,
      semanticMemoryTokenLimit: 8192,
      modelContextTokenLimit: 32768,
      outputTokenReserve: 6000,
      parallelSliceConcurrency: 3,
      outputPathMode: "source",
      conflictPolicy: "index",
    });

    expect(createTextTranslationOptions({ sliceTokenLimit: 5000 })).toMatchObject(
      {
        sliceTokenLimit: 5000,
        outputTokenReserve: 10000,
      },
    );
  });

  it("allows same fileName but requires unique fileId", () => {
    const files = [
      createFile({ fileId: "file_a", fileName: "chapter.txt", order: 0 }),
      createFile({ fileId: "file_b", fileName: "chapter.txt", order: 1 }),
    ];

    const result = validateTextTranslationConfig({
      files,
      options: createTextTranslationOptions(),
      requireModel: false,
    });

    expect(result.ok).toBe(true);

    const duplicate = validateTextTranslationConfig({
      files: [
        createFile({ fileId: "same", fileName: "a.txt", order: 0 }),
        createFile({ fileId: "same", fileName: "b.txt", order: 1 }),
      ],
      options: createTextTranslationOptions(),
      requireModel: false,
    });

    expect(duplicate.errors.map((issue) => issue.code)).toContain(
      "duplicate_file_id",
    );
  });

  it("returns stable budget error codes", () => {
    const result = validateTextTranslationConfig({
      files: [createFile()],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        sliceTokenLimit: 8000,
        semanticMemoryTokenLimit: 8192,
        modelContextTokenLimit: 16000,
        outputTokenReserve: 8000,
      }),
      requireModel: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(
      "model_context_budget_exceeded",
    );
  });

  it("validates language, concurrency, ordered project, and model configuration", () => {
    const result = validateTextTranslationConfig({
      files: [
        createFile({ fileId: "file_a", order: 0 }),
        createFile({ fileId: "file_b", order: 0 }),
      ],
      options: createTextTranslationOptions({
        sourceLang: "ZH",
        targetLang: "ZH",
        projectMode: "ordered_project",
        parallelSliceConcurrency: 4,
      }),
      model: {
        apiKey: "",
        modelKey: "model",
        endpoint: "https://example.test/v1",
      },
    });

    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duplicate_file_order",
        "source_target_language_same",
        "parallel_concurrency_out_of_range",
        "missing_task_model",
      ]),
    );
  });

  it("surfaces PRE-004 resource warnings and hard limits", () => {
    const markdownWarning = validateTextTranslationConfig({
      files: [
        createFile({
          format: "markdown",
          sizeBytes:
            TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileSoftWarningBytes +
            1,
        }),
      ],
      options: createTextTranslationOptions(),
      requireModel: false,
    });

    expect(markdownWarning.warnings.map((issue) => issue.code)).toContain(
      "file_size_soft_warning",
    );

    const markdownHardLimit = validateTextTranslationConfig({
      files: [
        createFile({
          format: "markdown",
          sizeBytes:
            TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileHardLimitBytes +
            1,
        }),
      ],
      options: createTextTranslationOptions(),
      requireModel: false,
    });

    expect(markdownHardLimit.errors.map((issue) => issue.code)).toContain(
      "file_size_hard_limit",
    );
  });

  it("estimates disk space and distinguishes minimum from recommended reserve", () => {
    const estimate = estimateTextTranslationWorkspaceDiskRequirement(50 * MB);

    expect(estimate.minimumRequiredBytes).toBe(164 * MB);
    expect(estimate.recommendedAvailableBytes).toBe(303 * MB);

    expect(
      assessTextTranslationDiskSpace(estimate, estimate.minimumRequiredBytes - 1)
        .errors[0].code,
    ).toBe("disk_available_below_minimum");
    expect(
      assessTextTranslationDiskSpace(
        estimate,
        estimate.recommendedAvailableBytes - 1,
      ).warnings[0].code,
    ).toBe("disk_available_below_recommended");
  });

  it("creates task and persisted task DTOs without secrets", () => {
    const task = createTextTranslationTask({
      taskId: "task_001",
      files: [createFile()],
      now: "2026-06-23T00:00:00.000Z",
    });

    expect(task.status).toBe("not_started");
    expect(task.phase).toBe("idle");
    expect(task.progress.totalFiles).toBe(1);

    const persisted = createPersistedTextTranslationTask({
      task,
      sourceFingerprint: [
        {
          fileId: "file_001",
          sourcePath: "/novel/chapter.txt",
          sizeBytes: 1024,
          modifiedAt: 1,
        },
      ],
      segmentCount: 12,
      model: {
        profileId: "profile_task",
        modelKey: "deepseek-chat",
        endpointLabel: "api.deepseek.com",
      },
    });

    const persistedText = JSON.stringify(persisted);
    expect(persisted.status).toBe("not_started");
    expect(persisted.failedSegmentIds).toEqual([]);
    expect(persistedText).not.toContain("apiKey");
    expect(persistedText).not.toContain("Authorization");
  });

  it("keeps default sequential context budget within the default model window", () => {
    const options = createTextTranslationOptions({
      executionMode: "sequential_context",
    });

    expect(estimateTextTranslationRequiredContextTokens(options)).toBeLessThan(
      options.modelContextTokenLimit,
    );
  });
});

function createFile(
  overrides: Partial<TextTranslationFileRef> = {},
): TextTranslationFileRef {
  return {
    fileId: "file_001",
    sourcePath: "/novel/chapter.txt",
    fileName: "chapter.txt",
    format: "txt",
    sizeBytes: 1024,
    modifiedAt: 1,
    order: 0,
    ...overrides,
  };
}
