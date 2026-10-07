import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  NameApplyResult,
  NameEntryKind,
  NameRenameItem,
  NameUndoResult,
  NameUnrecoveredEntry,
} from "@/name-translation/contract";
import { defaultPlatformContext, type PlatformContext } from "./fs-listing";
import type { JournalStep, NameJournalStore, JournalWriter } from "./journal";
import { computeFinalPaths, planRename, type PlannerDeps, type RenameGroup } from "./planner";

/**
 * Executes validated renames.
 *
 * Groups run deepest parent first, so every step uses paths that are still
 * valid on disk: renaming an entry only changes its own subtree, and that
 * subtree's entries were renamed earlier. Groups whose targets reuse a source
 * name (chains, swaps, case-only changes) go through unique temporary names.
 * Any failure reverses every completed step in reverse order.
 */

export interface ExecutorDeps extends PlannerDeps {
  readonly journals: NameJournalStore;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly exists?: (target: string) => Promise<boolean>;
  readonly retryDelayMs?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_TRANSIENT_RETRIES = 3;

class TargetExistsError extends Error {
  readonly code = "EEXIST";
  constructor(target: string) {
    super(`Target already exists: ${target}`);
  }
}

async function defaultExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

class StepRunner {
  readonly completed: JournalStep[] = [];
  /** Source path of the rename currently being attempted. */
  attempting = "";
  /** Temporary staging path -> original source path, for user-facing errors. */
  readonly stagedSources = new Map<string, string>();
  private readonly rename: (from: string, to: string) => Promise<void>;
  private readonly exists: (target: string) => Promise<boolean>;
  private readonly retryDelayMs: number;

  constructor(
    private readonly journal: JournalWriter,
    deps: ExecutorDeps,
  ) {
    this.rename = deps.rename ?? ((from, to) => fs.rename(from, to));
    this.exists = deps.exists ?? defaultExists;
    this.retryDelayMs = deps.retryDelayMs ?? 150;
  }

  async renameNoClobber(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new TargetExistsError(to);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? "";
        if (!TRANSIENT_CODES.has(code) || attempt >= MAX_TRANSIENT_RETRIES) throw error;
        await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
  }

  async step(from: string, to: string, kind: NameEntryKind): Promise<void> {
    this.attempting = from;
    await this.renameNoClobber(from, to);
    // Record in memory first so a journal write failure still gets rolled back.
    const step: JournalStep = { seq: this.completed.length + 1, from, to, kind };
    this.completed.push(step);
    await this.journal.step(step);
  }

  async reverse(step: JournalStep): Promise<NameUnrecoveredEntry | null> {
    try {
      if (!(await this.exists(step.to))) {
        return { currentPath: step.to, expectedPath: step.from, message: "Renamed entry is missing." };
      }
      await this.renameNoClobber(step.to, step.from);
      return null;
    } catch (error) {
      return { currentPath: step.to, expectedPath: step.from, message: errorMessage(error) };
    }
  }

  async tempPathIn(parentPath: string, label: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = path.join(parentPath, `.fk-rename-${label}-${randomBytes(4).toString("hex")}`);
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new Error(`Unable to allocate a temporary name in ${parentPath}`);
  }
}

async function runGroup(group: RenameGroup, runner: StepRunner, onStep: () => void): Promise<void> {
  if (!group.needsStaging) {
    for (const item of group.items) {
      await runner.step(item.path, path.join(group.parentPath, item.newName), item.kind);
      onStep();
    }
    return;
  }
  const staged: Array<{ temp: string; target: string; kind: NameEntryKind }> = [];
  for (const [index, item] of group.items.entries()) {
    const temp = await runner.tempPathIn(group.parentPath, String(index));
    await runner.step(item.path, temp, item.kind);
    runner.stagedSources.set(temp, item.path);
    staged.push({ temp, target: path.join(group.parentPath, item.newName), kind: item.kind });
  }
  for (const entry of staged) {
    await runner.step(entry.temp, entry.target, entry.kind);
    onStep();
  }
}

export async function applyRenames(
  items: readonly NameRenameItem[],
  deps: ExecutorDeps,
): Promise<NameApplyResult> {
  const context: PlatformContext = deps.context ?? defaultPlatformContext();
  const plan = await planRename(items, { ...deps, context });
  if (plan.preflight.issueCount > 0 || plan.preflight.readyCount === 0) {
    return { status: "rejected", preflight: plan.preflight };
  }

  const journal = await deps.journals.create(plan.preflight.readyCount);
  const runner = new StepRunner(journal, deps);
  const total = plan.preflight.readyCount;
  let done = 0;
  try {
    for (const group of plan.groups) {
      await runGroup(group, runner, () => {
        done += 1;
        deps.onProgress?.(done, total);
      });
    }
    await journal.status("completed").catch(() => undefined);
    await journal.close();
    const finals = computeFinalPaths(plan.groups, context.platform);
    return {
      status: "completed",
      journalId: journal.journalId,
      renamed: plan.groups.flatMap((group) =>
        group.items.map((item) => ({
          from: item.path,
          to: finals.get(item.path) ?? path.join(group.parentPath, item.newName),
          kind: item.kind,
        })),
      ),
    };
  } catch (error) {
    const message = errorMessage(error);
    const failedPath = runner.stagedSources.get(runner.attempting) ?? runner.attempting;
    const unrecovered: NameUnrecoveredEntry[] = [];
    for (const step of [...runner.completed].reverse()) {
      const failure = await runner.reverse(step);
      if (failure) unrecovered.push(failure);
      else await journal.undone(step.seq).catch(() => undefined);
    }
    await journal.status(unrecovered.length === 0 ? "rolled_back" : "failed").catch(() => undefined);
    await journal.close();
    return {
      status: "failed",
      journalId: journal.journalId,
      failedPath,
      message,
      rollback: unrecovered.length === 0 ? "complete" : "partial",
      unrecovered,
    };
  }
}

/**
 * Reverses a journal (undo after success, or recovery after an interrupted
 * run). Already reversed steps are skipped, so a partial undo can be resumed.
 */
export async function undoJournal(
  journalId: string,
  deps: ExecutorDeps,
): Promise<NameUndoResult | null> {
  const record = await deps.journals.read(journalId);
  if (!record) return null;
  const writer = await deps.journals.openForAppend(journalId);
  const runner = new StepRunner(writer, deps);
  const failures: NameUnrecoveredEntry[] = [];
  let restoredCount = 0;
  try {
    const pending = record.steps.filter((step) => !record.undone.has(step.seq)).reverse();
    for (const step of pending) {
      const failure = await runner.reverse(step);
      if (failure) {
        failures.push(failure);
        // Earlier steps may live under this entry; stop so a retry resumes here.
        break;
      }
      restoredCount += 1;
      await writer.undone(step.seq);
    }
    await writer.status(failures.length === 0 ? "undone" : "undo_partial");
  } finally {
    await writer.close();
  }
  return {
    status: failures.length === 0 ? "completed" : "partial",
    restoredCount,
    failures,
  };
}
