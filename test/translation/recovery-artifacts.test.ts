import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteUtf8File } from "../../electron/main/translation/atomic-file";
import { buildCheckpointPaths } from "../../electron/main/translation/checkpoint";
import {
  flushRecoveryArtifacts,
} from "../../electron/main/translation/recovery-artifacts";
import {
  SubtitleFileType,
  SubtitleSliceType,
  type TranslationCheckpointManifest,
} from "../../electron/main/translation/typing";

const fixtureRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtureRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("subtitle recovery artifact publication", () => {
  it("retries transient EPERM rename failures before publishing", async () => {
    const root = await createFixtureRoot();
    const targetPath = path.join(root, "checkpoint.json");
    await fs.writeFile(targetPath, "old", "utf8");

    const originalRename = fs.rename.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(targetPath)) {
        attempts += 1;
        if (attempts <= 2) throw errno("EPERM");
      }
      await originalRename(from, to);
    });

    await atomicWriteUtf8File(targetPath, "new");

    expect(attempts).toBe(3);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("new");
    expect((await fs.readdir(root)).filter((leaf) => leaf.endsWith(".tmp")))
      .toEqual([]);
  });

  it("accepts an ambiguous transient rename after exact read-back proves commit", async () => {
    const root = await createFixtureRoot();
    const targetPath = path.join(root, "checkpoint.json");
    const originalRename = fs.rename.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(targetPath)) {
        attempts += 1;
        await originalRename(from, to);
        throw errno("EPERM");
      }
      await originalRename(from, to);
    });

    await atomicWriteUtf8File(targetPath, "committed");

    expect(attempts).toBe(1);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("committed");
  });

  it("serializes concurrent flushes for the same task artifacts", async () => {
    const root = await createFixtureRoot();
    const paths = buildCheckpointPaths(root, "sample.lrc", "task-serial");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const originalRename = fs.rename.bind(fs);
    let remainingRenameCalls = 0;
    let activeRemainingRenames = 0;
    let maxActiveRemainingRenames = 0;

    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(paths.remainingPath)) {
        remainingRenameCalls += 1;
        activeRemainingRenames += 1;
        maxActiveRemainingRenames = Math.max(
          maxActiveRemainingRenames,
          activeRemainingRenames,
        );
        try {
          if (remainingRenameCalls === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
          await originalRename(from, to);
        } finally {
          activeRemainingRenames -= 1;
        }
        return;
      }
      await originalRename(from, to);
    });

    const firstFlush = flushRecoveryArtifacts(
      createManifest("first pending"),
      paths,
    );
    await firstEntered.promise;
    const secondFlush = flushRecoveryArtifacts(
      createManifest("second pending"),
      paths,
    );

    expect(remainingRenameCalls).toBe(1);
    releaseFirst.resolve();
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      [],
      [],
    ]);

    expect(remainingRenameCalls).toBe(2);
    expect(maxActiveRemainingRenames).toBe(1);
    await expect(fs.readFile(paths.remainingPath, "utf8"))
      .resolves.toBe("second pending");
  });

  it("reports an auxiliary artifact failure without rejecting the flush", async () => {
    const root = await createFixtureRoot();
    const paths = buildCheckpointPaths(root, "sample.lrc", "task-warning");
    const originalRename = fs.rename.bind(fs);

    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(paths.remainingPath)) {
        throw errno("EIO");
      }
      await originalRename(from, to);
    });

    await expect(flushRecoveryArtifacts(
      createManifest("still pending"),
      paths,
    )).resolves.toEqual([
      { artifact: "remaining", reason: "EIO" },
    ]);
    await expect(fs.readFile(paths.completedPath, "utf8"))
      .resolves.toBe("translated");
    expect((await fs.readdir(root)).filter((leaf) => leaf.endsWith(".tmp")))
      .toEqual([]);
  });
});

async function createFixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fusionkit-recovery-"));
  fixtureRoots.push(root);
  return root;
}

function createManifest(pendingSource: string): TranslationCheckpointManifest {
  const now = "2026-08-24T00:00:00.000Z";
  return {
    schemaVersion: 2,
    taskId: "task-recovery-artifacts",
    status: "running",
    createdAt: now,
    updatedAt: now,
    fileName: "sample.lrc",
    sourceContentHash: "source-hash",
    sourceSize: pendingSource.length,
    options: {
      fileType: SubtitleFileType.LRC,
      sliceType: SubtitleSliceType.NORMAL,
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
    },
    fragments: [
      {
        index: 0,
        sourceHash: "resolved-hash",
        sourceContent: "source",
        translatedContent: "translated",
        status: "resolved",
        attempts: 1,
      },
      {
        index: 1,
        sourceHash: "pending-hash",
        sourceContent: pendingSource,
        status: "pending",
        attempts: 0,
      },
    ],
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected filesystem failure`), {
    code,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
