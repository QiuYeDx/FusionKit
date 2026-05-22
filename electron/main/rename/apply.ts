import { promises as fs } from "fs";
import path from "path";
import { validateRenamePlan } from "./planner-validation";
import {
  createRenameJournal,
  finishRenameJournal,
  isRollbackableStatus,
  readRenameJournal,
  updateJournalOperation,
  type RenameJournalOptions,
} from "./journal";
import {
  getPathDepth,
  rewritePathPrefix,
} from "./path-utils";
import type {
  ApplyRenamePlanParams,
  NameTranslationApplyResult,
  NameTranslationPlanItem,
  RenameJournalOperation,
  RollbackRenameJournalParams,
  RollbackRenameJournalResult,
} from "./types";

export class RenamePlanValidationError extends Error {
  constructor(public readonly validationErrors: Awaited<ReturnType<typeof validateRenamePlan>>["errors"]) {
    super("Rename plan validation failed.");
    this.name = "RenamePlanValidationError";
  }
}

export interface ApplyRenamePlanOptions extends RenameJournalOptions {
  rename?: (from: string, to: string) => Promise<void>;
}

interface RenameOperation {
  item: NameTranslationPlanItem;
  kind: "file" | "directory";
  originalPath: string;
  finalPath: string;
  sourceRewritePath: string;
  currentSource: string;
  currentTemp?: string;
}

export async function applyRenamePlan(
  params: ApplyRenamePlanParams,
  options: ApplyRenamePlanOptions = {}
): Promise<NameTranslationApplyResult> {
  const validation = await validateRenamePlan(params);
  if (!validation.valid) {
    throw new RenamePlanValidationError(validation.errors);
  }

  const startedAt = Date.now();
  const rename = options.rename ?? fs.rename;
  const readyItems = params.items.filter((item) => item.status === "ready");
  const skippedCount = params.items.length - readyItems.length;
  const operations = createRenameOperations(readyItems);
  rewriteFinalTargetsForDirectoryRenames(operations);

  const journal = await createRenameJournal(
    params.plan,
    operations.map((operation) => ({
      itemId: operation.item.id,
      kind: operation.kind,
      originalPath: operation.originalPath,
      finalPath: operation.finalPath,
    })),
    options
  );

  const failures: NameTranslationApplyResult["failures"] = [];

  try {
    await runStageOne(operations, params.plan.planId, journal.journalId, rename, options);
    await runStageTwo(operations, journal.journalId, rename, options);
    await finishRenameJournal(journal.journalId, "completed", options);
  } catch (error) {
    const failedOperation = error instanceof RenameOperationError ? error.operation : null;
    const failedItem = failedOperation?.item;
    if (failedOperation && failedItem) {
      await updateJournalOperation(
        journal.journalId,
        failedItem.id,
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        options
      );
      failures.push({
        itemId: failedItem.id,
        sourcePath: failedOperation.currentTemp ?? failedOperation.currentSource,
        targetPath: failedOperation.finalPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await finishRenameJournal(journal.journalId, "failed", options);
  }

  const finishedJournal = await readRenameJournal(journal.journalId, options);
  const successCount =
    finishedJournal?.operations.filter((operation) => operation.status === "final_done")
      .length ?? 0;

  return {
    planId: params.plan.planId,
    journalId: journal.journalId,
    startedAt,
    finishedAt: Date.now(),
    totalCount: params.items.length,
    successCount,
    failedCount: failures.length,
    skippedCount,
    failures,
  };
}

export async function rollbackRenameJournal(
  params: RollbackRenameJournalParams,
  options: ApplyRenamePlanOptions = {}
): Promise<RollbackRenameJournalResult> {
  const journal = await readRenameJournal(params.journalId, options);
  if (!journal) throw new Error(`Rename journal not found: ${params.journalId}`);

  const rename = options.rename ?? fs.rename;
  const operations = journal.operations
    .filter((operation) => isRollbackableStatus(operation.status))
    .map((operation) => ({ ...operation }));
  sortRollbackOperations(operations);

  const failures: RollbackRenameJournalResult["failures"] = [];
  let successCount = 0;

  for (const operation of operations) {
    const currentPath =
      operation.status === "final_done" ? operation.finalPath : operation.tempPath;

    if (!currentPath) {
      failures.push({
        itemId: operation.itemId,
        path: operation.originalPath,
        error: "Rollback source path is missing from journal.",
      });
      continue;
    }

    try {
      await assertPathExists(currentPath);
      await rename(currentPath, operation.originalPath);
      await updateJournalOperation(
        journal.journalId,
        operation.itemId,
        { status: "rolled_back" },
        options
      );
      successCount++;

      if (operation.kind === "directory") {
        await rewriteRollbackOperationPaths(
          operations,
          operation,
          currentPath,
          operation.originalPath,
          journal.journalId,
          options
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateJournalOperation(
        journal.journalId,
        operation.itemId,
        { status: "rollback_blocked", error: message },
        options
      );
      failures.push({
        itemId: operation.itemId,
        path: currentPath,
        error: message,
      });
    }
  }

  await finishRenameJournal(
    journal.journalId,
    failures.length === 0 ? "rolled_back" : "failed",
    options
  );

  return {
    journalId: journal.journalId,
    successCount,
    failedCount: failures.length,
    failures,
  };
}

async function runStageOne(
  operations: RenameOperation[],
  planId: string,
  journalId: string,
  rename: NonNullable<ApplyRenamePlanOptions["rename"]>,
  options: RenameJournalOptions
): Promise<void> {
  const orderedOperations = [...operations].sort(compareStageOne);

  for (const operation of orderedOperations) {
    const from = operation.currentSource;
    const tempPath = await createUniqueTempPath(
      path.dirname(from),
      planId,
      operation.item.id
    );

    try {
      await rename(from, tempPath);
    } catch (error) {
      throw new RenameOperationError(operation, error);
    }

    operation.currentSource = tempPath;
    operation.currentTemp = tempPath;
    await updateJournalOperation(
      journalId,
      operation.item.id,
      { tempPath, status: "temp_done" },
      options
    );

    if (operation.kind === "directory") {
      await rewriteOperationCurrentPaths(
        operations,
        operation,
        from,
        tempPath,
        journalId,
        options
      );
    }
  }
}

async function runStageTwo(
  operations: RenameOperation[],
  journalId: string,
  rename: NonNullable<ApplyRenamePlanOptions["rename"]>,
  options: RenameJournalOptions
): Promise<void> {
  const orderedOperations = [...operations].sort(compareStageTwo);

  for (const operation of orderedOperations) {
    const from = operation.currentTemp;
    const to = operation.finalPath;
    if (!from) {
      throw new RenameOperationError(
        operation,
        new Error(`Temporary path is missing for ${operation.item.id}`)
      );
    }

    try {
      await rename(from, to);
    } catch (error) {
      throw new RenameOperationError(operation, error);
    }

    operation.currentTemp = to;
    operation.currentSource = to;
    await updateJournalOperation(
      journalId,
      operation.item.id,
      { finalPath: to, status: "final_done" },
      options
    );

    if (operation.kind === "directory") {
      await rewriteOperationCurrentPaths(
        operations,
        operation,
        from,
        to,
        journalId,
        options
      );
    }
  }
}

function createRenameOperations(items: NameTranslationPlanItem[]): RenameOperation[] {
  return items.map((item) => ({
    item,
    kind: item.kind,
    originalPath: item.sourcePath,
    finalPath: item.targetPath,
    sourceRewritePath: item.sourcePath,
    currentSource: item.sourcePath,
  }));
}

function rewriteFinalTargetsForDirectoryRenames(
  operations: RenameOperation[]
): void {
  const directoryOperations = operations
    .filter((operation) => operation.kind === "directory")
    .sort((a, b) => getPathDepth(a.sourceRewritePath) - getPathDepth(b.sourceRewritePath));

  for (const directoryOperation of directoryOperations) {
    const oldPrefix = directoryOperation.sourceRewritePath;
    const newPrefix = directoryOperation.finalPath;

    for (const operation of operations) {
      if (operation === directoryOperation) continue;
      operation.finalPath =
        rewritePathPrefix(operation.finalPath, oldPrefix, newPrefix) ??
        operation.finalPath;
      operation.sourceRewritePath =
        rewritePathPrefix(operation.sourceRewritePath, oldPrefix, newPrefix) ??
        operation.sourceRewritePath;
    }
  }
}

async function rewriteOperationCurrentPaths(
  operations: RenameOperation[],
  movedOperation: RenameOperation,
  oldPrefix: string,
  newPrefix: string,
  journalId: string,
  options: RenameJournalOptions
): Promise<void> {
  for (const operation of operations) {
    if (operation === movedOperation) continue;

    const nextSource = rewritePathPrefix(operation.currentSource, oldPrefix, newPrefix);
    if (nextSource) operation.currentSource = nextSource;

    const nextTemp = rewritePathPrefix(operation.currentTemp, oldPrefix, newPrefix);
    if (nextTemp && nextTemp !== operation.currentTemp) {
      operation.currentTemp = nextTemp;
      await updateJournalOperation(
        journalId,
        operation.item.id,
        { tempPath: nextTemp },
        options
      );
    }
  }
}

async function rewriteRollbackOperationPaths(
  operations: RenameJournalOperation[],
  movedOperation: RenameJournalOperation,
  oldPrefix: string,
  newPrefix: string,
  journalId: string,
  options: RenameJournalOptions
): Promise<void> {
  for (const operation of operations) {
    if (operation.itemId === movedOperation.itemId) continue;

    const nextFinalPath = rewritePathPrefix(
      operation.finalPath,
      oldPrefix,
      newPrefix
    );
    const nextTempPath = rewritePathPrefix(operation.tempPath, oldPrefix, newPrefix);
    const finalPathChanged =
      typeof nextFinalPath === "string" && nextFinalPath !== operation.finalPath;
    const tempPathChanged =
      typeof nextTempPath === "string" && nextTempPath !== operation.tempPath;

    if (finalPathChanged) operation.finalPath = nextFinalPath;
    if (tempPathChanged) operation.tempPath = nextTempPath;

    if (finalPathChanged || tempPathChanged) {
      await updateJournalOperation(
        journalId,
        operation.itemId,
        {
          ...(finalPathChanged ? { finalPath: nextFinalPath } : {}),
          ...(tempPathChanged ? { tempPath: nextTempPath } : {}),
        },
        options
      );
    }
  }
}

async function createUniqueTempPath(
  parentPath: string,
  planId: string,
  itemId: string
): Promise<string> {
  const safePlanId = planId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-24);
  const safeItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-16);

  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = path.join(
      parentPath,
      `.fusionkit-renaming-${safePlanId}-${safeItemId}${suffix}.tmp`
    );

    try {
      await fs.lstat(candidate);
    } catch {
      return candidate;
    }
  }

  throw new Error(`Unable to allocate temporary rename path in ${parentPath}`);
}

function compareStageOne(left: RenameOperation, right: RenameOperation): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  if (left.kind === "directory") {
    return getPathDepth(right.originalPath) - getPathDepth(left.originalPath);
  }
  return left.originalPath.localeCompare(right.originalPath);
}

function compareStageTwo(left: RenameOperation, right: RenameOperation): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  if (left.kind === "directory") {
    return getPathDepth(left.originalPath) - getPathDepth(right.originalPath);
  }
  return left.originalPath.localeCompare(right.originalPath);
}

function sortRollbackOperations(operations: RenameJournalOperation[]): void {
  operations.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    if (left.kind === "directory") {
      return getPathDepth(left.originalPath) - getPathDepth(right.originalPath);
    }
    return right.originalPath.localeCompare(left.originalPath);
  });
}

async function assertPathExists(targetPath: string): Promise<void> {
  await fs.lstat(targetPath);
}

class RenameOperationError extends Error {
  constructor(
    public readonly operation: RenameOperation,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RenameOperationError";
  }
}
