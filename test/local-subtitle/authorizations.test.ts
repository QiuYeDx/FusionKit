import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
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
        displayName: "first.wav",
        byteSize: 5,
        expiresAt: expect.any(Number),
      },
      {
        fileToken: "ls-input-file-2",
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
    const unsafeName = await file(root, "unsafe\n.wav", "audio");
    await expect(
      failedRegistry.authorize(OWNER_A, unsafeName),
    ).rejects.toMatchObject({ code: "invalid_content" });
    expect(failedFactory).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      const separatorName = await file(root, "unsafe\\name.wav", "audio");
      await expect(
        failedRegistry.authorize(OWNER_A, separatorName),
      ).rejects.toMatchObject({ code: "invalid_content" });
      expect(failedFactory).not.toHaveBeenCalled();
    }
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
    const unsafeOutput = path.join(root, "unsafe\noutput");
    await mkdir(unsafeOutput);
    const unsafeFactory = vi.fn(() => "unsafe-output-token");
    await expect(
      new LocalSubtitleOutputDirectoryAuthorizationRegistry({
        tokenFactory: unsafeFactory,
      }).authorize(OWNER_A, unsafeOutput),
    ).rejects.toMatchObject({ code: "invalid_content" });
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
