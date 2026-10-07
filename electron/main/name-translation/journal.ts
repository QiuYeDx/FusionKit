import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  NameEntryKind,
  NameJournalStatus,
  NameJournalSummary,
} from "@/name-translation/contract";

/**
 * Append-only JSONL journal of completed rename steps. Every step is recorded
 * right after it happens so an interrupted run can be reversed exactly. Only
 * paths are stored: no model content or credentials.
 */

const JOURNAL_VERSION = 1;
const MAX_KEPT_JOURNALS = 30;
const JOURNAL_EXTENSION = ".jsonl";

export interface JournalStep {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly kind: NameEntryKind;
}

type JournalLine =
  | { t: "header"; v: number; id: string; createdAt: number; itemCount: number }
  | { t: "step"; seq: number; from: string; to: string; kind: NameEntryKind }
  | { t: "status"; status: NameJournalStatus }
  | { t: "undone"; seq: number };

export interface JournalRecord {
  readonly journalId: string;
  readonly createdAt: number;
  readonly itemCount: number;
  readonly status: NameJournalStatus;
  readonly steps: readonly JournalStep[];
  readonly undone: ReadonlySet<number>;
}

export function createJournalId(now = Date.now()): string {
  return `nt-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class NameJournalStore {
  constructor(private readonly directory: string) {}

  private fileFor(journalId: string): string {
    if (!/^[a-z0-9_-]{8,80}$/i.test(journalId)) {
      throw new Error("Invalid journal id.");
    }
    return path.join(this.directory, `${journalId}${JOURNAL_EXTENSION}`);
  }

  async create(itemCount: number, now = Date.now()): Promise<JournalWriter> {
    await fs.mkdir(this.directory, { recursive: true });
    const journalId = createJournalId(now);
    const file = this.fileFor(journalId);
    const handle = await fs.open(file, "wx");
    const writer = new JournalWriter(journalId, handle);
    await writer.write({ t: "header", v: JOURNAL_VERSION, id: journalId, createdAt: now, itemCount });
    await this.prune(journalId);
    return writer;
  }

  async openForAppend(journalId: string): Promise<JournalWriter> {
    const handle = await fs.open(this.fileFor(journalId), "a");
    return new JournalWriter(journalId, handle);
  }

  async read(journalId: string): Promise<JournalRecord | null> {
    let content: string;
    try {
      content = await fs.readFile(this.fileFor(journalId), "utf8");
    } catch {
      return null;
    }
    return parseJournal(journalId, content);
  }

  async list(): Promise<NameJournalSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    const summaries: NameJournalSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(JOURNAL_EXTENSION)) continue;
      const journalId = name.slice(0, -JOURNAL_EXTENSION.length);
      try {
        const record = await this.read(journalId);
        if (record) summaries.push(summarize(record));
      } catch {
        // An unreadable journal is skipped rather than failing the listing.
      }
    }
    return summaries.sort((left, right) => right.createdAt - left.createdAt);
  }

  private async prune(keepId: string): Promise<void> {
    let names: string[];
    try {
      names = (await fs.readdir(this.directory)).filter((name) => name.endsWith(JOURNAL_EXTENSION));
    } catch {
      return;
    }
    if (names.length <= MAX_KEPT_JOURNALS) return;
    const records = await Promise.all(
      names.map(async (name) => {
        const id = name.slice(0, -JOURNAL_EXTENSION.length);
        const record = await this.read(id).catch(() => null);
        return { id, record };
      }),
    );
    // Never prune a journal that may still need recovery.
    const removable = records
      .filter(({ id, record }) => id !== keepId && record && record.status !== "running" && record.status !== "undo_partial" && record.status !== "failed")
      .sort((left, right) => (left.record!.createdAt - right.record!.createdAt));
    const excess = names.length - MAX_KEPT_JOURNALS;
    for (const { id } of removable.slice(0, excess)) {
      await fs.rm(this.fileFor(id), { force: true }).catch(() => undefined);
    }
  }
}

export class JournalWriter {
  constructor(
    readonly journalId: string,
    private readonly handle: FileHandle,
  ) {}

  async write(line: JournalLine): Promise<void> {
    await this.handle.appendFile(`${JSON.stringify(line)}\n`, "utf8");
  }

  async step(step: JournalStep): Promise<void> {
    await this.write({ t: "step", ...step });
    await this.handle.datasync().catch(() => undefined);
  }

  async undone(seq: number): Promise<void> {
    await this.write({ t: "undone", seq });
  }

  async status(status: NameJournalStatus): Promise<void> {
    await this.write({ t: "status", status });
    await this.handle.datasync().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export function parseJournal(journalId: string, content: string): JournalRecord | null {
  const lines = content.split("\n");
  let createdAt = 0;
  let itemCount = 0;
  let status: NameJournalStatus = "running";
  let header = false;
  const steps: JournalStep[] = [];
  const undone = new Set<number>();

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let line: JournalLine;
    try {
      line = JSON.parse(raw) as JournalLine;
    } catch {
      // A crash can truncate the final line; earlier lines remain authoritative.
      continue;
    }
    if (line.t === "header") {
      header = true;
      createdAt = Number(line.createdAt) || 0;
      itemCount = Number(line.itemCount) || 0;
    } else if (line.t === "step" && typeof line.from === "string" && typeof line.to === "string") {
      steps.push({ seq: line.seq, from: line.from, to: line.to, kind: line.kind === "directory" ? "directory" : "file" });
    } else if (line.t === "status") {
      status = line.status;
    } else if (line.t === "undone") {
      undone.add(line.seq);
    }
  }
  if (!header) return null;
  return { journalId, createdAt, itemCount, status, steps, undone };
}

export function summarize(record: JournalRecord): NameJournalSummary {
  return {
    journalId: record.journalId,
    createdAt: record.createdAt,
    status: record.status,
    itemCount: record.itemCount,
    stepCount: record.steps.length,
    undoneCount: record.steps.filter((step) => record.undone.has(step.seq)).length,
  };
}
