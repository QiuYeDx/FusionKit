import { z } from 'zod';
import { MODEL_ERROR_CATEGORIES } from '../lib/model-error-category';
import { FLAG_CODES, indexSchema, REPAIR_KINDS, SEGMENT_FAILURE_CODES, type Usage } from './contract';
import type {
  JournalLine, JournalSegmentLine, JournalSnapshot, JournalStateJson, JournalUsageLine, TranslationRecord,
  TranslationRecordJson, TranslationState, UsageDelta,
} from './model';

/**
 * The translation journal (`journal.log`, JSONL) and its compaction snapshot (`journal.snapshot.json`).
 * A segment line holds the complete state of one segment, so replay keeps the line with the largest `q`
 * per segment and does not depend on line order; usage lines are summed per document and per run.
 */

const bit = z.union([z.literal(0), z.literal(1)]);
const seqSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();
const tokensSchema = z.number().nonnegative();
const runIdSchema = z.string().min(1).nullable();

const flagDetailSchema = z.union([
  z.strictObject({ ratio: z.number() }),
  z.strictObject({ source: z.string(), target: z.string(), more: countSchema }),
  z.strictObject({ kinds: z.array(z.enum(REPAIR_KINDS)) }),
  z.strictObject({ items: z.array(z.string()) }),
  z.strictObject({}),
]);
const failureCodeSchema = z.enum(SEGMENT_FAILURE_CODES);
const stateShape = {
  s: z.enum(['p', 'd', 'f']),
  x: z.string().nullable(),
  o: z.enum(['m', 'u']).nullable(),
  l: bit,
  f: z.array(z.union([z.tuple([z.enum(FLAG_CODES), bit]), z.tuple([z.enum(FLAG_CODES), bit, flagDetailSchema])])),
  e: z.union([z.tuple([failureCodeSchema]), z.tuple([failureCodeSchema, z.enum(MODEL_ERROR_CATEGORIES)])]).nullable(),
};

/** The segment state machine (design §5.2.2): only done has a translation and can be locked, only failed has a failure. */
function isConsistent(state: JournalStateJson): boolean {
  switch (state.s) {
    case 'd': return state.x !== null && state.o !== null && state.e === null;
    case 'f': return state.x === null && state.o === null && state.l === 0 && state.e !== null;
    case 'p': return state.x === null && state.o === null && state.l === 0 && state.e === null;
  }
}

const stateSchema = z.object(stateShape).refine(isConsistent) satisfies z.ZodType<JournalStateJson>;
const recordShape = {
  i: indexSchema,
  v: z.number().int().positive(),
  ...stateShape,
  p: stateSchema.nullable(),
  r: runIdSchema,
  a: countSchema,
};
const recordSchema = z.object(recordShape).refine(isConsistent) satisfies z.ZodType<TranslationRecordJson>;
/** A `Usage`, as the journal snapshot and the manifest store it. */
export const usageSchema = z.object({
  inputTokens: tokensSchema, outputTokens: tokensSchema, cachedInputTokens: tokensSchema,
  requests: countSchema, failedRequests: countSchema, unknownRequests: countSchema,
}) satisfies z.ZodType<Usage>;

/** One journal line. Unknown keys are dropped; a line that fails is skipped by replay and counted. */
export const journalLineSchema = z.discriminatedUnion('t', [
  z.object({ q: seqSchema, t: z.literal('s'), ...recordShape }).refine(isConsistent),
  z.object({
    q: seqSchema, t: z.literal('u'), r: runIdSchema,
    in: tokensSchema, out: tokensSchema, c: tokensSchema, n: countSchema, fail: countSchema, unk: countSchema,
  }),
]) satisfies z.ZodType<JournalLine>;

const snapshotSchema = z.object({
  version: z.literal(1),
  seq: countSchema,
  records: z.record(z.string(), recordSchema),
  usage: usageSchema,
  runUsage: z.record(z.string(), usageSchema),
}).refine(snapshot => Object.entries(snapshot.records).every(([key, record]) => key === String(record.i))) satisfies z.ZodType<JournalSnapshot>;

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, failedRequests: 0, unknownRequests: 0 };
}

export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    requests: a.requests + b.requests,
    failedRequests: a.failedRequests + b.failedRequests,
    unknownRequests: a.unknownRequests + b.unknownRequests,
  };
}

const STATUS_CODES = { pending: 'p', done: 'd', failed: 'f' } as const;
const STATUSES = { p: 'pending', d: 'done', f: 'failed' } as const;
const ORIGIN_CODES = { model: 'm', user: 'u' } as const;
const ORIGINS = { m: 'model', u: 'user' } as const;

function encodeState(state: TranslationState): JournalStateJson {
  return {
    s: STATUS_CODES[state.status],
    x: state.target,
    o: state.origin === null ? null : ORIGIN_CODES[state.origin],
    l: state.locked ? 1 : 0,
    f: state.flags.map(({ code, dismissed, detail }) => detail === undefined ? [code, dismissed ? 1 : 0] : [code, dismissed ? 1 : 0, detail]),
    e: state.failure === null ? null
      : state.failure.category === undefined ? [state.failure.code] : [state.failure.code, state.failure.category],
  };
}

function decodeState(json: JournalStateJson): TranslationState {
  return {
    status: STATUSES[json.s],
    target: json.x,
    origin: json.o === null ? null : ORIGINS[json.o],
    locked: json.l === 1,
    flags: json.f.map(([code, dismissed, detail]) => detail === undefined ? { code, dismissed: dismissed === 1 } : { code, dismissed: dismissed === 1, detail }),
    failure: json.e === null ? null : json.e.length === 1 ? { code: json.e[0] } : { code: json.e[0], category: json.e[1] },
  };
}

export function encodeRecord(record: TranslationRecord): TranslationRecordJson {
  return {
    i: record.index, v: record.rev, ...encodeState(record),
    p: record.previous === null ? null : encodeState(record.previous),
    r: record.runId, a: record.at,
  };
}

export function decodeRecord(json: TranslationRecordJson): TranslationRecord {
  return {
    index: json.i, rev: json.v, ...decodeState(json),
    previous: json.p === null ? null : decodeState(json.p),
    runId: json.r, at: json.a,
  };
}

export function segmentLine(q: number, record: TranslationRecord): JournalSegmentLine {
  return { q, t: 's', ...encodeRecord(record) };
}

export function usageLine(q: number, { runId, usage }: UsageDelta): JournalUsageLine {
  return {
    q, t: 'u', r: runId,
    in: usage.inputTokens, out: usage.outputTokens, c: usage.cachedInputTokens,
    n: usage.requests, fail: usage.failedRequests, unk: usage.unknownRequests,
  };
}

/**
 * The text to append for `lines`, one JSON object per line, each ending in a newline. Throws, writing
 * nothing, when a line breaks the schema: replay would drop it, so it must never reach the disk.
 */
export function formatLines(lines: readonly JournalLine[]): string {
  let text = '';
  for (const line of lines) {
    journalLineSchema.parse(line);
    text += JSON.stringify(line) + '\n';
  }
  return text;
}

/**
 * The complete lines of a journal file. A crash can leave the last line without its newline; it is not
 * returned, and the file should be truncated to `end`, the byte length up to and including the last newline.
 */
export function splitJournal(bytes: Uint8Array): { lines: string[]; end: number } {
  const end = bytes.lastIndexOf(0x0a) + 1;
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split('\n');
  lines.pop();
  return { lines, end };
}

function parseLine(text: string): JournalLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = journalLineSchema.safeParse(value);
  return result.success ? result.data : null;
}

export interface JournalReplay {
  records: Map<number, TranslationRecord>;
  usage: Usage;
  runUsage: Map<string, Usage>;
  /** The largest `q` read, at least the snapshot's `seq`; the next line written gets `lastSeq + 1`. */
  lastSeq: number;
  /** Non-blank lines that could not be read. */
  skipped: number;
}

/**
 * Applies the journal lines with `q > snapshot.seq` on top of the snapshot. Per segment the line with
 * the largest `q` wins; a usage line counts once even when it appears twice.
 */
export function replayJournal(snapshot: JournalSnapshot | null, lines: Iterable<string>): JournalReplay {
  const seq = snapshot?.seq ?? 0;
  const latest = new Map<number, { q: number; record: TranslationRecordJson }>();
  for (const record of Object.values(snapshot?.records ?? {})) latest.set(record.i, { q: seq, record });
  let usage = snapshot ? { ...snapshot.usage } : emptyUsage();
  const runUsage = new Map(Object.entries(snapshot?.runUsage ?? {}).map(([runId, value]) => [runId, { ...value }]));
  const countedUsage = new Set<number>();
  let lastSeq = seq;
  let skipped = 0;
  for (const text of lines) {
    if (!text.trim()) continue;
    const line = parseLine(text);
    if (!line) {
      skipped++;
      continue;
    }
    lastSeq = Math.max(lastSeq, line.q);
    if (line.q <= seq) continue;
    if (line.t === 's') {
      const current = latest.get(line.i);
      if (!current || current.q < line.q) latest.set(line.i, { q: line.q, record: line });
    } else if (!countedUsage.has(line.q)) {
      countedUsage.add(line.q);
      const delta: Usage = {
        inputTokens: line.in, outputTokens: line.out, cachedInputTokens: line.c,
        requests: line.n, failedRequests: line.fail, unknownRequests: line.unk,
      };
      usage = sumUsage(usage, delta);
      if (line.r !== null) runUsage.set(line.r, sumUsage(runUsage.get(line.r) ?? emptyUsage(), delta));
    }
  }
  const records = new Map<number, TranslationRecord>();
  for (const [index, { record }] of latest) records.set(index, decodeRecord(record));
  return { records, usage, runUsage, lastSeq, skipped };
}

export interface JournalState {
  /** The largest `q` written so far. */
  seq: number;
  /** Absent entries are segments still pending at rev 0. */
  records: Iterable<TranslationRecord | undefined>;
  usage: Usage;
  runUsage: ReadonlyMap<string, Usage>;
}

export function buildSnapshot(state: JournalState): JournalSnapshot {
  const records: Record<string, TranslationRecordJson> = {};
  for (const record of state.records) if (record) records[record.index] = encodeRecord(record);
  const runUsage = Object.fromEntries([...state.runUsage].map(([runId, usage]) => [runId, { ...usage }]));
  return { version: 1, seq: state.seq, records, usage: { ...state.usage }, runUsage };
}

/** Reads `journal.snapshot.json`; null when it is not valid JSON or breaks the schema anywhere. */
export function parseSnapshot(text: string): JournalSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = snapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------------------------
// The snapshot file, line by line (design §6.10): a header line, then one record per line. Written and
// read in steps of 2,000 lines, so a large document never blocks the main process for long.

const snapshotHeaderSchema = z.object({ version: z.literal(1), seq: countSchema, usage: usageSchema, runUsage: z.record(z.string(), usageSchema) });
const SNAPSHOT_PAUSE_EVERY = 2_000;
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

function parseJsonLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The lines of `journal.snapshot.json`, each ending in a newline: the header, then every record of `state`. */
export function* snapshotLines(state: JournalState): Generator<string> {
  const runUsage = Object.fromEntries([...state.runUsage].map(([runId, usage]) => [runId, { ...usage }]));
  yield JSON.stringify({ version: 1, seq: state.seq, usage: { ...state.usage }, runUsage }) + '\n';
  for (const record of state.records) if (record) yield JSON.stringify(encodeRecord(record)) + '\n';
}

/**
 * Reads the lines of `journal.snapshot.json`, giving the event loop a turn every 2,000 lines. The
 * snapshot is null when its header is missing or damaged; a record line that cannot be read, or that
 * repeats a segment index, is left out and counted in `skipped`.
 */
export async function readSnapshot(lines: AsyncIterable<string>): Promise<{ snapshot: JournalSnapshot | null; skipped: number }> {
  let snapshot: JournalSnapshot | null = null;
  let skipped = 0;
  let read = 0;
  for await (const text of lines) {
    if (++read % SNAPSHOT_PAUSE_EVERY === 0) await pause();
    if (!snapshot) {
      const header = snapshotHeaderSchema.safeParse(parseJsonLine(text));
      if (!header.success) return { snapshot: null, skipped: 0 };
      snapshot = { version: 1, seq: header.data.seq, records: {}, usage: header.data.usage, runUsage: header.data.runUsage };
      continue;
    }
    if (!text.trim()) continue;
    const record = recordSchema.safeParse(parseJsonLine(text));
    if (!record.success || Object.hasOwn(snapshot.records, record.data.i)) {
      skipped++;
      continue;
    }
    snapshot.records[record.data.i] = record.data;
  }
  return { snapshot, skipped };
}

/**
 * `replayJournal` for a large snapshot, with the same result: the records of the snapshot that no newer
 * journal line replaces are decoded 2,000 at a time, giving the event loop a turn in between.
 */
export async function replayJournalAsync(snapshot: JournalSnapshot | null, lines: Iterable<string>): Promise<JournalReplay> {
  const replay = replayJournal(snapshot && { ...snapshot, records: {} }, lines);
  let decoded = 0;
  for (const record of Object.values(snapshot?.records ?? {})) {
    if (++decoded % SNAPSHOT_PAUSE_EVERY === 0) await pause();
    if (!replay.records.has(record.i)) replay.records.set(record.i, decodeRecord(record));
  }
  return replay;
}
