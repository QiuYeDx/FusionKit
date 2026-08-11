import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleTaskSummary,
} from "../../src/type/localSubtitle";
import {
  LOCAL_SUBTITLE_SESSION_SUMMARY_POLICY,
  LocalSubtitleSessionSummaryStore,
} from "../../electron/main/local-subtitle/session-summary";
import { localSubtitleRecoveredSessionSummarySchema } from "../../src/type/localSubtitleIpc";

const roots: string[] = [];
const FIRST_TIME = "2026-08-04T08:00:00.000Z";
const RECOVERY_TIME = "2026-08-04T09:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })));
});

describe("local subtitle session summary", () => {
  it("persists only path-free allowlisted task fields and numeric watermarks", async () => {
    const root = await createRoot();
    const store = createStore(root, FIRST_TIME, {
      memoryUsage: () => ({ rss: 900, heapUsed: 500 }),
      availableBytes: () => 4_000,
    });
    const committed = committedArtifact("SRT");
    store.capture([
      batch(task({
        displayName: "api-key-sk-super-secret-source.wav",
        status: "completed",
        progress: {
          stage: "exporting",
          stageProgress: 100,
          overallProgress: 100,
        },
        artifactResults: [committed],
        completion: {
          outcome: "full",
          artifacts: [committed],
          warnings: [],
        },
      }), { status: "completed" }),
    ]);

    const serialized = await readFile(summaryPath(root), "utf8");
    const parsed = JSON.parse(serialized);

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      build: {
        engine: "whisper_cpp",
        version: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
        commit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      },
      batches: [{
        batchId: "batch-1",
        tasks: [{
          taskId: "task-1",
          displayName: "media-task-1.wav",
          status: "completed",
          formats: ["SRT"],
          backend: "cpu",
          artifactResults: [{ format: "SRT", status: "committed" }],
        }],
      }],
      resourceWatermarks: {
        peakResidentBytes: 900,
        peakHeapUsedBytes: 500,
        minimumAvailableDiskBytes: 4_000,
      },
    });
    for (const forbidden of [
      "super-secret-source",
      "sk-super-secret",
      "artifact-ref-srt",
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
      "/private/source",
      "directoryLeaseRef",
      "artifactRef",
      "initialPrompt",
      "transcript",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("converts unfinished tasks to interrupted without reviving artifact actions", async () => {
    const root = await createRoot();
    const first = createStore(root, FIRST_TIME);
    first.capture([
      batch(task({
        status: "transcribing",
        progress: {
          stage: "transcribing",
          stageProgress: 40,
          overallProgress: 30,
          completedWindows: 2,
          totalWindows: 8,
        },
      }), { status: "running" }),
    ]);

    const restarted = createStore(root, RECOVERY_TIME);
    const recovered = restarted.initialize();
    const publicSummary = restarted.getRecoveredSessionSummary();

    expect(recovered).toMatchObject({
      batches: [{
        status: "interrupted",
        tasks: [{
          status: "interrupted",
          stage: "transcribing",
          errorCode: "runtime_crashed",
          updatedAt: RECOVERY_TIME,
          artifactResults: [],
        }],
      }],
      updatedAt: RECOVERY_TIME,
    });
    const serialized = await readFile(summaryPath(root), "utf8");
    expect(serialized).not.toContain("artifactRef");
    expect(serialized).not.toContain("expiresAt");
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(localSubtitleRecoveredSessionSummarySchema.safeParse(publicSummary).success)
      .toBe(true);
    expect(publicSummary?.batches[0]?.tasks[0]).not.toHaveProperty("artifactRef");
  });

  it("keeps terminal task summaries terminal across restart", async () => {
    const root = await createRoot();
    const first = createStore(root, FIRST_TIME);
    first.capture([
      batch(task({
        status: "failed",
        progress: {
          stage: "transcribing",
          stageProgress: 30,
          overallProgress: 20,
        },
        error: createLocalSubtitleError(
          "out_of_memory",
          "path=/private/source token=secret transcript=content",
          {
            stage: "transcribing",
            details: {
              summary: "apiKey=secret",
              lines: ["/private/source should never persist"],
              truncated: false,
            },
          },
        ),
      }), { status: "failed" }),
    ]);

    const recovered = createStore(root, RECOVERY_TIME).initialize();
    const serialized = await readFile(summaryPath(root), "utf8");

    expect(recovered?.batches[0]?.tasks[0]).toMatchObject({
      status: "failed",
      errorCode: "out_of_memory",
      updatedAt: FIRST_TIME,
    });
    expect(serialized).not.toContain("/private/source");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("transcript");
  });

  it("fails closed on an invalid existing manifest without exposing its content", async () => {
    const root = await createRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const invalid = '{"sourcePath":"/private/source","token":"secret"}\n';
    await writeFile(summaryPath(root), invalid, { mode: 0o600 });

    const store = createStore(root, RECOVERY_TIME);

    expect(store.initialize()).toBeUndefined();
    expect(store.getDiagnostic()).toEqual({
      code: "summary_invalid",
      operation: "initialize",
      occurredAt: RECOVERY_TIME,
    });
    store.capture([batch(task())]);
    expect(await readFile(summaryPath(root), "utf8")).toBe(invalid);
    expect(JSON.stringify(store.getDiagnostic())).not.toContain("/private/source");
    expect(JSON.stringify(store.getDiagnostic())).not.toContain("secret");
  });

  it("does not rewrite the manifest for progress-only updates in one stage", async () => {
    const root = await createRoot();
    let parentSyncs = 0;
    const store = createStore(root, FIRST_TIME, {
      syncParentDirectory: () => {
        parentSyncs += 1;
      },
    });
    store.capture([
      batch(task({
        status: "transcribing",
        progress: {
          stage: "transcribing",
          stageProgress: 10,
          overallProgress: 10,
        },
      }), { status: "running" }),
    ]);
    store.capture([
      batch(task({
        status: "transcribing",
        progress: {
          stage: "transcribing",
          stageProgress: 80,
          overallProgress: 70,
        },
        updatedAt: RECOVERY_TIME,
      }), { status: "running", updatedAt: RECOVERY_TIME }),
    ]);

    expect(parentSyncs).toBe(1);
  });
});

async function createRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "fusionkit-session-summary-"));
  roots.push(parent);
  return path.join(parent, "local-subtitle");
}

function createStore(
  root: string,
  timestamp: string,
  overrides: Partial<ConstructorParameters<typeof LocalSubtitleSessionSummaryStore>[0]> = {},
): LocalSubtitleSessionSummaryStore {
  return new LocalSubtitleSessionSummaryStore({
    managedResourceRoot: root,
    now: () => new Date(timestamp),
    idFactory: () => "12345678-1234-4123-8123-123456789abc",
    memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
    availableBytes: () => 1_000,
    syncParentDirectory: () => undefined,
    ...overrides,
  });
}

function summaryPath(root: string): string {
  return path.join(root, LOCAL_SUBTITLE_SESSION_SUMMARY_POLICY.fileName);
}

function batch(
  taskSummary: LocalSubtitleTaskSummary,
  overrides: Partial<LocalSubtitleBatchSummary> = {},
): LocalSubtitleBatchSummary {
  return {
    batchId: "batch-1",
    status: taskSummary.status === "queued" ? "queued" : "running",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "cpu",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      qualityPreset: "balanced",
      vadEnabled: false,
      outputFormats: ["SRT"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks: [taskSummary],
    createdAt: FIRST_TIME,
    updatedAt: taskSummary.updatedAt,
    ...overrides,
  };
}

function task(
  overrides: Partial<LocalSubtitleTaskSummary> = {},
): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key-1",
    generation: 1,
    displayName: "source.wav",
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
    createdAt: FIRST_TIME,
    updatedAt: FIRST_TIME,
    ...overrides,
  };
}

function committedArtifact(format: "SRT" | "LRC"): LocalSubtitleArtifactResult {
  return {
    format,
    status: "committed",
    artifact: {
      artifactRef: `artifact-ref-${format.toLowerCase()}`,
      displayName: `source.${format.toLowerCase()}`,
      format,
      expiresAt: Date.parse("2026-08-05T00:00:00.000Z"),
    },
  };
}
