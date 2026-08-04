import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import {
  LocalSubtitleArtifactRegistry,
  type ActivateLocalSubtitleArtifactOptions,
} from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import {
  localSubtitleFilesystemObjectIdentityForPath,
} from "../../electron/main/local-subtitle/filesystem-object-identity";

const OWNER_A = Object.freeze({
  webContentsId: 7,
  ownerSessionId: "owner-session-a",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 8,
  ownerSessionId: "owner-session-b",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_A_RELOADED = Object.freeze({
  webContentsId: 7,
  ownerSessionId: "owner-session-reloaded",
}) satisfies LocalSubtitleOwnerKey;

const VALID_SRT =
  "1\n00:00:00,000 --> 00:00:01,000\nFirst line\n\n" +
  "2\n00:00:01,250 --> 00:00:02,000\nSecond line\n";
const VALID_LRC = "[00:00.00]First line\n[00:01.25]Second line\n";
const UNREACHABLE_FILE_IDENTITY = Object.freeze({
  dev: 0,
  ino: 0,
  birthtimeMs: 0,
});
const UNREACHABLE_DIRECTORY_IDENTITY = Object.freeze({
  dev: 0,
  ino: 0,
  birthtimeMs: 0,
});

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("LocalSubtitleArtifactRegistry", () => {
  it("reserves an invisible ref before commit and activates it synchronously", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const reserved = registry.reserve({
      owner: OWNER_A,
      taskId: "task-1",
      generation: 1,
      format: "SRT",
      displayName: "sample.srt",
    });

    expect(reserved).toEqual({
      artifactRef: "ls-artifact-ref-1",
      expiresAt: expect.any(Number),
      reservation: "ls-artifact-reservation-reservation-1",
    });
    expect(Object.isFrozen(reserved)).toBe(true);
    await expect(
      registry.readText(OWNER_A, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    const activation = await writeArtifact(root, "sample.srt", VALID_SRT, "SRT");
    const summary = registry.activate(reserved.reservation, activation);

    expect(summary).toEqual({
      artifactRef: reserved.artifactRef,
      displayName: "sample.srt",
      format: "SRT",
      expiresAt: reserved.expiresAt,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(summary).not.toBeInstanceOf(Promise);
    expect(JSON.stringify(summary)).not.toContain(root);
    expect(registry.revokeReservation(reserved.reservation)).toBe(false);
    await expect(registry.readText(OWNER_A, summary.artifactRef)).resolves
      .toEqual({
        format: "SRT",
        rawText: VALID_SRT,
        plainText: "First line\nSecond line",
        cueCount: 2,
      });
  });

  it("returns immutable path-free reads and handoff snapshots for SRT and LRC", async () => {
    const root = await tempRoot();
    const revealed: string[] = [];
    const registry = deterministicRegistry({
      revealFile: (filePath) => {
        revealed.push(filePath);
      },
    });
    const srt = await reserveAndActivate(
      registry,
      root,
      "task-srt",
      "subtitle.srt",
      VALID_SRT,
      "SRT",
    );
    const lrc = await reserveAndActivate(
      registry,
      root,
      "task-lrc",
      "subtitle.lrc",
      VALID_LRC,
      "LRC",
    );

    const firstRead = await registry.readText(OWNER_A, srt.artifactRef);
    const secondRead = await registry.readText(OWNER_A, srt.artifactRef);
    expect(secondRead).toEqual(firstRead);
    expect(Object.isFrozen(firstRead)).toBe(true);

    const snapshot = await registry.snapshotForHandoff(
      OWNER_A,
      lrc.artifactRef,
    );
    expect(snapshot).toEqual({
      taskId: "task-lrc",
      generation: 1,
      format: "LRC",
      displayName: "subtitle.lrc",
      rawText: VALID_LRC,
      plainText: "First line\nSecond line",
      cueCount: 2,
      byteSize: Buffer.byteLength(VALID_LRC),
      sha256: sha256(VALID_LRC),
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(root);

    await expect(registry.reveal(OWNER_A, lrc.artifactRef)).resolves.toEqual({
      revealed: true,
    });
    expect(revealed).toEqual([path.join(root, "subtitle.lrc")]);
  });

  it("enforces owner and operation isolation without exposing records", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry({ revealFile: vi.fn() });
    const reserved = registry.reserve({
      owner: OWNER_A,
      taskId: "task-read-only",
      generation: 1,
      format: "SRT",
      displayName: "read-only.srt",
      operations: ["read"],
    });
    registry.activate(
      reserved.reservation,
      await writeArtifact(root, "read-only.srt", VALID_SRT, "SRT"),
    );

    await expect(
      registry.readText(OWNER_B, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      registry.readText(OWNER_A_RELOADED, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      registry.reveal(OWNER_A, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_ipc_request", field: "operation" });
    await expect(
      registry.snapshotForHandoff(OWNER_A, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_ipc_request", field: "operation" });
  });

  it("uses stable artifact_expired semantics at the exact TTL and after sweep", async () => {
    const root = await tempRoot();
    let now = 100;
    const registry = deterministicRegistry({ ttlMs: 10, now: () => now });
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-expiry",
      "expiry.srt",
      VALID_SRT,
      "SRT",
    );

    now = 109;
    await expect(registry.readText(OWNER_A, artifact.artifactRef)).resolves
      .toMatchObject({ cueCount: 2 });
    now = 110;
    expect(registry.sweepExpired()).toBe(1);
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    await expect(
      registry.readText(OWNER_A, "ls-artifact-never-issued"),
    ).rejects.toMatchObject({ code: "artifact_expired" });
  });

  it("reuses valid summaries and coalesces an expired ref into one verified rotation", async () => {
    const root = await tempRoot();
    let now = 100;
    const registry = deterministicRegistry({ ttlMs: 10, now: () => now });
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-refresh",
      "refresh.srt",
      VALID_SRT,
      "SRT",
    );

    expect(await registry.refreshSummary(OWNER_A, artifact)).toEqual(artifact);
    now = 110;
    expect(registry.sweepExpired()).toBe(1);
    const [first, second] = await Promise.all([
      registry.refreshSummary(OWNER_A, artifact),
      registry.refreshSummary(OWNER_A, artifact),
    ]);

    expect(first).toEqual({
      artifactRef: "ls-artifact-ref-2",
      displayName: "refresh.srt",
      format: "SRT",
      expiresAt: 120,
    });
    expect(second).toEqual(first);
    expect(await registry.refreshSummary(OWNER_A, artifact)).toEqual(first);
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    await expect(registry.readText(OWNER_A, first.artifactRef)).resolves
      .toMatchObject({ cueCount: 2 });
  });

  it("keeps a refreshable record when validation crosses the artifact TTL", async () => {
    const root = await tempRoot();
    let expireDuringRead = false;
    let readClockChecks = 0;
    const registry = deterministicRegistry({
      ttlMs: 10,
      now: () =>
        expireDuringRead && readClockChecks++ > 0 ? 110 : 100,
    });
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-refresh-during-read",
      "refresh-during-read.srt",
      VALID_SRT,
      "SRT",
    );

    expireDuringRead = true;
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    await expect(registry.refreshSummary(OWNER_A, artifact)).resolves.toEqual({
      artifactRef: "ls-artifact-ref-2",
      displayName: "refresh-during-read.srt",
      format: "SRT",
      expiresAt: 120,
    });
  });

  it("does not rotate an expired ref after its artifact changes or task is removed", async () => {
    const root = await tempRoot();
    let now = 200;
    const registry = deterministicRegistry({ ttlMs: 10, now: () => now });
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-refresh-failure",
      "refresh-failure.srt",
      VALID_SRT,
      "SRT",
    );
    await writeFile(
      path.join(root, "refresh-failure.srt"),
      VALID_SRT.replace("Second line", "Changed line"),
      "utf8",
    );
    now = 210;

    await expect(registry.refreshSummary(OWNER_A, artifact)).rejects
      .toMatchObject({ code: "artifact_changed" });
    expect(registry.revokeTask(OWNER_A, "task-refresh-failure")).toBe(1);
    await expect(registry.refreshSummary(OWNER_A, artifact)).rejects
      .toMatchObject({ code: "artifact_expired" });
  });

  it("revokes pending and active refs by task and permanently fences removed tasks", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const active = await reserveAndActivate(
      registry,
      root,
      "task-remove",
      "active.srt",
      VALID_SRT,
      "SRT",
    );
    const pending = registry.reserve({
      owner: OWNER_A,
      taskId: "task-remove",
      generation: 1,
      format: "LRC",
      displayName: "pending.lrc",
    });

    expect(registry.revokeTask(OWNER_B, "task-remove")).toBe(0);
    expect(registry.revokeTask(OWNER_A, "task-remove")).toBe(2);
    await expect(
      registry.readText(OWNER_A, active.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    expect(() =>
      registry.activate(pending.reservation, {
        filePath: path.join(root, "pending.lrc"),
        format: "LRC",
        displayName: "pending.lrc",
        byteSize: Buffer.byteLength(VALID_LRC),
        sha256: sha256(VALID_LRC),
        expectedFileIdentity: UNREACHABLE_FILE_IDENTITY,
        expectedDirectoryIdentity: UNREACHABLE_DIRECTORY_IDENTITY,
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "task-remove",
        generation: 2,
        format: "SRT",
        displayName: "late.srt",
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
  });

  it("claims task generations and atomically supersedes an older retry", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry({ maxEntries: 2 });
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "task-retry-invalid",
        generation: 0,
        format: "SRT",
        displayName: "invalid.srt",
      })
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_ipc_request",
        field: "generation",
      }),
    );

    const first = await reserveAndActivate(
      registry,
      root,
      "task-retry",
      "first.srt",
      VALID_SRT,
      "SRT",
      1,
    );
    const firstLrc = registry.reserve({
      owner: OWNER_A,
      taskId: "task-retry",
      generation: 1,
      format: "LRC",
      displayName: "first.lrc",
    });

    const retriedSrt = registry.reserve({
      owner: OWNER_A,
      taskId: "task-retry",
      generation: 2,
      format: "SRT",
      displayName: "retried.srt",
    });
    await expect(
      registry.readText(OWNER_A, first.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_expired" });
    expect(registry.revokeReservation(firstLrc.reservation)).toBe(false);
    expect(() =>
      registry.activate(firstLrc.reservation, {
        filePath: path.join(root, "first.lrc"),
        format: "LRC",
        displayName: "first.lrc",
        byteSize: Buffer.byteLength(VALID_LRC),
        sha256: sha256(VALID_LRC),
        expectedFileIdentity: UNREACHABLE_FILE_IDENTITY,
        expectedDirectoryIdentity: UNREACHABLE_DIRECTORY_IDENTITY,
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "task-retry",
        generation: 1,
        format: "LRC",
        displayName: "late.lrc",
      })
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_ipc_request",
        field: "generation",
      }),
    );

    registry.activate(
      retriedSrt.reservation,
      await writeArtifact(root, "retried.srt", VALID_SRT, "SRT"),
    );
    const retriedLrc = registry.reserve({
      owner: OWNER_A,
      taskId: "task-retry",
      generation: 2,
      format: "LRC",
      displayName: "retried.lrc",
    });
    registry.activate(
      retriedLrc.reservation,
      await writeArtifact(root, "retried.lrc", VALID_LRC, "LRC"),
    );

    await expect(
      registry.readText(OWNER_A, retriedSrt.artifactRef),
    ).resolves.toMatchObject({ format: "SRT", cueCount: 2 });
    await expect(
      registry.readText(OWNER_A, retriedLrc.artifactRef),
    ).resolves.toMatchObject({ format: "LRC", cueCount: 2 });
  });

  it("releases every owner ref and prevents an old document from minting more", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const first = await reserveAndActivate(
      registry,
      root,
      "task-owner",
      "owner.srt",
      VALID_SRT,
      "SRT",
    );
    registry.reserve({
      owner: OWNER_A,
      taskId: "task-pending",
      generation: 1,
      format: "LRC",
      displayName: "owner.lrc",
    });
    expect(registry.revokeTask(OWNER_A, "task-revoked")).toBe(0);
    const internals = registry as unknown as {
      readonly taskGenerations: ReadonlyMap<string, number>;
      readonly revokedTasks: ReadonlySet<string>;
      readonly ownerTaskKeys: ReadonlyMap<string, ReadonlySet<string>>;
    };
    expect(internals.taskGenerations.size).toBe(2);
    expect(internals.revokedTasks.size).toBe(1);
    expect([...internals.ownerTaskKeys.values()][0]?.size).toBe(3);

    expect(registry.revokeOwner(OWNER_A)).toBe(2);
    expect(internals.taskGenerations.size).toBe(0);
    expect(internals.revokedTasks.size).toBe(0);
    expect(internals.ownerTaskKeys.size).toBe(0);
    await expect(
      registry.readText(OWNER_A, first.artifactRef),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "late-task",
        generation: 1,
        format: "SRT",
        displayName: "late.srt",
      })
    ).toThrowError(expect.objectContaining({ code: "owner_released" }));
    expect(() =>
      registry.reserve({
        owner: OWNER_A_RELOADED,
        taskId: "new-document-task",
        generation: 1,
        format: "SRT",
        displayName: "new.srt",
      })
    ).not.toThrow();
  });

  it("keeps a failed activation pending so the exporter can roll it back", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const reserved = registry.reserve({
      owner: OWNER_A,
      taskId: "task-activation",
      generation: 1,
      format: "SRT",
      displayName: "activation.srt",
    });
    const activation = await writeArtifact(
      root,
      "activation.srt",
      VALID_SRT,
      "SRT",
    );

    expect(() =>
      registry.activate(reserved.reservation, {
        ...activation,
        format: "LRC",
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    expect(registry.revokeReservation(reserved.reservation)).toBe(true);
    expect(registry.revokeReservation(reserved.reservation)).toBe(false);
  });

  it("invalidates a ref when the committed file changes, even at the same size", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-changed",
      "changed.srt",
      VALID_SRT,
      "SRT",
    );
    const replacement = VALID_SRT.replace("First line", "Other line");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(VALID_SRT));
    await writeFile(path.join(root, "changed.srt"), replacement, "utf8");

    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_changed" });
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_changed" });
  });

  it("rejects file symlink replacement and directory identity replacement", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const symlinkArtifact = await reserveAndActivate(
      registry,
      root,
      "task-symlink",
      "symlink.srt",
      VALID_SRT,
      "SRT",
    );

    if (process.platform !== "win32") {
      const target = path.join(root, "target.srt");
      await writeFile(target, VALID_SRT, "utf8");
      await rm(path.join(root, "symlink.srt"));
      await symlink(target, path.join(root, "symlink.srt"), "file");
      await expect(
        registry.readText(OWNER_A, symlinkArtifact.artifactRef),
      ).rejects.toMatchObject({ code: "artifact_changed" });
    }

    const output = path.join(root, "output");
    await mkdir(output);
    const directoryArtifact = await reserveAndActivate(
      registry,
      output,
      "task-directory",
      "directory.srt",
      VALID_SRT,
      "SRT",
    );
    await rename(output, path.join(root, "old-output"));
    await mkdir(output);
    await writeFile(path.join(output, "directory.srt"), VALID_SRT, "utf8");

    await expect(
      registry.readText(OWNER_A, directoryArtifact.artifactRef),
    ).rejects.toMatchObject({ code: "artifact_changed" });
  });

  it("returns stable content_too_large before reading a grown artifact", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-large",
      "large.srt",
      VALID_SRT,
      "SRT",
    );
    await truncate(
      path.join(root, "large.srt"),
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes + 1,
    );

    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "content_too_large" });
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "content_too_large" });
  });

  it("returns stable content_too_large when the combined text result exceeds 16 MiB", async () => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const cueText = "x".repeat(LOCAL_SUBTITLE_LIMITS.maxCueTextChars);
    const cueCount = 2_100;
    const content = `${Array(cueCount).fill(`[00:00.00]${cueText}`).join("\n")}\n`;
    const plainText = Array(cueCount).fill(cueText).join("\n");
    expect(Buffer.byteLength(content)).toBeLessThan(
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          format: "LRC",
          rawText: content,
          plainText,
          cueCount,
        }),
      ),
    ).toBeGreaterThan(LOCAL_SUBTITLE_LIMITS.maxArtifactBytes);

    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-combined-large",
      "combined-large.lrc",
      content,
      "LRC",
    );

    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "content_too_large" });
    await expect(
      registry.readText(OWNER_A, artifact.artifactRef),
    ).rejects.toMatchObject({ code: "content_too_large" });
  });

  it.each([
    {
      name: "invalid UTF-8",
      fileName: "invalid-utf8.srt",
      bytes: Buffer.from([0xff, 0xfe, 0xfd]),
    },
    {
      name: "invalid SRT structure",
      fileName: "invalid-structure.srt",
      bytes: Buffer.from("not an srt\n", "utf8"),
    },
  ])("returns stable invalid_content for $name", async ({ fileName, bytes }) => {
    const root = await tempRoot();
    const registry = deterministicRegistry();
    const reserved = registry.reserve({
      owner: OWNER_A,
      taskId: `task-${fileName}`,
      generation: 1,
      format: "SRT",
      displayName: fileName,
    });
    const filePath = path.join(root, fileName);
    await writeFile(filePath, bytes);
    const expectedIdentities = await captureExpectedIdentities(filePath);
    registry.activate(reserved.reservation, {
      filePath,
      format: "SRT",
      displayName: fileName,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...expectedIdentities,
    });

    await expect(
      registry.readText(OWNER_A, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_content" });
    await expect(
      registry.readText(OWNER_A, reserved.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_content" });
  });

  it("does not reveal without an injected host and drops a late owner result", async () => {
    const root = await tempRoot();
    const unavailable = deterministicRegistry();
    const unavailableArtifact = await reserveAndActivate(
      unavailable,
      root,
      "task-no-reveal",
      "no-reveal.srt",
      VALID_SRT,
      "SRT",
    );
    await expect(
      unavailable.reveal(OWNER_A, unavailableArtifact.artifactRef),
    ).rejects.toMatchObject({ code: "invalid_content" });

    let finishReveal!: () => void;
    let revealStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      revealStarted = resolve;
    });
    const pendingReveal = new Promise<void>((resolve) => {
      finishReveal = resolve;
    });
    const registry = deterministicRegistry({
      revealFile: () => {
        revealStarted();
        return pendingReveal;
      },
    });
    const artifact = await reserveAndActivate(
      registry,
      root,
      "task-late-owner",
      "late-owner.srt",
      VALID_SRT,
      "SRT",
    );
    const reveal = registry.reveal(OWNER_A, artifact.artifactRef);
    await started;
    registry.releaseOwner(OWNER_A);
    finishReveal();

    await expect(reveal).rejects.toMatchObject({ code: "owner_released" });
  });

  it("sweeps abandoned reservations and restores bounded registry capacity", async () => {
    let now = 1_000;
    const registry = deterministicRegistry({
      ttlMs: 10,
      maxEntries: 1,
      now: () => now,
    });
    const expired = registry.reserve({
      owner: OWNER_A,
      taskId: "task-capacity-one",
      generation: 1,
      format: "SRT",
      displayName: "one.srt",
    });
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "task-capacity-two",
        generation: 1,
        format: "SRT",
        displayName: "two.srt",
      })
    ).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));

    now = 1_010;
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.revokeReservation(expired.reservation)).toBe(false);
    expect(() =>
      registry.reserve({
        owner: OWNER_A,
        taskId: "task-capacity-two",
        generation: 1,
        format: "SRT",
        displayName: "two.srt",
      })
    ).not.toThrow();
  });
});

function deterministicRegistry(
  overrides: ConstructorParameters<typeof LocalSubtitleArtifactRegistry>[0] = {},
): LocalSubtitleArtifactRegistry {
  let artifact = 0;
  let reservation = 0;
  return new LocalSubtitleArtifactRegistry({
    tokenFactory: () => `ref-${++artifact}`,
    reservationFactory: () => `reservation-${++reservation}`,
    ...overrides,
  });
}

async function reserveAndActivate(
  registry: LocalSubtitleArtifactRegistry,
  root: string,
  taskId: string,
  displayName: string,
  content: string,
  format: "SRT" | "LRC",
  generation = 1,
) {
  const reserved = registry.reserve({
    owner: OWNER_A,
    taskId,
    generation,
    format,
    displayName,
  });
  const activation = await writeArtifact(
    root,
    displayName,
    content,
    format,
  );
  return registry.activate(reserved.reservation, activation);
}

async function writeArtifact(
  root: string,
  displayName: string,
  content: string,
  format: "SRT" | "LRC",
): Promise<ActivateLocalSubtitleArtifactOptions> {
  const filePath = path.join(root, displayName);
  await writeFile(filePath, content, "utf8");
  const expectedIdentities = await captureExpectedIdentities(filePath);
  return {
    filePath,
    format,
    displayName,
    byteSize: Buffer.byteLength(content),
    sha256: sha256(content),
    ...expectedIdentities,
  };
}

async function captureExpectedIdentities(filePath: string) {
  const [expectedFileIdentity, expectedDirectoryIdentity] = await Promise.all([
    localSubtitleFilesystemObjectIdentityForPath(filePath),
    localSubtitleFilesystemObjectIdentityForPath(path.dirname(filePath)),
  ]);
  return {
    expectedFileIdentity,
    expectedDirectoryIdentity,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function tempRoot(): Promise<string> {
  const lexical = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-local-subtitle-artifact-"),
  );
  tempRoots.push(lexical);
  return realpath(lexical);
}
