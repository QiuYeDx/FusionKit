import { describe, expect, it, vi } from "vitest";
import type { LocalSubtitleOverwriteRecoverySummary } from "@/type/localSubtitleIpc";
import {
  LocalSubtitleOverwriteRecoveryService,
  type LocalSubtitleOverwriteRecoveryRendererApi,
} from "./localSubtitleOverwriteRecoveryService";

describe("local subtitle overwrite recovery service", () => {
  it("loads every page, strips unrelated metadata, and coalesces refreshes", async () => {
    const firstPage = deferred<ReturnType<typeof ready>>();
    const api = createApi();
    api.listOverwriteRecoveries
      .mockImplementationOnce(() => firstPage.promise)
      .mockResolvedValueOnce(
        ready([item("recovery-2", { createdAt: 2 })]),
      );
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });

    const one = service.refresh();
    const two = service.refresh();
    expect(one).toBe(two);
    const sourceItem = {
      ...item("recovery-1", { createdAt: 1 }),
      outputPath: "/private/output",
    };
    firstPage.resolve(
      ready([sourceItem], { createdAt: 1, recoveryId: "recovery-1" }),
    );

    await expect(one).resolves.toBe(true);
    expect(api.listOverwriteRecoveries.mock.calls).toEqual([
      [undefined],
      [{ after: { createdAt: 1, recoveryId: "recovery-1" } }],
    ]);
    expect(service.getState()).toMatchObject({
      availability: "ready",
      refreshing: false,
      items: [
        { recoveryId: "recovery-1" },
        { recoveryId: "recovery-2" },
      ],
    });
    expect(JSON.stringify(service.getState())).not.toMatch(
      /private-task|private\/output|outputPath/,
    );
  });

  it("keeps every schema-valid repository page reachable", async () => {
    const api = createApi();
    for (let page = 0; page < 42; page += 1) {
      const recoveryId = `recovery-${String(page).padStart(2, "0")}`;
      api.listOverwriteRecoveries.mockResolvedValueOnce(
        ready(
          [item(recoveryId, { createdAt: page })],
          page < 41 ? { createdAt: page, recoveryId } : undefined,
        ),
      );
    }
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });

    await expect(service.refresh()).resolves.toBe(true);
    expect(api.listOverwriteRecoveries).toHaveBeenCalledTimes(42);
    expect(service.getState().items).toHaveLength(42);
    expect(service.getState().queryErrorCode).toBeNull();
  });

  it("runs a trailing refresh after an in-flight query for a task failure event", async () => {
    const firstPage = deferred<ReturnType<typeof ready>>();
    const api = createApi();
    api.listOverwriteRecoveries
      .mockImplementationOnce(() => firstPage.promise)
      .mockResolvedValueOnce(ready([item("recovery-after-event")]));
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });

    const initial = service.refresh();
    const trailing = service.refreshAfterCurrent();
    firstPage.resolve(ready([]));

    await expect(initial).resolves.toBe(true);
    await expect(trailing).resolves.toBe(true);
    expect(api.listOverwriteRecoveries).toHaveBeenCalledTimes(2);
    expect(service.getState().items).toEqual([
      expect.objectContaining({ recoveryId: "recovery-after-event" }),
    ]);
  });

  it("keeps cancelled recovery pending and refreshes afterward", async () => {
    const api = createApi();
    api.listOverwriteRecoveries.mockResolvedValue(
      ready([item("recovery-1")]),
    );
    api.recoverOverwrite.mockResolvedValue({
      ok: true,
      data: { status: "cancelled" },
    });
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });
    await service.refresh();

    await expect(service.recover("recovery-1")).resolves.toEqual({
      kind: "cancelled",
    });

    expect(api.listOverwriteRecoveries).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({
      items: [{ recoveryId: "recovery-1" }],
      actionRecoveryId: null,
      feedback: { kind: "cancelled" },
    });
  });

  it("removes a recovered item before the mandatory refresh completes", async () => {
    const refreshAfterRecovery = deferred<ReturnType<typeof ready>>();
    const api = createApi();
    api.listOverwriteRecoveries
      .mockResolvedValueOnce(ready([item("recovery-1")]))
      .mockImplementationOnce(() => refreshAfterRecovery.promise);
    api.recoverOverwrite.mockResolvedValue({
      ok: true,
      data: { status: "recovered", outcome: "finalized" },
    });
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });
    await service.refresh();

    const recovery = service.recover("recovery-1");
    await vi.waitFor(() => expect(service.getState().items).toEqual([]));
    expect(service.getState().actionRecoveryId).toBe("recovery-1");
    refreshAfterRecovery.resolve(ready([]));

    await expect(recovery).resolves.toEqual({
      kind: "recovered",
      outcome: "finalized",
    });
    expect(service.getState()).toMatchObject({
      actionRecoveryId: null,
      feedback: { kind: "recovered", outcome: "finalized" },
    });
  });

  it("runs a fresh post-recovery query after an overlapping focus refresh", async () => {
    const overlappingRefresh = deferred<ReturnType<typeof ready>>();
    const api = createApi();
    api.listOverwriteRecoveries
      .mockResolvedValueOnce(ready([item("recovery-1")]))
      .mockImplementationOnce(() => overlappingRefresh.promise)
      .mockResolvedValueOnce(ready([]));
    const recoveryResult = deferred<{
      ok: true;
      data: { status: "recovered"; outcome: "rolled_back" };
    }>();
    api.recoverOverwrite.mockImplementationOnce(() => recoveryResult.promise);
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });
    await service.refresh();

    const recovery = service.recover("recovery-1");
    const focusRefresh = service.refresh();
    recoveryResult.resolve({
      ok: true,
      data: { status: "recovered", outcome: "rolled_back" },
    });
    overlappingRefresh.resolve(ready([item("recovery-1")]));

    await focusRefresh;
    await recovery;
    expect(api.listOverwriteRecoveries).toHaveBeenCalledTimes(3);
    expect(service.getState().items).toEqual([]);
  });

  it("deduplicates a recovery action and retains stable error codes", async () => {
    const pending = deferred<{
      ok: false;
      error: ReturnType<typeof ipcError>;
    }>();
    const api = createApi();
    api.listOverwriteRecoveries.mockResolvedValue(
      ready([item("recovery-1")]),
    );
    api.recoverOverwrite.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });
    await service.refresh();

    const one = service.recover("recovery-1");
    const two = service.recover("recovery-1");
    expect(one).toBe(two);
    pending.resolve({ ok: false, error: ipcError("recovery_pending") });

    await expect(one).resolves.toEqual({
      kind: "error",
      code: "recovery_pending",
    });
    expect(api.recoverOverwrite).toHaveBeenCalledOnce();
    expect(api.listOverwriteRecoveries).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({
      feedback: { kind: "error", code: "recovery_pending" },
    });
  });

  it("represents blocked, unavailable, and list failures without persisting data", async () => {
    const api = createApi();
    api.listOverwriteRecoveries
      .mockResolvedValueOnce({ ok: true, data: { status: "blocked" } })
      .mockResolvedValueOnce({ ok: true, data: { status: "unavailable" } })
      .mockResolvedValueOnce({
        ok: false,
        error: ipcError("invalid_content"),
      });
    const service = new LocalSubtitleOverwriteRecoveryService({
      getApi: () => api,
    });

    await service.refresh();
    expect(service.getState().availability).toBe("blocked");
    await service.refresh();
    expect(service.getState().availability).toBe("unavailable");
    await service.refresh();
    expect(service.getState()).toMatchObject({
      availability: "error",
      queryErrorCode: "invalid_content",
    });
  });
});

function createApi() {
  return {
    listOverwriteRecoveries: vi.fn<
      LocalSubtitleOverwriteRecoveryRendererApi["listOverwriteRecoveries"]
    >(),
    recoverOverwrite: vi.fn<
      LocalSubtitleOverwriteRecoveryRendererApi["recoverOverwrite"]
    >(),
  };
}

function item(
  recoveryId: string,
  overrides: Partial<ReturnType<typeof itemBase>> = {},
) {
  return { ...itemBase(recoveryId), ...overrides };
}

function itemBase(recoveryId: string) {
  return {
    recoveryId,
    displayCode: "ABCDEF123456",
    taskId: "private-task",
    generation: 1,
    format: "SRT" as const,
    direction: "finalize" as const,
    state: "pending" as const,
    createdAt: 1,
    requiresDirectorySelection: true,
  };
}

function ready(
  items: LocalSubtitleOverwriteRecoverySummary[],
  nextCursor?: { readonly createdAt: number; readonly recoveryId: string },
) {
  return {
    ok: true as const,
    data: {
      status: "ready" as const,
      items,
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

function ipcError(code: string) {
  return {
    code,
    message: "stable error",
    stage: "ipc",
    retryable: false,
  } as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
