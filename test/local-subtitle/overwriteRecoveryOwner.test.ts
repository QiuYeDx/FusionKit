import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import {
  localSubtitleOverwriteDirectoryKey,
  releaseLocalSubtitleOverwriteDirectoryFence,
  withLocalSubtitleOverwriteDirectory,
} from "../../electron/main/local-subtitle/overwrite-directory-coordinator";
import {
  createLocalSubtitleOverwriteRecoveryAuthority,
  LocalSubtitleOverwriteRecoveryError,
  LocalSubtitleOverwriteRecoveryFileRepository,
  LocalSubtitleOverwriteRecoveryOwner,
  type AdoptLocalSubtitleOverwriteRecoveryOptions,
  type LocalSubtitleOverwriteRecoveryRecord,
  type LocalSubtitleOverwriteRecoveryRepository,
} from "../../electron/main/local-subtitle/overwrite-recovery-owner";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import { LocalSubtitleOverwriteTransactionReceipt } from "../../electron/main/local-subtitle/overwrite-transaction";

const OWNER = Object.freeze({
  webContentsId: 17,
  ownerSessionId: "overwrite-recovery-owner",
}) satisfies LocalSubtitleOwnerKey;
const DIRECTORY_IDENTITY = Object.freeze({ dev: 1, ino: 2, birthtimeMs: 3 });
const RECOVERY_ID = "01234567-89ab-4cde-8fab-0123456789ab";

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-overwrite-recovery-owner-test-"),
  );
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("local subtitle overwrite recovery owner", () => {
  it("owns a finalize-pending receipt before owner release retries it", () => {
    const finalize = vi.fn()
      .mockImplementationOnce(() => { throw new Error("first finalize failed"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ finalize });
    expect(() => receipt.finalize()).toThrow("first finalize failed");
    const repository = new MemoryRepository();
    const registry = registryFixture();
    const owner = recoveryOwner(repository, registry);

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-finalize",
      generation: 2,
      format: "SRT",
      direction: "finalize",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "active", artifactRef: "ls-artifact-active" },
    });

    expect(owner.listPending()).toEqual([
      expect.objectContaining({
        recoveryId: RECOVERY_ID,
        direction: "finalize",
        requiresDirectorySelection: false,
      }),
    ]);
    expect(repository.records[0]).toMatchObject({
      recoveryId: RECOVERY_ID,
      registryState: "active",
      nativeState: "pending",
    });

    owner.releaseOwner(OWNER);

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(registry.revokeArtifact).not.toHaveBeenCalled();
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("attempts native rollback and Registry cleanup before reporting the first failure", () => {
    const rollbackFailure = new Error("rollback still pending");
    const rollback = vi.fn(() => { throw rollbackFailure; });
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow(rollbackFailure);
    const repository = new MemoryRepository();
    const registry = registryFixture({
      revokeReservation: vi.fn(() => {
        throw new Error("registry cleanup failed");
      }),
    });
    const owner = recoveryOwner(repository, registry);

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-rollback",
      generation: 1,
      format: "LRC",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-1" },
    });

    expect(() => owner.releaseOwner(OWNER)).toThrow(rollbackFailure);
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(registry.revokeReservation).toHaveBeenCalledWith("reservation-1");
    expect(repository.records[0]).toMatchObject({
      nativeState: "retry_failed",
      registryState: "reserved",
    });
  });

  it("settles a late handoff immediately after the owner was already released", () => {
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw new Error("first rollback failed"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow();
    const repository = new MemoryRepository();
    const registry = registryFixture();
    const owner = recoveryOwner(repository, registry);
    owner.releaseOwner(OWNER);

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-late",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-late" },
    });

    expect(rollback).toHaveBeenCalledTimes(2);
    expect(registry.revokeReservation).toHaveBeenCalledWith("reservation-late");
    expect(owner.listPending()).toEqual([]);
  });

  it("retains ownership when durable persistence reports a failure", () => {
    const finalize = vi.fn()
      .mockImplementationOnce(() => { throw new Error("pending finalize"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ finalize });
    expect(() => receipt.finalize()).toThrow();
    const repository = new MemoryRepository({ failReplace: true });
    const owner = recoveryOwner(repository, registryFixture());

    expect(() => adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-persist-failure",
      generation: 1,
      format: "SRT",
      direction: "finalize",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "active", artifactRef: "artifact-persist-failure" },
    })).toThrowError(expect.objectContaining({ code: "persistence_failed" }));

    expect(owner.listPending()).toHaveLength(1);
    repository.failReplace = false;
    owner.retry(RECOVERY_ID);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("treats an already-absent Registry authority as idempotently settled", () => {
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw new Error("pending rollback"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow();
    const revokeReservation = vi.fn(() => false);
    const repository = new MemoryRepository();
    const owner = recoveryOwner(
      repository,
      registryFixture({ revokeReservation }),
    );

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-registry-retry",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-retry" },
    });

    owner.retry(RECOVERY_ID);
    expect(revokeReservation).toHaveBeenCalledOnce();
    expect(owner.listPending()).toEqual([]);
  });

  it("settles after the real Registry was already released by an earlier owner phase", () => {
    const registry = new LocalSubtitleArtifactRegistry({
      tokenFactory: () => "artifact-real-registry",
      reservationFactory: () => "reservation-real-registry",
    });
    const reserved = registry.reserve({
      owner: OWNER,
      taskId: "task-real-registry",
      generation: 1,
      format: "SRT",
      displayName: "real-registry.srt",
    });
    registry.releaseOwner(OWNER);
    expect(registry.revokeReservation(reserved.reservation)).toBe(false);
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw new Error("pending rollback"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow("pending rollback");
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository(),
      registry,
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => ({ state: "not_found" }),
      }),
      { now: () => 100 },
    );

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-real-registry",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: reserved.reservation },
    });
    owner.releaseOwner(OWNER);

    expect(rollback).toHaveBeenCalledTimes(2);
    expect(owner.listPending()).toEqual([]);
  });

  it("preserves the first terminal failure when Registry and persistence also fail", () => {
    const terminalFailure = new Error("terminal failure");
    const registryFailure = new Error("registry failure");
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw terminalFailure; })
      .mockImplementationOnce(() => { throw terminalFailure; })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow(terminalFailure);
    const revokeReservation = vi.fn()
      .mockImplementationOnce(() => { throw registryFailure; })
      .mockReturnValueOnce(true);
    const repository = new MemoryRepository();
    const owner = recoveryOwner(
      repository,
      registryFixture({ revokeReservation }),
    );
    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-first-failure",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-first-failure" },
    });
    repository.failReplace = true;

    let observed: unknown;
    try {
      owner.releaseOwner(OWNER);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(terminalFailure);
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(revokeReservation).toHaveBeenCalledOnce();
    expect(owner.listPending()).toHaveLength(1);

    repository.failReplace = false;
    owner.retry(RECOVERY_ID);
    expect(rollback).toHaveBeenCalledTimes(3);
    expect(revokeReservation).toHaveBeenCalledTimes(2);
    expect(owner.listPending()).toEqual([]);
  });

  it("recovers a durable rollback by exact id after directory reauthorization", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );
    const directory = resolvedDirectory(fixtureRoot);

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory,
    })).resolves.toEqual({ state: "rolled_back" });

    expect(recover).toHaveBeenCalledWith({
      transactionId: RECOVERY_ID,
      directoryPath: fixtureRoot,
      expectedDirectoryIdentity: DIRECTORY_IDENTITY,
    });
    const request = recover.mock.calls[0]![0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.expectedDirectoryIdentity)).toBe(true);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("accepts an exact Windows directory identity for recovery selection", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );
    const windowsIdentity = Object.freeze({
      volumeSerialHex: "680b91a8",
      fileIdHex: "0000000000000000002800000013944f",
    });

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot, windowsIdentity),
    })).resolves.toEqual({ state: "rolled_back" });

    expect(recover).toHaveBeenCalledWith({
      transactionId: RECOVERY_ID,
      directoryPath: fixtureRoot,
      expectedDirectoryIdentity: windowsIdentity,
    });
  });

  it("retries only repository deletion after native rollback already settled", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => {
      repository.failReplace = true;
      return { state: "rolled_back" as const };
    });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );
    const directoryKey = localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY);

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "persistence_failed" });

    expect(recover).toHaveBeenCalledTimes(1);
    await expect(
      withLocalSubtitleOverwriteDirectory(directoryKey, () => undefined),
    ).rejects.toThrow("pending overwrite recovery");

    repository.failReplace = false;
    expect(() => owner.retry(RECOVERY_ID)).not.toThrow();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
    await expect(
      withLocalSubtitleOverwriteDirectory(directoryKey, () => "released"),
    ).resolves.toBe("released");
  });

  it("retains decision_required and fences the selected directory", async () => {
      const state = "decision_required" as const;
      const record = persistedRecord({ direction: "rollback" });
      const repository = new MemoryRepository({ records: [record] });
      const owner = new LocalSubtitleOverwriteRecoveryOwner(
        repository,
        registryFixture(),
        createLocalSubtitleOverwriteRecoveryAuthority({
          recover: () => ({ state }),
        }),
      );

      await expect(owner.recoverAfterReauthorization({
        recoveryId: RECOVERY_ID,
        taskId: record.taskId,
        generation: record.generation,
        format: record.format,
        directory: resolvedDirectory(fixtureRoot),
      })).resolves.toEqual({ state });

      expect(owner.listPending()).toEqual([
        expect.objectContaining({ state, direction: "rollback" }),
      ]);
      const directoryKey = localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY);
      await expect(withLocalSubtitleOverwriteDirectory(
        directoryKey,
        () => undefined,
      )).rejects.toThrow("pending overwrite recovery");
      await expect(owner.shutdown("app_quit")).rejects.toMatchObject({
        code: "recovery_pending",
      });
      releaseLocalSubtitleOverwriteDirectoryFence(directoryKey, RECOVERY_ID);
  });

  it("retains not_found and fences the selected directory", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => ({ state: "not_found" }),
      }),
    );
    const directoryKey = localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY);

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "not_found" });

    expect(owner.listPending()).toEqual([
      expect.objectContaining({ state: "not_found", direction: "rollback" }),
    ]);
    await expect(
      withLocalSubtitleOverwriteDirectory(directoryKey, () => undefined),
    ).rejects.toThrow("pending overwrite recovery");
    await expect(owner.shutdown("app_quit")).rejects.toMatchObject({
      code: "recovery_pending",
    });
    releaseLocalSubtitleOverwriteDirectoryFence(directoryKey, RECOVERY_ID);
  });

  it("serializes concurrent directory selections for the same recovery", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );
    const selection = {
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
    } as const;

    const first = owner.recoverAfterReauthorization({
      ...selection,
      directory: resolvedDirectory(
        path.join(fixtureRoot, "first"),
        { dev: 11, ino: 12, birthtimeMs: 13 },
      ),
    });
    const second = owner.recoverAfterReauthorization({
      ...selection,
      directory: resolvedDirectory(
        path.join(fixtureRoot, "second"),
        { dev: 21, ino: 22, birthtimeMs: 23 },
      ),
    });

    await expect(first).resolves.toEqual({ state: "rolled_back" });
    await expect(second).rejects.toMatchObject({ code: "invalid_request" });
    expect(recover).toHaveBeenCalledOnce();
    expect(owner.listPending()).toEqual([]);
  });

  it("lets a queued recovery retry only repository deletion after native settled", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const replace = vi.spyOn(repository, "replace");
    replace.mockImplementationOnce(() => {
      throw new LocalSubtitleOverwriteRecoveryError(
        "persistence_failed",
        "injected first deletion failure",
      );
    });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );
    const selection = {
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    } as const;

    const first = owner.recoverAfterReauthorization(selection);
    const second = owner.recoverAfterReauthorization(selection);

    await expect(first).rejects.toMatchObject({ code: "persistence_failed" });
    await expect(second).resolves.toEqual({ state: "rolled_back" });
    expect(recover).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledTimes(2);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("does not invoke rollback-only native recovery for a durable finalize direction", async () => {
    const record = persistedRecord({ direction: "finalize" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "decision_required" });

    expect(recover).not.toHaveBeenCalled();
    expect(repository.records[0]).toMatchObject({
      direction: "finalize",
      nativeState: "decision_required",
    });
    const directoryKey = localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY);
    await expect(withLocalSubtitleOverwriteDirectory(
      directoryKey,
      () => undefined,
    )).rejects.toThrow("pending overwrite recovery");
    releaseLocalSubtitleOverwriteDirectoryFence(directoryKey, RECOVERY_ID);
  });

  it("settles a handoff that arrives after shutdown already succeeded", async () => {
    const repository = new MemoryRepository();
    const registry = registryFixture();
    const owner = recoveryOwner(repository, registry);
    await owner.shutdown("app_quit");
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw new Error("pending rollback"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ rollback });
    expect(() => receipt.rollback()).toThrow("pending rollback");

    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-late-shutdown",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-shutdown" },
    });

    expect(rollback).toHaveBeenCalledTimes(2);
    expect(registry.revokeReservation).toHaveBeenCalledWith(
      "reservation-shutdown",
    );
    expect(owner.listPending()).toEqual([]);
    await expect(owner.shutdown("app_quit")).resolves.toBeUndefined();
  });

  it("claims each branded transaction receipt only once", () => {
    const finalize = vi.fn()
      .mockImplementationOnce(() => { throw new Error("pending finalize"); })
      .mockImplementationOnce(() => undefined);
    const receipt = transactionReceipt({ finalize });
    expect(() => receipt.finalize()).toThrow("pending finalize");
    const owner = recoveryOwner(new MemoryRepository(), registryFixture());
    adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-first-claim",
      generation: 1,
      format: "SRT",
      direction: "finalize",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "active", artifactRef: "artifact-first-claim" },
    });

    expect(() => adoptRecovery(owner, {
      recoveryId: "11234567-89ab-4cde-8fab-0123456789ab",
      owner: OWNER,
      taskId: "task-second-claim",
      generation: 1,
      format: "SRT",
      direction: "finalize",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "active", artifactRef: "artifact-second-claim" },
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
    expect(owner.listPending()).toHaveLength(1);

    owner.retry(RECOVERY_ID);
    expect(owner.listPending()).toEqual([]);
  });

  it("rejects an unbranded transaction receipt before claiming recovery", () => {
    const owner = recoveryOwner(new MemoryRepository(), registryFixture());

    expect(() => adoptRecovery(owner, {
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-fake-receipt",
      generation: 1,
      format: "SRT",
      direction: "finalize",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt: {
        state: "finalize_pending",
        finalize: () => undefined,
        rollback: () => undefined,
      } as never,
      registry: { state: "active", artifactRef: "artifact-fake-receipt" },
    })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(owner.listPending()).toEqual([]);
  });

  it("rejects stale task metadata before invoking native recovery", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation + 1,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("claims one recovery authority exactly once", () => {
    const authority = createLocalSubtitleOverwriteRecoveryAuthority({
      recover: () => ({ state: "not_found" }),
    });
    new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository(),
      registryFixture(),
      authority,
    );

    expect(() => new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository(),
      registryFixture(),
      authority,
    )).toThrowError(expect.objectContaining({ code: "invalid_authority" }));
  });

  it.each([
    ["extra key", { state: "rolled_back", path: fixtureRoot }],
    ["unknown state", { state: "finalized" }],
    ["primitive", "rolled_back"],
  ])("rejects an invalid synchronous recovery result: %s", async (_label, result) => {
    const record = persistedRecord({ direction: "rollback" });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository({ records: [record] }),
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({ recover: () => result }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "invalid_result" });
  });

  it("rejects and absorbs an asynchronous recovery result", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository({ records: [record] }),
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => Promise.reject(new Error("late failure")),
      }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "invalid_result" });
    await Promise.resolve();
  });
});

describe("local subtitle overwrite recovery file repository", () => {
  it("round-trips only path-free, token-free recovery metadata", async () => {
    const filePath = path.join(fixtureRoot, "overwrite-recoveries.json");
    const repository = new LocalSubtitleOverwriteRecoveryFileRepository(filePath);
    const record = persistedRecord({ direction: "rollback" });

    repository.replace([record]);

    expect(repository.load()).toEqual([record]);
    const serialized = await readFile(filePath, "utf8");
    expect(serialized).not.toContain(fixtureRoot);
    expect(serialized).not.toContain("outputDirToken");
    expect(serialized).not.toContain("ownerSessionId");
    expect(serialized).not.toContain("artifactRef");
    expect(serialized).not.toContain("partialLeaf");
    expect(serialized).not.toContain("finalLeaf");
  });

  it("fails closed on a modified repository payload", async () => {
    const filePath = path.join(fixtureRoot, "overwrite-recoveries.json");
    const repository = new LocalSubtitleOverwriteRecoveryFileRepository(filePath);
    repository.replace([persistedRecord({ direction: "rollback" })]);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    parsed.records[0].taskId = "tampered-task";
    await writeFile(filePath, JSON.stringify(parsed), "utf8");

    expect(() => repository.load()).toThrowError(
      expect.objectContaining({ code: "invalid_record" }),
    );
  });

  it("accepts an exact read-back when parent sync fails after atomic rename", () => {
    const filePath = path.join(fixtureRoot, "overwrite-recoveries.json");
    const syncParentDirectory = vi.fn(() => {
      throw Object.assign(new Error("directory sync unavailable"), { code: "EINVAL" });
    });
    const repository = new LocalSubtitleOverwriteRecoveryFileRepository(
      filePath,
      { syncParentDirectory },
    );
    const record = persistedRecord({ direction: "rollback" });

    expect(() => repository.replace([record])).not.toThrow();
    expect(repository.load()).toEqual([record]);
    expect(() => repository.replace([])).not.toThrow();
    expect(repository.load()).toEqual([]);
    expect(syncParentDirectory).toHaveBeenCalledTimes(2);
  });
});

function recoveryOwner(
  repository: LocalSubtitleOverwriteRecoveryRepository,
  registry: ReturnType<typeof registryFixture>,
) {
  return new LocalSubtitleOverwriteRecoveryOwner(
    repository,
    registry,
    createLocalSubtitleOverwriteRecoveryAuthority({
      recover: () => ({ state: "not_found" }),
    }),
    { now: () => 100 },
  );
}

function adoptRecovery<TReservation>(
  owner: LocalSubtitleOverwriteRecoveryOwner<TReservation>,
  options: Omit<
    AdoptLocalSubtitleOverwriteRecoveryOptions<TReservation>,
    "handoff"
  >,
): void {
  const handoff = owner.prepareAdoption({
    recoveryId: options.recoveryId,
    owner: options.owner,
    taskId: options.taskId,
    generation: options.generation,
    format: options.format,
    directoryIdentity: options.directoryIdentity,
  });
  try {
    owner.adopt({ ...options, handoff });
  } finally {
    owner.releaseAdoption(handoff);
  }
}

function registryFixture(overrides: {
  readonly revokeReservation?: ReturnType<typeof vi.fn>;
  readonly revokeArtifact?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    revokeReservation: overrides.revokeReservation ?? vi.fn(() => true),
    revokeArtifact: overrides.revokeArtifact ?? vi.fn(() => true),
  };
}

function transactionReceipt(options: {
  readonly finalize?: () => void;
  readonly rollback?: () => void;
}) {
  return new LocalSubtitleOverwriteTransactionReceipt({
    expectedFinalIdentity: { dev: 4, ino: 5, birthtimeMs: 6 },
    finalize: options.finalize ?? (() => undefined),
    rollback: options.rollback ?? (() => undefined),
  });
}

function resolvedDirectory(
  directoryPath: string,
  identity = DIRECTORY_IDENTITY,
) {
  return Object.freeze({
    directoryPath,
    directoryName: "output",
    identity: Object.freeze({ ...identity }),
    expiresAt: 10_000,
  });
}

function persistedRecord(overrides: {
  readonly direction: "finalize" | "rollback";
}): LocalSubtitleOverwriteRecoveryRecord {
  return Object.freeze({
    schemaVersion: 1,
    recoveryId: RECOVERY_ID,
    ownerFingerprint: "a".repeat(64),
    taskId: "task-persisted",
    generation: 3,
    format: "SRT",
    direction: overrides.direction,
    registryState: overrides.direction === "finalize" ? "active" : "reserved",
    nativeState: "pending",
    createdAt: 10,
    updatedAt: 10,
  });
}

class MemoryRepository implements LocalSubtitleOverwriteRecoveryRepository {
  records: readonly LocalSubtitleOverwriteRecoveryRecord[];
  failReplace: boolean;

  constructor(options: {
    readonly records?: readonly LocalSubtitleOverwriteRecoveryRecord[];
    readonly failReplace?: boolean;
  } = {}) {
    this.records = options.records ?? [];
    this.failReplace = options.failReplace ?? false;
  }

  load() {
    return this.records;
  }

  replace(records: readonly LocalSubtitleOverwriteRecoveryRecord[]) {
    if (this.failReplace) {
      throw new LocalSubtitleOverwriteRecoveryError(
        "persistence_failed",
        "injected persistence failure",
      );
    }
    this.records = records.map((record) => Object.freeze({ ...record }));
  }
}
