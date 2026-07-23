import { createHash } from "node:crypto";
import {
  lstatSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_LIMITS,
  type GeneratedSubtitleArtifactSummary,
  type LocalSubtitleFormat,
  type LocalSubtitleTranscript,
} from "../../src/type/localSubtitle";
import type {
  LocalSubtitleDirectoryIdentity,
  LocalSubtitleFileObjectIdentity,
  LocalSubtitleOwnerKey,
  ResolvedLocalSubtitleOutputDirectory,
} from "../../electron/main/local-subtitle/authorizations";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import {
  LocalSubtitleExporter,
  LocalSubtitleExporterError,
  type LocalSubtitleArtifactRegistryCollaborator,
} from "../../electron/main/local-subtitle/subtitle-exporter";
import {
  createLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionRequest,
} from "../../electron/main/local-subtitle/overwrite-transaction";
import {
  createLocalSubtitleOverwriteRecoveryAuthority,
  LocalSubtitleOverwriteRecoveryOwner,
  type LocalSubtitleOverwriteRecoveryRecord,
  type LocalSubtitleOverwriteRecoveryRegistry,
  type LocalSubtitleOverwriteRecoveryRepository,
} from "../../electron/main/local-subtitle/overwrite-recovery-owner";
import {
  parseLocalSubtitleLrcUtf8,
  parseLocalSubtitleSrtUtf8,
} from "../../electron/main/local-subtitle/subtitle-formats";

const OWNER = Object.freeze({
  webContentsId: 91,
  ownerSessionId: "subtitle-exporter-owner",
}) satisfies LocalSubtitleOwnerKey;

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-subtitle-exporter-test-"),
  );
});

afterEach(async () => {
  await Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(`${fixtureRoot}.displaced`, { recursive: true, force: true }),
  ]);
});

describe("local subtitle artifact export", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid generation %s before touching the output directory",
    async (generation) => {
      const registry = new TestArtifactRegistry();
      let resolveCalls = 0;

      await expect(
        new LocalSubtitleExporter(registry).exportArtifacts({
          owner: OWNER,
          taskId: "task-invalid-generation",
          generation,
          outputStem: "invalid-generation",
          formats: ["SRT"],
          conflictPolicy: "index",
          transcript: transcript(),
          resolveOutputDirectory: async () => {
            resolveCalls += 1;
            return resolvedDirectory(fixtureRoot);
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_content" });
      expect(resolveCalls).toBe(0);
      expect(registry.reservations).toEqual([]);
    },
  );

  it("writes independent SRT and LRC artifacts as private, verified files", async () => {
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry);

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-full",
      generation: 7,
      outputStem: "meeting",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      completion: { outcome: "full", warnings: [] },
      artifactResults: [
        { format: "SRT", status: "committed" },
        { format: "LRC", status: "committed" },
      ],
    });
    expect(await readFile(path.join(fixtureRoot, "meeting.srt"), "utf8")).toBe(
      "1\n00:00:00,009 --> 00:00:01,000\nHello\nworld\n\n" +
        "2\n00:00:01,011 --> 00:00:02,250\nAgain\n",
    );
    expect(await readFile(path.join(fixtureRoot, "meeting.lrc"), "utf8")).toBe(
      "[00:00.00]Hello world\n[00:01.01]Again\n",
    );
    expect(
      parseLocalSubtitleSrtUtf8(
        await readFile(path.join(fixtureRoot, "meeting.srt")),
      ).cues,
    ).toHaveLength(2);
    expect(
      parseLocalSubtitleLrcUtf8(
        await readFile(path.join(fixtureRoot, "meeting.lrc")),
      ).cues,
    ).toHaveLength(2);
    if (process.platform !== "win32") {
      expect((await stat(path.join(fixtureRoot, "meeting.srt"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(path.join(fixtureRoot, "meeting.lrc"))).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(registry.activations).toHaveLength(2);
    expect(registry.reservations.map((entry) => entry.generation)).toEqual([7, 7]);
    for (const activation of registry.activations) {
      const bytes = await readFile(activation.filePath);
      expect(activation.byteSize).toBe(bytes.byteLength);
      expect(activation.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("activates refs that the real registry can repeatedly parse and read", async () => {
    const registry = new LocalSubtitleArtifactRegistry({
      tokenFactory: () => "export-integration-ref",
      reservationFactory: () => "export-integration-reservation",
    });
    const exporter = new LocalSubtitleExporter(registry);

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-registry-integration",
      generation: 1,
      outputStem: "registry",
      formats: ["LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifactResult = result.artifactResults[0]!;
    if (artifactResult.status !== "committed") {
      throw new Error("Expected a committed artifact.");
    }
    const first = await registry.readText(OWNER, artifactResult.artifact.artifactRef);
    const second = await registry.readText(OWNER, artifactResult.artifact.artifactRef);
    expect(first).toEqual({
      format: "LRC",
      rawText: "[00:00.00]Hello world\n[00:01.01]Again\n",
      plainText: "Hello world\nAgain",
      cueCount: 2,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(result)).not.toContain(fixtureRoot);
  });

  it("keeps existing files and chooses the next indexed leaf", async () => {
    await writeFile(path.join(fixtureRoot, "meeting.srt"), "existing", {
      mode: 0o600,
    });
    await writeFile(path.join(fixtureRoot, "meeting (1).srt"), "also-existing", {
      mode: 0o600,
    });
    const registry = new TestArtifactRegistry();

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-index",
      generation: 1,
      outputStem: "meeting",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        {
          status: "committed",
          artifact: { displayName: "meeting (2).srt" },
        },
      ],
    });
    await expect(readFile(path.join(fixtureRoot, "meeting.srt"), "utf8")).resolves
      .toBe("existing");
    await expect(readFile(path.join(fixtureRoot, "meeting (1).srt"), "utf8"))
      .resolves.toBe("also-existing");
    await expect(readFile(path.join(fixtureRoot, "meeting (2).srt"), "utf8"))
      .resolves.toContain("00:00:00,009");
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("serializes concurrent index commits by directory object", async () => {
    const firstRegistry = new TestArtifactRegistry();
    const secondRegistry = new TestArtifactRegistry();
    const common = {
      owner: OWNER,
      generation: 1,
      outputStem: "concurrent",
      formats: ["SRT"] as const,
      conflictPolicy: "index" as const,
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    };

    const [first, second] = await Promise.all([
      new LocalSubtitleExporter(firstRegistry).exportArtifacts({
        ...common,
        taskId: "task-concurrent-first",
      }),
      new LocalSubtitleExporter(secondRegistry).exportArtifacts({
        ...common,
        taskId: "task-concurrent-second",
      }),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    const displayNames = [first, second]
      .flatMap((result) => result.artifactResults)
      .flatMap((result) =>
        result.status === "committed" ? [result.artifact.displayName] : [],
      )
      .sort();
    expect(displayNames).toEqual(["concurrent (1).srt", "concurrent.srt"]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("retries an externally won no-clobber race with a new reservation", async () => {
    const registry = new TestArtifactRegistry();
    let commitCalls = 0;
    const exporter = new LocalSubtitleExporter(registry, {
      commitIndex: async (partialPath, finalPath) => {
        commitCalls += 1;
        if (commitCalls === 1) {
          await writeFile(finalPath, "external-winner", { mode: 0o600 });
          throw errnoError("EEXIST");
        }
        await link(partialPath, finalPath);
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-index-race",
      generation: 1,
      outputStem: "race",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        { artifact: { displayName: "race (1).srt" } },
      ],
    });
    expect(registry.reservations).toHaveLength(2);
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    await expect(readFile(path.join(fixtureRoot, "race.srt"), "utf8")).resolves
      .toBe("external-winner");
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("atomically overwrites an existing regular file", async () => {
    const finalPath = path.join(fixtureRoot, "replace.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const before = await stat(finalPath);
    const registry = new TestArtifactRegistry();

    const result = await new LocalSubtitleExporter(registry, {
      commitOverwrite: rename,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-overwrite",
      generation: 1,
      outputStem: "replace",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result.status).toBe("completed");
    expect(await readFile(finalPath, "utf8")).toContain("00:00:00,009");
    const after = await stat(finalPath);
    expect([after.dev, after.ino]).not.toEqual([before.dev, before.ino]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("fails closed when no native overwrite transaction is configured", async () => {
    const finalPath = path.join(fixtureRoot, "native-required.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const registry = new TestArtifactRegistry();
    let partialIds = 0;
    let resolveCalls = 0;

    const result = await new LocalSubtitleExporter(registry, {
      createPartialId: () => {
        partialIds += 1;
        return "unexpected-partial";
      },
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-native-required",
      generation: 1,
      outputStem: "native-required",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: async () => {
        resolveCalls += 1;
        return resolvedDirectory(fixtureRoot);
      },
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("old-subtitle");
    expect(partialIds).toBe(0);
    expect(resolveCalls).toBe(0);
    expect(registry.reservations).toEqual([]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rejects configuring native and legacy overwrite strategies together", () => {
    const overwriteTransaction = createTestOverwriteTransaction().coordinator;

    expect(
      () =>
        new LocalSubtitleExporter(new TestArtifactRegistry(), {
          overwriteTransaction,
          commitOverwrite: rename,
        }),
    ).toThrow(TypeError);
  });

  it("rejects a structural overwrite adapter that bypasses the coordinator", () => {
    expect(
      () =>
        new LocalSubtitleExporter(new TestArtifactRegistry(), {
          overwriteTransaction: {
            begin: async () => Promise.reject(errnoError("EIO")),
          } as never,
        }),
    ).toThrow(TypeError);
  });

  it("rejects a prototype-spoofed overwrite coordinator", () => {
    const coordinator = createTestOverwriteTransaction().coordinator;
    const spoof = Object.create(Object.getPrototypeOf(coordinator));

    expect(
      () =>
        new LocalSubtitleExporter(new TestArtifactRegistry(), {
          overwriteTransaction: spoof,
        }),
    ).toThrow(TypeError);
  });

  it("fails closed before output work when a recovery owner is missing", async () => {
    const finalPath = path.join(fixtureRoot, "missing-recovery-owner.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const transaction = createTestOverwriteTransaction();
    const registry = new TestArtifactRegistry();
    const createPartialId = vi.fn(() => "missing-recovery-owner");

    expect(
      () =>
        new LocalSubtitleExporter(registry, {
          overwriteTransaction: transaction.coordinator,
          createPartialId,
        }),
    ).toThrow("A validated recovery owner is required");

    expect(createPartialId).not.toHaveBeenCalled();
    expect(transaction.requests).toEqual([]);
    expect(registry.reservations).toEqual([]);
    expect(registry.activations).toEqual([]);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("old-subtitle");
    await expect(readdir(fixtureRoot)).resolves.toEqual([
      "missing-recovery-owner.srt",
    ]);
  });

  it("rejects a duplicate recovery id before invoking native begin", async () => {
    const recoveryId = "reserved-recovery-id";
    const finalPath = path.join(fixtureRoot, "duplicate-recovery-id.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const transaction = createTestOverwriteTransaction();
    const registry = new TestArtifactRegistry();
    const recoveryOwner = createTestOverwriteRecoveryOwner(registry);
    const reservedHandoff = recoveryOwner.prepareAdoption({
      recoveryId,
      owner: OWNER,
      taskId: "existing-recovery",
      generation: 1,
      format: "SRT",
      directoryIdentity: fileIdentity(lstatSync(fixtureRoot)),
    });

    try {
      const result = await new LocalSubtitleExporter(registry, {
        overwriteTransaction: transaction.coordinator,
        overwriteRecoveryOwner: recoveryOwner,
        createPartialId: () => recoveryId,
      }).exportArtifacts({
        owner: OWNER,
        taskId: "task-duplicate-recovery-id",
        generation: 1,
        outputStem: "duplicate-recovery-id",
        formats: ["SRT"],
        conflictPolicy: "overwrite",
        transcript: transcript(),
        resolveOutputDirectory: resolver(fixtureRoot),
      });

      expect(result).toEqual({
        status: "failed",
        artifactResults: [
          { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        ],
      });
      expect(transaction.requests).toEqual([]);
      expect(registry.activations).toEqual([]);
      expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
      await expect(readFile(finalPath, "utf8")).resolves.toBe("old-subtitle");
      await expect(partialNames()).resolves.toEqual([]);
    } finally {
      recoveryOwner.releaseAdoption(reservedHandoff);
    }
  });

  it("releases an unclaimed recovery handoff after native begin fails", async () => {
    const recoveryId = "begin-failure-retry";
    const registry = new TestArtifactRegistry();
    const recoveryOwner = createTestOverwriteRecoveryOwner(registry);
    const begin = vi.fn()
      .mockImplementationOnce(() => {
        throw errnoError("EIO");
      })
      .mockImplementation((request: LocalSubtitleOverwriteTransactionRequest) => {
        const partialPath = path.join(request.directoryPath, request.partialLeaf);
        const finalPath = path.join(request.directoryPath, request.finalLeaf);
        renameSync(partialPath, finalPath);
        return {
          expectedFinalIdentity: fileIdentity(lstatSync(finalPath)),
          finalize: () => undefined,
          rollback: () => undefined,
        };
      });
    const coordinator = createLocalSubtitleOverwriteTransactionCoordinator({ begin });
    const exporter = new LocalSubtitleExporter(registry, {
      overwriteTransaction: coordinator,
      overwriteRecoveryOwner: recoveryOwner,
      createPartialId: () => recoveryId,
    });
    const options = {
      owner: OWNER,
      taskId: "task-begin-failure-retry",
      generation: 1,
      outputStem: "begin-failure-retry",
      formats: ["SRT" as const],
      conflictPolicy: "overwrite" as const,
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    };

    await expect(exporter.exportArtifacts(options)).resolves.toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    expect(recoveryOwner.listPending()).toEqual([]);
    await expect(partialNames()).resolves.toEqual([]);

    await expect(exporter.exportArtifacts(options)).resolves.toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    expect(begin).toHaveBeenCalledTimes(2);
    expect(recoveryOwner.listPending()).toEqual([]);
    await expect(
      readFile(path.join(fixtureRoot, "begin-failure-retry.srt"), "utf8"),
    ).resolves.toContain("00:00:00,009");
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("finalizes a synchronous overwrite transaction after Registry activation", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-success.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const events: string[] = [];
    const transaction = createTestOverwriteTransaction({ events });
    const registry = new TestArtifactRegistry({
      onActivate: () => events.push("activate"),
    });
    const recoveryOwner = createTestOverwriteRecoveryOwner(registry);

    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: recoveryOwner,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-success",
      generation: 1,
      outputStem: "transaction-success",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    expect(events).toEqual(["begin", "activate", "finalize"]);
    expect(transaction.requests).toHaveLength(1);
    expect(transaction.requests[0]).toMatchObject({
      directoryPath: await realpath(fixtureRoot),
      finalLeaf: "transaction-success.srt",
    });
    expect(registry.activations[0]!.expectedFileIdentity).toEqual(
      fileIdentity(lstatSync(finalPath)),
    );
    await expect(readFile(finalPath, "utf8")).resolves.toContain(
      "00:00:00,009",
    );
    await expect(lstat(transaction.backupPaths[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("commits and repeatedly reads a transaction artifact through the real Registry", async () => {
    const registry = new LocalSubtitleArtifactRegistry({
      tokenFactory: () => "transaction-integration-ref",
      reservationFactory: () => "transaction-integration-reservation",
    });
    const transaction = createTestOverwriteTransaction();
    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(registry),
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-registry-integration",
      generation: 1,
      outputStem: "transaction-registry-integration",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    const first = await registry.readText(OWNER, artifact.artifact.artifactRef);
    const second = await registry.readText(OWNER, artifact.artifact.artifactRef);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ format: "SRT", cueCount: 2 });
  });

  it("supports a transaction with no pre-existing overwrite victim", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-no-victim.srt");
    const transaction = createTestOverwriteTransaction();

    const result = await new LocalSubtitleExporter(new TestArtifactRegistry(), {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(),
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-no-victim",
      generation: 1,
      outputStem: "transaction-no-victim",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result.status).toBe("completed");
    await expect(readFile(finalPath, "utf8")).resolves.toContain("Hello");
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("restores target absence when activation fails without a victim", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-no-victim-rollback.srt");
    const transaction = createTestOverwriteTransaction();

    const result = await new LocalSubtitleExporter(
      new TestArtifactRegistry({ failActivateFormat: "SRT" }),
      {
        overwriteTransaction: transaction.coordinator,
        overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(),
      },
    ).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-no-victim-rollback",
      generation: 1,
      outputStem: "transaction-no-victim-rollback",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "failed",
      artifactResults: [{ errorCode: "invalid_content" }],
    });
    await expect(lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rolls back activation failure and preserves the overwritten victim", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-activation-failure.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const events: string[] = [];
    const transaction = createTestOverwriteTransaction({ events });
    const registry = new TestArtifactRegistry({ failActivateFormat: "SRT" });

    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(registry),
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-activation-failure",
      generation: 1,
      outputStem: "transaction-activation-failure",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "invalid_content" },
      ],
    });
    expect(events).toEqual(["begin", "rollback"]);
    expect(registry.revokedArtifacts).toEqual([]);
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("old-subtitle");
    await expect(lstat(transaction.backupPaths[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("retries finalize in the same direction before returning the committed artifact", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-finalize-failure.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const events: string[] = [];
    const beforeFinalize = vi.fn()
      .mockImplementationOnce(() => { throw errnoError("EIO"); })
      .mockImplementationOnce(() => undefined);
    const transaction = createTestOverwriteTransaction({
      events,
      beforeFinalize,
    });
    const registry = new TestArtifactRegistry({
      onActivate: () => events.push("activate"),
    });

    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(registry),
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-finalize-failure",
      generation: 1,
      outputStem: "transaction-finalize-failure",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    expect(events).toEqual([
      "begin",
      "activate",
      "finalize",
      "finalize",
    ]);
    expect(beforeFinalize).toHaveBeenCalledTimes(2);
    expect(registry.revokedArtifacts).toEqual([]);
    expect(registry.revoked).toEqual([]);
    await expect(readFile(finalPath, "utf8")).resolves.toContain(
      "00:00:00,009",
    );
    await expect(lstat(transaction.backupPaths[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("retains Registry commit direction when finalization retry remains pending", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-revoke-failure.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const events: string[] = [];
    const transaction = createTestOverwriteTransaction({
      events,
      beforeFinalize: () => {
        throw errnoError("EIO");
      },
    });
    const registry = new TestArtifactRegistry({
      onActivate: () => events.push("activate"),
    });
    const recoveryOwner = createTestOverwriteRecoveryOwner(registry);

    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: recoveryOwner,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-revoke-failure",
      generation: 1,
      outputStem: "transaction-revoke-failure",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "failed",
      artifactResults: [{ errorCode: "cleanup_failed" }],
    });
    expect(events).toEqual([
      "begin",
      "activate",
      "finalize",
      "finalize",
    ]);
    expect(registry.activations).toHaveLength(1);
    expect(registry.revokedArtifacts).toEqual([]);
    expect(registry.revoked).toEqual([]);
    expect(recoveryOwner.listPending()).toEqual([
      expect.objectContaining({
        taskId: "task-transaction-revoke-failure",
        generation: 1,
        format: "SRT",
        direction: "finalize",
        requiresDirectorySelection: false,
      }),
    ]);
    await expect(readFile(finalPath, "utf8")).resolves.toContain(
      "00:00:00,009",
    );
    await expect(readFile(transaction.backupPaths[0]!, "utf8")).resolves.toBe(
      "old-subtitle",
    );
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("fences later exports until pending recovery settles and releases the directory", async () => {
    const finalPath = path.join(fixtureRoot, "fenced-recovery.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const beforeFinalize = vi.fn()
      .mockImplementationOnce(() => { throw errnoError("EIO"); })
      .mockImplementationOnce(() => { throw errnoError("EIO"); })
      .mockImplementationOnce(() => undefined);
    const transaction = createTestOverwriteTransaction({ beforeFinalize });
    const firstRegistry = new TestArtifactRegistry();
    const recoveryOwner = createTestOverwriteRecoveryOwner(firstRegistry);

    const pending = await new LocalSubtitleExporter(firstRegistry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: recoveryOwner,
      createPartialId: () => "fenced-recovery",
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-fenced-recovery",
      generation: 1,
      outputStem: "fenced-recovery",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(pending).toMatchObject({
      status: "failed",
      artifactResults: [{ errorCode: "cleanup_failed" }],
    });
    expect(recoveryOwner.listPending()).toHaveLength(1);

    const blockedRegistry = new TestArtifactRegistry();
    const blockedPartialId = vi.fn(() => "must-not-be-created");
    const blocked = await new LocalSubtitleExporter(blockedRegistry, {
      createPartialId: blockedPartialId,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-blocked-by-recovery",
      generation: 1,
      outputStem: "blocked-by-recovery",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(blocked).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    expect(blockedPartialId).not.toHaveBeenCalled();
    expect(blockedRegistry.reservations).toEqual([]);
    await expect(
      lstat(path.join(fixtureRoot, "blocked-by-recovery.srt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    recoveryOwner.retry("fenced-recovery");
    expect(beforeFinalize).toHaveBeenCalledTimes(3);
    expect(recoveryOwner.listPending()).toEqual([]);

    const releasedRegistry = new TestArtifactRegistry();
    const released = await new LocalSubtitleExporter(releasedRegistry, {
      createPartialId: () => "released-after-recovery",
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-released-after-recovery",
      generation: 1,
      outputStem: "released-after-recovery",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(released).toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    expect(releasedRegistry.activations).toHaveLength(1);
    await expect(
      readFile(path.join(fixtureRoot, "released-after-recovery.srt"), "utf8"),
    ).resolves.toContain("00:00:00,009");
    await expect(lstat(transaction.backupPaths[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it.each([
    { label: "without cancellation", abortDuringBegin: false, errorCode: "cleanup_failed" },
    { label: "after cancellation", abortDuringBegin: true, errorCode: "cancel_failed" },
  ] as const)(
    "maps activation rollback failure to $errorCode $label",
    async ({ abortDuringBegin, errorCode }) => {
      const finalPath = path.join(fixtureRoot, "transaction-rollback-failure.srt");
      await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
      const controller = new AbortController();
      const events: string[] = [];
      const transaction = createTestOverwriteTransaction({
        events,
        afterBeginCommit: () => {
          if (abortDuringBegin) controller.abort();
        },
        beforeRollback: () => {
          throw errnoError("EACCES");
        },
      });
      const registry = new TestArtifactRegistry({ failActivateFormat: "SRT" });
      const recoveryOwner = createTestOverwriteRecoveryOwner(registry);

      const result = await new LocalSubtitleExporter(registry, {
        overwriteTransaction: transaction.coordinator,
        overwriteRecoveryOwner: recoveryOwner,
      }).exportArtifacts({
        owner: OWNER,
        taskId: `task-transaction-rollback-failure-${errorCode}`,
        generation: 1,
        outputStem: "transaction-rollback-failure",
        formats: ["SRT"],
        conflictPolicy: "overwrite",
        transcript: transcript(),
        resolveOutputDirectory: resolver(fixtureRoot),
        signal: controller.signal,
      });

      expect(result).toEqual({
        status: "failed",
        artifactResults: [{ format: "SRT", status: "failed", errorCode }],
      });
      expect(events).toEqual(["begin", "rollback"]);
      expect(registry.revoked).toEqual([]);
      expect(recoveryOwner.listPending()).toEqual([
        expect.objectContaining({
          taskId: `task-transaction-rollback-failure-${errorCode}`,
          direction: "rollback",
          requiresDirectorySelection: false,
        }),
      ]);
      await expect(readFile(finalPath, "utf8")).resolves.toContain(
        "00:00:00,009",
      );
      await expect(readFile(transaction.backupPaths[0]!, "utf8")).resolves.toBe(
        "old-subtitle",
      );
      await expect(partialNames()).resolves.toEqual([]);
    },
  );

  it("commits and finalizes before observing cancellation raised by begin", async () => {
    const finalPath = path.join(fixtureRoot, "transaction-late-cancel.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const controller = new AbortController();
    const events: string[] = [];
    const transaction = createTestOverwriteTransaction({
      events,
      afterBeginCommit: () => controller.abort(),
    });
    const registry = new TestArtifactRegistry({
      onActivate: () => events.push("activate"),
    });

    const result = await new LocalSubtitleExporter(registry, {
      overwriteTransaction: transaction.coordinator,
      overwriteRecoveryOwner: createTestOverwriteRecoveryOwner(registry),
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-transaction-late-cancel",
      generation: 1,
      outputStem: "transaction-late-cancel",
      formats: ["SRT", "LRC"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "completed",
      completion: {
        outcome: "partial",
        warnings: ["cancelled_after_partial_commit"],
      },
      artifactResults: [
        { format: "SRT", status: "committed" },
        {
          format: "LRC",
          status: "skipped",
          errorCode: "cancelled_after_partial_commit",
        },
      ],
    });
    expect(events).toEqual(["begin", "activate", "finalize"]);
    await expect(readFile(finalPath, "utf8")).resolves.toContain(
      "00:00:00,009",
    );
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rejects overwrite activation after a same-size partial replacement", async () => {
    const artifactRef = "ls-artifact-overwrite-file-race";
    const registry = new LocalSubtitleArtifactRegistry({
      tokenFactory: () => "overwrite-file-race",
      reservationFactory: () => "overwrite-file-race",
    });
    const exporter = new LocalSubtitleExporter(registry, {
      commitOverwrite: async (partialPath, finalPath) => {
        const bytes = await readFile(partialPath);
        const replacementPath = `${partialPath}.replacement`;
        await writeFile(replacementPath, bytes, { mode: 0o600 });
        const [original, replacement] = await Promise.all([
          lstat(partialPath),
          lstat(replacementPath),
        ]);
        expect([replacement.dev, replacement.ino]).not.toEqual([
          original.dev,
          original.ino,
        ]);
        await unlink(partialPath);
        await rename(replacementPath, partialPath);
        await rename(partialPath, finalPath);
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-overwrite-file-race",
      generation: 1,
      outputStem: "overwrite-file-race",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "artifact_changed" },
      ],
    });
    await expect(registry.readText(OWNER, artifactRef)).rejects.toMatchObject({
      code: "artifact_expired",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rejects overwrite activation after the authorized directory is replaced", async () => {
    const artifactRef = "ls-artifact-overwrite-directory-race";
    const displacedRoot = `${fixtureRoot}.displaced`;
    const registry = new LocalSubtitleArtifactRegistry({
      tokenFactory: () => "overwrite-directory-race",
      reservationFactory: () => "overwrite-directory-race",
    });
    const exporter = new LocalSubtitleExporter(registry, {
      commitOverwrite: async (partialPath, finalPath) => {
        const partialLeaf = path.basename(partialPath);
        await rename(fixtureRoot, displacedRoot);
        await mkdir(fixtureRoot);
        await rename(path.join(displacedRoot, partialLeaf), finalPath);
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-overwrite-directory-race",
      generation: 1,
      outputStem: "overwrite-directory-race",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "artifact_changed" },
      ],
    });
    await expect(registry.readText(OWNER, artifactRef)).rejects.toMatchObject({
      code: "artifact_expired",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("preserves the old overwrite target when atomic replace fails", async () => {
    const finalPath = path.join(fixtureRoot, "protected.srt");
    await writeFile(finalPath, "old-subtitle", { mode: 0o600 });
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry, {
      commitOverwrite: async () => {
        throw errnoError("EIO");
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-overwrite-failure",
      generation: 1,
      outputStem: "protected",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("old-subtitle");
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rejects an overwrite symlink without changing its target", async () => {
    if (process.platform === "win32") return;
    const external = path.join(fixtureRoot, "external.txt");
    const finalPath = path.join(fixtureRoot, "unsafe.srt");
    await writeFile(external, "external-content", { mode: 0o600 });
    await symlink(external, finalPath, "file");
    const registry = new TestArtifactRegistry();

    const result = await new LocalSubtitleExporter(registry, {
      commitOverwrite: rename,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-symlink",
      generation: 1,
      outputStem: "unsafe",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "failed",
      artifactResults: [{ errorCode: "output_write_failed" }],
    });
    expect((await lstat(finalPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(external, "utf8")).resolves.toBe("external-content");
    expect(registry.reservations).toEqual([]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("returns partial success without deleting the committed format", async () => {
    const registry = new TestArtifactRegistry({ failReserveFormat: "LRC" });

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-partial",
      generation: 1,
      outputStem: "partial",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toMatchObject({
      status: "completed",
      completion: { outcome: "partial", warnings: [] },
      artifactResults: [
        { format: "SRT", status: "committed" },
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    await expect(readFile(path.join(fixtureRoot, "partial.srt"), "utf8")).resolves
      .toContain("Hello");
    await expect(lstat(path.join(fixtureRoot, "partial.lrc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns failed when no requested format commits", async () => {
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry, {
      commitIndex: async () => {
        throw errnoError("EIO");
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-none",
      generation: 1,
      outputStem: "none",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    expect(registry.activations).toEqual([]);
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("cancels before the first commit and revokes the pending ref", async () => {
    const controller = new AbortController();
    const registry = new TestArtifactRegistry({
      onReserve: () => controller.abort(),
    });

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-cancel-before",
      generation: 1,
      outputStem: "cancel-before",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "cancelled",
      artifactResults: [
        { format: "SRT", status: "skipped" },
        { format: "LRC", status: "skipped" },
      ],
    });
    expect(registry.reservations).toHaveLength(1);
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  });

  it("removes a growing partial when cancellation follows the first MiB write", async () => {
    const controller = new AbortController();
    const writtenOffsets: number[] = [];
    const exporter = new LocalSubtitleExporter(new TestArtifactRegistry(), {
      onPartialWriteChunk: (writtenBytes) => {
        writtenOffsets.push(writtenBytes);
        if (writtenBytes >= 1024 * 1024) controller.abort();
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-cancel-large-write",
      generation: 1,
      outputStem: "cancel-large-write",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: largeTranscript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(writtenOffsets.at(-1)).toBeGreaterThanOrEqual(1024 * 1024);
    expect(result).toEqual({
      status: "cancelled",
      artifactResults: [{ format: "SRT", status: "skipped" }],
    });
    await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  });

  it("reports cancel_failed when a pre-commit cancellation cannot remove its partial", async () => {
    const controller = new AbortController();
    const registry = new TestArtifactRegistry({
      onReserve: () => controller.abort(),
    });
    const exporter = new LocalSubtitleExporter(registry, {
      removeFile: async () => {
        throw errnoError("EACCES");
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-cancel-cleanup-failure",
      generation: 1,
      outputStem: "cancel-cleanup-failure",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cancel_failed" },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(partialNames()).resolves.toHaveLength(1);
    await expect(lstat(path.join(fixtureRoot, "cancel-cleanup-failure.srt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes cleanup failure when cancellation arrives during async unlink", async () => {
    const controller = new AbortController();
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry, {
      commitIndex: async () => {
        throw errnoError("EIO");
      },
      removeFile: async () => {
        controller.abort();
        throw errnoError("EACCES");
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-cleanup-cancellation-race",
      generation: 1,
      outputStem: "cleanup-cancellation-race",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cancel_failed" },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(partialNames()).resolves.toHaveLength(1);
  });

  it("reports cleanup_failed when a failed commit cannot remove its partial", async () => {
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry, {
      commitIndex: async () => {
        throw errnoError("EIO");
      },
      removeFile: async () => {
        throw errnoError("EACCES");
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-partial-cleanup-failure",
      generation: 1,
      outputStem: "partial-cleanup-failure",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(partialNames()).resolves.toHaveLength(1);
    await expect(lstat(path.join(fixtureRoot, "partial-cleanup-failure.srt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back an indexed commit when the hard-link partial cannot detach", async () => {
    const registry = new TestArtifactRegistry();
    const exporter = new LocalSubtitleExporter(registry, {
      removeFileSync: (filePath) => {
        if (filePath.endsWith(".partial")) throw errnoError("EACCES");
        unlinkSync(filePath);
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-index-detach-failure",
      generation: 1,
      outputStem: "index-detach-failure",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        {
          format: "SRT",
          status: "failed",
          errorCode: "cleanup_failed",
        },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  });

  it("reports cleanup_failed when an indexed final cannot be rolled back", async () => {
    const registry = new TestArtifactRegistry({ failActivateFormat: "SRT" });
    const finalPath = path.join(fixtureRoot, "index-rollback-failure.srt");
    const exporter = new LocalSubtitleExporter(registry, {
      removeFileSync: (filePath) => {
        if (path.basename(filePath) === "index-rollback-failure.srt") {
          throw errnoError("EACCES");
        }
        unlinkSync(filePath);
      },
    });

    const result = await exporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-index-rollback-failure",
      generation: 1,
      outputStem: "index-rollback-failure",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(readFile(finalPath, "utf8")).resolves.toContain("Hello");
    await expect(partialNames()).resolves.toEqual([]);
  });

  it("rolls back an indexed final when artifact activation rejects", async () => {
    const registry = new TestArtifactRegistry({ failActivateFormat: "SRT" });

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-index-activation-failure",
      generation: 1,
      outputStem: "index-activation-failure",
      formats: ["SRT"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });

    expect(result).toEqual({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "invalid_content" },
      ],
    });
    expect(registry.revoked).toEqual([registry.reservations[0]!.reservation]);
    expect(registry.activations).toEqual([]);
    await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  });

  it("keeps the first commit and skips later formats when cancellation wins afterward", async () => {
    const controller = new AbortController();
    const registry = new TestArtifactRegistry({
      onActivate: (activation) => {
        if (activation.format === "SRT") controller.abort();
      },
    });

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-cancel-after",
      generation: 1,
      outputStem: "cancel-after",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "completed",
      completion: {
        outcome: "partial",
        warnings: ["cancelled_after_partial_commit"],
      },
      artifactResults: [
        { format: "SRT", status: "committed" },
        {
          format: "LRC",
          status: "skipped",
          errorCode: "cancelled_after_partial_commit",
        },
      ],
    });
    await expect(readFile(path.join(fixtureRoot, "cancel-after.srt"), "utf8"))
      .resolves.toContain("Hello");
    await expect(lstat(path.join(fixtureRoot, "cancel-after.lrc"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("linearizes a concurrent cancellation over a pre-commit format failure", async () => {
    const controller = new AbortController();
    const registry = new TestArtifactRegistry({
      failReserveFormat: "LRC",
      onReserve: (format) => {
        if (format === "LRC") controller.abort();
      },
    });

    const result = await new LocalSubtitleExporter(registry).exportArtifacts({
      owner: OWNER,
      taskId: "task-cancel-failure-race",
      generation: 1,
      outputStem: "cancel-failure-race",
      formats: ["SRT", "LRC"],
      conflictPolicy: "index",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "completed",
      completion: {
        outcome: "partial",
        warnings: ["cancelled_after_partial_commit"],
      },
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

  it("re-resolves the output lease after waiting for the directory mutex", async () => {
    const firstRegistry = new TestArtifactRegistry();
    const secondRegistry = new TestArtifactRegistry();
    const gate = deferred<void>();
    const commitStarted = deferred<void>();
    const firstExporter = new LocalSubtitleExporter(firstRegistry, {
      commitOverwrite: async (partialPath, finalPath) => {
        commitStarted.resolve();
        await gate.promise;
        await rename(partialPath, finalPath);
      },
    });
    const first = firstExporter.exportArtifacts({
      owner: OWNER,
      taskId: "task-lock-first",
      generation: 1,
      outputStem: "first",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: resolver(fixtureRoot),
    });
    await commitStarted.promise;

    const snapshot = await resolvedDirectory(fixtureRoot);
    let resolveCalls = 0;
    const second = new LocalSubtitleExporter(secondRegistry, {
      commitOverwrite: rename,
    }).exportArtifacts({
      owner: OWNER,
      taskId: "task-lock-second",
      generation: 1,
      outputStem: "second",
      formats: ["SRT"],
      conflictPolicy: "overwrite",
      transcript: transcript(),
      resolveOutputDirectory: async () => {
        resolveCalls += 1;
        if (resolveCalls > 1) {
          throw new LocalSubtitleExporterError(
            "authorization_expired",
            "Output lease expired.",
          );
        }
        return snapshot;
      },
    });
    await waitFor(() => resolveCalls === 1);
    gate.resolve();

    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(second).resolves.toEqual({
      status: "failed",
      artifactResults: [
        {
          format: "SRT",
          status: "failed",
          errorCode: "authorization_expired",
        },
      ],
    });
    expect(resolveCalls).toBe(2);
    await expect(lstat(path.join(fixtureRoot, "second.srt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(partialNames()).resolves.toEqual([]);
  });
});

interface Reservation {
  readonly id: string;
}

interface Activation {
  readonly filePath: string;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly expectedFileIdentity: LocalSubtitleFileObjectIdentity;
  readonly expectedDirectoryIdentity: LocalSubtitleDirectoryIdentity;
}

class TestArtifactRegistry
  implements LocalSubtitleArtifactRegistryCollaborator<Reservation>
{
  readonly reservations: Array<{
    readonly format: LocalSubtitleFormat;
    readonly generation: number;
    readonly reservation: Reservation;
  }> = [];
  readonly activations: Activation[] = [];
  readonly revoked: Reservation[] = [];
  readonly revokedArtifacts: string[] = [];
  readonly #failReserveFormat?: LocalSubtitleFormat;
  readonly #failActivateFormat?: LocalSubtitleFormat;
  readonly #onReserve?: (format: LocalSubtitleFormat) => void;
  readonly #onActivate?: (activation: Activation) => void;
  readonly #onRevokeArtifact?: (artifactRef: string) => void;

  constructor(options: {
    readonly failReserveFormat?: LocalSubtitleFormat;
    readonly failActivateFormat?: LocalSubtitleFormat;
    readonly onReserve?: (format: LocalSubtitleFormat) => void;
    readonly onActivate?: (activation: Activation) => void;
    readonly onRevokeArtifact?: (artifactRef: string) => void;
  } = {}) {
    this.#failReserveFormat = options.failReserveFormat;
    this.#failActivateFormat = options.failActivateFormat;
    this.#onReserve = options.onReserve;
    this.#onActivate = options.onActivate;
    this.#onRevokeArtifact = options.onRevokeArtifact;
  }

  reserve(options: {
    readonly owner: LocalSubtitleOwnerKey;
    readonly taskId: string;
    readonly generation: number;
    readonly format: LocalSubtitleFormat;
    readonly displayName: string;
  }) {
    if (options.format === this.#failReserveFormat) {
      this.#onReserve?.(options.format);
      throw new LocalSubtitleExporterError(
        "output_write_failed",
        "Injected registry reservation failure.",
      );
    }
    const reservation = Object.freeze({
      id: `reservation-${this.reservations.length + 1}`,
    });
    this.reservations.push({
      format: options.format,
      generation: options.generation,
      reservation,
    });
    this.#onReserve?.(options.format);
    return Object.freeze({
      artifactRef: `ls-artifact-${this.reservations.length}`,
      expiresAt: Date.now() + 60_000,
      reservation,
    });
  }

  activate(
    reservation: Reservation,
    artifact: Activation,
  ): GeneratedSubtitleArtifactSummary {
    const record = this.reservations.find(
      (candidate) => candidate.reservation === reservation,
    );
    if (!record) throw new Error("Unknown reservation.");
    if (artifact.format === this.#failActivateFormat) {
      throw new LocalSubtitleExporterError(
        "invalid_content",
        "Injected registry activation failure.",
      );
    }
    this.activations.push(Object.freeze({ ...artifact }));
    this.#onActivate?.(artifact);
    const index = this.reservations.findIndex(
      (candidate) => candidate.reservation === reservation,
    );
    return Object.freeze({
      artifactRef: `ls-artifact-${index + 1}`,
      displayName: artifact.displayName,
      format: artifact.format,
      expiresAt: Date.now() + 60_000,
    });
  }

  revokeReservation(reservation: Reservation): boolean {
    this.revoked.push(reservation);
    return true;
  }

  revokeArtifact(_owner: LocalSubtitleOwnerKey, artifactRef: string): boolean {
    this.revokedArtifacts.push(artifactRef);
    this.#onRevokeArtifact?.(artifactRef);
    return true;
  }
}

function createTestOverwriteRecoveryOwner(
  registry: LocalSubtitleOverwriteRecoveryRegistry<unknown> = {
    revokeReservation: () => true,
    revokeArtifact: () => true,
  },
) {
  return new LocalSubtitleOverwriteRecoveryOwner(
    new TestOverwriteRecoveryRepository(),
    registry,
    createLocalSubtitleOverwriteRecoveryAuthority({
      recover: () => ({ state: "not_found" }),
    }),
  );
}

class TestOverwriteRecoveryRepository
  implements LocalSubtitleOverwriteRecoveryRepository
{
  records: readonly LocalSubtitleOverwriteRecoveryRecord[] = [];

  load() {
    return this.records;
  }

  replace(records: readonly LocalSubtitleOverwriteRecoveryRecord[]) {
    this.records = records;
  }
}

function createTestOverwriteTransaction(options: {
  readonly events?: string[];
  readonly afterBeginCommit?: (
    request: LocalSubtitleOverwriteTransactionRequest,
  ) => void;
  readonly beforeFinalize?: () => void;
  readonly beforeRollback?: () => void;
} = {}) {
  const requests: LocalSubtitleOverwriteTransactionRequest[] = [];
  const backupPaths: string[] = [];
  const coordinator = createLocalSubtitleOverwriteTransactionCoordinator({
    begin(request) {
      options.events?.push("begin");
      requests.push(request);
      const partialPath = path.join(request.directoryPath, request.partialLeaf);
      const finalPath = path.join(request.directoryPath, request.finalLeaf);
      const backupPath = path.join(
        request.directoryPath,
        `.fusionkit-test-overwrite-backup-${request.finalLeaf}`,
      );
      backupPaths.push(backupPath);

      expect(fileIdentity(lstatSync(request.directoryPath))).toEqual(
        request.expectedDirectoryIdentity,
      );
      const partial = lstatSync(partialPath);
      expect(fileIdentity(partial)).toEqual(request.expectedPartialIdentity);
      expect(partial.size).toBe(request.expectedByteSize);

      let hadVictim = true;
      try {
        renameSync(finalPath, backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hadVictim = false;
      }
      try {
        renameSync(partialPath, finalPath);
      } catch (error) {
        if (hadVictim) renameSync(backupPath, finalPath);
        throw error;
      }
      const expectedFinalIdentity = fileIdentity(lstatSync(finalPath));
      options.afterBeginCommit?.(request);

      return {
        expectedFinalIdentity,
        finalize() {
          options.events?.push("finalize");
          options.beforeFinalize?.();
          if (hadVictim) unlinkSync(backupPath);
        },
        rollback() {
          options.events?.push("rollback");
          options.beforeRollback?.();
          renameSync(finalPath, partialPath);
          if (hadVictim) renameSync(backupPath, finalPath);
        },
      };
    },
  });

  return { coordinator, requests, backupPaths };
}

function fileIdentity(value: Stats): LocalSubtitleFileObjectIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  });
}

function transcript(): LocalSubtitleTranscript {
  return Object.freeze({
    schemaVersion: 1,
    source: Object.freeze({ displayName: "meeting.wav", durationMs: 3_000 }),
    model: Object.freeze({
      engine: "whisper_cpp" as const,
      modelId: "large-v3-q5_0",
      modelHash: "a".repeat(64),
      backend: "cpu" as const,
    }),
    detectedLanguage: "en",
    segments: Object.freeze([
      Object.freeze({
        id: "cue-1",
        startMs: 9,
        endMs: 1_000,
        text: "Hello\nworld",
      }),
      Object.freeze({
        id: "cue-2",
        startMs: 1_011,
        endMs: 2_250,
        text: "Again",
      }),
    ]),
  });
}

function largeTranscript(): LocalSubtitleTranscript {
  const segmentCount = 10_000;
  return Object.freeze({
    schemaVersion: 1,
    source: Object.freeze({
      displayName: "large.wav",
      durationMs: segmentCount * 10,
    }),
    model: Object.freeze({
      engine: "whisper_cpp" as const,
      modelId: "large-v3-q5_0",
      modelHash: "b".repeat(64),
      backend: "cpu" as const,
    }),
    detectedLanguage: "en",
    segments: Object.freeze(
      Array.from({ length: segmentCount }, (_, index) =>
        Object.freeze({
          id: `cue-${index + 1}`,
          startMs: index * 10,
          endMs: index * 10 + 9,
          text: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxLineChars),
        }),
      ),
    ),
  });
}

function resolver(
  directoryPath: string,
): () => Promise<ResolvedLocalSubtitleOutputDirectory> {
  return () => resolvedDirectory(directoryPath);
}

async function resolvedDirectory(
  directoryPath: string,
): Promise<ResolvedLocalSubtitleOutputDirectory> {
  const canonicalPath = await realpath(directoryPath);
  const value = await lstat(canonicalPath);
  const identity = Object.freeze({
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  }) satisfies LocalSubtitleDirectoryIdentity;
  return Object.freeze({
    directoryPath: canonicalPath,
    directoryName: path.basename(canonicalPath),
    identity,
    expiresAt: Date.now() + 60_000,
  });
}

async function partialNames(): Promise<string[]> {
  return (await readdir(fixtureRoot)).filter((name) => name.endsWith(".partial"));
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached.");
}
