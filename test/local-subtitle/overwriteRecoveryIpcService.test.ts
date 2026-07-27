import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import {
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type ResolvedLocalSubtitleOutputDirectory,
} from "../../electron/main/local-subtitle/authorizations";
import {
  LocalSubtitleIpcService,
  LocalSubtitleOverwriteRecoveryAdmissionCoordinator,
  type LocalSubtitleIpcHandlers,
} from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOwnerSessionRegistry } from "../../electron/main/local-subtitle/ipc-security";
import type { LocalSubtitleOverwriteRecoverySummary } from "../../electron/main/local-subtitle/overwrite-recovery-owner";

const DEV_SERVER_URL = "http://127.0.0.1:7777/";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local subtitle overwrite recovery IPC service", () => {
  it("returns non-ready failures without opening a directory picker", async () => {
    for (const status of ["unavailable", "blocked"] as const) {
      const select = vi.fn();
      const fixture = createFixture({
        overwriteRecovery: { status },
        select,
      });

      await expect(fixture.recover("recovery-1")).resolves.toMatchObject({
        ok: false,
        error: {
          code: status === "unavailable"
            ? "runtime_missing"
            : "configuration_not_ready",
        },
      });
      expect(select).not.toHaveBeenCalled();
    }
  });

  it("retries a volatile recovery without opening the picker", async () => {
    const entry = summary("recovery-volatile", false);
    const select = vi.fn();
    const retry = vi.fn(() =>
      localSubtitleIpcSuccess({
        status: "recovered" as const,
        outcome: "finalized" as const,
      }),
    );
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, retry }),
      select,
    });

    await expect(fixture.recover(entry.recoveryId)).resolves.toEqual({
      ok: true,
      data: { status: "recovered", outcome: "finalized" },
    });
    expect(retry).toHaveBeenCalledWith(
      { recoveryId: entry.recoveryId },
      entry,
      expect.objectContaining({ owner: fixture.owner }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("treats picker cancellation as success without calling recovery", async () => {
    const entry = summary("recovery-cancelled", true);
    const recover = vi.fn();
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const authorize = vi.spyOn(outputs, "authorize");
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, recover }),
      select: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      outputs,
    });

    await expect(fixture.recover(entry.recoveryId)).resolves.toEqual({
      ok: true,
      data: { status: "cancelled" },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("serializes the same recovery id across windows before picker await", async () => {
    const entry = summary("recovery-shared", true);
    const selected = deferred<{ canceled: boolean; filePaths: string[] }>();
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry }),
      select: vi.fn(() => selected.promise),
      owners: 2,
    });

    const first = fixture.recover(entry.recoveryId, 0);
    await expect(fixture.recover(entry.recoveryId, 1)).resolves.toMatchObject({
      ok: false,
      error: { code: "resource_busy" },
    });
    selected.resolve({ canceled: true, filePaths: [] });
    await expect(first).resolves.toEqual({
      ok: true,
      data: { status: "cancelled" },
    });
  });

  it("drops a picker result after owner release and never starts recovery", async () => {
    const entry = summary("recovery-released", true);
    const selected = deferred<{ canceled: boolean; filePaths: string[] }>();
    const recover = vi.fn();
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, recover }),
      select: vi.fn(() => selected.promise),
    });
    const pending = fixture.recover(entry.recoveryId);

    fixture.registry.release(fixture.ownerSessionIds[0]!);
    fixture.service.releaseOwner(fixture.ownerIdentities[0]!);
    selected.resolve({ canceled: false, filePaths: ["/private/late"] });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("invalidates an open picker during shutdown and reopens admission after shutdown failure", async () => {
    const entry = summary("recovery-shutdown-picker", true);
    const firstSelection = deferred<{ canceled: boolean; filePaths: string[] }>();
    const select = vi.fn()
      .mockImplementationOnce(() => firstSelection.promise)
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const target = {
      releaseOwner: vi.fn(),
      shutdown: vi.fn(() => Promise.reject(new Error("pending recovery"))),
    };
    const admissions = new LocalSubtitleOverwriteRecoveryAdmissionCoordinator(
      target,
    );
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry }),
      select,
      admissions,
    });
    const pendingPicker = fixture.recover(entry.recoveryId);
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());

    await expect(admissions.shutdown("update")).rejects.toThrow(
      "pending recovery",
    );
    firstSelection.resolve({ canceled: true, filePaths: [] });
    await expect(pendingPicker).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });

    await expect(fixture.recover(entry.recoveryId)).resolves.toEqual({
      ok: true,
      data: { status: "cancelled" },
    });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("drops an authorization result after shutdown invalidates its admission", async () => {
    const directoryPath = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-recovery-authorize-")),
    );
    roots.push(directoryPath);
    const entry = summary("recovery-shutdown-authorize", true);
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const continueAuthorization = deferred<void>();
    const authorize = outputs.authorize.bind(outputs);
    vi.spyOn(outputs, "authorize").mockImplementation(async (owner, selectedPath) => {
      const authorization = await authorize(owner, selectedPath);
      await continueAuthorization.promise;
      return authorization;
    });
    const revoke = vi.spyOn(outputs, "revokeDraft");
    const recover = vi.fn();
    const admissions = rejectingShutdownAdmissions();
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, recover }),
      select: vi.fn(async () => ({ canceled: false, filePaths: [directoryPath] })),
      outputs,
      admissions,
    });
    const pending = fixture.recover(entry.recoveryId);
    await vi.waitFor(() => expect(outputs.authorize).toHaveBeenCalledOnce());

    await expect(admissions.shutdown("update")).rejects.toThrow(
      "pending recovery",
    );
    continueAuthorization.resolve();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
    expect(recover).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("drops a resolved draft after shutdown invalidates its admission", async () => {
    const directoryPath = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-recovery-resolve-")),
    );
    roots.push(directoryPath);
    const entry = summary("recovery-shutdown-resolve", true);
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const continueResolution = deferred<void>();
    const resolveDraft = outputs.resolveDraft.bind(outputs);
    vi.spyOn(outputs, "resolveDraft").mockImplementation(async (owner, token) => {
      const directory = await resolveDraft(owner, token);
      await continueResolution.promise;
      return directory;
    });
    const revoke = vi.spyOn(outputs, "revokeDraft");
    const recover = vi.fn();
    const admissions = rejectingShutdownAdmissions();
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, recover }),
      select: vi.fn(async () => ({ canceled: false, filePaths: [directoryPath] })),
      outputs,
      admissions,
    });
    const pending = fixture.recover(entry.recoveryId);
    await vi.waitFor(() => expect(outputs.resolveDraft).toHaveBeenCalledOnce());

    await expect(admissions.shutdown("update")).rejects.toThrow(
      "pending recovery",
    );
    continueResolution.resolve();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
    expect(recover).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes the temporary directory draft and returns no path or token", async () => {
    const directoryPath = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-recovery-ipc-")),
    );
    roots.push(directoryPath);
    const entry = summary("recovery-directory", true);
    const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    const revoke = vi.spyOn(outputs, "revokeDraft");
    const recover = vi.fn(
      (
        _request: { readonly recoveryId: string },
        directory: ResolvedLocalSubtitleOutputDirectory,
      ) => {
        expect(directory.directoryPath).toBe(directoryPath);
        return localSubtitleIpcSuccess({
          status: "recovered" as const,
          outcome: "rolled_back" as const,
        });
      },
    );
    const fixture = createFixture({
      overwriteRecovery: readyHandlers({ entry, recover }),
      select: vi.fn(async () => ({ canceled: false, filePaths: [directoryPath] })),
      outputs,
    });

    const result = await fixture.recover(entry.recoveryId);
    expect(result).toEqual({
      ok: true,
      data: { status: "recovered", outcome: "rolled_back" },
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(directoryPath);
    expect(JSON.stringify(result)).not.toContain("outputDirToken");
  });
});

function createFixture(options: {
  readonly overwriteRecovery: NonNullable<LocalSubtitleIpcHandlers["overwriteRecovery"]>;
  readonly select: () => Promise<{ canceled: boolean; filePaths: readonly string[] }>;
  readonly outputs?: LocalSubtitleOutputDirectoryAuthorizationRegistry;
  readonly owners?: number;
  readonly admissions?: LocalSubtitleOverwriteRecoveryAdmissionCoordinator;
}) {
  const registry = new LocalSubtitleOwnerSessionRegistry({
    trustedSender: { devServerUrl: DEV_SERVER_URL },
  });
  const ownerFixtures = Array.from({ length: options.owners ?? 1 }, (_, index) => {
    const frame = new FakeFrame(30 + index);
    const sender = new FakeSender(10 + index, frame);
    frame.sender = sender;
    return { frame, sender, event: createEvent(sender, frame) };
  });
  const service = new LocalSubtitleIpcService({
    ownerSessions: registry,
    capabilities: options.outputs ? { outputs: options.outputs } : undefined,
    handlers: { overwriteRecovery: options.overwriteRecovery },
    selectOverwriteRecoveryDirectory: options.select,
    overwriteRecoveryAdmissions: options.admissions,
  });
  const ownerSessionIds = ownerFixtures.map(({ event }) => {
    const registration = service.registerOwnerSession(event, {});
    if (!registration.ok) throw new Error("Could not register test owner.");
    return (registration.data as { ownerSessionId: string }).ownerSessionId;
  });
  const ownerIdentities = ownerFixtures.map(({ event }, index) => ({
    ownerSessionId: ownerSessionIds[index]!,
    senderId: event.sender.id,
    processId: event.processId,
    frameId: event.frameId,
  }));
  const owners = ownerFixtures.map(({ event }, index) => ({
    event,
    ownerSessionId: ownerSessionIds[index]!,
  }));
  return {
    service,
    registry,
    ownerSessionIds,
    ownerIdentities,
    owner: {
      webContentsId: owners[0]!.event.sender.id,
      ownerSessionId: owners[0]!.ownerSessionId,
    },
    recover: (recoveryId: string, ownerIndex = 0) => {
      const selectedOwner = owners[ownerIndex]!;
      return service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite,
        selectedOwner.event,
        {
          ownerSessionId: selectedOwner.ownerSessionId,
          payload: { recoveryId },
        },
      );
    },
  };
}

function readyHandlers(options: {
  readonly entry: LocalSubtitleOverwriteRecoverySummary;
  readonly retry?: NonNullable<Extract<LocalSubtitleIpcHandlers["overwriteRecovery"], { status: "ready" }>["retry"]>;
  readonly recover?: NonNullable<Extract<LocalSubtitleIpcHandlers["overwriteRecovery"], { status: "ready" }>["recover"]>;
}): Extract<LocalSubtitleIpcHandlers["overwriteRecovery"], { status: "ready" }> {
  return {
    status: "ready",
    describe: () => localSubtitleIpcSuccess(options.entry),
    retry: options.retry ?? vi.fn(),
    recover: options.recover ?? vi.fn(),
  };
}

function summary(
  recoveryId: string,
  requiresDirectorySelection: boolean,
): LocalSubtitleOverwriteRecoverySummary {
  return {
    recoveryId,
    displayCode: "ABCDEF123456",
    taskId: `task-${recoveryId}`,
    generation: 1,
    format: "SRT",
    direction: requiresDirectorySelection ? "rollback" : "finalize",
    state: "pending",
    createdAt: 1,
    requiresDirectorySelection,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rejectingShutdownAdmissions() {
  return new LocalSubtitleOverwriteRecoveryAdmissionCoordinator({
    releaseOwner: vi.fn(),
    shutdown: vi.fn(() => Promise.reject(new Error("pending recovery"))),
  });
}

function createEvent(sender: FakeSender, frame: FakeFrame) {
  return {
    sender,
    senderFrame: frame,
    processId: frame.processId,
    frameId: frame.routingId,
  } as never;
}

class FakeFrame extends EventEmitter {
  readonly processId = 20;
  readonly url = `${DEV_SERVER_URL}#/tools/subtitle/local-transcriber`;
  readonly parent = null;
  readonly detached = false;
  destroyed = false;
  sender?: FakeSender;
  readonly send = vi.fn();

  constructor(readonly routingId: number) {
    super();
  }

  isDestroyed() {
    return this.destroyed;
  }
}

class FakeSender extends EventEmitter {
  destroyed = false;

  constructor(
    readonly id: number,
    readonly mainFrame: FakeFrame,
  ) {
    super();
  }

  isDestroyed() {
    return this.destroyed;
  }
}
