import { createHash } from 'node:crypto';
import {
  LONG_TEXT_LIMITS, SEGMENT_KINDS, VERBATIM_KINDS,
  type Counts, type DocumentDetail, type DocumentSummary, type FlagCode, type LanguageTag, type LedgerEntry, type LongTextFormat,
  type LongTextSettings, type PageInfo, type PageResult, type QueryFilter, type QueryResult, type RunView, type SegmentRow, type Usage,
} from '../../../src/long-text/contract';
import { emptyUsage, formatLines, segmentLine, sumUsage, usageLine } from '../../../src/long-text/journal';
import {
  cutUtf16, isTranslatable, pendingState, stateOf,
  type CandidateFilter, type DocumentManifest, type DocumentPort, type Flag, type JournalLine, type PageRecord, type RunScope,
  type SegmentTable, type TranslationRecord, type TranslationState, type UsageDelta,
} from '../../../src/long-text/model';
import { displayAt as displayOf } from '../../../src/long-text/segments';
import {
  COMPACT_JOURNAL_BYTES, COMPACT_JOURNAL_LINES, compactionSnapshot, effectiveLanguages, interruptRuns, LongTextOperationError,
  manifestSchema, manifestSummary, normalizeManifest, runRecordView,
  type DocumentFiles, type LongTextRepository, type StoredDocument, type Unavailable,
} from './repository';

/**
 * A document held in memory (design §6.10 “内存”): S, the segment table, one translation record per
 * segment, counts and page statistics kept up to date, the in-flight set, and the reads the reader needs
 * (pages, filters, search, attention navigation). It implements `DocumentPort` for runs and
 * retranslations. Every change goes through the document's serial queue: rev check, one journal append,
 * then memory. Nothing here sends events by itself; callers call `emit` after a change.
 */

/** Length-ratio reference of a document (`RatioReference` in `quality.ts`). */
export interface RatioTracker {
  readonly value: number;
  push(ratio: number): void;
}
export interface RatioModel {
  /** A fresh reference for the effective languages. */
  create(languages: { source: LanguageTag; target: LanguageTag }): RatioTracker;
  /** The length ratio of segment `index`'s model translation, or null when it does not count (§7). */
  sample(document: LoadedDocument, index: number): number | null;
}
export interface LoadedDocumentOptions {
  /** On open and on a language change the reference is rebuilt from the latest 200 model translations. */
  ratio: RatioModel;
  /** Receives `emit`; the service merges, numbers and sends the change events. */
  onSegments?: (range: { start: number; end: number }) => void;
  now?: () => number;
}

const MANIFEST_DELAY_MS = 2_000;
const VERBATIM_SOURCE_CHARS = 2_000;
const RATIO_SAMPLES = 200;

/** Failed, or a flag not dismissed while unlocked; a locked segment only for `markup_missing` (§7). */
export function needsAttention(record: TranslationState | undefined): boolean {
  if (!record) return false;
  if (record.status === 'failed') return true;
  return record.flags.some(flag => !flag.dismissed && (!record.locked || flag.code === 'markup_missing'));
}

/** Search compares NFKC, lower-cased text. */
export const searchKey = (text: string) => text.normalize('NFKC').toLowerCase();

/** sha256 of the settings that change a translation, with the effective source language (§6.10). */
export function settingsDigest(manifest: Pick<DocumentManifest, 'settings' | 'detected'>): string {
  const { settings } = manifest;
  const { source, target } = effectiveLanguages(manifest);
  const digested = { source, target, style: settings.style, instructions: settings.instructions, knowledge: settings.knowledge, profileId: settings.profileId };
  return createHash('sha256').update(JSON.stringify(digested)).digest('hex');
}

type Change = { state: TranslationState; previous: TranslationState | null } | null;

export class LoadedDocument implements DocumentPort {
  readonly id: string;
  readonly format: LongTextFormat;
  readonly table: SegmentTable;
  /** S, with its original line endings. */
  readonly source: string;
  readonly pages: readonly PageRecord[];
  readonly refs: ReadonlySet<string>;
  /** The ledger entries; `ledger.ts` edits them and calls `saveLedger`. */
  ledger: LedgerEntry[];
  readonly journalIssues: number;

  private manifestState: DocumentManifest;
  private readonly records: Array<TranslationRecord | undefined>;
  private readonly inFlight = new Set<number>();
  private counts: Counts = { translatable: 0, done: 0, pending: 0, failed: 0, attention: 0, edited: 0, locked: 0 };
  private readonly pageTranslatable: Int32Array;
  private readonly pageDone: Int32Array;
  private readonly pageAttention: Int32Array;
  private readonly pageInFlight: Int32Array;
  private usage: Usage;
  private readonly runUsage: Map<string, Usage>;
  private seq: number;
  private journalBytes: number;
  private journalLines: number;
  /** The journal size past which the next write compacts; raised after a failed compaction. */
  private compactAt = { bytes: COMPACT_JOURNAL_BYTES, lines: COMPACT_JOURNAL_LINES };
  private ratioTracker: RatioTracker;
  private activeRun: (() => RunView) | null = null;
  private sourceKeys: string[] | null = null;
  private readonly targetKeys = new Map<number, string>();
  private manifestTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  /**
   * Loads a document. Runs a previous session left running or pausing become interrupted: a run only
   * exists while its document is loaded, so none can be live here.
   */
  static async open(repository: LongTextRepository, id: string, options: LoadedDocumentOptions): Promise<LoadedDocument | Unavailable> {
    const stored = await repository.withDocument(id, files => files.load());
    if ('unavailable' in stored) return stored;
    const document = new LoadedDocument(repository, stored, options);
    if (interruptRuns(document.manifestState)) await document.saveManifest();
    return document;
  }

  private constructor(private readonly repository: LongTextRepository, stored: StoredDocument, private readonly options: LoadedDocumentOptions) {
    const { manifest, table, replay } = stored;
    this.id = manifest.id;
    this.format = manifest.format;
    this.table = table;
    this.source = stored.source;
    this.pages = stored.pages;
    this.refs = new Set(stored.refs);
    this.ledger = stored.ledger;
    this.journalIssues = stored.issues;
    this.manifestState = manifest;
    this.now = options.now ?? Date.now;
    this.records = new Array<TranslationRecord | undefined>(table.count);
    for (const [index, record] of replay.records) this.records[index] = record;
    this.usage = replay.usage;
    this.runUsage = replay.runUsage;
    this.seq = replay.lastSeq;
    this.journalBytes = stored.journal.bytes;
    this.journalLines = stored.journal.lines;
    const pages = stored.pages.length;
    this.pageTranslatable = new Int32Array(pages);
    this.pageDone = new Int32Array(pages);
    this.pageAttention = new Int32Array(pages);
    this.pageInFlight = new Int32Array(pages);
    for (let index = 0; index < table.count; index++) {
      if (!this.isTranslatable(index)) continue;
      this.counts.translatable++;
      this.pageTranslatable[table.page[index]]++;
      this.account(index, this.records[index], 1);
    }
    this.ratioTracker = this.createRatio();
  }

  get manifest(): Readonly<DocumentManifest> {
    return this.manifestState;
  }

  get ratio(): RatioTracker {
    return this.ratioTracker;
  }

  settings(): LongTextSettings {
    return this.manifestState.settings;
  }

  languages(): { source: LanguageTag; target: LanguageTag } {
    return effectiveLanguages(this.manifestState);
  }

  displayAt(index: number): string {
    return displayOf(this.source, this.table, index);
  }

  translationAt(index: number): TranslationRecord | undefined {
    return this.records[index];
  }

  rev(index: number): number {
    return this.records[index]?.rev ?? 0;
  }

  pageOf(index: number): number {
    return this.table.page[index];
  }

  isTranslatable(index: number): boolean {
    return isTranslatable(this.table, index);
  }

  // Runs and retranslations (DocumentPort).

  candidates(page: number, filter: CandidateFilter): number[] {
    const record = this.pages[page];
    const result: number[] = [];
    if (record) for (let index = record.start; index <= record.end; index++) if (this.isCandidate(index, filter)) result.push(index);
    return result;
  }

  pagesWithCandidates(scope: RunScope): number[] {
    const result: number[] = [];
    this.pages.forEach((record, page) => {
      if (this.pageTranslatable[page] === this.pageDone[page]) return;
      for (let index = record.start; index <= record.end; index++) {
        if (!this.isCandidate(index, scope)) continue;
        result.push(page);
        return;
      }
    });
    return result;
  }

  markInFlight(indices: readonly number[]): boolean {
    if (indices.some(index => this.inFlight.has(index))) return false;
    for (const index of indices) {
      if (this.inFlight.has(index)) continue;
      this.inFlight.add(index);
      this.pageInFlight[this.table.page[index]]++;
    }
    return true;
  }

  releaseInFlight(indices: readonly number[]): void {
    for (const index of indices) if (this.inFlight.delete(index)) this.pageInFlight[this.table.page[index]]--;
  }

  commit(records: readonly TranslationRecord[], usage: UsageDelta | null, options: { skipLocked: boolean }): Promise<number[]> {
    return this.repository.withDocument(this.id, async files => {
      const accepted: TranslationRecord[] = [];
      const seen = new Set<number>();
      for (const record of records) {
        const current = this.records[record.index];
        if (!this.isTranslatable(record.index) || seen.has(record.index)) continue;
        if ((current?.rev ?? 0) !== record.rev - 1 || (options.skipLocked && current?.locked)) continue;
        seen.add(record.index);
        accepted.push(record);
      }
      await this.write(files, accepted, usage);
      return accepted.map(record => record.index);
    });
  }

  clear(indices: readonly number[], runId: string | null): Promise<number[]> {
    return this.repository.withDocument(this.id, files => this.reset(files, indices, false, runId));
  }

  emit(range: { start: number; end: number }): void {
    this.options.onSegments?.(range);
  }

  /** The view of the run in memory while one exists; otherwise the latest run record is shown. */
  attachRun(view: (() => RunView) | null): void {
    this.activeRun = view;
  }

  // Single-segment commands. Each checks the rev, refuses a segment in flight with `busy`, and is one undo step.

  /**
   * Saves the user's translation (§5.2.2): done, origin user, locked, with `flags` (the `markup_missing`
   * check) as its only flags. An empty text clears the translation instead.
   */
  edit(index: number, rev: number, text: string, flags: readonly Flag[] = []): Promise<SegmentRow> {
    const target = text.replace(/\r\n?/g, '\n').trim();
    return this.change(index, rev, record => {
      if (!target) return record.status === 'pending' ? null : { state: pendingState(), previous: stateOf(record) };
      const state: TranslationState = { status: 'done', target, origin: 'user', locked: true, flags: flags.map(flag => ({ ...flag })), failure: null };
      return { state, previous: stateOf(record) };
    });
  }

  /** Locks or unlocks a translated segment; the undo step stays what it was. */
  setLocked(index: number, rev: number, locked: boolean): Promise<SegmentRow> {
    return this.change(index, rev, record => {
      if (record.status !== 'done') throw new LongTextOperationError('invalid_request');
      return record.locked === locked ? null : { state: { ...stateOf(record), locked }, previous: record.previous };
    });
  }

  undo(index: number, rev: number): Promise<SegmentRow> {
    return this.change(index, rev, record => (record.previous ? { state: record.previous, previous: null } : null));
  }

  dismissFlag(index: number, rev: number, code: FlagCode): Promise<SegmentRow> {
    return this.change(index, rev, record => {
      if (!record.flags.some(flag => flag.code === code && !flag.dismissed)) return null;
      const flags = record.flags.map(flag => (flag.code === code ? { ...flag, dismissed: true } : flag));
      return { state: { ...stateOf(record), flags }, previous: record.previous };
    });
  }

  /** The `clear` command: every translated or failed segment back to pending, locked ones too unless `keepLocked`. */
  clearAll(keepLocked: boolean): Promise<number[]> {
    return this.repository.withDocument(this.id, files => {
      const all: number[] = [];
      for (let index = 0; index < this.table.count; index++) if (this.records[index]) all.push(index);
      return this.reset(files, all, !keepLocked, null);
    });
  }

  // Reads for the renderer.

  row(index: number): SegmentRow {
    const { table } = this;
    const record = this.records[index];
    const translatable = this.isTranslatable(index);
    const verbatimKind = table.verbatimKind[index];
    const source = this.displayAt(index);
    return {
      index, ordinal: table.ordinal[index], page: table.page[index], rev: record?.rev ?? 0,
      kind: SEGMENT_KINDS[table.kind[index]], level: table.level[index], marker: table.markers.get(index) ?? '',
      ...(verbatimKind ? { verbatimKind: VERBATIM_KINDS[verbatimKind - 1] } : {}),
      translatable,
      source: translatable ? source : cutUtf16(source, VERBATIM_SOURCE_CHARS),
      target: record?.target ?? null,
      status: this.inFlight.has(index) ? 'translating' : record?.status ?? 'pending',
      origin: record?.origin ?? null,
      locked: record?.locked ?? false,
      flags: (record?.flags ?? []).filter(flag => !flag.dismissed).map(({ code, detail }) => (detail === undefined ? { code } : { code, detail })),
      failure: record?.failure ? { ...record.failure } : null,
      canUndo: Boolean(record?.previous),
    };
  }

  pageInfo(page: number): PageInfo {
    const { start, end, title } = this.pages[page];
    return {
      index: page, start, end, title,
      translatable: this.pageTranslatable[page], done: this.pageDone[page], attention: this.pageAttention[page], inFlight: this.pageInFlight[page] > 0,
    };
  }

  /** Every row of the page, verbatim blocks included; rows in flight read as `translating`. */
  readPage(page: number): PageResult {
    const record = this.pages[page];
    if (!record) throw new LongTextOperationError('invalid_request');
    const rows: SegmentRow[] = [];
    for (let index = record.start; index <= record.end; index++) rows.push(this.row(index));
    return { documentId: this.id, revision: this.manifestState.revision, page: this.pageInfo(page), rows };
  }

  /**
   * Translatable segments matching the filter, in index order. “Untranslated” is pending or failed,
   * “edited” is origin user; search matches the display source or target, NFKC and case-insensitive,
   * and stops at 5,000 results (`truncated`).
   */
  query(filter: QueryFilter, offset: number, limit: number): QueryResult {
    const matches = this.predicate(filter);
    const cap = filter.kind === 'search' ? LONG_TEXT_LIMITS.searchResults : Infinity;
    const found: number[] = [];
    let truncated = false;
    for (let index = 0; index < this.table.count; index++) {
      if (!this.isTranslatable(index) || !matches(index)) continue;
      if (found.length === cap) {
        truncated = true;
        break;
      }
      found.push(index);
    }
    return { total: found.length, offset, rows: found.slice(offset, offset + limit).map(index => this.row(index)), truncated };
  }

  /** The next or previous segment needing attention after `from`, continuing from the other end (`wrapped`). */
  locate(from: number, direction: 'next' | 'previous'): { index: number; page: number; wrapped: boolean } | null {
    const { count } = this.table;
    if (from >= count) throw new LongTextOperationError('invalid_request');
    const step = direction === 'next' ? 1 : -1;
    for (let k = 1; k <= count; k++) {
      const raw = from + step * k;
      const index = (raw + count) % count;
      if (needsAttention(this.records[index])) return { index, page: this.table.page[index], wrapped: raw !== index };
    }
    return null;
  }

  summary(): DocumentSummary {
    const manifest = this.manifestState;
    const latest = manifest.runs[0];
    const active = this.activeRun?.();
    return {
      ...manifestSummary(manifest, this.journalIssues),
      counts: { ...this.counts },
      usage: { ...this.usage },
      run: active ?? (latest ? runRecordView(latest, manifest.settings.pace, this.runUsage.get(latest.id) ?? emptyUsage()) : null),
    };
  }

  detail(): DocumentDetail {
    const manifest = this.manifestState;
    return {
      ...this.summary(),
      settings: structuredClone(manifest.settings),
      detected: { ...manifest.detected },
      structure: manifest.structure && { ...manifest.structure },
      pages: this.pages.map((_, page) => this.pageInfo(page)),
      ledger: { total: this.ledger.length, confirmed: this.ledger.filter(entry => entry.confirmed).length },
      sample: manifest.sample && { indices: [...manifest.sample.indices], stale: manifest.sample.settingsDigest !== settingsDigest(manifest) },
      exportFolder: manifest.exportFolder,
    };
  }

  // Manifest and ledger.

  /**
   * Applies `change` to a copy of the manifest, checks it, and makes it current; `bump` raises `revision`
   * (what `expectedRevision` guards). Otherwise saved within 2 s; with `immediate` (run status changes,
   * user commands) the copy is built at the head of the document's queue, written, and only then made
   * current, so a failed write changes nothing, unless `keepOnFailure` keeps the change in memory and
   * saves it again later (best-effort records). A change of the effective languages starts a fresh
   * length-ratio reference.
   */
  async updateManifest(
    change: (manifest: DocumentManifest) => void,
    options: { bump?: boolean; immediate?: boolean; keepOnFailure?: boolean } = {},
  ): Promise<void> {
    const draftNext = (): DocumentManifest => {
      const draft = structuredClone(this.manifestState);
      change(draft);
      if (options.bump) draft.revision++;
      draft.updatedAt = this.now();
      const parsed = manifestSchema.safeParse(draft);
      if (!parsed.success) throw new LongTextOperationError('internal', { cause: parsed.error });
      return normalizeManifest(parsed.data);
    };
    const makeCurrent = (next: DocumentManifest) => {
      const before = this.languages();
      this.manifestState = next;
      const after = this.languages();
      if (before.source !== after.source || before.target !== after.target) this.ratioTracker = this.createRatio();
    };
    if (!options.immediate) {
      makeCurrent(draftNext());
      this.scheduleManifest();
      return;
    }
    await this.repository.withDocument(this.id, async files => {
      // Built from the state current at the head of the queue, so concurrent updates are not lost.
      const next = draftNext();
      try {
        await files.writeManifest({ ...next, counts: { ...this.counts }, usage: { ...this.usage } });
      } catch (error) {
        if (options.keepOnFailure) {
          makeCurrent(next);
          this.scheduleManifest();
        }
        throw error;
      }
      this.cancelManifestTimer();
      makeCurrent(next);
    });
  }

  /** Writes the manifest now, with the current counts and usage as its caches. */
  saveManifest(): Promise<void> {
    this.cancelManifestTimer();
    return this.repository.withDocument(this.id, files => files.writeManifest(this.persistedManifest()));
  }

  /** Writes a pending manifest change and waits for queued writes; call before dropping the document from memory. */
  async close(): Promise<void> {
    if (this.manifestTimer) await this.saveManifest();
    else await this.repository.withDocument(this.id, async () => undefined);
  }

  /** Before quitting: writes a pending manifest change synchronously; failures are ignored (startup recovery is authoritative). */
  flushManifestSync(): void {
    if (!this.manifestTimer) return;
    this.cancelManifestTimer();
    try {
      this.repository.writeManifestSync(this.id, this.persistedManifest());
    } catch {
      // Nothing more can be done while quitting.
    }
  }

  saveLedger(): Promise<void> {
    return this.repository.withDocument(this.id, files => files.writeLedger(this.ledger));
  }

  // Internals.

  private isCandidate(index: number, filter: CandidateFilter): boolean {
    if (!this.isTranslatable(index) || this.inFlight.has(index)) return false;
    const record = this.records[index];
    if (record && (record.status === 'done' || record.locked)) return false;
    if (filter.minIndex !== undefined && index < filter.minIndex) return false;
    if (filter.sample && !filter.sample.has(index)) return false;
    return !filter.skip?.(index);
  }

  private account(index: number, record: TranslationRecord | undefined, sign: 1 | -1): void {
    const { counts } = this;
    const status = record?.status ?? 'pending';
    const page = this.table.page[index];
    counts[status] += sign;
    if (status === 'done') this.pageDone[page] += sign;
    if (record?.origin === 'user') counts.edited += sign;
    if (record?.locked) counts.locked += sign;
    if (needsAttention(record)) {
      counts.attention += sign;
      this.pageAttention[page] += sign;
    }
  }

  private setRecord(record: TranslationRecord): void {
    this.account(record.index, this.records[record.index], -1);
    this.records[record.index] = record;
    this.account(record.index, record, 1);
    this.targetKeys.delete(record.index);
  }

  private change(index: number, rev: number, next: (record: TranslationRecord) => Change): Promise<SegmentRow> {
    if (!this.isTranslatable(index)) return Promise.reject(new LongTextOperationError('invalid_request'));
    return this.repository.withDocument(this.id, async files => {
      if (this.inFlight.has(index)) throw new LongTextOperationError('busy');
      const current = this.records[index] ?? { index, rev: 0, ...pendingState(), previous: null, runId: null, at: 0 };
      if (current.rev !== rev) throw new LongTextOperationError('revision_conflict');
      const change = next(current);
      if (change) await this.write(files, [{ index, rev: rev + 1, ...change.state, previous: change.previous, runId: null, at: this.now() }], null);
      return this.row(index);
    });
  }

  /** Back to pending, keeping the old state as the undo step; segments in flight, pending, or locked (unless included) are skipped. */
  private async reset(files: DocumentFiles, indices: Iterable<number>, includeLocked: boolean, runId: string | null): Promise<number[]> {
    const at = this.now();
    const records: TranslationRecord[] = [];
    const seen = new Set<number>();
    for (const index of indices) {
      const current = this.records[index];
      if (!current || current.status === 'pending' || seen.has(index) || this.inFlight.has(index) || (current.locked && !includeLocked)) continue;
      seen.add(index);
      records.push({ index, rev: current.rev + 1, ...pendingState(), previous: stateOf(current), runId, at });
    }
    await this.write(files, records, null);
    return records.map(record => record.index);
  }

  /**
   * One journal append for the records and the usage line, then memory. Sequence numbers that may have
   * reached the disk are never reused, even when the append fails.
   */
  private async write(files: DocumentFiles, records: readonly TranslationRecord[], usage: UsageDelta | null): Promise<void> {
    if (!records.length && !usage) return;
    let q = this.seq;
    const lines: JournalLine[] = records.map(record => segmentLine(++q, record));
    if (usage) lines.push(usageLine(++q, usage));
    const text = formatLines(lines);
    this.seq = q;
    await files.appendJournal(text, this.journalBytes);
    this.journalBytes += Buffer.byteLength(text);
    this.journalLines += lines.length;
    for (const record of records) this.setRecord(record);
    if (usage) {
      this.usage = sumUsage(this.usage, usage.usage);
      if (usage.runId !== null) this.runUsage.set(usage.runId, sumUsage(this.runUsage.get(usage.runId) ?? emptyUsage(), usage.usage));
    }
    if (records.length) this.manifestState.updatedAt = this.now();
    this.scheduleManifest();
    if (this.journalBytes > this.compactAt.bytes || this.journalLines > this.compactAt.lines) await this.compact(files);
  }

  private async compact(files: DocumentFiles): Promise<void> {
    try {
      // A consistent view: records are replaced, never changed, and compaction runs on the document's queue.
      const state = { seq: this.seq, records: this.records.slice(), usage: { ...this.usage }, runUsage: new Map(this.runUsage) };
      await files.compact(compactionSnapshot(state, this.manifestState.runs));
      this.journalBytes = 0;
      this.journalLines = 0;
      this.compactAt = { bytes: COMPACT_JOURNAL_BYTES, lines: COMPACT_JOURNAL_LINES };
    } catch (error) {
      // The appended lines are safe in the journal. Retry once it has grown by another full limit, so a
      // journal.log held open elsewhere (no share-delete) does not rewrite the whole snapshot on every commit.
      this.compactAt = { bytes: this.journalBytes + COMPACT_JOURNAL_BYTES, lines: this.journalLines + COMPACT_JOURNAL_LINES };
      console.warn('[long-text] Could not compact the journal', error);
    }
  }

  private predicate(filter: QueryFilter): (index: number) => boolean {
    switch (filter.kind) {
      case 'attention': return index => needsAttention(this.records[index]);
      case 'untranslated': return index => this.records[index]?.status !== 'done';
      case 'edited': return index => this.records[index]?.origin === 'user';
      case 'search': {
        const needle = searchKey(filter.text.trim());
        const sources = this.searchSources();
        return index => sources[index].includes(needle) || this.searchTarget(index).includes(needle);
      }
    }
  }

  /** Normalized display sources, built on the first search. */
  private searchSources(): string[] {
    if (!this.sourceKeys) {
      this.sourceKeys = new Array<string>(this.table.count);
      for (let index = 0; index < this.table.count; index++) this.sourceKeys[index] = this.isTranslatable(index) ? searchKey(this.displayAt(index)) : '';
    }
    return this.sourceKeys;
  }

  private searchTarget(index: number): string {
    const target = this.records[index]?.target;
    if (!target) return '';
    let key = this.targetKeys.get(index);
    if (key === undefined) {
      key = searchKey(target);
      this.targetKeys.set(index, key);
    }
    return key;
  }

  /** Pushes the ratios of the latest model translations, oldest first. */
  private createRatio(): RatioTracker {
    const { ratio } = this.options;
    const tracker = ratio.create(this.languages());
    const latest = this.records
      .filter((record): record is TranslationRecord => record?.status === 'done' && record.origin === 'model')
      .sort((a, b) => b.at - a.at || b.index - a.index);
    const samples: number[] = [];
    for (const record of latest) {
      if (samples.length === RATIO_SAMPLES) break;
      const value = ratio.sample(this, record.index);
      if (value !== null) samples.push(value);
    }
    for (let k = samples.length - 1; k >= 0; k--) tracker.push(samples[k]);
    return tracker;
  }

  private persistedManifest(): DocumentManifest {
    return { ...this.manifestState, counts: { ...this.counts }, usage: { ...this.usage } };
  }

  private scheduleManifest(): void {
    if (this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      this.saveManifest().catch(error => console.warn('[long-text] Could not save the manifest', error));
    }, MANIFEST_DELAY_MS);
  }

  private cancelManifestTimer(): void {
    if (this.manifestTimer) clearTimeout(this.manifestTimer);
    this.manifestTimer = null;
  }
}
