import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCheckpointPaths,
  createManifest,
  parseCheckpointManifest,
  saveManifest,
  toCurrentManifest,
  validateManifestSelfContained,
} from "../../electron/main/translation/checkpoint";
import { SubtitleTranslationDirectoryCapabilityRegistry } from "../../electron/main/translation/directory-capability";
import { SubtitleTranslationRecoveryCapabilityRegistry } from "../../electron/main/translation/recovery-capability";
import {
  SubtitleSliceType,
  SubtitleFileType,
  TaskStatus,
  type TranslationCheckpointManifestV1,
} from "../../electron/main/translation/typing";

const OWNER_A = Object.freeze({
  webContentsId: 71,
  ownerSessionId: "12345678-1234-4123-8123-123456789abc",
});
const OWNER_B = Object.freeze({
  webContentsId: 72,
  ownerSessionId: "22345678-1234-4123-8123-123456789abc",
});
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("subtitle translation recovery capability", () => {
  it("isolates new recovery artifact namespaces by stable task identity", () => {
    const first = buildCheckpointPaths(
      "/output",
      "same-name.srt",
      "subtitle-task-first",
    );
    const second = buildCheckpointPaths(
      "/output",
      "same-name.srt",
      "subtitle-task-second",
    );
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(path.basename(first.manifestPath)).toMatch(
      /^fusionkit-task-[0-9a-f]{24}\.fusionkit\.resume\.json$/u,
    );
    expect(path.basename(second.manifestPath)).toMatch(
      /^fusionkit-task-[0-9a-f]{24}\.fusionkit\.resume\.json$/u,
    );
  });

  it("writes path-free v2 manifests and strips paths from historical v1 input", () => {
    const manifest = createManifest({
      taskId: "subtitle-task-v2-manifest",
      fileName: "private.srt",
      fileContent: "private subtitle content",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/private/source/private.srt",
      targetFileURL: "/private/output",
      status: TaskStatus.PENDING,
      executionBinding: { status: "needs_configuration" },
      actualUsage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        reasoningTokens: 10,
        cachedInputTokens: 20,
        requestCount: 2,
        reportedRequestCount: 2,
        calculatedCost: 0.01,
      },
    }, ["private subtitle content"]);
    expect(manifest.schemaVersion).toBe(2);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("/private/source");
    expect(serialized).not.toContain("/private/output");
    expect(serialized).not.toContain("apiKey");
    expect(manifest.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      reasoningTokens: 10,
      cachedInputTokens: 20,
      requestCount: 2,
      reportedRequestCount: 2,
      calculatedCost: 0.01,
    });

    const converted = toCurrentManifest(v1Manifest());
    const convertedSerialized = JSON.stringify(converted);
    expect(converted.schemaVersion).toBe(2);
    expect(convertedSerialized).not.toContain("/legacy/source");
    expect(convertedSerialized).not.toContain("/legacy/output");
    expect(converted.fragments[0].sourceContent).toBe("legacy subtitle content");
    expect(converted.usage).toBeUndefined();

    const tainted = v1Manifest() as TranslationCheckpointManifestV1 & {
      apiKey: string;
    };
    tainted.apiKey = "private-key";
    Object.assign(tainted.options, { capabilityToken: "private-token" });
    Object.assign(tainted.fragments[0], { checkpointPath: "/private/checkpoint" });
    const sanitized = JSON.stringify(toCurrentManifest(tainted));
    expect(sanitized).not.toMatch(/private-key|private-token|private\/checkpoint/u);
    expect(() => parseCheckpointManifest({ schemaVersion: 3 })).toThrow(
      "Unsupported checkpoint schema version: 3",
    );
    expect(validateManifestSelfContained({
      ...manifest,
      usage: { ...manifest.usage!, reportedRequestCount: 3 },
    })).toEqual({ valid: false, reason: "usage 无效" });
  });

  it("persists thinking mode and defaults legacy checkpoints to disabled", () => {
    const manifest = createManifest({
      taskId: "subtitle-task-thinking",
      fileName: "thinking.srt",
      fileContent: "subtitle content",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/private/source/thinking.srt",
      targetFileURL: "/private/output",
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready",
        profileId: "deepseek-profile",
        profileLabel: "DeepSeek",
        apiKey: "private-key",
        apiModel: "deepseek-v4-flash",
        endPoint: "https://api.deepseek.com/v1",
        thinkingEnabled: true,
      },
    }, ["subtitle content"]);

    expect(manifest.options.thinkingEnabled).toBe(true);
    expect(toCurrentManifest(v1Manifest()).options.thinkingEnabled).toBe(false);
  });

  it("keeps scans main-owned and binds prepared tasks to a reauthorized target", async () => {
    const root = await tempRoot();
    const recoveryDirectory = path.join(root, "recovery-private");
    const outputDirectory = path.join(root, "new-output-private");
    await Promise.all([mkdir(recoveryDirectory), mkdir(outputDirectory)]);
    const checkpointPath = path.join(
      recoveryDirectory,
      "sample.fusionkit.resume.json",
    );
    await saveManifest(checkpointPath, createManifest({
      taskId: "subtitle-task-old-session",
      fileName: "sample.srt",
      fileContent: "subtitle fragment that stays in main",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/must/not/be/persisted.srt",
      targetFileURL: "/must/not/be/persisted",
      status: TaskStatus.PENDING,
      executionBinding: { status: "needs_configuration" },
      actualUsage: {
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
        reasoningTokens: 0,
        cachedInputTokens: 5,
        requestCount: 1,
        reportedRequestCount: 1,
        calculatedCost: 0.002,
      },
    }, ["subtitle fragment that stays in main"]));

    const recovery = new SubtitleTranslationRecoveryCapabilityRegistry({
      tokenFactory: sequence("scan", "checkpoint", "candidate", "prepared"),
    });
    const directories = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("draft", "target", "retry-draft"),
    });
    const scan = await recovery.scanDirectory(OWNER_A, recoveryDirectory);
    expect(scan).toMatchObject({
      cancelled: false,
      totalCount: 1,
      recoverableCount: 1,
      candidates: [{
        fileName: "sample.srt",
        schemaVersion: 2,
        recoverability: "ready_from_manifest",
        outputDirectoryLabel: "recovery-private",
        actualUsage: {
          totalTokens: 40,
          requestCount: 1,
          reportedRequestCount: 1,
        },
      }],
    });
    expect(JSON.stringify(scan)).not.toContain(root);
    expect(JSON.stringify(scan)).not.toContain("subtitle fragment");
    const candidate = scan.candidates[0];
    expect(() => recovery.resolveCheckpointForReveal(
      OWNER_B,
      candidate.checkpointRef,
    )).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));

    const directory = await directories.authorizeDraft(OWNER_A, outputDirectory);
    const prepared = await recovery.prepareRecoveredTasks({
      owner: OWNER_A,
      recoveryScanId: scan.recoveryScanId,
      directoryToken: directory.directoryToken,
      candidateIds: [candidate.candidateId],
      directoryCapabilities: directories,
    });
    expect(prepared).toMatchObject({
      totalCandidates: 1,
      hasMore: false,
      tasks: [{
        taskId: "subtitle-task-prepared",
        fileName: "sample.srt",
        checkpointRef: candidate.checkpointRef,
        actualUsage: {
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
          requestCount: 1,
          reportedRequestCount: 1,
        },
        reference: {
          kind: "generated_task_v1",
          target: { displayLabel: "new-output-private" },
        },
      }],
    });
    expect(JSON.stringify(prepared)).not.toContain(root);
    await expect(recovery.resolveCheckpointForTask(
      OWNER_A,
      "subtitle-task-prepared",
      candidate.checkpointRef,
    )).resolves.toBe(checkpointPath);
    await expect(recovery.resolveCheckpointForTask(
      OWNER_B,
      "subtitle-task-prepared",
      candidate.checkpointRef,
    )).rejects.toMatchObject({ code: "invalid_ipc_request" });

    const retryDirectory = await directories.authorizeDraft(
      OWNER_A,
      outputDirectory,
    );
    await expect(recovery.prepareRecoveredTasks({
      owner: OWNER_A,
      recoveryScanId: scan.recoveryScanId,
      directoryToken: retryDirectory.directoryToken,
      candidateIds: [candidate.candidateId],
      directoryCapabilities: directories,
    })).rejects.toMatchObject({ code: "task_reference_conflict" });

    recovery.releaseOwner(OWNER_A);
    expect(() => recovery.resolveCheckpointForReveal(
      OWNER_A,
      candidate.checkpointRef,
    )).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
  });

  it("fails closed when a scan expires or a selected manifest changes", async () => {
    const root = await tempRoot();
    const recoveryDirectory = path.join(root, "recovery");
    const outputDirectory = path.join(root, "output");
    await Promise.all([mkdir(recoveryDirectory), mkdir(outputDirectory)]);
    const checkpointPath = path.join(
      recoveryDirectory,
      "sample.fusionkit.resume.json",
    );
    const manifest = createManifest({
      taskId: "subtitle-task-expiring",
      fileName: "sample.srt",
      fileContent: "one fragment",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/private/source.srt",
      targetFileURL: "/private/output",
      status: TaskStatus.PENDING,
      executionBinding: { status: "needs_configuration" },
    }, ["one fragment"]);
    await saveManifest(checkpointPath, manifest);

    let now = 100;
    const expiring = new SubtitleTranslationRecoveryCapabilityRegistry({
      now: () => now,
      ttlMs: 10,
      tokenFactory: sequence("expiring-scan", "expiring-checkpoint", "expiring-candidate"),
    });
    const expiringScan = await expiring.scanDirectory(OWNER_A, recoveryDirectory);
    now = 111;
    await expect(expiring.prepareRecoveredTasks({
      owner: OWNER_A,
      recoveryScanId: expiringScan.recoveryScanId,
      directoryToken: "unused-directory-token",
      directoryCapabilities: new SubtitleTranslationDirectoryCapabilityRegistry(),
    })).rejects.toMatchObject({ code: "authorization_expired" });

    const changed = new SubtitleTranslationRecoveryCapabilityRegistry({
      tokenFactory: sequence("changed-scan", "changed-checkpoint", "changed-candidate"),
    });
    const changedScan = await changed.scanDirectory(OWNER_A, recoveryDirectory);
    manifest.updatedAt = "2026-08-05T00:02:00.000Z";
    await saveManifest(checkpointPath, manifest);
    const directories = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("changed-draft"),
    });
    const directory = await directories.authorizeDraft(OWNER_A, outputDirectory);
    await expect(changed.prepareRecoveredTasks({
      owner: OWNER_A,
      recoveryScanId: changedScan.recoveryScanId,
      directoryToken: directory.directoryToken,
      directoryCapabilities: directories,
    })).rejects.toMatchObject({ code: "task_reference_conflict" });
  });
});

function v1Manifest(): TranslationCheckpointManifestV1 {
  return {
    schemaVersion: 1,
    taskId: "subtitle-task-v1-manifest",
    status: "failed",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
    fileName: "legacy.srt",
    sourceFilePath: "/legacy/source/legacy.srt",
    sourceContentHash: "hash",
    outputDir: "/legacy/output",
    completedOutputPath: "/legacy/output/legacy.completed.srt",
    remainingOutputPath: "/legacy/output/legacy.remaining.srt",
    errorLogPath: "/legacy/output/legacy.error.log",
    options: {
      fileType: SubtitleFileType.SRT,
      sliceType: SubtitleSliceType.NORMAL,
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
    },
    fragments: [{
      index: 0,
      sourceHash: "hash",
      sourceContent: "legacy subtitle content",
      status: "failed",
      attempts: 1,
    }],
  };
}

function sequence(...values: string[]): () => string {
  return () => {
    const value = values.shift();
    if (!value) throw new Error("token sequence exhausted");
    return value;
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-recovery-ref-"));
  tempRoots.push(root);
  return root;
}
