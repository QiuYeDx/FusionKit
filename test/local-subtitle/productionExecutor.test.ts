import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  createLocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleFormat,
  type LocalSubtitleTaskSummary,
} from "../../src/type/localSubtitle";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import type {
  LocalSubtitleJobBatchRuntime,
  LocalSubtitleJobTaskExecutionContext,
} from "../../electron/main/local-subtitle/job-manager";
import type {
  LocalSubtitleBrandedPcmWindow,
  LocalSubtitleMediaStructuralWindow,
  LocalSubtitleNormalizedPcm,
  LocalSubtitleResolvedPcmWindow,
} from "../../electron/main/local-subtitle/media-normalizer";
import { LocalSubtitleProductionExecutor } from "../../electron/main/local-subtitle/production-executor";
import type { LocalSubtitleVerifiedRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";
import type {
  LocalSubtitleServerInferenceRequest,
  LocalSubtitleServerInferenceResponse,
} from "../../electron/main/local-subtitle/server-contract";
import type {
  LocalSubtitleServerInferenceOperation,
  LocalSubtitleServerLease,
  LocalSubtitleServerRequestTicket,
  LocalSubtitleServerRuntimePin,
  LocalSubtitleServerSupervisorInferenceResponse,
} from "../../electron/main/local-subtitle/server-supervisor";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import {
  LocalSubtitleExporter,
  type LocalSubtitleExporterDependencies,
} from "../../electron/main/local-subtitle/subtitle-exporter";
import {
  localSubtitleFilesystemObjectIdentityForPath,
} from "../../electron/main/local-subtitle/filesystem-object-identity";

const OWNER: LocalSubtitleOwnerKey = Object.freeze({
  webContentsId: 71,
  ownerSessionId: "production-executor-owner",
});
const MODEL_HASH = LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256;
const WINDOW_HASH = "a".repeat(64);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local subtitle production executor", () => {
  it("binds one branded PCM attempt and activates a readable SRT artifact", async () => {
    const harness = await createHarness();

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      durationMs: 10_000,
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    const first = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    const second = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    expect(second).toEqual(first);
    expect(first.rawText).toContain("00:00:01,000 --> 00:00:03,000");
    expect(harness.media.resolveWindow).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(1);
    const request = harness.supervisor.beginInference.mock.calls[0]![1];
    expect(request).toMatchObject({
      requestGeneration: 1,
      expectedFileIdentity: {
        dev: 1,
        ino: 1,
        size: expect.any(Number),
      },
      taskMode: "transcribe",
      vadEnabled: false,
    });
    expect(Object.isFrozen(request.expectedFileIdentity)).toBe(true);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
    expect(harness.supervisor.release).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.outputs.resolveBatchLease).toHaveBeenCalled();
    expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
    expect(harness.context.update.mock.calls.map(([update]) => update.status)).toEqual([
      "preparing_media",
      "loading_model",
      "loading_model",
      "transcribing",
      "transcribing",
      "post_processing",
      "post_processing",
      "exporting",
    ]);
  });

  it("uses only the task input parent resolver for source output", async () => {
    const harness = await createHarness({ outputMode: "source" });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });

    expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
    expect(
      harness.inputs.resolveTaskSourceOutputDirectory,
    ).toHaveBeenCalledTimes(4);
    for (const call of harness.inputs.resolveTaskSourceOutputDirectory.mock.calls) {
      expect(call).toEqual([OWNER, "task-1", "file-token-1"]);
    }
  });

  it("exports an LRC-only artifact through the production pipeline", async () => {
    const harness = await createHarness({ formats: ["LRC"] });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [{ format: "LRC", status: "committed" }],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    await expect(
      harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
    ).resolves.toMatchObject({
      format: "LRC",
      rawText: expect.stringMatching(/^\[00:01\.00\]/u),
    });
  });

  it.each([
    ["SRT", "LRC"],
    ["LRC", "SRT"],
  ] as const)(
    "commits source output formats in request order: %s then %s",
    async (first, second) => {
      const harness = await createHarness({
        outputMode: "source",
        formats: [first, second],
      });

      const result = await harness.executor.execute(harness.context);

      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: first, status: "committed" },
          { format: second, status: "committed" },
        ],
      });
      expect(
        harness.inputs.resolveTaskSourceOutputDirectory,
      ).toHaveBeenCalledTimes(7);
      expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
    },
  );

  it("keeps the first production artifact when the second format fails", async () => {
    const harness = await createHarness({
      formats: ["SRT", "LRC"],
      failArtifactReserveFormat: "LRC",
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        { format: "SRT", status: "committed" },
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    await expect(
      harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
    ).resolves.toMatchObject({ format: "SRT" });
  });

  it.each([
    ["without cancellation", false, "cleanup_failed"],
    ["after synchronous cancellation", true, "cancel_failed"],
  ] as const)(
    "keeps a readable SRT when LRC commit and partial cleanup fail %s",
    async (_case, abortDuringCleanup, expectedErrorCode) => {
      let failedLrcPartialPath: string | undefined;
      const harness = await createHarness({
        formats: ["SRT", "LRC"],
        exporterDependencies: (controller) => ({
          commitIndex: async (partialPath, finalPath) => {
            if (finalPath.endsWith(".lrc")) {
              failedLrcPartialPath = partialPath;
              throw Object.assign(new Error("LRC commit failed"), { code: "EIO" });
            }
            await link(partialPath, finalPath);
          },
          removeFile: async (filePath) => {
            if (filePath === failedLrcPartialPath) {
              if (abortDuringCleanup) controller.abort();
              throw Object.assign(new Error("LRC partial cleanup failed"), {
                code: "EACCES",
              });
            }
            await unlink(filePath);
          },
        }),
      });

      const result = await harness.executor.execute(harness.context);

      expect(harness.controller.signal.aborted).toBe(abortDuringCleanup);
      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: "SRT", status: "committed" },
          { format: "LRC", status: "failed", errorCode: expectedErrorCode },
        ],
      });
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      const first = await harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      );
      const second = await harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      );
      expect(second).toEqual(first);
      expect(first).toMatchObject({ format: "SRT" });
      await expect(lstat(path.join(harness.outputRoot, "meeting.srt"))).resolves
        .toMatchObject({ size: expect.any(Number) });
      await expect(lstat(path.join(harness.outputRoot, "meeting.lrc"))).rejects
        .toMatchObject({ code: "ENOENT" });
      if (!failedLrcPartialPath) throw new Error("Expected failed LRC partial.");
      await expect(lstat(failedLrcPartialPath)).resolves.toMatchObject({
        size: expect.any(Number),
      });
    },
  );

  it.each(["custom", "source"] as const)(
    "keeps the first artifact when the %s directory resolver fails before the second format",
    async (outputMode) => {
      const harness = await createHarness({
        outputMode,
        formats: ["SRT", "LRC"],
      });
      let resolutions = 0;
      const failBeforeSecondFormat = async () => {
        resolutions += 1;
        const failingResolution = outputMode === "source" ? 5 : 4;
        if (resolutions === failingResolution) {
          throw Object.assign(new Error("output directory resolution failed"), {
            code: "output_write_failed",
          });
        }
        return resolvedOutputDirectory(harness.outputRoot);
      };
      if (outputMode === "source") {
        harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
          failBeforeSecondFormat,
        );
      } else {
        harness.outputs.resolveBatchLease.mockImplementation(failBeforeSecondFormat);
      }

      const result = await harness.executor.execute(harness.context);

      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: "SRT", status: "committed" },
          { format: "LRC", status: "failed", errorCode: "output_write_failed" },
        ],
      });
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      await expect(
        harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
      ).resolves.toMatchObject({ format: "SRT" });
      expect(resolutions).toBe(outputMode === "source" ? 5 : 4);
    },
  );

  it.each(["custom", "source"] as const)(
    "executes %s overwrite when the exporter has commit authority",
    async (outputMode) => {
      const commitOverwrite = vi.fn(rename);
      const harness = await createHarness({
        outputMode,
        conflictPolicy: "overwrite",
        exporterDependencies: () => ({ commitOverwrite }),
      });
      const finalPath = path.join(harness.outputRoot, "meeting.srt");
      await writeFile(finalPath, "previous subtitle", { mode: 0o600 });

      const result = await harness.executor.execute(harness.context);
      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [{ format: "SRT", status: "committed" }],
      });
      expect(commitOverwrite).toHaveBeenCalledOnce();
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      await expect(harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      )).resolves.toMatchObject({ rawText: expect.stringContaining("cue-0") });
    },
  );

  it("preserves the first production artifact when cancellation follows its commit", async () => {
    const harness = await createHarness({
      formats: ["SRT", "LRC"],
      abortAfterArtifactFormat: "SRT",
    });

    const result = await harness.executor.execute(harness.context);

    expect(harness.controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        { format: "SRT", status: "committed" },
        {
          format: "LRC",
          status: "skipped",
          errorCode: "cancelled_after_partial_commit",
        },
      ],
    });
  });

  it("fails source output preflight before media or runtime work", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory.mockRejectedValueOnce(
      Object.assign(new Error("source parent changed"), {
        code: "media_changed",
      }),
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "preparing_media" },
      artifactResults: [],
    });

    expect(harness.media.normalizeTask).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
  });

  it("rejects source parent identity drift between preflight and export", async () => {
    const harness = await createHarness({ outputMode: "source" });
    const preflightRoot = path.join(harness.root, "preflight-parent");
    const exportRoot = path.join(harness.root, "export-parent");
    await Promise.all([mkdir(preflightRoot), mkdir(exportRoot)]);
    let resolution = 0;
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(async () =>
      resolvedOutputDirectory(resolution++ === 0 ? preflightRoot : exportRoot),
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_write_failed", stage: "exporting" },
    });

    expect(resolution).toBe(2);
    await expect(lstat(path.join(preflightRoot, "meeting.srt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(exportRoot, "meeting.srt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stabilizes a source parent failure during export", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory
      .mockResolvedValueOnce(await resolvedOutputDirectory(harness.outputRoot))
      .mockRejectedValueOnce(
        Object.assign(new Error("source lease expired after transcription"), {
          code: "authorization_expired",
        }),
      );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "authorization_expired", stage: "preflight" },
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "authorization_expired" },
      ],
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).toHaveBeenCalledOnce();
  });

  it("resolves each source task to its own parent directory", async () => {
    const harness = await createHarness({ outputMode: "source" });
    const firstRoot = path.join(harness.root, "first-parent");
    const secondRoot = path.join(harness.root, "second-parent");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
      async (_owner, taskId, expectedFileToken) => {
        expect(expectedFileToken).toBe(
          taskId === "task-1" ? "file-token-1" : "file-token-2",
        );
        return resolvedOutputDirectory(
          taskId === "task-1" ? firstRoot : secondRoot,
        );
      },
    );
    const sibling = createContext(
      new AbortController().signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
      { taskId: "task-2", fileToken: "file-token-2" },
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });

    await expect(lstat(path.join(firstRoot, "meeting.srt"))).resolves.toBeDefined();
    await expect(lstat(path.join(secondRoot, "meeting.srt"))).resolves.toBeDefined();
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
  });

  it("lets a source sibling continue after the first task parent preflight fails", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
      async (_owner, taskId) => {
        if (taskId === "task-1") {
          throw Object.assign(new Error("source parent is unavailable"), {
            code: "output_write_failed",
          });
        }
        return resolvedOutputDirectory(harness.outputRoot);
      },
    );
    const sibling = createContext(
      new AbortController().signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
      { taskId: "task-2", fileToken: "file-token-2" },
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_write_failed", stage: "exporting" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();

    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
  });

  it.each(["custom", "source"] as const)(
    "rejects %s overwrite contexts before resolving or executing",
    async (outputMode) => {
      const harness = await createHarness();
      const config = createConfig(outputMode, "overwrite");
      expect(() =>
        harness.executor.beginBatchSlice(Object.freeze({
          owner: OWNER,
          batchId: "overwrite-batch",
          config,
          managedModel: harness.context.managedModel,
          admittedRuntimeGeneration: harness.context.admittedRuntimeGeneration,
          signal: new AbortController().signal,
        }))).toThrow();

      await expect(
        harness.executor.execute(Object.freeze({ ...harness.context, config })),
      ).resolves.toMatchObject({
        status: "failed",
        error: { code: "invalid_ipc_request", stage: "preflight" },
      });
      expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
      expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
      expect(harness.media.normalizeTask).not.toHaveBeenCalled();
      expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    },
  );

  it("splits a degenerate root into exact retry children with unique identities", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      inference: ({ request, window, index }) =>
        index === 0
          ? repeatedResponse(request, window)
          : validResponse(request, window, `child-${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result.status).toBe("completed");
    expect(harness.media.materializeWindow).toHaveBeenCalledTimes(3);
    expect(
      harness.media.materializeWindow.mock.calls.map(
        ([options]) => options.descriptor.parentWindowKey,
      ),
    ).toEqual([undefined, "w000000", "w000000"]);
    const generations = harness.supervisor.beginInference.mock.calls.map(
      ([, request]) => request.requestGeneration,
    );
    expect(generations).toEqual([1, 2, 3]);
    expect(new Set(generations).size).toBe(3);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(3);
  });

  it("rejects a post-response PCM proof change before post-processing or export", async () => {
    const harness = await createHarness({ mutateSecondResolve: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
  });

  it("rejects a branded window from another normalization", async () => {
    const harness = await createHarness({
      brandNormalizationId: "normalization-swapped",
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.media.resolveWindow).not.toHaveBeenCalled();
    expect(harness.supervisor.beginInference).not.toHaveBeenCalled();
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects reuse of a branded window across retry attempts", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      reuseWindowBrand: true,
      inference: ({ request, window }) => repeatedResponse(request, window),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a stale response generation and leaves no artifact", async () => {
    const harness = await createHarness({
      inference: ({ request, window }) => ({
        processEpoch: 1,
        response: {
          ...validResponse(request, window, "stale").response,
          requestGeneration: request.requestGeneration + 1,
        },
      }),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "runtime_protocol_mismatch", stage: "transcribing" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("fails closed when retained raw text exceeds the file budget across roots", async () => {
    const harness = await createHarness({
      totalFrames: 50 * 16_000,
      retainedRawBudget: { maxSegments: 10, maxTextBytes: 20 },
      inference: ({ request, window, index }) =>
        validResponse(request, window, `rawtext${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "limit_exceeded", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(2);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("counts degenerate parents and retry children in one segment budget", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      retainedRawBudget: { maxSegments: 8, maxTextBytes: 1_024 },
      inference: ({ request, window, index }) =>
        index === 0
          ? repeatedResponse(request, window)
          : validResponse(request, window, `child-${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "limit_exceeded", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(2);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects runtime generation drift before acquiring a server lease", async () => {
    const harness = await createHarness({
      serverRuntimeGeneration: "c".repeat(64),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.media.materializeWindow).not.toHaveBeenCalled();
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a runtime generation that changed after batch admission", async () => {
    const harness = await createHarness({
      admittedRuntimeGeneration: "c".repeat(64),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.media.materializeWindow).not.toHaveBeenCalled();
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("pins lazily after media succeeds and keeps the same pin for later tasks", async () => {
    const harness = await createHarness();
    harness.media.normalizeTask.mockRejectedValueOnce(new Error("decode failed"));

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_decode_failed" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledTimes(2);
  });

  it("rejects exact server artifact drift after a batch pin is established", async () => {
    const generation = "b".repeat(64);
    const runtimeRoot = path.join(os.tmpdir(), "fusionkit-pinned-runtime-proof");
    const harness = await createHarness({
      serverRuntimeBundles: [
        fakeVerifiedServerRuntime(
          runtimeRoot,
          generation,
          path.join(runtimeRoot, "runtime", "server-a"),
        ),
        fakeVerifiedServerRuntime(
          runtimeRoot,
          generation,
          path.join(runtimeRoot, "runtime", "server-b"),
        ),
      ],
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
  });

  it("releases a pin acquired after its batch runtime closes exactly once", async () => {
    const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
    let resolvePin!: (pin: LocalSubtitleServerRuntimePin) => void;
    const pendingPin = new Promise<LocalSubtitleServerRuntimePin>((resolve) => {
      resolvePin = resolve;
    });
    const harness = await createHarness({
      acquireBatchRuntimePin: () => pendingPin,
    });
    const execution = harness.executor.execute(harness.context);
    await waitFor(
      () => harness.supervisor.acquireBatchRuntimePin.mock.calls.length === 1,
    );

    harness.executor.endBatchSlice(harness.context.batchRuntime);
    resolvePin(runtimePin);

    await expect(execution).resolves.toMatchObject({
      status: "failed",
      error: { code: "owner_released", stage: "loading_model" },
    });
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledWith(runtimePin);
  });

  it("keeps a shared pending pin for a sibling when the current task is cancelled", async () => {
    const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
    let resolvePin!: (pin: LocalSubtitleServerRuntimePin) => void;
    const pendingPin = new Promise<LocalSubtitleServerRuntimePin>((resolve) => {
      resolvePin = resolve;
    });
    const harness = await createHarness({
      acquireBatchRuntimePin: () => pendingPin,
    });
    const first = harness.executor.execute(harness.context);
    await waitFor(
      () => harness.supervisor.acquireBatchRuntimePin.mock.calls.length === 1,
    );

    harness.controller.abort();

    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    expect(harness.supervisor.releaseBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin.mock.calls[0]![3]).toBe(
      harness.sliceController.signal,
    );

    resolvePin(runtimePin);
    await Promise.resolve();
    await Promise.resolve();
    const siblingController = new AbortController();
    const sibling = createContext(
      siblingController.signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
    );

    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
    expect(harness.supervisor.releaseBatchRuntimePin).not.toHaveBeenCalled();

    harness.executor.endBatchSlice(harness.context.batchRuntime);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledWith(runtimePin);
  });

  it("rejects a task after its batch runtime slice is closed", async () => {
    const harness = await createHarness();
    harness.executor.endBatchSlice(harness.context.batchRuntime);

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid_ipc_request", stage: "preflight" },
    });
    expect(harness.media.normalizeTask).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
  });

  it("sanitizes Windows device names before reserving an artifact", async () => {
    const harness = await createHarness({ displayName: "CON.wav" });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        {
          format: "SRT",
          status: "committed",
          artifact: { displayName: "_CON.srt" },
        },
      ],
    });
  });

  it("keeps a long Windows device stem within the leaf byte limit", async () => {
    const harness = await createHarness({
      displayName: `CON.${"a".repeat(247)}.wav`,
    });

    const result = await harness.executor.execute(harness.context);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    expect(artifact.artifact.displayName).toMatch(/^_CON\./u);
    expect(Buffer.byteLength(artifact.artifact.displayName, "utf8"))
      .toBeLessThanOrEqual(255);
  });

  it("cancels the active Supervisor ticket and cleans private media", async () => {
    const pending = deferred<LocalSubtitleServerSupervisorInferenceResponse>();
    const harness = await createHarness({
      beginInference: (request) => ({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: pending.promise,
      }),
      cancelRequest: async () => {
        pending.reject(new Error("aborted"));
      },
    });

    const execution = harness.executor.execute(harness.context);
    await waitFor(() => harness.supervisor.beginInference.mock.calls.length === 1);
    harness.controller.abort();
    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(harness.supervisor.cancelRequest).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.release).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("promotes cancellation cleanup failure above ordinary cancellation", async () => {
    const pending = deferred<LocalSubtitleServerSupervisorInferenceResponse>();
    const harness = await createHarness({
      beginInference: () => ({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: pending.promise,
      }),
      cancelRequest: async () => {
        pending.reject(new Error("aborted"));
        throw new Error("native request did not settle cleanly");
      },
    });

    const execution = harness.executor.execute(harness.context);
    await waitFor(() => harness.supervisor.beginInference.mock.calls.length === 1);
    harness.controller.abort();
    const result = await execution;

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("blocks export when required media cleanup fails", async () => {
    const harness = await createHarness({ disposeNormalizedFailure: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("continues normalized cleanup when Supervisor release fails", async () => {
    const harness = await createHarness({ releaseFailure: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.supervisor.release).toHaveBeenCalledOnce();
    expect(harness.media.disposeNormalized).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("keeps request generations monotonic across execute calls", async () => {
    const harness = await createHarness();

    const first = await harness.executor.execute(harness.context);
    const second = await harness.executor.execute(harness.context);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(
      harness.supervisor.beginInference.mock.calls.map(
        ([, request]) => request.requestGeneration,
      ),
    ).toEqual([1, 2]);
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.release).toHaveBeenCalledTimes(2);
    harness.executor.endBatchSlice(harness.context.batchRuntime);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
  });

  it("reports exporter cleanup failures at the cleanup stage", async () => {
    const returnedFailure = await createHarness();
    returnedFailure.exporter.exportArtifacts.mockResolvedValueOnce({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cancel_failed" },
      ],
    });

    await expect(returnedFailure.executor.execute(returnedFailure.context)).resolves
      .toMatchObject({
        status: "failed",
        error: { code: "cleanup_failed", stage: "cleanup" },
        artifactResults: [
          { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
        ],
      });

    const thrownFailure = await createHarness();
    thrownFailure.exporter.exportArtifacts.mockRejectedValueOnce(
      Object.assign(new Error("partial cleanup failed"), {
        localSubtitleCode: "cancel_failed",
      }),
    );

    await expect(thrownFailure.executor.execute(thrownFailure.context)).resolves
      .toMatchObject({
        status: "failed",
        error: { code: "cleanup_failed", stage: "cleanup" },
      });
  });

  it.each([
    [
      ["SRT", "LRC"],
      [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        { format: "LRC", status: "failed", errorCode: "cleanup_failed" },
      ],
    ],
    [
      ["LRC", "SRT"],
      [
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
        { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
      ],
    ],
  ] as const)(
    "prioritizes a later cleanup failure for %j",
    async (formats, artifactResults) => {
      const harness = await createHarness({ formats });
      harness.exporter.exportArtifacts.mockResolvedValueOnce({
        status: "failed",
        artifactResults,
      });

      await expect(harness.executor.execute(harness.context)).resolves
        .toMatchObject({
          status: "failed",
          error: { code: "cleanup_failed", stage: "cleanup" },
          artifactResults,
        });
    },
  );

  it("normalizes every cleanup artifact when cancellation wins", async () => {
    const harness = await createHarness({ formats: ["SRT", "LRC"] });
    harness.exporter.exportArtifacts.mockImplementationOnce(async () => {
      harness.controller.abort();
      return {
        status: "failed",
        artifactResults: [
          { format: "SRT", status: "failed", errorCode: "output_write_failed" },
          { format: "LRC", status: "failed", errorCode: "cleanup_failed" },
        ],
      };
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        { format: "LRC", status: "failed", errorCode: "cancel_failed" },
      ],
    });
  });

  it("maps a non-cancel pipeline cleanup failure to cleanup_failed", async () => {
    const harness = await createHarness({
      normalizeFailure: Object.assign(new Error("media cleanup failed"), {
        localSubtitleCode: "cancel_failed",
      }),
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("maps an aborted pipeline cleanup failure to cancel_failed", async () => {
    const harness = await createHarness();
    harness.media.normalizeTask.mockImplementationOnce(async () => {
      harness.controller.abort();
      throw Object.assign(new Error("media cleanup failed after abort"), {
        localSubtitleCode: "cleanup_failed",
      });
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  readonly totalFrames?: number;
  readonly displayName?: string;
  readonly brandNormalizationId?: string;
  readonly reuseWindowBrand?: boolean;
  readonly serverRuntimeGeneration?: string;
  readonly serverRuntimeBundles?: readonly LocalSubtitleVerifiedRuntimeBundle[];
  readonly admittedRuntimeGeneration?: string;
  readonly mutateSecondResolve?: boolean;
  readonly disposeNormalizedFailure?: boolean;
  readonly releaseFailure?: boolean;
  readonly acquireBatchRuntimePin?: () => Promise<LocalSubtitleServerRuntimePin>;
  readonly normalizeFailure?: unknown;
  readonly outputMode?: "custom" | "source";
  readonly conflictPolicy?: LocalSubtitleConflictPolicy;
  readonly formats?: readonly LocalSubtitleFormat[];
  readonly failArtifactReserveFormat?: LocalSubtitleFormat;
  readonly abortAfterArtifactFormat?: LocalSubtitleFormat;
  readonly exporterDependencies?: (
    controller: AbortController,
  ) => LocalSubtitleExporterDependencies;
  readonly retainedRawBudget?: Readonly<{
    maxSegments: number;
    maxTextBytes: number;
  }>;
  readonly inference?: (input: {
    readonly request: LocalSubtitleServerInferenceRequest;
    readonly window: LocalSubtitleMediaStructuralWindow;
    readonly index: number;
  }) => LocalSubtitleServerSupervisorInferenceResponse;
  readonly beginInference?: (
    request: LocalSubtitleServerInferenceRequest,
  ) => LocalSubtitleServerInferenceOperation;
  readonly cancelRequest?: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "fusionkit-production-executor-")),
  );
  tempRoots.push(root);
  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot);
  const controller = new AbortController();
  const sliceController = new AbortController();
  const totalFrames = options.totalFrames ?? 10 * 16_000;
  const normalized: LocalSubtitleNormalizedPcm = Object.freeze({
    schemaVersion: 1,
    normalizationId: "normalization-1",
    taskId: "task-1",
    taskGeneration: 1,
    displayName: options.displayName ?? "meeting.wav",
    runtimeGeneration: "b".repeat(64),
    selectedStreamId: "stream-1",
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    totalFrames,
    durationMs: Math.round((totalFrames * 1_000) / 16_000),
    dataSizeBytes: totalFrames * 2,
  });
  const windowByPath = new Map<string, LocalSubtitleMediaStructuralWindow>();
  const resolveCount = new Map<string, number>();
  let nextWindow = 0;
  let firstBrand: LocalSubtitleBrandedPcmWindow | undefined;
  const media = {
    normalizeTask: vi.fn(async (request: {
      taskId: string;
      taskGeneration: number;
      onProgress?: (value: number) => void;
    }) => {
      if (options.normalizeFailure !== undefined) throw options.normalizeFailure;
      request.onProgress?.(100);
      return deepFreeze({
        ...normalized,
        normalizationId:
          request.taskId === "task-1"
            ? normalized.normalizationId
            : `normalization-${request.taskId}`,
        taskId: request.taskId,
        taskGeneration: request.taskGeneration,
      });
    }),
    materializeWindow: vi.fn(async (request: {
      normalized: LocalSubtitleNormalizedPcm;
      descriptor: LocalSubtitleMediaStructuralWindow;
    }) => {
      if (options.reuseWindowBrand && firstBrand) return firstBrand;
      const windowId = `window-${++nextWindow}`;
      const byteSize = 44 + (request.descriptor.endFrame - request.descriptor.startFrame) * 2;
      const brand = deepFreeze({
        schemaVersion: 1 as const,
        windowId,
        normalizationId:
          options.brandNormalizationId ?? request.normalized.normalizationId,
        taskId: request.normalized.taskId,
        taskGeneration: request.normalized.taskGeneration,
        descriptor: request.descriptor,
        frameCount: request.descriptor.endFrame - request.descriptor.startFrame,
        durationMs: request.descriptor.endMs - request.descriptor.startMs,
        byteSize,
        sha256: WINDOW_HASH,
      });
      firstBrand = brand;
      windowByPath.set(path.join(root, `${windowId}.wav`), request.descriptor);
      return brand;
    }),
    resolveWindow: vi.fn(async (brand: LocalSubtitleBrandedPcmWindow) => {
      const filePath = path.join(root, `${brand.windowId}.wav`);
      const count = (resolveCount.get(brand.windowId) ?? 0) + 1;
      resolveCount.set(brand.windowId, count);
      return Object.freeze({
        filePath,
        fileIdentity: Object.freeze({
          dev: 1,
          ino: nextWindow,
          size: brand.byteSize,
          mtimeMs: 10,
          ctimeMs: 10,
        }),
        byteSize: brand.byteSize,
        sha256:
          options.mutateSecondResolve && count === 2
            ? "c".repeat(64)
            : brand.sha256,
      }) as LocalSubtitleResolvedPcmWindow;
    }),
    disposeWindow: vi.fn(async () => ({ removed: true })),
    disposeNormalized: vi.fn(async () => {
      if (options.disposeNormalizedFailure) throw new Error("cleanup failed");
      return { removed: true };
    }),
  };
  let inferenceIndex = 0;
  const lease = Object.freeze({}) as LocalSubtitleServerLease;
  const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
  const supervisor = {
    acquireBatchRuntimePin: vi.fn(
      options.acquireBatchRuntimePin ?? (async () => runtimePin),
    ),
    acquirePinnedTaskLease: vi.fn(async () => lease),
    beginInference: vi.fn((
      _lease: LocalSubtitleServerLease,
      request: LocalSubtitleServerInferenceRequest,
    ) => {
      if (options.beginInference) return options.beginInference(request);
      const window = windowByPath.get(request.filePath);
      if (!window) throw new Error("Missing fake window descriptor.");
      const result = options.inference?.({
        request,
        window,
        index: inferenceIndex++,
      }) ?? validResponse(request, window, `cue-${inferenceIndex++}`);
      return Object.freeze({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: Promise.resolve(result),
      });
    }),
    cancelRequest: vi.fn(async () => options.cancelRequest?.()),
    release: vi.fn(async () => {
      if (options.releaseFailure) throw new Error("server release failed");
    }),
    releaseBatchRuntimePin: vi.fn(() => undefined),
  };
  const artifacts = new LocalSubtitleArtifactRegistry({
    tokenFactory: sequence("artifact"),
    reservationFactory: sequence("reservation"),
  });
  const exporterArtifacts = {
    reserve: (request: Parameters<typeof artifacts.reserve>[0]) => {
      if (request.format === options.failArtifactReserveFormat) {
        throw new Error("artifact reservation failed");
      }
      return artifacts.reserve(request);
    },
    activate: (...args: Parameters<typeof artifacts.activate>) => {
      const summary = artifacts.activate(...args);
      if (summary.format === options.abortAfterArtifactFormat) {
        controller.abort();
      }
      return summary;
    },
    revokeReservation: (reservation: string) =>
      artifacts.revokeReservation(reservation),
    revokeArtifact: (...args: Parameters<typeof artifacts.revokeArtifact>) =>
      artifacts.revokeArtifact(...args),
  };
  const realExporter = new LocalSubtitleExporter(exporterArtifacts, {
    ...options.exporterDependencies?.(controller),
    createPartialId: sequence("partial"),
  });
  const exporter = {
    exportArtifacts: vi.fn(realExporter.exportArtifacts.bind(realExporter)),
    supportsConflictPolicy: vi.fn(
      realExporter.supportsConflictPolicy.bind(realExporter),
    ),
  };
  const outputs = {
    resolveBatchLease: vi.fn(async () => resolvedOutputDirectory(outputRoot)),
  };
  const inputs = {
    resolveTaskSourceOutputDirectory: vi.fn(async () =>
      resolvedOutputDirectory(outputRoot),
    ),
  };
  const defaultServerRuntime = fakeVerifiedServerRuntime(
    root,
    options.serverRuntimeGeneration ?? normalized.runtimeGeneration,
  );
  let serverRuntimeIndex = 0;
  const executor = new LocalSubtitleProductionExecutor({
    media,
    supervisor,
    inputs,
    outputs,
    exporter,
    verifyServerRuntime: async () => {
      const configured = options.serverRuntimeBundles;
      if (!configured || configured.length === 0) return defaultServerRuntime;
      const runtime = configured[Math.min(serverRuntimeIndex, configured.length - 1)]!;
      serverRuntimeIndex += 1;
      return runtime;
    },
    selectCpuServerArtifactId: () => "whisper-server-cpu",
    validateWindowBrand: () => true,
    rootPlanIdFactory: () => "root-plan-1",
    cpuThreads: 2,
    ...(options.retainedRawBudget === undefined
      ? {}
      : { retainedRawBudget: options.retainedRawBudget }),
  });
  const admittedRuntimeGeneration =
    options.admittedRuntimeGeneration ?? normalized.runtimeGeneration;
  const config = createConfig(
    options.outputMode ?? "custom",
    options.conflictPolicy ?? "index",
    options.formats ?? ["SRT"],
  );
  const managedModel = Object.freeze({
    storage: "managed" as const,
    id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    absolutePath: path.join(os.tmpdir(), "managed-model.bin"),
    byteSize: 1024,
    sha256: MODEL_HASH,
  });
  const batchRuntime = executor.beginBatchSlice(Object.freeze({
    owner: OWNER,
    batchId: "batch-1",
    config,
    managedModel,
    admittedRuntimeGeneration,
    signal: sliceController.signal,
  }));
  const context = createContext(
    controller.signal,
    admittedRuntimeGeneration,
    batchRuntime,
    config,
    managedModel,
  );
  return {
    root,
    outputRoot,
    controller,
    sliceController,
    context,
    executor,
    media,
    supervisor,
    inputs,
    outputs,
    exporter,
    artifacts,
  };
}

function fakeVerifiedServerRuntime(
  root: string,
  runtimeGeneration: string,
  serverAbsolutePath = path.join(root, "runtime", "whisper-server"),
): LocalSubtitleVerifiedRuntimeBundle {
  return deepFreeze({
    schemaVersion: 1 as const,
    target: {
      platform: "darwin" as const,
      arch: "arm64" as const,
    },
    scope: "server" as const,
    root: path.join(root, "runtime"),
    manifestPath: path.join(root, "runtime", "manifest.json"),
    manifestSha256: runtimeGeneration,
    runtimeGeneration,
    integrityProfile: "development" as const,
    artifactPaths: {
      "whisper-server-cpu": {
        id: "whisper-server-cpu",
        kind: "server" as const,
        backend: "cpu" as const,
        absolutePath: serverAbsolutePath,
        byteSize: 1024,
        sha256: "d".repeat(64),
        version: "1.9.1+b1ade71",
        signatureKind: "unsigned" as const,
      },
    },
    evidenceFileCount: 1,
    noPathFallback: true as const,
    ready: true as const,
  }) as LocalSubtitleVerifiedRuntimeBundle;
}

function createContext(
  signal: AbortSignal,
  admittedRuntimeGeneration: string,
  batchRuntime: LocalSubtitleJobBatchRuntime,
  config: LocalSubtitleBatchConfigSnapshot,
  managedModel: LocalSubtitleJobTaskExecutionContext["managedModel"],
  identity: Readonly<{
    taskId: string;
    fileToken: string;
  }> = { taskId: "task-1", fileToken: "file-token-1" },
) {
  const update = vi.fn(() => ({} as LocalSubtitleTaskSummary));
  return Object.freeze({
    owner: OWNER,
    batchId: "batch-1",
    taskId: identity.taskId,
    generation: 1,
    fileToken: identity.fileToken,
    config,
    managedModel,
    admittedRuntimeGeneration,
    batchRuntime,
    signal,
    update,
  }) as LocalSubtitleJobTaskExecutionContext & { readonly update: typeof update };
}

function createConfig(
  outputMode: "custom" | "source" = "custom",
  conflictPolicy: "index" | "overwrite" = "index",
  formats: readonly LocalSubtitleFormat[] = ["SRT"],
): LocalSubtitleBatchConfigSnapshot {
  return createLocalSubtitleBatchConfigSnapshot({
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    serverHttpContractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    snapshotId: "snapshot-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    model: {
      engine: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.id,
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: MODEL_HASH,
    },
    devicePreference: "cpu",
    resolvedBackend: "cpu",
    language: "auto",
    taskMode: "transcribe",
    inference: {
      qualityPreset: "balanced",
      advanced: {
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 7_000,
        maxCueChars: 84,
        maxLineChars: 42,
      },
      vad: {
        enabled: false,
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        tokenTimestamps: false,
        timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
      },
      rawQualityGate: {
        maxSegmentDurationMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
        repeatedCueThreshold:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
        repeatedCoverageMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
        maxRetryDepth:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
      },
    },
    output: outputMode === "source"
      ? {
          mode: "source",
          formats: [...formats],
          conflictPolicy,
        }
      : {
          mode: "custom",
          formats: [...formats],
          conflictPolicy,
          directoryLeaseRef: "batch-1",
          displayLabel: "output",
        },
    postAction: { mode: "export_only" },
  });
}

async function resolvedOutputDirectory(directoryPath: string) {
  const identity =
    await localSubtitleFilesystemObjectIdentityForPath(directoryPath);
  return Object.freeze({
    directoryPath,
    directoryName: path.basename(directoryPath),
    identity,
    expiresAt: Date.now() + 60_000,
  });
}

function validResponse(
  request: LocalSubtitleServerInferenceRequest,
  window: LocalSubtitleMediaStructuralWindow,
  text: string,
): LocalSubtitleServerSupervisorInferenceResponse {
  const durationMs = window.endMs - window.startMs;
  const endMs = Math.min(durationMs, 3_000);
  const startMs = Math.min(1_000, Math.max(0, endMs - 1_000));
  return {
    processEpoch: 1,
    response: serverResponse(request, durationMs, [
      rawSegment(0, startMs, endMs, text),
    ]),
  };
}

function repeatedResponse(
  request: LocalSubtitleServerInferenceRequest,
  window: LocalSubtitleMediaStructuralWindow,
): LocalSubtitleServerSupervisorInferenceResponse {
  const durationMs = window.endMs - window.startMs;
  return {
    processEpoch: 1,
    response: serverResponse(
      request,
      durationMs,
      Array.from({ length: 8 }, (_, index) =>
        rawSegment(index, index * 2_000, index * 2_000 + 2_000, "repeat"),
      ),
    ),
  };
}

function serverResponse(
  request: LocalSubtitleServerInferenceRequest,
  durationMs: number,
  segments: LocalSubtitleServerInferenceResponse["result"]["segments"],
): LocalSubtitleServerInferenceResponse {
  return {
    requestGeneration: request.requestGeneration,
    sessionDisposition: "reusable",
    result: {
      contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
      task: "transcribe",
      language: "en",
      durationMs,
      text: segments.map((segment) => segment.text).join(" "),
      segments,
      wordTimelineStatus: "not_requested",
    },
  };
}

function rawSegment(
  id: number,
  startMs: number,
  endMs: number,
  text: string,
) {
  return {
    id,
    startMs,
    endMs,
    text,
    temperature: 0,
    averageLogProbability: -0.2,
    noSpeechProbability: 0.01,
  };
}

function sequence(prefix: string) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the production executor.");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
