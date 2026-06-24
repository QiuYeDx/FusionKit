import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTextTranslationOptions } from "@/type/textTranslation";
import type { TextTranslationEvent } from "@/type/textTranslationIpc";
import { TextTranslationService } from "../../../electron/main/text-translation/text-translation-service";
import { TextTranslationWorkspaceRepository } from "../../../electron/main/text-translation/persistence/workspace-repository";
import {
  formatMarkdownBilingualTranslationResponse,
  formatMarkdownTargetOnlyTranslationResponse,
  formatSequentialTranslationResponse,
} from "../../../electron/main/text-translation/model/translation-response-protocol";
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
    await server?.close();
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

  it("reports translating phase and first failure details when all segments fail", async () => {
    const sourcePath = path.join(tempRoot, "all-fail.txt");
    await writeFile(sourcePath, "first\n\nsecond", "utf-8");

    for (let index = 0; index < 8; index += 1) {
      server.enqueue({
        status: 500,
        body: {
          error: {
            message: "planned model outage",
            type: "server_error",
            code: "planned_outage",
          },
        },
      });
    }

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-all-fail"),
    });
    const events: TextTranslationEvent[] = [];
    const service = new TextTranslationService({
      repository,
      eventSink: (event) => events.push(event),
    });

    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        sliceTokenLimit: 1,
        outputDir: path.join(tempRoot, "out-all-fail"),
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

    const failed = await service.startTask({ taskId: created.data.taskId });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;

    expect(failed.error.phase).toBe("translating");
    expect(failed.error.message).toContain(
      "All text translation segments failed.",
    );
    expect(failed.error.message).toContain("First failure:");
    expect(failed.error.details).toMatchObject({
      failedSegments: prepared.data.progress.totalSegments,
      firstFailure: {
        errorCode: "http_retryable",
        message: expect.stringContaining("planned model outage"),
      },
    });

    const failedEvent = [...events]
      .reverse()
      .find((event) => event.type === "task-failed");
    expect(failedEvent).toMatchObject({
      type: "task-failed",
      taskId: created.data.taskId,
      task: {
        status: "failed",
        phase: "translating",
      },
      error: {
        phase: "translating",
      },
    });
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

  it("runs sequential Markdown in order, resumes, and clears stale results after retranslation", async () => {
    const sourcePath = path.join(tempRoot, "sequential-markdown.md");
    const outputDir = path.join(tempRoot, "out-sequential-markdown");
    await writeFile(sourcePath, "Alpha.\n\nBeta.", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-sequential-markdown"),
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
    const segments = await repository.readSegmentsIndex<{ segmentId: string }>(
      created.data.taskId,
    );
    expect(segments).toHaveLength(2);
    const payloads = await readMarkdownTargetPayloads(
      repository,
      created.data.taskId,
      segments,
    );

    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain(segments[0].segmentId);
      return {
        body: createChatCompletionBody({
          content: formatSequentialMarkdownTargetResponse(
            payloads.get(segments[0].segmentId)!,
            "阿尔法。",
            { currentSceneSummary: "Alpha memory committed." },
          ),
        }),
      };
    });
    server.enqueue({
      status: 500,
      body: {
        error: {
          message: "planned sequential Markdown failure",
          type: "server_error",
          code: "planned_markdown_failure",
        },
      },
    });

    const partial = await service.startTask({ taskId: created.data.taskId });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.status).toBe("partially_completed");

    const recoveredService = new TextTranslationService({ repository });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("Alpha memory committed.");
      expect(body).toContain("阿尔法。");
      expect(body).toContain(segments[1].segmentId);
      return {
        body: createChatCompletionBody({
          content: formatSequentialMarkdownTargetResponse(
            payloads.get(segments[1].segmentId)!,
            "贝塔。",
            { currentSceneSummary: "Beta memory committed." },
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
    expect(replayed.segmentMemoryVersions[segments[0].segmentId]).toEqual({
      inputMemoryVersion: 0,
      memoryVersion: 1,
    });
    expect(replayed.segmentMemoryVersions[segments[1].segmentId]).toEqual({
      inputMemoryVersion: 1,
      memoryVersion: 2,
    });
    expect(
      await readFile(
        path.join(outputDir, "sequential-markdown.zh.md"),
        "utf-8",
      ),
    ).toBe("阿尔法。\n\n贝塔。");

    server.enqueue({
      status: 500,
      body: {
        error: {
          message: "planned Markdown retranslation failure",
          type: "server_error",
          code: "planned_markdown_failure",
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

    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("Alpha memory committed.");
      expect(body).not.toContain("Beta memory committed.");
      return {
        body: createChatCompletionBody({
          content: formatSequentialMarkdownTargetResponse(
            payloads.get(segments[1].segmentId)!,
            "贝塔重译。",
            { currentSceneSummary: "Beta was retranslated." },
          ),
        }),
      };
    });
    const rerun = await recoveredService.resumeTask({
      taskId: created.data.taskId,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.data.status).toBe("completed");
    expect(
      (await repository.replayEvents(created.data.taskId)).staleSegmentIds,
    ).toEqual([]);
    expect(
      await readFile(
        path.join(outputDir, "sequential-markdown.zh (1).md"),
        "utf-8",
      ),
    ).toBe("阿尔法。\n\n贝塔重译。");
  });

  it("retries sequential Markdown placeholder mismatches without committing the rejected memory patch", async () => {
    const sourcePath = path.join(tempRoot, "sequential-placeholder.md");
    const outputDir = path.join(tempRoot, "out-sequential-placeholder");
    await writeFile(
      sourcePath,
      "A paragraph with `inline code`.",
      "utf-8",
    );

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-sequential-placeholder"),
    });
    const service = new TextTranslationService({ repository });
    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        outputMode: "bilingual",
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

    const segments = await repository.readSegmentsIndex<{ segmentId: string }>(
      created.data.taskId,
    );
    const payload =
      await repository.readSegmentSourcePayload<TestMarkdownBilingualPayload>(
        created.data.taskId,
        segments[0].segmentId,
      );
    const placeholder = payload.blocks
      .flatMap((block) => block.placeholders ?? [])
      .at(0);
    expect(placeholder).toBeDefined();

    server.enqueue({
      body: createChatCompletionBody({
        content: formatSequentialTranslationResponse(
          payload.segmentId,
          formatMarkdownBilingualTranslationResponse(payload.segmentId, [
            {
              blockId: payload.blocks[0].blockId,
              translatedMarkdown: "模型删除了保护占位符。",
            },
          ]),
          { currentSceneSummary: "REJECTED_MEMORY_PATCH" },
        ),
      }),
    });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("Retry correction:");
      expect(body).not.toContain("REJECTED_MEMORY_PATCH");
      return {
        body: createChatCompletionBody({
          content: formatSequentialTranslationResponse(
            payload.segmentId,
            formatMarkdownBilingualTranslationResponse(payload.segmentId, [
              {
                blockId: payload.blocks[0].blockId,
                translatedMarkdown: `一个段落包含 ${placeholder!.token}。`,
              },
            ]),
            { currentSceneSummary: "Accepted memory patch." },
          ),
        }),
      };
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");
    expect(server.requests).toHaveLength(2);
    expect(await repository.readMemoryLatest(created.data.taskId)).toMatchObject({
      version: 1,
      currentSceneSummary: "Accepted memory patch.",
    });
    expect(
      await readFile(
        path.join(outputDir, "sequential-placeholder.zh.md"),
        "utf-8",
      ),
    ).toBe(
      "A paragraph with `inline code`.\n\n> 一个段落包含 `inline code`。",
    );
  });

  it("shares sequential memory across ordered TXT and Markdown files", async () => {
    const txtPath = path.join(tempRoot, "mixed-01.txt");
    const markdownPath = path.join(tempRoot, "mixed-02.md");
    const outputDir = path.join(tempRoot, "out-mixed-project");
    await writeFile(txtPath, "Alpha.", "utf-8");
    await writeFile(markdownPath, "# Beta", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-mixed-project"),
    });
    const service = new TextTranslationService({ repository });
    const created = await service.createTask({
      files: [
        { sourcePath: txtPath, order: 0 },
        { sourcePath: markdownPath, order: 1 },
      ],
      options: createTextTranslationOptions({
        executionMode: "sequential_context",
        projectMode: "ordered_project",
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
    }>(created.data.taskId);
    expect(segments).toHaveLength(2);
    const markdownPayload =
      await repository.readSegmentSourcePayload<TestMarkdownTargetPayload>(
        created.data.taskId,
        segments[1].segmentId,
      );

    server.enqueue({
      body: createChatCompletionBody({
        content: formatSequentialTranslationResponse(
          segments[0].segmentId,
          "阿尔法。",
          { currentSceneSummary: "Mixed project memory." },
        ),
      }),
    });
    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).toContain("Mixed project memory.");
      expect(body).toContain("阿尔法。");
      return {
        body: createChatCompletionBody({
          content: formatSequentialMarkdownTargetResponse(
            markdownPayload,
            "贝塔",
            { currentSceneSummary: "Mixed project completed." },
          ),
        }),
      };
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");
    expect(
      await readFile(path.join(outputDir, "mixed-01.zh.txt"), "utf-8"),
    ).toBe("阿尔法。");
    expect(
      await readFile(path.join(outputDir, "mixed-02.zh.md"), "utf-8"),
    ).toBe("# 贝塔");
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

  it("translates a Markdown file in parallel target-only mode from frozen unit payloads", async () => {
    const sourcePath = path.join(tempRoot, "chapter.md");
    const outputDir = path.join(tempRoot, "out-markdown-target");
    const markdown = [
      "---",
      "title: Original Title",
      "---",
      "",
      "# Chapter One",
      "",
      "A paragraph with **strong text**, `inline code`, and [a link](https://example.com/path?q=1).",
      "",
      "```ts",
      'const untouched = "code";',
      "```",
    ].join("\n");
    await writeFile(sourcePath, markdown, "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-markdown-target"),
    });
    const service = new TextTranslationService({ repository });
    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
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
      sourceTextSnapshotPath: string;
    }>(created.data.taskId);
    expect(segments).toHaveLength(1);
    expect(segments[0].sourceTextSnapshotPath.endsWith(".json")).toBe(true);
    expect(
      await repository.readFileSourceSnapshot(
        created.data.taskId,
        segments[0].fileId,
      ),
    ).toBe(markdown);
    const payload =
      await repository.readSegmentSourcePayload<TestMarkdownTargetPayload>(
        created.data.taskId,
        segments[0].segmentId,
      );
    expect(payload.kind).toBe("markdown_target_only");

    server.enqueue((request) => {
      const body = JSON.stringify(request.body);
      expect(body).not.toContain("Original Title");
      expect(body).not.toContain("inline code");
      expect(body).not.toContain("https://example.com/path?q=1");
      expect(body).not.toContain("const untouched");
      return {
        body: createChatCompletionBody({
          content: formatMarkdownTargetOnlyTranslationResponse(
            payload.segmentId,
            payload.units.map((unit) => ({
              unitId: unit.unitId,
              translatedText: translateMarkdownUnit(unit.sourceText),
            })),
          ),
        }),
      };
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");

    const output = await readFile(
      path.join(outputDir, "chapter.zh.md"),
      "utf-8",
    );
    expect(output).toContain("title: Original Title");
    expect(output).toContain("# 第一章");
    expect(output).toContain(
      "一个段落包含 **加粗文本**、`inline code`，以及 [一个链接](https://example.com/path?q=1)。",
    );
    expect(output).toContain('const untouched = "code";');

    const persistedResult =
      await repository.readSegmentResultPayload<TestMarkdownTargetResult>(
        created.data.taskId,
        segments[0].segmentId,
      );
    expect(persistedResult).toMatchObject({
      schemaVersion: 1,
      kind: "markdown_target_only",
      segmentId: segments[0].segmentId,
    });
  });

  it("translates Markdown bilingual blocks and restores protected placeholders", async () => {
    const sourcePath = path.join(tempRoot, "bilingual.md");
    const outputDir = path.join(tempRoot, "out-markdown-bilingual");
    const markdown = [
      "---",
      "title: Original Title",
      "---",
      "",
      "# Chapter One",
      "",
      "A paragraph with `inline code` and [a link](https://example.com/path?q=1).",
    ].join("\n");
    await writeFile(sourcePath, markdown, "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-markdown-bilingual"),
    });
    const service = new TextTranslationService({ repository });
    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
        outputMode: "bilingual",
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
    const segments = await repository.readSegmentsIndex<{ segmentId: string }>(
      created.data.taskId,
    );
    expect(segments).toHaveLength(1);
    const payload =
      await repository.readSegmentSourcePayload<TestMarkdownBilingualPayload>(
        created.data.taskId,
        segments[0].segmentId,
      );
    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[1].sourceText).not.toContain("inline code");
    expect(payload.blocks[1].sourceText).not.toContain(
      "https://example.com/path?q=1",
    );

    server.enqueue({
      body: createChatCompletionBody({
        content: formatMarkdownBilingualTranslationResponse(
          payload.segmentId,
          payload.blocks.map((item) => ({
            blockId: item.blockId,
            translatedMarkdown: translateMarkdownBlock(item),
          })),
        ),
      }),
    });

    const completed = await service.startTask({ taskId: created.data.taskId });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe("completed");

    const output = await readFile(
      path.join(outputDir, "bilingual.zh.md"),
      "utf-8",
    );
    expect(output).toContain("# Chapter One\n\n> 第一章");
    expect(output).toContain(
      "A paragraph with `inline code` and [a link](https://example.com/path?q=1).\n\n> 一个段落包含 `inline code` 和 [一个链接](https://example.com/path?q=1)。",
    );
    expect(output.match(/title: Original Title/g)).toHaveLength(1);
  });

  it("resumes a partial Markdown task from frozen workspace sources after the source file is deleted", async () => {
    const sourcePath = path.join(tempRoot, "recover-source-missing.md");
    const outputDir = path.join(tempRoot, "out-markdown-recovery");
    await writeFile(sourcePath, "Alpha.\n\nBeta.", "utf-8");

    const repository = new TextTranslationWorkspaceRepository({
      tasksRoot: path.join(tempRoot, "tasks-markdown-recovery"),
    });
    const service = new TextTranslationService({ repository });
    const created = await service.createTask({
      files: [{ sourcePath, order: 0 }],
      options: createTextTranslationOptions({
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
    const segments = await repository.readSegmentsIndex<{ segmentId: string }>(
      created.data.taskId,
    );
    expect(segments).toHaveLength(2);
    const payloads = new Map<string, TestMarkdownTargetPayload>();
    for (const segment of segments) {
      payloads.set(
        segment.segmentId,
        await repository.readSegmentSourcePayload<TestMarkdownTargetPayload>(
          created.data.taskId,
          segment.segmentId,
        ),
      );
    }

    const firstSegmentId = segments[0].segmentId;
    const initialResponder = createMarkdownTargetResponder({
      payloads,
      failSegmentId: segments[1].segmentId,
    });
    for (let index = 0; index < 4; index += 1) {
      server.enqueue(initialResponder);
    }

    const partial = await service.startTask({ taskId: created.data.taskId });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.status).toBe("partially_completed");
    expect(
      await repository.readSegmentResultPayload(
        created.data.taskId,
        firstSegmentId,
      ),
    ).toMatchObject({ segmentId: firstSegmentId });

    await unlink(sourcePath);
    const recoveredService = new TextTranslationService({ repository });
    const recoverable = await recoveredService.listRecoverableTasks();
    expect(recoverable.ok).toBe(true);
    if (!recoverable.ok) return;
    expect(recoverable.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: created.data.taskId,
          resumable: true,
          sourceStatus: "missing",
          completedSegmentCount: 1,
        }),
      ]),
    );

    server.enqueue(createMarkdownTargetResponder({ payloads }));
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
    expect(server.requests.length - requestCountBeforeResume).toBe(1);
    expect(
      await readFile(
        path.join(outputDir, "recover-source-missing.zh.md"),
        "utf-8",
      ),
    ).toBe("阿尔法。\n\n贝塔。");
  });
});

interface TestProtectedPlaceholder {
  token: string;
  source: string;
  kind: string;
}

interface TestMarkdownTargetPayload {
  schemaVersion: 1;
  kind: "markdown_target_only";
  segmentId: string;
  units: Array<{
    unitId: string;
    sourceText: string;
    placeholders?: TestProtectedPlaceholder[];
  }>;
}

interface TestMarkdownTargetResult {
  schemaVersion: 1;
  kind: "markdown_target_only";
  segmentId: string;
}

interface TestMarkdownBilingualPayload {
  schemaVersion: 1;
  kind: "markdown_bilingual";
  segmentId: string;
  blocks: Array<{
    blockId: string;
    sourceText: string;
    placeholders?: TestProtectedPlaceholder[];
    block: {
      nodeType: string;
    };
  }>;
}

function translateMarkdownUnit(sourceText: string): string {
  const translations: Record<string, string> = {
    "Chapter One": "第一章",
    "A paragraph with ": "一个段落包含 ",
    "strong text": "加粗文本",
    ", ": "、",
    ", and ": "，以及 ",
    "a link": "一个链接",
    ".": "。",
    "Alpha.": "阿尔法。",
    "Beta.": "贝塔。",
  };
  return translations[sourceText] ?? sourceText;
}

function translateMarkdownBlock(
  item: TestMarkdownBilingualPayload["blocks"][number],
): string {
  if (item.block.nodeType === "heading") return "第一章";
  return item.sourceText
    .replace("A paragraph with ", "一个段落包含 ")
    .replace(" and ", " 和 ")
    .replace("[a link]", "[一个链接]")
    .replace(/\.$/, "。");
}

function createMarkdownTargetResponder(input: {
  payloads: Map<string, TestMarkdownTargetPayload>;
  failSegmentId?: string;
}) {
  return (request: { body: Record<string, unknown> }) => {
    const body = JSON.stringify(request.body);
    const segmentId = body.match(
      /FUSIONKIT_MARKDOWN_TARGET_ONLY:([^>\\]+)>>>/,
    )?.[1];
    if (!segmentId) {
      throw new Error("Markdown target protocol id was not found in request.");
    }
    if (segmentId === input.failSegmentId) {
      return {
        status: 500,
        body: {
          error: {
            message: "planned Markdown segment failure",
            type: "server_error",
            code: "planned_markdown_failure",
          },
        },
      };
    }
    const payload = input.payloads.get(segmentId);
    if (!payload) {
      throw new Error(`Markdown payload not found for segment: ${segmentId}`);
    }
    return {
      body: createChatCompletionBody({
        content: formatMarkdownTargetOnlyTranslationResponse(
          segmentId,
          payload.units.map((unit) => ({
            unitId: unit.unitId,
            translatedText: translateMarkdownUnit(unit.sourceText),
          })),
        ),
      }),
    };
  };
}

async function readMarkdownTargetPayloads(
  repository: TextTranslationWorkspaceRepository,
  taskId: string,
  segments: Array<{ segmentId: string }>,
): Promise<Map<string, TestMarkdownTargetPayload>> {
  const payloads = new Map<string, TestMarkdownTargetPayload>();
  for (const segment of segments) {
    payloads.set(
      segment.segmentId,
      await repository.readSegmentSourcePayload<TestMarkdownTargetPayload>(
        taskId,
        segment.segmentId,
      ),
    );
  }
  return payloads;
}

function formatSequentialMarkdownTargetResponse(
  payload: TestMarkdownTargetPayload,
  translatedText: string,
  memoryPatch: unknown,
): string {
  return formatSequentialTranslationResponse(
    payload.segmentId,
    formatMarkdownTargetOnlyTranslationResponse(
      payload.segmentId,
      payload.units.map((unit) => ({
        unitId: unit.unitId,
        translatedText,
      })),
    ),
    memoryPatch,
  );
}
