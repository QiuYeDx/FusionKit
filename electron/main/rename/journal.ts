import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import type {
  NameTranslationPlan,
  NameTranslationPlanItem,
  RenameJournal,
  RenameJournalOperation,
  RenameJournalOperationStatus,
  RenameJournalStatus,
} from "./types";

export interface RenameJournalOptions {
  journalDir?: string;
}

export interface RenameJournalOperationSeed {
  itemId: string;
  kind: "file" | "directory";
  originalPath: string;
  finalPath: string;
}

export async function createRenameJournal(
  plan: NameTranslationPlan,
  operations: Array<RenameJournalOperationSeed | NameTranslationPlanItem>,
  options: RenameJournalOptions = {}
): Promise<RenameJournal> {
  const journal: RenameJournal = {
    journalId: createJournalId(plan.planId),
    planId: plan.planId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    operations: operations.map(toJournalOperation),
  };

  await writeRenameJournal(journal, options);
  return journal;
}

export async function updateJournalOperation(
  journalId: string,
  itemId: string,
  patch: Partial<
    Pick<RenameJournalOperation, "tempPath" | "finalPath" | "status" | "error">
  >,
  options: RenameJournalOptions = {}
): Promise<void> {
  const journal = await readRenameJournal(journalId, options);
  if (!journal) throw new Error(`Rename journal not found: ${journalId}`);

  const operation = journal.operations.find((op) => op.itemId === itemId);
  if (!operation) {
    throw new Error(`Rename journal operation not found: ${itemId}`);
  }

  Object.assign(operation, patch);
  journal.updatedAt = Date.now();
  await writeRenameJournal(journal, options);
}

export async function finishRenameJournal(
  journalId: string,
  status: RenameJournalStatus,
  options: RenameJournalOptions = {}
): Promise<void> {
  const journal = await readRenameJournal(journalId, options);
  if (!journal) throw new Error(`Rename journal not found: ${journalId}`);
  journal.status = status;
  journal.updatedAt = Date.now();
  await writeRenameJournal(journal, options);
}

export async function readRenameJournal(
  journalId: string,
  options: RenameJournalOptions = {}
): Promise<RenameJournal | null> {
  try {
    const content = await fs.readFile(getJournalPath(journalId, options), "utf-8");
    return JSON.parse(content) as RenameJournal;
  } catch {
    return null;
  }
}

export async function writeRenameJournal(
  journal: RenameJournal,
  options: RenameJournalOptions = {}
): Promise<void> {
  const journalDir = getJournalDir(options);
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(
    getJournalPath(journal.journalId, options),
    JSON.stringify(journal, null, 2),
    "utf-8"
  );
}

export function getJournalPath(
  journalId: string,
  options: RenameJournalOptions = {}
): string {
  return path.join(getJournalDir(options), `${sanitizeJournalId(journalId)}.json`);
}

export function getJournalDir(options: RenameJournalOptions = {}): string {
  if (options.journalDir) return options.journalDir;
  return path.join(app.getPath("userData"), "rename-journals");
}

function toJournalOperation(
  operation: RenameJournalOperationSeed | NameTranslationPlanItem
): RenameJournalOperation {
  if ("sourcePath" in operation) {
    return {
      itemId: operation.id,
      kind: operation.kind,
      originalPath: operation.sourcePath,
      finalPath: operation.targetPath,
      status: "pending",
    };
  }

  return {
    itemId: operation.itemId,
    kind: operation.kind,
    originalPath: operation.originalPath,
    finalPath: operation.finalPath,
    status: "pending",
  };
}

function createJournalId(planId: string): string {
  return `rename_journal_${sanitizeJournalId(planId)}_${Date.now()}`;
}

function sanitizeJournalId(journalId: string): string {
  return journalId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function isRollbackableStatus(
  status: RenameJournalOperationStatus
): boolean {
  return status === "final_done" || status === "temp_done";
}
