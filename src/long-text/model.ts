import type { ModelErrorCategory } from '../lib/model-error-category';
import type {
  Counts, FlagCode, FlagDetail, LanguageTag, LongTextFormat, LongTextSettings, RunKind, RunStatus, RunView,
  SegmentFailureCode, SegmentKind, Style, SupportedEncoding, TxtSplit, Usage, VerbatimKind,
} from './contract';

/** Internal model shared by the main process and the pure `src/long-text` modules. */

export type LineEnding = '\n' | '\r\n' | '\r';

/** One line of `segments.jsonl`, written once at import or resegmentation. */
export interface SegmentRecord {
  i: number;                 // global index, verbatim blocks included
  o: number;                 // ordinal among translatable segments, from 1; 0 for verbatim blocks
  k: SegmentKind;
  l: number;                 // heading level / list depth / quote depth
  m: string;                 // display marker: '•' '1.' '☐' '☑' '[^1]' or ''
  t: 0 | 1;                  // translatable
  r: number[];               // line content ranges, flat [s0,e0,s1,e1,…], UTF-16 offsets into S, end exclusive
  b: number[];               // break after each line but the last: 0 soft, 1 hard, 2 soft without joiner (TXT unwrap of CJK text wrapped by count); length r.length/2 − 1
  cp: string;                // continuation prefix
  hb: '' | '  ' | '\\';      // how the source wrote hard breaks
  g: number;                 // group shared by the parts of a split segment; i when not split
  n: number;                 // estimated source tokens
  ch: 0 | 1;                 // chapter heading
  pg: number;                // page
  vk?: VerbatimKind;
}

/** `SegmentTable.kind` stores the index into `SEGMENT_KINDS`; `verbatimKind` stores the index into
 * `VERBATIM_KINDS` plus one, and 0 for translatable segments. */
export const SEGMENT_FLAG = Object.freeze({ translatable: 1, chapter: 2, hardBreakBackslash: 4, hardBreakSpaces: 8 });

/** Compact in-memory form of every `SegmentRecord` of a document (up to 200,000). */
export interface SegmentTable {
  count: number;
  kind: Uint8Array; level: Uint8Array; flags: Uint8Array;   // flags: SEGMENT_FLAG bits
  ordinal: Int32Array; group: Int32Array; tokens: Uint32Array; page: Int32Array; verbatimKind: Uint8Array;
  lineStart: Int32Array; lineCount: Int32Array;             // segment i owns lines lineStart[i] … lineStart[i] + lineCount[i] − 1
  lineRanges: Int32Array;                                   // line j spans [lineRanges[2j], lineRanges[2j + 1])
  lineBreaks: Uint8Array;                                   // `b` between line j and line j + 1 of the same segment (0 soft, 1 hard, 2 soft without joiner); 0 after a segment's last line
  markers: Map<number, string>; prefixes: Map<number, string>;   // only non-empty `m` / `cp`
}

/** One entry of `pages.json`: inclusive segment index range. */
export interface PageRecord { start: number; end: number; title: string | null }

/** Inline token of a projected display text: `<xN/>` atoms are kept verbatim, `<mN>…</mN>` pairs
 * keep their ends and have the inner text translated. */
export type InlineMark =
  | { id: number; atom: true; kind: 'code' | 'url' | 'html' | 'math' | 'footnote' | 'escape' | 'entity' | 'break' | 'sep' | 'literal'; raw: string }
  | { id: number; atom: false; kind: 'link' | 'image' | 'format'; open: string; close: string; inner: string; parent: number | null };

/** A stored quality flag; dismissed flags stay stored but leave `SegmentRow.flags`. */
export interface Flag { code: FlagCode; dismissed: boolean; detail?: FlagDetail }
export interface SegmentFailure { code: SegmentFailureCode; category?: ModelErrorCategory }

/** The content of a segment's translation. `translating` exists only in memory (the in-flight set). */
export interface TranslationState {
  status: 'pending' | 'done' | 'failed';
  target: string | null;
  origin: 'model' | 'user' | null;
  locked: boolean;
  flags: Flag[];
  failure: SegmentFailure | null;
}
export const pendingState = (): TranslationState => ({ status: 'pending', target: null, origin: null, locked: false, flags: [], failure: null });
/** The `TranslationState` fields of a record, without the rest; pending when there is none. */
export const stateOf = (record: TranslationState | undefined): TranslationState => (record
  ? { status: record.status, target: record.target, origin: record.origin, locked: record.locked, flags: record.flags, failure: record.failure }
  : pendingState());

/** Whether segment `index` exists and is translatable. */
export const isTranslatable = (table: Pick<SegmentTable, 'count' | 'flags'>, index: number): boolean =>
  index >= 0 && index < table.count && (table.flags[index] & SEGMENT_FLAG.translatable) !== 0;

/** At most `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/** The full current state of one segment, as replayed from the journal. Absent means pending at rev 0. */
export interface TranslationRecord extends TranslationState {
  index: number;
  rev: number;                               // +1 on every change
  previous: TranslationState | null;         // what undo restores
  runId: string | null;
  at: number;
}

/** Journal lines (`journal.log`, JSONL). `journal.ts` owns their schema and the replay. */
export type JournalFlagJson = [FlagCode, 0 | 1] | [FlagCode, 0 | 1, FlagDetail];
export type JournalFailureJson = [SegmentFailureCode] | [SegmentFailureCode, ModelErrorCategory];
export interface JournalStateJson { s: 'p' | 'd' | 'f'; x: string | null; o: 'm' | 'u' | null; l: 0 | 1; f: JournalFlagJson[]; e: JournalFailureJson | null }
/** The complete state of one segment; replay keeps the line with the largest `q` per `i`. */
export interface JournalSegmentLine extends JournalStateJson { q: number; t: 's'; i: number; v: number; p: JournalStateJson | null; r: string | null; a: number }
/** One request's usage; replay sums them per document and per run. */
export interface JournalUsageLine { q: number; t: 'u'; r: string | null; in: number; out: number; c: number; n: number; fail: number; unk: number }
export type JournalLine = JournalSegmentLine | JournalUsageLine;
export type TranslationRecordJson = Omit<JournalSegmentLine, 'q' | 't'>;
/** `journal.snapshot.json`: replay applies only journal lines with `q > seq` on top of it. */
export interface JournalSnapshot { version: 1; seq: number; records: Record<string, TranslationRecordJson>; usage: Usage; runUsage: Record<string, Usage> }

export interface RunRecord {
  id: string; kind: RunKind; status: RunStatus; startedAt: number; endedAt?: number;
  settingsDigest: string;
  model: { profileId: string; modelKey: string; label: string };   // never the endpoint or the key
  total: number; done: number; failed: number; deferred: number; error?: RunView['error'];
}

/** `manifest.json`. `settingsDigest = sha256(JSON.stringify({ source: effective source, target, style,
 * instructions, knowledge, profileId }))`. */
export interface DocumentManifest {
  schemaVersion: 1; id: string; revision: number; createdAt: number; updatedAt: number;
  name: string; format: LongTextFormat;
  source: { kind: 'file'; path: string; size: number; mtimeMs: number; sha256: string } | { kind: 'paste' };
  encoding: { name: SupportedEncoding; confidence: 'high' | 'low'; confirmed: boolean; lineEnding: LineEnding } | null;
  lineEnding: LineEnding;
  structure: { txtSplit: TxtSplit; resolved: 'line' | 'unwrap' } | null;
  detected: { sourceLanguage: LanguageTag; style: Style };
  stats: { characters: number; segments: number; translatable: number; pages: number; sourceTokens: number };
  settings: LongTextSettings;
  counts: Counts; usage: Usage;              // caches; a loaded document trusts the replay
  fullRunStarted: boolean;
  sample: { indices: number[]; settingsDigest: string; at: number } | null;
  runs: RunRecord[];                          // the latest 20
  exportFolder: string | null;               // written only by chooseExportFolder
  exports: Array<{ path: string; name: string; mode: 'target' | 'bilingual'; at: number }>;   // the latest 10
}

/** Which segments a run may translate: `minIndex` for "from here" runs, `sample` for sample runs. */
export interface RunScope { minIndex?: number; sample?: ReadonlySet<number> }
export interface CandidateFilter extends RunScope {
  /** Run-local exclusions, e.g. deferred segments and segments out of solo attempts. */
  skip?: (index: number) => boolean;
}
/** One request's usage, appended as a journal usage line together with the commit it belongs to. */
export interface UsageDelta { runId: string | null; usage: Usage }

/**
 * What a run or a single-segment retranslation needs from a loaded document. `document-state.ts`
 * implements it; `runner.ts` depends on nothing else of the document.
 *
 * Changes never emit events by themselves: the caller calls `emit` once after a dispatch, a release,
 * a commit or a clear.
 */
export interface DocumentPort {
  readonly id: string;
  readonly format: LongTextFormat;
  readonly table: SegmentTable;
  /** Normalized link reference labels found at import; every `project` call passes them as `refs`. */
  readonly refs: ReadonlySet<string>;
  /** Read live, so settings changed during a run apply from the next batch. */
  settings(): LongTextSettings;
  /** Effective languages: `auto` resolved to the detected source language. */
  languages(): { source: LanguageTag; target: LanguageTag };
  /** Recent length ratios of model translations (`RatioReference` in `quality.ts`). */
  readonly ratio: { readonly value: number; push(ratio: number): void };
  /**
   * Translatable segments of `page` whose status is pending or failed, unlocked, not in flight and
   * inside the filter, in index order.
   */
  candidates(page: number, filter: CandidateFilter): number[];
  /** Pages, ascending, that have at least one candidate inside `scope`. */
  pagesWithCandidates(scope: RunScope): number[];
  /** Marks all `indices` in flight, or none and returns false when any of them already is. */
  markInFlight(indices: readonly number[]): boolean;
  releaseInFlight(indices: readonly number[]): void;
  rev(index: number): number;
  displayAt(index: number): string;
  translationAt(index: number): TranslationRecord | undefined;
  pageOf(index: number): number;
  /**
   * Appends the records and the usage line in one write on the document's serial queue, then updates
   * memory, counts and page statistics. Each record carries its new `rev`; a record is skipped when the
   * segment's current rev is not `rev − 1`, or when `skipLocked` is set and the segment is now locked.
   * Resolves with the indices written; rejects, changing nothing, when the write fails.
   */
  commit(records: readonly TranslationRecord[], usage: UsageDelta | null, options: { skipLocked: boolean }): Promise<number[]>;
  /**
   * Resets each listed segment that is done or failed, and neither locked nor in flight, to pending,
   * keeping the old version as `previous`, in one write. Resolves with the indices reset.
   */
  clear(indices: readonly number[], runId: string | null): Promise<number[]>;
  /** Sends one `segments` change event for the inclusive index range. */
  emit(range: { start: number; end: number }): void;
}
