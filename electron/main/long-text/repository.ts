import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, copyFileSync, constants as fsConstants, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { MODEL_ERROR_CATEGORIES } from '../../../src/lib/model-error-category';
import {
  indexSchema, languageSchema, LONG_TEXT_ENCODINGS, LONG_TEXT_ERROR_CODES, LONG_TEXT_FORMATS, LONG_TEXT_LIMITS, RUN_KINDS,
  RUN_STATUSES, settingsSchema, STYLES, TXT_SPLITS,
  type DocumentSummary, type LanguageTag, type LedgerEntry, type LongTextErrorCode, type Pace, type RunView, type Usage,
} from '../../../src/long-text/contract';
import {
  emptyUsage, readSnapshot, replayJournalAsync, snapshotLines, splitJournal, usageSchema, type JournalReplay, type JournalState,
} from '../../../src/long-text/journal';
import {
  SEGMENT_FLAG,
  type DocumentManifest, type JournalSnapshot, type PageRecord, type RunRecord, type SegmentRecord, type SegmentTable,
} from '../../../src/long-text/model';
import { loadSegmentTable, SegmentationError } from '../../../src/long-text/segments';

/**
 * Disk layout of the long text translator (design §6.10):
 *
 *   <root>/index.json                   list cache; entries older than their manifest are rebuilt from it
 *   <root>/documents/<id>/              one document, files named in FILES
 *   <root>/documents/.import-<uuid>/    a new document being written; deleted at startup
 *   <root>/documents/.staging-<uuid>/   a replacement being swapped in (manifest written last); restored when <id> is missing
 *   <root>/documents/.trash-<uuid>/     a document being deleted
 *
 * Every operation on the files of one document runs on that document's serial queue (`withDocument`).
 */

export const FILES = Object.freeze({
  manifest: 'manifest.json', previousManifest: 'manifest.prev.json', original: 'original.bin', source: 'source.txt',
  segments: 'segments.jsonl', pages: 'pages.json', refs: 'refs.json', journal: 'journal.log', snapshot: 'journal.snapshot.json',
  ledger: 'ledger.json',
});
export type DocumentFile = keyof typeof FILES;
export const MANIFEST_SCHEMA_VERSION = 1;
/** The journal is folded into the snapshot once it passes either size, after an append and at load. */
export const COMPACT_JOURNAL_BYTES = 8 * 1024 * 1024;
export const COMPACT_JOURNAL_LINES = 20_000;
const INDEX_FILE = 'index.json';
const INDEX_DELAY_MS = 1_000;
const STORAGE_CACHE_MS = 10_000;
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;
const RECORDS_PER_WRITE = 2_000;
const STAGING = '.staging-';
/** A new document being written; never restored, since its import never reported success. */
const IMPORTING = '.import-';
const TRASH = '.trash-';
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A failed operation, carrying the error code the service returns. */
export class LongTextOperationError extends Error {
  constructor(readonly code: LongTextErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LongTextOperationError';
  }
}

/** A document file that exists but cannot be used. */
class DamagedFile extends Error {}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const isMissing = (error: unknown) => errorCode(error) === 'ENOENT';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** source.txt must decode to exactly the S its segment offsets refer to, including a leading U+FEFF. */
const sourceUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function io<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof LongTextOperationError ? error : new LongTextOperationError('storage_failed', { cause: error });
  }
}

const count = z.number().int().nonnegative();
const time = z.number().nonnegative();
const documentId = z.string().regex(DOCUMENT_ID);
const countsSchema = z.object({ translatable: count, done: count, pending: count, failed: count, attention: count, edited: count, locked: count });
const lineEndingSchema = z.enum(['\n', '\r\n', '\r']);
const runSchema = z.object({
  id: z.string().min(1).max(200), kind: z.enum(RUN_KINDS), status: z.enum(RUN_STATUSES), startedAt: time, endedAt: time.optional(),
  settingsDigest: z.string(),
  model: z.object({ profileId: z.string(), modelKey: z.string(), label: z.string() }),
  total: count, done: count, failed: count, deferred: count,
  error: z.object({ code: z.enum(LONG_TEXT_ERROR_CODES), category: z.enum(MODEL_ERROR_CATEGORIES).optional(), message: z.string().optional() }).optional(),
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION), id: documentId, revision: count, createdAt: time, updatedAt: time,
  name: z.string().min(1), format: z.enum(LONG_TEXT_FORMATS),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1), size: count, mtimeMs: z.number(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    z.object({ kind: z.literal('paste') }),
  ]),
  encoding: z.object({ name: z.enum(LONG_TEXT_ENCODINGS), confidence: z.enum(['high', 'low']), confirmed: z.boolean(), lineEnding: lineEndingSchema }).nullable(),
  lineEnding: lineEndingSchema,
  structure: z.object({ txtSplit: z.enum(TXT_SPLITS), resolved: z.enum(['line', 'unwrap']) }).nullable(),
  detected: z.object({ sourceLanguage: languageSchema, style: z.enum(STYLES) }),
  stats: z.object({ characters: count, segments: count, translatable: count, pages: count, sourceTokens: count }),
  settings: settingsSchema,
  counts: countsSchema, usage: usageSchema,
  fullRunStarted: z.boolean(),
  sample: z.object({ indices: z.array(indexSchema), settingsDigest: z.string(), at: time }).nullable(),
  runs: z.array(runSchema),
  exportFolder: z.string().nullable(),
  exports: z.array(z.object({ path: z.string().min(1), name: z.string().min(1), mode: z.enum(['target', 'bilingual']), at: time })),
}) satisfies z.ZodType<DocumentManifest>;

const ledgerFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    id: documentId,
    source: z.string().min(1).max(LONG_TEXT_LIMITS.termChars), target: z.string().min(1).max(LONG_TEXT_LIMITS.termChars),
    origin: z.enum(['model', 'user']), confirmed: z.boolean(), firstSeen: count.nullable(), updatedAt: time,
  }) satisfies z.ZodType<LedgerEntry>).max(LONG_TEXT_LIMITS.ledgerEntries),
});
const pagesSchema = z.array(z.object({ start: count, end: count, title: z.string().nullable() })) satisfies z.ZodType<PageRecord[]>;
const refsSchema = z.array(z.string());
const indexFileSchema = z.object({ version: z.literal(1), documents: z.array(z.unknown()) });
/** Enough of a cached `DocumentSummary` to trust the rest of it; the index is only ever written by this module. */
const cachedSummarySchema = z.looseObject({
  id: documentId, revision: count, name: z.string(), format: z.enum(LONG_TEXT_FORMATS), createdAt: time, updatedAt: time,
  counts: countsSchema, usage: usageSchema, fullRunStarted: z.boolean(), journalIssues: count,
});

/** The source language with `auto` resolved to the detected one, and the target. */
export function effectiveLanguages(manifest: Pick<DocumentManifest, 'settings' | 'detected'>): { source: LanguageTag; target: LanguageTag } {
  const { sourceLanguage, targetLanguage } = manifest.settings;
  return { source: sourceLanguage === 'auto' ? manifest.detected.sourceLanguage : sourceLanguage, target: targetLanguage };
}

/** The view of a run that is not in memory: nothing in flight and no estimate. */
export function runRecordView(run: RunRecord, pace: Pace, usage: Usage): RunView {
  return {
    id: run.id, kind: run.kind, status: run.status,
    total: run.total, done: run.done, failed: run.failed, deferred: run.deferred, inFlight: 0,
    frontier: null, frontierPage: null, pace, effectiveLanes: 0, etaSeconds: null,
    startedAt: run.startedAt, endedAt: run.endedAt ?? null,
    model: { ...run.model },
    ...(run.error ? { error: { ...run.error } } : {}),
    usage: { ...usage },
  };
}

/** The list entry of a document from its manifest; counts and usage are the manifest's caches. */
export function manifestSummary(manifest: DocumentManifest, journalIssues = 0, runUsage: Usage = emptyUsage()): DocumentSummary {
  const { settings, source, encoding, stats } = manifest;
  const run = manifest.runs[0];
  const lastExport = manifest.exports[0];
  return {
    id: manifest.id, revision: manifest.revision, name: manifest.name, format: manifest.format,
    createdAt: manifest.createdAt, updatedAt: manifest.updatedAt,
    source: source.kind === 'file' ? { kind: 'file', fileName: path.basename(source.path), directory: path.dirname(source.path) } : { kind: 'paste' },
    encoding: encoding && { name: encoding.name, confidence: encoding.confidence, confirmed: encoding.confirmed },
    languages: { ...effectiveLanguages(manifest), sourceIsAuto: settings.sourceLanguage === 'auto' },
    style: settings.style,
    stats: { characters: stats.characters, translatable: stats.translatable, pages: stats.pages },
    counts: { ...manifest.counts }, usage: { ...manifest.usage },
    fullRunStarted: manifest.fullRunStarted,
    run: run ? runRecordView(run, settings.pace, runUsage) : null,
    lastExport: lastExport ? { name: lastExport.name, at: lastExport.at } : null,
    journalIssues,
  };
}

/** The list entry of a document that cannot be opened: its last cached entry when there is one. */
export function unavailableSummary(
  id: string, unavailable: 'damaged' | 'newer_version', cached: DocumentSummary | undefined, name: string | undefined, at: number,
): DocumentSummary {
  if (cached) return { ...cached, ...(name ? { name } : {}), unavailable };
  return {
    id, revision: 0, name: name || id, format: 'txt', createdAt: at, updatedAt: at, source: { kind: 'paste' }, encoding: null,
    languages: { source: 'en', target: 'en', sourceIsAuto: false }, style: 'general',
    stats: { characters: 0, translatable: 0, pages: 0 },
    counts: { translatable: 0, done: 0, pending: 0, failed: 0, attention: 0, edited: 0, locked: 0 }, usage: emptyUsage(),
    fullRunStarted: false, run: null, lastExport: null, journalIssues: 0, unavailable,
  };
}

/** Marks the runs a previous session left running or pausing as interrupted; true when any changed. */
export function interruptRuns(manifest: DocumentManifest): boolean {
  let changed = false;
  for (const run of manifest.runs) {
    if (run.status !== 'running' && run.status !== 'pausing') continue;
    run.status = 'interrupted';
    changed = true;
  }
  return changed;
}

/** Keeps the latest 20 runs and 10 exports, newest first, so `runs[0]` and `exports[0]` are the latest. */
export function normalizeManifest(manifest: DocumentManifest): DocumentManifest {
  manifest.runs = [...manifest.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, LONG_TEXT_LIMITS.runsKept);
  manifest.exports = [...manifest.exports].sort((a, b) => b.at - a.at).slice(0, LONG_TEXT_LIMITS.exportsKept);
  return manifest;
}

/** The state the snapshot that replaces the journal is written from; run usage is kept for the runs the manifest still lists. */
export function compactionSnapshot(state: JournalState, runs: readonly RunRecord[]): JournalState {
  const kept = new Set(runs.map(run => run.id));
  return { ...state, runUsage: new Map([...state.runUsage].filter(([runId]) => kept.has(runId))) };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      // Windows refuses a rename while another process (an indexer, an antivirus) briefly holds the file.
      if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY'].includes(errorCode(error) ?? '')) throw error;
      await delay(RENAME_RETRY_MS);
    }
  }
}

async function writeDurable(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** tmp → fsync → rename, so readers see the old file or the new one, never a torn one. */
async function writeAtomic(file: string, data: string | Uint8Array, beforeRename?: () => Promise<void>): Promise<void> {
  const temporary = `${file}.tmp`;
  try {
    await writeDurable(temporary, data);
    await beforeRename?.();
    await renameWithRetry(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Like `writeAtomic`, for text made of many lines: written 2,000 lines at a time, each write an await. */
async function writeLinesAtomic(file: string, lines: Iterable<string>): Promise<void> {
  const temporary = `${file}.tmp`;
  try {
    const handle = await fs.open(temporary, 'w');
    try {
      let chunk = '';
      let count = 0;
      for (const line of lines) {
        chunk += line;
        if (++count < RECORDS_PER_WRITE) continue;
        await handle.writeFile(chunk);
        chunk = '';
        count = 0;
      }
      if (chunk) await handle.writeFile(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Streams `file` line by line into `read`, then closes it. */
async function readLines<T>(file: string, read: (lines: AsyncIterable<string>) => Promise<T>): Promise<T> {
  const handle = await fs.open(file, 'r');
  const stream = handle.createReadStream({ encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await read(lines);
  } finally {
    lines.close();
    if (!stream.closed) {
      const closed = once(stream, 'close');
      stream.destroy();
      await closed;
    }
  }
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

const exists = (target: string) => fs.access(target).then(() => true, () => false);

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    return undefined;
  }
}

function parseFile<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  const parsed = schema.safeParse(parseJson(bytes));
  if (!parsed.success) throw new DamagedFile();
  return parsed.data;
}

async function removeDirectory(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    .catch(error => console.warn(`[long-text] Could not remove ${path.basename(dir)}`, error));
}

async function writeRecords(file: string, records: readonly SegmentRecord[]): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    for (let start = 0; start < records.length; start += RECORDS_PER_WRITE) {
      let chunk = '';
      for (let i = start; i < Math.min(records.length, start + RECORDS_PER_WRITE); i++) chunk += JSON.stringify(records[i]) + '\n';
      await handle.writeFile(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Pages cover every segment exactly once, in order, and agree with each segment's page number. */
function pagesMatch(pages: readonly PageRecord[], table: SegmentTable): boolean {
  let next = 0;
  for (const [number, page] of pages.entries()) {
    if (page.start !== next || page.end < page.start || page.end >= table.count) return false;
    for (let i = page.start; i <= page.end; i++) if (table.page[i] !== number) return false;
    next = page.end + 1;
  }
  return table.count > 0 && next === table.count;
}

type ManifestFile = { manifest: DocumentManifest } | { newer: string | undefined } | null;

async function readManifestFile(file: string): Promise<ManifestFile> {
  const bytes = await readOptional(file);
  if (!bytes) return null;
  const value = parseJson(bytes);
  if (isObject(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > MANIFEST_SCHEMA_VERSION) {
    return { newer: typeof value.name === 'string' ? value.name : undefined };
  }
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? { manifest: parsed.data } : null;
}

export type Unavailable = { unavailable: 'damaged' | 'newer_version'; name?: string };
export type ManifestRead = { manifest: DocumentManifest; previous: boolean } | Unavailable;

/** A new document: everything written once at import. */
export interface NewDocument {
  manifest: DocumentManifest;
  /** S, kept with its original line endings. */
  source: string;
  /** The imported bytes (file sources only), for encoding previews and re-decoding. */
  original: Uint8Array | null;
  records: readonly SegmentRecord[];
  pages: readonly PageRecord[];
  /** Normalized link reference labels (`SegmentedDocument.refs`); projections must use the same set. */
  refs: readonly string[];
}

/** Everything `load` reads back, the journal already replayed. */
export interface StoredDocument {
  manifest: DocumentManifest;
  source: string;
  table: SegmentTable;
  pages: PageRecord[];
  refs: string[];
  /** Records of translatable segments only. */
  replay: JournalReplay;
  /** Size of `journal.log` after truncating a torn last line or compacting. */
  journal: { bytes: number; lines: number };
  ledger: LedgerEntry[];
  /** Unreadable journal lines, a damaged snapshot or ledger, records of segments that do not exist. */
  issues: number;
}

/** The files of one document. Only reachable through `LongTextRepository.withDocument`, so calls never overlap. */
export class DocumentFiles {
  /** Set when `manifest.json` could not be read: the next write must not copy it over the previous version. */
  private primaryDamaged = false;
  /** Set when a failed append could not be rolled back: the journal may end in lines that must not stay. */
  private journalRollback = false;

  constructor(readonly id: string, readonly dir: string) {}

  path(file: DocumentFile): string {
    return path.join(this.dir, FILES[file]);
  }

  /** `manifest.json`, else `manifest.prev.json`; `newer_version` as soon as either has a newer schema. */
  readManifest(): Promise<ManifestRead> {
    return io(async () => {
      const own = (file: ManifestFile) => (file && 'manifest' in file && file.manifest.id !== this.id ? null : file);
      const primary = own(await readManifestFile(this.path('manifest')));
      if (primary && 'manifest' in primary) {
        this.primaryDamaged = false;
        return { manifest: primary.manifest, previous: false };
      }
      if (primary) return { unavailable: 'newer_version', name: primary.newer };
      this.primaryDamaged = true;
      const previous = own(await readManifestFile(this.path('previousManifest')));
      if (previous && 'manifest' in previous) return { manifest: previous.manifest, previous: true };
      if (previous) return { unavailable: 'newer_version', name: previous.newer };
      return { unavailable: 'damaged' };
    });
  }

  /** tmp → fsync → copy the current version to `manifest.prev.json` → rename. */
  async writeManifest(manifest: DocumentManifest): Promise<void> {
    const text = JSON.stringify(manifestSchema.parse(manifest));
    const file = this.path('manifest');
    const keepPrevious = !this.primaryDamaged;
    await io(() => writeAtomic(file, text, async () => {
      if (!keepPrevious) return;
      try {
        await fs.copyFile(file, this.path('previousManifest'));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }));
    this.primaryDamaged = false;
  }

  /** Best effort before quitting, when nothing asynchronous will run again; throws on failure. */
  writeManifestSync(manifest: DocumentManifest): void {
    const file = this.path('manifest');
    const temporary = `${file}.quit.tmp`;
    const descriptor = openSync(temporary, 'w');
    try {
      writeFileSync(descriptor, JSON.stringify(manifestSchema.parse(manifest)));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (!this.primaryDamaged) {
      try { copyFileSync(file, this.path('previousManifest')); } catch { /* no current version yet */ }
    }
    renameSync(temporary, file);
  }

  /**
   * Appends journal lines: open for append → write → datasync → close (no handle stays open, so the
   * compaction rename never meets one on Windows). On failure the file is cut back to `size`, its length
   * before the append, so a half-written batch cannot sit in front of later lines. When that cut fails
   * too, it is tried again before the next append, and nothing is appended while it keeps failing.
   */
  async appendJournal(text: string, size: number): Promise<void> {
    const file = this.path('journal');
    if (this.journalRollback) {
      await io(() => fs.truncate(file, size));
      this.journalRollback = false;
    }
    const handle = await io(() => fs.open(file, 'a'));
    let failure: unknown = null;
    try {
      await handle.appendFile(text, 'utf8');
      await handle.datasync();
    } catch (error) {
      failure = error;
    } finally {
      await handle.close().catch(error => { failure ??= error; });
    }
    if (failure === null) return;
    await fs.truncate(file, size).catch(() => {
      this.journalRollback = true;
    });
    throw new LongTextOperationError('storage_failed', { cause: failure });
  }

  /**
   * Two steps, each atomic: ① the snapshot of `state` (replay then skips every line with `q ≤ seq`),
   * written 2,000 lines at a time, ② an empty journal. A crash between them leaves lines the snapshot
   * already holds, which replay ignores.
   */
  compact(state: JournalState): Promise<void> {
    return io(async () => {
      await writeLinesAtomic(this.path('snapshot'), snapshotLines(state));
      await writeAtomic(this.path('journal'), '');
      this.journalRollback = false;
    });
  }

  /** The ledger entries; [] when there is no ledger yet, null when it is damaged. */
  readLedger(): Promise<LedgerEntry[] | null> {
    return io(async () => {
      const bytes = await readOptional(this.path('ledger'));
      if (!bytes) return [];
      const parsed = ledgerFileSchema.safeParse(parseJson(bytes));
      return parsed.success ? parsed.data.entries : null;
    });
  }

  writeLedger(entries: readonly LedgerEntry[]): Promise<void> {
    const text = JSON.stringify(ledgerFileSchema.parse({ version: 1, entries }));
    return io(() => writeAtomic(this.path('ledger'), text));
  }

  /** The imported bytes; null for pasted text. */
  readOriginal(): Promise<Uint8Array | null> {
    return io(() => readOptional(this.path('original')));
  }

  /**
   * Loads a document (§6.10 “加载”): manifest (or its previous version) → S → segments → pages → refs →
   * snapshot (line by line; unreadable records are counted) → journal (a torn last line is cut off the
   * file, unreadable lines are counted) → ledger (damaged: empty and counted). A damaged snapshot or
   * ledger is copied aside first, so no later write destroys it. A journal over the compaction limits is
   * compacted on the way.
   */
  async load(): Promise<StoredDocument | Unavailable> {
    if (!(await exists(this.dir))) throw new LongTextOperationError('not_found');
    const read = await this.readManifest();
    if ('unavailable' in read) return read;
    const { manifest } = read;
    let segmentation: Pick<StoredDocument, 'source' | 'table' | 'pages' | 'refs'>;
    try {
      segmentation = await this.readSegmentation();
    } catch (error) {
      if (error instanceof DamagedFile || error instanceof SegmentationError || isMissing(error)) return { unavailable: 'damaged', name: manifest.name };
      throw new LongTextOperationError('storage_failed', { cause: error });
    }
    const { table } = segmentation;
    return io(async () => {
      let issues = 0;
      const read = await this.readSnapshotFile();
      const snapshot = read?.snapshot ?? null;
      if (read) issues += read.skipped + (snapshot ? 0 : 1);
      if (read && (!snapshot || read.skipped)) await this.preserveDamaged('snapshot');
      const journal = await this.readJournal();
      const replay = await replayJournalAsync(snapshot, journal.lines);
      issues += replay.skipped;
      for (const index of [...replay.records.keys()]) {
        if (index < table.count && table.flags[index] & SEGMENT_FLAG.translatable) continue;
        replay.records.delete(index);
        issues++;
      }
      const ledger = await this.readLedger();
      if (!ledger) {
        issues++;
        await this.preserveDamaged('ledger');
      }
      let size = { bytes: journal.bytes, lines: journal.lines.length };
      if (size.bytes > COMPACT_JOURNAL_BYTES || size.lines > COMPACT_JOURNAL_LINES) {
        try {
          await this.compact(compactionSnapshot({ seq: replay.lastSeq, records: replay.records.values(), usage: replay.usage, runUsage: replay.runUsage }, manifest.runs));
          size = { bytes: 0, lines: 0 };
        } catch (error) {
          console.warn('[long-text] Could not compact the journal', error);
        }
      }
      return { manifest, ...segmentation, replay, journal: size, ledger: ledger ?? [], issues };
    });
  }

  /** The list entry from the manifest; runs a previous session left running are marked interrupted first. */
  async summarize(cached?: DocumentSummary): Promise<DocumentSummary> {
    try {
      const read = await this.readManifest();
      if ('unavailable' in read) return unavailableSummary(this.id, read.unavailable, cached, read.name, await this.modifiedAt());
      if (interruptRuns(read.manifest)) await this.writeManifest(read.manifest);
      const run = read.manifest.runs[0];
      const runUsage = run && cached?.run?.id === run.id ? cached.run.usage : undefined;
      return manifestSummary(read.manifest, cached?.journalIssues ?? 0, runUsage);
    } catch {
      return unavailableSummary(this.id, 'damaged', cached, undefined, await this.modifiedAt());
    }
  }

  /** Modification time of `manifest.json`; Infinity when it cannot be read. */
  async manifestTime(): Promise<number> {
    return (await fs.stat(this.path('manifest')).catch(() => null))?.mtimeMs ?? Infinity;
  }

  private async modifiedAt(): Promise<number> {
    return (await fs.stat(this.dir).catch(() => null))?.mtimeMs ?? 0;
  }

  /** The snapshot, null when there is none; its `snapshot` is null when the file cannot be used. */
  private async readSnapshotFile(): Promise<{ snapshot: JournalSnapshot | null; skipped: number } | null> {
    try {
      return await readLines(this.path('snapshot'), readSnapshot);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Copies a damaged file aside (best effort) so no later compaction or ledger write destroys it. The
   * copy is named after the file's modification time and size, so loading it again adds no second copy.
   */
  private async preserveDamaged(file: 'snapshot' | 'ledger'): Promise<void> {
    const from = this.path(file);
    try {
      const stat = await fs.stat(from);
      const to = path.join(this.dir, `${FILES[file].replace(/\.json$/, '')}.damaged-${Math.trunc(stat.mtimeMs)}-${stat.size}.json`);
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') console.warn('[long-text] Could not keep the damaged file', error);
    }
  }

  private async readSegmentation(): Promise<Pick<StoredDocument, 'source' | 'table' | 'pages' | 'refs'>> {
    let source: string;
    try {
      source = sourceUtf8.decode(await fs.readFile(this.path('source')));
    } catch (error) {
      throw error instanceof TypeError ? new DamagedFile() : error;
    }
    const table = await this.readTable(source.length);
    const pages = parseFile(pagesSchema, await fs.readFile(this.path('pages')));
    if (!pagesMatch(pages, table)) throw new DamagedFile();
    const refsBytes = await readOptional(this.path('refs'));
    return { source, table, pages, refs: refsBytes ? parseFile(refsSchema, refsBytes) : [] };
  }

  /** Streams `segments.jsonl` line by line into the table (`loadSegmentTable` yields every 2,000 lines). */
  private readTable(sourceLength: number): Promise<SegmentTable> {
    return readLines(this.path('segments'), lines => loadSegmentTable(lines, sourceLength));
  }

  private async readJournal(): Promise<{ lines: string[]; bytes: number }> {
    const file = this.path('journal');
    const bytes = await readOptional(file);
    this.journalRollback = false;
    if (!bytes) return { lines: [], bytes: 0 };
    const { lines, end } = splitJournal(bytes);
    if (end < bytes.length) await fs.truncate(file, end);
    return { lines, bytes: end };
  }
}

export interface RepositoryOptions {
  now?: () => number;
}

/** The `<userData>/long-text` folder: documents, their serial write queues, the list cache and storage usage. */
export class LongTextRepository {
  readonly documentsDir: string;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly files = new Map<string, DocumentFiles>();
  private readonly removals = new Set<Promise<void>>();
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private indexSource: (() => readonly DocumentSummary[]) | null = null;
  private indexWriting: Promise<void> = Promise.resolve();
  private storage: { bytes: number; at: number } | null = null;

  constructor(readonly root: string, options: RepositoryOptions = {}) {
    this.documentsDir = path.join(root, 'documents');
    this.now = options.now ?? Date.now;
  }

  documentDir(id: string): string {
    if (!DOCUMENT_ID.test(id)) throw new LongTextOperationError('invalid_request');
    return path.join(this.documentsDir, id);
  }

  /** Runs `task` after every earlier task of the same document; the files are only reachable this way. */
  withDocument<T>(id: string, task: (files: DocumentFiles) => Promise<T>): Promise<T> {
    let files = this.files.get(id);
    if (!files) {
      if (!DOCUMENT_ID.test(id)) return Promise.reject(new LongTextOperationError('invalid_request'));
      files = new DocumentFiles(id, this.documentDir(id));
      this.files.set(id, files);
    }
    const bound = files;
    const result = (this.queues.get(id) ?? Promise.resolve()).then(() => task(bound));
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return result;
  }

  /**
   * Startup: creates the folders, deletes `.trash-*` and `.import-*` (imports that never finished), moves a
   * complete `.staging-*` whose document folder is missing into place (a replacement interrupted between its
   * two renames) and deletes the others, then reads the list from
   * `index.json`. Entries that are missing, older than their manifest, unavailable or running are rebuilt
   * from the manifest, which also marks runs a previous session left running as interrupted.
   */
  async recover(): Promise<DocumentSummary[]> {
    await io(() => fs.mkdir(this.documentsDir, { recursive: true }));
    for (const entry of await io(() => fs.readdir(this.documentsDir, { withFileTypes: true }))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(TRASH) || entry.name.startsWith(IMPORTING)) await removeDirectory(path.join(this.documentsDir, entry.name));
      else if (entry.name.startsWith(STAGING)) await this.settleStaging(entry.name);
    }
    const ids = (await io(() => fs.readdir(this.documentsDir, { withFileTypes: true })))
      .filter(entry => entry.isDirectory() && DOCUMENT_ID.test(entry.name)).map(entry => entry.name);
    const { cached, writtenAt } = await this.readIndex();
    let changed = cached.size !== ids.length;
    const summaries: DocumentSummary[] = [];
    for (const id of ids) {
      const entry = cached.get(id);
      const running = entry?.run?.status === 'running' || entry?.run?.status === 'pausing';
      const fresh = entry && !entry.unavailable && !running && await this.withDocument(id, files => files.manifestTime()) < writtenAt;
      if (entry && fresh) {
        summaries.push(entry);
        continue;
      }
      summaries.push(await this.withDocument(id, files => files.summarize(entry)));
      changed = true;
    }
    if (changed) await this.writeIndex(summaries).catch(error => console.warn('[long-text] Could not write the document index', error));
    return summaries;
  }

  /** Writes `index.json` 1 s after the last call, with the list `documents()` returns at that time. */
  scheduleIndex(documents: () => readonly DocumentSummary[]): void {
    this.indexSource = documents;
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.flushIndex().catch(error => console.warn('[long-text] Could not write the document index', error));
    }, INDEX_DELAY_MS);
  }

  /** Writes a scheduled index now, or waits for the write in progress. */
  async flushIndex(): Promise<void> {
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = null;
    const source = this.indexSource;
    this.indexSource = null;
    if (source) await this.writeIndex(source());
    else await this.indexWriting;
  }

  /** Writes the document into `.import-<uuid>` (manifest last) and renames the folder into place. */
  createDocument(document: NewDocument): Promise<void> {
    const manifest = normalizeManifest(manifestSchema.parse(document.manifest));
    return this.withDocument(manifest.id, async files => {
      if (await exists(files.dir)) throw new LongTextOperationError('conflict');
      const staging = await this.stage(IMPORTING, async dir => {
        if (document.original) await writeDurable(path.join(dir, FILES.original), document.original);
        await this.writeSegmentation(dir, document, manifest);
      });
      try {
        await renameWithRetry(staging, files.dir);
      } catch (error) {
        await removeDirectory(staging);
        throw new LongTextOperationError('storage_failed', { cause: error });
      }
      this.storage = null;
    });
  }

  /**
   * Replaces the segmentation of a document (resegmenting discards its translations): `original.bin` and
   * the ledger are kept, the journal and snapshot start empty. The new folder is staged completely, then
   * swapped in with two renames; `recover` finishes a swap interrupted between them.
   */
  replaceDocument(id: string, document: Omit<NewDocument, 'original'>): Promise<void> {
    const manifest = normalizeManifest(manifestSchema.parse(document.manifest));
    if (manifest.id !== id) return Promise.reject(new LongTextOperationError('invalid_request'));
    return this.withDocument(id, async files => {
      if (!(await exists(files.dir))) throw new LongTextOperationError('not_found');
      const staging = await this.stage(STAGING, async dir => {
        for (const file of ['original', 'ledger'] as const) {
          await fs.copyFile(files.path(file), path.join(dir, FILES[file])).catch(error => {
            if (!isMissing(error)) throw error;
          });
        }
        await this.writeSegmentation(dir, document, manifest);
      });
      const trash = path.join(this.documentsDir, `${TRASH}${randomUUID()}`);
      try {
        await renameWithRetry(files.dir, trash);
      } catch (error) {
        await removeDirectory(staging);
        throw new LongTextOperationError('storage_failed', { cause: error });
      }
      try {
        await renameWithRetry(staging, files.dir);
      } catch (error) {
        try {
          await renameWithRetry(trash, files.dir);
        } catch (restoreError) {
          // <id> is now missing: keep the complete staging folder so recover() moves it into place.
          console.warn('[long-text] Could not restore the replaced document; recovery will finish the swap', restoreError);
          this.files.delete(id);
          throw new LongTextOperationError('storage_failed', { cause: error });
        }
        await removeDirectory(staging);
        throw new LongTextOperationError('storage_failed', { cause: error });
      }
      this.files.delete(id);
      this.storage = null;
      this.discard(trash);
    });
  }

  /** Renames the document folder to `.trash-<uuid>` and deletes it in the background. */
  remove(id: string): Promise<void> {
    return this.withDocument(id, async files => {
      const trash = path.join(this.documentsDir, `${TRASH}${randomUUID()}`);
      try {
        await renameWithRetry(files.dir, trash);
      } catch (error) {
        if (isMissing(error)) return;
        throw new LongTextOperationError('storage_failed', { cause: error });
      }
      this.files.delete(id);
      this.storage = null;
      this.discard(trash);
    });
  }

  /** Before quitting: writes a manifest synchronously, outside the queue; throws on failure. */
  writeManifestSync(id: string, manifest: DocumentManifest): void {
    (this.files.get(id) ?? new DocumentFiles(id, this.documentDir(id))).writeManifestSync(manifest);
  }

  /** Total size of the files of every document folder, cached for 10 s; imports and deletions refresh it. */
  async storageBytes(): Promise<number> {
    if (this.storage && this.now() - this.storage.at < STORAGE_CACHE_MS) return this.storage.bytes;
    let bytes = 0;
    const entries = await fs.readdir(this.documentsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !DOCUMENT_ID.test(entry.name)) continue;
      const dir = path.join(this.documentsDir, entry.name);
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      const stats = await Promise.all(names.map(name => fs.stat(path.join(dir, name)).catch(() => null)));
      for (const stat of stats) bytes += stat?.isFile() ? stat.size : 0;
    }
    this.storage = { bytes, at: this.now() };
    return bytes;
  }

  /** Resolves once every queued operation, background deletion and index write has settled. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values(), ...this.removals, this.indexWriting]);
  }

  /** Stops the index timer; a scheduled index write is dropped (`recover` rebuilds stale entries). */
  dispose(): void {
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = null;
    this.indexSource = null;
  }

  private writeIndex(documents: readonly DocumentSummary[]): Promise<void> {
    const text = JSON.stringify({ version: 1, documents });
    const write = this.indexWriting.then(() => io(() => writeAtomic(path.join(this.root, INDEX_FILE), text)));
    this.indexWriting = write.catch(() => undefined);
    return write;
  }

  private async readIndex(): Promise<{ cached: Map<string, DocumentSummary>; writtenAt: number }> {
    const file = path.join(this.root, INDEX_FILE);
    const cached = new Map<string, DocumentSummary>();
    try {
      const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      const parsed = indexFileSchema.safeParse(parseJson(bytes));
      if (!parsed.success) return { cached, writtenAt: -Infinity };
      for (const value of parsed.data.documents) {
        const entry = cachedSummarySchema.safeParse(value);
        if (entry.success) cached.set(entry.data.id, entry.data as unknown as DocumentSummary);
      }
      return { cached, writtenAt: stat.mtimeMs };
    } catch {
      return { cached, writtenAt: -Infinity };
    }
  }

  private async settleStaging(name: string): Promise<void> {
    const dir = path.join(this.documentsDir, name);
    const read = await readManifestFile(path.join(dir, FILES.manifest)).catch(() => null);
    if (read && 'manifest' in read) {
      const target = path.join(this.documentsDir, read.manifest.id);
      if (!(await exists(target))) {
        try {
          return await renameWithRetry(dir, target);
        } catch (error) {
          console.warn('[long-text] Could not restore a staged document', error);
          return; // Kept: it may be the only copy, and the next startup tries again.
        }
      }
    }
    await removeDirectory(dir);
  }

  private async stage(prefix: string, write: (dir: string) => Promise<void>): Promise<string> {
    const dir = path.join(this.documentsDir, `${prefix}${randomUUID()}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await write(dir);
      return dir;
    } catch (error) {
      await removeDirectory(dir);
      throw error instanceof LongTextOperationError ? error : new LongTextOperationError('storage_failed', { cause: error });
    }
  }

  /** The manifest goes last: a staging folder with a readable manifest is complete. */
  private async writeSegmentation(dir: string, document: Omit<NewDocument, 'original' | 'manifest'>, manifest: DocumentManifest): Promise<void> {
    await writeDurable(path.join(dir, FILES.source), document.source);
    await writeRecords(path.join(dir, FILES.segments), document.records);
    await writeDurable(path.join(dir, FILES.pages), JSON.stringify(document.pages));
    await writeDurable(path.join(dir, FILES.refs), JSON.stringify(document.refs));
    await writeDurable(path.join(dir, FILES.manifest), JSON.stringify(manifest));
  }

  private discard(dir: string): void {
    const removal = removeDirectory(dir);
    this.removals.add(removal);
    void removal.then(() => this.removals.delete(removal));
  }
}
