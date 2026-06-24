import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTextTranslationOptions } from "@/type/textTranslation";
import { TextTranslationService } from "../../../electron/main/text-translation/text-translation-service";
import { TextTranslationWorkspaceRepository } from "../../../electron/main/text-translation/persistence/workspace-repository";
import { formatSequentialTranslationResponse } from "../../../electron/main/text-translation/model/translation-response-protocol";
import {
  createChatCompletionBody,
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "../protocol/fakeOpenAICompatibleServer";

describe("TextTranslationService BE-007 vertical slice", () => {
  let tempRoot: string;
  let server: FakeOpenAICompatibleServer;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-e2e-"));
    server = await startFakeOpenAICompatibleServer();
  });

  afterEach(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prepares, translates, persists, and assembles a single TXT task", async () => {
    const sourcePath = path.join(tempRoot, "chapter.txt");
    const outputDir = path.join(tempRoot, "out");
    await writeFile(sourcePath, "Hello world.", "utf-8");

    server.enqueue({
      body: createChatCompletionBody({
        content: "你好，世界。",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
    });

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        outputDir,
        outputPathMode: "custom",
        conflictPolicy: "index",
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.data.progress.totalSegments).toBe(1);

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    expect(completed.data.status).toBe("completed");
    expect(completed.data.progress.completedSegments).toBe(1);
    expect(await readFile(path.join(outputDir, "chapter.zh.txt"), "utf-8")).toBe(
      "你好，世界。",
    );

    const taskJson = await readFile(
      path.join(tempRoot, "tasks", created.data.taskId, "task.json"),
      "utf-8",
    );
    expect(taskJson).not.toContain("sk-e2e-secret");
    expect(taskJson).not.toContain("Authorization");

    const events = await repository.readEvents(created.data.taskId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "segment_started",
        "segment_completed",
        "task_completed",
      ]),
    );
    const replayed = await repository.replayEvents(created.data.taskId);
    expect(replayed.status).toBe("completed");
    expect(replayed.completedSegmentIds).toHaveLength(1);

    const segmentId = replayed.completedSegmentIds[0];
    expect(await repository.readSegmentResult(created.data.taskId, segmentId)).toBe(
      "你好，世界。",
    );
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(server.requests[0].body)).toContain("Hello world.");
  });

  it("rejects illegal lifecycle transitions and preserves workspace on cancel", async () => {
    const sourcePath = path.join(tempRoot, "cancel.txt");
    await writeFile(sourcePath, "Hello world.", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions(),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prematureStart = await service.startTask({
      taskId: created.data.taskId,
    });
    expect(prematureStart.ok).toBe(false);

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const cancelled = await service.cancelTask({ taskId: created.data.taskId });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.data.status).toBe("cancelled");

    await expect(
      access(path.join(tempRoot, "tasks", created.data.taskId, "task.json")),
    ).resolves.toBeUndefined();

    const replayed = await repository.replayEvents(created.data.taskId);
    expect(replayed.status).toBe("cancelled");
  });

  it("continues parallel segments after one segment fails and records partial completion", async () => {
    const sourcePath = path.join(tempRoot, "partial.txt");
    await writeFile(sourcePath, "good\n\nbad", "utf-8");

    const responder = (request: { body: Record<string, unknown> }) => {
      const body = JSON.stringify(request.body);
      if (body.includes("bad")) {
        return {
          status: 500,
          body: {
            error: {
              message: "planned segment failure",
              type: "server_error",
              code: "planned_failure",
            },
          },
        };
      }
      return {
        body: createChatCompletionBody({
          content: "好",
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
      };
    };
    for (let index = 0; index < 4; index += 1) {
      server.enqueue(responder);
    }

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        sliceTokenLimit: 1,
        outputDir: path.join(tempRoot, "out"),
        outputPathMode: "custom",
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.data.progress.totalSegments).toBeGreaterThanOrEqual(2);

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    expect(completed.data.status).toBe("partially_completed");
    expect(completed.data.progress.completedSegments).toBeGreaterThan(0);
    expect(completed.data.progress.completedSegments).toBeLessThan(
      completed.data.progress.totalSegments,
    );

    const events = await repository.readEvents(created.data.taskId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["segment_completed", "segment_failed"]),
    );
    const replayed = await repository.replayEvents(created.data.taskId);
    expect(replayed.status).toBe("partially_completed");
    expect(replayed.completedSegmentIds.length).toBeGreaterThan(0);
    expect(replayed.failedSegmentIds.length).toBeGreaterThan(0);

    const recoveredService = new TextTranslationService({ repository });
    const recoverable = await recoveredService.listRecoverableTasks();
    expect(recoverable.ok).toBe(true);
    if (!recoverable.ok) return;
    expect(recoverable.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: created.data.taskId,
          status: "partially_completed",
          resumable: true,
          completedSegmentCount: replayed.completedSegmentIds.length,
          sourceStatus: "matched",
        }),
      ]),
    );

    server.enqueue({
      body: createChatCompletionBody({
        content: "坏",
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
        },
      }),
    });

    const requestCountBeforeResume = server.requests.length;
    const resumed = await recoveredService.resumeTask({
      taskId: created.data.taskId,
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.status).toBe("completed");
    expect(server.requests).toHaveLength(requestCountBeforeResume + 1);
    expect(
      server.requests.filter((request) =>
        JSON.stringify(request.body).includes("good"),
      ),
    ).toHaveLength(1);
    expect(await readFile(path.join(tempRoot, "out", "partial.zh.txt"), "utf-8"))
      .toBe("好\n\n坏");
  });

  it("runs sequential-context segments in order and resumes with the latest memory", async () => {
    const sourcePath = path.join(tempRoot, "sequential.txt");
    const outputDir = path.join(tempRoot, "out-sequential");
    await writeFile(sourcePath, "A\n\nB", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-sequential"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        sliceTokenLimit: 1,
        outputDir,
        outputPathMode: "custom",
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const segments = await repository.readSegmentsIndex<{
      segmentId: string;
    }>(created.data.taskId);
    expect(segments).toHaveLength(2);

    let activeRequests = 0;
    let maxActiveRequests = 0;
    server.enqueue(async (request) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        const body = JSON.stringify(request.body);
        expect(body).toContain(segments[0].segmentId);
        return {
          body: createChatCompletionBody({
            content: formatSequentialTranslationResponse(
              segments[0].segmentId,
              "第一段",
              { currentSceneSummary: "First paragraph is done." },
            ),
          }),
        };
      } finally {
        activeRequests -= 1;
      }
    });
    server.enqueue({
      status: 500,
      body: {
        error: {
          message: "planned sequential failure",
          type: "server_error",
          code: "planned_failure",
        },
      },
    });

    const partial = await service.startTask({ taskId: created.data.taskId });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.status).toBe("partially_completed");
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    expect(maxActiveRequests).toBe(1);

    const firstEvents = await repository.readEvents(created.data.taskId);
    expect(
      firstEvents.find(
        (event) =>
          event.type === "segment_completed" &&
          event.segmentId === segments[0].segmentId,
      ),
    ).toMatchObject({
      inputMemoryVersion: 0,
      memoryVersion: 1,
    });

    const recoveredService = new TextTranslationService({ repository });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("First paragraph is done.");
      expect(body).toContain("第一段");
      expect(body).toContain(segments[1].segmentId);
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            segments[1].segmentId,
            "第二段",
            { currentSceneSummary: "Second paragraph is done." },
          ),
        }),
      };
    });

    const resumed = await recoveredService.resumeTask({
      taskId: created.data.taskId,
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.status).toBe("completed");

    const replayed = await repository.replayEvents(created.data.taskId);
    expect(replayed.status).toBe("completed");
    expect(replayed.segmentMemoryVersions[segments[0].segmentId]).toEqual({
      inputMemoryVersion: 0,
      memoryVersion: 1,
    });
    expect(replayed.segmentMemoryVersions[segments[1].segmentId]).toEqual({
      inputMemoryVersion: 1,
      memoryVersion: 2,
    });
    expect(
      await readFile(path.join(outputDir, "sequential.zh.txt"), "utf-8"),
    ).toBe("第一段\n\n第二段");

    server.enqueue({
      status: 500,
      body: {
        error: {
          message: "planned retranslation failure",
          type: "server_error",
          code: "planned_failure",
        },
      },
    });

    const stalePartial = await recoveredService.retranslateFromSegment({
      taskId: created.data.taskId,
      segmentId: segments[1].segmentId,
    });
    expect(stalePartial.ok).toBe(true);
    if (!stalePartial.ok) return;
    expect(stalePartial.data.status).toBe("partially_completed");

    const staleReplay = await repository.replayEvents(created.data.taskId);
    expect(staleReplay.completedSegmentIds).toEqual([segments[0].segmentId]);
    expect(staleReplay.staleSegmentIds).toEqual([segments[1].segmentId]);
    expect(staleReplay.segmentResultPaths[segments[1].segmentId]).toBeUndefined();

    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("First paragraph is done.");
      expect(body).toContain("第一段");
      expect(body).toContain(segments[1].segmentId);
      expect(body).not.toContain("Second paragraph is done.");
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            segments[1].segmentId,
            "第二段重译",
            { currentSceneSummary: "Second paragraph was retranslated." },
          ),
        }),
      };
    });

    const rerunCompleted = await recoveredService.resumeTask({
      taskId: created.data.taskId,
    });
    expect(rerunCompleted.ok).toBe(true);
    if (!rerunCompleted.ok) return;
    expect(rerunCompleted.data.status).toBe("completed");
    const rerunReplay = await repository.replayEvents(created.data.taskId);
    expect(rerunReplay.staleSegmentIds).toEqual([]);
    expect(
      await readFile(path.join(outputDir, "sequential.zh (1).txt"), "utf-8"),
    ).toBe("第一段\n\n第二段重译");
  });

  it("keeps sequential translation when only memory patch parsing fails", async () => {
    const sourcePath = path.join(tempRoot, "invalid-patch.txt");
    await writeFile(sourcePath, "Only paragraph.", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-invalid-patch"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        outputDir: path.join(tempRoot, "out-invalid"),
        outputPathMode: "custom",
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const segments = await repository.readSegmentsIndex<{
      segmentId: string;
    }>(created.data.taskId);

    server.enqueue({
      body: createChatCompletionBody({
        content: formatSequentialTranslationResponse(
          segments[0].segmentId,
          "唯一段落",
          { schemaVersion: 999 },
        ),
      }),
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");

    const replayed = await repository.replayEvents(created.data.taskId);
    expect(replayed.warningCodes).toContain("invalid_memory_patch");
    expect(replayed.segmentMemoryVersions[segments[0].segmentId]).toEqual({
      inputMemoryVersion: 0,
      memoryVersion: 0,
    });
  });

  it("translates ordered project files with cross-file memory and relative outputs", async () => {
    const sourceRoot = path.join(tempRoot, "book");
    const chapterOne = path.join(sourceRoot, "chapter-01.txt");
    const chapterTwo = path.join(sourceRoot, "chapter-02.txt");
    const outputDir = path.join(tempRoot, "out-project");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(chapterOne, "A", "utf-8");
    await writeFile(chapterTwo, "B", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-project"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [
        { sourcePath: chapterOne, relativePath: "book/chapter-01.txt", order: 0 },
        { sourcePath: chapterTwo, relativePath: "book/chapter-02.txt", order: 1 },
      ],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        projectMode: "ordered_project",
        sliceTokenLimit: 100,
        outputDir,
        outputPathMode: "custom",
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const segments = await repository.readSegmentsIndex<{
      segmentId: string;
      fileId: string;
      globalIndex: number;
    }>(created.data.taskId);
    expect(segments.map((segment) => segment.globalIndex)).toEqual([0, 1]);
    expect(segments[0].fileId).not.toBe(segments[1].fileId);

    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain(segments[0].segmentId);
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            segments[0].segmentId,
            "第一章",
            { currentSceneSummary: "Arin reached the city." },
          ),
        }),
      };
    });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("Arin reached the city.");
      expect(body).toContain(segments[1].segmentId);
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            segments[1].segmentId,
            "第二章",
            { currentSceneSummary: "Arin entered the archive." },
          ),
        }),
      };
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");
    expect(await readFile(path.join(outputDir, "book/chapter-01.zh.txt"), "utf-8"))
      .toBe("第一章");
    expect(await readFile(path.join(outputDir, "book/chapter-02.zh.txt"), "utf-8"))
      .toBe("第二章");

    const firstSnapshot = await repository.readMemorySnapshot(
      created.data.taskId,
      `file_end_${segments[0].segmentId}_v000001`,
    );
    expect(firstSnapshot).toMatchObject({
      currentSceneSummary: "Arin reached the city.",
    });
  });

  it("resets sequential memory before configured ordered project files", async () => {
    const chapterOne = path.join(tempRoot, "reset-01.txt");
    const chapterTwo = path.join(tempRoot, "reset-02.txt");
    await writeFile(chapterOne, "A", "utf-8");
    await writeFile(chapterTwo, "B", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-project-reset"),
    });
    const service = new TextTranslationService({ repository });

    const created = await service.createTask({
      files: [
        { sourcePath: chapterOne, order: 0 },
        { sourcePath: chapterTwo, order: 1 },
      ],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        projectMode: "ordered_project",
        sliceTokenLimit: 100,
        outputDir: path.join(tempRoot, "out-reset"),
        outputPathMode: "custom",
        memoryResetFileOrders: [1],
      }),
      model: {
        apiKey: "sk-e2e-secret",
        modelKey: "fake-model",
        endpoint: server.baseUrl,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const prepared = await service.prepareTask({ taskId: created.data.taskId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const segments = await repository.readSegmentsIndex<{ segmentId: string }>(
      created.data.taskId,
    );

    server.enqueue({
      body: createChatCompletionBody({
        content: formatSequentialTranslationResponse(
          segments[0].segmentId,
          "第一章",
          { currentSceneSummary: "This memory should not cross reset." },
        ),
      }),
    });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).not.toContain("This memory should not cross reset.");
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            segments[1].segmentId,
            "第二章",
            { currentSceneSummary: "Reset chain starts here." },
          ),
        }),
      };
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");
  });
});
