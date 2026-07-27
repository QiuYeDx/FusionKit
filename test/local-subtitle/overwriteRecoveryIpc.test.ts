import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  type LocalSubtitleIpcResult,
} from "@/type/localSubtitleIpc";
import type { LocalSubtitleIpcHandlerContext } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOverwriteRecoveryIpcBridge } from "../../electron/main/local-subtitle/overwrite-recovery-ipc";
import type { LocalSubtitleOverwriteProductionRuntime } from "../../electron/main/local-subtitle/overwrite-production-runtime-core";
import {
  LocalSubtitleOverwriteRecoveryError,
  type LocalSubtitleOverwriteRecoverySummary,
} from "../../electron/main/local-subtitle/overwrite-recovery-owner";

const CONTEXT = {
  owner: { webContentsId: 7, ownerSessionId: "owner_session_1234567890" },
} as LocalSubtitleIpcHandlerContext;
const DIRECTORY = {
  directoryPath: "/private/output",
  directoryName: "output",
  identity: { platform: "posix", dev: 1, ino: 2 },
  expiresAt: 10_000,
} as never;

describe("local subtitle overwrite recovery IPC bridge", () => {
  it.each(["unavailable", "blocked"] as const)(
    "reports app-scoped %s status without fabricating an empty ready list",
    async (status) => {
      const bridge = new LocalSubtitleOverwriteRecoveryIpcBridge({
        status,
        reason: status === "unavailable"
          ? "native_resource_unavailable"
          : "recovery_state_unavailable",
        lifecycleTarget: {},
      } as unknown as LocalSubtitleOverwriteProductionRuntime<unknown>);

      await expect(list(bridge, {})).resolves.toEqual({
        ok: true,
        data: { status },
      });
      expect(bridge.handlers.overwriteRecovery).toEqual({ status });
    },
  );

  it("paginates path-free summaries with a stable tuple cursor", async () => {
    const entries = [summary("recovery-a", 1), summary("recovery-b", 1), summary("recovery-c", 2)];
    const bridge = readyBridge({ entries });
    const otherWindow = {
      ...CONTEXT,
      owner: { webContentsId: 8, ownerSessionId: "owner_session_abcdefghij" },
    } as LocalSubtitleIpcHandlerContext;

    await expect(list(bridge, { limit: 2 })).resolves.toEqual({
      ok: true,
      data: {
        status: "ready",
        items: entries.slice(0, 2),
        nextCursor: { createdAt: 1, recoveryId: "recovery-b" },
      },
    });
    await expect(
      list(bridge, {
        after: { createdAt: 1, recoveryId: "recovery-b" },
        limit: 2,
      }),
    ).resolves.toEqual({
      ok: true,
      data: { status: "ready", items: entries.slice(2) },
    });
    await expect(list(bridge, { limit: 2 }, otherWindow)).resolves.toEqual(
      await list(bridge, { limit: 2 }, CONTEXT),
    );
    expect(JSON.stringify(await list(bridge, {}))).not.toContain("/private/");
  });

  it("retries an in-process recovery without requiring a directory", async () => {
    const entry = summary("recovery-retry", 1, false, "finalize");
    const retry = vi.fn();
    const bridge = readyBridge({ entries: [entry], retry });
    const recovery = requireReady(bridge);

    expect(recovery.describe({ recoveryId: entry.recoveryId }, CONTEXT))
      .toEqual({ ok: true, data: entry });
    expect(recovery.retry({ recoveryId: entry.recoveryId }, entry, CONTEXT))
      .toEqual({
      ok: true,
      data: { status: "recovered", outcome: "finalized" },
    });
    expect(retry).toHaveBeenCalledWith(entry.recoveryId);
  });

  it("rechecks the complete summary tuple after directory selection", async () => {
    const selected = summary("recovery-drift", 1);
    const changed = { ...selected, state: "settled" as const };
    let entries: readonly LocalSubtitleOverwriteRecoverySummary[] = [selected];
    const recoverAfterReauthorization = vi.fn();
    const bridge = readyBridge({
      getEntries: () => entries,
      recoverAfterReauthorization,
    });
    const recovery = requireReady(bridge);
    const described = await recovery.describe(
      { recoveryId: selected.recoveryId },
      CONTEXT,
    );
    if (!described.ok) throw new Error("Expected recovery description.");
    entries = [changed];

    await expect(
      recovery.recover(
        { recoveryId: selected.recoveryId },
        DIRECTORY,
        described.data,
        CONTEXT,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "resource_busy" },
    });
    expect(recoverAfterReauthorization).not.toHaveBeenCalled();
  });

  it("passes only authoritative metadata and maps private failures", async () => {
    const entry = summary("recovery-private", 4);
    const recoverAfterReauthorization = vi.fn(() => {
      throw new LocalSubtitleOverwriteRecoveryError(
        "recovery_pending",
        "private journal at /private/output",
      );
    });
    const bridge = readyBridge({ entries: [entry], recoverAfterReauthorization });
    const recovery = requireReady(bridge);
    const result = await recovery.recover(
      { recoveryId: entry.recoveryId },
      DIRECTORY,
      entry,
      CONTEXT,
    );

    expect(recoverAfterReauthorization).toHaveBeenCalledWith({
      owner: CONTEXT.owner,
      recoveryId: entry.recoveryId,
      taskId: entry.taskId,
      generation: entry.generation,
      format: entry.format,
      directory: DIRECTORY,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "output_write_failed", stage: "exporting" },
    });
    expect(JSON.stringify(result)).not.toContain("/private/output");
  });

  it("maps an expired temporary directory authorization without invoking another picker", async () => {
    const entry = summary("recovery-expired", 5);
    const recoverAfterReauthorization = vi.fn(() => {
      throw new LocalSubtitleOverwriteRecoveryError(
        "authorization_expired",
        "temporary directory authorization expired",
      );
    });
    const bridge = readyBridge({ entries: [entry], recoverAfterReauthorization });
    const recovery = requireReady(bridge);

    await expect(recovery.recover(
      { recoveryId: entry.recoveryId },
      DIRECTORY,
      entry,
      CONTEXT,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_expired", stage: "exporting" },
    });
  });
});

function readyBridge(options: {
  readonly entries?: readonly LocalSubtitleOverwriteRecoverySummary[];
  readonly getEntries?: () => readonly LocalSubtitleOverwriteRecoverySummary[];
  readonly retry?: (recoveryId: string) => void;
  readonly recoverAfterReauthorization?: (options: unknown) => unknown;
}) {
  const recoveryOwner = {
    listPending: () => options.getEntries?.() ?? options.entries ?? [],
    retry: options.retry ?? vi.fn(),
    recoverAfterReauthorization:
      options.recoverAfterReauthorization ??
      vi.fn(() => ({ state: "rolled_back" as const })),
  };
  return new LocalSubtitleOverwriteRecoveryIpcBridge({
    status: "ready",
    recoveryOwner,
  } as unknown as LocalSubtitleOverwriteProductionRuntime<unknown>);
}

async function list(
  bridge: LocalSubtitleOverwriteRecoveryIpcBridge,
  request: unknown,
  context = CONTEXT,
): Promise<LocalSubtitleIpcResult<unknown>> {
  const handler = bridge.handlers.public?.[
    LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries
  ];
  if (!handler) throw new Error("Missing list recovery handler.");
  return await handler(request, context);
}

function requireReady(bridge: LocalSubtitleOverwriteRecoveryIpcBridge) {
  const recovery = bridge.handlers.overwriteRecovery;
  if (!recovery || recovery.status !== "ready") {
    throw new Error("Expected ready recovery bridge.");
  }
  return recovery;
}

function summary(
  recoveryId: string,
  createdAt: number,
  requiresDirectorySelection = true,
  direction: "finalize" | "rollback" = "rollback",
): LocalSubtitleOverwriteRecoverySummary {
  return {
    recoveryId,
    displayCode: "ABCDEF123456",
    taskId: `task-${recoveryId}`,
    generation: 1,
    format: "SRT",
    direction,
    state: "pending",
    createdAt,
    requiresDirectorySelection,
  };
}
