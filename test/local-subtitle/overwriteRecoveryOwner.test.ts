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
      decision: "finalize_committed",
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
      decision: "rollback_unpublished",
      nativeState: "retry_failed",
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

  it("retains a fenced preclaim when durable persistence reports an uncertain failure", async () => {
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

    expect(owner.listPending()).toEqual([
      expect.objectContaining({
        recoveryId: RECOVERY_ID,
        direction: "rollback",
        state: "not_started",
        requiresDirectorySelection: true,
      }),
    ]);
    expect(repository.records).toEqual([]);
    expect(finalize).toHaveBeenCalledOnce();

    repository.failReplace = false;
    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: "task-persist-failure",
      generation: 1,
      format: "SRT",
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });
    expect(owner.listPending()).toEqual([]);
  });

  it.each(["before", "after"] as const)(
    "does not acknowledge a terminal marker when settled persistence fails $phase replacement",
    (phase) => {
    const rollback = vi.fn();
    const acknowledge = vi.fn();
    const receipt = transactionReceipt({ rollback, acknowledge });
    const repository = new MemoryRepository();
    const owner = recoveryOwner(repository, registryFixture());
    const handoff = owner.prepareAdoption({
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-settled-persistence",
      generation: 1,
      format: "SRT",
      directoryIdentity: DIRECTORY_IDENTITY,
    });
    owner.markBeginStarted(handoff);
    owner.adopt({
      handoff,
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-settled-persistence",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-settled" },
    });
    if (phase === "before") repository.failReplace = true;
    else repository.failAfterReplace = true;

    expect(() => owner.settleAdoption(handoff)).toThrowError(
      expect.objectContaining({ code: "persistence_failed" }),
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(receipt.state).toBe("rollback_pending_ack");
    expect(acknowledge).not.toHaveBeenCalled();

    repository.failReplace = false;
    repository.failAfterReplace = false;
    owner.settleAdoption(handoff);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(receipt.state).toBe("rolled_back");
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
    },
  );

  it("retries the exact finalize decision after an uncertain persistence result", () => {
    const finalize = vi.fn();
    const acknowledge = vi.fn();
    const receipt = transactionReceipt({ finalize, acknowledge });
    const repository = new MemoryRepository();
    const owner = recoveryOwner(repository, registryFixture());
    const handoff = owner.prepareAdoption({
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-finalize-persistence",
      generation: 1,
      format: "SRT",
      directoryIdentity: DIRECTORY_IDENTITY,
    });
    owner.markBeginStarted(handoff);
    owner.adopt({
      handoff,
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-finalize-persistence",
      generation: 1,
      format: "SRT",
      direction: "rollback",
      directoryIdentity: DIRECTORY_IDENTITY,
      receipt,
      registry: { state: "reserved", reservation: "reservation-finalize" },
    });
    repository.failAfterReplace = true;

    expect(() => owner.commitActivated(handoff, "artifact-finalize")).toThrowError(
      expect.objectContaining({ code: "persistence_failed" }),
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(receipt.state).toBe("open");
    expect(repository.records[0]).toMatchObject({
      decision: "finalize_committed",
      nativeState: "pending",
    });

    repository.failAfterReplace = false;
    expect(() => owner.commitActivated(handoff, "artifact-finalize")).not.toThrow();
    owner.settleAdoption(handoff);
    expect(finalize).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(owner.listPending()).toEqual([]);
  });

  it("does not delete the durable preclaim after native begin has started", async () => {
    const repository = new MemoryRepository();
    const owner = recoveryOwner(repository, registryFixture());
    const handoff = owner.prepareAdoption({
      recoveryId: RECOVERY_ID,
      owner: OWNER,
      taskId: "task-begin-started",
      generation: 1,
      format: "SRT",
      directoryIdentity: DIRECTORY_IDENTITY,
    });

    owner.markBeginStarted(handoff);
    owner.releaseAdoption(handoff);

    expect(owner.listPending()).toEqual([
      expect.objectContaining({
        recoveryId: RECOVERY_ID,
        state: "not_started",
        requiresDirectorySelection: true,
      }),
    ]);
    expect(repository.records).toHaveLength(1);

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: "task-begin-started",
      generation: 1,
      format: "SRT",
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });
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
        acknowledge: () => ({ state: "not_found" }),
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
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
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
      decision: "rollback",
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
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
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
      decision: "rollback",
    });
  });

  it("reauthorizes and retries only acknowledgement plus repository deletion after native rollback settled", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const replace = vi.spyOn(repository, "replace");
    const replaceImplementation = replace.getMockImplementation();
    let failDeletion = true;
    replace.mockImplementation((records) => {
      if (records.length === 0 && failDeletion) {
        failDeletion = false;
        throw new LocalSubtitleOverwriteRecoveryError(
          "persistence_failed",
          "injected deletion failure",
        );
      }
      if (replaceImplementation) return replaceImplementation(records);
      repository.records = records.map((item) => Object.freeze({ ...item }));
    });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const acknowledge = vi.fn()
      .mockReturnValueOnce({ state: "acknowledged" as const })
      .mockReturnValueOnce({ state: "not_found" as const });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge,
      }),
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

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
    await expect(
      withLocalSubtitleOverwriteDirectory(directoryKey, () => "released"),
    ).resolves.toBe("released");
  });

  it("retains pending recovery when the native terminal marker is not found", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => ({ state: "not_found" }),
        acknowledge: () => ({ state: "not_found" }),
      }),
    );
    const directoryKey = localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY);

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "recovery_pending" });

    expect(owner.listPending()).toEqual([
      expect.objectContaining({ state: "retry_failed", direction: "rollback" }),
    ]);
    await expect(
      withLocalSubtitleOverwriteDirectory(directoryKey, () => undefined),
    ).rejects.toThrow("pending overwrite recovery");
    await expect(owner.shutdown("app_quit")).rejects.toMatchObject({
      code: "recovery_pending",
    });
    releaseLocalSubtitleOverwriteDirectoryFence(directoryKey, RECOVERY_ID);
  });

  it("completes a not-started rollback preclaim when native begin created no journal", async () => {
    const record = persistedRecord({
      direction: "rollback",
      nativeState: "not_started",
    });
    const repository = new MemoryRepository({ records: [record] });
    const acknowledge = vi.fn();
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => ({ state: "not_found" }),
        acknowledge,
      }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });

    expect(acknowledge).not.toHaveBeenCalled();
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("preserves not-started state across a transient recovery failure", async () => {
    const record = persistedRecord({
      direction: "rollback",
      nativeState: "not_started",
    });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn()
      .mockImplementationOnce(() => { throw new Error("transient recovery failure"); })
      .mockReturnValueOnce({ state: "not_found" as const });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "not_found" }),
      }),
    );
    const selection = {
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    } as const;

    await expect(owner.recoverAfterReauthorization(selection)).rejects.toThrow(
      "transient recovery failure",
    );
    expect(owner.listPending()).toEqual([
      expect.objectContaining({ state: "not_started" }),
    ]);

    await expect(owner.recoverAfterReauthorization(selection)).resolves.toEqual({
      state: "rolled_back",
    });
    expect(owner.listPending()).toEqual([]);
  });

  it("serializes concurrent directory selections for the same recovery", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
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
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
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
    expect(replace).toHaveBeenCalledTimes(3);
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
  });

  it("drives native finalize recovery from the durable commit decision", async () => {
    const record = persistedRecord({ direction: "finalize" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "finalized" as const }));
    const acknowledge = vi.fn(() => ({ state: "acknowledged" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge,
      }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "finalized" });

    expect(recover).toHaveBeenCalledWith({
      transactionId: RECOVERY_ID,
      directoryPath: fixtureRoot,
      expectedDirectoryIdentity: DIRECTORY_IDENTITY,
      decision: "finalize",
    });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(owner.listPending()).toEqual([]);
    expect(repository.records).toEqual([]);
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

  it("claims each branded transaction receipt only once", async () => {
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
    expect(owner.listPending()).toHaveLength(2);

    owner.retry(RECOVERY_ID);
    await expect(owner.recoverAfterReauthorization({
      recoveryId: "11234567-89ab-4cde-8fab-0123456789ab",
      taskId: "task-second-claim",
      generation: 1,
      format: "SRT",
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });
    expect(owner.listPending()).toEqual([]);
  });

  it("rejects an unbranded transaction receipt while retaining its begun preclaim", async () => {
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
    expect(owner.listPending()).toEqual([
      expect.objectContaining({ state: "not_started", direction: "rollback" }),
    ]);
    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: "task-fake-receipt",
      generation: 1,
      format: "SRT",
      directory: resolvedDirectory(fixtureRoot),
    })).resolves.toEqual({ state: "rolled_back" });
  });

  it("rejects stale task metadata before invoking native recovery", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const repository = new MemoryRepository({ records: [record] });
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      repository,
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
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
      acknowledge: () => ({ state: "not_found" }),
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

  it("rejects the impossible finalize-committed plus not-started record state", () => {
    const record = persistedRecord({
      direction: "finalize",
      nativeState: "not_started",
    });

    expect(() => new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository({ records: [record] }),
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => ({ state: "not_found" }),
        acknowledge: () => ({ state: "not_found" }),
      }),
    )).toThrowError(expect.objectContaining({ code: "invalid_record" }));
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
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => result,
        acknowledge: () => ({ state: "acknowledged" }),
      }),
    );

    await expect(owner.recoverAfterReauthorization({
      recoveryId: RECOVERY_ID,
      taskId: record.taskId,
      generation: record.generation,
      format: record.format,
      directory: resolvedDirectory(fixtureRoot),
    })).rejects.toMatchObject({ code: "invalid_result" });
    releaseLocalSubtitleOverwriteDirectoryFence(
      localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY),
      RECOVERY_ID,
    );
  });

  it("rejects and absorbs an asynchronous recovery result", async () => {
    const record = persistedRecord({ direction: "rollback" });
    const owner = new LocalSubtitleOverwriteRecoveryOwner(
      new MemoryRepository({ records: [record] }),
      registryFixture(),
      createLocalSubtitleOverwriteRecoveryAuthority({
        recover: () => Promise.reject(new Error("late failure")),
        acknowledge: () => ({ state: "acknowledged" }),
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
    releaseLocalSubtitleOverwriteDirectoryFence(
      localSubtitleOverwriteDirectoryKey(DIRECTORY_IDENTITY),
      RECOVERY_ID,
    );
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
      acknowledge: () => ({ state: "not_found" }),
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
    owner.markBeginStarted(handoff);
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
  readonly acknowledge?: () => void;
}) {
  return new LocalSubtitleOverwriteTransactionReceipt({
    expectedFinalIdentity: { dev: 4, ino: 5, birthtimeMs: 6 },
    finalize: options.finalize ?? (() => undefined),
    rollback: options.rollback ?? (() => undefined),
    acknowledge: options.acknowledge ?? (() => undefined),
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
  readonly nativeState?: LocalSubtitleOverwriteRecoveryRecord["nativeState"];
}): LocalSubtitleOverwriteRecoveryRecord {
  return Object.freeze({
    schemaVersion: 2,
    recoveryId: RECOVERY_ID,
    ownerFingerprint: "a".repeat(64),
    taskId: "task-persisted",
    generation: 3,
    format: "SRT",
    decision: overrides.direction === "finalize"
      ? "finalize_committed"
      : "rollback_unpublished",
    nativeState: overrides.nativeState ?? "pending",
    createdAt: 10,
    updatedAt: 10,
  });
}

class MemoryRepository implements LocalSubtitleOverwriteRecoveryRepository {
  records: readonly LocalSubtitleOverwriteRecoveryRecord[];
  failReplace: boolean;
  failAfterReplace: boolean;

  constructor(options: {
    readonly records?: readonly LocalSubtitleOverwriteRecoveryRecord[];
    readonly failReplace?: boolean;
    readonly failAfterReplace?: boolean;
  } = {}) {
    this.records = options.records ?? [];
    this.failReplace = options.failReplace ?? false;
    this.failAfterReplace = options.failAfterReplace ?? false;
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
    if (this.failAfterReplace) {
      throw new LocalSubtitleOverwriteRecoveryError(
        "persistence_failed",
        "injected post-replacement persistence failure",
      );
    }
  }
}
