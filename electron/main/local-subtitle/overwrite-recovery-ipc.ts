import { createLocalSubtitleError } from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_OVERWRITE_RECOVERY_PAGE_LIMIT,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
  type LocalSubtitleIpcResult,
  type LocalSubtitleListOverwriteRecoveriesRequest,
  type LocalSubtitleOverwriteRecoveryCursor,
} from "@/type/localSubtitleIpc";
import type { ResolvedLocalSubtitleOutputDirectory } from "./authorizations";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
} from "./ipc";
import type { LocalSubtitleOverwriteProductionRuntime } from "./overwrite-production-runtime-core";
import {
  LocalSubtitleOverwriteRecoveryError,
  type LocalSubtitleOverwriteRecoverySummary,
} from "./overwrite-recovery-owner";

export class LocalSubtitleOverwriteRecoveryIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;

  constructor(runtime: LocalSubtitleOverwriteProductionRuntime<unknown>) {
    if (!runtime || typeof runtime !== "object") {
      throw new TypeError("The overwrite recovery IPC runtime is invalid.");
    }

    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries]: (
          request: unknown,
        ) => {
          if (runtime.status === "unavailable") {
            return localSubtitleIpcSuccess({ status: "unavailable" as const });
          }
          if (runtime.status === "blocked") {
            return localSubtitleIpcSuccess({ status: "blocked" as const });
          }
          return localSubtitleIpcSuccess(
            pageRecoveries(
              runtime.recoveryOwner.listPending(),
              request as LocalSubtitleListOverwriteRecoveriesRequest,
            ),
          );
        },
      }),
      overwriteRecovery: runtime.status === "ready"
        ? Object.freeze({
            status: "ready" as const,
            describe: (request: { readonly recoveryId: string }) => {
              const summary = findRecovery(
                runtime.recoveryOwner.listPending(),
                request.recoveryId,
              );
              return summary
                ? localSubtitleIpcSuccess(summary)
                : invalidRecoveryFailure();
            },
            retry: (
              request: { readonly recoveryId: string },
              expected: LocalSubtitleOverwriteRecoverySummary,
            ): LocalSubtitleIpcResult<unknown> => {
              const summary = findRecovery(
                runtime.recoveryOwner.listPending(),
                request.recoveryId,
              );
              if (
                !summary ||
                !sameRecoverySummary(summary, expected) ||
                summary.requiresDirectorySelection
              ) {
                return recoveryBusyFailure();
              }
              try {
                runtime.recoveryOwner.retry(summary.recoveryId);
                return localSubtitleIpcSuccess({
                  status: "recovered" as const,
                  outcome: terminalOutcome(summary),
                });
              } catch (error) {
                return mapRecoveryFailure(error);
              }
            },
            recover: async (
              request: { readonly recoveryId: string },
              directory: ResolvedLocalSubtitleOutputDirectory,
              expected: LocalSubtitleOverwriteRecoverySummary,
              context: LocalSubtitleIpcHandlerContext,
            ): Promise<LocalSubtitleIpcResult<unknown>> => {
              const summary = findRecovery(
                runtime.recoveryOwner.listPending(),
                request.recoveryId,
              );
              if (
                !summary ||
                !sameRecoverySummary(summary, expected) ||
                !summary.requiresDirectorySelection
              ) {
                return recoveryBusyFailure();
              }
              try {
                const result = await runtime.recoveryOwner
                  .recoverAfterReauthorization({
                    owner: context.owner,
                    recoveryId: summary.recoveryId,
                    taskId: summary.taskId,
                    generation: summary.generation,
                    format: summary.format,
                    directory,
                  });
                if (
                  result.state !== "finalized" &&
                  result.state !== "rolled_back"
                ) {
                  return invalidRecoveryResultFailure();
                }
                return localSubtitleIpcSuccess({
                  status: "recovered" as const,
                  outcome: result.state,
                });
              } catch (error) {
                return mapRecoveryFailure(error);
              }
            },
          })
        : Object.freeze({ status: runtime.status }),
    });
  }
}

function pageRecoveries(
  entries: readonly LocalSubtitleOverwriteRecoverySummary[],
  request: LocalSubtitleListOverwriteRecoveriesRequest,
) {
  const limit = request.limit ?? LOCAL_SUBTITLE_OVERWRITE_RECOVERY_PAGE_LIMIT;
  const eligible = request.after
    ? entries.filter((entry) => isAfter(entry, request.after!))
    : entries;
  const items = eligible.slice(0, limit);
  const last = items.at(-1);
  return {
    status: "ready" as const,
    items,
    ...(last && eligible.length > items.length
      ? {
          nextCursor: {
            createdAt: last.createdAt,
            recoveryId: last.recoveryId,
          },
        }
      : {}),
  };
}

function findRecovery(
  entries: readonly LocalSubtitleOverwriteRecoverySummary[],
  recoveryId: string,
): LocalSubtitleOverwriteRecoverySummary | undefined {
  return entries.find((entry) => entry.recoveryId === recoveryId);
}

function sameRecoverySummary(
  left: LocalSubtitleOverwriteRecoverySummary,
  right: LocalSubtitleOverwriteRecoverySummary,
): boolean {
  return left.recoveryId === right.recoveryId &&
    left.displayCode === right.displayCode &&
    left.taskId === right.taskId &&
    left.generation === right.generation &&
    left.format === right.format &&
    left.direction === right.direction &&
    left.state === right.state &&
    left.createdAt === right.createdAt &&
    left.requiresDirectorySelection === right.requiresDirectorySelection;
}

function terminalOutcome(
  summary: LocalSubtitleOverwriteRecoverySummary,
): "finalized" | "rolled_back" {
  return summary.direction === "finalize" ? "finalized" : "rolled_back";
}

function isAfter(
  entry: LocalSubtitleOverwriteRecoverySummary,
  cursor: LocalSubtitleOverwriteRecoveryCursor,
): boolean {
  return entry.createdAt > cursor.createdAt ||
    (entry.createdAt === cursor.createdAt &&
      entry.recoveryId.localeCompare(cursor.recoveryId) > 0);
}

function mapRecoveryFailure(error: unknown): LocalSubtitleIpcResult<never> {
  if (!(error instanceof LocalSubtitleOverwriteRecoveryError)) {
    return invalidRecoveryResultFailure();
  }
  switch (error.code) {
    case "authorization_expired":
      return localSubtitleIpcFailure(
        createLocalSubtitleError(
          "authorization_expired",
          "The overwrite recovery directory authorization expired.",
          { stage: "exporting" },
        ),
      );
    case "invalid_request":
      return invalidRecoveryFailure();
    case "invalid_state":
      return recoveryUnavailableFailure();
    case "persistence_failed":
    case "recovery_pending":
      return localSubtitleIpcFailure(
        createLocalSubtitleError(
          "output_write_failed",
          "Overwrite recovery remains pending.",
          { stage: "exporting" },
        ),
      );
    case "invalid_result":
      return invalidRecoveryResultFailure();
    case "invalid_authority":
    case "invalid_record":
      return recoveryUnavailableFailure();
  }
}

function recoveryUnavailableFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "configuration_not_ready",
      "Overwrite recovery is unavailable.",
    ),
  );
}

function invalidRecoveryResultFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "invalid_content",
      "Overwrite recovery returned an invalid result.",
      { stage: "ipc" },
    ),
  );
}

function invalidRecoveryFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "invalid_ipc_request",
      "The overwrite recovery request is invalid.",
      { field: "recoveryId" },
    ),
  );
}

function recoveryBusyFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "resource_busy",
      "Overwrite recovery is already in progress.",
    ),
  );
}
