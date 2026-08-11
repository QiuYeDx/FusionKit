import { afterEach, describe, expect, it, vi } from "vitest";
import {
  link,
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
import {
  LocalSubtitleArtifactAuthorizationRegistry,
  LocalSubtitleAuthorizationError,
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleImportTokenRegistry,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  resolveSafeLocalSubtitleChildPath,
  type LocalSubtitleOwnerKey,
} from "../../electron/main/local-subtitle/authorizations";
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

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("local subtitle input and output authorizations", () => {
  it("authorizes many files all-or-none and exposes no paths", async () => {
    const root = await tempRoot();
    const first = await file(root, "first.wav", "first");
    const second = await file(root, "second.wav", "second");
    const tokenFactory = vi.fn(sequence("file"));
    const registry = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory,
    });
    const authorized = await registry.authorizeMany(OWNER_A, [first, second]);
    expect(authorized).toEqual([
      {
        fileToken: "ls-input-file-1",
        sourceKey: expect.stringMatching(/^ls-source-/),
        displayName: "first.wav",
        byteSize: 5,
        expiresAt: expect.any(Number),
      },
      {
        fileToken: "ls-input-file-2",
        sourceKey: expect.stringMatching(/^ls-source-/),
        displayName: "second.wav",
        byteSize: 6,
        expiresAt: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(authorized)).not.toContain(root);
    const failedFactory = vi.fn(sequence("never"));
    const failedRegistry = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: failedFactory,
    });
    await expect(
      failedRegistry.authorizeMany(OWNER_A, [first, path.join(root, "missing")]),
    ).rejects.toMatchObject({ code: "media_changed" });
    expect(failedFactory).not.toHaveBeenCalled();
    const empty = await file(root, "empty.wav", "");
    await expect(failedRegistry.authorize(OWNER_A, empty)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    expect(failedFactory).not.toHaveBeenCalled();
    const oversized = await file(root, "oversized.wav", "x");
    await truncate(oversized, 64 * 1024 * 1024 * 1024 + 1);
    await expect(failedRegistry.authorize(OWNER_A, oversized)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    expect(failedFactory).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      const unsafeName = await file(root, "unsafe\n.wav", "audio");
      await expect(
        failedRegistry.authorize(OWNER_A, unsafeName),
      ).rejects.toMatchObject({ code: "invalid_content" });
      expect(failedFactory).not.toHaveBeenCalled();
      const separatorName = await file(root, "unsafe\\name.wav", "audio");
      await expect(
        failedRegistry.authorize(OWNER_A, separatorName),
      ).rejects.toMatchObject({ code: "invalid_content" });
      expect(failedFactory).not.toHaveBeenCalled();
    }
  });

  it("reuses an opaque source key for the same owner and canonical file only", async () => {
    const root = await tempRoot();
    const input = await file(root, "same.wav", "audio");
    const registry = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: sequence("token"),
      sourceKeyFactory: sequence("source"),
    });

    const first = await registry.authorize(OWNER_A, input);
    const second = await registry.authorize(OWNER_A, input);
    const otherOwner = await registry.authorize(OWNER_B, input);

    expect(first.fileToken).not.toBe(second.fileToken);
    expect(first.sourceKey).toBe("ls-source-source-1");
    expect(second.sourceKey).toBe(first.sourceKey);
    expect(otherOwner.sourceKey).toBe("ls-source-source-2");
    expect(JSON.stringify([first, second, otherOwner])).not.toContain(root);
  });

  it("enforces owner, operation, and exact TTL boundaries", async () => {
    const root = await tempRoot();
    const input = await file(root, "input.wav", "audio");
    let now = 1_000;
    const registry = new LocalSubtitleInputAuthorizationRegistry({
      draftTtlMs: 100,
      now: () => now,
      tokenFactory: () => "input-token",
    });
    const authorized = await registry.authorize(OWNER_A, input, ["probe"]);

    await expect(
      registry.resolveDraft(OWNER_B, authorized.fileToken, "probe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    now = 1_099;
    const canonicalInput = await realpath(input);
    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "probe"),
    ).resolves.toMatchObject({ filePath: canonicalInput });
    now = 1_100;
    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "probe"),
    ).rejects.toMatchObject({ code: "authorization_expired" });
    expect(registry.revokeDraft(OWNER_A, authorized.fileToken)).toBe(false);
  });

  it("keeps custom transcribe inputs valid when only the source parent label is unsafe", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const sourceDirectory = path.join(root, "unsafe\\parent");
    await mkdir(sourceDirectory);
    const inputPath = await file(sourceDirectory, "input.wav", "audio");
    const registry = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "unsafe-parent-input",
    });

    const authorized = await registry.authorize(OWNER_A, inputPath);

    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "transcribe"),
    ).resolves.toMatchObject({ displayName: "input.wav" });
  });

  it("revokes an input when its filesystem identity changes", async () => {
    const root = await tempRoot();
    const input = await file(root, "changed.wav", "before");
    const registry = new LocalSubtitleInputAuthorizationRegistry();
    const authorized = await registry.authorize(OWNER_A, input);
    await writeFile(input, "different-size-content");
    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "probe"),
    ).rejects.toMatchObject({ code: "media_changed" });
    await expect(
      registry.resolveDraft(OWNER_A, authorized.fileToken, "probe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("rejects file and directory symlink authorizations", async () => {
    const root = await tempRoot();
    const targetFile = await file(root, "target.wav", "audio");
    const fileLink = path.join(root, "linked.wav");
    const targetDirectory = path.join(root, "target-directory");
    const directoryLink = path.join(root, "linked-directory");
    await mkdir(targetDirectory);
    if (process.platform !== "win32") {
      await symlink(targetFile, fileLink, "file");
      await expect(
        new LocalSubtitleInputAuthorizationRegistry().authorize(
          OWNER_A,
          fileLink,
        ),
      ).rejects.toMatchObject({ code: "media_changed" });
    }
    await symlink(
      targetDirectory,
      directoryLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      new LocalSubtitleOutputDirectoryAuthorizationRegistry().authorize(
        OWNER_A,
        directoryLink,
      ),
    ).rejects.toMatchObject({ code: "output_write_failed" });
  });

  it("detects replacement of an authorized output directory", async () => {
    const root = await tempRoot();
    const output = path.join(root, "output");
    await mkdir(output);
    const registry = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "output-token",
    });
    const authorized = await registry.authorize(OWNER_A, output);
    const unsafeFactory = vi.fn(() => "unsafe-output-token");
    if (process.platform !== "win32") {
      const unsafeOutput = path.join(root, "unsafe\noutput");
      await mkdir(unsafeOutput);
      await expect(
        new LocalSubtitleOutputDirectoryAuthorizationRegistry({
          tokenFactory: unsafeFactory,
        }).authorize(OWNER_A, unsafeOutput),
      ).rejects.toMatchObject({ code: "invalid_content" });
    }
    expect(unsafeFactory).not.toHaveBeenCalled();
    const rootAuthorization = await new LocalSubtitleOutputDirectoryAuthorizationRegistry()
      .authorize(OWNER_A, path.parse(root).root);
    expect(rootAuthorization.directoryName).toBe("Filesystem root");

    await rm(output, { recursive: true });
    await mkdir(output);

    await expect(
      registry.resolveDraft(OWNER_A, authorized.outputDirToken),
    ).rejects.toMatchObject({ code: "output_write_failed" });
    expect(registry.revokeDraft(OWNER_A, authorized.outputDirToken)).toBe(false);
  });
});

describe("local subtitle task source output authorization", () => {
  it("derives a main-only canonical parent from the committed input lease", async () => {
    const root = await tempRoot();
    const sourceDirectory = path.join(root, "source-media");
    await mkdir(sourceDirectory);
    const inputPath = await file(sourceDirectory, "input.wav", "audio");
    let now = 1_000;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      leaseTtlMs: 100,
      now: () => now,
      tokenFactory: () => "source-input",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
      { now: () => now },
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "source-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "source-task" }],
    });
    const lease = transaction.commit();
    const canonicalDirectory = await realpath(sourceDirectory);
    const directoryIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(canonicalDirectory);

    now = 1_050;
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "source-task",
        input.fileToken,
      ),
    ).resolves.toEqual({
      directoryPath: canonicalDirectory,
      directoryName: "source-media",
      identity: directoryIdentity,
      expiresAt: 1_100,
    });
    expect(JSON.stringify(input)).not.toContain(root);
    expect(JSON.stringify(lease)).not.toContain(root);
  });

  it("binds source output derivation to owner, task, token, and exact TTL", async () => {
    const root = await tempRoot();
    const paths = await Promise.all([
      file(root, "first.wav", "first"),
      file(root, "second.wav", "second"),
    ]);
    let now = 2_000;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      leaseTtlMs: 10,
      now: () => now,
      tokenFactory: sequence("source-bound"),
    });
    const [first, second] = await inputs.authorizeMany(OWNER_A, paths);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
      { now: () => now },
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "source-bound-batch",
      inputs: [
        { fileToken: first!.fileToken, taskId: "source-bound-first" },
        { fileToken: second!.fileToken, taskId: "source-bound-second" },
      ],
    });
    transaction.commit();

    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_B,
        "source-bound-first",
        first!.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "unknown-task",
        first!.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "source-bound-first",
        second!.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "source-bound-second",
        first!.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    now = 2_010;
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "source-bound-first",
        first!.fileToken,
      ),
    ).rejects.toMatchObject({ code: "authorization_expired" });
  });

  it("requires derive_source_output on the committed input lease", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "transcribe-only.wav", "audio");
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "transcribe-only",
    });
    const input = await inputs.authorize(OWNER_A, inputPath, ["transcribe"]);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "transcribe-only-batch",
      inputs: [
        { fileToken: input.fileToken, taskId: "transcribe-only-task" },
      ],
    });
    transaction.commit();

    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "transcribe-only-task",
        input.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request", field: "operation" });
  });

  it("revokes source output derivation when the committed file is replaced", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "replace-file.wav", "before");
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "replace-file",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "replace-file-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "replace-file-task" }],
    });
    transaction.commit();
    await rm(inputPath);
    await writeFile(inputPath, "after replacement");

    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "replace-file-task",
        input.fileToken,
      ),
    ).rejects.toMatchObject({ code: "media_changed" });
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "replace-file-task",
        input.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("rejects parent replacement after capture even when file identity remains exact", async () => {
    const root = await tempRoot();
    const sourceDirectory = path.join(root, "replace-parent-source");
    const replacementDirectory = path.join(root, "replace-parent-ready");
    const displacedDirectory = path.join(root, "replace-parent-displaced");
    await mkdir(sourceDirectory);
    await mkdir(replacementDirectory);
    const inputPath = await file(sourceDirectory, "input.wav", "audio");
    await link(inputPath, path.join(replacementDirectory, "input.wav"));
    let sourceResolutionActive = false;
    let sourceVerification = 0;
    const enteredSecondVerification = deferred<void>();
    const verificationGate = deferred<void>();
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "replace-parent",
      beforeVerify: () => {
        if (!sourceResolutionActive) return;
        sourceVerification += 1;
        if (sourceVerification !== 2) return;
        enteredSecondVerification.resolve();
        return verificationGate.promise;
      },
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "replace-parent-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "replace-parent-task" }],
    });
    transaction.commit();

    sourceResolutionActive = true;
    const resolving = inputs.resolveTaskSourceOutputDirectory(
      OWNER_A,
      "replace-parent-task",
      input.fileToken,
    );
    await enteredSecondVerification.promise;
    await rename(sourceDirectory, displacedDirectory);
    await rename(replacementDirectory, sourceDirectory);
    verificationGate.resolve();

    await expect(resolving).rejects.toMatchObject({
      code: "output_write_failed",
    });
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "replace-parent-task",
        "transcribe",
        input.fileToken,
      ),
    ).resolves.toMatchObject({ filePath: await realpath(inputPath) });
  });

  it("pins the source parent at authorization and accepts it again after repair", async () => {
    const root = await tempRoot();
    const sourceDirectory = path.join(root, "pinned-parent-source");
    const replacementDirectory = path.join(root, "pinned-parent-ready");
    const displacedDirectory = path.join(root, "pinned-parent-displaced");
    await Promise.all([mkdir(sourceDirectory), mkdir(replacementDirectory)]);
    const inputPath = await file(sourceDirectory, "input.wav", "audio");
    await link(inputPath, path.join(replacementDirectory, "input.wav"));
    const sourceIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(sourceDirectory);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "pinned-parent",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "pinned-parent-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "pinned-parent-task" }],
    });
    transaction.commit();

    await rename(sourceDirectory, displacedDirectory);
    await rename(replacementDirectory, sourceDirectory);
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "pinned-parent-task",
        input.fileToken,
      ),
    ).rejects.toMatchObject({ code: "output_write_failed" });
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "pinned-parent-task",
        "transcribe",
        input.fileToken,
      ),
    ).resolves.toBeDefined();

    await rename(sourceDirectory, replacementDirectory);
    await rename(displacedDirectory, sourceDirectory);
    await expect(
      inputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "pinned-parent-task",
        input.fileToken,
      ),
    ).resolves.toMatchObject({
      directoryPath: await realpath(sourceDirectory),
      identity: sourceIdentity,
    });
  });

  it("rechecks exact file identity after the source parent boundary proof", async () => {
    const root = await tempRoot();
    const sourceDirectory = path.join(root, "final-file-source");
    await mkdir(sourceDirectory);
    const inputPath = await file(sourceDirectory, "input.wav", "before");
    let sourceResolutionActive = false;
    let sourceVerification = 0;
    const enteredFinalVerification = deferred<void>();
    const verificationGate = deferred<void>();
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "final-file",
      beforeVerify: () => {
        if (!sourceResolutionActive) return;
        sourceVerification += 1;
        if (sourceVerification !== 3) return;
        enteredFinalVerification.resolve();
        return verificationGate.promise;
      },
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "final-file-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "final-file-task" }],
    });
    transaction.commit();

    sourceResolutionActive = true;
    const resolving = inputs.resolveTaskSourceOutputDirectory(
      OWNER_A,
      "final-file-task",
      input.fileToken,
    );
    await enteredFinalVerification.promise;
    await rm(inputPath);
    await writeFile(inputPath, "after");
    verificationGate.resolve();

    await expect(resolving).rejects.toMatchObject({ code: "media_changed" });
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "final-file-task",
        "transcribe",
        input.fileToken,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("uses a canonical parent and rejects a symlink inserted after capture", async () => {
    const root = await tempRoot();
    const canonicalDirectory = path.join(root, "canonical-source");
    const aliasDirectory = path.join(root, "source-alias");
    await mkdir(canonicalDirectory);
    const canonicalInput = await file(canonicalDirectory, "input.wav", "audio");
    await symlink(
      canonicalDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const canonicalInputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "canonical-parent",
    });
    const canonicalAuthorization = await canonicalInputs.authorize(
      OWNER_A,
      path.join(aliasDirectory, "input.wav"),
    );
    const canonicalTransaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      canonicalInputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "canonical-parent-batch",
      inputs: [
        {
          fileToken: canonicalAuthorization.fileToken,
          taskId: "canonical-parent-task",
        },
      ],
    });
    canonicalTransaction.commit();
    await expect(
      canonicalInputs.resolveTaskSourceOutputDirectory(
        OWNER_A,
        "canonical-parent-task",
        canonicalAuthorization.fileToken,
      ),
    ).resolves.toMatchObject({
      directoryPath: await realpath(canonicalDirectory),
      directoryName: "canonical-source",
    });

    const sourceDirectory = path.join(root, "symlink-race-source");
    const displacedDirectory = path.join(root, "symlink-race-displaced");
    await mkdir(sourceDirectory);
    const raceInput = await file(sourceDirectory, "race.wav", "audio");
    let sourceResolutionActive = false;
    let sourceVerification = 0;
    const enteredSecondVerification = deferred<void>();
    const verificationGate = deferred<void>();
    const raceInputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "symlink-parent",
      beforeVerify: () => {
        if (!sourceResolutionActive) return;
        sourceVerification += 1;
        if (sourceVerification !== 2) return;
        enteredSecondVerification.resolve();
        return verificationGate.promise;
      },
    });
    const raceAuthorization = await raceInputs.authorize(OWNER_A, raceInput);
    const raceTransaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      raceInputs,
      new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "symlink-parent-batch",
      inputs: [
        {
          fileToken: raceAuthorization.fileToken,
          taskId: "symlink-parent-task",
        },
      ],
    });
    raceTransaction.commit();

    sourceResolutionActive = true;
    const resolving = raceInputs.resolveTaskSourceOutputDirectory(
      OWNER_A,
      "symlink-parent-task",
      raceAuthorization.fileToken,
    );
    await enteredSecondVerification.promise;
    await rename(sourceDirectory, displacedDirectory);
    await symlink(
      displacedDirectory,
      sourceDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    verificationGate.resolve();

    await expect(resolving).rejects.toMatchObject({
      code: "output_write_failed",
    });
  });
});

describe("local subtitle capability lease transaction", () => {
  it("commits input and output leases and isolates renderer revoke", async () => {
    const root = await tempRoot();
    const firstPath = await file(root, "first.wav", "first");
    const secondPath = await file(root, "second.wav", "second");
    const outputPath = path.join(root, "output");
    await mkdir(outputPath);
    let now = 10_000;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      leaseTtlMs: 100,
      now: () => now,
      tokenFactory: sequence("input"),
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      leaseTtlMs: 100,
      now: () => now,
      tokenFactory: sequence("output"),
    });
    const [first, second] = await inputs.authorizeMany(
      OWNER_A,
      [firstPath, secondPath],
    );
    const output = await outputs.authorize(OWNER_A, outputPath);
    const coordinator = new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
      { now: () => now, reservationIdFactory: () => "reservation-1" },
    );

    const transaction = await coordinator.reserveBatch({
      owner: OWNER_A,
      batchId: "batch-1",
      inputs: [
        { fileToken: first!.fileToken, taskId: "task-1" },
        { fileToken: second!.fileToken, taskId: "task-2" },
      ],
      outputDirToken: output.outputDirToken,
    });
    expect(inputs.revokeDraft(OWNER_A, first!.fileToken)).toBe(false);
    expect(outputs.revokeDraft(OWNER_A, output.outputDirToken)).toBe(false);
    expect(transaction.commit()).toMatchObject({
      batchId: "batch-1",
      taskIds: ["task-1", "task-2"],
      expiresAt: 10_100,
    });
    const canonicalFirstPath = await realpath(firstPath);
    const canonicalOutputPath = await realpath(outputPath);

    await expect(
      inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).resolves.toMatchObject({ filePath: canonicalFirstPath });
    await expect(
      outputs.resolveBatchLease(OWNER_A, "batch-1"),
    ).resolves.toMatchObject({ directoryPath: canonicalOutputPath });
    await expect(
      inputs.resolveTaskLease(OWNER_B, "task-1", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    now = 10_050;
    await expect(inputs.renewTaskLease(OWNER_A, "task-1", 200)).resolves.toBe(
      10_250,
    );
    await expect(outputs.renewBatchLease(OWNER_A, "batch-1", 200)).resolves.toBe(
      10_250,
    );
    expect(inputs.releaseTaskLease(OWNER_A, "task-1")).toBe(true);
    expect(outputs.releaseBatchLease(OWNER_A, "batch-1")).toBe(true);
  });

  it("keeps in-flight input and output resolution valid across lease renewal", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "renew-race.wav", "input");
    const outputPath = path.join(root, "renew-race-output");
    await mkdir(outputPath);
    const inputEntered = deferred<void>();
    const inputGate = deferred<void>();
    const outputEntered = deferred<void>();
    const outputGate = deferred<void>();
    let blockInput = false;
    let blockOutput = false;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "renew-race-input",
      beforeVerify: () => {
        if (!blockInput) return;
        blockInput = false;
        inputEntered.resolve();
        return inputGate.promise;
      },
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "renew-race-output",
      beforeVerify: () => {
        if (!blockOutput) return;
        blockOutput = false;
        outputEntered.resolve();
        return outputGate.promise;
      },
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "renew-race-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "renew-race-task" }],
      outputDirToken: output.outputDirToken,
    });
    transaction.commit();

    blockInput = true;
    const resolvingInput = inputs.resolveTaskLease(
      OWNER_A,
      "renew-race-task",
      "transcribe",
      input.fileToken,
    );
    await inputEntered.promise;
    await inputs.renewTaskLease(OWNER_A, "renew-race-task");
    inputGate.resolve();
    await expect(resolvingInput).resolves.toMatchObject({
      filePath: await realpath(inputPath),
    });

    blockOutput = true;
    const resolvingOutput = outputs.resolveBatchLease(
      OWNER_A,
      "renew-race-batch",
    );
    await outputEntered.promise;
    await outputs.renewBatchLease(OWNER_A, "renew-race-batch");
    outputGate.resolve();
    await expect(resolvingOutput).resolves.toMatchObject({
      directoryPath: await realpath(outputPath),
    });
  });

  it("rolls back earlier reservations when a later task scope conflicts", async () => {
    const root = await tempRoot();
    const paths = await Promise.all([
      file(root, "existing.wav", "existing"),
      file(root, "free.wav", "free"),
      file(root, "conflict.wav", "conflict"),
    ]);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: sequence("input"),
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const [existing, free, conflict] = await inputs.authorizeMany(OWNER_A, paths);
    const coordinator = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs, {
      reservationIdFactory: sequence("reservation"),
    });
    const existingTransaction = await coordinator.reserveBatch({
      owner: OWNER_A,
      batchId: "existing-batch",
      inputs: [{ fileToken: existing!.fileToken, taskId: "taken-task" }],
    });
    existingTransaction.commit();

    await expect(
      coordinator.reserveBatch({
        owner: OWNER_A,
        batchId: "new-batch",
        inputs: [
          { fileToken: free!.fileToken, taskId: "free-task" },
          { fileToken: conflict!.fileToken, taskId: "taken-task" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    expect(inputs.revokeDraft(OWNER_A, free!.fileToken)).toBe(true);
    expect(inputs.revokeDraft(OWNER_A, conflict!.fileToken)).toBe(true);
    const canonicalExistingPath = await realpath(paths[0]!);
    await expect(
      inputs.resolveTaskLease(OWNER_A, "taken-task", "transcribe"),
    ).resolves.toMatchObject({ filePath: canonicalExistingPath });
  });

  it("restores every draft on explicit rollback", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "input.wav", "input");
    const outputPath = path.join(root, "output");
    await mkdir(outputPath);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "input-token",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "output-token",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "batch",
      inputs: [{ fileToken: input.fileToken, taskId: "task" }],
      outputDirToken: output.outputDirToken,
    });

    transaction.rollback();

    expect(inputs.revokeDraft(OWNER_A, input.fileToken)).toBe(true);
    expect(outputs.revokeDraft(OWNER_A, output.outputDirToken)).toBe(true);
  });

  it("restores committed leases when synchronous batch publication fails", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "publish-failure.wav", "input");
    const outputPath = path.join(root, "publish-failure-output");
    await mkdir(outputPath);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "publish-failure-input",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "publish-failure-output",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "publish-failure-batch",
      inputs: [
        { fileToken: input.fileToken, taskId: "publish-failure-task" },
      ],
      outputDirToken: output.outputDirToken,
    });

    expect(() =>
      transaction.commitAndRun(() => {
        throw new Error("session publication failed");
      }),
    ).toThrow("session publication failed");

    expect(inputs.revokeDraft(OWNER_A, input.fileToken)).toBe(true);
    expect(outputs.revokeDraft(OWNER_A, output.outputDirToken)).toBe(true);
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "publish-failure-task",
        "transcribe",
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("ignores public rollback reentrancy while publishing a committed batch", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "reentrant-rollback.wav", "input");
    const outputPath = path.join(root, "reentrant-rollback-output");
    await mkdir(outputPath);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "reentrant-rollback-input",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "reentrant-rollback-output",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "reentrant-rollback-batch",
      inputs: [
        { fileToken: input.fileToken, taskId: "reentrant-rollback-task" },
      ],
      outputDirToken: output.outputDirToken,
    });

    expect(
      transaction.commitAndRun(() => {
        transaction.rollback();
        return "published";
      }),
    ).toMatchObject({
      lease: { batchId: "reentrant-rollback-batch" },
      value: "published",
    });
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "reentrant-rollback-task",
        "transcribe",
      ),
    ).resolves.toMatchObject({ filePath: await realpath(inputPath) });
    await expect(
      outputs.resolveBatchLease(OWNER_A, "reentrant-rollback-batch"),
    ).resolves.toMatchObject({ directoryPath: await realpath(outputPath) });
  });

  it("fails publication and compensates surviving leases after owner release", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "publish-owner-release.wav", "input");
    const outputPath = path.join(root, "publish-owner-release-output");
    await mkdir(outputPath);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: () => "publish-owner-release-input",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "publish-owner-release-output",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "publish-owner-release-batch",
      inputs: [
        {
          fileToken: input.fileToken,
          taskId: "publish-owner-release-task",
        },
      ],
      outputDirToken: output.outputDirToken,
    });

    expect(() =>
      transaction.commitAndRun(() => inputs.releaseOwner(OWNER_A))
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    await expect(
      inputs.resolveTaskLease(
        OWNER_A,
        "publish-owner-release-task",
        "transcribe",
      ),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(outputs.revokeDraft(OWNER_A, output.outputDirToken)).toBe(true);
    await expect(
      outputs.resolveBatchLease(OWNER_A, "publish-owner-release-batch"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("fails closed when publication sweeps an output lease at expiry", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "publish-expiry.wav", "input");
    const outputPath = path.join(root, "publish-expiry-output");
    await mkdir(outputPath);
    let inputNow = 100;
    let outputNow = 100;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      draftTtlMs: 1_000,
      leaseTtlMs: 10,
      now: () => inputNow,
      tokenFactory: () => "publish-expiry-input",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      draftTtlMs: 1_000,
      leaseTtlMs: 10,
      now: () => outputNow,
      tokenFactory: () => "publish-expiry-output",
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
      { now: () => 100 },
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "publish-expiry-batch",
      inputs: [{ fileToken: input.fileToken, taskId: "publish-expiry-task" }],
      outputDirToken: output.outputDirToken,
    });

    expect(() =>
      transaction.commitAndRun(() => {
        outputNow = 110;
        expect(outputs.sweepExpired()).toBe(1);
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    expect(inputs.revokeDraft(OWNER_A, input.fileToken)).toBe(true);
    expect(outputs.revokeDraft(OWNER_A, output.outputDirToken)).toBe(false);
    await expect(
      outputs.resolveBatchLease(OWNER_A, "publish-expiry-batch"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it.each(["pending", "resolved", "rejected"] as const)(
    "rejects and absorbs a %s thenable from synchronous batch publication",
    async (kind) => {
      const root = await tempRoot();
      const inputPath = await file(root, `${kind}-publish.wav`, "input");
      const inputs = new LocalSubtitleInputAuthorizationRegistry({
        tokenFactory: () => `${kind}-publish-input`,
      });
      const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
      const input = await inputs.authorize(OWNER_A, inputPath);
      const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
        inputs,
        outputs,
      ).reserveBatch({
        owner: OWNER_A,
        batchId: `${kind}-publish-batch`,
        inputs: [
          {
            fileToken: input.fileToken,
            taskId: `${kind}-publish-task`,
          },
        ],
      });
      const thenable = kind === "pending"
        ? new Promise<never>(() => undefined)
        : kind === "resolved"
          ? Promise.resolve("published")
          : Promise.reject(new Error("late publish rejection"));

      expect(() => transaction.commitAndRun(() => thenable)).toThrow(
        expect.objectContaining({ code: "invalid_ipc_request", field: "publish" }),
      );
      await Promise.resolve();
      expect(inputs.revokeDraft(OWNER_A, input.fileToken)).toBe(true);
    },
  );

  it("rolls back to valid drafts when a reserved lease expires before commit", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "lease-expiry.wav", "input");
    let now = 100;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      draftTtlMs: 1_000,
      leaseTtlMs: 100,
      now: () => now,
      tokenFactory: () => "lease-expiry-input",
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      draftTtlMs: 1_000,
      leaseTtlMs: 100,
      now: () => now,
    });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
      { now: () => now },
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "lease-expiry-batch",
      inputs: [
        { fileToken: input.fileToken, taskId: "lease-expiry-task" },
      ],
      leaseTtlMs: 10,
    });

    now = 110;
    expect(() => transaction.commit()).toThrowError(
      expect.objectContaining({ code: "authorization_expired" }),
    );
    expect(inputs.revokeDraft(OWNER_A, input.fileToken)).toBe(true);
  });

  it("sweeps abandoned reservations back to drafts until the draft expires", async () => {
    const root = await tempRoot();
    const firstPath = await file(root, "abandoned.wav", "input");
    const secondPath = await file(root, "fully-expired.wav", "input");
    let now = 1_000;
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      draftTtlMs: 100,
      leaseTtlMs: 10,
      now: () => now,
      tokenFactory: sequence("abandoned"),
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      draftTtlMs: 100,
      leaseTtlMs: 10,
      now: () => now,
    });
    const first = await inputs.authorize(OWNER_A, firstPath);
    const firstTransaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
      { now: () => now },
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "abandoned-batch",
      inputs: [{ fileToken: first.fileToken, taskId: "abandoned-task" }],
    });

    now = 1_010;
    expect(inputs.sweepExpired()).toBe(1);
    expect(inputs.revokeDraft(OWNER_A, first.fileToken)).toBe(true);
    expect(() => firstTransaction.commit()).toThrowError(
      expect.objectContaining({ code: "invalid_ipc_request" }),
    );

    now = 2_000;
    const second = await inputs.authorize(OWNER_A, secondPath);
    await new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs, {
      now: () => now,
    }).reserveBatch({
      owner: OWNER_A,
      batchId: "expired-batch",
      inputs: [{ fileToken: second.fileToken, taskId: "expired-task" }],
    });
    now = 2_100;
    expect(inputs.sweepExpired()).toBe(1);
    expect(inputs.revokeDraft(OWNER_A, second.fileToken)).toBe(false);
  });

  it("owner release removes drafts and leases without authorizing a reload", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "input.wav", "input");
    const inputs = new LocalSubtitleInputAuthorizationRegistry({
      tokenFactory: sequence("input"),
    });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const input = await inputs.authorize(OWNER_A, inputPath);
    const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
      inputs,
      outputs,
    ).reserveBatch({
      owner: OWNER_A,
      batchId: "batch",
      inputs: [{ fileToken: input.fileToken, taskId: "task" }],
    });
    transaction.commit();

    inputs.releaseOwner(OWNER_A);

    await expect(
      inputs.resolveTaskLease(OWNER_A, "task", "transcribe"),
    ).rejects.toMatchObject({ code: "owner_released" });
    await expect(
      inputs.resolveTaskLease(OWNER_A_RELOADED, "task", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(inputs.authorize(OWNER_A, inputPath)).rejects.toMatchObject({
      code: "owner_released",
    });
  });
});

describe("local subtitle artifact and import token skeletons", () => {
  it("binds artifact refs to owner, TTL, and allowed operations", () => {
    let now = 100;
    const registry = new LocalSubtitleArtifactAuthorizationRegistry<string>({
      ttlMs: 10,
      now: () => now,
      tokenFactory: () => "artifact-ref",
    });
    const authorization = registry.register(OWNER_A, "descriptor", ["read"]);
    expect(() => registry.register(
      { webContentsId: -1, ownerSessionId: "invalid" },
      "invalid-owner",
    )).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));

    expect(registry.resolve(OWNER_A, authorization.artifactRef, "read")).toBe(
      "descriptor",
    );
    expect(() =>
      registry.resolve(OWNER_A, authorization.artifactRef, "handoff")
    ).toThrowError(LocalSubtitleAuthorizationError);
    expect(() =>
      registry.resolve(OWNER_B, authorization.artifactRef, "read")
    ).toThrowError(LocalSubtitleAuthorizationError);
    now = 110;
    expect(() =>
      registry.resolve(OWNER_A, authorization.artifactRef, "read")
    ).toThrowError(expect.objectContaining({ code: "authorization_expired" }));
    registry.register(OWNER_A, "second", ["read"]);
    now = 120;
    expect(registry.sweepExpired()).toBe(1);
  });

  it("consumes import tokens once and disposes on success, failure, and expiry", async () => {
    let now = 1_000;
    const dispose = vi.fn();
    const registry = new LocalSubtitleImportTokenRegistry<string>({
      ttlMs: 10,
      maxTokens: 2,
      maxBytes: 8,
      now: () => now,
      tokenFactory: sequence("import"),
    });
    const success = registry.mint(OWNER_A, "one", 3, dispose);
    await expect(
      registry.consume(
        OWNER_A,
        success.translationImportToken,
        (value) => value.toUpperCase(),
      ),
    ).resolves.toBe("ONE");
    await expect(
      registry.consume(OWNER_A, success.translationImportToken, (value) => value),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    const failure = registry.mint(OWNER_A, "two", 3, dispose);
    await expect(
      registry.consume(OWNER_A, failure.translationImportToken, () => {
        throw new Error("consumer failed");
      }),
    ).rejects.toThrow("consumer failed");
    const expiredToken = registry.mint(OWNER_A, "old", 3, dispose);
    now = 1_010;
    await expect(
      registry.consume(
        OWNER_A,
        expiredToken.translationImportToken,
        (value) => value,
      ),
    ).rejects.toMatchObject({ code: "authorization_expired" });
    expect(dispose.mock.calls.map(([value]) => value)).toEqual([
      "one",
      "two",
      "old",
    ]);
  });

  it("enforces import token quotas and releases quota on revoke", () => {
    let now = 0;
    const dispose = vi.fn();
    const registry = new LocalSubtitleImportTokenRegistry<string>({
      ttlMs: 5,
      maxTokens: 1,
      maxBytes: 4,
      now: () => now,
      tokenFactory: sequence("import"),
    });
    expect(() => registry.mint(
      { webContentsId: -1, ownerSessionId: "invalid" },
      "bad",
      1,
      dispose,
    )).toThrowError(expect.objectContaining({ code: "invalid_ipc_request" }));
    const first = registry.mint(OWNER_A, "one", 4, dispose);
    expect(() => registry.mint(OWNER_A, "two", 1, dispose)).toThrowError(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
    now = 5;
    expect(registry.sweepExpired()).toBe(1);
    expect(dispose).toHaveBeenCalledWith("one");
    const second = registry.mint(OWNER_A, "two", 1, dispose);
    expect(registry.revoke(OWNER_A, second.translationImportToken)).toBe(true);
    registry.mint(OWNER_A, "three", 1, dispose);
    registry.releaseOwner(OWNER_A);
    expect(dispose).toHaveBeenLastCalledWith("three");
    expect(() => registry.mint(OWNER_A, "old-owner", 1, dispose)).toThrowError(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() => registry.mint(OWNER_B, "new-owner", 4, dispose)).not.toThrow();
  });

  it("uses non-confusable kind prefixes even with the same token source", async () => {
    const root = await tempRoot();
    const inputPath = await file(root, "input.wav", "input");
    const outputPath = path.join(root, "output");
    await mkdir(outputPath);
    const inputs = new LocalSubtitleInputAuthorizationRegistry({ tokenFactory: () => "same" });
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
      tokenFactory: () => "same",
    });
    const artifacts = new LocalSubtitleArtifactAuthorizationRegistry<string>({
      tokenFactory: () => "same",
    });
    const imports = new LocalSubtitleImportTokenRegistry<string>({ tokenFactory: () => "same" });
    const input = await inputs.authorize(OWNER_A, inputPath);
    const output = await outputs.authorize(OWNER_A, outputPath);
    const artifact = artifacts.register(OWNER_A, "artifact");
    const imported = imports.mint(OWNER_A, "snapshot", 8, () => undefined);
    expect([
      input.fileToken,
      output.outputDirToken,
      artifact.artifactRef,
      imported.translationImportToken,
    ]).toEqual([
      "ls-input-same", "ls-output-same", "ls-artifact-same", "ls-import-same",
    ]);
    await expect(
      outputs.resolveDraft(OWNER_A, input.fileToken),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      imports.consume(OWNER_A, artifact.artifactRef, (value) => value),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });
});

describe("safe local subtitle output leaf", () => {
  it("resolves a direct child and rejects traversal and platform-unsafe leaves", () => {
    const root = path.resolve(os.tmpdir(), "authorized-output");
    expect(resolveSafeLocalSubtitleChildPath(root, "subtitle.srt")).toBe(
      path.join(root, "subtitle.srt"),
    );
    for (const leaf of [
      "../escape.srt",
      "nested/subtitle.srt",
      "nested\\subtitle.srt",
      "/absolute.srt",
      "CON.srt",
      "stream:ads",
      "trailing.",
      "trailing ",
      "control\0.srt",
    ]) {
      expect(() => resolveSafeLocalSubtitleChildPath(root, leaf)).toThrowError(
        expect.objectContaining({ code: "output_write_failed" }),
      );
    }
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-local-subtitle-authorization-"),
  );
  tempRoots.push(root);
  return root;
}

async function file(root: string, name: string, content: string): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, content);
  return filePath;
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
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
