import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskStatus,
  type LocalSubtitleTaskSummary,
} from "../../src/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
} from "../../src/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import {
  localSubtitleFilesystemObjectIdentityForPath,
} from "../../electron/main/local-subtitle/filesystem-object-identity";
import {
  LocalSubtitleIpcService,
  type LocalSubtitleIpcHandlerContext,
} from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleSessionIpcBridge } from "../../electron/main/local-subtitle/session-ipc";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";

const OWNER = Object.freeze({
  webContentsId: 41,
  ownerSessionId: "session-ipc-owner",
}) satisfies LocalSubtitleOwnerKey;
const NOW = "2026-08-04T00:00:00.000Z";
const VALID_SRT = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("LocalSubtitleSessionIpcBridge artifact refresh", () => {
  it("publishes one revisioned replacement only after an expired artifact revalidates", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-session-ipc-artifact-")),
    );
    tempRoots.push(root);
    const artifactPath = path.join(root, "sample.srt");
    await writeFile(artifactPath, VALID_SRT, "utf8");
    let now = 100;
    let tokenIndex = 0;
    const artifacts = new LocalSubtitleArtifactRegistry({
      ttlMs: 10,
      now: () => now,
      tokenFactory: () => `artifact-${++tokenIndex}`,
      reservationFactory: () => "reservation-1",
    });
    const reserved = artifacts.reserve({
      owner: OWNER,
      taskId: "task-1",
      generation: 1,
      format: "SRT",
      displayName: "sample.srt",
    });
    const [expectedFileIdentity, expectedDirectoryIdentity] = await Promise.all([
      localSubtitleFilesystemObjectIdentityForPath(artifactPath),
      localSubtitleFilesystemObjectIdentityForPath(root),
    ]);
    const artifact = artifacts.activate(reserved.reservation, {
      filePath: artifactPath,
      format: "SRT",
      displayName: "sample.srt",
      sha256: createHash("sha256").update(VALID_SRT).digest("hex"),
      byteSize: Buffer.byteLength(VALID_SRT),
      expectedFileIdentity,
      expectedDirectoryIdentity,
    });
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER, batch());
    for (const [status, stageProgress, overallProgress] of [
      ["preparing_media", 100, 20],
      ["transcribing", 100, 80],
      ["post_processing", 100, 90],
      ["exporting", 50, 95],
    ] as const) {
      registry.upsertTask(OWNER, task({
        status,
        progress: { stage: status, stageProgress, overallProgress },
      }));
    }
    const artifactResults = [{
      format: "SRT",
      status: "committed",
      artifact,
    }] as const satisfies readonly LocalSubtitleArtifactResult[];
    registry.upsertTask(OWNER, task({
      status: "completed",
      progress: {
        stage: "exporting",
        stageProgress: 100,
        overallProgress: 100,
      },
      artifactResults,
      completion: {
        outcome: "full",
        artifacts: artifactResults,
        warnings: [],
      },
    }));

    const bridge = new LocalSubtitleSessionIpcBridge(registry, artifacts);
    const service = new LocalSubtitleIpcService({ capabilities: { artifacts } });
    bridge.attach(service);
    const handler = bridge.handlers.public?.[
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot
    ];
    if (!handler) throw new Error("Session snapshot handler is unavailable.");
    const context = {
      owner: OWNER,
      ownerIdentity: {
        senderId: OWNER.webContentsId,
        ownerSessionId: OWNER.ownerSessionId,
        processId: 1,
        frameId: 1,
      },
      event: {} as never,
      capabilities: service.capabilities,
      signal: new AbortController().signal,
      isOwnerCurrent: () => true,
    } satisfies LocalSubtitleIpcHandlerContext;

    now = 109;
    const validResult = await handler({}, context);
    if (!validResult.ok) throw new Error("Expected a valid session snapshot.");
    const validSnapshot = validResult.data as LocalSubtitleSessionSnapshot;
    expect(validSnapshot.revision).toBe(6);
    expect(committedRef(validSnapshot)).toBe(artifact.artifactRef);

    now = 110;
    const refreshedResult = await handler({}, context);
    if (!refreshedResult.ok) throw new Error("Expected a refreshed snapshot.");
    const refreshed = refreshedResult.data as LocalSubtitleSessionSnapshot;
    expect(refreshed.revision).toBe(7);
    expect(committedRef(refreshed)).toBe("ls-artifact-artifact-2");
    await expect(
      artifacts.readText(OWNER, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    await expect(
      artifacts.readText(OWNER, committedRef(refreshed)),
    ).resolves.toMatchObject({ rawText: VALID_SRT });

    const repeatedResult = await handler({}, context);
    if (!repeatedResult.ok) throw new Error("Expected a repeated snapshot.");
    const repeated = repeatedResult.data as LocalSubtitleSessionSnapshot;
    expect(repeated.revision).toBe(7);
    expect(committedRef(repeated)).toBe("ls-artifact-artifact-2");
  });
});

function committedRef(snapshot: LocalSubtitleSessionSnapshot): string {
  const result = snapshot.batches[0]?.tasks[0]?.artifactResults[0];
  if (result?.status !== "committed") {
    throw new Error("Expected a committed artifact.");
  }
  return result.artifact.artifactRef;
}

function batch(): LocalSubtitleBatchSummary {
  return {
    batchId: "batch-1",
    status: "queued",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "cpu",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      vadEnabled: false,
      outputFormats: ["SRT"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks: [task()],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(
  overrides: Partial<LocalSubtitleTaskSummary> & {
    readonly status?: LocalSubtitleTaskStatus;
  } = {},
): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key-1",
    generation: 1,
    displayName: "sample.wav",
    status: "queued",
    progress: {
      stage: "queued",
      stageProgress: 0,
      overallProgress: 0,
    },
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
    },
    resolvedBackend: "cpu",
    requestedFormats: ["SRT"],
    artifactResults: [],
    postAction: {
      mode: "export_only",
      importStatus: "not_requested",
      startStatus: "not_requested",
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
